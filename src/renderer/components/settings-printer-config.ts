import {
  ALLOWED_PROTOCOLS_BY_TYPE,
  PrinterType,
  type PrinterConfig,
  type PrinterProtocol,
  type PrintersConfig,
} from '../../shared/types';
import {
  FABRIC_TAG_PRINTER_DEFAULTS,
  repairLegacyFabricTagPrinterConfig,
} from '../../shared/fabric-tag-printer-config';

/** Generic slot defaults used by both legacy and multi-printer settings. */
export const DEFAULT_PRINTER_CONFIG: PrinterConfig = {
  enabled: false,
  protocol: 'THERMAL',
  baudRate: 9600,
  labelWidth: 50,
  labelHeight: 30,
  paperWidth: 80,
  charsPerLine: 48,
  supportsCut: true,
  supportsCashDrawer: false,
};

/** Measured safe defaults for the continuous 20mm fabric ribbon. */
export const FABRIC_TAG_DEFAULTS = FABRIC_TAG_PRINTER_DEFAULTS;

const MIN_LABEL_DIMENSION_MM = 10;
const MAX_LABEL_DIMENSION_MM = 1000;
const MAX_TSPL_GAP_MM = 25;

function clampFinite(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  const finite = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, finite));
}

export function maxLabelOriginInsetMm(labelWidthMm: number): number {
  const width = clampFinite(labelWidthMm, MIN_LABEL_DIMENSION_MM, MAX_LABEL_DIMENSION_MM, 20);
  // Settings edits in 0.1mm steps. Staying one full step below half-width
  // guarantees the formatter's strict `< width / 2` invariant.
  return Math.max(0, Math.floor((width / 2 - 0.1) * 10) / 10);
}

export function resolvePrinterConfigForType(
  printerType: string,
  saved?: PrinterConfig,
): PrinterConfig {
  const normalizedSaved = printerType === PrinterType.FABRIC_TAG
    ? repairLegacyFabricTagPrinterConfig(saved)
    : saved;
  const base: PrinterConfig = {
    ...DEFAULT_PRINTER_CONFIG,
    ...(printerType === PrinterType.FABRIC_TAG ? FABRIC_TAG_DEFAULTS : {}),
    ...(normalizedSaved || {}),
  };
  const allowed = (
    ALLOWED_PROTOCOLS_BY_TYPE as Record<string, readonly PrinterProtocol[] | undefined>
  )[printerType] || [];
  return allowed.length > 0 && !allowed.includes(base.protocol)
    ? { ...base, protocol: allowed[0] }
    : base;
}

/**
 * Normalize only configured slots when state is hydrated from electron-store.
 * Missing slots must stay missing so opening Settings does not silently create
 * every printer type, while stale/invalid saved values cannot survive behind a
 * select that merely renders the first allowed protocol.
 */
export function normalizePrintersConfig(printers?: PrintersConfig): PrintersConfig {
  const normalized: PrintersConfig = {};
  for (const [printerType, saved] of Object.entries(printers || {})) {
    if (saved) {
      normalized[printerType as PrinterType] = sanitizePrinterConfigForPersistence(printerType, saved);
    }
  }
  return normalized;
}

/**
 * Clamp persisted values to the constructor invariants, not merely the HTML
 * input attributes. Controlled inputs can temporarily hold blank/out-of-range
 * values for longer than the 600ms autosave debounce.
 */
export function sanitizePrinterConfigForPersistence(
  printerType: string,
  saved: PrinterConfig,
): PrinterConfig {
  const config = resolvePrinterConfigForType(printerType, saved);
  const isFabricTag = printerType === PrinterType.FABRIC_TAG;
  const isLabel = printerType === PrinterType.LABEL || isFabricTag;
  if (!isLabel) return config;

  const labelWidth = clampFinite(
    config.labelWidth,
    MIN_LABEL_DIMENSION_MM,
    MAX_LABEL_DIMENSION_MM,
    isFabricTag ? 20 : 50,
  );
  const labelHeight = clampFinite(
    config.labelHeight,
    MIN_LABEL_DIMENSION_MM,
    MAX_LABEL_DIMENSION_MM,
    isFabricTag ? 60 : 30,
  );
  // `paperWidth` is the backend field while `labelWidth` is what the local
  // formatter consumes. Keep the aliases identical for label-media slots so
  // a local 25mm edit cannot be PUT as a stale 20mm server width and then be
  // reverted by the next refresh.
  const sanitized: PrinterConfig = {
    ...config,
    labelWidth,
    labelHeight,
    paperWidth: labelWidth,
  };

  if (config.protocol === 'TSPL') {
    sanitized.labelGapMm = clampFinite(
      config.labelGapMm,
      0,
      MAX_TSPL_GAP_MM,
      isFabricTag ? 0 : 2,
    );
    sanitized.printSpeed = clampFinite(config.printSpeed, 1, 12, isFabricTag ? 2 : 3);
    sanitized.printDensity = clampFinite(config.printDensity, 0, 15, isFabricTag ? 12 : 10);
    sanitized.labelOriginInsetMm = clampFinite(
      config.labelOriginInsetMm,
      0,
      maxLabelOriginInsetMm(labelWidth),
      0,
    );
  }

  return sanitized;
}

export function sanitizePrintersConfigForPersistence(printers?: PrintersConfig): PrintersConfig {
  const sanitized: PrintersConfig = {};
  for (const [printerType, config] of Object.entries(printers || {})) {
    if (config) {
      sanitized[printerType as PrinterType] = sanitizePrinterConfigForPersistence(printerType, config);
    }
  }
  return sanitized;
}

/**
 * Apply one UI edit to the same normalized config that the card displays.
 * Storing against the generic THERMAL defaults while rendering normalized
 * TSPL values made a fresh FABRIC_TAG card look valid but autosave invalid.
 */
export function updatePrinterConfigState(
  previous: PrintersConfig,
  printerType: string,
  updates: Partial<PrinterConfig>,
): PrintersConfig {
  const nextConfig = {
    ...resolvePrinterConfigForType(printerType, previous[printerType as PrinterType]),
    ...updates,
  };
  return {
    ...previous,
    [printerType]: nextConfig,
  };
}
