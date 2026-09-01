import type { PrinterConfig } from '../../../shared/types';

/**
 * Restore TSPL-only tuning that the local_printers SQL mirror cannot store.
 * The electron-store entry is authoritative for these installation-specific
 * values when a mirrored printer is recreated.
 */
export function applyStoredTsplMediaTuning(
  target: PrinterConfig,
  stored: PrinterConfig | null | undefined,
): void {
  if (!stored || target.protocol !== 'TSPL') return;

  if (typeof stored.labelGapMm === 'number' && Number.isFinite(stored.labelGapMm)) {
    target.labelGapMm = stored.labelGapMm;
  }
  if (typeof stored.printSpeed === 'number' && Number.isFinite(stored.printSpeed)) {
    target.printSpeed = stored.printSpeed;
  }
  if (typeof stored.printDensity === 'number' && Number.isFinite(stored.printDensity)) {
    target.printDensity = stored.printDensity;
  }
  if (
    typeof stored.labelOriginInsetMm === 'number'
    && Number.isFinite(stored.labelOriginInsetMm)
  ) {
    target.labelOriginInsetMm = stored.labelOriginInsetMm;
  }
  if (stored.mediaSensor === 'gap' || stored.mediaSensor === 'bline' || stored.mediaSensor === 'none') {
    target.mediaSensor = stored.mediaSensor;
  }
}
