/**
 * VID → Protocol routing registry.
 *
 * Single source of truth that connects a physical USB device (identified by
 * its USB Vendor ID) to the printer protocol(s) the device speaks. Used to:
 *
 *  1. Pre-flight check before opening a serial port — if the slot is wired
 *     for POSNET but the COM port hosts a VID_C1CA (ELZAB) device, fail
 *     immediately with PROTOCOL_DEVICE_MISMATCH instead of looping the
 *     baud fan-out and reporting a confusing "no response".
 *
 *  2. Live UI hint when the user picks a port in Settings — show a banner
 *     "COM3 is ELZAB. Switch to ELZAB_STX?" with a one-click fix.
 *
 *  3. Auto-route when enabling a slot manually — if the chosen port has a
 *     known device, snap the protocol to match instead of relying on the
 *     default.
 *
 * Adding a new printer brand = add one entry to BRAND_PATTERNS in
 * detection/types.ts. This file only defines the validation surface.
 */
import type { PrinterProtocol } from '../../../shared/types';
import { BRAND_PATTERNS } from './types';

export interface VidEntry {
  brand: string;
  knownProtocols: PrinterProtocol[];
  preferredProtocol: PrinterProtocol;
}

/** Lookup table built from BRAND_PATTERNS at module load. */
function buildVidIndex(): Map<string, VidEntry> {
  const index = new Map<string, VidEntry>();
  for (const bp of BRAND_PATTERNS) {
    for (const rawVid of bp.vids) {
      const vid = rawVid.toUpperCase();
      // First brand wins per VID (BRAND_PATTERNS has no duplicates today).
      if (!index.has(vid)) {
        index.set(vid, {
          brand: bp.brand,
          knownProtocols: knownProtocolsFor(bp.brand, bp.defaultProtocol),
          preferredProtocol: bp.defaultProtocol,
        });
      }
    }
  }
  return index;
}

/**
 * Some brands legitimately speak more than one protocol. Most don't.
 * This is encoded here rather than in BRAND_PATTERNS to keep BRAND_PATTERNS
 * focused on auto-classification (one default protocol per brand).
 */
function knownProtocolsFor(brand: string, defaultProtocol: PrinterProtocol): PrinterProtocol[] {
  switch (brand) {
    case 'POSNET':
      return ['POSNET'];
    case 'ELZAB':
      return ['ELZAB_STX'];
    case 'Zebra':
      return ['ZEBRA'];
    case 'Epson':
    case 'Star Micronics':
    case 'Citizen':
    case 'Bixolon':
      return ['THERMAL', 'WINDOWS'];
    case 'TSC':
      // TSPL2 is native; ZEBRA only works on models with ZPL emulation
      // switched on, and WINDOWS goes through the vendor driver.
      return ['TSPL', 'WINDOWS', 'ZEBRA'];
    case 'DYMO':
    case 'Brother':
    case 'Honeywell':
      return ['WINDOWS', 'ZEBRA', 'THERMAL'];
    case 'HP':
    case 'Canon':
    case 'Samsung':
      return ['WINDOWS'];
    default:
      return [defaultProtocol];
  }
}

const VID_INDEX = buildVidIndex();

export function lookupVid(vid: string | null | undefined): VidEntry | null {
  if (!vid) return null;
  const key = vid.replace(/^0x/i, '').toUpperCase().padStart(4, '0');
  return VID_INDEX.get(key) ?? null;
}

export type ValidationCode =
  | 'OK'
  | 'PROTOCOL_DEVICE_MISMATCH'
  | 'UNKNOWN_DEVICE'
  | 'NO_DEVICE_ON_PORT';

export interface ValidationResult {
  ok: boolean;
  code: ValidationCode;
  detail?: string;
  detectedBrand?: string;
  detectedVid?: string;
  suggestedProtocol?: PrinterProtocol;
}

/**
 * Pure validation: given a known VID and a chosen protocol, decide whether
 * the protocol can actually drive that device. Splitting the PowerShell PnP
 * lookup out keeps this unit-testable.
 */
export function validateProtocolAgainstVid(
  vid: string | null | undefined,
  protocol: PrinterProtocol,
): ValidationResult {
  const entry = lookupVid(vid);
  if (!entry) {
    return {
      ok: true,
      code: vid ? 'UNKNOWN_DEVICE' : 'NO_DEVICE_ON_PORT',
      detail: vid ? `Unknown device (VID_${vid}); allowing — no registry entry.` : undefined,
    };
  }
  if (entry.knownProtocols.includes(protocol)) {
    return {
      ok: true,
      code: 'OK',
      detectedBrand: entry.brand,
      detectedVid: vid ?? undefined,
    };
  }
  return {
    ok: false,
    code: 'PROTOCOL_DEVICE_MISMATCH',
    detectedBrand: entry.brand,
    detectedVid: vid ?? undefined,
    suggestedProtocol: entry.preferredProtocol,
    detail:
      `Port has ${entry.brand} device (VID_${vid}), but slot is configured for ${protocol}. ` +
      `${entry.brand} speaks ${entry.knownProtocols.join(' or ')}.`,
  };
}
