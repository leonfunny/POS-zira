/**
 * UniversalDetectionService
 *
 * Orchestrates detection for ALL printer types in one scan.
 * Replaces the POSNET-only DeviceDetectionService with a universal approach:
 *
 *   1. Windows Printers scan (Get-Printer) → classify by brand
 *   2. USB PnP VID scan → catch CDC serial devices (POSNET etc.)
 *   3. COM port probe for serial printers (POSNET + ESC/POS)
 *   4. Register all results in UniversalDeviceRegistry
 *   5. Auto-assign: 1 device per type slot → auto-configure
 *
 * Does NOT replace POSNET-specific DeviceDetectionService — that remains
 * for fiscal adapter use. This service handles the broader detection.
 */

import logger from '../../logger';
import { listSerialPorts, listWindowsPrintersDetailed, WindowsPrinterInfo, probeEscPosPort } from '../port-utils';
import { getPosnetDriverStatus, classifyPrinterCategory, DetectedDevice } from '../driver-installer';
import { UniversalDeviceRegistry } from './device-registry';
import {
  UniversalDeviceProfile,
  UniversalDetectionResult,
  RecoveryResult,
  matchBrand,
  generateDeviceId,
  BRAND_PATTERNS,
} from './types';
import { PrinterProtocol, PrinterType } from '../../../shared/types';

export class UniversalDetectionService {
  private registry: UniversalDeviceRegistry;
  private scanning = false;

  constructor(registry: UniversalDeviceRegistry) {
    this.registry = registry;
  }

  /** True if a scan is currently in progress. */
  isScanning(): boolean {
    return this.scanning;
  }

  /** Get the registry instance (for external queries). */
  getRegistry(): UniversalDeviceRegistry {
    return this.registry;
  }

