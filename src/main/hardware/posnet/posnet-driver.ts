import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../../logger';
import { ReceiptFormatter } from './receipt-formatter';
import { ReceiptData, PrinterStatusInfo } from '../../../shared/types';
import { listSerialPorts, sanitizePortName } from '../port-utils';

const execFileAsync = promisify(execFile);

/** Known POSNET USB Vendor ID */
const POSNET_USB_VID = '1424';

/**
 * Posnet Driver with real COM port detection
 * Detects POSNET devices by USB VID and communicates via serial
 */
export class PosnetDriver {
  private connected = false;
  private formatter: ReceiptFormatter;

  constructor(
    private portName: string = 'COM3',
    private baudRate: number = 9600,
    private protocol: 'THERMAL' | 'POSNET' = 'THERMAL'
  ) {
    this.formatter = new ReceiptFormatter();
    logger.info(`[PosnetDriver] Driver initialized for ${portName}`);
  }

  /**
   * Connect to the printer.
   * Only marks connected = true when a valid port is confirmed.
   */
  async connect(): Promise<boolean> {
    logger.info(`[PosnetDriver] Connecting to ${this.portName}...`);

    try {
      const ports = await listSerialPorts();

      if (ports.includes(this.portName)) {
        this.connected = true;
        logger.info(`[PosnetDriver] Connected to ${this.portName}`);
        return true;
      }

      logger.warn(`[PosnetDriver] COM port "${this.portName}" not found. Available: ${ports.join(', ') || 'none'}`);

      // Try auto-detecting POSNET port
      const posnetPort = await PosnetDriver.detectPosnetPort();
      if (posnetPort) {
        logger.info(`[PosnetDriver] Auto-detected POSNET device on ${posnetPort}`);
        this.portName = posnetPort;
        this.connected = true;
        return true;
      }

      logger.warn('[PosnetDriver] No POSNET device detected — staying disconnected');
      this.connected = false;
      return false;
    } catch (error) {
      logger.error('[PosnetDriver] Connection failed:', error);
      this.connected = false;
      return false;
    }
  }

  /**
   * Disconnect from printer
   */
  disconnect(): void {
    this.connected = false;
    logger.info(`[PosnetDriver] Disconnected`);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Verify the configured port is still available.
   * Used by periodic health checks.
   */
  async healthCheck(): Promise<boolean> {
    const ports = await listSerialPorts();
    const stillAvailable = ports.includes(this.portName);
    if (this.connected && !stillAvailable) {
      logger.warn(`[PosnetDriver] Health check: port ${this.portName} disappeared — marking disconnected`);
      this.connected = false;
    } else if (!this.connected && stillAvailable) {
      logger.info(`[PosnetDriver] Health check: port ${this.portName} reappeared — marking connected`);
      this.connected = true;
    }
    return this.connected;
  }

  /**
   * Print a receipt (mock - logs data)
   */
  async printReceipt(data: ReceiptData): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('Printer not connected');
    }

    logger.info('[PosnetDriver] Mock printing receipt...');

    const formattedData = this.formatter.formatOrder(data);

    logger.info('[PosnetDriver] Receipt data:', JSON.stringify({
      items: formattedData.items.length,
      payment: formattedData.payment,
      cashier: formattedData.cashier,
    }));

