import * as path from 'path';
import type {
  ProductAdminCapabilities,
  ProductAdminMainImageUploadInput,
  ProductAdminReceiveStockInput,
  ProductAdminVariant,
} from '../../shared/types';
import type { ProductVariantRow } from '../database/repos/product-repo';

export const PRODUCT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const PRODUCT_ADMIN_PURCHASE_COST_FIELDS = [
  'purchasePrice',
  'purchasePriceGrosze',
  'unitCost',
  'unitCostGrosze',
  'purchase_price',
  'purchase_price_grosze',
  'unit_cost',
  'unit_cost_grosze',
] as const;

const PRODUCT_IMAGE_MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function inputError(message: string, code: string, field?: string): Error {
  const error = new Error(message) as Error & { code?: string; field?: string };
  error.code = code;
  error.field = field;
  return error;
}

function redactPurchaseCostFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPurchaseCostFields);
  if (!value || typeof value !== 'object') return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if ((PRODUCT_ADMIN_PURCHASE_COST_FIELDS as readonly string[]).includes(key)) continue;
    redacted[key] = redactPurchaseCostFields(nestedValue);
  }
  return redacted;
}

/**
 * Product-admin permissions are field-level: a role may mutate stock or products
 * without being allowed to see purchase cost. Keep that boundary in main even if
 * a backend response accidentally includes protected fields.
 */
export function redactProductAdminPurchaseData<T>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const source = data as Record<string, unknown>;
  const redacted: Record<string, unknown> = { ...source };
  if (Object.prototype.hasOwnProperty.call(source, 'variant')) {
    redacted.variant = redactPurchaseCostFields(source.variant);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'template')) {
    redacted.template = redactPurchaseCostFields(source.template);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'product')) {
    redacted.product = redactPurchaseCostFields(source.product);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'receipt')) {
    redacted.receipt = redactPurchaseCostFields(source.receipt);
  }
  if (Array.isArray(source.items)) {
    redacted.items = source.items.map(redactPurchaseCostFields);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'details')) {
    redacted.details = redactPurchaseCostFields(source.details);
  }
  return redacted as T;
}

type ProductAdminNullableMirrorFields = Pick<
  ProductVariantRow,
  | 'template_id'
  | 'sku'
  | 'barcode'
  | 'category_id'
  | 'sale_unit'
  | 'sell_by'
  | 'name_translations'
>;

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

interface ProductAdminSessionConfig {
  serverUrl?: unknown;
  salonSlug?: unknown;
  salonCode?: unknown;
  agentId?: unknown;
}

export interface ProductAdminSessionContext {
  readonly token: string;
  readonly serverUrl: string;
  readonly salonSlug: string;
  readonly salonCode: string;
  readonly agentId: string;
}

function productAdminContextValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function captureProductAdminSessionContext(
  token: string | null | undefined,
  config: ProductAdminSessionConfig,
): ProductAdminSessionContext {
  return Object.freeze({
    token: typeof token === 'string' ? token : '',
    serverUrl: productAdminContextValue(config?.serverUrl),
    salonSlug: productAdminContextValue(config?.salonSlug),
    salonCode: productAdminContextValue(config?.salonCode),
    agentId: productAdminContextValue(config?.agentId),
  });
}

export function isProductAdminSessionContextCurrent(
  expected: ProductAdminSessionContext,
  token: string | null | undefined,
  config: ProductAdminSessionConfig,
): boolean {
  const current = captureProductAdminSessionContext(token, config);
  return current.token === expected.token
    && current.serverUrl === expected.serverUrl
    && current.salonSlug === expected.salonSlug
    && current.salonCode === expected.salonCode
    && current.agentId === expected.agentId;
}

