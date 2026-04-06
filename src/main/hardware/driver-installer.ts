import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import logger from '../logger';
import { BRAND_PATTERNS } from './detection/types';

const execFileAsync = promisify(execFile);

/** Known USB Vendor IDs for fiscal/receipt printers */
const POSNET_VID = '1424';   // POSNET Polska S.A.
const ZEBRA_VID  = '0A5F';   // Zebra Technologies (GK420d, ZD410, etc.)
const HP_VID     = '03F0';   // HP printers

/** All known printer VIDs from brand patterns (for PnP scan) */
const ALL_PRINTER_VIDS = [...new Set(BRAND_PATTERNS.flatMap(bp => bp.vids))];

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
  /** Recommended printer type slot (RECEIPT, LABEL, A4). Set by classifyPrinterCategory(). */
  targetType?: string;
  /** Recommended protocol (POSNET, ZEBRA, THERMAL, WINDOWS). Set by classifyPrinterCategory(). */
  recommendedProtocol?: string;
}

export interface HardwareStatus {
  devices: DetectedDevice[];
  posnetPresent: boolean;
  posnetComPort: string | null;
  posnetDriverInstalled: boolean;
}

export interface DriverInstallResult {
  success: boolean;
  message: string;
  rebootRequired?: boolean;
}

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
  const devices: DetectedDevice[] = [];
  const seenPrinterNames = new Set<string>();

  try {
    // --- Batched PowerShell: Get-Printer + PnP VID scan + COM port lookup ---
    const vids = ALL_PRINTER_VIDS;
    const batchScript = `
$ErrorActionPreference = 'SilentlyContinue'
# Section 1: Windows printers
Write-Output '---PRINTERS---'
try {
  Get-Printer | Select-Object Name,PortName,DriverName | ConvertTo-Csv -NoTypeInformation
} catch {
  try { Get-CimInstance -ClassName Win32_Printer | Select-Object Name,PortName,DriverName | ConvertTo-Csv -NoTypeInformation } catch {}
}
# Section 2: PnP VID devices
Write-Output '---PNPDEVICES---'
$vids = @(${vids.map(v => `'${v}'`).join(',')})
foreach ($vid in $vids) {
  $devs = Get-PnpDevice -Status OK | Where-Object { $_.InstanceId -match "VID_$vid" }
  foreach ($d in $devs) {
    $desc = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_BusReportedDeviceDesc' -ErrorAction SilentlyContinue).Data
    # Also resolve COM port for Ports-class devices inline
    $com = ''
    if ($d.Class -eq 'Ports') {
      $fn = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_FriendlyName' -ErrorAction SilentlyContinue).Data
      if ($fn -match '\\(COM(\\d+)\\)') { $com = "COM$($Matches[1])" }
    }
    Write-Output "$vid|$($d.InstanceId)|$($d.Class)|$desc|$com"
  }
}
`;
    const encoded = Buffer.from(batchScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 20000 },
    );

    // Parse sections
    const sections = stdout.split(/---(\w+)---/).filter(Boolean);
    let printerSection = '';
    let pnpSection = '';
    for (let i = 0; i < sections.length; i++) {
      if (sections[i] === 'PRINTERS' && i + 1 < sections.length) printerSection = sections[i + 1];
      if (sections[i] === 'PNPDEVICES' && i + 1 < sections.length) pnpSection = sections[i + 1];
    }

    // --- Process Section 1: Windows printers ---
    const installedPrinters: Array<{ name: string; port: string; driver: string }> = [];
    const printerLines = printerSection.split('\n').slice(1); // skip CSV header
    for (const line of printerLines) {
      const trimmed = line.trim().replace(/^"|"$/g, '');
      if (!trimmed) continue;
      const parts = trimmed.split('","');
      if (parts.length < 2) continue;
      installedPrinters.push({ name: parts[0], port: parts[1] || '', driver: parts[2] || '' });
    }

    for (const printer of installedPrinters) {
      const connType = classifyConnection(printer.port);
      if (connType === 'VIRTUAL') continue;

      const brand = detectBrand(printer.name, printer.driver);
      seenPrinterNames.add(printer.name.toLowerCase());

      devices.push({
        vid: '',
        pid: '',
        brand,
        model: printer.name,
        windowsPrinterName: printer.name,
        comPort: printer.port.match(/^COM\d+$/i) ? printer.port.toUpperCase() : null,
        portName: printer.port,
        connectionType: connType,
        driverInstalled: true,
      });
    }

    // --- Process Section 2: PnP VID devices ---
    for (const line of pnpSection.split('\n').map(l => l.trim()).filter(Boolean)) {
      const parts = line.split('|');
      const vid = parts[0] || '';
      const instanceId = parts[1] || '';
      const devClass = parts[2] || '';
      const rawModel = parts[3] || '';
      const comPortFromScript = (parts[4] || '').trim();
      const model = rawModel.trim();
      if (!model) continue;

      const brand = getBrandByVid(vid);
      const matchedPrinter = findPrinterForVid(installedPrinters, vid, model);
      if (matchedPrinter && seenPrinterNames.has(matchedPrinter.toLowerCase())) continue;

      // COM port already resolved inline by the batch script
      const comPort: string | null = comPortFromScript || null;

      devices.push({
        vid,
        pid: (instanceId.match(/PID_([0-9A-F]+)/i) || [])[1] || '',
        brand,
        model,
        windowsPrinterName: matchedPrinter || null,
        comPort,
        portName: comPort,
        connectionType: comPort ? 'SERIAL' : 'USB',
        driverInstalled: matchedPrinter != null,
      });
    }
  } catch (err) {
    logger.warn('[DriverInstaller] getPosnetDriverStatus error:', err);
  }

  // Classify each device and attach targetType + recommendedProtocol
  for (const dev of devices) {
    const classification = classifyPrinterCategory(dev);
    dev.targetType = classification.targetType;
    dev.recommendedProtocol = classification.protocol;
  }

  const posnetDevice = devices.find(d => d.vid === POSNET_VID || d.brand === 'POSNET');

  return {
    devices,
    posnetPresent: !!posnetDevice,
    posnetComPort: posnetDevice?.comPort || null,
    posnetDriverInstalled: posnetDevice?.driverInstalled || false,
  };
}


