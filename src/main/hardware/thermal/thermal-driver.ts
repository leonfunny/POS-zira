import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from '../../logger';
import { EscPosFormatter, DailyReportData, EscPosCharset, EscPosCutMode } from './escpos-formatter';
import { ReceiptData, PrinterStatusInfo } from '../../../shared/types';
import { listWindowsPrinters, listSerialPorts, sanitizePrinterName, probeEscPosPort, isWindowsPrinterPresent, flushStuckPrintJobs, getStuckPrintJobStatus } from '../port-utils';
import { matchBrand, type RecoveryResult } from '../detection/types';
import { withPortLock } from '../posnet/port-mutex';

const execFileAsync = promisify(execFile);

/**
 * Connection type for thermal printer
 */
export type ThermalConnectionType = 'USB' | 'SERIAL';

/**
 * Thermal Printer Driver
 * Supports both USB (Windows Spooler) and Serial Port connections
 * Uses ESC/POS commands for thermal receipt printers
 */
export class ThermalDriver {
  private connected = false;
  private formatter: EscPosFormatter;
  private connectionType: ThermalConnectionType;
  /** Detected brand name, used for recovery matching. */
  private brand: string = '';
  /** Timestamp of last successful printer presence check (ms) — skip re-check within 10s */
  private lastPresenceCheckAt: number = 0;

  /**
   * When true, printTest() uses plain-text Out-Printer instead of ESC/POS bytes.
   * Set this for A4/laser/inkjet printers that don't understand ESC/POS.
   */
  private windowsTextMode: boolean = false;

  constructor(
    private printerNameOrPort: string,  // Windows printer name or COM port
    private baudRate: number = 9600,
    connectionType: ThermalConnectionType = 'USB',
    private paperWidth: number = 80,     // 80mm or 58mm
    private charsPerLine: number = 48,   // Characters per line
    windowsTextMode: boolean = false,    // true → A4/laser path (Out-Printer text)
    opts?: { charset?: EscPosCharset; cutMode?: EscPosCutMode },
  ) {
    this.connectionType = connectionType;
    this.windowsTextMode = windowsTextMode;
    this.formatter = new EscPosFormatter(paperWidth, charsPerLine, opts);
    // Auto-detect brand from printer name for recovery
    const matched = matchBrand(printerNameOrPort);
    if (matched) this.brand = matched.brand;
    logger.info(`[ThermalDriver] Initialized for "${printerNameOrPort}" (${connectionType}, ${paperWidth}mm, charset=${opts?.charset ?? 'utf8'}, cut=${opts?.cutMode ?? 'partial'}${windowsTextMode ? ', TEXT' : ''})${this.brand ? ` [${this.brand}]` : ''}`);
  }

  setCharset(charset: EscPosCharset): void { this.formatter.setCharset(charset); }
  setCutMode(mode: EscPosCutMode): void { this.formatter.setCutMode(mode); }
  getCharset(): EscPosCharset { return this.formatter.getCharset(); }
  getCutMode(): EscPosCutMode { return this.formatter.getCutMode(); }

  /**
   * Best-effort model identification. Returns the brand name derived from the
   * printer name (matched against the brand registry), or the configured name
   * itself as a human-readable fallback. GS I 67 bidirectional read is not
   * attempted here because Out-Printer does not expose a read channel.
   */
  identifyModel(): { modelName?: string; source: 'brand' | 'name' | 'none' } {
    if (this.brand) return { modelName: this.brand, source: 'brand' };
    if (this.printerNameOrPort) return { modelName: this.printerNameOrPort, source: 'name' };
    return { source: 'none' };
  }

  /**
   * List available Windows printers (delegates to shared utility)
   */
  static async listPrinters(): Promise<string[]> {
    return listWindowsPrinters();
  }

  /**
   * List available COM ports (delegates to shared utility)
   */
  static async listPorts(): Promise<string[]> {
    return listSerialPorts();
  }

