/**
 * PosnetProbeEngine
 *
 * Tries each COM port against multiple probe profiles (protocol + baud combos)
 * in priority order. Returns the first successful probe result.
 *
 * Design:
 * - Short timeouts to avoid blocking on busy/invalid ports
 * - Strong error handling — never crashes on port errors
 * - Profiles tried in priority order with fallback
 * - Extracts serial number + model from device response
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../../logger';
import { sanitizePortName } from '../port-utils';
import { ProbeProfile, ProbeResult, DeviceCapabilities, PosnetProtocol } from './types';
import { DEFAULT_PROBE_PROFILES, POSNET_PRODUCT_IDS } from './probe-profiles';

const execFileAsync = promisify(execFile);

// ─── CRC16-CCITT (same as posnet-driver.ts) ────────────────────────────────

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

function buildPosnetFrame(cmd: string, ...params: string[]): Buffer {
  let body = cmd + '\t';
  for (const p of params) body += p + '\t';
  const bodyBuf = Buffer.from(body, 'ascii');
  const crcHex = crc16(bodyBuf);
  const frame = Buffer.alloc(1 + bodyBuf.length + 1 + 4 + 1);
  let offset = 0;
  frame[offset++] = 0x02; // STX
  bodyBuf.copy(frame, offset); offset += bodyBuf.length;
  frame[offset++] = 0x23; // '#'
  Buffer.from(crcHex, 'ascii').copy(frame, offset); offset += 4;
  frame[offset++] = 0x03; // ETX
  return frame;
}

function frameToHex(frame: Buffer): string {
  return Array.from(frame).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(',');
}

// ─── IPosnetSdkClient interface ─────────────────────────────────────────────
// Wrapper for real Posnet DLL calls. Mark where SDK integration goes.

export interface IPosnetSdkClient {
  /** Open connection to device via SDK. */
  open(port: string, baudRate: number): Promise<boolean>;
  /** Close SDK connection. */
  close(): Promise<void>;
  /** Read device serial number via SDK. */
  getSerial(): Promise<string | null>;
  /** Read device model via SDK. */
  getModel(): Promise<string | null>;
  /** Read firmware version via SDK. */
  getFirmwareVersion(): Promise<string | null>;
  /** Check if device is fiscal. */
  isFiscal(): Promise<boolean>;
}

/**
 * Stub SDK client — replace with real DLL interop when SDK is available.
 * All methods log where the real DLL call would go.
 */
export class StubPosnetSdkClient implements IPosnetSdkClient {
  async open(port: string, baudRate: number): Promise<boolean> {
    logger.warn(`[SdkClient] STUB: Would call PosnetSDK.Open("${port}", ${baudRate})`);
    return false; // SDK not available
  }
  async close(): Promise<void> {
    logger.warn('[SdkClient] STUB: Would call PosnetSDK.Close()');
  }
  async getSerial(): Promise<string | null> {
    logger.warn('[SdkClient] STUB: Would call PosnetSDK.GetSerial()');
    return null;
  }
  async getModel(): Promise<string | null> {
    logger.warn('[SdkClient] STUB: Would call PosnetSDK.GetModel()');
    return null;
  }
  async getFirmwareVersion(): Promise<string | null> {
    logger.warn('[SdkClient] STUB: Would call PosnetSDK.GetFirmwareVersion()');
    return null;
  }
  async isFiscal(): Promise<boolean> {
    logger.warn('[SdkClient] STUB: Would call PosnetSDK.IsFiscal()');
    return false;
  }
}

// ─── PosnetProbeEngine ──────────────────────────────────────────────────────

export class PosnetProbeEngine {
  private profiles: ProbeProfile[];
  private sdkClient: IPosnetSdkClient;

  constructor(
    profiles?: ProbeProfile[],
    sdkClient?: IPosnetSdkClient,
  ) {
    this.profiles = (profiles || DEFAULT_PROBE_PROFILES)
      .slice()
      .sort((a, b) => a.priority - b.priority);
    this.sdkClient = sdkClient || new StubPosnetSdkClient();
  }

  /**
   * Probe a single port against all profiles in priority order.
   * Returns the first successful result, or null if all fail.
   */
  async probePort(port: string, pidHint?: number): Promise<ProbeResult | null> {
    const safePort = sanitizePortName(port);
    if (!safePort) {
      logger.warn(`[ProbeEngine] Invalid port name: ${port}`);
      return null;
    }

    // Sort profiles: prefer those whose hintProductIds match the PID
    const sorted = this.prioritizeProfiles(pidHint);

    for (const profile of sorted) {
      logger.info(`[ProbeEngine] Probing ${safePort} with profile "${profile.name}" (${profile.protocol} @ ${profile.baudRate})`);

      try {
        const result = await this.tryProfile(safePort, profile, pidHint);
        if (result.success) {
          logger.info(`[ProbeEngine] SUCCESS on ${safePort}: profile="${profile.name}", serial=${result.serial}, model=${result.model}`);
          return result;
        }
        logger.info(`[ProbeEngine] Profile "${profile.name}" failed on ${safePort}: ${result.errorMessage}`);
      } catch (err: any) {
        logger.warn(`[ProbeEngine] Profile "${profile.name}" threw on ${safePort}: ${err.message}`);
      }
    }

    logger.info(`[ProbeEngine] All profiles exhausted for ${safePort}`);
    return null;
  }

