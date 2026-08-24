/**
 * Universal printer detection types.
 *
 * Generalizes the POSNET-only detection system to support all printer brands.
 * Devices are keyed by a stable identifier: serial number (POSNET), Windows
 * printer name (Zebra/Thermal USB), or generated ID (fallback).
 */

import { PrinterProtocol, PrinterType } from '../../../shared/types';

// ─── Universal Device Profile ─────────────────────────────────────────────────

export interface UniversalDeviceProfile {
  /** Stable unique identifier (serial, Windows printer name, or generated). */
  id: string;
  /** Brand name (e.g. "POSNET", "Zebra", "Epson", "HP"). */
  brand: string;
  /** Model name (e.g. "Temo HS", "GK420d", "TM-T20III"). */
  model: string;
  /** Printer protocol used by this device. */
  protocol: PrinterProtocol;
  /** Target printer type slot. */
  printerType: PrinterType;
  /** Connection type. */
  connectionType: 'USB' | 'SERIAL' | 'NETWORK';

  // Connection details (one or both may be set)
  /** Windows printer name (for spooler-based printers). */
  windowsPrinterName?: string;
  /** COM port (for serial printers). */
  port?: string;
  /** Baud rate for serial connections. */
  baudRate?: number;

  /** Current device status. */
  status: UniversalDeviceStatus;
  /** ISO timestamp of last successful communication / health check. */
  lastSeen: string;
  /** ISO timestamp of first discovery. */
  firstSeen: string;
  /** True if auto-selected (single device per slot). */
  autoSelected: boolean;

  /** Previous identifiers used for recovery (old printer names, old ports). */
  previousIds: string[];
}

export type UniversalDeviceStatus = 'online' | 'offline' | 'recovered' | 'error' | 'unknown';

// ─── Detection Result ──────────────────────────────────────────────────────────

export interface UniversalDetectionResult {
  /** True if at least one device was found. */
  success: boolean;
  /** All discovered devices. */
  devices: UniversalDeviceProfile[];
  /** Devices that were auto-configured (new or recovered). */
  configured: UniversalDeviceProfile[];
  /** Non-fatal warnings encountered during scan. */
  warnings: string[];
}

// ─── Recovery Result ───────────────────────────────────────────────────────────

export interface RecoveryResult {
  /** True if the printer was found again. */
  recovered: boolean;
  /** New identifier (printer name or COM port). */
  newIdentifier?: string;
  /** Old identifier that was lost. */
  oldIdentifier: string;
  /** Human-readable message. */
  message: string;
}

// ─── Recoverable Driver Interface ─────────────────────────────────────────────

/**
 * Interface for printer drivers that support reconnection.
 * Used by HardwareModule to centralize recovery logic —
 * the orchestrator finds a new identifier, the driver just reconnects.
 */
export interface RecoverableDriver {
  /** Reconnect the driver using a new identifier (printer name or COM port). */
  reconnect(newIdentifier: string): void | Promise<void>;
}

// ─── Persisted registry file ───────────────────────────────────────────────────

export interface UniversalRegistryData {
  version: 2;
  lastScan: string;
  /** Devices keyed by stable ID. */
  devices: Record<string, UniversalDeviceProfile>;
}

// ─── Brand patterns for recovery matching ──────────────────────────────────────

export interface BrandPattern {
  brand: string;
  /** Patterns to match in Windows printer name (lowercase). */
  namePatterns: string[];
  /** Known USB Vendor IDs. */
  vids: string[];
  /** Default protocol for this brand. */
  defaultProtocol: PrinterProtocol;
  /** Default printer type slot. */
  defaultType: PrinterType;
}