  /**
   * Full detection scan for all printer types.
   * Leverages existing getPosnetDriverStatus() which already scans:
   *   - Windows printers (Get-Printer)
   *   - USB PnP devices by VID
   * Then registers everything in the universal registry.
   */
  async detectAll(): Promise<UniversalDetectionResult> {
    if (this.scanning) {
      logger.warn('[UniversalDetection] Scan already in progress');
      return { success: false, devices: [], configured: [], warnings: ['Scan already in progress'] };
    }

    this.scanning = true;
    const warnings: string[] = [];
    const configured: UniversalDeviceProfile[] = [];

    try {
      logger.info('[UniversalDetection] Starting full device scan...');

      // Use existing detection infrastructure
      const hwStatus = await getPosnetDriverStatus();
      logger.info(`[UniversalDetection] Found ${hwStatus.devices.length} device(s) from hardware scan`);

      // Register each detected device in universal registry
      for (const dev of hwStatus.devices) {
        try {
          const profile = this.registerDetectedDevice(dev);
          if (profile) configured.push(profile);
        } catch (err: any) {
          warnings.push(`Failed to register ${dev.brand} ${dev.model}: ${err.message}`);
        }
      }

      this.registry.recordScan();
      this.registry.save();

      const allDevices = this.registry.getOnlineDevices();
      logger.info(`[UniversalDetection] Scan complete: ${allDevices.length} online device(s)`);

      return {
        success: allDevices.length > 0,
        devices: allDevices,
        configured,
        warnings,
      };
    } catch (err: any) {
      logger.error('[UniversalDetection] Scan failed:', err);
      return { success: false, devices: [], configured: [], warnings: [err.message] };
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Quick re-scan: check if previously known devices are still available.
   * Used by health check to update registry status without a full scan.
   */
  async rescanKnown(): Promise<UniversalDetectionResult> {
    if (this.scanning) {
      logger.warn('[UniversalDetection] Scan already in progress');
      return { success: false, devices: [], configured: [], warnings: ['Scan already in progress'] };
    }

    const known = this.registry.getAllDevices();
    if (known.length === 0) {
      return this.detectAll();
    }

    this.scanning = true;
    const warnings: string[] = [];

    try {
      // Get current Windows printers and COM ports
      const [windowsPrinters, comPorts] = await Promise.all([
        listWindowsPrintersDetailed().catch(() => [] as WindowsPrinterInfo[]),
        listSerialPorts().catch(() => [] as string[]),
      ]);

      const winNames = new Set(windowsPrinters.map(p => p.name.toLowerCase()));
      const comSet = new Set(comPorts.map(p => p.toUpperCase()));

      for (const device of known) {
        let stillAvailable = false;

        if (device.windowsPrinterName) {
          stillAvailable = winNames.has(device.windowsPrinterName.toLowerCase());
        } else if (device.port) {
          stillAvailable = comSet.has(device.port.toUpperCase());
        }

        if (stillAvailable) {
          this.registry.markOnline(device.id);
        } else if (device.status === 'online' || device.status === 'recovered') {
          this.registry.markOffline(device.id);
          logger.info(`[UniversalDetection] Device went offline: ${device.id} (${device.brand} ${device.model})`);
        }
      }

      this.registry.save();

      return {
        success: true,
        devices: this.registry.getOnlineDevices(),
        configured: [],
        warnings,
      };
    } catch (err: any) {
      logger.error('[UniversalDetection] Rescan failed:', err);
      return { success: false, devices: [], configured: [], warnings: [err.message] };
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Attempt to recover a specific offline device.
   * Scans current printers/ports to find a matching device by brand pattern.
   */
  async recoverDevice(deviceId: string): Promise<RecoveryResult> {
    const device = this.registry.getById(deviceId);
    if (!device) {
      return { recovered: false, oldIdentifier: deviceId, message: 'Device not found in registry' };
    }

    const oldIdentifier = device.windowsPrinterName || device.port || device.id;

    if (device.connectionType === 'SERIAL' || device.port) {
      return this.recoverSerialDevice(device, oldIdentifier);
    } else {
      return this.recoverWindowsDevice(device, oldIdentifier);
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Register a DetectedDevice (from driver-installer) into the universal registry.
   */
  private registerDetectedDevice(dev: DetectedDevice): UniversalDeviceProfile | null {
    const classification = classifyPrinterCategory(dev);
    const id = generateDeviceId(
      undefined,
      dev.windowsPrinterName || undefined,
      dev.brand,
      dev.comPort || dev.portName || undefined,
      dev.vid || undefined,
      dev.pid || undefined,
    );

    return this.registry.upsert({
      id,
      brand: dev.brand,
      model: dev.model,
      protocol: classification.protocol as PrinterProtocol,
      printerType: classification.targetType as PrinterType,
      connectionType: dev.connectionType === 'VIRTUAL' ? 'USB' : dev.connectionType as 'USB' | 'SERIAL' | 'NETWORK',
      windowsPrinterName: dev.windowsPrinterName || undefined,
      port: dev.comPort || undefined,
      baudRate: dev.comPort ? 9600 : undefined,
      status: dev.driverInstalled ? 'online' : 'offline',
    });
  }

  /**
   * Recovery for Windows spooler printers (Zebra, Thermal USB, A4).
   * When the configured printer name disappears, scan Windows printers
   * for a brand-matching name.
   */
  private async recoverWindowsDevice(
    device: UniversalDeviceProfile,
    oldIdentifier: string,
  ): Promise<RecoveryResult> {
    try {
      const printers = await listWindowsPrintersDetailed();
      const brandLower = device.brand.toLowerCase();

      // Find brand pattern for this device
      const brandPattern = BRAND_PATTERNS.find(
        bp => bp.brand.toLowerCase() === brandLower,
      );

      if (!brandPattern) {
        return {
          recovered: false,
          oldIdentifier,
          message: `No brand pattern for "${device.brand}" — cannot recover`,
        };
      }

      // Search for a printer matching the brand patterns
      for (const printer of printers) {
        const nameLower = printer.name.toLowerCase();
        const isMatch = brandPattern.namePatterns.some(p => nameLower.includes(p));
        if (!isMatch) continue;

        // Found a matching printer — check it's not already tracked as another device
        const existingByName = this.registry.getByWindowsPrinterName(printer.name);
        if (existingByName && existingByName.id !== device.id && existingByName.status === 'online') {
          continue; // Already tracked as a different device
        }

        // Update device with new printer name
        device.windowsPrinterName = printer.name;
        device.status = 'recovered';
        device.lastSeen = new Date().toISOString();
        if (!device.previousIds.includes(oldIdentifier)) {
          device.previousIds.push(oldIdentifier);
        }
        this.registry.markRecovered(device.id, printer.name);
        this.registry.save();

        logger.info(`[UniversalDetection] Recovered Windows printer: "${oldIdentifier}" → "${printer.name}"`);
        return {
          recovered: true,
          newIdentifier: printer.name,
          oldIdentifier,
          message: `${device.brand} printer recovered as "${printer.name}"`,
        };
      }

      return {
        recovered: false,
        oldIdentifier,
        message: `No ${device.brand} printer found in Windows`,
      };
    } catch (err: any) {
      return {
        recovered: false,
        oldIdentifier,
        message: `Recovery scan failed: ${err.message}`,
      };
    }
  }

  /**
   * Recovery for serial/COM port printers (POSNET, Thermal serial).
   * When the configured COM port disappears, scan all COM ports.
   * For POSNET: delegate to PosnetDriver.detectPosnetPort() (done in health check).
   * For Thermal serial: try ESC/POS probe on each port.
   */
  private async recoverSerialDevice(
    device: UniversalDeviceProfile,
    oldIdentifier: string,
  ): Promise<RecoveryResult> {
    try {
      const ports = await listSerialPorts();
      if (ports.length === 0) {
        return { recovered: false, oldIdentifier, message: 'No COM ports available' };
      }

      // Skip the old port (it's already gone)
      const candidates = ports.filter(p => p.toUpperCase() !== (device.port || '').toUpperCase());
      if (candidates.length === 0) {
        // Only the same port exists — check if it came back
        if (ports.includes((device.port || '').toUpperCase())) {
          this.registry.markRecovered(device.id);
          this.registry.save();
          return {
            recovered: true,
            newIdentifier: device.port,
            oldIdentifier,
            message: `Port ${device.port} reappeared`,
          };
        }
        return { recovered: false, oldIdentifier, message: 'No new COM ports to try' };
      }

      // For non-POSNET serial printers, try ESC/POS probe on each port
      // POSNET recovery is handled by PosnetDriver.recoverPort() directly
      if (device.protocol !== 'POSNET') {
        for (const port of candidates) {
          const responded = await probeEscPosPort(port, device.baudRate || 9600);
          if (responded) {
            device.port = port;
            device.status = 'recovered';
            device.lastSeen = new Date().toISOString();
            if (!device.previousIds.includes(oldIdentifier)) {
              device.previousIds.push(oldIdentifier);
            }
            this.registry.markRecovered(device.id, port);
            this.registry.save();

            logger.info(`[UniversalDetection] Recovered serial printer: ${oldIdentifier} → ${port}`);
            return {
              recovered: true,
              newIdentifier: port,
              oldIdentifier,
              message: `${device.brand} printer recovered on ${port}`,
            };
          }
        }
      }

      return {
        recovered: false,
        oldIdentifier,
        message: `${device.brand} printer not found on any COM port`,
      };
    } catch (err: any) {
      return {
        recovered: false,
        oldIdentifier,
        message: `Serial recovery failed: ${err.message}`,
      };
    }
  }

}
