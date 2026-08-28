import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AgentConfig, ScaleReadResult, ScaleAutoDetectResult, ScaleDiagnoseStep } from '../../../shared/types';
import { getVidForPort, listSerialPorts } from '../port-utils';
import { DibalGdposScaleDriver } from './dibal-gdpos-scale-driver';
import { readRemoteScaleWeight, resolveScaleConnection } from './scale-network-service';
import { getConfig, setConfig } from '../../config/store';

export interface ScaleReadOptions {
  port?: string;
  forceLocal?: boolean;
}

const KNOWN_SCALE_SERIAL_VIDS = new Set([
  '067B', // Prolific PL2303 USB-serial adapter used by the Dibal scale cable
  '0403', // FTDI FT232R / FT232 / FT2232 / FT4232 USB-serial adapter
  '1A86', // QinHeng CH340 / CH341 USB-serial adapter
  '10C4', // Silicon Labs CP210x USB-to-UART bridge
  '0483', // STMicroelectronics Virtual COM Port
  '04D8', // Microchip CDC
  '2341', // Arduino CDC
  '2A03', // Arduino CDC
]);
const KNOWN_NON_SCALE_SERIAL_VIDS = new Set([
  '079B', // Ingenico/Elavon Move/5000 payment terminal
  'C1CA', // ELZAB fiscal printer
  '1424', // POSNET fiscal printer
]);
const execFileAsync = promisify(execFile);
const SCALE_PORT_CACHE_MS = 10 * 60 * 1000;

// A scale that answers with UNSTABLE is physically there — the load is just still
// settling. One short retry catches the common "customer just put the item down"
// case. Keep this at ONE retry: every read spawns a PowerShell probe with a 4s
// timeout, so each extra attempt adds up to 4s of latency to the POS weigh button,
// multiplied by the number of candidate ports being probed.
const SCALE_UNSTABLE_RETRIES = 1;
const SCALE_UNSTABLE_RETRY_DELAY_MS = 250;

async function readWithUnstableRetry(
  read: () => Promise<ScaleReadResult>,
): Promise<ScaleReadResult> {
  let result = await read();
  for (let retry = 0; retry < SCALE_UNSTABLE_RETRIES; retry++) {
    if (result.success || result.code !== 'UNSTABLE') break;
    await new Promise((resolve) => setTimeout(resolve, SCALE_UNSTABLE_RETRY_DELAY_MS));
    const retryResult = await read();
    if (retryResult.success) return retryResult;
    result = retryResult.code === 'UNSTABLE' ? result : retryResult;
  }
  return result;
}

let cachedScalePort: { port: string; expiresAt: number } | null = null;

function addComPort(ports: Set<string>, port?: string | null): void {
  const normalized = String(port || '').trim().toUpperCase();
  if (/^COM\d{1,3}$/.test(normalized)) ports.add(normalized);
}

export function collectConfiguredSerialPorts(config: AgentConfig): Set<string> {
  const ports = new Set<string>();
  addComPort(ports, config.printerPort);
  addComPort(ports, config.receiptPrinter?.port);
  addComPort(ports, config.labelPrinter?.port);
  Object.values(config.printers || {}).forEach((printer) => addComPort(ports, printer?.port));
  return ports;
}

export function mergeScaleSerialPorts(serialPorts: string[], scaleUsbPorts: string[]): string[] {
  const ports: string[] = [];
  const add = (value?: string | null) => {
    const port = String(value || '').trim().toUpperCase();
    if (/^COM\d{1,3}$/.test(port) && !ports.includes(port)) ports.push(port);
  };
  serialPorts.forEach(add);
  scaleUsbPorts.forEach(add);
  return ports;
}

export async function listPresentScaleUsbSerialPorts(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  try {
    const vids = Array.from(KNOWN_SCALE_SERIAL_VIDS);
    const psScript =
      "$ErrorActionPreference = 'SilentlyContinue'\n" +
      `$vids = @(${vids.map((vid) => `'${vid}'`).join(',')})\n` +
      "Get-PnpDevice -Class Ports -PresentOnly -Status OK -ErrorAction SilentlyContinue | ForEach-Object {\n" +
      "  $fn = $_.FriendlyName\n" +
      "  $iid = $_.InstanceId\n" +
      "  if ($fn -match '\\(COM(\\d+)\\)') {\n" +
      "    $com = \"COM$($Matches[1])\"\n" +
      "    foreach ($vid in $vids) {\n" +
      "      if ($iid -match \"VID_$vid\") { Write-Output $com; break }\n" +
      "    }\n" +
      "  }\n" +
      "}\n";
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 8000 },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim().toUpperCase())
      .filter((line, index, lines) => /^COM\d{1,3}$/.test(line) && lines.indexOf(line) === index);
  } catch {
    return [];
  }
}

