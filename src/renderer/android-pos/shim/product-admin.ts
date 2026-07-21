/**
 * product-admin.ts — the owner's product / stock / category admin surface for
 * the Android POS shim (E-PARITY-3).
 *
 * A faithful port of the Windows product-admin flow (api-client.ts
 * productAdminRequest :1586 + the operation wrappers :1716-2030; the IPC
 * envelope in pos.module.ts withProductAdminCapability :1728). ADMIN-ONLY — the
 * cashier flow never reaches it. Uses the STAFF JWT (Windows getSecureAuthToken,
 * pos.module.ts:1734 — NOT the pa_ key) + the salon-context headers, so it is
 * fully client-portable and needs no backend gate.
 *
 * Every method resolves to the same envelope the renderer's IPC layer returns:
 *   { ok: true, data } | { ok: false, error, code? }
 * — a thrown request maps its `.status`/`.code`/`.message` into that shape.
 *
 * Purchase-price redaction IS ported (defence-in-depth): when the token lacks
 * canViewPurchasePrice, cost fields are stripped from every response, exactly as
 * Windows does (redactProductAdminPurchaseData) — fail-safe (redact when the
 * capability is unknown/unfetchable).
 *
 * ─── Deliberate divergence from Windows (documented, server-authoritative) ───
 * No client-side PRE-FLIGHT capability gate. Windows fetches /capabilities and
 * refuses locally when a capability is off; here the SERVER enforces it and
 * returns the same `{ ok:false, code }` envelope on a rejected call. The renderer
 * still calls getCapabilities() to enable/disable its own UI.
 * The two multipart image uploads (main-image, category image) ARE supported:
 * the renderer sends the image as a base64 data URL, which the WebView decodes
 * to a Blob and posts as the 'image' multipart field — the same wire shape
 * Windows' main process builds from bytes.
 */

import type { PosApiClient } from '../port/api-client';
import type { ShimConfigStore } from './config-store';
import type { AgentConfig } from '../../../shared/types';

/**
 * Purchase (cost) price is field-level protected: a role may edit stock/products
 * without being allowed to SEE cost. Ported byte-for-byte from Windows
 * product-workspace-input.ts:18-102 (PRODUCT_ADMIN_PURCHASE_COST_FIELDS +
 * redactProductAdminPurchaseData) so the Sunmi hides cost from a token without
 * `canViewPurchasePrice`, even if a backend response includes the fields.
 */
const PURCHASE_COST_FIELDS: readonly string[] = [
  'purchasePrice', 'purchasePriceGrosze', 'unitCost', 'unitCostGrosze',
  'purchase_price', 'purchase_price_grosze', 'unit_cost', 'unit_cost_grosze',
];

function redactPurchaseCostFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPurchaseCostFields);
  if (!value || typeof value !== 'object') return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PURCHASE_COST_FIELDS.includes(key)) continue;
    redacted[key] = redactPurchaseCostFields(nested);
  }
  return redacted;
}

function redactProductAdminPurchaseData<T>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const source = data as Record<string, unknown>;
  const redacted: Record<string, unknown> = { ...source };
  for (const key of ['variant', 'template', 'product', 'receipt', 'details']) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      redacted[key] = redactPurchaseCostFields(source[key]);
    }
  }
  if (Array.isArray(source.items)) redacted.items = source.items.map(redactPurchaseCostFields);
  return redacted as T;
}

/** The IPC envelope the renderer expects for every product-admin call. */
export type ProductAdminResult =
  | { ok: true; data: any }
  | { ok: false; error: string; code?: string };

