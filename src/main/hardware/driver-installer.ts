import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import logger from '../logger';
import { BRAND_PATTERNS } from './detection/types';
import { listSerialPorts, isUsbPrintPortPresent } from './port-utils';

const execFileAsync = promisify(execFile);

/** Known USB Vendor IDs for fiscal/receipt printers */
const POSNET_VID = '1424';   // POSNET Polska S.A.
const ZEBRA_VID  = '0A5F';   // Zebra Technologies (GK420d, ZD410, etc.)
const HP_VID     = '03F0';   // HP printers

/** All known printer VIDs from brand patterns (for PnP scan) */
const ALL_PRINTER_VIDS = [...new Set(BRAND_PATTERNS.flatMap(bp => bp.vids))];
const PNP_PRINTER_KEYWORDS = [
  ...new Set([
    'printer',
    'print',
    'label',
    'receipt',
    'pos',
    'drukarka',
    ...BRAND_PATTERNS.flatMap(bp => bp.namePatterns),
  ]),
];

export interface DetectedDevice {
  vid: string;
  pid: string;
  brand: string;
  model: string;
  windowsPrinterName: string | null;   // installed Windows printer name, if any
  comPort: string | null;              // COM port for serial devices
  portName: string | null;             // Windows port name (USB001, USB002, etc.)
  connectionType: 'USB' | 'SERIAL' | 'NETWORK' | 'VIRTUAL';
  driverInstalled: boolean;
  /** Recommended printer type slot (RECEIPT, FISCAL, LABEL, A4). Set by classifyPrinterCategory(). */
  targetType?: string;
  /** Recommended protocol (POSNET, ELZAB_STX, ZEBRA, THERMAL, WINDOWS). Set by classifyPrinterCategory(). */
  recommendedProtocol?: string;
  /** When false, show the device but require manual slot selection instead of auto-setup. */
  autoSetupEligible?: boolean;
}

const POSNET_MANUAL_PROTOCOL_PIDS = new Set(['100A', '100B']); // Thermal HD/XL can be set to different PC protocols.

function normalizeUsbPid(pid: string | null | undefined): string {
  const cleaned = (pid || '').replace(/^0x/i, '').toUpperCase();
  return cleaned ? cleaned.padStart(4, '0') : '';
}

export function requiresManualPosnetProtocolSelection(device: Pick<DetectedDevice, 'vid' | 'pid' | 'brand' | 'model'>): boolean {
  const brand = (device.brand || '').toUpperCase();
  const vid = (device.vid || '').toUpperCase();
  if (brand !== 'POSNET' && vid !== POSNET_VID) return false;

  const pid = normalizeUsbPid(device.pid);
  if (pid && POSNET_MANUAL_PROTOCOL_PIDS.has(pid)) return true;

  return /\bthermal\s+(hd|xl)\b/i.test(device.model || '');
}

export interface HardwareStatus {
  devices: DetectedDevice[];
  posnetPresent: boolean;
  posnetComPort: string | null;
  posnetDriverInstalled: boolean;
  serialPorts: string[];
  windowsPrinters: Array<{ name: string; port: string }>;
}

export interface DriverInstallResult {
  success: boolean;
  message: string;
  rebootRequired?: boolean;
}

let inFlightDriverStatusScan: Promise<HardwareStatus> | null = null;

/** Path to bundled posnetCDC15v.inf — works dev and packaged */
export function getPosnetInfPath(): string {
  const rel = path.join('drivers', 'posnet', 'posnetCDC15v.inf');
  if (app.isPackaged) {
    return path.join(process.resourcesPath, rel);
  }
  return path.join(app.getAppPath(), 'resources', rel);
}

/**
 * Detect all connected printers and their status.
 * Combines two detection methods in a single PowerShell invocation:
 * 1. Windows Get-Printer — finds all installed printers (USB, network, virtual)
 * 2. USB PnP VID scan — finds POSNET serial/CDC devices that don't appear as Windows printers
 *    (includes COM port lookup for serial devices)
 */
export async function getPosnetDriverStatus(): Promise<HardwareStatus> {
  if (inFlightDriverStatusScan) {
    logger.info('[DriverInstaller] getPosnetDriverStatus() joining in-flight scan');
    return inFlightDriverStatusScan;
  }

  inFlightDriverStatusScan = detectPosnetDriverStatus().finally(() => {
    inFlightDriverStatusScan = null;
  });
  return inFlightDriverStatusScan;
}