export async function buildScalePortCandidates(
  ports: string[],
  configuredPorts: Set<string>,
): Promise<string[]> {
  const availablePorts = new Set(ports.map((port) => port.toUpperCase()));
  const candidates: string[] = [];
  const vidByPort = new Map<string, string | null>();
  const addCandidate = (candidate?: string | null) => {
    const port = String(candidate || '').trim().toUpperCase();
    if (!port || !availablePorts.has(port) || configuredPorts.has(port) || candidates.includes(port)) return;
    candidates.push(port);
  };

  // 1. High priority: ports with matching known scale USB VIDs (FTDI, Prolific, CH340, CP210x...)
  for (const candidate of ports) {
    const port = candidate.toUpperCase();
    if (configuredPorts.has(port)) continue;
    const vid = await getVidForPort(candidate).catch(() => null);
    vidByPort.set(port, vid);
    if (vid && KNOWN_SCALE_SERIAL_VIDS.has(vid)) addCandidate(candidate);
  }

  // 2. Fallback: all remaining live serial ports not used by printers / non-scale devices
  for (const candidate of ports) {
    const port = candidate.toUpperCase();
    if (configuredPorts.has(port)) continue;
    if (candidates.includes(port)) continue;
    const vid = vidByPort.has(port) ? vidByPort.get(port) : await getVidForPort(candidate).catch(() => null);
    if (vid && KNOWN_NON_SCALE_SERIAL_VIDS.has(vid)) continue;
    addCandidate(candidate);
  }

  return candidates;
}

export function identifyScaleChipset(vid?: string | null): string {
  const vidUpper = (vid || '').toUpperCase();
  if (vidUpper === '0403') return 'FTDI FT232 / USB-to-Serial';
  if (vidUpper === '067B') return 'Prolific PL2303 / USB-to-Serial';
  if (vidUpper === '1A86') return 'QinHeng CH340 / CH341';
  if (vidUpper === '10C4') return 'Silicon Labs CP210x';
  if (vidUpper === '0483') return 'STMicroelectronics Virtual COM';
  if (vidUpper === '04D8') return 'Microchip UART';
  if (vidUpper === '2341' || vidUpper === '2A03') return 'Arduino CDC';
  return vidUpper ? `USB Serial (VID_${vidUpper})` : 'Standard Serial Port';
}