  /**
   * Connect to the printer.
   *
   * USB mode: spooler list check + isWindowsPrinterPresent() cross-check
   *           (verifies the underlying USB device is physically present, not
   *            just the spooler entry).
   *
   * SERIAL mode: present-port list check + ESC/POS DLE EOT probe (verifies
   *              there's actually a printer responding on the port).
   *
   * Only sets connected=true when the hardware is verified present right now.
   */
  async connect(): Promise<boolean> {
    logger.info(`[ThermalDriver] Connecting to "${this.printerNameOrPort}" via ${this.connectionType}...`);

    try {
      if (this.connectionType === 'USB') {
        // Stage 1: spooler list check
        const printers = await ThermalDriver.listPrinters();
        const inSpooler = printers.some(p =>
          p.toLowerCase() === this.printerNameOrPort.toLowerCase()
        );

        if (!inSpooler) {
          logger.warn(`[ThermalDriver] Printer "${this.printerNameOrPort}" not in spooler. Available: ${printers.join(', ') || 'none'}`);
          this.connected = false;
          return false;
        }

        // Stage 2: hardware presence cross-check
        const present = await isWindowsPrinterPresent(this.printerNameOrPort);
        if (!present) {
          logger.warn(`[ThermalDriver] Printer "${this.printerNameOrPort}" in spooler but NOT physically present`);
          this.connected = false;
          return false;
        }

        this.connected = true;
        this.lastPresenceCheckAt = Date.now();
        logger.info(`[ThermalDriver] Connected to USB printer "${this.printerNameOrPort}" (verified present)`);
      } else {
        // Serial path: present-port list check + ESC/POS probe
        const ports = await ThermalDriver.listPorts();
        const portUpper = this.printerNameOrPort.toUpperCase();
        if (!ports.includes(portUpper)) {
          logger.warn(`[ThermalDriver] COM port "${this.printerNameOrPort}" not present. Available: ${ports.join(', ') || 'none'}`);
          this.connected = false;
          return false;
        }

        // Probe with ESC/POS DLE EOT to confirm a real printer is responding.
        // This catches the case where the COM port exists (e.g. a generic CDC
        // device) but no thermal printer is actually attached.
        const responded = await probeEscPosPort(this.printerNameOrPort, this.baudRate);
        if (!responded) {
          logger.warn(`[ThermalDriver] COM port "${this.printerNameOrPort}" present but no ESC/POS response`);
          this.connected = false;
          return false;
        }

        this.connected = true;
        logger.info(`[ThermalDriver] Connected to serial printer on "${this.printerNameOrPort}" (probe OK)`);
      }

      return this.connected;
    } catch (error) {
      logger.error('[ThermalDriver] Connection failed:', error);
      this.connected = false;
      return false;
    }
  }

  /**
   * Verify the printer/port is still available AND physically present.
   * Used by periodic health checks.
   */
  async healthCheck(cachedPrinters?: string[], cachedPorts?: string[]): Promise<boolean> {
    let stillAvailable: boolean;

    if (this.connectionType === 'USB') {
      if (cachedPrinters) {
        stillAvailable = cachedPrinters.some(p => p.toLowerCase() === this.printerNameOrPort.toLowerCase());
      } else {
        const printers = await listWindowsPrinters();
        const inSpooler = printers.some(p => p.toLowerCase() === this.printerNameOrPort.toLowerCase());
        if (inSpooler) {
          try {
            stillAvailable = await isWindowsPrinterPresent(this.printerNameOrPort);
          } catch {
            stillAvailable = inSpooler;
          }
        } else {
          stillAvailable = false;
        }
      }
    } else {
      const ports = cachedPorts ?? await listSerialPorts();
      stillAvailable = ports.includes(this.printerNameOrPort.toUpperCase());
    }

    if (this.connected && !stillAvailable) {
      logger.warn(`[ThermalDriver] Health check: "${this.printerNameOrPort}" gone — marking disconnected`);
      this.connected = false;
    } else if (!this.connected && stillAvailable) {
      logger.info(`[ThermalDriver] Health check: "${this.printerNameOrPort}" present again — marking connected`);
      this.connected = true;
    }
    return this.connected;
  }

