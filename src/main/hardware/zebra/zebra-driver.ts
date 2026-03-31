import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from '../../logger';
import { ZplFormatter } from './zpl-formatter';
import { ReceiptData, LabelData, PrinterStatusInfo } from '../../../shared/types';
import { listWindowsPrinters, sanitizePrinterName } from '../port-utils';

const execFileAsync = promisify(execFile);

/**
 * Zebra Printer Driver
 * Prints to Zebra printers via Windows print spooler
 */
export class ZebraDriver {
  private printerName: string;
  private connected = false;
  private formatter: ZplFormatter;

  constructor(
    printerName: string,
    labelWidth: number = 100,
    labelHeight: number = 50
  ) {
    this.printerName = printerName;
    this.formatter = new ZplFormatter(labelWidth, labelHeight);
    logger.info(`[ZebraDriver] Initialized for "${printerName}" (${labelWidth}x${labelHeight}mm)`);
  }

  /**
   * List available Windows printers (delegates to shared utility)
   */
  static async listPrinters(): Promise<string[]> {
    return listWindowsPrinters();
  }

  /**
   * Connect to the printer (verify it exists)
   */
  async connect(): Promise<boolean> {
    try {
      logger.info(`[ZebraDriver] Connecting to "${this.printerName}"...`);

      const printers = await ZebraDriver.listPrinters();
      this.connected = printers.some(p =>
        p.toLowerCase() === this.printerName.toLowerCase()
      );

      if (this.connected) {
        logger.info(`[ZebraDriver] Connected to "${this.printerName}"`);
      } else {
        logger.warn(`[ZebraDriver] Printer "${this.printerName}" not found in: ${printers.join(', ')}`);
      }

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

  /**
   * Verify the printer is still available in Windows.
   * Used by periodic health checks.
   */
  async healthCheck(): Promise<boolean> {
    const printers = await listWindowsPrinters();
    const stillAvailable = printers.some(p => p.toLowerCase() === this.printerName.toLowerCase());
    if (this.connected && !stillAvailable) {
      logger.warn(`[ZebraDriver] Health check: "${this.printerName}" disappeared — marking disconnected`);
      this.connected = false;
    } else if (!this.connected && stillAvailable) {
      logger.info(`[ZebraDriver] Health check: "${this.printerName}" reappeared — marking connected`);
      this.connected = true;
    }
    return this.connected;
  }

  /**
   * Send raw ZPL data to printer using Windows API
   */
  private async printRaw(data: string): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('ZebraDriver only supports Windows');
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
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static bool SendStringToPrinter(string szPrinterName, string szString) {
        IntPtr hPrinter = IntPtr.Zero;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "ZPL Label";
        di.pDataType = "RAW";

        if (!OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) return false;

        try {
            if (!StartDocPrinter(hPrinter, 1, di)) return false;
            try {
                if (!StartPagePrinter(hPrinter)) return false;
                try {
                    IntPtr pBytes = Marshal.StringToCoTaskMemAnsi(szString);
                    try {
                        int dwWritten = 0;
                        return WritePrinter(hPrinter, pBytes, szString.Length, out dwWritten);
                    } finally {
                        Marshal.FreeCoTaskMem(pBytes);
                    }
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
$content = Get-Content -Path $zplFile -Raw -Encoding UTF8

$result = [RawPrinterHelper]::SendStringToPrinter($printerName, $content)
if (-not $result) {
    $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "Failed to send data to printer. Error code: $errorCode"
}
Write-Output "OK"
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

      if (stdout && stdout.includes('OK')) {
        logger.info('[ZebraDriver] Print job sent successfully');
      } else {
        throw new Error(`Unexpected output: ${stdout}`);
      }
    } catch (error) {
      logger.error('[ZebraDriver] Print failed:', error);
      throw error;
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

    await this.printRaw(zpl);
    logger.info('[ZebraDriver] Label printed successfully');
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
