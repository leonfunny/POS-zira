import {
  CARE_SYMBOLS,
  FABRIC_TAG_EXCLUSIVE_CARE_SYMBOL_GROUPS,
  FABRIC_TAG_LIMITS,
  FABRIC_TAG_RASTER_MIME_TYPES,
  isCareSymbol,
  type BarcodeType,
  type CareSymbol,
  type FabricTagData,
  type FabricTagRasterMime,
} from '../../../shared/types';
import { readRasterImageDimensions } from '../../../shared/fabric-tag-image';

const BARCODE_TYPES = ['AUTO', 'CODE128', 'EAN13', 'QR'] as const satisfies readonly BarcodeType[];
const FABRIC_TAG_LAYOUTS = ['default', 'care-first'] as const;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_LOGO_DATA_URL_LENGTH = 32 + Math.ceil(FABRIC_TAG_LIMITS.logoBytes / 3) * 4;
const RASTER_LOGO_DATA_URL = /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i;

export class FabricTagInputError extends TypeError {
  readonly failureClass = 'FINAL' as const;

  constructor(field: string, expected: string, context = 'fabric tag') {
    super(`Invalid ${context} ${field}: expected ${expected}`);
    this.name = 'FabricTagInputError';
  }
}

export class FabricTagPrintBusyError extends Error {
  /** No renderer or spooler work started for the rejected request. */
  readonly failureClass = 'SAFE_BEFORE_PRINT' as const;

  constructor() {
    super('Fabric tag printer is busy with another print job');
    this.name = 'FabricTagPrintBusyError';
  }
}

function invalid(field: string, expected: string, context?: string): never {
  throw new FabricTagInputError(field, expected, context);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse one bounded, single-line text field shared by templates and jobs. */
export function parseFabricTagText(
  value: unknown,
  field: string,
  maximum: number,
  options: { context?: string; required?: boolean } = {},
): string | null {
  if (value == null) {
    if (options.required) invalid(field, 'a string', options.context);
    return null;
  }
  if (typeof value !== 'string') invalid(field, 'a string or null', options.context);
  const text = value.trim();
  if (options.required && !text) invalid(field, 'a non-empty string', options.context);
  if (text.length > maximum) invalid(field, `at most ${maximum} characters`, options.context);
  if (CONTROL_CHARACTERS.test(text)) invalid(field, 'single-line text without control characters', options.context);
  return text;
}

/** Validate, bound, whitelist, and deduplicate care-symbol input. */
export function parseFabricTagCareSymbols(
  value: unknown,
  context = 'fabric tag',
): CareSymbol[] {
  if (value == null) return [];
  if (!Array.isArray(value)) invalid('careSymbols', 'an array', context);
  if (value.length > FABRIC_TAG_LIMITS.careSymbols) {
    invalid('careSymbols', `at most ${FABRIC_TAG_LIMITS.careSymbols} entries`, context);
  }
  // Materialise sparse slots so Array#every cannot skip them.
  const symbols = Array.from(value);
  if (!symbols.every(isCareSymbol)) {
    invalid('careSymbols', 'only supported care symbols', context);
  }
  const deduplicated = [...new Set(symbols)] as CareSymbol[];
  for (const group of FABRIC_TAG_EXCLUSIVE_CARE_SYMBOL_GROUPS) {
    const selected = group.filter((symbol) => deduplicated.includes(symbol));
    if (selected.length > 1) {
      invalid(
        'careSymbols',
        `at most one symbol from the ${group.join('/')} group`,
        context,
      );
    }
  }
  return deduplicated;
}

export interface ParsedFabricTagLogo {
  dataUrl: string;
  mimeType: FabricTagRasterMime;
  decodedBytes: number;
  width: number;
  height: number;
}

/**
 * Validate a raster logo before Chromium sees it.
 *
 * The encoded-length check runs before the regular expression or base64
 * allocation. Dimensions are then read from bounded header bytes, not by an
 * image decoder, so a compressed bomb is rejected before BrowserWindow exists.
 */
export function parseFabricTagLogoDataUrl(
  value: unknown,
  context = 'fabric tag',
): ParsedFabricTagLogo | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    invalid('logoDataUrl', 'a raster image data URL or null', context);
  }
  if (value.length > MAX_LOGO_DATA_URL_LENGTH) {
    invalid('logoDataUrl', `at most ${FABRIC_TAG_LIMITS.logoBytes} decoded bytes`, context);
  }

  const match = RASTER_LOGO_DATA_URL.exec(value);
  if (!match || match[2].length === 0 || match[2].length % 4 !== 0) {
    invalid('logoDataUrl', 'a base64 PNG, JPEG, GIF, or WebP data URL', context);
  }
  const mimeType = match[1].toLowerCase() as FabricTagRasterMime;
  if (!(FABRIC_TAG_RASTER_MIME_TYPES as readonly string[]).includes(mimeType)) {
    invalid('logoDataUrl', 'a base64 PNG, JPEG, GIF, or WebP data URL', context);
  }

  const decoded = Buffer.from(match[2], 'base64');
  if (decoded.byteLength === 0 || decoded.byteLength > FABRIC_TAG_LIMITS.logoBytes) {
    invalid('logoDataUrl', `at most ${FABRIC_TAG_LIMITS.logoBytes} decoded bytes`, context);
  }
  let width: number;
  let height: number;
  try {
    ({ width, height } = readRasterImageDimensions(decoded, mimeType));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    invalid('logoDataUrl', `a valid raster image (${detail})`, context);
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    invalid('logoDataUrl', 'an image with positive integer dimensions', context);
  }
  if (width > FABRIC_TAG_LIMITS.logoMaxDimension || height > FABRIC_TAG_LIMITS.logoMaxDimension) {
    invalid(
      'logoDataUrl',
      `dimensions no larger than ${FABRIC_TAG_LIMITS.logoMaxDimension}×${FABRIC_TAG_LIMITS.logoMaxDimension}`,
      context,
    );
  }
  if (width * height > FABRIC_TAG_LIMITS.logoMaxPixels) {
    invalid('logoDataUrl', `at most ${FABRIC_TAG_LIMITS.logoMaxPixels} decoded pixels`, context);
  }

  return { dataUrl: value, mimeType, decodedBytes: decoded.byteLength, width, height };
}