  /**
   * Disconnect from printer
   */
  disconnect(): void {
    this.connected = false;
    logger.info('[ThermalDriver] Disconnected');
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /** Get the current printer name or COM port. */
  getPrinterNameOrPort(): string { return this.printerNameOrPort; }

  /** Reconnect using a new identifier — printer name or COM port (RecoverableDriver). */
  async reconnect(newIdentifier: string): Promise<void> {
    logger.info(`[ThermalDriver] Reconnecting: "${this.printerNameOrPort}" → "${newIdentifier}"`);
    this.printerNameOrPort = newIdentifier;
    if (newIdentifier.match(/^COM\d+$/i)) {
      this.connectionType = 'SERIAL';
      // Verify serial port is present
      const ports = await listSerialPorts();
      this.connected = ports.some(p => p.toUpperCase() === newIdentifier.toUpperCase());
    } else {
      // Verify Windows printer is physically present
      this.connected = await isWindowsPrinterPresent(newIdentifier);
    }
    if (!this.connected) {
      logger.warn(`[ThermalDriver] Reconnect failed — "${newIdentifier}" not physically present`);
    }
  }

  /** Get the detected brand. */
  getBrand(): string { return this.brand; }

  /** Set brand explicitly (e.g. from auto-setup). */
  setBrand(brand: string): void { this.brand = brand; }

  /**
   * Attempt to recover the printer when it disappears.
   *
   * USB mode:    Scan Windows printers for a brand-matching name.
   * Serial mode: Scan all COM ports with ESC/POS status probe (DLE EOT 1).
   *
   * Pure: does NOT mutate driver state. Caller should use reconnect() on success.
   */
  async recoverPrinter(cachedPrinters?: string[], cachedPorts?: string[]): Promise<RecoveryResult> {
    const oldId = this.printerNameOrPort;
    logger.info(`[ThermalDriver] Attempting recovery for "${oldId}" (${this.connectionType})...`);

    if (this.connectionType === 'USB') {
      return this.recoverUsbPrinter(oldId, cachedPrinters);
    } else {
      return this.recoverSerialPrinter(oldId, cachedPorts);
    }
  }

  /**
   * USB recovery: scan Windows printers for a brand-matching name.
   */
  private async recoverUsbPrinter(oldId: string, cachedPrinters?: string[]): Promise<RecoveryResult> {
    try {
      const printers = cachedPrinters ?? await listWindowsPrinters();

      // First, check if the original name came back
      if (printers.some(p => p.toLowerCase() === oldId.toLowerCase())) {
        return { recovered: true, newIdentifier: oldId, oldIdentifier: oldId, message: `Printer "${oldId}" reappeared` };
      }

      // Try brand-based recovery
      const brandPattern = this.brand ? matchBrand(this.brand) : matchBrand(oldId);
      if (!brandPattern) {
        return { recovered: false, oldIdentifier: oldId, message: `No brand pattern for "${oldId}" — cannot recover` };
      }

      for (const name of printers) {
        const nameLower = name.toLowerCase();
        if (brandPattern.namePatterns.some(p => nameLower.includes(p))) {
          return { recovered: true, newIdentifier: name, oldIdentifier: oldId, message: `Printer recovered as "${name}"` };
        }
      }

      return { recovered: false, oldIdentifier: oldId, message: `No ${brandPattern.brand} printer found in Windows` };
    } catch (err: any) {
      return { recovered: false, oldIdentifier: oldId, message: `USB recovery failed: ${err.message}` };
    }
  }

  /**
   * Serial recovery: scan all COM ports with ESC/POS DLE EOT probe.
   */
  private async recoverSerialPrinter(oldId: string, cachedPorts?: string[]): Promise<RecoveryResult> {
    try {
      const ports = cachedPorts ?? await listSerialPorts();
      if (ports.length === 0) {
        return { recovered: false, oldIdentifier: oldId, message: 'No COM ports available' };
      }

      // Check if original port came back first
      if (ports.includes(oldId.toUpperCase())) {
        return { recovered: true, newIdentifier: oldId, oldIdentifier: oldId, message: `Port ${oldId} reappeared` };
      }

      // Try other ports with ESC/POS probe
      for (const port of ports) {
        if (port.toUpperCase() === oldId.toUpperCase()) continue;
        const responded = await probeEscPosPort(port, this.baudRate);
        if (responded) {
          return { recovered: true, newIdentifier: port, oldIdentifier: oldId, message: `Printer recovered on ${port}` };
        }
      }

      return { recovered: false, oldIdentifier: oldId, message: `Thermal printer not found on any COM port` };
    } catch (err: any) {
      return { recovered: false, oldIdentifier: oldId, message: `Serial recovery failed: ${err.message}` };
    }
  }

  /** @deprecated Use shared probeEscPosPort from port-utils instead. Kept for backward compatibility. */
  static async probeEscPosPort(port: string, baudRate: number = 9600): Promise<boolean> {
    return probeEscPosPort(port, baudRate);
  }

  /**
   * Send raw data to printer.
   *
   * USB pre-flight: verify hardware presence + flush any stuck jobs left over
   * from a previous offline period (so the user doesn't get a flood of old
   * test prints when they re-plug the cable).
   *
   * USB post-flight: re-check Get-PrintJob for stuck status. If stuck, throw
   * rather than report success.
   *
   * SERIAL pre-flight: re-probe with ESC/POS DLE EOT to verify the printer is
   * still responding before sending the actual job.
   */
  private async printRaw(data: Buffer | string): Promise<void> {
    // ─── Pre-flight verification ───────────────────────────────────────────
    if (this.connectionType === 'USB') {
      // Skip presence check if we verified within the last 10 seconds
      const now = Date.now();
      if (now - this.lastPresenceCheckAt > 10_000) {
        const present = await isWindowsPrinterPresent(this.printerNameOrPort);
        if (!present) {
          this.connected = false;
          throw new Error(
            `Printer "${this.printerNameOrPort}" is not physically connected. ` +
            `Check the USB cable and power, then click Detect Printers.`
          );
        }
        this.lastPresenceCheckAt = now;
      }
    } else {
      // SERIAL — re-probe to confirm printer still responds
      const ports = await listSerialPorts();
      if (!ports.includes(this.printerNameOrPort.toUpperCase())) {
        this.connected = false;
        throw new Error(
          `Serial port "${this.printerNameOrPort}" is not present. ` +
          `Check the cable and click Detect Printers.`
        );
      }
      const responded = await probeEscPosPort(this.printerNameOrPort, this.baudRate);
      if (!responded) {
        this.connected = false;
        throw new Error(
          `No printer responding on ${this.printerNameOrPort}. ` +
          `Check the cable and printer power, then click Detect Printers.`
        );
      }
    }

    const tempFile = path.join(os.tmpdir(), `thermal_${Date.now()}.bin`);

    try {
      // Write data to temp file
      const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
      fs.writeFileSync(tempFile, buf);

      if (this.connectionType === 'USB') {
        const safeName = sanitizePrinterName(this.printerNameOrPort);
        if (!safeName) throw new Error(`Invalid printer name: "${this.printerNameOrPort}"`);

        // ─── Combined flush + print + post-check in ONE PowerShell call ───
        // This replaces 3 separate PS spawns (flush, print, post-check) with
        // a single process, saving ~3-5 seconds of PS startup overhead.
        const escapedFile = tempFile.replace(/'/g, "''");
        const psScript =
          '$ProgressPreference = "SilentlyContinue"\n' +
          // Phase 1: Flush stuck jobs (best-effort)
          'try {\n' +
          `  $jobs = Get-PrintJob -PrinterName '${safeName}' -ErrorAction SilentlyContinue\n` +
          '  $stuck = $jobs | Where-Object { $_.JobStatus -match "Error|Offline|Blocked|Paused" }\n' +
          '  if ($stuck) { $stuck | Remove-PrintJob -ErrorAction SilentlyContinue }\n' +
          '} catch {}\n' +
          // Phase 2: Add-Type + WritePrinter
          'Add-Type @"\n' +
          'using System;\nusing System.Runtime.InteropServices;\n' +
          'public class RawPrint {\n' +
          '  [StructLayout(LayoutKind.Sequential)] public struct DOCINFO {\n' +
          '    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;\n' +
          '    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;\n' +
          '    [MarshalAs(UnmanagedType.LPStr)] public string pDatatype;\n' +
          '  }\n' +
          '  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Auto)]\n' +
          '  public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);\n' +
          '  [DllImport("winspool.drv", SetLastError=true)]\n' +
          '  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFO pDocInfo);\n' +
          '  [DllImport("winspool.drv", SetLastError=true)]\n' +
          '  public static extern bool StartPagePrinter(IntPtr hPrinter);\n' +
          '  [DllImport("winspool.drv", SetLastError=true)]\n' +
          '  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);\n' +
          '  [DllImport("winspool.drv", SetLastError=true)]\n' +
          '  public static extern bool EndPagePrinter(IntPtr hPrinter);\n' +
          '  [DllImport("winspool.drv", SetLastError=true)]\n' +
          '  public static extern bool EndDocPrinter(IntPtr hPrinter);\n' +
          '  [DllImport("winspool.drv", SetLastError=true)]\n' +
          '  public static extern bool ClosePrinter(IntPtr hPrinter);\n' +
          '}\n"@\n' +
          `$data = [System.IO.File]::ReadAllBytes('${escapedFile}')\n` +
          '$h = [IntPtr]::Zero\n' +
          `if (-not [RawPrint]::OpenPrinter('${safeName}', [ref]$h, [IntPtr]::Zero)) {\n` +
          '  throw "OpenPrinter failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"\n}\n' +
          '$di = New-Object RawPrint+DOCINFO\n' +
          '$di.pDocName = "Zira AI Receipt"\n$di.pDatatype = "RAW"\n' +
          'try {\n' +
          '  if (-not [RawPrint]::StartDocPrinter($h, 1, [ref]$di)) { throw "StartDocPrinter failed" }\n' +
          '  [RawPrint]::StartPagePrinter($h) | Out-Null\n' +
          '  $w = 0\n' +
          '  if (-not [RawPrint]::WritePrinter($h, $data, $data.Length, [ref]$w)) { throw "WritePrinter failed" }\n' +
          '  [RawPrint]::EndPagePrinter($h) | Out-Null\n' +
          '  [RawPrint]::EndDocPrinter($h) | Out-Null\n' +
          '  Write-Output "OK:$w"\n' +
          '} finally {\n  [RawPrint]::ClosePrinter($h) | Out-Null\n}\n' +
          // Phase 3: Post-check for stuck jobs (inline, no separate PS spawn)
          'Start-Sleep -Milliseconds 300\n' +
          'try {\n' +
          `  $postJobs = Get-PrintJob -PrinterName '${safeName}' -ErrorAction SilentlyContinue\n` +
          '  $postStuck = $postJobs | Where-Object { $_.JobStatus -match "Error|Offline|Blocked" }\n' +
          '  if ($postStuck) {\n' +
          '    $postStuck | Remove-PrintJob -ErrorAction SilentlyContinue\n' +
          '    Write-Error "STUCK:$($postStuck[0].JobStatus)"\n' +
          '  }\n' +
          '} catch {}\n';

        const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
        const { stdout, stderr } = await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
          { encoding: 'utf8', timeout: 15000 },
        );

        // Check for errors
        const cleanedErr = (stderr || '').replace(/#< CLIXML[\s\S]*?Preparing modules[\s\S]*?<\/Objs>/gi, '').trim();
        if (cleanedErr) {
          // Distinguish stuck-job warning from real errors
          if (cleanedErr.includes('STUCK:')) {
            const stuckStatus = cleanedErr.match(/STUCK:(.*)/)?.[1] || 'Unknown';
            logger.error(`[ThermalDriver] Post-flight queue check: stuck job (${stuckStatus})`);
            this.connected = false;
            throw new Error(
              `Printer "${this.printerNameOrPort}" did not accept the job (${stuckStatus}). ` +
              `Check the printer is powered on and connected.`
            );
          }
          logger.warn(`[ThermalDriver] WritePrinter stderr: ${cleanedErr}`);
          throw new Error(`Print failed: ${cleanedErr}`);
        }
        const result = (stdout || '').trim();
        if (!result.startsWith('OK:')) {
          throw new Error(`WritePrinter returned unexpected result: ${result}`);
        }
        logger.info(`[ThermalDriver] Raw data sent via WritePrinter (${result})`);
      } else {
        // Serial port: Configure and send via cmd.exe
        const locked = await withPortLock(this.printerNameOrPort, `thermal.printRaw(${this.printerNameOrPort})`, async () => {
          await execFileAsync(
            'mode.com',
            [`${this.printerNameOrPort}:`, `baud=${this.baudRate}`, 'parity=n', 'data=8', 'stop=1'],
            { encoding: 'utf8', timeout: 10000 },
          );
          await execFileAsync(
            'cmd.exe',
            ['/c', 'copy', '/b', tempFile, `${this.printerNameOrPort}:`],
            { encoding: 'utf8', timeout: 15000 },
          );
        });
        if (!locked.ok) {
          this.connected = false;
          throw new Error(locked.message);
        }
      }

      logger.info('[ThermalDriver] Data sent to printer');
    } catch (error) {
      logger.error('[ThermalDriver] Print failed:', error);
      throw error;
    } finally {
      // Clean up temp file
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  }

  /**
   * Print receipt
   */
  async printReceipt(data: ReceiptData): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info('[ThermalDriver] Printing receipt...');

    const escposData = this.formatter.formatReceipt(data);

    // Check if ESC/POS data contains non-ASCII text (Vietnamese, Polish, etc.).
    // If so, re-render the entire receipt as a raster image — this bypasses
    // codepage issues on budget printers that don't support UTF-8 mode.
    if (this.bufferHasNonAsciiText(escposData)) {
      logger.info('[ThermalDriver] Non-ASCII detected — rendering receipt as raster image');
      const lines = this.formatter.formatReceiptPlainLines(data);
      const rasterData = await this.renderTextToRaster(lines);
      await this.printRaw(rasterData);
    } else {
      await this.printRaw(escposData);
    }

    logger.info('[ThermalDriver] Receipt printed successfully');
  }

  /**
   * Check if an ESC/POS buffer contains non-ASCII text bytes (bytes > 0x7F
   * that are NOT part of known ESC/POS command sequences).
   */
  private bufferHasNonAsciiText(data: Buffer): boolean {
    let i = 0;
    while (i < data.length) {
      const b = data[i];
      // Skip ESC sequences (ESC + command byte + optional params)
      if (b === 0x1B || b === 0x1D || b === 0x1C) { i += 2; continue; }
      // Any byte > 0x7F outside a command = non-ASCII text (UTF-8 continuation)
      if (b > 0x7F) return true;
      i++;
    }
    return false;
  }

  /**
   * Render an array of plain-text lines to ESC/POS raster image data.
   * Uses PowerShell System.Drawing to render Unicode text to a monochrome
   * bitmap, then converts to GS v 0 raster format. Works with ALL languages
   * regardless of printer codepage support.
   */
  private async renderTextToRaster(lines: Array<{ text: string; rightText?: string; bold?: boolean; big?: boolean; center?: boolean; separator?: boolean }>): Promise<Buffer> {
    // pixels at 203 DPI: 58mm→384, 76mm→432 (Epson TM-U220 / dot-matrix
    // legacy), 80mm→576 standard. Default to 576 so paperWidth values
    // outside this set still produce a reasonable raster (printer trims
    // overflow rather than misaligns).
    const dotsWidth =
      this.paperWidth <= 58 ? 384 : this.paperWidth <= 76 ? 432 : 576;
    const bytesPerRow = dotsWidth / 8;

    // Escape text for PowerShell string literal
    const escapedLines = JSON.stringify(lines);
    const tempJson = path.join(os.tmpdir(), `receipt_lines_${Date.now()}.json`);
    const tempBmp = path.join(os.tmpdir(), `receipt_raster_${Date.now()}.bin`);

    fs.writeFileSync(tempJson, escapedLines, 'utf8');

    const psScript =
      '$ProgressPreference = "SilentlyContinue"\n' +
      'Add-Type -AssemblyName System.Drawing\n' +
      `$lines = Get-Content -Path '${tempJson.replace(/\\/g, '\\\\')}' -Encoding UTF8 | ConvertFrom-Json\n` +
      `$W = ${dotsWidth}\n` +
      '$fontName = "Consolas"\n' +
      // Font sizes calibrated for 203 DPI thermal printers:
      // ESC/POS Font A = 12x24 dots ≈ 8pt at 203 DPI, double-size = 24x48 ≈ 14pt
      '$fontNormal = New-Object System.Drawing.Font($fontName, 8, [System.Drawing.FontStyle]::Regular)\n' +
      '$fontBold = New-Object System.Drawing.Font($fontName, 8, [System.Drawing.FontStyle]::Bold)\n' +
      '$fontBig = New-Object System.Drawing.Font($fontName, 14, [System.Drawing.FontStyle]::Bold)\n' +
      // Measure total height first
      '$sfM = New-Object System.Drawing.StringFormat\n' +
      '$sfM.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap\n' +
      '$bmpM = New-Object System.Drawing.Bitmap(1, 1)\n' +
      '$bmpM.SetResolution(203, 203)\n' +
      '$gM = [System.Drawing.Graphics]::FromImage($bmpM)\n' +
      '$totalH = 0\n' +
      'foreach ($ln in $lines) {\n' +
      '  if ($ln.separator) { $totalH += 16; continue }\n' +
      '  $f = if ($ln.big) { $fontBig } elseif ($ln.bold) { $fontBold } else { $fontNormal }\n' +
      '  $t = if ($ln.text) { $ln.text } else { " " }\n' +
      '  $sz = $gM.MeasureString($t, $f, 9999, $sfM)\n' +
      '  $totalH += [Math]::Ceiling($sz.Height)\n' +
      '}\n' +
      '$totalH += 30\n' + // bottom margin
      '$gM.Dispose(); $bmpM.Dispose()\n' +
      // Render
      '$bmp = New-Object System.Drawing.Bitmap($W, [Math]::Max($totalH, 10))\n' +
      '$bmp.SetResolution(203, 203)\n' + // Match thermal printer DPI
      '$g = [System.Drawing.Graphics]::FromImage($bmp)\n' +
      '$g.Clear([System.Drawing.Color]::White)\n' +
      '$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit\n' +
      '$M = 8\n' + // left/right margin in pixels
      '$PW = $W - $M * 2\n' + // printable width
      '$sf = New-Object System.Drawing.StringFormat\n' +
      '$sf.Trimming = [System.Drawing.StringTrimming]::None\n' +
      '$sf.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap\n' +
      '$y = 0\n' +
      'foreach ($ln in $lines) {\n' +
      '  if ($ln.separator) {\n' +
      '    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 1)\n' +
      '    $g.DrawLine($pen, $M, ($y+8), ($W-$M), ($y+8))\n' +
      '    $pen.Dispose(); $y += 16; continue\n' +
      '  }\n' +
      '  $f = if ($ln.big) { $fontBig } elseif ($ln.bold) { $fontBold } else { $fontNormal }\n' +
      '  $t = if ($ln.text) { $ln.text } else { " " }\n' +
      '  $brush = [System.Drawing.Brushes]::Black\n' +
      '  $sz = $g.MeasureString($t, $f, $W, $sf)\n' +
      '  $lh = [Math]::Ceiling($sz.Height)\n' +
      // Handle left+right split (e.g. "Subtotal:" on left, "42.00 zl" on right)
      '  if ($ln.rightText) {\n' +
      '    $g.DrawString($t, $f, $brush, $M, $y)\n' +
      '    $rsz = $g.MeasureString($ln.rightText, $f, $W, $sf)\n' +
      '    $rx = $W - $M - $rsz.Width\n' +
      '    $g.DrawString($ln.rightText, $f, $brush, $rx, $y)\n' +
      '    $lh = [Math]::Max($lh, [Math]::Ceiling($rsz.Height))\n' +
      '  } elseif ($ln.center) {\n' +
      '    $x = [Math]::Max($M, ($W - $sz.Width) / 2)\n' +
      '    $g.DrawString($t, $f, $brush, $x, $y)\n' +
      '  } else {\n' +
      '    $g.DrawString($t, $f, $brush, $M, $y)\n' +
      '  }\n' +
      '  $y += $lh\n' +
      '}\n' +
      '$g.Dispose()\n' +
      // Convert to monochrome raster (threshold)
      `$bw = ${bytesPerRow}\n` +
      '$H = $bmp.Height\n' +
      '$raster = New-Object byte[] ($bw * $H)\n' +
      'for ($row = 0; $row -lt $H; $row++) {\n' +
      '  for ($col = 0; $col -lt $W; $col++) {\n' +
      '    $px = $bmp.GetPixel($col, $row)\n' +
      '    $gray = ($px.R * 0.299 + $px.G * 0.587 + $px.B * 0.114)\n' +
      '    if ($gray -lt 128) {\n' +
      '      $byteIdx = $row * $bw + [Math]::Floor($col / 8)\n' +
      '      $bitIdx = 7 - ($col % 8)\n' +
      '      $raster[$byteIdx] = $raster[$byteIdx] -bor (1 -shl $bitIdx)\n' +
      '    }\n' +
      '  }\n' +
      '}\n' +
      '$bmp.Dispose()\n' +
      // Build ESC/POS: INIT + GS v 0 + raster + feed + cut
      '$esc = [byte[]]@(0x1B, 0x40)\n' + // ESC @
      '$xL = $bw -band 0xFF; $xH = ($bw -shr 8) -band 0xFF\n' +
      '$yL = $H -band 0xFF; $yH = ($H -shr 8) -band 0xFF\n' +
      '$gsv = [byte[]]@(0x1D, 0x76, 0x30, 0x00, $xL, $xH, $yL, $yH)\n' + // GS v 0
      '$feed = [byte[]]@(0x1B, 0x64, 0x03)\n' + // ESC d 3
      '$cut = [byte[]]@(0x1D, 0x56, 0x01)\n' + // GS V 1
      // Write all to binary file
      `$outFile = '${tempBmp.replace(/\\/g, '\\\\')}'\n` +
      '$fs = [IO.File]::Create($outFile)\n' +
      '$fs.Write($esc, 0, $esc.Length)\n' +
      '$fs.Write($gsv, 0, $gsv.Length)\n' +
      '$fs.Write($raster, 0, $raster.Length)\n' +
      '$fs.Write($feed, 0, $feed.Length)\n' +
      '$fs.Write($cut, 0, $cut.Length)\n' +
      '$fs.Close()\n' +
      'Write-Output "OK:$($esc.Length + $gsv.Length + $raster.Length + $feed.Length + $cut.Length)"\n';

    try {
      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        { encoding: 'utf8', timeout: 30000 },
      );
      const result = (stdout || '').trim();
      if (!result.startsWith('OK:')) {
        throw new Error(`Raster rendering failed: ${result}`);
      }
      logger.info(`[ThermalDriver] Raster rendered: ${result} bytes`);

      const rasterBuffer = fs.readFileSync(tempBmp);
      return rasterBuffer;
    } finally {
      if (fs.existsSync(tempJson)) fs.unlinkSync(tempJson);
      if (fs.existsSync(tempBmp)) fs.unlinkSync(tempBmp);
    }
  }

  /**
   * Print test page.
   *
   * In ESC/POS mode (default): sends raw ESC/POS bytes via printRaw() — works
   *   on thermal receipt printers that understand ESC/POS.
   *
   * In windowsTextMode: sends a plain-text page via Out-Printer — works on
   *   any Windows-installed printer (A4 laser, inkjet, multi-function), which
   *   would otherwise interpret ESC/POS bytes as garbage.
   */
  async printTest(opts?: { salonName?: string; sellerName?: string; sellerNip?: string }): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info(`[ThermalDriver] Printing test page (${this.windowsTextMode ? 'TEXT' : 'ESC/POS'})...`);

    if (this.windowsTextMode) {
      // A4/laser path — pre-flight check then send plain text via Out-Printer
      const present = await isWindowsPrinterPresent(this.printerNameOrPort);
      if (!present) {
        this.connected = false;
        throw new Error(
          `Printer "${this.printerNameOrPort}" is not physically connected. ` +
          `Check the cable and power, then click Detect Printers.`
        );
      }
      try { await flushStuckPrintJobs(this.printerNameOrPort); } catch { /* best-effort */ }
      await this.printTestWindowsText();
      // Post-flight check
      await new Promise(r => setTimeout(r, 1500));
      const stuckStatus = await getStuckPrintJobStatus(this.printerNameOrPort);
      if (stuckStatus) {
        try { await flushStuckPrintJobs(this.printerNameOrPort); } catch { /* best-effort */ }
        this.connected = false;
        throw new Error(
          `Printer "${this.printerNameOrPort}" did not accept the job (${stuckStatus}). ` +
          `Check the printer is powered on and connected.`
        );
      }
      logger.info('[ThermalDriver] Test page printed (text mode)');
      return;
    }

    const modelInfo = this.identifyModel();
    const testData = this.formatter.formatTestPage({
      modelInfo: { modelName: modelInfo.modelName },
      salonName: opts?.salonName,
      sellerName: opts?.sellerName,
      sellerNip: opts?.sellerNip,
    });
    await this.printRaw(testData);

    // Post-flight: USB spooler jobs may stick if the printer is off/offline —
    // Out-Printer returns success even then. Check the queue and surface a
    // meaningful error rather than claiming success.
    if (this.connectionType === 'USB') {
      await new Promise(r => setTimeout(r, 1500));
      const stuckStatus = await getStuckPrintJobStatus(this.printerNameOrPort);
      if (stuckStatus) {
        try { await flushStuckPrintJobs(this.printerNameOrPort); } catch { /* best-effort */ }
        throw new Error(
          `Test page was sent but got stuck in the spooler (${stuckStatus}). ` +
          `The printer may be off, offline, or out of paper.`
        );
      }
    }

    logger.info('[ThermalDriver] Test page printed');
  }

