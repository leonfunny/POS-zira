/**
 * Types for the Posnet fiscal printer detection and management system.
 *
 * Key design decision: devices are keyed by SERIAL number, not COM port.
 * COM ports can change between USB reconnects; serial numbers are permanent.
 */

// ─── Device Profile ────────────────────────────────────────────────────────────

export interface DeviceProfile {
  /** Unique device serial number (permanent identifier). */
  serial: string;
  /** Model name (e.g. "Temo HS", "Thermal HD"). */
  model: string;
  /** Current COM port (may change on reconnect). */
  port: string;
  /** Communication protocol that worked during probe. */
  protocol: PosnetProtocol;
  /** DLL/library path for SDK-based protocols. Empty for native serial. */
  library: string;
  /** Baud rate used for communication. */
  baudRate: number;
  /** Current device status. */
  status: DeviceProfileStatus;
  /** ISO timestamp of last successful communication. */
  lastSeen: string;
  /** ISO timestamp of first discovery. */
  firstSeen: string;
  /** Firmware version if available. */
  firmwareVersion?: string;
  /** Device capabilities detected during probe. */
  capabilities: DeviceCapabilities;
  /** True if auto-selected (single device scenario). */
  autoSelected: boolean;
}

export interface DeviceCapabilities {
  fiscal: boolean;
  customerDisplay: boolean;
  cashDrawer: boolean;
  nip: boolean;
}

export type DeviceProfileStatus = 'online' | 'offline' | 'busy' | 'error' | 'unknown';

export type PosnetProtocol = 'POSNET_V2' | 'THERMAL' | 'SDK_BRIDGE';

// ─── Probe Profile ─────────────────────────────────────────────────────────────

export interface ProbeProfile {
  /** Unique name (e.g. "posnet-v2-9600", "thermal-115200"). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Protocol to try. */
  protocol: PosnetProtocol;
  /** DLL/library for SDK-based protocols. */
  library: string;
  /** Serial baud rate. */
  baudRate: number;
  /** Serial data bits. */
  dataBits: number;
  /** Serial parity: 'None' | 'Even' | 'Odd'. */
  parity: string;
  /** Serial stop bits: 'One' | 'Two'. */
  stopBits: string;
  /** Timeout for a single probe attempt (ms). */
  timeoutMs: number;
  /** Priority (lower = tried first). */
  priority: number;
  /** USB Product IDs that hint this profile is likely correct. Empty = try on any. */
  hintProductIds: number[];
}

// ─── Probe Result ──────────────────────────────────────────────────────────────

export interface ProbeResult {
  success: boolean;
  port: string;
  profileName: string;
  serial?: string;
  model?: string;
  firmwareVersion?: string;
  protocol: PosnetProtocol;
  library?: string;
  baudRate: number;
  errorMessage?: string;
  capabilities?: DeviceCapabilities;
}

// ─── Detection Result ──────────────────────────────────────────────────────────

export interface DetectionResult {
  /** True if at least one device was found. */
  success: boolean;
  /** All discovered devices. */
  devices: DeviceProfile[];
  /** Auto-selected device (only when exactly 1 found). Null if 0 or >1. */
  selectedDevice: DeviceProfile | null;
  /** True if user must pick from multiple devices. */
  requiresUserSelection: boolean;
  /** Ports that were scanned but had no Posnet device. */
  scannedPorts: string[];
  /** Non-fatal warnings encountered during scan. */
  warnings: string[];
}

// ─── Persisted registry file ───────────────────────────────────────────────────

export interface DeviceRegistryData {
  version: 1;
  lastScan: string;
  devices: Record<string, DeviceProfile>; // keyed by serial
  selectedSerial: string | null;
}
