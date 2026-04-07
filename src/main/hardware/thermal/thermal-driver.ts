import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from '../../logger';
import { EscPosFormatter, DailyReportData } from './escpos-formatter';
import { ReceiptData, PrinterStatusInfo } from '../../../shared/types';
import { listWindowsPrinters, listSerialPorts, sanitizePrinterName, probeEscPosPort, isWindowsPrinterPresent, flushStuckPrintJobs, getStuckPrintJobStatus } from '../port-utils';
import { matchBrand, type RecoveryResult } from '../detection/types';

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
  ) {
    this.connectionType = connectionType;
    this.windowsTextMode = windowsTextMode;
    this.formatter = new EscPosFormatter(paperWidth, charsPerLine);
    // Auto-detect brand from printer name for recovery
    const matched = matchBrand(printerNameOrPort);
    if (matched) this.brand = matched.brand;
    logger.info(`[ThermalDriver] Initialized for "${printerNameOrPort}" (${connectionType}, ${paperWidth}mm${windowsTextMode ? ', TEXT' : ''})${this.brand ? ` [${this.brand}]` : ''}`);
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
      const printers = cachedPrinters ?? await listWindowsPrinters();
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
      const present = await isWindowsPrinterPresent(this.printerNameOrPort);
      if (!present) {
        this.connected = false;
        throw new Error(
          `Printer "${this.printerNameOrPort}" is not physically connected. ` +
          `Check the USB cable and power, then click Detect Printers.`
        );
      }
      try {
        const flushed = await flushStuckPrintJobs(this.printerNameOrPort);
        if (flushed > 0) {
          logger.warn(`[ThermalDriver] Pre-flight flushed ${flushed} stale job(s) from "${this.printerNameOrPort}"`);
        }
      } catch { /* best-effort */ }
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
      if (typeof data === 'string') {
        fs.writeFileSync(tempFile, data, 'binary');
      } else {
        fs.writeFileSync(tempFile, data);
      }

      if (this.connectionType === 'USB') {
        const safeName = sanitizePrinterName(this.printerNameOrPort);
        if (!safeName) throw new Error(`Invalid printer name: "${this.printerNameOrPort}"`);

        // Try direct file copy to shared printer first (via cmd.exe, no shell spawned by execFile)
        try {
          await execFileAsync(
            'cmd.exe',
            ['/c', 'copy', '/b', tempFile, `\\\\%COMPUTERNAME%\\${safeName}`],
            { encoding: 'utf8', timeout: 15000 },
          );
        } catch {
          // Fallback: PowerShell Out-Printer via EncodedCommand (avoids string escaping issues)
          const psScript = `Get-Content -Encoding Byte '${tempFile.replace(/\\/g, '\\\\')}' | Out-Printer '${safeName}'`;
          const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
          await execFileAsync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
            { timeout: 15000 },
          );
        }

        // ─── Post-flight: confirm queue actually drained ───────────────
        // copy /b and Out-Printer both queue silently — they return success even
        // if the spooler will then mark the job as Error/Offline. Re-check.
        await new Promise(r => setTimeout(r, 1500));
        const stuckStatus = await getStuckPrintJobStatus(this.printerNameOrPort);
        if (stuckStatus) {
          logger.error(`[ThermalDriver] Post-flight queue check: stuck job (${stuckStatus})`);
          try { await flushStuckPrintJobs(this.printerNameOrPort); } catch { /* best-effort */ }
          this.connected = false;
          throw new Error(
            `Printer "${this.printerNameOrPort}" did not accept the job (${stuckStatus}). ` +
            `Check the printer is powered on and connected.`
          );
        }
      } else {
        // Serial port: Configure and send via cmd.exe
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
    await this.printRaw(escposData);

    logger.info('[ThermalDriver] Receipt printed successfully');
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
  async printTest(): Promise<void> {
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

    const testData = this.formatter.formatTestPage();
    await this.printRaw(testData);

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