  /**
   * Print a plain-text test page via PowerShell Out-Printer.
   * Works on any printer installed in Windows (thermal, laser, inkjet).
   */
  private async printTestWindowsText(): Promise<void> {
    const now = new Date().toLocaleString('en-GB');
    const line = '================================';
    const text = [
      line,
      '     Zira AI Print Agent',
      '         Test Print',
      line,
      '',
      `Printer : ${this.printerNameOrPort}`,
      `Date    : ${now}`,
      '',
      'Status  : OK',
      line,
      '',
      '',
    ].join('\r\n');

    const tempFile = path.join(os.tmpdir(), `zira_test_${Date.now()}.txt`);
    try {
      fs.writeFileSync(tempFile, text, 'utf8');
      const safeName = sanitizePrinterName(this.printerNameOrPort);
      if (!safeName) throw new Error(`Invalid printer name: "${this.printerNameOrPort}"`);

      const escapedFile = tempFile.replace(/\\/g, '\\\\');
      const psScript = `Get-Content -Path '${escapedFile}' | Out-Printer '${safeName}'`;
      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
      await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        { timeout: 15000 },
      );
      logger.info('[ThermalDriver] Windows text test page sent to spooler');
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  }

  /**
   * Open cash drawer (if supported)
   */
  async openDrawer(): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info('[ThermalDriver] Opening cash drawer...');