function validIsoRevisionToken(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12
    || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z') {
    const [zoneHour, zoneMinute] = zone.slice(1).split(':').map(Number);
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function requireProductAdminExpectedUpdatedAt(
  capabilities: Pick<ProductAdminCapabilities, 'supportsOptimisticConcurrency'>,
  value: unknown,
): string | undefined {
  const expectedUpdatedAt = typeof value === 'string' ? value.trim() : '';
  if (capabilities.supportsOptimisticConcurrency !== true) {
    return expectedUpdatedAt || undefined;
  }
  if (!validIsoRevisionToken(expectedUpdatedAt)) {
    const error = new Error('missing-or-invalid-product-revision') as Error & {
      code?: string;
      status?: number;
      field?: string;
    };
    error.code = 'STALE_PRODUCT';
    error.status = 409;
    error.field = 'expectedUpdatedAt';
    throw error;
  }
  return expectedUpdatedAt;
}

/**
 * Product-admin responses from older servers may omit newer fields, while a
 * current server uses an explicit null to clear them. Preserve that distinction
 * when updating the local mirror.
 */
export function mergeProductAdminNullableMirrorFields(
  variant: Partial<ProductAdminVariant>,
  existing?: Partial<ProductVariantRow> | null,
): ProductAdminNullableMirrorFields {
  let nameTranslations = existing?.name_translations ?? null;
  if (hasOwn(variant, 'nameTranslations')) {
    if (variant.nameTranslations == null) {
      nameTranslations = null;
    } else {
      try {
        nameTranslations = JSON.stringify(variant.nameTranslations);
      } catch {
        // Keep the last valid local value if a malformed runtime object cannot
        // be encoded. The backend payload remains authoritative on next sync.
      }
    }
  }

  let sellBy = existing?.sell_by ?? null;
  if (hasOwn(variant, 'sellBy')) {
    if (variant.sellBy == null) {
      sellBy = null;
    } else {
      const normalized = String(variant.sellBy).trim().toUpperCase();
      if (normalized === 'PIECE' || normalized === 'WEIGHT') sellBy = normalized;
    }
  }

  return {
    template_id: hasOwn(variant, 'templateId')
      ? variant.templateId ?? null
      : existing?.template_id ?? null,
    sku: hasOwn(variant, 'sku') ? variant.sku ?? null : existing?.sku ?? null,
    barcode: hasOwn(variant, 'barcode') ? variant.barcode ?? null : existing?.barcode ?? null,
    category_id: hasOwn(variant, 'categoryId')
      ? variant.categoryId ?? null
      : existing?.category_id ?? null,
    sale_unit: hasOwn(variant, 'saleUnit')
      ? variant.saleUnit ?? null
      : existing?.sale_unit ?? null,
    sell_by: sellBy,
    name_translations: nameTranslations,
  };
}

function productAdminRevision(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const revision = Date.parse(value);
  return Number.isFinite(revision) ? revision : null;
}

/**
 * A mutation response may arrive after a newer catalog delta has already been
 * mirrored. Apply the response as one canonical unit only when its revision is
 * at least as new as the local row. Unversioned responses may create a missing
 * row, but must not overwrite an existing revision.
 */
export function shouldApplyProductAdminVariantMirror(
  variant: Partial<ProductAdminVariant>,
  existing?: Partial<ProductVariantRow> | null,
): boolean {
  if (!existing) return true;

  const incomingRevision = productAdminRevision(variant.updatedAt);
  if (incomingRevision === null) return false;

  const existingRevision = productAdminRevision(existing.updated_at);
  return existingRevision === null || incomingRevision >= existingRevision;
}

export function decodeProductImageDataUrl(payload: ProductAdminMainImageUploadInput): {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
} {
  const dataUrl = typeof payload?.dataUrl === 'string' ? payload.dataUrl.trim() : '';
  if (!dataUrl || dataUrl.length > Math.ceil(PRODUCT_IMAGE_MAX_BYTES * 4 / 3) + 256) {
    throw inputError(
      dataUrl ? 'image-too-large' : 'invalid-image-data',
      dataUrl ? 'IMAGE_TOO_LARGE' : 'INVALID_IMAGE',
      'dataUrl',
    );
  }

  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(dataUrl);
  const mimeType = match?.[1]?.toLowerCase() ?? '';
  const extension = PRODUCT_IMAGE_MIME_EXTENSION[mimeType];
  if (!match || !extension || (payload.mimeType && payload.mimeType !== mimeType)) {
    throw inputError('unsupported-image-type', 'INVALID_IMAGE', 'mimeType');
  }

  const base64 = match[2].replace(/[\r\n]/g, '');
  if (base64.length % 4 !== 0) {
    throw inputError('invalid-image-data', 'INVALID_IMAGE', 'dataUrl');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.length > PRODUCT_IMAGE_MAX_BYTES) {
    throw inputError(
      bytes.length > PRODUCT_IMAGE_MAX_BYTES ? 'image-too-large' : 'invalid-image-data',
      bytes.length > PRODUCT_IMAGE_MAX_BYTES ? 'IMAGE_TOO_LARGE' : 'INVALID_IMAGE',
      'dataUrl',
    );
  }

  const matchesMagic = mimeType === 'image/jpeg'
    ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mimeType === 'image/png'
      ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : bytes.length >= 12
        && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
        && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!matchesMagic) {
    throw inputError('image-content-type-mismatch', 'INVALID_IMAGE', 'dataUrl');
  }

  const requestedName = String(payload.fileName ?? '').trim();
  const safeStem = path.basename(requestedName, path.extname(requestedName))
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'product-image';
  return { bytes, mimeType, fileName: `${safeStem}.${extension}` };
}