export interface ProductAdminSurface {
  getCapabilities(): Promise<{ ok: boolean; capabilities?: any; error?: string }>;
  createProduct(payload: any): Promise<ProductAdminResult>;
  updateVariant(variantId: string, payload: any): Promise<ProductAdminResult>;
  deactivateVariant(variantId: string, payload: any): Promise<ProductAdminResult>;
  adjustStock(variantId: string, payload: any): Promise<ProductAdminResult>;
  getVariant(variantId: string): Promise<ProductAdminResult>;
  listLots(variantId: string): Promise<ProductAdminResult>;
  receiveStock(variantId: string, payload: any): Promise<ProductAdminResult>;
  listCategories(): Promise<ProductAdminResult>;
  createCategory(payload: any): Promise<ProductAdminResult>;
  updateCategory(categoryId: string, payload: any): Promise<ProductAdminResult>;
  updateCategoryOrder(updates: any): Promise<ProductAdminResult>;
  deleteCategory(categoryId: string, payload: any): Promise<ProductAdminResult>;
  // Multipart image uploads (data URL -> Blob -> 'image' field).
  uploadMainImage(variantId: string, payload: any): Promise<ProductAdminResult>;
  uploadCategoryImage(categoryId: string, payload: any): Promise<ProductAdminResult>;
}

export interface ProductAdminSurfaceDeps {
  client: PosApiClient;
  configStore: ShimConfigStore;
}

/**
 * Decode a base64 data URL (`data:<mime>;base64,<payload>`) into a Blob. The
 * renderer sends images as a data URL (ProductAdminMainImageUploadInput.dataUrl);
 * Windows' main process decodes to bytes and builds a multipart form — the
 * WebView does the same with atob + Blob. `mimeOverride` wins when provided.
 * Returns null when the input is not a decodable base64 data URL.
 */
function dataUrlToBlob(dataUrl: string, mimeOverride?: string): Blob | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl ?? '');
  if (!match) return null;
  const [, mime, isBase64, payload] = match;
  const type = mimeOverride || mime || 'application/octet-stream';
  try {
    if (isBase64) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type });
    }
    return new Blob([decodeURIComponent(payload)], { type });
  } catch {
    return null;
  }
}

const BAD_IMAGE: ProductAdminResult = {
  ok: false,
  error: 'invalid image data url',
  code: 'INVALID_IMAGE',
};

