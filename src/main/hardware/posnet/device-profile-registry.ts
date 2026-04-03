/**
 * DeviceProfileRegistry
 *
 * Persists device profiles to JSON, keyed by serial number.
 * Handles:
 * - Store/update profiles after successful probe
 * - Port migration: same serial on new COM port → update mapping
 * - Selection: auto-select when 1 device, require user choice when multiple
 * - Persistence: %APPDATA%/Zira AI/posnet-devices.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import logger from '../../logger';
import { DeviceProfile, DeviceRegistryData, ProbeResult, DeviceProfileStatus } from './types';

const REGISTRY_FILENAME = 'posnet-devices.json';

export class DeviceProfileRegistry {
  private data: DeviceRegistryData;
  private filePath: string;
  private dirty = false;

  constructor(storagePath?: string) {
    this.filePath = storagePath || path.join(app.getPath('userData'), REGISTRY_FILENAME);
    this.data = this.load();
  }

  // ─── Query ─────────────────────────────────────────────────────────────────

  /** Get all known devices. */
  getAllDevices(): DeviceProfile[] {
    return Object.values(this.data.devices);
  }

  /** Get device by serial number. */
  getBySerial(serial: string): DeviceProfile | null {
    return this.data.devices[serial] || null;
  }

  /** Get device by current COM port. */
  getByPort(port: string): DeviceProfile | null {
    return Object.values(this.data.devices).find(d => d.port === port) || null;
  }

  /** Get the currently selected device (for printing). */
  getSelectedDevice(): DeviceProfile | null {
    if (!this.data.selectedSerial) return null;
    return this.data.devices[this.data.selectedSerial] || null;
  }

  /** Get online devices only. */
  getOnlineDevices(): DeviceProfile[] {
    return Object.values(this.data.devices).filter(d => d.status === 'online');
  }

  // ─── Mutate ────────────────────────────────────────────────────────────────

  /**
   * Register or update a device from a successful probe result.
   * If serial already exists → update port and lastSeen (port migration).
   * If new serial → create new profile.
   */
  upsertFromProbe(result: ProbeResult): DeviceProfile {
    const serial = result.serial || `UNKNOWN_${result.port}`;
    const existing = this.data.devices[serial];
    const now = new Date().toISOString();

    if (existing) {
      // Port migration: same serial, possibly different port
      if (existing.port !== result.port) {
        logger.info(`[Registry] Port migration: ${serial} moved ${existing.port} → ${result.port}`);
      }
      existing.port = result.port;
      existing.protocol = result.protocol;
      existing.library = result.library || '';
      existing.baudRate = result.baudRate;
      existing.status = 'online';
      existing.lastSeen = now;
      if (result.model) existing.model = result.model;
      if (result.firmwareVersion) existing.firmwareVersion = result.firmwareVersion;
      if (result.capabilities) existing.capabilities = result.capabilities;
      this.dirty = true;
      return existing;
    }

    // New device
    const profile: DeviceProfile = {
      serial,
      model: result.model || 'Unknown',
      port: result.port,
      protocol: result.protocol,
      library: result.library || '',
      baudRate: result.baudRate,
      status: 'online',
      lastSeen: now,
      firstSeen: now,
      firmwareVersion: result.firmwareVersion,
      capabilities: result.capabilities || {
        fiscal: false,
        customerDisplay: false,
        cashDrawer: false,
        nip: false,
      },
      autoSelected: false,
    };

    this.data.devices[serial] = profile;
    logger.info(`[Registry] New device registered: ${serial} (${profile.model}) on ${profile.port}`);
    this.dirty = true;
    return profile;
  }

  /**
   * Select a device for printing.
   * - If exactly 1 online device → auto-select and mark autoSelected=true
   * - If multiple → require explicit serial selection
   */
  selectDevice(serial: string): DeviceProfile | null {
    const device = this.data.devices[serial];
    if (!device) {
      logger.warn(`[Registry] Cannot select unknown serial: ${serial}`);
      return null;
    }

    // Clear previous auto-select flags
    for (const d of Object.values(this.data.devices)) {
      d.autoSelected = false;
    }

    this.data.selectedSerial = serial;
    device.autoSelected = true;
    this.dirty = true;
    logger.info(`[Registry] Selected device: ${serial} (${device.model}) on ${device.port}`);
    return device;
  }

  /**
   * Auto-select if exactly one online device.
   * Returns the auto-selected device, or null if 0 or >1.
   */
  autoSelect(): DeviceProfile | null {
    const online = this.getOnlineDevices();
    if (online.length === 1) {
      return this.selectDevice(online[0].serial);
    }
    if (online.length > 1) {
      logger.info(`[Registry] Multiple devices online (${online.length}), user must select`);
    }
    return null;
  }

  /** Mark a device as offline. */
  markOffline(serial: string): void {
    const device = this.data.devices[serial];
    if (device) {
      device.status = 'offline';
      this.dirty = true;
    }
  }

  /** Mark all devices as offline (e.g. before a fresh scan). */
  markAllOffline(): void {
    for (const d of Object.values(this.data.devices)) {
      d.status = 'offline';
    }
    this.dirty = true;
  }

  /** Update status of a specific device. */
  setStatus(serial: string, status: DeviceProfileStatus): void {
    const device = this.data.devices[serial];
    if (device) {
      device.status = status;
      this.dirty = true;
    }
  }

  /** Remove a device from the registry. */
  removeDevice(serial: string): void {
    if (this.data.devices[serial]) {
      delete this.data.devices[serial];
      if (this.data.selectedSerial === serial) {
        this.data.selectedSerial = null;
      }
      this.dirty = true;
      logger.info(`[Registry] Removed device: ${serial}`);
    }
  }

  /** Record that a scan was performed. */
  recordScan(): void {
    this.data.lastScan = new Date().toISOString();
    this.dirty = true;
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  /** Save to disk if dirty. */
  save(): void {
    if (!this.dirty) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
      this.dirty = false;
      logger.info(`[Registry] Saved ${Object.keys(this.data.devices).length} device(s) to ${this.filePath}`);
    } catch (err) {
      logger.error('[Registry] Failed to save:', err);
    }
  }

  /** Force reload from disk. */
  reload(): void {
    this.data = this.load();
    this.dirty = false;
  }

  /** Export registry data as JSON (for IPC/UI). */
  toJSON(): DeviceRegistryData {
    return JSON.parse(JSON.stringify(this.data));
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private load(): DeviceRegistryData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as DeviceRegistryData;
        if (parsed.version === 1 && parsed.devices) {
          logger.info(`[Registry] Loaded ${Object.keys(parsed.devices).length} device(s) from ${this.filePath}`);
          return parsed;
        }
        logger.warn('[Registry] Invalid registry file version, starting fresh');
      }
    } catch (err) {
      logger.warn('[Registry] Failed to load registry, starting fresh:', err);
    }

    return {
      version: 1,
      lastScan: '',
      devices: {},
      selectedSerial: null,
    };
  }
}