async function detectPosnetDriverStatus(): Promise<HardwareStatus> {
  const devices: DetectedDevice[] = [];
  const seenPrinterNames = new Set<string>();
  let serialPorts: string[] = [];

  interface SpoolerPrinter {
    name: string;
    port: string;
    driver: string;
    workOffline: boolean;
    printerStatus: string;
    pnpId: string;
    pnpPresent: 'true' | 'false' | 'unknown';
  }
  const installedPrinters: SpoolerPrinter[] = [];

  logger.info('[DriverInstaller] getPosnetDriverStatus() called — running with ghost-printer filter v4 (PNPDeviceID + Section-2 class allowlist + ghost-name memory)');

  // Names of every spooler printer we considered — kept OR filtered. Used at the
  // end of Section 2 to make sure a PnP hit can never resurrect a ghost as a
  // standalone USB device. Lowercased for case-insensitive matching.
  const allSpoolerNames = new Set<string>();
  // Subset of allSpoolerNames that we explicitly DROPPED as ghosts. Used in
  // Section 2 to refuse hits that would resurrect them.
  const ghostSpoolerNames = new Set<string>();

  try {
    // --- Batched PowerShell: Win32_Printer + present-PnP set + brand VID scan ---
    //
    // v3 design: instead of fragile CSV parsing of Get-Printer, use Win32_Printer
    // (which exposes PNPDeviceID) and pre-build a hashset of all currently-present
    // PnP InstanceIds. Each printer's PNPDeviceID is then cross-checked against
    // that set: if the printer's backing PnP device isn't physically present right
    // now, the printer is a ghost spooler entry and we drop it.
    //
    // Output format uses `PRT|` line prefix instead of CSV to eliminate CSV-header
    // parsing bugs entirely. Pipes inside fields are normalized to '/' before output.
    const vids = ALL_PRINTER_VIDS;
    const batchScript = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

# Pre-query: hashset of every PnP InstanceId currently physically present
$presentIds = @{}
try {
  Get-PnpDevice -PresentOnly -Status OK -ErrorAction SilentlyContinue | ForEach-Object {
    $presentIds[$_.InstanceId] = $true
  }
} catch {}

# Section 1: Win32_Printer rows with PNPDeviceID + present flag
# Format: PRT|name|port|driver|offline|status|pnpId|present
Write-Output '---PRINTERS---'
try {
  Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | ForEach-Object {
    $name = if ($_.Name) { ($_.Name -as [string]).Replace('|','/') } else { '' }
    $port = if ($_.PortName) { ($_.PortName -as [string]).Replace('|','/') } else { '' }
    $driver = if ($_.DriverName) { ($_.DriverName -as [string]).Replace('|','/') } else { '' }
    $offline = if ($_.WorkOffline) { 'true' } else { 'false' }
    # Win32_Printer.PrinterStatus is an int (3=Idle,4=Printing,5=Warmup,7=Offline)
    $statusName = switch ($_.PrinterStatus) {
      1 { 'Other' }
      2 { 'Unknown' }
      3 { 'Idle' }
      4 { 'Printing' }
      5 { 'Warmup' }
      6 { 'StoppedPrinting' }
      7 { 'Offline' }
      default { 'Unknown' }
    }
    $pnpId = if ($_.PNPDeviceID) { ($_.PNPDeviceID -as [string]).Replace('|','/') } else { '' }
    $present = if ($pnpId -and $presentIds.ContainsKey($pnpId)) { 'true' } elseif ($pnpId) { 'false' } else { 'unknown' }
    Write-Output "PRT|$name|$port|$driver|$offline|$statusName|$pnpId|$present"
  }
} catch {}

# Section 2: PnP VID devices — PresentOnly (catches POSNET CDC and similar serial-only devices that have no spooler entry)
#
# CRITICAL: We only emit devices whose Class is plausibly a printer. Many printer
# brands also sell unrelated peripherals on the same VID (HP keyboards, HP USB
# hubs, Brother scanners, etc.). Without this filter, the parser used to pick up
# an HP "USB2.1 Hub" (Class=USB), match it to a leftover HP LaserJet spooler
# entry, and resurrect that ghost as a "real" printer.
#
# Allowed classes:
#   Ports     - CDC serial devices (POSNET, Star CDC, etc.)
#   Printer   - native Windows printer-class devices
#   USB       - ONLY if the bus-reported description contains a printer keyword
#               (catches USBPRINT-backed devices that report Class=USB)
# Anything else (USBDevice, HIDClass, Net, Bluetooth, Keyboard, Mouse, Image,
# Media, Monitor, System, Multimedia, ...) is dropped.
Write-Output '---PNPDEVICES---'
$vids = @(${vids.map(v => `'${v}'`).join(',')})
$printerKeywords = @(${PNP_PRINTER_KEYWORDS.map(k => `'${k.replace(/'/g, "''")}'`).join(',')})
foreach ($vid in $vids) {
  $devs = Get-PnpDevice -PresentOnly -Status OK -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match "VID_$vid" }
  foreach ($d in $devs) {
    $desc = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_BusReportedDeviceDesc' -ErrorAction SilentlyContinue).Data
    $cls = if ($d.Class) { $d.Class } else { '' }
    $allowed = $false
    if ($cls -eq 'Ports' -or $cls -eq 'Printer' -or $cls -eq 'USBPRINT') {
      $allowed = $true
    } elseif ($cls -eq 'USB') {
      # Class=USB is too generic on its own (matches USB hubs). Require the
      # bus-reported description to mention something printer-like.
      $combined = "$desc $($d.FriendlyName) $($d.Description)"
      foreach ($kw in $printerKeywords) {
        if ($combined -match $kw) { $allowed = $true; break }
      }
    }
    if (-not $allowed) { continue }
    $com = ''
    if ($cls -eq 'Ports') {
      $fn = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_FriendlyName' -ErrorAction SilentlyContinue).Data
      if ($fn -match '\\(COM(\\d+)\\)') { $com = "COM$($Matches[1])" }
    }
    Write-Output "PNP|$vid|$($d.InstanceId)|$cls|$desc|$com"
  }
}
`;
    const encoded = Buffer.from(batchScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 20000 },
    );

    // --- Parse output ---
    // We use line-prefix parsing instead of section markers + CSV. This is
    // immune to CSV header parsing bugs (no headers at all).
    interface PnpHit {
      vid: string;
      instanceId: string;
      devClass: string;
      model: string;
      comPort: string | null;
    }
    const pnpHits: PnpHit[] = [];

    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('PRT|')) {
        const parts = line.slice(4).split('|');
        // parts = [name, port, driver, offline, status, pnpId, present]
        if (parts.length < 7) continue;
        const name = parts[0] || '';
        if (!name) continue;
        const presentRaw = (parts[6] || 'unknown').trim().toLowerCase();
        installedPrinters.push({
          name,
          port: parts[1] || '',
          driver: parts[2] || '',
          workOffline: (parts[3] || '').trim().toLowerCase() === 'true',
          printerStatus: parts[4] || '',
          pnpId: parts[5] || '',
          pnpPresent: presentRaw === 'true' ? 'true' : presentRaw === 'false' ? 'false' : 'unknown',
        });
      } else if (line.startsWith('PNP|')) {
        const parts = line.slice(4).split('|');
        // parts = [vid, instanceId, devClass, model, com]
        if (parts.length < 4) continue;
        const model = (parts[3] || '').trim();
        if (!model) continue;
        pnpHits.push({
          vid: parts[0] || '',
          instanceId: parts[1] || '',
          devClass: parts[2] || '',
          model,
          comPort: (parts[4] || '').trim() || null,
        });
      }
    }

    const presentVidsLower = new Set(pnpHits.map(h => h.vid.toLowerCase()));

    // Get currently-present COM ports (PnP -PresentOnly) so we can validate
    // spooler printers attached to a serial port.
    let presentComPorts: Set<string>;
    try {
      serialPorts = await listSerialPorts();
      presentComPorts = new Set(serialPorts.map(p => p.toUpperCase()));
    } catch {
      presentComPorts = new Set();
    }

    // --- Filter Section 1 by physical presence ---
    // A spooler printer is REAL if all of these hold:
    //   1. WorkOffline is false
    //   2. PrinterStatus is not Offline/Error
    //   3. AND its connection backend is present:
    //      - COM port  → port is in present COM list
    //      - Network   → trust spooler (we can't probe network without printing)
    //      - USB / any other / unknown → if the brand has known VIDs, REQUIRE
    //        a matching VID present in the PnP scan. This catches ghost
    //        printers via custom port names (ZDesigner USB001, Port_#0001.Hub_#0008, etc.)
    //        that don't match the simple `^USB\d+$` regex.
    logger.info(
      `[DriverInstaller] Filtering ${installedPrinters.length} spooler printer(s); ` +
      `present COM=${[...presentComPorts].join(',') || 'none'}; ` +
      `present VIDs=${[...presentVidsLower].join(',') || 'none'}`,
    );
    for (const printer of installedPrinters) {
      // Remember every spooler printer name we considered, regardless of outcome.
      // Section 2 (PnP VID hits) uses this to refuse resurrection.
      allSpoolerNames.add(printer.name.toLowerCase());

      const connType = classifyConnection(printer.port);
      if (connType === 'VIRTUAL') {
        logger.info(`[DriverInstaller] Skipping virtual printer "${printer.name}" (port=${printer.port})`);
        ghostSpoolerNames.add(printer.name.toLowerCase());
        continue;
      }

      // PRIMARY signal: PNPDeviceID lookup against present-PnP set.
      // This is authoritative — Windows knows exactly which device backs this
      // spooler entry, and Get-PnpDevice -PresentOnly tells us if it's plugged
      // in right now. Catches HP M426/M402d ghosts left over from old USB installs
      // even when WorkOffline incorrectly reports false.
      if (printer.pnpId && printer.pnpPresent === 'false') {
        logger.info(`[DriverInstaller] FILTERED ghost printer "${printer.name}" — PNPDeviceID="${printer.pnpId}" not in present PnP set`);
        ghostSpoolerNames.add(printer.name.toLowerCase());
        continue;
      }

      // Hard offline signals
      if (printer.workOffline) {
        logger.info(`[DriverInstaller] Skipping offline printer "${printer.name}" (WorkOffline=true)`);
        ghostSpoolerNames.add(printer.name.toLowerCase());
        continue;
      }
      if (/Offline|Error|NotAvailable/i.test(printer.printerStatus)) {
        logger.info(`[DriverInstaller] Skipping printer "${printer.name}" (status=${printer.printerStatus})`);
        ghostSpoolerNames.add(printer.name.toLowerCase());
        continue;
      }

      // If we have a verified-present PNPDeviceID, skip the heuristic checks below
      if (printer.pnpId && printer.pnpPresent === 'true') {
        logger.info(`[DriverInstaller] KEEPING printer "${printer.name}" — PNPDeviceID verified present`);
        seenPrinterNames.add(printer.name.toLowerCase());
        const portUpper2 = (printer.port || '').toUpperCase();
        const connType2 = classifyConnection(printer.port);
        if (connType2 === 'VIRTUAL') continue;
        devices.push({
          vid: '',
          pid: '',
          brand: detectBrand(printer.name, printer.driver),
          model: printer.name,
          windowsPrinterName: printer.name,
          comPort: portUpper2.match(/^COM\d+$/) ? portUpper2 : null,
          portName: printer.port,
          connectionType: connType2,
          driverInstalled: true,
          autoSetupEligible: true,
        });
        continue;
      }

      // Fallback: Backend presence check (used when PNPDeviceID is empty —
      // typical for network printers, virtual printers, very old drivers)
      const portUpper = (printer.port || '').toUpperCase();
      const brand = detectBrand(printer.name, printer.driver);
      const bp = BRAND_PATTERNS.find(b => b.brand.toUpperCase() === brand.toUpperCase());
      const isNetworkPort =
        /^(WSD|TCPIP|IP_)/i.test(portUpper) ||
        portUpper.includes('\\\\') ||
        portUpper.startsWith('PORTPROMPT');

      let backendPresent = true;
      let reason = '';

      if (/^COM\d+$/.test(portUpper)) {
        backendPresent = presentComPorts.has(portUpper);
        reason = `COM port ${portUpper} ${backendPresent ? 'present' : 'absent'}`;
      } else if (isNetworkPort) {
        // Network printer — trust the spooler (can't probe without sending data)
        backendPresent = true;
        reason = `network port ${portUpper}, trusting spooler`;
      } else if (/^(USB\d+|DOT4_\d+)$/i.test(portUpper)) {
        const samePortPresent = await isUsbPrintPortPresent(portUpper);
        if (samePortPresent) {
          backendPresent = true;
          reason = `${portUpper} has present USBPRINT device`;
        } else if (bp && bp.vids.length > 0) {
          backendPresent = bp.vids.some(v => presentVidsLower.has(v.toLowerCase()));
          reason = `brand=${bp.brand} VIDs=[${bp.vids.join(',')}] ${backendPresent ? 'matched present PnP' : 'NOT matched (ghost)'}`;
        } else if (bp) {
          backendPresent = true;
          reason = `brand=${bp.brand} has no VID table on ${portUpper}, trusting spooler`;
        } else {
          backendPresent = true;
          reason = `unknown brand on ${portUpper}, trusting spooler (no VID cross-check possible)`;
        }
      } else if (bp && bp.vids.length > 0) {
        // USB / DOT4 / custom port name with KNOWN brand → require VID present
        backendPresent = bp.vids.some(v => presentVidsLower.has(v.toLowerCase()));
        reason = `brand=${bp.brand} VIDs=[${bp.vids.join(',')}] ${backendPresent ? 'matched present PnP' : 'NOT matched (ghost)'}`;
      } else if (bp) {
        backendPresent = true;
        reason = `brand=${bp.brand} has no VID table on ${portUpper}, trusting spooler`;
      } else {
        // Unknown brand on non-network port — fall back optimistic but log loud
        backendPresent = true;
        reason = `unknown brand on ${portUpper}, trusting spooler (no VID cross-check possible)`;
      }

      if (!backendPresent) {
        logger.info(`[DriverInstaller] FILTERED ghost printer "${printer.name}" — ${reason}`);
        ghostSpoolerNames.add(printer.name.toLowerCase());
        continue;
      }
      logger.info(`[DriverInstaller] KEEPING printer "${printer.name}" — ${reason}`);

      seenPrinterNames.add(printer.name.toLowerCase());

      devices.push({
        vid: '',
        pid: '',
        brand,
        model: printer.name,
        windowsPrinterName: printer.name,
        comPort: portUpper.match(/^COM\d+$/) ? portUpper : null,
        portName: printer.port,
        connectionType: connType,
        driverInstalled: true,
        autoSetupEligible: true,
      });
    }

    // --- Add Section 2: PnP VID devices NOT already covered by spooler ---
    //
    // Section 2 exists for one reason: serial-only CDC devices (POSNET) that
    // never appear in the Windows print spooler at all. For everything else,
    // Section 1 is authoritative.
    //
    // Resurrection guards (in order of strictness):
    //   (1) If matchedPrinter is a name we already kept in Section 1, skip
    //       (already represented).
    //   (2) If matchedPrinter is a name we explicitly DROPPED as a ghost in
    //       Section 1, skip — never resurrect a filtered ghost. This catches
    //       e.g. an HP USB hub PnP hit that findPrinterForVid would otherwise
    //       happily attach to a leftover "HP LaserJet ... USB003" spooler entry.
    //   (3) For non-POSNET PnP hits, REQUIRE the device to also have a matched
    //       spooler entry that wasn't dropped. A bare PnP-VID hit with no live
    //       spooler entry behind it (e.g. an HP keyboard) must not become a
    //       phantom printer card in the UI.
    for (const hit of pnpHits) {
      const brand = getBrandByVid(hit.vid);
      const isPosnet = hit.vid === POSNET_VID || brand === 'POSNET';

      const matchedPrinter = findPrinterForVid(
        installedPrinters.map(p => ({ name: p.name, port: p.port, driver: p.driver })),
        hit.vid,
        hit.model,
      );
      const matchedSpooler = matchedPrinter
        ? installedPrinters.find((printer) => printer.name === matchedPrinter)
        : undefined;

      // Guard (1): already represented as a kept Section 1 device
      if (matchedPrinter && seenPrinterNames.has(matchedPrinter.toLowerCase())) {
        continue;
      }

      // Guard (2): would resurrect a Section 1 ghost — refuse
      if (matchedPrinter && ghostSpoolerNames.has(matchedPrinter.toLowerCase())) {
        logger.info(`[DriverInstaller] Section 2: REFUSING PnP hit (${brand}/${hit.model}/${hit.devClass}) — would resurrect filtered ghost "${matchedPrinter}"`);
        continue;
      }

      // Guard (3): non-POSNET PnP hits without a real spooler match are dropped.
      // A printer (HP LaserJet, Zebra label, etc.) MUST have a Windows spooler
      // entry to be usable. If we got a PnP-VID hit but no spooler entry, the
      // device is either (a) a non-printer peripheral on the same VID, or
      // (b) a printer with no driver installed yet. In case (b) we used to add
      // a card so the user could install drivers — but the new "Detect Printers"
      // UI auto-runs Windows driver scan, so it's safer to drop than risk
      // showing a phantom card.
      if (!isPosnet && !matchedPrinter && hit.comPort) {
        const isKnownSerialFiscal = brand === 'ELZAB';
        logger.info(
          `[DriverInstaller] Section 2: exposing ${isKnownSerialFiscal ? `${brand} (auto-setup eligible)` : 'manual-only generic'} serial candidate on ${hit.comPort} (${hit.model})`
        );
        devices.push({
          vid: hit.vid,
          pid: (hit.instanceId.match(/PID_([0-9A-F]+)/i) || [])[1] || '',
          brand: isKnownSerialFiscal ? brand : 'Generic Serial',
          model: hit.model || hit.comPort,
          windowsPrinterName: null,
          comPort: hit.comPort,
          portName: hit.comPort,
          connectionType: 'SERIAL',
          driverInstalled: true,
          autoSetupEligible: isKnownSerialFiscal,
        });
        continue;
      }

      if (!isPosnet && !matchedPrinter) {
        logger.info(`[DriverInstaller] Section 2: dropping ${brand}/${hit.model} (class=${hit.devClass}) — no live spooler entry`);
        continue;
      }

      // POSNET CDC and similar serial-only devices have no spooler entry,
      // so they show up here. driverInstalled should reflect "we can talk to it"
      // — for serial devices that means we have a COM port, NOT that there's
      // a Windows spooler entry.
      const driverInstalled = isPosnet
        ? !!hit.comPort                  // POSNET CDC: needs COM port to be talkable
        : matchedPrinter != null;        // Other USB devices: need spooler driver

      devices.push({
        vid: hit.vid,
        pid: (hit.instanceId.match(/PID_([0-9A-F]+)/i) || [])[1] || '',
        brand,
        model: hit.model,
        windowsPrinterName: matchedPrinter || null,
        comPort: hit.comPort,
        portName: matchedSpooler?.port || hit.comPort,
        connectionType: hit.comPort ? 'SERIAL' : 'USB',
        driverInstalled,
        autoSetupEligible: isPosnet || matchedPrinter != null,
      });
    }

    logger.info(`[DriverInstaller] Result: ${devices.length} real device(s); ${ghostSpoolerNames.size} ghost(s) filtered out of ${allSpoolerNames.size} spooler entries`);
  } catch (err) {
    logger.warn('[DriverInstaller] getPosnetDriverStatus error:', err);
  }

  // Dedup variant printer names: Windows creates "Printer (1)", "Printer (2)"
  // after driver reinstalls on different ports (e.g. USB001 vs LPT1:).
  // Only dedup when one name is clearly a "(N)" variant of another.
  {
    const VARIANT_RE = /\s+\(\d+\)$/;
    const baseName = (name: string) => name.replace(VARIANT_RE, '');
    // Port quality: prefer USB > SERIAL > NETWORK > LPT/virtual
    const portScore = (port: string) => {
      const p = (port || '').toUpperCase();
      if (p.match(/^USB\d+$/)) return 4;
      if (p.match(/^COM\d+$/)) return 3;
      if (p.match(/^(WSD|TCPIP|IP_)/)) return 2;
      return 0; // LPT, PORTPROMPT, nul, unknown — least preferred
    };
    // Build lookup: baseName -> indices of devices sharing that base name
    const baseGroups = new Map<string, number[]>();
    for (let i = 0; i < devices.length; i++) {
      const raw = devices[i].windowsPrinterName || devices[i].model || '';
      const base = baseName(raw).toLowerCase();
      if (!base) continue;
      const arr = baseGroups.get(base) || [];
      arr.push(i);
      baseGroups.set(base, arr);
    }
    const toRemove = new Set<number>();
    for (const [, indices] of baseGroups) {
      if (indices.length < 2) continue;
      // Only dedup if at least one entry has the "(N)" suffix — otherwise
      // they're genuinely different devices (e.g. two POSNET on different COMs)
      const hasVariant = indices.some(i => {
        const raw = devices[i].windowsPrinterName || devices[i].model || '';
        return VARIANT_RE.test(raw);
      });
      if (!hasVariant) continue;
      // Keep the entry on the best port; tie-break: prefer base name over variant
      let bestIdx = indices[0];
      for (let j = 1; j < indices.length; j++) {
        const idx = indices[j];
        const bestScore = portScore(devices[bestIdx].portName || devices[bestIdx].comPort || '');
        const currScore = portScore(devices[idx].portName || devices[idx].comPort || '');
        if (currScore > bestScore) {
          toRemove.add(bestIdx);
          bestIdx = idx;
        } else if (currScore === bestScore) {
          // Same port quality — keep the base-named one
          const bestRaw = devices[bestIdx].windowsPrinterName || devices[bestIdx].model || '';
          const currRaw = devices[idx].windowsPrinterName || devices[idx].model || '';
          if (VARIANT_RE.test(bestRaw) && !VARIANT_RE.test(currRaw)) {
            toRemove.add(bestIdx);
            bestIdx = idx;
          } else {
            toRemove.add(idx);
          }
        } else {
          toRemove.add(idx);
        }
      }
    }
    if (toRemove.size > 0) {
      const removed = [...toRemove].map(idx => devices[idx].windowsPrinterName || devices[idx].model);
      logger.info(`[DriverInstaller] Dedup: removed ${toRemove.size} variant(s): ${removed.join(', ')}`);
      for (const idx of [...toRemove].sort((a, b) => b - a)) devices.splice(idx, 1);
    }
  }

  // Classify each device and attach targetType + recommendedProtocol
  for (const dev of devices) {
    const classification = classifyPrinterCategory(dev);
    dev.targetType = classification.targetType;
    dev.recommendedProtocol = classification.protocol;
    if (requiresManualPosnetProtocolSelection(dev)) {
      dev.autoSetupEligible = false;
    } else if (dev.autoSetupEligible === undefined) {
      dev.autoSetupEligible = dev.brand !== 'Generic Serial';
    }
  }

  if (serialPorts.length === 0) {
    serialPorts = Array.from(new Set(devices.map((dev) => dev.comPort).filter((port): port is string => !!port)));
  }

  const posnetDevice = devices.find(d => d.vid === POSNET_VID || d.brand === 'POSNET');
  const filteredWindowsPrinters = dedupeWindowsPrinters(
    devices
      .filter((dev) => dev.windowsPrinterName && dev.connectionType !== 'VIRTUAL')
      .map((dev) => ({
        name: dev.windowsPrinterName as string,
        port: dev.portName || dev.comPort || '',
      })),
  );
  const fallbackWindowsPrinters = dedupeWindowsPrinters(
    installedPrinters
      .filter((printer) => isRealSpoolerPrinter(printer.name, printer.port))
      .map((printer) => ({ name: printer.name, port: printer.port })),
  );
  const windowsPrinters = filteredWindowsPrinters.length > 0 ? filteredWindowsPrinters : fallbackWindowsPrinters;

  if (filteredWindowsPrinters.length === 0 && fallbackWindowsPrinters.length > 0) {
    logger.warn(
      `[DriverInstaller] Filtered printer list is empty; falling back to ${fallbackWindowsPrinters.length} raw spooler printer(s)`
    );
  }

  return {
    devices,
    posnetPresent: !!posnetDevice,
    posnetComPort: posnetDevice?.comPort || null,
    posnetDriverInstalled: posnetDevice?.driverInstalled || false,
    serialPorts,
    windowsPrinters,
  };
}


/** Classify a printer's connection type by its port name */
function classifyConnection(port: string): 'USB' | 'SERIAL' | 'NETWORK' | 'VIRTUAL' {
  const p = port.toUpperCase();
  if (p.match(/^COM\d+$/)) return 'SERIAL';
  if (p.match(/^USB\d+$/)) return 'USB';
  if (p.match(/^(WSD|TCPIP|IP_)/i) || p.includes('\\\\')) return 'NETWORK';
  // Virtual/software printers: PDF, XPS, Fax, OneNote, PORTPROMPT
  if (
    p.includes('PORTPROMPT') ||
    p.includes('SHRFAX') ||
    p.includes('MICROSOFT') ||
    p.includes('NUL') ||
    p.match(/^FILE:/i) ||
    p.match(/^TS\d+/i) ||
    p.match(/^LPT\d+/i)
  ) return 'VIRTUAL';
  return 'USB'; // default assumption for unknown port types
}

function isRealSpoolerPrinter(name: string, port: string): boolean {
  if (classifyConnection(port) === 'VIRTUAL') return false;
  return !/(OneNote|Fax|Microsoft Print to PDF|Microsoft XPS Document Writer|Send To OneNote)/i.test(name);
}

function dedupeWindowsPrinters(printers: Array<{ name: string; port: string }>): Array<{ name: string; port: string }> {
  const seen = new Map<string, { name: string; port: string }>();
  for (const printer of printers) {
    if (!printer.name) continue;
    if (!seen.has(printer.name)) {
      seen.set(printer.name, printer);
    }
  }
  return Array.from(seen.values());
}

/** Detect brand from printer name or driver string using shared BRAND_PATTERNS */
function detectBrand(name: string, driver: string): string {
  const combined = `${name} ${driver}`.toLowerCase();
  for (const bp of BRAND_PATTERNS) {
    if (bp.namePatterns.some(p => combined.includes(p))) return bp.brand;
  }
  return 'Unknown';
}

/** Heuristic: match installed printer to VID by driver name or model substring */
function findPrinterForVid(
  printers: Array<{ name: string; port: string; driver: string }>,
  vid: string,
  model: string,
): string | undefined {
  const brand = getBrandByVid(vid);
  const brandPattern = BRAND_PATTERNS.find(bp => bp.brand === brand);
  if (!brandPattern) return undefined;

  const modelLower = model.toLowerCase();
  return printers.find(p => {
    const nameLower = p.name.toLowerCase();
    const driverLower = p.driver.toLowerCase();
    // Match by brand name patterns
    if (brandPattern.namePatterns.some(pat => nameLower.includes(pat) || driverLower.includes(pat))) {
      return true;
    }
    // Match by model substring
    if (modelLower && nameLower.includes(modelLower)) return true;
    return false;
  })?.name;
}


function getBrandByVid(vid: string): string {
  const upper = vid.toUpperCase();
  const match = BRAND_PATTERNS.find(bp => bp.vids.some(v => v.toUpperCase() === upper));
  return match ? match.brand : `VID_${vid}`;
}

/** Known thermal/receipt printer model patterns */
const THERMAL_PATTERNS = [
  'thermal', 'receipt', 'pos ', 'tm-t', 'tm-m', 'tm-u', 'tm-p', // Epson TM series
  'tsp', 'sp7', 'sm-', 'ct-', // Star Micronics
  'srp-', 'spp-', // Bixolon
  'ct-s', 'ct-e', 'cl-s', // Citizen
  'rp-', // custom receipt
];

/** Known label printer model patterns */
const LABEL_PATTERNS = [
  'label', 'zd', 'zt', 'zq', 'gk4', 'gx4', 'gc4', 'tlp', 'lp2', // Zebra models
  'ql-', 'td-', 'pt-', // Brother label
  'labelwriter', // DYMO
  'xp-423', 'xp423', // Xprinter 4-inch label printers
];

/**
 * Classify a detected device into a printer category.
 * Returns the recommended PrinterType and protocol for auto-setup.
 */
export function classifyPrinterCategory(device: DetectedDevice): {
  targetType: 'RECEIPT' | 'FISCAL' | 'LABEL' | 'A4';
  protocol: 'POSNET' | 'ELZAB_STX' | 'ZEBRA' | 'THERMAL' | 'WINDOWS';
} {
  const brand = device.brand.toUpperCase();
  const model = (device.model || '').toLowerCase();
  const driver = (device.windowsPrinterName || '').toLowerCase();
  const combined = `${model} ${driver}`;

  // POSNET — always FISCAL slot, always POSNET protocol
  // POSNET fiscal support here is POSNET v2 only. Some Thermal HD/XL devices
  // can also be configured for a printer-side THEMAL protocol, so discovery
  // disables auto-setup for those PIDs until the printer menu is verified.
  if (brand === 'POSNET' || device.vid === POSNET_VID) {
    return { targetType: 'FISCAL', protocol: 'POSNET' };
  }

  // ELZAB Zeta Online is a fiscal printer. It may expose Windows transport
  // drivers, but it must not be classified as a generic THERMAL receipt device.
  if (brand === 'ELZAB' || combined.includes('elzab') || combined.includes('zeta online')) {
    return { targetType: 'FISCAL', protocol: 'ELZAB_STX' };
  }

  // Zebra — check if it's a label printer (most are) vs receipt
  if (brand === 'ZEBRA' || device.vid === ZEBRA_VID) {
    // Zebra receipt printers are rare; default to label
    return { targetType: 'LABEL', protocol: 'ZEBRA' };
  }

  // DYMO — always label
  if (brand === 'DYMO') {
    return { targetType: 'LABEL', protocol: 'WINDOWS' };
  }

  // Brother — check if label or regular
  // Xprinter sells both receipt printers (XP-80T/XP-58) and label printers
  // (XP-423B). Distinguish the label family before falling back to receipt.
  if (brand === 'XPRINTER' || combined.includes('xprinter')) {
    if (LABEL_PATTERNS.some(p => combined.includes(p))) {
      return { targetType: 'LABEL', protocol: 'WINDOWS' };
    }
    return { targetType: 'RECEIPT', protocol: 'THERMAL' };
  }

  if (brand === 'BROTHER') {
    if (LABEL_PATTERNS.some(p => combined.includes(p))) {
      return { targetType: 'LABEL', protocol: 'WINDOWS' };
    }
  }

  // Check model name for thermal/receipt indicators
  if (THERMAL_PATTERNS.some(p => combined.includes(p))) {
    return { targetType: 'RECEIPT', protocol: 'THERMAL' };
  }

  // Check model name for label indicators
  if (LABEL_PATTERNS.some(p => combined.includes(p))) {
    return { targetType: 'LABEL', protocol: 'WINDOWS' };
  }

  // Known thermal brands default to receipt
  if (['EPSON', 'STAR MICRONICS', 'CITIZEN', 'BIXOLON'].includes(brand)) {
    return { targetType: 'RECEIPT', protocol: 'THERMAL' };
  }

  // HP, Canon, Samsung, Brother (non-label) — likely laser/inkjet → A4
  if (['HP', 'CANON', 'SAMSUNG'].includes(brand)) {
    // But if connected via COM port, it's probably thermal
    if (device.connectionType === 'SERIAL') {
      return { targetType: 'RECEIPT', protocol: 'THERMAL' };
    }
    return { targetType: 'A4', protocol: 'WINDOWS' };
  }

  // Unknown — default to receipt with THERMAL protocol (safest general choice)
  if (device.connectionType === 'SERIAL') {
    return { targetType: 'RECEIPT', protocol: 'THERMAL' };
  }
  return { targetType: 'RECEIPT', protocol: 'WINDOWS' };
}

/**
 * Trigger Windows to scan for and install drivers from Windows Update.
 * Works for Zebra, HP, Epson, and any printer with drivers in Windows Update catalog.
 */
export async function triggerWindowsDriverScan(): Promise<DriverInstallResult> {
  logger.info('[DriverInstaller] Triggering Windows driver scan (pnputil /scan-devices)...');
  try {
    const { stdout } = await execFileAsync(
      'pnputil.exe',
      ['/scan-devices'],
      { encoding: 'utf8', timeout: 30000 },
    );
    logger.info('[DriverInstaller] Driver scan complete:', stdout.trim());

    // Wait for Windows to process newly found drivers
    await new Promise(r => setTimeout(r, 3000));

    return { success: true, message: 'Windows driver scan complete. New drivers may have been installed.' };
  } catch (err: any) {
    logger.warn('[DriverInstaller] Driver scan failed:', err);
    return { success: false, message: `Driver scan failed: ${err.message}` };
  }
}

/**
 * Install bundled POSNET CDC driver.
 * Tries direct pnputil first, falls back to UAC-elevated PowerShell.
 */
export async function installPosnetDriver(): Promise<DriverInstallResult> {
  const infPath = getPosnetInfPath();
  if (!fs.existsSync(infPath)) {
    return { success: false, message: `Driver file not found: ${infPath}` };
  }
  logger.info(`[DriverInstaller] Installing POSNET driver from: ${infPath}`);

  try {
    const { stdout } = await execFileAsync(
      'pnputil.exe',
      ['/add-driver', infPath, '/install'],
      { encoding: 'utf8', timeout: 30000 },
    );
    const rebootRequired = stdout.toLowerCase().includes('reboot');
    logger.info('[DriverInstaller] Installed (direct):', stdout.trim());
    return { success: true, message: 'POSNET driver installed successfully.', rebootRequired };
  } catch (err: any) {
    if (!isAccessDenied(err)) {
      return { success: false, message: err.message };
    }
  }

  return installWithElevation(infPath);
}

function isAccessDenied(err: any): boolean {
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('access') || msg.includes('denied') || msg.includes('administrator') || err?.code === 5;
}

function installWithElevation(infPath: string): Promise<DriverInstallResult> {
  return new Promise((resolve) => {
    const safeInf = infPath.replace(/'/g, "''");
    const psCommand =
      `$p = Start-Process pnputil.exe ` +
      `-ArgumentList '/add-driver','${safeInf}','/install' ` +
      `-Verb RunAs -Wait -PassThru; exit $p.ExitCode`;

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCommand],
      { encoding: 'utf8', timeout: 60000 },
      (error) => {
        if (error) {
          const cancelled = (error.message || '').toLowerCase().includes('cancel');
          resolve({ success: false, message: cancelled ? 'UAC cancelled.' : `Install failed: ${error.message}` });
        } else {
          resolve({ success: true, message: 'POSNET driver installed successfully.' });
        }
      },
    );
  });
}