export function createProductAdminSurface(deps: ProductAdminSurfaceDeps): ProductAdminSurface {
  const { client, configStore } = deps;

  /** Salon-context headers Windows reads from config (salonCode + agentId). */
  const context = (): { salonCode?: string; agentId?: string } => {
    const cfg = configStore.getRawConfig() as AgentConfig & { salonCode?: string; agentId?: string };
    const salonCode = String(cfg.salonCode ?? '').trim() || undefined;
    const agentId = String(cfg.agentId ?? '').trim() || undefined;
    return { salonCode, agentId };
  };

  // Capabilities gate for purchase-price redaction. Fetched once per surface
  // (shared with getCapabilities) — leaner than Windows' per-call fetch, same
  // safety. FAIL-SAFE: an unfetchable capabilities response redacts (matches
  // Windows' canViewPurchasePrice:false default on error, pos.module.ts:1440).
  let capsPromise: Promise<any | null> | null = null;
  const loadCaps = (): Promise<any | null> => {
    if (!capsPromise) {
      capsPromise = client.productAdminRequest<any>('GET', '/capabilities', context()).catch(() => null);
    }
    return capsPromise;
  };
  const canSeePurchasePrice = async (): Promise<boolean> => {
    const caps = await loadCaps();
    return caps?.supportsPurchasePrice === true && caps?.canViewPurchasePrice === true;
  };

  /** Run a product-admin request and normalize it into the IPC envelope, hiding
   *  purchase cost from a token that lacks canViewPurchasePrice. */
  const run = async <T>(fn: () => Promise<T>): Promise<ProductAdminResult> => {
    try {
      const data = await fn();
      const safe = (await canSeePurchasePrice()) ? data : redactProductAdminPurchaseData(data);
      return { ok: true, data: safe };
    } catch (e: any) {
      // Map the thrown request envelope (status/code/message) to { ok:false }.
      const code = typeof e?.code === 'string' ? e.code : undefined;
      return { ok: false, error: e?.message || String(e), ...(code ? { code } : {}) };
    }
  };

  /** Pull the idempotency key + expected-updated-at off a payload, leaving body. */
  const split = (payload: any): { body: any; idempotencyKey?: string; expectedUpdatedAt?: string } => {
    const { idempotencyKey, expectedUpdatedAt, ...body } = payload ?? {};
    return { body, idempotencyKey, expectedUpdatedAt };
  };

  return {
    async getCapabilities() {
      const capabilities = await loadCaps();
      return capabilities !== null
        ? { ok: true, capabilities }
        : { ok: false, error: 'capabilities-unavailable' };
    },

    createProduct(payload) {
      const { body, idempotencyKey } = split(payload);
      // Windows drops a `retailPrice` alias before POST (:1760); do the same.
      const { retailPrice: _drop, ...clean } = body ?? {};
      return run(() => client.productAdminRequest('POST', '/products', { ...context(), body: clean, idempotencyKey }));
    },

    updateVariant(variantId, payload) {
      const { body, expectedUpdatedAt } = split(payload);
      return run(() => client.productAdminRequest(
        'PATCH', `/variants/${encodeURIComponent(variantId)}`, { ...context(), body, expectedUpdatedAt },
      ));
    },

    deactivateVariant(variantId, payload) {
      const { body, expectedUpdatedAt } = split(payload);
      return run(() => client.productAdminRequest(
        'POST', `/variants/${encodeURIComponent(variantId)}/deactivate`, { ...context(), body, expectedUpdatedAt },
      ));
    },

    adjustStock(variantId, payload) {
      const { body, idempotencyKey } = split(payload);
      return run(() => client.productAdminRequest(
        'POST', `/variants/${encodeURIComponent(variantId)}/stock-adjustments`, { ...context(), body, idempotencyKey },
      ));
    },

    getVariant(variantId) {
      return run(() => client.productAdminRequest('GET', `/variants/${encodeURIComponent(variantId)}`, context()));
    },

    listLots(variantId) {
      return run(() => client.productAdminRequest('GET', `/variants/${encodeURIComponent(variantId)}/lots`, context()));
    },

    receiveStock(variantId, payload) {
      const { body, idempotencyKey } = split(payload);
      return run(() => client.productAdminRequest(
        'POST', `/variants/${encodeURIComponent(variantId)}/receipts`, { ...context(), body, idempotencyKey },
      ));
    },

    listCategories() {
      return run(() => client.productAdminRequest('GET', '/categories', context()));
    },

    createCategory(payload) {
      const { body, idempotencyKey } = split(payload);
      return run(() => client.productAdminRequest('POST', '/categories', { ...context(), body, idempotencyKey }));
    },

    updateCategory(categoryId, payload) {
      const { body, expectedUpdatedAt } = split(payload);
      return run(() => client.productAdminRequest(
        'PATCH', `/categories/${encodeURIComponent(categoryId)}`, { ...context(), body, expectedUpdatedAt },
      ));
    },

    updateCategoryOrder(updates) {
      // Windows PATCHes /categories/order with the updates array (:1929).
      const body = Array.isArray(updates) ? { updates } : updates;
      return run(() => client.productAdminRequest('PATCH', '/categories/order', { ...context(), body }));
    },

    deleteCategory(categoryId, payload) {
      const { expectedUpdatedAt } = split(payload);
      return run(() => client.productAdminRequest(
        'DELETE', `/categories/${encodeURIComponent(categoryId)}`, { ...context(), expectedUpdatedAt },
      ));
    },

    uploadMainImage(variantId, payload) {
      return uploadImage(`/variants/${encodeURIComponent(variantId)}/main-image`, payload);
    },
    uploadCategoryImage(categoryId, payload) {
      return uploadImage(`/categories/${encodeURIComponent(categoryId)}/image`, payload);
    },
  };

  /** Shared image-upload path: data URL -> Blob -> multipart 'image' field. */
  function uploadImage(path: string, payload: any): Promise<ProductAdminResult> {
    const blob = dataUrlToBlob(String(payload?.dataUrl ?? ''), payload?.mimeType);
    if (!blob) return Promise.resolve(BAD_IMAGE);
    const form = new FormData();
    // Windows appends the field as 'image' with the file name (api-client.ts:1835).
    form.append('image', blob, String(payload?.fileName ?? 'image'));
    return run(() => client.productAdminMultipartRequest(path, form, {
      ...context(),
      expectedUpdatedAt: payload?.expectedUpdatedAt,
    }));
  }
}