function optionalBoolean(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') invalid(field, 'a boolean');
  return value;
}

function optionalFiniteInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value == null) return undefined;
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    invalid(field, `a finite integer from ${minimum} to ${maximum}`);
  }
  return value;
}

/** Authoritative main-process parser for renderer IPC and remote print jobs. */
export function parseFabricTagData(value: unknown): FabricTagData {
  if (!isRecord(value)) invalid('payload', 'an object');

  const brandName = parseFabricTagText(
    value.brandName,
    'brandName',
    FABRIC_TAG_LIMITS.brandName,
  ) ?? '';
  const logo = parseFabricTagLogoDataUrl(value.logoDataUrl);
  if (!brandName && !logo) {
    invalid('payload', 'a brandName or raster logoDataUrl');
  }

  const size = parseFabricTagText(value.size, 'size', FABRIC_TAG_LIMITS.size) ?? undefined;
  const composition = parseFabricTagText(
    value.composition,
    'composition',
    FABRIC_TAG_LIMITS.composition,
  ) ?? undefined;
  const careSymbols = parseFabricTagCareSymbols(value.careSymbols);
  const careText = parseFabricTagText(
    value.careText,
    'careText',
    FABRIC_TAG_LIMITS.careText,
  ) ?? undefined;
  const barcode = parseFabricTagText(
    value.barcode,
    'barcode',
    FABRIC_TAG_LIMITS.barcode,
  ) ?? undefined;
  const currency = parseFabricTagText(
    value.currency,
    'currency',
    FABRIC_TAG_LIMITS.currency,
  ) ?? undefined;

  let barcodeType: BarcodeType | undefined;
  if (value.barcodeType != null) {
    if (
      typeof value.barcodeType !== 'string'
      || !(BARCODE_TYPES as readonly string[]).includes(value.barcodeType)
    ) {
      invalid('barcodeType', `one of ${BARCODE_TYPES.join(', ')}`);
    }
    barcodeType = value.barcodeType as BarcodeType;
  }
  if (barcodeType === 'EAN13' && !/^\d{13}$/.test(barcode || '')) {
    invalid('barcode', 'exactly 13 digits when barcodeType is EAN13');
  }
  if (barcodeType && !barcode) invalid('barcode', 'a non-empty value when barcodeType is set');

  const useQrCode = optionalBoolean(value.useQrCode, 'useQrCode');
  if (useQrCode && !barcode) invalid('barcode', 'a non-empty value when useQrCode is true');

  const priceGrosze = optionalFiniteInteger(
    value.priceGrosze,
    'priceGrosze',
    0,
    FABRIC_TAG_LIMITS.priceGrosze,
  );
  const quantity = optionalFiniteInteger(
    value.quantity,
    'quantity',
    1,
    FABRIC_TAG_LIMITS.quantity,
  );
  if (quantity === undefined) invalid('quantity', 'a required finite integer');

  let layout: NonNullable<FabricTagData['layout']> = 'default';
  if (value.layout != null) {
    if (
      typeof value.layout !== 'string'
      || !(FABRIC_TAG_LAYOUTS as readonly string[]).includes(value.layout)
    ) {
      invalid('layout', `one of ${FABRIC_TAG_LAYOUTS.join(', ')}`);
    }
    layout = value.layout as NonNullable<FabricTagData['layout']>;
  }

  return {
    brandName,
    logoDataUrl: logo?.dataUrl,
    size,
    composition,
    careSymbols: careSymbols.length ? careSymbols : undefined,
    careText,
    barcode,
    barcodeType,
    useQrCode,
    priceGrosze,
    currency,
    layout,
    quantity,
  };
}

/**
 * Single-flight guard used by HardwareModule's shared IPC/socket print path.
 * A second request fails before the expensive rasteriser or RAW spooler runs.
 */
export class FabricTagPrintGate {
  private inFlight = false;

  /** Share one printer single-flight boundary with pre-rendered artwork. */
  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.inFlight) throw new FabricTagPrintBusyError();
    this.inFlight = true;
    try {
      return await operation();
    } finally {
      this.inFlight = false;
    }
  }

  async run<T>(
    input: unknown,
    operation: (data: FabricTagData) => Promise<T>,
  ): Promise<T> {
    const data = parseFabricTagData(input);
    return this.runExclusive(() => operation(data));
  }
}

export { CARE_SYMBOLS, FABRIC_TAG_LIMITS };