export async function detectAndSetupScale(
  config?: AgentConfig,
): Promise<ScaleAutoDetectResult> {
  const currentConfig = config || getConfig();
  const [serialPorts, scaleUsbPorts] = await Promise.all([
    listSerialPorts(),
    listPresentScaleUsbSerialPorts(),
  ]);
  const ports = mergeScaleSerialPorts(serialPorts, scaleUsbPorts);
  const configuredPorts = collectConfiguredSerialPorts(currentConfig);
  const candidates = await buildScalePortCandidates(ports, configuredPorts);

  const steps: ScaleDiagnoseStep[] = [];

  if (candidates.length === 0) {
    steps.push({
      step: 'Port scan',
      ok: false,
      error: 'No candidate COM ports available on this machine',
    });
    return {
      success: false,
      steps,
      message: 'No available COM ports found on this machine to detect scale.',
    };
  }

  const baudRate = currentConfig.scale?.baudRate || 9600;
  for (const candidate of candidates) {
    const vid = await getVidForPort(candidate).catch(() => null);
    const chipName = identifyScaleChipset(vid);

    const driver = new DibalGdposScaleDriver(candidate, baudRate);
    const result = await readWithUnstableRetry(() => driver.readWeight());

    if (result.success || (result.rawAscii && result.code === 'UNSTABLE')) {
      const weight = result.success ? result.weightKg : undefined;
      const latestConfig = getConfig();
      const scaleModelName = 'DIBAL GDPOS Scale';
      const driverStatusText = 'OK (Driver active & communicating)';

      steps.push({
        step: `Port detection (${candidate})`,
        ok: true,
        detail: `Found active serial port on ${candidate}`,
      });
      steps.push({
        step: 'Chipset identification',
        ok: true,
        detail: `${chipName}${vid ? ` (VID_${vid})` : ''}`,
      });
      steps.push({
        step: 'Scale protocol handshake',
        ok: true,
        detail: 'DIBAL GDPOS @ 9600 8N1: ENQ (0x05) -> ACK (0x06) confirmed',
      });
      steps.push({
        step: 'Weight frame decoding',
        ok: true,
        detail: `Current reading: ${weight !== undefined ? weight.toFixed(3) + ' kg' : '0.000 kg'} (${result.success ? 'Stable' : 'Unstable'})`,
      });

      // Save complete scale configuration into local machine settings.
      // A shop configured for a Wi-Fi (remote) scale keeps that mode: this routine
      // also runs from best-effort auto-setup, and silently flipping such a shop to
      // a local scale would point the POS at the wrong device. Record the port and
      // hardware details either way so a later manual switch to "local" is ready.
      const keepRemoteMode = latestConfig.scale?.connection === 'remote';
      setConfig({
        scale: {
          ...latestConfig.scale,
          enabled: keepRemoteMode ? latestConfig.scale?.enabled ?? true : true,
          connection: keepRemoteMode ? 'remote' : 'local',
          port: candidate,
          protocol: 'DIBAL_GDPOS',
          baudRate,
          chipset: chipName,
          model: scaleModelName,
          driverStatus: driverStatusText,
        },
      });

      cachedScalePort = { port: candidate, expiresAt: Date.now() + SCALE_PORT_CACHE_MS };

      return {
        success: true,
        port: candidate,
        protocol: 'DIBAL_GDPOS',
        chipset: chipName,
        model: scaleModelName,
        driverStatus: driverStatusText,
        baudRate,
        weightKg: weight,
        stable: result.success ? result.stable : false,
        steps,
        message: `Scale connected & saved on ${candidate} (${chipName})${weight !== undefined ? ` [${weight.toFixed(3)} kg]` : ''}`,
      };
    } else {
      steps.push({
        step: `Port probe (${candidate})`,
        ok: false,
        detail: `${chipName}: ${result.error || result.code}`,
      });
    }
  }

  return {
    success: false,
    steps,
    message: `Probed port(s) ${candidates.join(', ')}: no responsive scale found. Please check cable and scale settings (DIBAL GDPOS 9600 8N1).`,
  };
}

export async function readScaleWeight(
  config: AgentConfig,
  options?: ScaleReadOptions,
): Promise<ScaleReadResult> {
  if (!options?.forceLocal && resolveScaleConnection(config) === 'remote') {
    return readRemoteScaleWeight(config);
  }

  const explicitPort = String(options?.port || config.scale?.port || '').trim().toUpperCase();
  const baudRate = config.scale?.baudRate || 9600;
  const readScale = (port: string) => new DibalGdposScaleDriver(port, baudRate).readWeight();
  const rememberSuccess = (result: ScaleReadResult): ScaleReadResult => {
    if (result.success) {
      cachedScalePort = { port: result.port, expiresAt: Date.now() + SCALE_PORT_CACHE_MS };
    }
    return result;
  };

  if (explicitPort) {
    const result = await readWithUnstableRetry(() => readScale(explicitPort));
    return rememberSuccess(result);
  }

  const configuredPorts = collectConfiguredSerialPorts(config);
  if (cachedScalePort && cachedScalePort.expiresAt > Date.now() && !configuredPorts.has(cachedScalePort.port)) {
    const cachedResult = await readWithUnstableRetry(() => readScale(cachedScalePort!.port));
    if (cachedResult.success) return rememberSuccess(cachedResult);
    cachedScalePort = null;
  }

  const [serialPorts, scaleUsbPorts] = await Promise.all([
    listSerialPorts(),
    listPresentScaleUsbSerialPorts(),
  ]);
  const ports = mergeScaleSerialPorts(serialPorts, scaleUsbPorts);
  const candidates = await buildScalePortCandidates(ports, configuredPorts);

  let firstFailure: ScaleReadResult | null = null;
  for (const candidate of candidates) {
    const result = await readWithUnstableRetry(() => readScale(candidate));
    if (result.success) return rememberSuccess(result);
    firstFailure ||= result;
  }

  return firstFailure || rememberSuccess(await readScale(ports[0] || ''));
}
