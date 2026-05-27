import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../../logger';
import { sanitizePortName } from '../port-utils';
import { withPortLock } from '../posnet/port-mutex';

const execFileAsync = promisify(execFile);

export type ScaleReadErrorCode =
  | 'INVALID_PORT'
  | 'PORT_BUSY'
  | 'NO_ACK'
  | 'NO_FRAME'
  | 'PARSE_FAILED'
  | 'SERIAL_ERROR'
  | 'UNSTABLE';

export interface ScaleReadSuccess {
  success: true;
  protocol: 'DIBAL_GDPOS';
  port: string;
  weightKg: number;
  stable: boolean;
  status: string;
  rawAscii: string;
  rawHex: string;
}

export interface ScaleReadFailure {
  success: false;
  protocol: 'DIBAL_GDPOS';
  port?: string;
  error: string;
  code: ScaleReadErrorCode;
  rawAscii?: string;
  rawHex?: string;
  status?: string;
}

export type ScaleReadResult = ScaleReadSuccess | ScaleReadFailure;

const DEFAULT_BAUD_RATE = 9600;
const ACK = 0x06;

function hex(bytes: Buffer): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function printableAscii(bytes: Buffer): string {
  return bytes.toString('ascii').replace(/[^\x20-\x7E\r\n\t]/g, '.');
}

export function parseDibalGdposFrame(bytes: Buffer): {
  ok: true;
  weightKg: number;
  stable: boolean;
  status: string;
  rawAscii: string;
  rawHex: string;
} | {
  ok: false;
  code: 'PARSE_FAILED' | 'UNSTABLE';
  error: string;
  rawAscii: string;
  rawHex: string;
  status?: string;
} {
  const rawAscii = printableAscii(bytes);
  const rawHex = hex(bytes);
  const match = rawAscii.match(/\b([A-Z])\s*([+-]?\d{2}\.\d{3})kg/i);
  if (!match) {
    return { ok: false, code: 'PARSE_FAILED', error: 'Scale response did not include a kg weight', rawAscii, rawHex };
  }

  const status = match[1].toUpperCase();
  const weightKg = Number(match[2]);
  if (!Number.isFinite(weightKg)) {
    return { ok: false, code: 'PARSE_FAILED', error: 'Scale response weight is not a number', rawAscii, rawHex, status };
  }

  const stable = status === 'S';
  if (!stable) {
    return { ok: false, code: 'UNSTABLE', error: `Scale weight is not stable (status=${status})`, rawAscii, rawHex, status };
  }

  return { ok: true, weightKg, stable, status, rawAscii, rawHex };
}

