import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../../logger';
import { ReceiptFormatter } from './receipt-formatter';
import { ReceiptData, PrinterStatusInfo } from '../../../shared/types';
import { listSerialPorts, sanitizePortName } from '../port-utils';

const execFileAsync = promisify(execFile);

/** Known POSNET USB Vendor ID */
const POSNET_USB_VID = '1424';

// ─── CRC16-CCITT (poly 0x1021, init 0) ─────────────────────────────────────

const CRC16_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    t.push(crc);
  }
  return t;
})();

function crc16(data: Buffer): string {
  let crc = 0;
  for (const b of data) {
    crc = ((crc << 8) & 0xFFFF) ^ CRC16_TABLE[((crc >> 8) ^ b) & 0xFF];
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// ─── POSNET frame constants ─────────────────────────────────────────────────

const STX = 0x02;
const ETX = 0x03;
const TAB = 0x09;

/**
 * Posnet Driver — POSNET v2 serial protocol for Temo HS and compatible printers.
 *
 * Frame format: STX + body + '#' + CRC16(4hex) + ETX
 * Body:         cmd + TAB + (param + TAB)*
 * CRC covers:   body (everything between STX and '#', exclusive)
 *
 * All serial I/O via PowerShell System.IO.Ports.SerialPort.
 */
export class PosnetDriver {
  private connected = false;
  private formatter: ReceiptFormatter;

  constructor(
    private portName: string = 'COM3',
    private baudRate: number = 9600,
    private protocol: 'THERMAL' | 'POSNET' = 'POSNET'
  ) {
    this.formatter = new ReceiptFormatter();
    logger.info(`[PosnetDriver] Driver initialized for ${portName} @ ${baudRate}`);
  }

  // ─── Connection lifecycle ─────────────────────────────────────────────────

  async connect(): Promise<boolean> {
    logger.info(`[PosnetDriver] Connecting to ${this.portName}...`);
    try {
      const ports = await listSerialPorts();
      if (ports.includes(this.portName)) {
        // Port exists — verify a POSNET device is actually on it
        const verified = await PosnetDriver.verifyPosnetDevice(this.portName);
        if (verified) {
          this.connected = true;
          logger.info(`[PosnetDriver] Connected and verified POSNET on ${this.portName}`);
          return true;
        }
        // Port exists but no POSNET device responded — still mark connected
        // so test print can attempt (and fail with a clear error)
        logger.warn(`[PosnetDriver] Port ${this.portName} exists but no POSNET response — connecting anyway`);
        this.connected = true;
        return true;
      }

      logger.warn(`[PosnetDriver] COM port "${this.portName}" not found. Available: ${ports.join(', ') || 'none'}`);
      const posnetPort = await PosnetDriver.detectPosnetPort();
      if (posnetPort) {
        logger.info(`[PosnetDriver] Auto-detected POSNET device on ${posnetPort}`);
        this.portName = posnetPort;
        this.connected = true;
        return true;
      }

      this.connected = false;
      return false;
    } catch (error) {
      logger.error('[PosnetDriver] Connection failed:', error);
      this.connected = false;
      return false;
    }
  }

  disconnect(): void {
    this.connected = false;
    logger.info(`[PosnetDriver] Disconnected`);
  }

  getPort(): string { return this.portName; }

  async recoverPort(): Promise<string | null> {
    logger.info('[PosnetDriver] Scanning all COM ports for POSNET device...');
    const found = await PosnetDriver.detectPosnetPort();
    if (found) {
      logger.info(`[PosnetDriver] Found POSNET on ${found} (current: ${this.portName})`);
    }
    return found;
  }

  isConnected(): boolean { return this.connected; }

  /** Reconnect using a new COM port (RecoverableDriver). */
  reconnect(newPort: string): void {
    logger.info(`[PosnetDriver] Reconnecting: ${this.portName} → ${newPort}`);
    this.portName = newPort;
    this.connected = true;
  }

  async healthCheck(cachedPorts?: string[]): Promise<boolean> {
    const ports = cachedPorts ?? await listSerialPorts();
    const stillAvailable = ports.includes(this.portName);
    if (this.connected && !stillAvailable) {
      logger.warn(`[PosnetDriver] Health check: port ${this.portName} disappeared`);
      this.connected = false;
    } else if (!this.connected && stillAvailable) {
      logger.info(`[PosnetDriver] Health check: port ${this.portName} reappeared`);
      this.connected = true;
    }
    return this.connected;
  }

  // ─── Printing ─────────────────────────────────────────────────────────────

  /**
   * Print a test page via non-fiscal transaction.
   * Sequence: trinit bm0 → trline × N → trend to<total>
   */
  async printTest(): Promise<void> {
    if (!this.isConnected()) throw new Error('Printer not connected');
    logger.info(`[PosnetDriver] Printing test page on ${this.portName}...`);

    const lines = [
      '*** TEST PRINT ***',
      'POSNET Temo HS',
      this.portName + ' @ ' + this.baudRate,
      new Date().toLocaleString('pl-PL'),
      'Zira AI Print Agent',
    ];

    // Each line is a "1 grosze item" — non-fiscal doesn't care about real prices
    const pricePerLine = 1; // 1 grosz
    const total = lines.length * pricePerLine;

    const frames: string[][] = [];
    // Start non-fiscal transaction
    frames.push(['trinit', 'bm0']);
    // Print lines
    for (const text of lines) {
      frames.push(['trline', `na${text}`, 'vt0', `pr${pricePerLine}`, 'il1.000']);
    }
    // End + print
    frames.push(['trend', `to${total}`]);

    await this.sendPosnetSequence(frames);
    logger.info('[PosnetDriver] Test page printed');
  }

  /**
   * Print a receipt via non-fiscal transaction.
   */
  async printReceipt(data: ReceiptData): Promise<void> {
    if (!this.isConnected()) throw new Error('Printer not connected');
    logger.info('[PosnetDriver] Printing receipt...');

    const formattedData = this.formatter.formatOrder(data);

    const frames: string[][] = [];
    // Start non-fiscal
    frames.push(['trinit', 'bm0']);

    let total = 0;
    for (const item of formattedData.items) {
      const price = Math.max(1, item.price); // price in grosze, min 1
      const qty = item.quantity > 0 ? item.quantity.toFixed(3) : '1.000';
      // Map VAT letter to index: A=0, B=1, C=2, D=3, E=4
      const vatIndex = { A: 0, B: 1, C: 2, D: 3, E: 4 }[item.vat] ?? 0;
      frames.push(['trline', `na${item.name}`, `vt${vatIndex}`, `pr${price}`, `il${qty}`]);
      total += price;
    }

    // Payment (optional for non-fiscal but good practice)
    const paymentType = formattedData.payment?.type === 2 ? 2 : 0; // 0=cash, 2=card
    frames.push(['trpayment', `ty${paymentType}`, `wa${total}`]);

    // End + print
    frames.push(['trend', `to${total}`]);

    await this.sendPosnetSequence(frames);
    logger.info('[PosnetDriver] Receipt printed');
  }

  /** Display message on customer display */
  async displayMessage(line1: string, line2?: string): Promise<void> {
    if (!this.isConnected()) return;
    try {
      const frames: string[][] = [['dsptxtline', 'id0', 'no0', `ln${line1}`]];
      if (line2) frames.push(['dsptxtline', 'id0', 'no1', `ln${line2}`]);
      await this.sendPosnetSequence(frames);
    } catch (err) {
      logger.warn('[PosnetDriver] Display message failed:', err);
    }
  }

  /** Open cash drawer */
  async openDrawer(): Promise<void> {
    if (!this.isConnected()) throw new Error('Printer not connected');
    await this.sendPosnetSequence([['opendrwr']]);
    logger.info('[PosnetDriver] Cash drawer opened');
  }

  async getStatus(): Promise<PrinterStatusInfo> {
    return {
      connected: this.connected,
      type: 'POSNET',
      mock: false,
      port: this.portName,
      protocol: this.protocol,
    };
  }

  // ─── POSNET protocol helpers ──────────────────────────────────────────────

  /**
   * Build a POSNET v2 frame.
   * Format: STX + cmd + TAB + (param + TAB)* + '#' + CRC16(4hex) + ETX
   */
  private static buildFrame(cmd: string, ...params: string[]): Buffer {
    // Body = cmd + TAB + (param + TAB)*
    let body = cmd + '\t';
    for (const p of params) body += p + '\t';

    const bodyBuf = Buffer.from(body, 'ascii');
    const crcHex = crc16(bodyBuf);

    // Frame = STX + body + '#' + CRC + ETX
    const frame = Buffer.alloc(1 + bodyBuf.length + 1 + 4 + 1);
    let offset = 0;
    frame[offset++] = STX;
    bodyBuf.copy(frame, offset); offset += bodyBuf.length;
    frame[offset++] = 0x23; // '#'
    Buffer.from(crcHex, 'ascii').copy(frame, offset); offset += 4;
    frame[offset++] = ETX;

    return frame;
  }

  /**
   * Send multiple POSNET frames in a single serial session.
   * Opens port → writes all frames (waiting for response between each) → closes.
   * Throws on any error response from the printer.
   */
  private async sendPosnetSequence(commands: string[][]): Promise<string[]> {
    const safePort = sanitizePortName(this.portName);
    if (!safePort) throw new Error(`Invalid port name: ${this.portName}`);

    // Build all frames as hex arrays for PowerShell
    const frameHexArrays: string[] = [];
    const cmdLabels: string[] = [];
    for (const [cmd, ...params] of commands) {
      const frame = PosnetDriver.buildFrame(cmd, ...params);
      const hex = Array.from(frame).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(',');
      frameHexArrays.push(hex);
      cmdLabels.push(cmd);
    }

    // Build PowerShell script that sends all frames in one session
    let psScript = '$ProgressPreference = "SilentlyContinue"\n';
    psScript += `$p = New-Object System.IO.Ports.SerialPort('${safePort}', ${this.baudRate}, 'None', 8, 'One')\n`;
    psScript += '$p.WriteTimeout = 5000\n$p.ReadTimeout = 5000\n';
    psScript += '$p.DtrEnable = $true\n$p.RtsEnable = $true\n';
    psScript += '$results = @()\n';
    psScript += 'try {\n  $p.Open()\n';

    for (let i = 0; i < frameHexArrays.length; i++) {
      psScript += `  $f${i} = [byte[]]@(${frameHexArrays[i]})\n`;
      psScript += `  $p.Write($f${i}, 0, $f${i}.Length)\n`;
      psScript += '  Start-Sleep -Milliseconds 1200\n';
      psScript += '  $n = $p.BytesToRead\n';
      psScript += '  if ($n -gt 0) {\n';
      psScript += '    $buf = New-Object byte[] $n\n';
      psScript += '    $p.Read($buf, 0, $n) | Out-Null\n';
      psScript += '    $results += [System.Text.Encoding]::ASCII.GetString($buf)\n';
      psScript += '  } else { $results += "NOREPLY" }\n';
    }

    psScript += '  $results -join "|||"\n';
    psScript += '} catch {\n  Write-Error $_.Exception.Message\n';
    psScript += '} finally {\n  if ($p.IsOpen) { $p.Close() }\n}\n';

    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');

    try {
      const { stdout, stderr } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        { encoding: 'utf8', timeout: commands.length * 3000 + 10000 },
      );

      if (stderr?.trim()) {
        // Filter out PowerShell CLIXML progress records (e.g. "Preparing modules for first use")
        const filteredStderr = stderr.replace(/#< CLIXML[\s\S]*?<\/Objs>/g, '').trim();
        if (filteredStderr) {
          logger.warn(`[PosnetDriver] Serial stderr: ${filteredStderr}`);
          throw new Error(`Serial error: ${filteredStderr}`);
        }
        logger.debug(`[PosnetDriver] Ignored PowerShell progress output on stderr`);
      }

      const responses = stdout.trim().split('|||');
      logger.info(`[PosnetDriver] Responses: ${JSON.stringify(responses)}`);

      // Check for errors in responses
      for (let i = 0; i < responses.length; i++) {
        const resp = responses[i] || '';
        if (resp === 'NOREPLY') {
          throw new Error(`No response from printer on ${this.portName} — check that a POSNET printer is connected to this port`);
        }
        if (resp.includes('ERR') || (resp.includes('?') && !resp.startsWith(cmdLabels[i]))) {
          // Error from printer
          throw new Error(`POSNET ${cmdLabels[i]} failed: ${resp.trim()}`);
        }
      }

      return responses;
    } catch (error: any) {
      // If the error is a POSNET protocol error, cancel any pending transaction
      try {
        const cancelFrame = PosnetDriver.buildFrame('prncancel');
        const cancelHex = Array.from(cancelFrame).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(',');
        const cancelScript = '$ProgressPreference = "SilentlyContinue"\n' +
          `$p = New-Object System.IO.Ports.SerialPort('${safePort}', ${this.baudRate}, 'None', 8, 'One')\n` +
          '$p.WriteTimeout = 3000; $p.DtrEnable = $true; $p.RtsEnable = $true\n' +
          'try { $p.Open()\n' +
          `  $f = [byte[]]@(${cancelHex}); $p.Write($f, 0, $f.Length)\n` +
          '  Start-Sleep -Milliseconds 500\n' +
          '} finally { if ($p.IsOpen) { $p.Close() } }\n';
        const enc = Buffer.from(cancelScript, 'utf16le').toString('base64');
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8', timeout: 8000 });
      } catch { /* best-effort cancel */ }

      throw error;
    }
  }

  // ─── Static detection ─────────────────────────────────────────────────────

  /**
   * Auto-detect POSNET device.
   * Step 1: Find COM ports with VID 1424
   * Step 2: Verify port can be opened
   * Step 3: Send rtcget to confirm POSNET device
   */
  static async detectPosnetPort(): Promise<string | null> {
    try {
      const candidates = await PosnetDriver.findPosnetCandidates();
      if (candidates.length === 0) {
        logger.info('[PosnetDriver] Step 1: No USB devices with VID_1424 found');
        return null;
      }
      logger.info(`[PosnetDriver] Step 1: VID candidates: ${candidates.join(', ')}`);

      const openable: string[] = [];
      for (const port of candidates) {
        const canOpen = await PosnetDriver.testPortOpen(port);
        if (canOpen) openable.push(port);
      }
      if (openable.length === 0) {
        logger.warn('[PosnetDriver] Step 2: None of the candidate ports could be opened');
        return null;
      }
      logger.info(`[PosnetDriver] Step 2: Openable ports: ${openable.join(', ')}`);

      for (const port of openable) {
        const confirmed = await PosnetDriver.verifyPosnetDevice(port);
        if (confirmed) {
          logger.info(`[PosnetDriver] Step 3: Confirmed POSNET device on ${port}`);
          return port;
        }
      }

      // Fallback: return first openable VID match
      logger.warn(`[PosnetDriver] Step 3: No POSNET response, falling back to ${openable[0]}`);
      return openable[0];
    } catch (error) {
      logger.error('[PosnetDriver] detectPosnetPort failed:', error);
      return null;
    }
  }

  private static async findPosnetCandidates(): Promise<string[]> {
    try {
      const psCommand =
        "Get-CimInstance Win32_PnPEntity | " +
        "Where-Object { $_.DeviceID -match 'VID_1424' -and $_.Name -match 'COM\\d+' } | " +
        "ForEach-Object { if ($_.Name -match '\\(COM(\\d+)\\)') { Write-Output \"COM$($Matches[1])\" } }";
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psCommand],
        { encoding: 'utf8', timeout: 15000 },
      );
      return stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('COM'));
    } catch (error) {
      logger.error('[PosnetDriver] findPosnetCandidates failed:', error);
      return [];
    }
  }

  private static async testPortOpen(port: string): Promise<boolean> {
    const safePort = sanitizePortName(port);
    if (!safePort) return false;
    try {
      const psCommand =
        `$p = New-Object System.IO.Ports.SerialPort('${safePort}', 9600, 'None', 8, 'One'); ` +
        '$p.ReadTimeout = 1000; $p.WriteTimeout = 1000; ' +
        'try { $p.Open(); Write-Output "OK" } finally { if ($p.IsOpen) { $p.Close() } }';
      const { stdout } = await execFileAsync(
        'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand],
        { encoding: 'utf8', timeout: 8000 },
      );
      return stdout.trim().includes('OK');
    } catch { return false; }
  }

  /**
   * Verify POSNET device by sending rtcget (read clock).
   * A POSNET printer responds with: rtcget TAB da<date> TAB #CRC ETX
   */
  private static async verifyPosnetDevice(port: string): Promise<boolean> {
    const safePort = sanitizePortName(port);
    if (!safePort) return false;

    try {
      // Build rtcget frame
      const frame = PosnetDriver.buildFrame('rtcget');
      const hexArray = Array.from(frame).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(',');

      const psScript =
        '$ProgressPreference = "SilentlyContinue"\n' +
        `$p = New-Object System.IO.Ports.SerialPort('${safePort}', 9600, 'None', 8, 'One')\n` +
        '$p.ReadTimeout = 3000\n$p.WriteTimeout = 3000\n' +
        '$p.DtrEnable = $true\n$p.RtsEnable = $true\n' +
        'try {\n  $p.Open()\n' +
        `  $f = [byte[]]@(${hexArray})\n` +
        '  $p.Write($f, 0, $f.Length)\n' +
        '  Start-Sleep -Milliseconds 1500\n' +
        '  $n = $p.BytesToRead\n' +
        '  if ($n -gt 0) {\n' +
        '    $buf = New-Object byte[] $n\n' +
        '    $p.Read($buf, 0, $n) | Out-Null\n' +
        '    $s = [System.Text.Encoding]::ASCII.GetString($buf)\n' +
        "    if ($s -match 'rtcget') { Write-Output 'POSNET' }\n" +
        "    elseif ($buf[0] -eq 0x02) { Write-Output 'POSNET' }\n" +
        "    else { Write-Output 'UNKNOWN' }\n" +
        "  } else { Write-Output 'NOREPLY' }\n" +
        '} finally {\n  if ($p.IsOpen) { $p.Close() }\n}\n';

      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        { encoding: 'utf8', timeout: 12000 },
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
