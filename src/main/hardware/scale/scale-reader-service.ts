import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AgentConfig } from '../../../shared/types';
import { getVidForPort, listSerialPorts } from '../port-utils';
import { DibalGdposScaleDriver, type ScaleReadResult } from './dibal-gdpos-scale-driver';

export interface ScaleReadOptions {
  port?: string;
}

const KNOWN_SCALE_PORTS = ['COM5'];
const KNOWN_SCALE_SERIAL_VIDS = new Set([
  '067B', // Prolific PL2303 USB-serial adapter used by the Dibal scale cable
]);
const KNOWN_NON_SCALE_SERIAL_VIDS = new Set([
  '079B', // Ingenico/Elavon Move/5000 payment terminal
]);
const execFileAsync = promisify(execFile);
const SCALE_PORT_CACHE_MS = 10 * 60 * 1000;

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

  for (const knownPort of KNOWN_SCALE_PORTS) addCandidate(knownPort);
  if (candidates.length > 0) return candidates;

  for (const candidate of ports) {
    const port = candidate.toUpperCase();
    if (configuredPorts.has(port)) continue;
    if (candidates.includes(port)) continue;
    const vid = await getVidForPort(candidate).catch(() => null);
    vidByPort.set(port, vid);
    if (vid && KNOWN_SCALE_SERIAL_VIDS.has(vid)) addCandidate(candidate);
  }

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

export async function readScaleWeight(
  config: AgentConfig,
  options?: ScaleReadOptions,
): Promise<ScaleReadResult> {
  const explicitPort = String(options?.port || config.scale?.port || '').trim().toUpperCase();
  const baudRate = config.scale?.baudRate || 9600;
  const readScale = (port: string) => new DibalGdposScaleDriver(port, baudRate).readWeight();
  const rememberSuccess = (result: ScaleReadResult): ScaleReadResult => {
    if (result.success) {
      cachedScalePort = { port: result.port, expiresAt: Date.now() + SCALE_PORT_CACHE_MS };
    }
    return result;
  };

  if (explicitPort) return rememberSuccess(await readScale(explicitPort));

  const configuredPorts = collectConfiguredSerialPorts(config);
  if (cachedScalePort && cachedScalePort.expiresAt > Date.now() && !configuredPorts.has(cachedScalePort.port)) {
    const cachedResult = await readScale(cachedScalePort.port);
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
    const result = await readScale(candidate);
    if (result.success) return rememberSuccess(result);
    firstFailure ||= result;
  }

  return firstFailure || rememberSuccess(await readScale(ports[0] || ''));
}