    // Simulate print delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    logger.info('[PosnetDriver] Mock receipt printed successfully');
  }

  /**
   * Print test page (mock)
   */
  async printTest(): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('Printer not connected');
    }

    logger.info('[PosnetDriver] Mock printing test page...');
    await new Promise(resolve => setTimeout(resolve, 500));
    logger.info('[PosnetDriver] Mock test page printed');
  }

  /**
   * Display message (mock)
   */
  async displayMessage(line1: string, line2?: string): Promise<void> {
    if (!this.isConnected()) return;
    logger.info(`[PosnetDriver] Display: ${line1} | ${line2 || ''}`);
  }

  /**
   * Open cash drawer (mock)
   */
  async openDrawer(): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('Printer not connected');
    }
    logger.info('[PosnetDriver] Mock cash drawer opened');
  }

  /**
   * Get printer status (mock)
   */
  async getStatus(): Promise<PrinterStatusInfo> {
    return {
      connected: this.connected,
      type: 'POSNET',
      mock: true,
      port: this.portName,
      protocol: this.protocol,
    };
  }

  /**
   * Auto-detect the COM port that has a POSNET device connected.
   * 3-step safe detection (no fiscal commands):
   *   Step 1: Filter COM ports by USB VID 1424 (POSNET)
   *   Step 2: Verify COM port can be opened (safe open, no data sent)
   *   Step 3: Send read-only status command (STX + status + ETX) to confirm device responds
   * Returns the COM port name (e.g. 'COM3') or null if not found
   */
  static async detectPosnetPort(): Promise<string | null> {
    try {
      // --- Step 1: Find COM ports with POSNET USB VID ---
      const candidates = await PosnetDriver.findPosnetCandidates();
      if (candidates.length === 0) {
        logger.info('[PosnetDriver] Step 1: No USB devices with VID_1424 found');
        return null;
      }
      logger.info(`[PosnetDriver] Step 1: VID candidates: ${candidates.join(', ')}`);

      // --- Step 2: Safe open test (no data sent) ---
      const openable: string[] = [];
      for (const port of candidates) {
        const canOpen = await PosnetDriver.testPortOpen(port);
        if (canOpen) {
          openable.push(port);
        }
      }
      if (openable.length === 0) {
        logger.warn('[PosnetDriver] Step 2: None of the candidate ports could be opened');
        return null;
      }
      logger.info(`[PosnetDriver] Step 2: Openable ports: ${openable.join(', ')}`);

      // --- Step 3: Send read-only status command to verify POSNET device ---
      for (const port of openable) {
        const confirmed = await PosnetDriver.verifyPosnetDevice(port);
        if (confirmed) {
          logger.info(`[PosnetDriver] Step 3: Confirmed POSNET device on ${port}`);
          return port;
        }
      }

      // If step 3 fails for all, return first openable port from step 2
      // (device might be busy or in a state that doesn't respond to status)
      logger.warn(`[PosnetDriver] Step 3: No POSNET response, falling back to first VID match: ${openable[0]}`);
      return openable[0];
    } catch (error) {
      logger.error('[PosnetDriver] detectPosnetPort failed:', error);
      return null;
    }
  }

  /**
   * Step 1: Find COM ports associated with POSNET USB devices (VID 1424)
   */
  private static async findPosnetCandidates(): Promise<string[]> {
    try {
      // Use Get-CimInstance (Get-WmiObject is deprecated and removed in PS 7)
      const psCommand =
        "Get-CimInstance Win32_PnPEntity | " +
        "Where-Object { $_.DeviceID -match 'VID_1424' -and $_.Name -match 'COM\\d+' } | " +
        "ForEach-Object { if ($_.Name -match '\\(COM(\\d+)\\)') { Write-Output \"COM$($Matches[1])\" } }";

      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psCommand],
        { encoding: 'utf8', timeout: 15000 },
      );

      return stdout
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('COM'));
    } catch (error) {
      logger.error('[PosnetDriver] findPosnetCandidates failed:', error);
      return [];
    }
  }

  /**
   * Step 2: Test if a COM port can be opened (safe — no data sent or read).
   * Uses EncodedCommand and sanitized port name to prevent injection.
   */
  private static async testPortOpen(port: string): Promise<boolean> {
    const safePort = sanitizePortName(port);
    if (!safePort) {
      logger.warn(`[PosnetDriver] testPortOpen: invalid port name "${port}"`);
      return false;
    }

    try {
      const psCommand =
        `$p = New-Object System.IO.Ports.SerialPort('${safePort}', 9600, 'None', 8, 'One'); ` +
        '$p.ReadTimeout = 1000; $p.WriteTimeout = 1000; ' +
        'try { $p.Open(); Write-Output "OK" } finally { if ($p.IsOpen) { $p.Close() } }';

      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psCommand],
        { encoding: 'utf8', timeout: 8000 },
      );

      return stdout.trim().includes('OK');
    } catch {
      logger.warn(`[PosnetDriver] Port ${safePort} cannot be opened`);
      return false;
    }
  }

  /**
   * Step 3: Verify POSNET device by sending a read-only status request.
   * Uses POSNET protocol: STX (0x02) + command + ETX (0x03)
   * Only sends a safe, non-fiscal status query.
   * Port is always closed via try/finally.
   */
  private static async verifyPosnetDevice(port: string): Promise<boolean> {
    const safePort = sanitizePortName(port);
    if (!safePort) {
      logger.warn(`[PosnetDriver] verifyPosnetDevice: invalid port name "${port}"`);
      return false;
    }

    try {
      // Use -EncodedCommand for multi-line script (semicolons can't express this cleanly)
      const psScript =
        `$p = New-Object System.IO.Ports.SerialPort('${safePort}', 9600, 'None', 8, 'One')\n` +
        '$p.ReadTimeout = 2000\n$p.WriteTimeout = 2000\n' +
        '$p.DtrEnable = $true\n$p.RtsEnable = $true\n' +
        'try {\n  $p.Open()\n' +
        "  $cmd = [byte[]]@(0x02) + [System.Text.Encoding]::ASCII.GetBytes('#s') + [byte[]]@(0x03)\n" +
        '  $p.Write($cmd, 0, $cmd.Length)\n' +
        '  Start-Sleep -Milliseconds 1000\n' +
        '  $n = $p.BytesToRead\n' +
        '  if ($n -gt 0) {\n' +
        '    $buf = New-Object byte[] $n\n' +
        '    $p.Read($buf, 0, $n) | Out-Null\n' +
        "    if ($buf[0] -eq 0x02) { Write-Output 'POSNET' }\n" +
        "    else { Write-Output 'UNKNOWN' }\n" +
        "  } else {\n    Write-Output 'NOREPLY'\n  }\n" +
        '} finally {\n  if ($p.IsOpen) { $p.Close() }\n}';
      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');

      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        { encoding: 'utf8', timeout: 10000 },
      );

      const result = stdout.trim();
      logger.info(`[PosnetDriver] verifyPosnetDevice(${safePort}): ${result}`);
      return result === 'POSNET';
    } catch (error) {
      logger.warn(`[PosnetDriver] verifyPosnetDevice(${safePort}) failed:`, error);
      return false;
    }
  }
}