/** Classify a printer's connection type by its port name */
function classifyConnection(port: string): 'USB' | 'SERIAL' | 'NETWORK' | 'VIRTUAL' {
  const p = port.toUpperCase();
  if (p.match(/^COM\d+$/)) return 'SERIAL';
  if (p.match(/^USB\d+$/)) return 'USB';
  if (p.match(/^(WSD|TCPIP|IP_)/i) || p.includes('\\\\')) return 'NETWORK';
  // Virtual/software printers: PDF, XPS, Fax, OneNote, PORTPROMPT
  if (p.includes('PORTPROMPT') || p.includes('SHRFAX') || p.includes('MICROSOFT') || p.includes('NUL')) return 'VIRTUAL';
  return 'USB'; // default assumption for unknown port types
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
];

/**
 * Classify a detected device into a printer category.
 * Returns the recommended PrinterType and protocol for auto-setup.
 */
export function classifyPrinterCategory(device: DetectedDevice): {
  targetType: 'RECEIPT' | 'LABEL' | 'A4';
  protocol: 'POSNET' | 'ZEBRA' | 'THERMAL' | 'WINDOWS';
} {
  const brand = device.brand.toUpperCase();
  const model = (device.model || '').toLowerCase();
  const driver = (device.windowsPrinterName || '').toLowerCase();
  const combined = `${model} ${driver}`;

  // POSNET — always receipt, always POSNET protocol
  if (brand === 'POSNET' || device.vid === POSNET_VID) {
    return { targetType: 'RECEIPT', protocol: 'POSNET' };
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
