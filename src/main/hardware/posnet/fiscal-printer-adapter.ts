/**
 * FiscalPrinterAdapter
 *
 * Uses the selected device profile for all printing operations.
 * Completely separate from detection logic — receives a DeviceProfile
 * and wraps the underlying PosnetDriver for printing.
 *
 * Responsibilities:
 * - Get the active device from the registry
 * - Create/manage a PosnetDriver instance with the profile's settings
 * - Delegate all print operations
 * - Handle profile changes (port migration, device switch)
 */

import logger from '../../logger';
import { PosnetDriver } from './posnet-driver';
import { DeviceProfileRegistry } from './device-profile-registry';
import { DeviceProfile, PosnetProtocol } from './types';
import { ReceiptData, PrinterStatusInfo } from '../../../shared/types';

export class FiscalPrinterAdapter {
  private registry: DeviceProfileRegistry;
  private driver: PosnetDriver | null = null;
  private activeSerial: string | null = null;

  constructor(registry: DeviceProfileRegistry) {
    this.registry = registry;
  }

  /**
   * Initialize/reinitialize the adapter from the currently selected device.
   * Returns true if a driver was successfully created and connected.
   */
  async initialize(): Promise<boolean> {
    const selected = this.registry.getSelectedDevice();
    if (!selected) {
      logger.warn('[FiscalAdapter] No device selected in registry');
      this.disconnect();
      return false;
    }

    // If same device is already active and connected, skip re-init
    if (this.activeSerial === selected.serial && this.driver?.isConnected()) {
      // But check if port changed (migration)
      if (this.driver.getPort() !== selected.port) {
        logger.info(`[FiscalAdapter] Port changed for ${selected.serial}: ${this.driver.getPort()} → ${selected.port}`);
        this.disconnect();
      } else {
        return true;
      }
    }

    // Create new driver from profile
    this.disconnect();
    return this.connectToProfile(selected);
  }

  /**
   * Connect to a specific device profile.
   */
  private async connectToProfile(profile: DeviceProfile): Promise<boolean> {
    const protocol = this.mapProtocol(profile.protocol);

    logger.info(`[FiscalAdapter] Connecting to ${profile.model} (${profile.serial}) on ${profile.port} @ ${profile.baudRate} [${protocol}]`);

    this.driver = new PosnetDriver(profile.port, profile.baudRate, protocol);

    try {
      const connected = await this.driver.connect();
      if (connected) {
        this.activeSerial = profile.serial;
        logger.info(`[FiscalAdapter] Connected to ${profile.serial}`);
        return true;
      }

      logger.warn(`[FiscalAdapter] Failed to connect to ${profile.serial} on ${profile.port}`);
      this.registry.markOffline(profile.serial);
      this.driver = null;
      return false;
    } catch (err: any) {
      logger.error(`[FiscalAdapter] Connection error for ${profile.serial}:`, err);
      this.registry.setStatus(profile.serial, 'error');
      this.driver = null;
      return false;
    }
  }

  /**
   * Disconnect the current driver.
   */
  disconnect(): void {
    if (this.driver) {
      try { this.driver.disconnect(); } catch (err: any) { logger.debug('[FiscalPrinterAdapter] disconnect driver failed:', err?.message); }
      this.driver = null;
      this.activeSerial = null;
    }
  }

  /**
   * Switch to a different device (after user selection).
   */
  async switchDevice(serial: string): Promise<boolean> {
    const device = this.registry.selectDevice(serial);
    if (!device) {
      logger.warn(`[FiscalAdapter] Cannot switch to unknown device: ${serial}`);
      return false;
    }

    this.disconnect();
    return this.connectToProfile(device);
  }

  // ─── Print operations (delegate to PosnetDriver) ──────────────────────────

  async printReceipt(data: ReceiptData): Promise<void> {
    const driver = await this.ensureDriver();
    await driver.printReceipt(data);
  }

  async printTest(): Promise<void> {
    const driver = await this.ensureDriver();
    await driver.printTest();
  }

  async displayMessage(line1: string, line2?: string): Promise<void> {
    const driver = await this.ensureDriver();
    await driver.displayMessage(line1, line2);
  }

  async openDrawer(): Promise<void> {
    const driver = await this.ensureDriver();
    await driver.openDrawer();
  }

  async getStatus(): Promise<PrinterStatusInfo> {
    if (!this.driver) {
      return {
        connected: false,
        type: 'POSNET',
        mock: false,
      };
    }
    return this.driver.getStatus();
  }

  isConnected(): boolean {
    return this.driver?.isConnected() || false;
  }

  getPort(): string {
    return this.driver?.getPort() || '';
  }

  /** Get the active device profile. */
  getActiveProfile(): DeviceProfile | null {
    if (!this.activeSerial) return null;
    return this.registry.getBySerial(this.activeSerial);
  }

  // ─── Health check ─────────────────────────────────────────────────────────

  /**
   * Run health check on the active driver.
   * If disconnected, attempt port recovery through the registry.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.driver || !this.activeSerial) {
      // Try to initialize from registry
      const ok = await this.initialize();
      return ok;
    }

    const healthy = await this.driver.healthCheck();

    if (!healthy) {
      logger.warn(`[FiscalAdapter] Health check failed for ${this.activeSerial}`);
      this.registry.markOffline(this.activeSerial);

      // Try port recovery
      const newPort = await this.driver.recoverPort();
      if (newPort) {
        // Update registry with new port
        const profile = this.registry.getBySerial(this.activeSerial);
        if (profile) {
          profile.port = newPort;
          profile.status = 'online';
          profile.lastSeen = new Date().toISOString();
          this.registry.save();
        }
        return true;
      }

      return false;
    }

    // Update lastSeen
    const profile = this.registry.getBySerial(this.activeSerial);
    if (profile) {
      profile.status = 'online';
      profile.lastSeen = new Date().toISOString();
    }

    return true;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async ensureDriver(): Promise<PosnetDriver> {
    if (this.driver?.isConnected()) {
      return this.driver;
    }

    // Try to reinitialize
    const ok = await this.initialize();
    if (!ok || !this.driver) {
      throw new Error('No fiscal printer connected. Run device detection first.');
    }

    return this.driver;
  }

  private mapProtocol(protocol: PosnetProtocol): 'POSNET' | 'THERMAL' {
    switch (protocol) {
      case 'POSNET_V2':
      case 'SDK_BRIDGE':
        return 'POSNET';
      case 'THERMAL':
        return 'THERMAL';
      default:
        return 'POSNET';
    }
  }
}