    const drawerCmd = this.formatter.getCashDrawerCommand();
    await this.printRaw(drawerCmd);

    logger.info('[ThermalDriver] Cash drawer opened');
  }

  /**
   * Cut paper (if supported)
   */
  async cutPaper(fullCut: boolean = false): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    const cutCmd = this.formatter.getCutCommand(fullCut);
    await this.printRaw(cutCmd);

    logger.info('[ThermalDriver] Paper cut');
  }

  /**
   * Print daily report (Raport Dobowy)
   */
  async printDailyReport(data: DailyReportData): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info('[ThermalDriver] Printing daily report...');

    const reportData = this.formatter.formatDailyReport(data);
    await this.printRaw(reportData);

    logger.info('[ThermalDriver] Daily report printed');
  }

  /**
   * Print X Report (non-zeroing report)
   */
  async printXReport(data: DailyReportData): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info('[ThermalDriver] Printing X report...');

    const reportData = this.formatter.formatXReport(data);
    await this.printRaw(reportData);

    logger.info('[ThermalDriver] X report printed');
  }

  /**
   * Print Z Report (end of day, zeroing report)
   */
  async printZReport(data: DailyReportData): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info('[ThermalDriver] Printing Z report...');

    const reportData = this.formatter.formatZReport(data);
    await this.printRaw(reportData);

    logger.info('[ThermalDriver] Z report printed');
  }

  /**
   * Get printer status
   */
  async getStatus(): Promise<PrinterStatusInfo> {
    return {
      connected: this.connected,
      printerName: this.printerNameOrPort,
      connectionType: this.connectionType,
      paperWidth: this.paperWidth,
      type: 'THERMAL',
    };
  }
}

// Re-export DailyReportData for convenience
export { DailyReportData } from './escpos-formatter';