  /**
   * Try a single profile against a port.
   */
  private async tryProfile(port: string, profile: ProbeProfile, pidHint?: number): Promise<ProbeResult> {
    if (profile.protocol === 'SDK_BRIDGE') {
      return this.trySdkProfile(port, profile);
    }

    if (profile.protocol === 'THERMAL') {
      return this.tryThermalProfile(port, profile);
    }

    // POSNET_V2: send rtcget + sernr to identify device
    return this.tryPosnetV2Profile(port, profile, pidHint);
  }

  /**
   * POSNET v2 probe: send rtcget (verify device) then sernr (get serial).
   */
  private async tryPosnetV2Profile(port: string, profile: ProbeProfile, pidHint?: number): Promise<ProbeResult> {
    const rtcFrame = buildPosnetFrame('rtcget');
    const sernrFrame = buildPosnetFrame('sernr');
    const rtcHex = frameToHex(rtcFrame);
    const sernrHex = frameToHex(sernrFrame);

    // Single PowerShell session: open port → send rtcget → read → send sernr → read → close
    const psScript = `
$ErrorActionPreference = 'Stop'
$p = New-Object System.IO.Ports.SerialPort('${port}', ${profile.baudRate}, '${profile.parity}', ${profile.dataBits}, '${profile.stopBits}')
$p.WriteTimeout = ${profile.timeoutMs}
$p.ReadTimeout = ${profile.timeoutMs}
$p.DtrEnable = $true
$p.RtsEnable = $true
$results = @()
try {
  $p.Open()

  # Command 1: rtcget (verify POSNET device)
  $f1 = [byte[]]@(${rtcHex})
  $p.Write($f1, 0, $f1.Length)
  Start-Sleep -Milliseconds 800
  $n1 = $p.BytesToRead
  if ($n1 -gt 0) {
    $buf1 = New-Object byte[] $n1
    $p.Read($buf1, 0, $n1) | Out-Null
    $results += [System.Text.Encoding]::ASCII.GetString($buf1)
  } else {
    $results += 'NOREPLY'
  }

  # Command 2: sernr (get serial number)
  $f2 = [byte[]]@(${sernrHex})
  $p.Write($f2, 0, $f2.Length)
  Start-Sleep -Milliseconds 800
  $n2 = $p.BytesToRead
  if ($n2 -gt 0) {
    $buf2 = New-Object byte[] $n2
    $p.Read($buf2, 0, $n2) | Out-Null
    $results += [System.Text.Encoding]::ASCII.GetString($buf2)
  } else {
    $results += 'NOREPLY'
  }

  $results -join '|||'
} catch {
  Write-Error $_.Exception.Message
} finally {
  if ($p.IsOpen) { $p.Close() }
}
`.trim();

    try {
      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
      const { stdout, stderr } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        { encoding: 'utf8', timeout: profile.timeoutMs * 3 + 5000 },
      );

      if (stderr?.trim()) {
        return ProbeResult_Failure(port, profile.name, `Serial error: ${stderr.trim()}`);
      }

      const parts = stdout.trim().split('|||');
      const rtcResp = parts[0] || '';
      const sernrResp = parts[1] || '';

      // Validate rtcget response (must contain STX byte or 'rtcget')
      const isRtcValid = rtcResp.charCodeAt(0) === 0x02 || rtcResp.includes('rtcget');
      if (!isRtcValid && rtcResp !== 'NOREPLY') {
        // Might still be a POSNET device with unexpected response format
        logger.info(`[ProbeEngine] Unexpected rtcget response on ${port}: ${rtcResp.substring(0, 60)}`);
      }
      if (rtcResp === 'NOREPLY') {
        return ProbeResult_Failure(port, profile.name, 'No response to rtcget');
      }

      // Parse serial number from sernr response
      const serial = this.parseSerialFromResponse(sernrResp);
      // Try to infer model from PID
      const model = pidHint ? (POSNET_PRODUCT_IDS[pidHint] || `PID_${pidHint.toString(16)}`) : 'Unknown Posnet';

      return {
        success: true,
        port,
        profileName: profile.name,
        serial: serial || `UNKNOWN_${port}`,
        model,
        protocol: profile.protocol,
        library: profile.library,
        baudRate: profile.baudRate,
        capabilities: {
          fiscal: true, // POSNET v2 devices are fiscal by definition
          customerDisplay: true,
          cashDrawer: true,
          nip: true,
        },
      };
    } catch (err: any) {
      return ProbeResult_Failure(port, profile.name, err.message);
    }
  }

  /**
   * Thermal/ESC-POS probe: send ESC/POS status request.
   */
  private async tryThermalProfile(port: string, profile: ProbeProfile): Promise<ProbeResult> {
    // ESC/POS: send DLE EOT 1 (real-time status request)
    const statusCmd = '0x10,0x04,0x01';

    const psScript = `
$ErrorActionPreference = 'Stop'
$p = New-Object System.IO.Ports.SerialPort('${port}', ${profile.baudRate}, '${profile.parity}', ${profile.dataBits}, '${profile.stopBits}')
$p.WriteTimeout = ${profile.timeoutMs}
$p.ReadTimeout = ${profile.timeoutMs}
$p.DtrEnable = $true
$p.RtsEnable = $true
try {
  $p.Open()
  $f = [byte[]]@(${statusCmd})
  $p.Write($f, 0, $f.Length)
  Start-Sleep -Milliseconds 500
  $n = $p.BytesToRead
  if ($n -gt 0) {
    $buf = New-Object byte[] $n
    $p.Read($buf, 0, $n) | Out-Null
    Write-Output "THERMAL_OK"
  } else {
    Write-Output "NOREPLY"
  }
} catch {
  Write-Error $_.Exception.Message
} finally {
  if ($p.IsOpen) { $p.Close() }
}
`.trim();

    try {
      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
      const { stdout, stderr } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        { encoding: 'utf8', timeout: profile.timeoutMs + 5000 },
      );

      if (stderr?.trim() || stdout.trim() === 'NOREPLY') {
        return ProbeResult_Failure(port, profile.name, stderr?.trim() || 'No response');
      }

      if (stdout.trim() === 'THERMAL_OK') {
        return {
          success: true,
          port,
          profileName: profile.name,
          serial: `THERMAL_${port}`,
          model: 'Thermal Printer',
          protocol: 'THERMAL',
          library: '',
          baudRate: profile.baudRate,
          capabilities: {
            fiscal: false,
            customerDisplay: false,
            cashDrawer: true,
            nip: false,
          },
        };
      }

      return ProbeResult_Failure(port, profile.name, `Unexpected response: ${stdout.trim()}`);
    } catch (err: any) {
      return ProbeResult_Failure(port, profile.name, err.message);
    }
  }

  /**
   * SDK/DLL probe — delegates to IPosnetSdkClient.
   */
  private async trySdkProfile(port: string, profile: ProbeProfile): Promise<ProbeResult> {
    try {
      const opened = await this.sdkClient.open(port, profile.baudRate);
      if (!opened) {
        return ProbeResult_Failure(port, profile.name, 'SDK open() returned false');
      }

      const serial = await this.sdkClient.getSerial();
      const model = await this.sdkClient.getModel();
      const firmware = await this.sdkClient.getFirmwareVersion();
      const fiscal = await this.sdkClient.isFiscal();

      await this.sdkClient.close();

      if (!serial) {
        return ProbeResult_Failure(port, profile.name, 'SDK returned no serial');
      }

      return {
        success: true,
        port,
        profileName: profile.name,
        serial,
        model: model || 'Unknown (SDK)',
        firmwareVersion: firmware || undefined,
        protocol: 'SDK_BRIDGE',
        library: profile.library,
        baudRate: profile.baudRate,
        capabilities: {
          fiscal,
          customerDisplay: true,
          cashDrawer: true,
          nip: fiscal,
        },
      };
    } catch (err: any) {
      try { await this.sdkClient.close(); } catch (err2: any) { logger.debug('[PosnetProbeEngine] close SDK client after probe failure failed:', err2?.message); }
      return ProbeResult_Failure(port, profile.name, err.message);
    }
  }

  /**
   * Parse serial number from POSNET sernr response.
   * Response format: STX + "sernr\tse<serial>\t" + '#' + CRC + ETX
   */
  private parseSerialFromResponse(response: string): string | null {
    if (!response || response === 'NOREPLY') return null;

    // Try to extract "se" parameter (serial number)
    const seMatch = response.match(/se([A-Za-z0-9]+)/);
    if (seMatch) return seMatch[1];

    // Try to extract any alphanumeric string after "sernr"
    const sernrMatch = response.match(/sernr\t([^\t#]+)/);
    if (sernrMatch) return sernrMatch[1];

    return null;
  }

  /**
   * Reorder profiles so those matching the PID hint come first.
   */
  private prioritizeProfiles(pidHint?: number): ProbeProfile[] {
    if (!pidHint) return this.profiles;

    const hinted: ProbeProfile[] = [];
    const rest: ProbeProfile[] = [];

    for (const p of this.profiles) {
      if (p.hintProductIds.includes(pidHint)) {
        hinted.push(p);
      } else {
        rest.push(p);
      }
    }

    return [...hinted, ...rest];
  }
}

function ProbeResult_Failure(port: string, profileName: string, error: string): ProbeResult {
  return {
    success: false,
    port,
    profileName,
    protocol: 'POSNET_V2',
    baudRate: 0,
    errorMessage: error,
  };
}
