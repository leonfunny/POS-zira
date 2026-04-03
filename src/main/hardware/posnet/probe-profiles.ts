/**
 * Built-in probe profiles for known Posnet device families.
 *
 * Each profile defines serial settings + protocol to attempt on a COM port.
 * Profiles are tried in priority order (lower = first).
 *
 * Product IDs come from the existing POSNET CDC driver (posnetCDC15v.inf):
 *   VID 0x1424 is POSNET S.A.
 */

import { ProbeProfile } from './types';

/** All known POSNET USB Product IDs from the bundled driver. */
export const POSNET_PRODUCT_IDS: Record<number, string> = {
  0x1015: 'Temo HS',
  0x1016: 'Mobile HS',
  0x1017: 'NIXDORF TH230+',
  0x1018: '4610-1NR',
  0x100A: 'Thermal HD',
  0x100B: 'Thermal XL',
  0x100C: 'Neo',
  0x100D: 'Ergo',
  0x10A0: 'Posnet K',
  0x10B0: 'Posnet D',
};

export const POSNET_USB_VID = '1424';

/**
 * Default probe profiles, ordered by priority.
 *
 * Profile A: POSNET v2 native serial @ 9600 (most common, works with Temo HS etc.)
 * Profile B: POSNET v2 native serial @ 19200 (some newer models)
 * Profile C: POSNET v2 native serial @ 115200 (high-speed models)
 * Profile D: Thermal/ESC-POS fallback @ 9600 (hybrid printers)
 * Profile E: SDK bridge (placeholder for DLL-based communication)
 */
export const DEFAULT_PROBE_PROFILES: ProbeProfile[] = [
  {
    name: 'posnet-v2-9600',
    description: 'POSNET v2 native serial @ 9600 baud (standard)',
    protocol: 'POSNET_V2',
    library: '',
    baudRate: 9600,
    dataBits: 8,
    parity: 'None',
    stopBits: 'One',
    timeoutMs: 3000,
    priority: 1,
    hintProductIds: [0x1015, 0x1016, 0x1017, 0x1018, 0x100A, 0x100B, 0x100C, 0x100D],
  },
  {
    name: 'posnet-v2-19200',
    description: 'POSNET v2 native serial @ 19200 baud',
    protocol: 'POSNET_V2',
    library: '',
    baudRate: 19200,
    dataBits: 8,
    parity: 'None',
    stopBits: 'One',
    timeoutMs: 3000,
    priority: 2,
    hintProductIds: [],
  },
  {
    name: 'posnet-v2-115200',
    description: 'POSNET v2 native serial @ 115200 baud (high-speed)',
    protocol: 'POSNET_V2',
    library: '',
    baudRate: 115200,
    dataBits: 8,
    parity: 'None',
    stopBits: 'One',
    timeoutMs: 2000,
    priority: 3,
    hintProductIds: [0x10A0, 0x10B0],
  },
  {
    name: 'thermal-esc-9600',
    description: 'Thermal ESC/POS fallback @ 9600 baud',
    protocol: 'THERMAL',
    library: '',
    baudRate: 9600,
    dataBits: 8,
    parity: 'None',
    stopBits: 'One',
    timeoutMs: 2000,
    priority: 10,
    hintProductIds: [],
  },
  {
    name: 'sdk-bridge',
    description: 'POSNET SDK/DLL bridge (requires installed SDK)',
    protocol: 'SDK_BRIDGE',
    library: 'PosnetSDK.dll',  // placeholder — real path set per installation
    baudRate: 9600,
    dataBits: 8,
    parity: 'None',
    stopBits: 'One',
    timeoutMs: 5000,
    priority: 20,
    hintProductIds: [],
  },
];
