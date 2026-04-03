import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from '../../logger';
import { EscPosFormatter, DailyReportData } from './escpos-formatter';
import { ReceiptData, PrinterStatusInfo } from '../../../shared/types';
import { listWindowsPrinters, listSerialPorts, sanitizePrinterName } from '../port-utils';

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

  constructor(
    private printerNameOrPort: string,  // Windows printer name or COM port
    private baudRate: number = 9600,
    connectionType: ThermalConnectionType = 'USB',
    private paperWidth: number = 80,     // 80mm or 58mm
    private charsPerLine: number = 48    // Characters per line
  ) {
    this.connectionType = connectionType;
    this.formatter = new EscPosFormatter(paperWidth, charsPerLine);
    logger.info(`[ThermalDriver] Initialized for "${printerNameOrPort}" (${connectionType}, ${paperWidth}mm)`);
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
   * Only marks connected = true when the printer/port is actually found.
   */
  async connect(): Promise<boolean> {
    logger.info(`[ThermalDriver] Connecting to "${this.printerNameOrPort}" via ${this.connectionType}...`);

    try {
      if (this.connectionType === 'USB') {
        const printers = await ThermalDriver.listPrinters();
        const found = printers.some(p =>
          p.toLowerCase() === this.printerNameOrPort.toLowerCase()
        );

        if (!found) {
          logger.warn(`[ThermalDriver] Printer "${this.printerNameOrPort}" not found. Available: ${printers.join(', ') || 'none'}`);
          this.connected = false;
          return false;
        }

        this.connected = true;
        logger.info(`[ThermalDriver] Connected to USB printer "${this.printerNameOrPort}"`);
      } else {
        const ports = await ThermalDriver.listPorts();
        if (!ports.includes(this.printerNameOrPort)) {
          logger.warn(`[ThermalDriver] COM port "${this.printerNameOrPort}" not found. Available: ${ports.join(', ') || 'none'}`);
          this.connected = false;
          return false;
        }

        this.connected = true;
        logger.info(`[ThermalDriver] Connected to serial port "${this.printerNameOrPort}"`);
      }

      return this.connected;
    } catch (error) {
      logger.error('[ThermalDriver] Connection failed:', error);
      this.connected = false;
      return false;
    }
  }

  /**
   * Verify the printer/port is still available.
   * Used by periodic health checks.
   */
  async healthCheck(): Promise<boolean> {
    let stillAvailable: boolean;

    if (this.connectionType === 'USB') {
      const printers = await listWindowsPrinters();
      stillAvailable = printers.some(p => p.toLowerCase() === this.printerNameOrPort.toLowerCase());
    } else {
      const ports = await listSerialPorts();
      stillAvailable = ports.includes(this.printerNameOrPort);
    }

    if (this.connected && !stillAvailable) {
      logger.warn(`[ThermalDriver] Health check: "${this.printerNameOrPort}" disappeared — marking disconnected`);
      this.connected = false;
    } else if (!this.connected && stillAvailable) {
      logger.info(`[ThermalDriver] Health check: "${this.printerNameOrPort}" reappeared — marking connected`);
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

  /**
   * Send raw data to printer
   */
  private async printRaw(data: Buffer | string): Promise<void> {
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
   * Print test page using ESC/POS binary data via printRaw().
   * printRaw() handles both USB (copy /b to printer share) and Serial paths,
   * sending raw bytes that thermal printers understand.
   */
  async printTest(): Promise<void> {
    if (!this.connected) {
      throw new Error('Printer not connected');
    }

    logger.info('[ThermalDriver] Printing test page...');

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
