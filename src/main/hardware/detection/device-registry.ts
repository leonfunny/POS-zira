/**
 * UniversalDeviceRegistry
 *
 * Persists device profiles for ALL printer types to JSON.
 * Extends the POSNET-only DeviceProfileRegistry pattern to cover
 * Thermal, Zebra, DYMO, HP, and any other Windows printer.
 *
 * Persistence: %APPDATA%/Zira AI/printer-registry.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import logger from '../../logger';
import {
  UniversalDeviceProfile,
  UniversalDeviceStatus,
  UniversalRegistryData,
  generateDeviceId,
} from './types';
import { PrinterType } from '../../../shared/types';

const REGISTRY_FILENAME = 'printer-registry.json';

export class UniversalDeviceRegistry {
  private data: UniversalRegistryData;
  private filePath: string;
  private dirty = false;

  constructor(storagePath?: string) {
    this.filePath = storagePath || path.join(app.getPath('userData'), REGISTRY_FILENAME);
    this.data = this.load();
  }

  // ─── Query ─────────────────────────────────────────────────────────────────

  /** Get all known devices. */
  getAllDevices(): UniversalDeviceProfile[] {
    return Object.values(this.data.devices);
  }

  /** Get device by ID. */
  getById(id: string): UniversalDeviceProfile | null {
    return this.data.devices[id] || null;
  }

  /** Get devices by printer type slot. */
  getByType(printerType: PrinterType): UniversalDeviceProfile[] {
    return this.getAllDevices().filter(d => d.printerType === printerType);
  }

  /** Get online devices only. */
  getOnlineDevices(): UniversalDeviceProfile[] {
    return this.getAllDevices().filter(d => d.status === 'online' || d.status === 'recovered');
  }

  /** Get devices by brand. */
  getByBrand(brand: string): UniversalDeviceProfile[] {
    const lower = brand.toLowerCase();
    return this.getAllDevices().filter(d => d.brand.toLowerCase() === lower);
  }

  /** Find device by Windows printer name (case-insensitive). */
  getByWindowsPrinterName(name: string): UniversalDeviceProfile | null {
    const lower = name.toLowerCase();
    return this.getAllDevices().find(
      d => d.windowsPrinterName?.toLowerCase() === lower,
    ) || null;
  }

  /** Find device by COM port. */
  getByPort(port: string): UniversalDeviceProfile | null {
    const upper = port.toUpperCase();
    return this.getAllDevices().find(d => d.port?.toUpperCase() === upper) || null;
  }

  // ─── Mutate ────────────────────────────────────────────────────────────────

  /**
   * Register or update a device.
   * If ID already exists → update connection info and lastSeen.
   * If new → create new profile.
   */
  upsert(profile: Omit<UniversalDeviceProfile, 'firstSeen' | 'lastSeen' | 'autoSelected' | 'previousIds'> & {
    firstSeen?: string;
    lastSeen?: string;
  }): UniversalDeviceProfile {
    const now = new Date().toISOString();
    const existing = this.data.devices[profile.id];

    if (existing) {
      // Track previous identifiers for recovery
      if (profile.windowsPrinterName && existing.windowsPrinterName &&
          profile.windowsPrinterName !== existing.windowsPrinterName) {
        if (!existing.previousIds.includes(existing.windowsPrinterName)) {
          existing.previousIds.push(existing.windowsPrinterName);
        }
        logger.info(`[UniversalRegistry] Printer name migration: ${profile.id} "${existing.windowsPrinterName}" → "${profile.windowsPrinterName}"`);
      }
      if (profile.port && existing.port && profile.port !== existing.port) {
        if (!existing.previousIds.includes(existing.port)) {
          existing.previousIds.push(existing.port);
        }
        logger.info(`[UniversalRegistry] Port migration: ${profile.id} ${existing.port} → ${profile.port}`);
      }

      existing.brand = profile.brand;
      existing.model = profile.model;
      existing.protocol = profile.protocol;
      existing.printerType = profile.printerType;
      existing.connectionType = profile.connectionType;
      existing.windowsPrinterName = profile.windowsPrinterName;
      existing.port = profile.port;
      existing.baudRate = profile.baudRate;
      existing.status = profile.status;
      existing.lastSeen = now;
      this.dirty = true;
      return existing;
    }

    // New device
    const newProfile: UniversalDeviceProfile = {
      ...profile,
      firstSeen: now,
      lastSeen: now,
      autoSelected: false,
      previousIds: [],
    };

    this.data.devices[profile.id] = newProfile;
    logger.info(`[UniversalRegistry] New device: ${profile.id} (${profile.brand} ${profile.model})`);
    this.dirty = true;
    return newProfile;
  }

  /** Mark a device as offline. */
  markOffline(id: string): void {
    const device = this.data.devices[id];
    if (device && device.status !== 'offline') {
      device.status = 'offline';
      this.dirty = true;
      logger.info(`[UniversalRegistry] Marked offline: ${id}`);
    }
  }

  /** Mark a device as online. */
  markOnline(id: string): void {
    const device = this.data.devices[id];
    if (device && device.status !== 'online') {
      device.status = 'online';
      device.lastSeen = new Date().toISOString();
      this.dirty = true;
    }
  }

  /** Mark a device as recovered (was offline, found again). */
  markRecovered(id: string, newIdentifier?: string): void {
    const device = this.data.devices[id];
    if (device) {
      device.status = 'recovered';
      device.lastSeen = new Date().toISOString();
      if (newIdentifier) {
        // Store old identifier in history
        const oldId = device.windowsPrinterName || device.port || '';
        if (oldId && !device.previousIds.includes(oldId)) {
          device.previousIds.push(oldId);
        }
      }
      this.dirty = true;
      logger.info(`[UniversalRegistry] Recovered: ${id}${newIdentifier ? ` → ${newIdentifier}` : ''}`);
    }
  }

  /** Mark all devices as offline (before a fresh scan). */
  markAllOffline(): void {
    for (const d of Object.values(this.data.devices)) {
      d.status = 'offline';
    }
    this.dirty = true;
  }

  /** Update status of a specific device. */
  setStatus(id: string, status: UniversalDeviceStatus): void {
    const device = this.data.devices[id];
    if (device) {
      device.status = status;
      this.dirty = true;
    }
  }

  /** Remove a device from the registry. */
  removeDevice(id: string): void {
    if (this.data.devices[id]) {
      delete this.data.devices[id];
      this.dirty = true;
      logger.info(`[UniversalRegistry] Removed device: ${id}`);
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
      logger.info(`[UniversalRegistry] Saved ${Object.keys(this.data.devices).length} device(s)`);
    } catch (err) {
      logger.error('[UniversalRegistry] Failed to save:', err);
    }
  }

  /** Force reload from disk. */
  reload(): void {
    this.data = this.load();
    this.dirty = false;
  }

  /** Export registry data as JSON (for IPC/UI). */
  toJSON(): UniversalRegistryData {
    return JSON.parse(JSON.stringify(this.data));
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private load(): UniversalRegistryData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.version === 2 && parsed.devices) {
          logger.info(`[UniversalRegistry] Loaded ${Object.keys(parsed.devices).length} device(s)`);
          return parsed as UniversalRegistryData;
        }
        logger.warn('[UniversalRegistry] Invalid registry version, starting fresh');
      }
    } catch (err) {
      logger.warn('[UniversalRegistry] Failed to load, starting fresh:', err);
    }

    return {
      version: 2,
      lastScan: '',
      devices: {},
    };
  }
}
