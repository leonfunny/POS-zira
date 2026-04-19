import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../../logger';
import { ReceiptFormatter } from './receipt-formatter';
import { ReceiptData, PrinterStatusInfo } from '../../../shared/types';
import { listSerialPorts, sanitizePortName } from '../port-utils';
import { POSNET_PRODUCT_IDS } from './probe-profiles';

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
  private modelName?: string;
  private firmwareVersion?: string;

  constructor(
    private portName: string = 'COM3',
    private baudRate: number = 9600,
    private protocol: 'THERMAL' | 'POSNET' = 'POSNET'
  ) {
    this.formatter = new ReceiptFormatter();
    logger.info(`[PosnetDriver] Driver initialized for ${portName} @ ${baudRate}`);
  }

  getModelName(): string | undefined { return this.modelName; }
  getFirmwareVersion(): string | undefined { return this.firmwareVersion; }

  // ─── Connection lifecycle ─────────────────────────────────────────────────

  async connect(): Promise<boolean> {
    logger.info(`[PosnetDriver] Connecting to ${this.portName}...`);
    try {
      const ports = await listSerialPorts();
      const portUpper = this.portName.toUpperCase();
      if (ports.includes(portUpper)) {
        // Port exists — try to verify a POSNET device is on it via rtcget.
        const verified = await PosnetDriver.verifyPosnetDevice(this.portName);
        if (verified) {
          this.connected = true;
          logger.info(`[PosnetDriver] Connected and verified POSNET on ${this.portName}`);
          return true;
        }
        // rtcget got no response — but some POSNET Thermal models (e.g. Thermal XL)
        // don't reply to rtcget while still being fully functional for printing.
        // Fall through to VID-based physical presence check below.
        logger.warn(`[PosnetDriver] Port ${this.portName} exists but no POSNET rtcget response — checking VID`);
      } else {
        logger.warn(`[PosnetDriver] COM port "${this.portName}" not present. Available: ${ports.join(', ') || 'none'}`);
      }

      // Check if a POSNET USB device (VID_1424) is physically present.
      const candidates = await PosnetDriver.findPosnetCandidates();
      if (candidates.length > 0) {
        // VID_1424 device found — check if configured port matches a candidate
        const matchesConfigured = candidates.some(c => c.toUpperCase() === portUpper);
        if (matchesConfigured) {
          // The configured port IS a VID_1424 device — trust physical presence
          // even though rtcget didn't respond. The printer is plugged in.
          logger.info(`[PosnetDriver] VID_1424 confirmed on ${this.portName} — connecting without rtcget verify`);
          this.connected = true;
          return true;
        }
        // VID_1424 found but on a different port — switch to that port
        // Prefer one that responds to rtcget, fall back to first openable
        for (const port of candidates) {
          const confirmedPosnet = await PosnetDriver.verifyPosnetDevice(port);
          if (confirmedPosnet) {
            logger.info(`[PosnetDriver] Auto-detected POSNET on ${port} (was ${this.portName})`);
            this.portName = port;
            this.connected = true;
            return true;
          }
        }
        // No rtcget response on any candidate, but VID_1424 is present — use first openable
        for (const port of candidates) {
          const canOpen = await PosnetDriver.testPortOpen(port);
          if (canOpen) {
            logger.info(`[PosnetDriver] VID_1424 device on ${port} (no rtcget) — connecting on physical presence`);
            this.portName = port;
            this.connected = true;
            return true;
          }
        }
      }

      // No VID_1424 device found at all — printer is genuinely not connected
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
   * Query the printer for its model + firmware via POSNET `modinf`.
   *
   * POSNET response format: modinf TAB na<name> TAB nv<version> TAB ... TAB # CRC ETX
   * On failure (no response, wrong command, legacy model that doesn't support
   * modinf), falls back to USB VID_1424 PID lookup via POSNET_PRODUCT_IDS.
   * Result is cached on the instance (this.modelName / this.firmwareVersion)
   * so subsequent callers don't re-query the printer.
   */
  async identifyModel(): Promise<{ modelName?: string; firmwareVersion?: string; source: 'modinf' | 'usb-pid' | 'none' }> {
    if (!this.isConnected()) {
      return { source: 'none' };
    }

    // 1) Try modinf
    try {
      const responses = await this.sendPosnetSequence([['modinf']]);
      const resp = responses[0] || '';
      // Parse: find na<name> and nv<version> tokens
      const nameMatch = resp.match(/\bna([^\t\x03#]+)/);
      const versMatch = resp.match(/\bnv([^\t\x03#]+)/);
      if (nameMatch) {
        this.modelName = nameMatch[1].trim();
        if (versMatch) this.firmwareVersion = versMatch[1].trim();
        logger.info(`[PosnetDriver] modinf → ${this.modelName} fw=${this.firmwareVersion ?? '?'}`);
        return { modelName: this.modelName, firmwareVersion: this.firmwareVersion, source: 'modinf' };
      }
    } catch (err) {
      logger.warn(`[PosnetDriver] modinf failed, falling back to USB PID lookup: ${(err as Error).message}`);
    }

    // 2) Fallback: USB PID lookup for VID_1424
    try {
      const pid = await PosnetDriver.findPosnetPidForPort(this.portName);
      if (pid !== null && POSNET_PRODUCT_IDS[pid]) {
        this.modelName = `POSNET ${POSNET_PRODUCT_IDS[pid]}`;
        logger.info(`[PosnetDriver] USB PID 0x${pid.toString(16)} → ${this.modelName}`);
        return { modelName: this.modelName, source: 'usb-pid' };
      }
    } catch (err) {
      logger.debug(`[PosnetDriver] USB PID lookup failed: ${(err as Error).message}`);
    }

    return { source: 'none' };
  }

  /**
   * Print a test page via non-fiscal transaction.
   *
   * Primary path: `trinit bm0` → `trline` × N → `trend to<total>` (POSNET v2 standard).
   * Fallback path: `prninit` → `prnline tx<text>` × N → `prnend` (legacy non-fiscal
   * printout, for older POSNET models that reject `trinit`).
   *
   * Model name on the receipt is the one returned by `identifyModel()` — no
   * hard-coded model string.
   */
  async printTest(): Promise<void> {
    if (!this.isConnected()) throw new Error('Printer not connected');
    logger.info(`[PosnetDriver] Printing test page on ${this.portName}...`);

    if (!this.modelName) {
      await this.identifyModel();
    }
    const modelLine = this.modelName ? `Model: ${this.modelName}` : 'POSNET Printer';

    const lines = [
      '*** TEST PRINT ***',
      modelLine,
      `${this.portName} @ ${this.baudRate}`,
      new Date().toLocaleString('pl-PL'),
      'Zira AI Print Agent',
    ];

    // Primary: trinit / trline / trend (1 grosz per line item, non-fiscal)
    try {
      const pricePerLine = 1;
      const total = lines.length * pricePerLine;

      const frames: string[][] = [['trinit', 'bm0']];
      for (const text of lines) {
        frames.push(['trline', `na${text}`, 'vt0', `pr${pricePerLine}`, 'il1.000']);
      }
      frames.push(['trend', `to${total}`]);

      await this.sendPosnetSequence(frames);
      logger.info('[PosnetDriver] Test page printed (trinit path)');
      return;
    } catch (primaryErr) {
      logger.warn(`[PosnetDriver] trinit path failed, attempting prninit fallback: ${(primaryErr as Error).message}`);
    }

    // Fallback: prninit / prnline / prnend (legacy non-fiscal printout for older models)
    try {
      const frames: string[][] = [['prninit']];
      for (const text of lines) {
        frames.push(['prnline', `tx${text}`]);
      }
      frames.push(['prnend']);

      await this.sendPosnetSequence(frames);
      logger.info('[PosnetDriver] Test page printed (prninit fallback)');
    } catch (fallbackErr) {
      logger.error(`[PosnetDriver] Both trinit and prninit paths failed`);
      throw fallbackErr;
    }
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
        // Filter out ONLY harmless PowerShell CLIXML progress records
        // (e.g. "Preparing modules for first use"). Keep actual errors.
        const filteredStderr = stderr.replace(/#< CLIXML[\s\S]*?Preparing modules[\s\S]*?<\/Objs>/gi, '').trim();
        // Also check for CLIXML-wrapped errors (Write-Error produces CLIXML that
        // contains the real error message — don't silently swallow it).
        const cliXmlError = stderr.match(/<S S="Error">([^<]+)<\/S>/);
        if (cliXmlError) {
          const errMsg = cliXmlError[1].replace(/&#xD;&#xA;/g, '').trim();
          logger.warn(`[PosnetDriver] Serial CLIXML error: ${errMsg}`);
          throw new Error(`Serial error: ${errMsg}`);
        }
        if (filteredStderr) {
          logger.warn(`[PosnetDriver] Serial stderr: ${filteredStderr}`);
          throw new Error(`Serial error: ${filteredStderr}`);
        }
        logger.debug(`[PosnetDriver] Ignored PowerShell progress output on stderr`);
      }

      const responses = stdout.trim().split('|||');
      logger.info(`[PosnetDriver] Responses: ${JSON.stringify(responses)}`);

      // Empty stdout means PowerShell script hit an exception before producing
      // any output — the error was likely caught in the PS catch block.
      // Treat this as a write failure (common when CTS is not asserted).
      if (!stdout.trim() || (responses.length === 1 && !responses[0])) {
        throw new Error(`No data returned from printer on ${this.portName} — the printer may not be accepting data (check cable, power, and paper)`);
      }

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

      // No POSNET response on any candidate — do NOT silently return a random
      // port (the old behavior caused test prints to "succeed" silently).
      logger.warn(`[PosnetDriver] Step 3: No POSNET device responded on any candidate port`);
      return null;
    } catch (error) {
      logger.error('[PosnetDriver] detectPosnetPort failed:', error);
      return null;
    }
  }

  /**
   * Find the USB Product ID (PID) for a given COM port, if it's a POSNET
   * VID_1424 device. Returns null for non-POSNET ports.
   */
  private static async findPosnetPidForPort(port: string): Promise<number | null> {
    try {
      const psCommand =
        "Get-CimInstance Win32_PnPEntity | " +
        "Where-Object { $_.DeviceID -match 'VID_1424' -and $_.Name -match 'COM\\d+' } | " +
        "ForEach-Object { if ($_.Name -match '\\(COM(\\d+)\\)' -and $_.DeviceID -match 'PID_([0-9A-Fa-f]{4})') { Write-Output \"COM$($Matches[1])|$($Matches[1])\" } }";
      // Note: the regex overwrites $Matches for each -match — re-run both captures in order
      const fixedPsCommand =
        "Get-CimInstance Win32_PnPEntity | " +
        "Where-Object { $_.DeviceID -match 'VID_1424' } | " +
        "ForEach-Object { " +
        "  $name = $_.Name; $did = $_.DeviceID; " +
        "  if ($name -match '\\(COM(\\d+)\\)') { $com = 'COM' + $Matches[1] } else { $com = '' }; " +
        "  if ($did -match 'PID_([0-9A-Fa-f]{4})') { $pid = $Matches[1] } else { $pid = '' }; " +
        "  if ($com -and $pid) { Write-Output (\"{0}|{1}\" -f $com, $pid) } " +
        "}";
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', fixedPsCommand],
        { encoding: 'utf8', timeout: 15000 },
      );
      const target = port.toUpperCase();
      for (const line of stdout.split('\n').map(l => l.trim()).filter(Boolean)) {
        const [com, pidHex] = line.split('|');
        if (com && com.toUpperCase() === target && pidHex) {
          return parseInt(pidHex, 16);
        }
      }
      return null;
    } catch (error) {
      logger.debug(`[PosnetDriver] findPosnetPidForPort failed: ${(error as Error).message}`);
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
        '  Start-Sleep -Milliseconds 2500\n' +
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