export const BRAND_PATTERNS: BrandPattern[] = [
  {
    brand: 'POSNET',
    namePatterns: ['posnet'],
    vids: ['1424'],
    defaultProtocol: 'POSNET',
    defaultType: 'RECEIPT',
  },
  {
    brand: 'ELZAB',
    namePatterns: ['elzab', 'zeta online'],
    vids: ['C1CA'],
    defaultProtocol: 'ELZAB_STX',
    defaultType: 'FISCAL',
  },
  {
    brand: 'Zebra',
    namePatterns: ['zebra', 'zdesigner', 'ztc '],
    vids: ['0A5F'],
    defaultProtocol: 'ZEBRA',
    defaultType: 'LABEL',
  },
  {
    brand: 'Xprinter',
    namePatterns: ['xprinter', 'xp-80', 'xp80', 'xp-58', 'xp58', 'xp-423', 'xp423'],
    // Many XP-80T/POS-80 installs enumerate through a generic USB printing
    // support bridge with VID_1FC9. Keep this in the known list so receipt
    // printer presence checks do not reject a real USB002 printer as a ghost.
    vids: ['1FC9'],
    defaultProtocol: 'THERMAL',
    defaultType: 'RECEIPT',
  },
  {
    brand: 'Epson',
    namePatterns: ['epson', 'tm-t', 'tm-m', 'tm-u', 'tm-p'],
    vids: ['04B8'],
    defaultProtocol: 'THERMAL',
    defaultType: 'RECEIPT',
  },
  {
    brand: 'Star Micronics',
    namePatterns: ['star ', 'tsp', 'sp7', 'sm-'],
    vids: ['0519'],
    defaultProtocol: 'THERMAL',
    defaultType: 'RECEIPT',
  },
  {
    brand: 'Citizen',
    namePatterns: ['citizen', 'ct-s', 'ct-e', 'cl-s'],
    vids: ['1D90'],
    defaultProtocol: 'THERMAL',
    defaultType: 'RECEIPT',
  },
  {
    brand: 'Bixolon',
    namePatterns: ['bixolon', 'srp-', 'spp-'],
    vids: ['1504'],
    defaultProtocol: 'THERMAL',
    defaultType: 'RECEIPT',
  },
  {
    brand: 'DYMO',
    namePatterns: ['dymo', 'labelwriter'],
    vids: ['0922'],
    defaultProtocol: 'WINDOWS',
    defaultType: 'LABEL',
  },
  {
    brand: 'TSC',
    namePatterns: ['tsc', 'mb2', 'mb3', 'mh2', 'mh3', 'ml2', 'ml3', 'da2', 'da3', 'te2', 'te3', 'tx2', 'tx3', 'tx6', 'ttp-'],
    vids: ['1203'],
    defaultProtocol: 'WINDOWS',
    defaultType: 'LABEL',
  },
  {
    brand: 'Honeywell',
    namePatterns: ['honeywell', 'intermec', 'pc42', 'pc43', 'pm42', 'pm43', 'pd43'],
    vids: ['0C2E'],
    defaultProtocol: 'WINDOWS',
    defaultType: 'LABEL',
  },
  {
    brand: 'Brother',
    namePatterns: ['brother'],
    vids: ['04F9'],
    defaultProtocol: 'WINDOWS',
    defaultType: 'LABEL',
  },
  {
    brand: 'HP',
    namePatterns: ['hp ', 'hewlett'],
    vids: ['03F0'],
    defaultProtocol: 'WINDOWS',
    defaultType: 'A4',
  },
  {
    brand: 'Canon',
    namePatterns: ['canon'],
    vids: ['04A9'],
    defaultProtocol: 'WINDOWS',
    defaultType: 'A4',
  },
  {
    brand: 'Samsung',
    namePatterns: ['samsung'],
    vids: ['04E8'],
    defaultProtocol: 'WINDOWS',
    defaultType: 'A4',
  },
];

/**
 * Detect brand from a printer name string.
 * Returns the matching BrandPattern or null.
 */
export function matchBrand(name: string): BrandPattern | null {
  const lower = name.toLowerCase();
  for (const bp of BRAND_PATTERNS) {
    if (bp.namePatterns.some(p => lower.includes(p))) return bp;
  }
  return null;
}

/**
 * Generate a stable device ID from available info.
 * Prefers: serial > usb VID+PID > windowsPrinterName > brand-port.
 *
 * Using VID+PID is more stable than Windows printer name because the name
 * can change on driver reinstall (e.g. "ZDesigner GK420d" → "ZDesigner GK420d (Copy 1)").
 */
export function generateDeviceId(
  serial?: string,
  windowsPrinterName?: string,
  brand?: string,
  port?: string,
  vid?: string,
  pid?: string,
): string {
  if (serial && serial !== '') return `serial:${serial}`;
  if (vid && pid && vid !== '' && pid !== '') return `usb:${vid}_${pid}`;
  if (windowsPrinterName && windowsPrinterName !== '') return `win:${windowsPrinterName}`;
  return `dev:${brand || 'unknown'}-${port || 'noport'}`;
}