export function normalizeProductReceiptInput(
  payload: ProductAdminReceiveStockInput,
): ProductAdminReceiveStockInput {
  const quantity = payload?.quantity;
  if (typeof quantity !== 'number') {
    throw inputError('invalid-receipt-quantity', 'INVALID_STOCK_QUANTITY', 'quantity');
  }
  const quantityMillis = quantity * 1000;
  if (!Number.isFinite(quantity)
    || quantity < 0.001
    || quantity > 9_999_999
    || Math.abs(quantityMillis - Math.round(quantityMillis)) > 1e-8) {
    throw inputError('invalid-receipt-quantity', 'INVALID_STOCK_QUANTITY', 'quantity');
  }

  let unitCostGrosze: number | undefined;
  if (payload?.unitCostGrosze !== null && payload?.unitCostGrosze !== undefined) {
    const cost = payload.unitCostGrosze;
    if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0) {
      throw inputError('invalid-receipt-unit-cost', 'INVALID_PRICE', 'unitCostGrosze');
    }
    unitCostGrosze = cost;
  }

  const lotNumber = String(payload?.lotNumber ?? '').trim();
  if (lotNumber.length > 100) {
    throw inputError('invalid-lot-number', 'INVALID_LOT_NUMBER', 'lotNumber');
  }

  const expirationDate = String(payload?.expirationDate ?? '').trim();
  if (expirationDate) {
    const parsed = new Date(`${expirationDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expirationDate)
      || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== expirationDate) {
      throw inputError('invalid-expiration-date', 'INVALID_EXPIRATION_DATE', 'expirationDate');
    }
  }

  const reason = String(payload?.reason ?? '').trim();
  if (reason.length > 255) {
    throw inputError('invalid-receipt-reason', 'INVALID_REASON', 'reason');
  }

  const idempotencyKey = String(payload?.idempotencyKey ?? '').trim();
  if (!idempotencyKey || idempotencyKey.length > 80) {
    throw inputError('invalid-idempotency-key', 'IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey');
  }

  return {
    quantity,
    unitCostGrosze,
    lotNumber: lotNumber || undefined,
    expirationDate: expirationDate || undefined,
    reason: reason || undefined,
    expectedUpdatedAt: String(payload?.expectedUpdatedAt ?? '').trim() || undefined,
    idempotencyKey,
  };
}