async function pollDibalGdpos(port: string, baudRate = DEFAULT_BAUD_RATE): Promise<ScaleReadResult> {
  const safePort = sanitizePortName(port);
  if (!safePort) {
    return { success: false, protocol: 'DIBAL_GDPOS', error: 'Invalid scale COM port', code: 'INVALID_PORT' };
  }

  const lock = await withPortLock<ScaleReadResult>(safePort, 'read dibal scale', async (): Promise<ScaleReadResult> => {
    const psScript = `
$ErrorActionPreference = 'Stop'
$p = New-Object System.IO.Ports.SerialPort('${safePort}', ${baudRate}, 'None', 8, 'One')
$p.ReadTimeout = 250
$p.WriteTimeout = 250
$p.DtrEnable = $true
$p.RtsEnable = $true
function Read-Bytes([int]$timeoutMs, [int]$quietMs, [bool]$returnAfterFirst, [bool]$stopOnEot) {
  $buf = New-Object System.Collections.Generic.List[byte]
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  $lastReadAt = Get-Date
  $sawBytes = $false
  while ((Get-Date) -lt $deadline) {
    $n = $p.BytesToRead
    if ($n -gt 0) {
      $bytes = New-Object byte[] $n
      [void]$p.Read($bytes, 0, $n)
      foreach ($b in $bytes) { $buf.Add($b) }
      $lastReadAt = Get-Date
      $sawBytes = $true
      if ($returnAfterFirst -and $buf.Count -gt 0) { break }
      if ($stopOnEot -and $buf.Count -gt 0 -and $buf[$buf.Count - 1] -eq 0x04) { break }
    } else {
      if ($sawBytes -and (((Get-Date) - $lastReadAt).TotalMilliseconds -ge $quietMs)) { break }
      Start-Sleep -Milliseconds 10
    }
  }
  return $buf.ToArray()
}
try {
  $p.Open()
  if ($p.BytesToRead -gt 0) { [void]([byte[]]@(Read-Bytes 120 30 $false $false)) }
  $p.Write([byte[]](0x05), 0, 1)
  $ack = [byte[]]@(Read-Bytes 350 20 $true $false)
  if ($ack.Length -lt 1 -or $ack[0] -ne 0x06) {
    $ackB64 = [Convert]::ToBase64String($ack)
    Write-Output (@{ ok = $false; code = 'NO_ACK'; ack = $ackB64 } | ConvertTo-Json -Compress)
    exit 0
  }
  $p.Write([byte[]](0x12), 0, 1)
  $frame = [byte[]]@(Read-Bytes 900 60 $false $true)
  if ($frame.Length -lt 1) {
    Write-Output (@{ ok = $false; code = 'NO_FRAME'; frame = '' } | ConvertTo-Json -Compress)
    exit 0
  }
  $frameB64 = [Convert]::ToBase64String($frame)
  Write-Output (@{ ok = $true; frame = $frameB64 } | ConvertTo-Json -Compress)
} catch {
  Write-Output (@{ ok = $false; code = 'SERIAL_ERROR'; error = $_.Exception.Message } | ConvertTo-Json -Compress)
} finally {
  if ($p -and $p.IsOpen) { $p.Close() }
  if ($p) { $p.Dispose() }
}
`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 4000 },
    );
    const line = stdout.trim().split(/\r?\n/).find((l) => l.trim().startsWith('{')) ?? '';
    if (!line) {
      return { success: false, protocol: 'DIBAL_GDPOS', port: safePort, error: 'Scale command returned no result', code: 'SERIAL_ERROR' as const };
    }
    const parsed = JSON.parse(line) as { ok: boolean; code?: ScaleReadErrorCode; error?: string; ack?: string; frame?: string };
    if (!parsed.ok) {
      const raw = parsed.ack || parsed.frame ? Buffer.from(parsed.ack || parsed.frame || '', 'base64') : Buffer.alloc(0);
      return {
        success: false,
        protocol: 'DIBAL_GDPOS',
        port: safePort,
        error: parsed.error || (parsed.code === 'NO_ACK' ? 'Scale did not ACK the ENQ handshake' : 'Scale returned no weight frame'),
        code: parsed.code || 'SERIAL_ERROR',
        rawAscii: raw.length ? printableAscii(raw) : undefined,
        rawHex: raw.length ? hex(raw) : undefined,
      };
    }

    const frame = Buffer.from(parsed.frame || '', 'base64');
    const result = parseDibalGdposFrame(frame);
    if (!result.ok) {
      const { ok: _ok, ...failure } = result;
      return { success: false, protocol: 'DIBAL_GDPOS', port: safePort, ...failure };
    }

    const { ok: _ok, ...success } = result;
    return { success: true, protocol: 'DIBAL_GDPOS', port: safePort, ...success };
  });

  if (!lock.ok) {
    return { success: false, protocol: 'DIBAL_GDPOS', port: safePort, error: lock.message, code: 'PORT_BUSY' };
  }

  return lock.value;
}

export class DibalGdposScaleDriver {
  constructor(private readonly port: string, private readonly baudRate = DEFAULT_BAUD_RATE) {}

  async readWeight(): Promise<ScaleReadResult> {
    const result = await pollDibalGdpos(this.port, this.baudRate);
    if (result.success) {
      logger.info(`[Scale] Dibal GDPOS ${result.port}: ${result.weightKg.toFixed(3)} kg status=${result.status}`);
    } else {
      logger.warn(`[Scale] Dibal GDPOS ${result.port || this.port}: ${result.code} ${result.error}`);
    }
    return result;
  }
}
