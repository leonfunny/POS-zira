/**
 * DeviceDetectionService
 *
 * Orchestrates COM port scanning and device probing.
 * Flow:
 *   1. Scan all COM ports (or filter to VID_1424 candidates)
 *   2. For each port → PosnetProbeEngine tries profiles A→B→C...
 *   3. Successful probes → DeviceProfileRegistry (keyed by serial)
 *   4. Auto-select if 1 device; require user choice if multiple
 *
 * Does NOT install drivers or download anything at runtime.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../../logger';
import { listSerialPorts } from '../port-utils';
import { PosnetProbeEngine } from './posnet-probe-engine';
import { DeviceProfileRegistry } from './device-profile-registry';
import { DetectionResult, DeviceProfile } from './types';
import { POSNET_USB_VID, POSNET_PRODUCT_IDS } from './probe-profiles';

const execFileAsync = promisify(execFile);

interface PortCandidate {
  port: string;
  pid?: number;
  isVidMatch: boolean;
}

export class DeviceDetectionService {
  private probeEngine: PosnetProbeEngine;
  private registry: DeviceProfileRegistry;
  private scanning = false;

  constructor(
    probeEngine: PosnetProbeEngine,
    registry: DeviceProfileRegistry,
  ) {
    this.probeEngine = probeEngine;
    this.registry = registry;
  }

  /** True if a scan is currently in progress. */
  isScanning(): boolean {
    return this.scanning;
  }

  /**
   * Full detection scan:
   * 1. Find VID_1424 candidates first (fast path)
   * 2. Fall back to all COM ports if no VID matches
   * 3. Probe each candidate with the engine
   * 4. Register results, auto-select if applicable
   */
  async detectAll(): Promise<DetectionResult> {
    if (this.scanning) {
      logger.warn('[Detection] Scan already in progress, skipping');
      return {
        success: false,
        devices: [],
        selectedDevice: null,
        requiresUserSelection: false,
        scannedPorts: [],
        warnings: ['Scan already in progress'],
      };
    }

    this.scanning = true;
    const warnings: string[] = [];
    const scannedPorts: string[] = [];
    const foundDevices: DeviceProfile[] = [];

    try {
      logger.info('[Detection] Starting full device scan...');

      // Mark existing devices offline before scan
      this.registry.markAllOffline();

      // Step 1: Find candidates
      const candidates = await this.findCandidates();
      logger.info(`[Detection] Found ${candidates.length} candidate port(s): ${candidates.map(c => `${c.port}${c.isVidMatch ? ' (VID match)' : ''}`).join(', ') || 'none'}`);

      if (candidates.length === 0) {
        this.registry.recordScan();
        this.registry.save();
        return {
          success: false,
          devices: [],
          selectedDevice: null,
          requiresUserSelection: false,
          scannedPorts: [],
          warnings: ['No COM ports found. Check USB connection and drivers.'],
        };
      }

      // Step 2: Probe each candidate
      // Prioritize VID matches first
      const sorted = [
        ...candidates.filter(c => c.isVidMatch),
        ...candidates.filter(c => !c.isVidMatch),
      ];

      for (const candidate of sorted) {
        scannedPorts.push(candidate.port);
        logger.info(`[Detection] Probing ${candidate.port}...`);

        try {
          const result = await this.probeEngine.probePort(candidate.port, candidate.pid);

          if (result && result.success) {
            const profile = this.registry.upsertFromProbe(result);
            foundDevices.push(profile);
            logger.info(`[Detection] Device found: ${profile.model} (${profile.serial}) on ${profile.port}`);
          } else {
            logger.info(`[Detection] No Posnet device on ${candidate.port}`);
          }
        } catch (err: any) {
          const msg = `Port ${candidate.port} probe failed: ${err.message}`;
          warnings.push(msg);
          logger.warn(`[Detection] ${msg}`);
        }
      }

      // Step 3: Auto-select if exactly 1 device
      let selectedDevice: DeviceProfile | null = null;
      if (foundDevices.length === 1) {
        selectedDevice = this.registry.selectDevice(foundDevices[0].serial);
        if (selectedDevice) {
          selectedDevice.autoSelected = true;
          logger.info(`[Detection] Auto-selected: ${selectedDevice.serial} (${selectedDevice.model})`);
        }
      } else if (foundDevices.length > 1) {
        logger.info(`[Detection] Multiple devices found (${foundDevices.length}), user must select`);
      }

      this.registry.recordScan();
      this.registry.save();

      const result: DetectionResult = {
        success: foundDevices.length > 0,
        devices: foundDevices,
        selectedDevice,
        requiresUserSelection: foundDevices.length > 1,
        scannedPorts,
        warnings,
      };

      logger.info(`[Detection] Scan complete: ${foundDevices.length} device(s) found`);
      return result;

    } finally {
      this.scanning = false;
    }
  }

  /**
   * Quick re-scan: only check ports where we previously found devices.
   * Useful for health checks and reconnection.
   */
  async rescanKnownDevices(): Promise<DetectionResult> {
    const known = this.registry.getAllDevices();
    if (known.length === 0) {
      return this.detectAll(); // No known devices, do full scan
    }

    this.scanning = true;
    const warnings: string[] = [];
    const scannedPorts: string[] = [];
    const onlineDevices: DeviceProfile[] = [];

    try {
      for (const device of known) {
        scannedPorts.push(device.port);
        try {
          const result = await this.probeEngine.probePort(device.port);
          if (result && result.success) {
            const updated = this.registry.upsertFromProbe(result);
            onlineDevices.push(updated);
          } else {
            // Device not on this port anymore — try all ports
            this.registry.markOffline(device.serial);
          }
        } catch (err: any) {
          this.registry.markOffline(device.serial);
          warnings.push(`${device.serial} check failed: ${err.message}`);
        }
      }

      // For offline devices, attempt recovery on all ports
      const offlineDevices = this.registry.getAllDevices().filter(d => d.status === 'offline');
      if (offlineDevices.length > 0) {
        logger.info(`[Detection] ${offlineDevices.length} device(s) offline, attempting port recovery...`);
        const allPorts = await listSerialPorts();
        const unusedPorts = allPorts.filter(p => !scannedPorts.includes(p));

        for (const port of unusedPorts) {
          scannedPorts.push(port);
          try {
            const result = await this.probeEngine.probePort(port);
            if (result && result.success) {
              const updated = this.registry.upsertFromProbe(result);
              onlineDevices.push(updated);
              logger.info(`[Detection] Recovered ${updated.serial} on ${port}`);
            }
          } catch (err: any) { logger.debug(`[DeviceDetection] probe port ${port} for recovery failed:`, err?.message); }
        }
      }

      this.registry.recordScan();
      this.registry.save();

      const selectedDevice = this.registry.autoSelect();

      return {
        success: onlineDevices.length > 0,
        devices: onlineDevices,
        selectedDevice,
        requiresUserSelection: onlineDevices.length > 1 && !selectedDevice,
        scannedPorts,
        warnings,
      };
    } finally {
      this.scanning = false;
    }
  }

  // ─── Port candidate discovery ──────────────────────────────────────────────

  /**
   * Find COM port candidates, combining VID-filtered PnP scan + all serial ports.
   */
  private async findCandidates(): Promise<PortCandidate[]> {
    const candidates: PortCandidate[] = [];
    const seenPorts = new Set<string>();

    // Method 1: PnP devices with VID_1424 (fast, accurate)
    try {
      const vidPorts = await this.findPosnetVidPorts();
      for (const vp of vidPorts) {
        if (!seenPorts.has(vp.port)) {
          candidates.push(vp);
          seenPorts.add(vp.port);
        }
      }
    } catch (err: any) {
      logger.warn(`[Detection] VID scan failed: ${err.message}`);
    }

    // Method 2: All serial ports (catches devices without VID match)
    try {
      const allPorts = await listSerialPorts();
      for (const port of allPorts) {
        if (!seenPorts.has(port)) {
          candidates.push({ port, isVidMatch: false });
          seenPorts.add(port);
        }
      }
    } catch (err: any) {
      logger.warn(`[Detection] Serial port scan failed: ${err.message}`);
    }

    return candidates;
  }

  /**
   * Query PnP for USB devices with VID_1424, extracting COM port and PID.
   */
  private async findPosnetVidPorts(): Promise<PortCandidate[]> {
    const psCommand = `
Get-CimInstance Win32_PnPEntity |
  Where-Object { $_.DeviceID -match 'VID_${POSNET_USB_VID}' -and $_.Name -match 'COM\\d+' } |
  ForEach-Object {
    $port = if ($_.Name -match '\\(COM(\\d+)\\)') { "COM$($Matches[1])" } else { '' }
    $pid = if ($_.DeviceID -match 'PID_([0-9A-Fa-f]+)') { $Matches[1] } else { '0000' }
    if ($port) { Write-Output "$port|$pid" }
  }
`.trim();

    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psCommand],
        { encoding: 'utf8', timeout: 15000 },
      );

      return stdout
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
          const [port, pidHex] = line.split('|');
          const pid = parseInt(pidHex, 16);
          return {
            port,
            pid: isNaN(pid) ? undefined : pid,
            isVidMatch: true,
          };
        });
    } catch (err: any) {
      logger.warn(`[Detection] findPosnetVidPorts failed: ${err.message}`);
      return [];
    }
  }
}
