/**
 * Posnet fiscal printer detection & management module.
 *
 * Architecture (4 services):
 *
 *   DeviceDetectionService  ─→ scans COM ports, orchestrates probing
 *         │
 *   PosnetProbeEngine       ─→ tries protocol profiles on each port
 *         │
 *   DeviceProfileRegistry   ─→ stores devices by serial, handles port migration
 *         │
 *   FiscalPrinterAdapter    ─→ wraps PosnetDriver for the selected device
 *
 * Usage:
 *   const registry = new DeviceProfileRegistry();
 *   const engine = new PosnetProbeEngine();
 *   const detection = new DeviceDetectionService(engine, registry);
 *   const adapter = new FiscalPrinterAdapter(registry);
 *
 *   const result = await detection.detectAll();
 *   if (result.selectedDevice) {
 *     await adapter.initialize();
 *     await adapter.printTest();
 *   }
 */

export { DeviceDetectionService } from './device-detection-service';
export { PosnetProbeEngine, StubPosnetSdkClient } from './posnet-probe-engine';
export type { IPosnetSdkClient } from './posnet-probe-engine';
export { DeviceProfileRegistry } from './device-profile-registry';
export { FiscalPrinterAdapter } from './fiscal-printer-adapter';
export { PosnetDriver } from './posnet-driver';
export { ReceiptFormatter } from './receipt-formatter';
export { DEFAULT_PROBE_PROFILES, POSNET_PRODUCT_IDS, POSNET_USB_VID } from './probe-profiles';
export type {
  DeviceProfile,
  DeviceCapabilities,
  DeviceProfileStatus,
  PosnetProtocol,
  ProbeProfile,
  ProbeResult,
  DetectionResult,
  DeviceRegistryData,
} from './types';
