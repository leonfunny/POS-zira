import type { PrinterConfig } from './types';

/** Measured safe defaults for the continuous 20mm fabric ribbon. */
export const FABRIC_TAG_PRINTER_DEFAULTS: Partial<PrinterConfig> = {
  labelWidth: 20,
  labelHeight: 60,
  paperWidth: 20,
  charsPerLine: 32,
  labelGapMm: 0,
  mediaSensor: 'none',
  printSpeed: 2,
  printDensity: 12,
};

/**
 * Repair the exact legacy sentinel produced when the generic Settings default
 * was stored behind a FABRIC_TAG select that visually showed TSPL. Custom TSPL
 * media sizes are intentional and must not be rewritten.
 */
export function repairLegacyFabricTagPrinterConfig(
  saved?: PrinterConfig,
): PrinterConfig | undefined {
  if (
    !saved
    || saved.protocol !== 'THERMAL'
    || saved.labelWidth !== 50
    || saved.labelHeight !== 30
  ) {
    return saved;
  }

  return {
    ...saved,
    ...FABRIC_TAG_PRINTER_DEFAULTS,
    protocol: 'TSPL',
  };
}
