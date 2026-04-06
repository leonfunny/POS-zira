/**
 * Universal printer detection module.
 *
 * Provides auto-detect, recovery, and registry for ALL printer types.
 */

export { UniversalDetectionService } from './universal-detection-service';
export { UniversalDeviceRegistry } from './device-registry';
export {
  type UniversalDeviceProfile,
  type UniversalDetectionResult,
  type RecoveryResult,
  type UniversalRegistryData,
  type BrandPattern,
  BRAND_PATTERNS,
  matchBrand,
  generateDeviceId,
} from './types';
