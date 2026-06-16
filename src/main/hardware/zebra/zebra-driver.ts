import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from '../../logger';
import { ZplFormatter, type ZplTextProfile } from './zpl-formatter';
import { ReceiptData, LabelData, CheckinConfirmationData, PrinterStatusInfo, InfoLabelData, type KitchenTicketData } from '../../../shared/types';
import { listWindowsPrinters, sanitizePrinterName, isWindowsPrinterPresent, flushStuckPrintJobs, getStuckPrintJobStatus } from '../port-utils';
import { type RecoveryResult } from '../detection/types';

const execFileAsync = promisify(execFile);

type PrintRawOptions = {
  fast?: boolean;
};

/**
 * Zebra Printer Driver
 * Prints to Zebra printers via Windows print spooler
 */
export class ZebraDriver {
  private printerName: string;
  private connected = false;
  private formatter: ZplFormatter;

  private static textProfileForPrinter(printerName: string): ZplTextProfile {
    return /xprinter|xp-?423|xp-?42|gk420|zdesigner|zebra|ztc/i.test(printerName) ? 'ascii' : 'zebra';
  }

  constructor(
    printerName: string,
    labelWidth: number = 100,
    labelHeight: number = 50
  ) {
    this.printerName = printerName;
    this.formatter = new ZplFormatter(labelWidth, labelHeight, 203, ZebraDriver.textProfileForPrinter(printerName));
    logger.info(`[ZebraDriver] Initialized for "${printerName}" (${labelWidth}x${labelHeight}mm)`);
  }

  /**
   * List available Windows printers (delegates to shared utility)
   */
  static async listPrinters(): Promise<string[]> {
    return listWindowsPrinters();
  }

  /**
   * Query the Windows printer driver for its configured paper size.
   * Uses System.Drawing.Printing to read the driver's DEVMODE paper dimensions.
   * Returns dimensions in mm, or null if detection fails.
   */
  static async detectPaperSize(printerName: string): Promise<{ widthMm: number; heightMm: number } | null> {
    if (process.platform !== 'win32') return null;
    try {
      const psScript = `
Add-Type -AssemblyName System.Drawing
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = '${printerName.replace(/'/g, "''")}'
if ($doc.PrinterSettings.IsValid) {
  $s = $doc.DefaultPageSettings.PaperSize
  $wMm = [Math]::Round($s.Width * 0.254, 1)
  $hMm = [Math]::Round($s.Height * 0.254, 1)
  Write-Output "$wMm,$hMm"
} else { Write-Output "INVALID" }
`;
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { timeout: 10000 },
      );
      const trimmed = stdout.trim();
      if (trimmed === 'INVALID' || !trimmed) return null;
      const [w, h] = trimmed.split(',').map(Number);
      if (isNaN(w) || isNaN(h) || w <= 0 || h <= 0) return null;
      return { widthMm: w, heightMm: h };
    } catch (err) {
      logger.warn('[ZebraDriver] Paper size detection failed:', err);
      return null;
    }
  }

  /**
   * Connect to the printer.
   *
   * Two-stage check:
   *   1. Spooler list contains the printer name (cheap)
   *   2. Hardware presence cross-check via PnP / WorkOffline / port topology (reliable)
   *
   * Returns true ONLY if the printer is BOTH installed in the spooler AND
   * physically present right now. This prevents the "ghost printer" bug where
   * connect() succeeds for a disconnected USB printer and jobs accumulate in
   * the queue until the cable is re-plugged and they all flush at once.
   */
  async connect(): Promise<boolean> {
    try {
      logger.info(`[ZebraDriver] Connecting to "${this.printerName}"...`);

      // Stage 1: Spooler list check
      const printers = await ZebraDriver.listPrinters();
      const inSpooler = printers.some(p =>
        p.toLowerCase() === this.printerName.toLowerCase()
      );

      if (!inSpooler) {
        logger.warn(`[ZebraDriver] Printer "${this.printerName}" not found in spooler. Available: ${printers.join(', ') || 'none'}`);
        this.connected = false;
        return false;
      }

      // Stage 2: Hardware presence cross-check
      const present = await isWindowsPrinterPresent(this.printerName);
      if (!present) {
        logger.warn(`[ZebraDriver] Printer "${this.printerName}" is in spooler but NOT physically present (cable unplugged or powered off)`);
        this.connected = false;
        return false;
      }

      this.connected = true;
      logger.info(`[ZebraDriver] Connected to "${this.printerName}" (verified present)`);

      return this.connected;
    } catch (error) {
      logger.error('[ZebraDriver] Connect error:', error);
      this.connected = false;
      return false;
    }
  }

  /**
   * Disconnect from printer
   */
  disconnect(): void {
    this.connected = false;
    logger.info('[ZebraDriver] Disconnected');
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /** Reconnect using a new Windows printer name (RecoverableDriver). */
  async reconnect(newPrinterName: string): Promise<void> {
    logger.info(`[ZebraDriver] Reconnecting: "${this.printerName}" → "${newPrinterName}"`);
    this.printerName = newPrinterName;
    // Verify the new printer is actually present before marking connected
    const present = await isWindowsPrinterPresent(newPrinterName);
    this.connected = present;
    if (!present) {
      logger.warn(`[ZebraDriver] Reconnect failed — "${newPrinterName}" not physically present`);
      return;
    }
  }

  /**
   * Verify the printer is still available in Windows AND physically present.
   * Used by periodic health checks.
   */
  async healthCheck(cachedPrinters?: string[]): Promise<boolean> {
    if (cachedPrinters) {
      const stillAvailable = cachedPrinters.some(p => p.toLowerCase() === this.printerName.toLowerCase());
      if (this.connected && !stillAvailable) {
        logger.warn(`[ZebraDriver] Health check: "${this.printerName}" gone (snapshot) â€” marking disconnected`);
        this.connected = false;
      } else if (!this.connected && stillAvailable) {
        logger.info(`[ZebraDriver] Health check: "${this.printerName}" present again (snapshot) â€” marking connected`);
        this.connected = true;
      }
      return this.connected;
    }

    const printers = cachedPrinters ?? await listWindowsPrinters();
    const inSpooler = printers.some(p => p.toLowerCase() === this.printerName.toLowerCase());

    let stillAvailable = false;
    if (inSpooler) {
      // Cross-check physical presence — spooler entry alone is not enough
      try {
        stillAvailable = await isWindowsPrinterPresent(this.printerName);
      } catch {
        stillAvailable = inSpooler; // fallback if presence check fails
      }
    }

    if (this.connected && !stillAvailable) {
      logger.warn(`[ZebraDriver] Health check: "${this.printerName}" gone (inSpooler=${inSpooler}) — marking disconnected`);
      this.connected = false;
    } else if (!this.connected && stillAvailable) {
      logger.info(`[ZebraDriver] Health check: "${this.printerName}" present again — marking connected`);
      this.connected = true;
    }
    return this.connected;
  }

  /** Zebra brand patterns for printer name matching. */
  private static readonly ZEBRA_PATTERNS = ['zebra', 'zdesigner', 'ztc '];

  /**
   * Attempt to recover the printer when it disappears.
   * Scans Windows printers for Zebra/ZDesigner pattern match.
   * Pure: does NOT mutate driver state. Caller should use reconnect() on success.
   */
  async recoverPrinter(cachedPrinters?: string[]): Promise<RecoveryResult> {
    const oldName = this.printerName;
    logger.info(`[ZebraDriver] Attempting recovery for "${oldName}"...`);

    try {
      const printers = cachedPrinters ?? await listWindowsPrinters();

      // First, check if the original name came back
      if (printers.some(p => p.toLowerCase() === oldName.toLowerCase())) {
        return { recovered: true, newIdentifier: oldName, oldIdentifier: oldName, message: `Printer "${oldName}" reappeared` };
      }

      // Search for any Zebra printer
      for (const name of printers) {
        const nameLower = name.toLowerCase();
        if (ZebraDriver.ZEBRA_PATTERNS.some(p => nameLower.includes(p))) {
          return { recovered: true, newIdentifier: name, oldIdentifier: oldName, message: `Zebra printer recovered as "${name}"` };
        }
      }

      return { recovered: false, oldIdentifier: oldName, message: 'No Zebra printer found in Windows' };
    } catch (err: any) {
      return { recovered: false, oldIdentifier: oldName, message: `Recovery failed: ${err.message}` };
    }
  }

  /**
   * Send raw ZPL data to printer using Windows API.
   *
   * Pre-flight: verify hardware is present + flush any stuck jobs from a
   * previous offline period (otherwise those ghost jobs would print as soon
   * as the printer comes back online, surprising the user).
   *
   * Post-flight: check the queue again — if a job is stuck, throw rather
   * than report success. This is the "smoking gun" fix for the bug where
   * test prints all "succeed" while the printer is unplugged and then
   * suddenly all print at once on reconnect.
   */
  private async printRaw(data: string, options: PrintRawOptions = {}): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('ZebraDriver only supports Windows');
    }

    // ─── Pre-flight: verify printer is physically present ────────────────
    const present = await isWindowsPrinterPresent(this.printerName);
    if (!present) {
      this.connected = false;
      throw new Error(
        `Printer "${this.printerName}" is not physically connected. ` +
        `Check the USB cable and power, then click Detect Printers.`
      );
    }

    // ─── Pre-flight: flush any leftover stuck jobs from a previous offline period ─
    if (!options.fast) {
      try {
        const flushed = await flushStuckPrintJobs(this.printerName);
        if (flushed > 0) {
          logger.warn(`[ZebraDriver] Pre-flight flushed ${flushed} stale job(s) from "${this.printerName}"`);
        }
      } catch { /* best-effort */ }
    }

    const timestamp = Date.now();
    const tempZplFile = path.join(os.tmpdir(), `zebra_${timestamp}.zpl`);
    // Note: PowerShell script is now passed via -EncodedCommand, no temp .ps1 file needed

    try {
      // Write ZPL to temp file
      fs.writeFileSync(tempZplFile, data, 'utf8');
      logger.debug(`[ZebraDriver] ZPL written to ${tempZplFile}`);

      // Create PowerShell script for raw printing
      // Uses Windows API to send raw data directly to printer
      const psScript = `
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, Int32 dwCount, out Int32 dwWritten);

    public static string SendBytesToPrinter(string szPrinterName, byte[] bytes) {
        IntPtr hPrinter = IntPtr.Zero;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "ZPL Label";
        di.pDataType = "RAW";

        if (!OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) {
            int err = Marshal.GetLastWin32Error();
            return "OpenPrinter failed for '" + szPrinterName + "' (Win32 error " + err + ")";
        }

        try {
            if (!StartDocPrinter(hPrinter, 1, di)) {
                int err = Marshal.GetLastWin32Error();
                return "StartDocPrinter failed (Win32 error " + err + ")";
            }
            try {
                if (!StartPagePrinter(hPrinter)) {
                    int err = Marshal.GetLastWin32Error();
                    return "StartPagePrinter failed (Win32 error " + err + ")";
                }
                try {
                    int dwWritten = 0;
                    if (!WritePrinter(hPrinter, bytes, bytes.Length, out dwWritten)) {
                        int err = Marshal.GetLastWin32Error();
                        return "WritePrinter failed (Win32 error " + err + ")";
                    }
                    if (dwWritten != bytes.Length) {
                        return "WritePrinter wrote " + dwWritten + " of " + bytes.Length + " bytes";
                    }
                    return "OK";
                } finally {
                    EndPagePrinter(hPrinter);
                }
            } finally {
                EndDocPrinter(hPrinter);
            }
        } finally {
            ClosePrinter(hPrinter);
        }
    }
}
"@

$printerName = '${this.printerName.replace(/'/g, "''")}'
$zplFile = '${tempZplFile.replace(/\\/g, '\\\\').replace(/'/g, "''")}'
$bytes = [System.IO.File]::ReadAllBytes($zplFile)

$result = [RawPrinterHelper]::SendBytesToPrinter($printerName, $bytes)
if ($result -ne "OK") {
    throw $result
}

if (${options.fast ? '$true' : '$false'}) {
    Write-Output "OK"
} else {
# Non-blocking queue check — warn if job is stuck but don't fail
try {
    Start-Sleep -Milliseconds 1000
    $stuckJobs = Get-PrintJob -PrinterName $printerName -ErrorAction SilentlyContinue | Where-Object {
        $_.JobStatus -match 'Error|Offline|Blocked|PaperOut|Paused'
    }
    if ($stuckJobs) {
        $status = ($stuckJobs | Select-Object -First 1).JobStatus
        try { $stuckJobs | Remove-PrintJob -ErrorAction SilentlyContinue } catch {}
        Write-Output "WARN:QUEUE_STUCK:$status"
    } else {
        Write-Output "OK"
    }
} catch {
    # Queue check failed — still report success since data was sent
    Write-Output "OK"
}
}
`;

      // SECURITY: Use execFile() with -EncodedCommand to avoid shell injection.
      // execFile() does not spawn a shell, so no metacharacter interpretation.
      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
      logger.debug(`[ZebraDriver] Executing PowerShell with encoded command`);

      const { stdout, stderr } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        { timeout: 30000 },
      );

      if (stderr && stderr.trim()) {
        logger.warn(`[ZebraDriver] PowerShell stderr: ${stderr}`);
      }

      if (stdout && stdout.includes('WARN:QUEUE_STUCK:')) {
        const status = stdout.match(/WARN:QUEUE_STUCK:(\S+)/)?.[1] || 'Unknown';
        logger.error(`[ZebraDriver] Job stuck in queue (status: ${status}) — printer is a ghost (cable unplugged or powered off)`);
        this.connected = false;
        throw new Error(
          `Print job stuck in queue (${status}). The printer "${this.printerName}" ` +
          `appears to be installed in Windows but not physically connected. ` +
          `Check USB/power and click Detect Printers.`
        );
      } else if (stdout && stdout.includes('OK')) {
        logger.info('[ZebraDriver] Print job sent successfully');
      } else {
        throw new Error(`Unexpected output: ${stdout}`);
      }

      if (!options.fast) {

      // ─── Post-flight: confirm queue actually drained ──────────────────
      // The in-script check above only inspects status 1 second after WritePrinter.
      // Re-check after another short delay to catch jobs that took longer to error out.
      await new Promise(r => setTimeout(r, 800));
      const stuckStatus = await getStuckPrintJobStatus(this.printerName);
      if (stuckStatus) {
        logger.error(`[ZebraDriver] Post-flight queue check found stuck job: ${stuckStatus}`);
        try { await flushStuckPrintJobs(this.printerName); } catch { /* best-effort */ }
        this.connected = false;
        throw new Error(
          `Printer "${this.printerName}" did not accept the job (${stuckStatus}). ` +
          `Check the printer is powered on and connected.`
        );
      }
      }
    } catch (error: any) {
      logger.error('[ZebraDriver] Print failed:', error);
      const raw = error?.stderr || error?.message || String(error);

      // Check for queue stuck (ghost printer detected)
      const queueMatch = raw.match(/QUEUE_STUCK:(\S+)/);
      if (queueMatch) {
        const status = queueMatch[1];
        throw new Error(
          `Print job stuck in queue (status: ${status}). This printer may be a ghost device — ` +
          `check that you selected the correct printer with an active USB port.`
        );
      }

      // Look for our structured error from SendBytesToPrinter (e.g. "OpenPrinter failed ...")
      const structured = raw.match(/(OpenPrinter|StartDocPrinter|StartPagePrinter|WritePrinter) failed[^"'\r\n]*/);
      if (structured) {
        throw new Error(structured[0]);
      }
      // Fallback: strip CLIXML tags and keep first meaningful line
      const cleaned = raw.replace(/#< CLIXML[\s\S]*$/m, '').replace(/<[^>]+>/g, '').trim();
      const firstLine = cleaned.split(/[\r\n]+/).find((l: string) => l.trim().length > 10) || cleaned;
      throw new Error(firstLine.slice(0, 200) || 'Print command failed');
    } finally {
      // Clean up temp ZPL file (no .ps1 file needed with EncodedCommand)
      try {
        if (fs.existsSync(tempZplFile)) {
          fs.unlinkSync(tempZplFile);
        }
      } catch (cleanupError) {
        logger.warn(`[ZebraDriver] Failed to cleanup ${tempZplFile}:`, cleanupError);
      }
    }
  }

  /**
   * Print a receipt
   */
  async printReceipt(data: ReceiptData): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info('[ZebraDriver] Printing receipt...');
    const zpl = this.formatter.formatReceipt(data);
    logger.debug(`[ZebraDriver] ZPL:\n${zpl}`);

    await this.printRaw(zpl);
    logger.info('[ZebraDriver] Receipt printed successfully');
  }

  /**
   * Print a label with barcode
   */
  async printLabel(data: LabelData): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info(`[ZebraDriver] Printing label (barcode: ${data.barcode}, qty: ${data.quantity})...`);
    const zpl = this.formatter.formatLabel(data);
    logger.debug(`[ZebraDriver] ZPL:\n${zpl}`);

    await this.printRaw(zpl, { fast: true });
    logger.info('[ZebraDriver] Label printed successfully');
  }

  /**
   * Print a compact kitchen self-order payment slip on label media.
   */
  async printKitchenPaymentLabel(data: KitchenTicketData): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info(`[ZebraDriver] Printing kitchen payment label for ${data.orderNumber}...`);
    const zpl = this.formatter.formatKitchenPaymentLabel(data);
    logger.debug(`[ZebraDriver] ZPL:\n${zpl}`);

    await this.printRaw(zpl, { fast: true });
    logger.info('[ZebraDriver] Kitchen payment label printed successfully');
  }

  /**
   * Print a 4-line PL-legal food information label
   */
  async printInfoLabel(data: InfoLabelData): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info(`[ZebraDriver] Printing info label for "${data.productName}"...`);
    const zpl = this.formatter.formatInfoLabel(data, (this.formatter as any).labelWidth, (this.formatter as any).labelHeight);
    logger.debug(`[ZebraDriver] ZPL:\n${zpl}`);

    await this.printRaw(zpl);
    logger.info('[ZebraDriver] Info label printed successfully');
  }

  /**
   * Print check-in confirmation label (ZPL fallback)
   */
  async printCheckinConfirmation(data: CheckinConfirmationData): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info(`[ZebraDriver] Printing check-in confirmation for "${data.customerName}"...`);
    const zpl = this.formatter.formatCheckinConfirmation(data);
    logger.debug(`[ZebraDriver] ZPL:\n${zpl}`);

    await this.printRaw(zpl);
    logger.info('[ZebraDriver] Check-in confirmation printed successfully');
  }

  /** Expose printer name for external callers (e.g. Electron PDF printing) */
  getPrinterName(): string {
    return this.printerName;
  }

  /**
   * Send ~JC calibration command.
   * The printer will feed several labels to detect gap/mark type and label length.
   */
  async calibrate(): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info('[ZebraDriver] Sending calibration (~JC)...');
    await this.printRaw('~JC');
    logger.info('[ZebraDriver] Calibration complete');
  }

  /**
   * Print test page
   */
  async printTest(): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info('[ZebraDriver] Printing test page...');
    const zpl = this.formatter.formatTestPrint();
    logger.debug(`[ZebraDriver] Test ZPL:\n${zpl}`);

    await this.printRaw(zpl);
    logger.info('[ZebraDriver] Test page printed successfully');
  }

  /**
   * Display message (not supported on Zebra - no-op)
   */
  async displayMessage(line1: string, line2?: string): Promise<void> {
    logger.debug(`[ZebraDriver] displayMessage not supported: ${line1} | ${line2 || ''}`);
  }

  /**
   * Open cash drawer (not supported on Zebra - no-op)
   */
  async openDrawer(): Promise<void> {
    logger.debug('[ZebraDriver] openDrawer not supported on Zebra printers');
  }

  /**
   * Get printer status
   */
  async getStatus(): Promise<PrinterStatusInfo> {
    return {
      connected: this.connected,
      printerName: this.printerName,
      type: 'ZEBRA',
    };
  }
}
