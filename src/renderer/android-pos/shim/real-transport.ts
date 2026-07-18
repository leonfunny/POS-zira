/**
 * RealShimTransport — a ShimTransport backed by the S3 PosApiClient (fetch) +
 * the S4 TokenStore (Keystore) + the S5 SQL.js catalog mirror.
 *
 * Packet S6+S7 of the Android parity port — see
 * docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md (§5, S6+S7) and the method
 * contract in docs/android-pos/SHIM_CONTRACT_S1.md (§1, §2.A/B/D/E, §7).
 *
 * This swaps the S2 SYNTHETIC fakes for real behavior on exactly the auth +
 * catalog + sync.products ports (CASH checkout stays S2 fakes until S8). The
 * shim surface the renderer sees never changes: installShim({ transport })
 * injects this object; every other STUB/LATER/EXCLUDE return stays as S1
 * specifies (stubs.ts only delegates when a transport method is present).
 *
 * ─── Source parity ────────────────────────────────────────────────────────
 * Windows behavior is the reference (PARITY_PORT_PLAN §2 — "Where Windows is
 * quirky, Android is identically quirky"). The auth-user + salon resolution,
 * the refresh model, the catalog-sync cursor loop, and the per-row grosze /
 * category normalization below are COPIED from the Windows main process, not
 * redesigned. Citations reference the Windows source of truth:
 *   - login AuthUser build:        src/main/modules/auth.module.ts:777-795
 *   - /auth/me → AuthUser mapping: src/main/network/auth-get-user.ts:49-61
 *   - salon id/name/slug resolve:  src/main/modules/auth.module.ts:170-183
 *   - refresh endpoint transport:  src/main/network/auth-refresh.ts:103-165
 *   - catalog sync cursor loop:    src/main/sync/product-sync.ts:305-418
 *   - product row normalization:   src/main/network/api-client.ts:2339-2428
 *   - price → grosze helpers:      src/main/network/api-client.ts:2300-2338
 *   - category normalization:      src/main/network/api-client.ts:2232-2256
 *   - legacyCategoryImageUrl:      src/main/network/api-client.ts:494-500
 *   - unsafe-cursor predicate:     src/main/sync/product-sync.ts:151-168
 *
 * ─── Network boundary ─────────────────────────────────────────────────────
 * This module imports nothing from `src/main/**` and no Node/Electron module.
 * `fetch` is the only network primitive it uses — the cross-platform boundary
 * verifier allows `fetch` (and only `fetch`) in a shim graph (S6+S7); WebSocket
 * / XMLHttpRequest / the `pa_`-keyed socket the Windows agent opens stay
 * forbidden in every mode (plan §1 rail #1, S1 §2.B note).
 */

import type { AgentConfig, AuthUser } from '../../../shared/types';
import { PosApiClient, type TokenProvider } from '../../android-pos/port/api-client';
import type {
  ShimGetUserResult,
  ShimLoginResult,
  ShimPosCategory,
  ShimPosProduct,
  ShimTransport,
} from './transport';
import type { ShimConfigStore } from './config-store';
import type { TokenStore } from './token-store';
import { initAndroidDb, type AndroidDatabase, type AndroidDbInitOptions } from './db/db';
import { createProductRepo, type AndroidProductRow } from './db/product-repo';
import { createCategoryRepo, type AndroidCategoryRow } from './db/category-repo';
import { createSyncMeta } from './db/sync-meta';
import {
  buildBackendOrderItem,
  createOrderRepo,
  getLineSaleQuantity,
  getLineSaleUnit,
  getLineSellBy,
  getLineTotalGrosze,
} from './db/order-repo';

// ─── Backend base URL ──────────────────────────────────────────────────────

/** Production default — the same host the Windows app targets (auth.module.ts:753). */
const DEFAULT_API_URL = 'https://api.enail.pro';
/**
 * localStorage key a developer sets to repoint the shim at a DEV backend (e.g. a
 * Tailscale DEV box). Cleartext http is BLOCKED in the native WebView by the
 * Android network_security_config (the cap shell ships cleartext-permissive
 * OFF), so an http override only takes effect in a PLAIN browser during dev —
 * do NOT change the network security config. Unset → fall through to the
 * `apiUrl` config field, then the production default.
 */
const DEV_API_URL_STORAGE_KEY = 'zira.dev.apiUrl';

/**
 * Resolve the backend base URL (auth.module.ts:753 falls back to the same
 * default). Priority: localStorage dev override → `apiUrl` config field →
 * production default. Read once at transport construction (the host is stable
 * per salon; only a dev override changes it).
 */
function resolveApiUrl(configStore: ShimConfigStore): string {
  const g = globalThis as unknown as { localStorage?: { getItem(k: string): string | null } };
  const devOverride = g.localStorage?.getItem(DEV_API_URL_STORAGE_KEY);
  if (devOverride && devOverride.trim()) return devOverride.trim();

  const apiUrl = (configStore.getRawConfig() as AgentConfig & { apiUrl?: string }).apiUrl;
  if (apiUrl && apiUrl.trim()) return apiUrl.trim();

  return DEFAULT_API_URL;
}

// ─── Auth-user + salon resolution (copied from Windows) ────────────────────

/** ported from auth.module.ts:170-173. */
function resolveAuthSalonId(payload: any): string {
  const user = payload?.user ?? payload ?? {};
  return user.salonId || user.salon_id || user.salon?.id || payload?.salon?.id || '';
}

/** ported from auth.module.ts:175-178. */
function resolveAuthSalonName(payload: any, fallback?: string): string {
  const user = payload?.user ?? payload ?? {};
  return payload?.salon?.name || user.salon?.name || user.salonName || fallback || '';
}

/** ported from auth.module.ts:180-183. */
function resolveAuthSalonSlug(payload: any): string {
  const user = payload?.user ?? payload ?? {};
  return payload?.salon?.slug || user.salon?.slug || user.salonSlug || '';
}

/**
 * Build the AuthUser from a login response (auth.module.ts:777-781). The login
 * body carries `{ access_token, refresh_token?, user }`; the salon may be nested
 * under `result.salon` / `user.salon` / flat `salonId` — resolve defensively.
 */
function buildLoginAuthUser(result: any, fallbackSalonName?: string): AuthUser {
  const user = result?.user ?? {};
  return {
    id: user.id || user.sub || '',
    email: user.email || '',
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    role: user.role || '',
    salonId: resolveAuthSalonId(result),
    salonName: resolveAuthSalonName(result, fallbackSalonName),
  };
}

/** ported from auth-get-user.ts:49-61 — /auth/me raw → AuthUser. */
function resolveAuthUser(raw: any, defaultSalonName?: string): AuthUser {
  const user = raw?.user ?? raw ?? {};
  const fullName = user.fullName || user.full_name || '';
  return {
    id: user.id || user.sub || '',
    email: user.email || '',
    firstName: user.firstName || user.first_name || fullName.split(/\s+/)[0] || '',
    lastName: user.lastName || user.last_name || '',
    role: user.role || '',
    salonId: user.salonId || user.salon_id || user.salon?.id || raw?.salon?.id || '',
    salonName: raw?.salon?.name || user.salon?.name || user.salonName || defaultSalonName || '',
  };
}

// ─── Price → grosze + row normalization (copied from api-client.ts) ─────────

/** `v` is a present, non-empty value (api-client.ts:2300). */
function hasValue(v: unknown): boolean {
  return v !== null && v !== undefined && v !== '';
}

/** PLN decimal → integer grosze (api-client.ts:2301-2305). Null/NaN → 0. */
function toGrosze(v: unknown): number {
  if (!hasValue(v)) return 0;
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * A price that may already be grosze (api-client.ts:2306-2313). Heuristic: a
 * decimal separator → PLN (×100); else abs < 500 → assume PLN (×100), otherwise
 * treat as already-grosze. Keeps both wire formats safe at this boundary.
 */
function normalizePossiblyStoredPrice(v: unknown): number {
  if (!hasValue(v)) return 0;
  const raw = String(v).trim();
  const n = Number.parseFloat(raw.replace(',', '.'));
  if (!Number.isFinite(n)) return 0;
  if (/[.,]/.test(raw)) return Math.round(n * 100);
  return Math.abs(n) < 500 ? Math.round(n * 100) : Math.round(n);
}

interface PriceCandidate {
  value: unknown;
  stored?: boolean;
}

/**
 * Walk price candidates in priority order (api-client.ts:2321-2329); the first
 * yielding a POSITIVE grosze amount wins; 0 if none do. A `stored` candidate
 * (a backend field that may already be grosze) routes through
 * normalizePossiblyStoredPrice; a fresh PLN value routes through toGrosze.
 */
function firstPositivePrice(candidates: PriceCandidate[]): number {
  for (const { value, stored } of candidates) {
    const grosze = stored ? normalizePossiblyStoredPrice(value) : toGrosze(value);
    if (grosze > 0) return grosze;
  }
  return 0;
}

/** Normalize one backend product row into the Android PosProduct column subset
 *  (api-client.ts:2339-2428). The Android schema (S5 §2) stores only the
 *  PosProduct columns — it omits name_translations / price_gross / price_net /
 *  vat_amount / item_type / track_inventory / kiosk_* that the Windows mapper
 *  also emits. Search is name-only as a result (product-repo.ts divergence),
 *  so the Windows poisoned-translation guard (api-client.ts:2441-2462, which
 *  only nullifies name_translations) has nothing to operate on here and is
 *  not ported. */
function normalizeProductRow(item: any): AndroidProductRow | null {
  if (!item || !item.id) return null;
  const template = item.template ?? {};
  const retailGrosze = firstPositivePrice([
    { value: item.retailPrice },
    { value: item.retail_price, stored: true },
    { value: item.priceGross },
    { value: item.price_gross, stored: true },
    { value: item.price, stored: true },
    { value: template.retailPrice },
    { value: template.retail_price, stored: true },
    { value: template.priceGross },
    { value: template.price_gross, stored: true },
  ]);
  const name = item.name ?? template.name ?? '';
  return {
    id: item.id,
    template_id: item.templateId ?? item.template_id ?? template.id ?? null,
    name,
    sku: item.sku ?? null,
    barcode: item.barcode ?? null,
    retail_price: retailGrosze,
    category_id: template.categoryId ?? template.category_id ?? item.categoryId ?? item.category_id ?? null,
    image_url: item.imageUrl ?? item.image_url ?? null,
    in_stock: item.totalStockQty ?? item.total_stock_qty ?? item.in_stock ?? 0,
    available_qty: item.availableQty ?? item.available_qty ?? item.totalStockQty ?? item.total_stock_qty ?? item.in_stock ?? 0,
    // parseFloat(...) || 23 — NaN AND 0 fall back to the standard Polish rate (api-client.ts:2380).
    vat_rate: Number.parseFloat(template.taxRate ?? template.tax_rate ?? item.vat_rate) || 23,
    is_active: (item.isActive ?? item.is_active ?? true) ? 1 : 0,
    is_on_sale: (item.isOnSale ?? item.is_on_sale) ? 1 : 0,
    thumbnail_url: item.thumbnailUrl ?? item.thumbnail_url ?? null,
    sale_unit: item.saleUnit ?? item.sale_unit ?? template.baseUnit ?? template.base_unit ?? null,
    sell_by: item.sellBy ?? item.sell_by ?? template.sellBy ?? template.sell_by ?? 'PIECE',
    updated_at: item.canonicalUpdatedAt ?? item.canonical_updated_at ?? item.updatedAt ?? item.updated_at ?? null,
  };
}

/** ported from api-client.ts:494-500 — an icon string that is itself a URL. */
function legacyCategoryImageUrl(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return null;
  return /^(https?:)?\/\//i.test(normalized) || normalized.startsWith('/')
    ? normalized
    : null;
}

/**
 * Normalize one backend category row into the Android PosCategory column subset
 * (api-client.ts:2232-2256). kitchen_print is always null from the backend
 * (KSO visibility is device-local — Windows never overwrites it); the category
 * repo's COALESCE preserves any locally-known kitchen_print on upsert
 * (category-repo.ts). The Android schema omits name_translations and
 * kiosk_modifier_groups_json.
 */
function normalizeCategoryRow(cat: any): AndroidCategoryRow | null {
  if (!cat?.id || !cat?.name) return null;
  const icon = typeof cat.icon === 'string' ? cat.icon.trim() : '';
  const hasExplicitImageUrl = Object.prototype.hasOwnProperty.call(cat, 'imageUrl')
    || Object.prototype.hasOwnProperty.call(cat, 'image_url');
  const rawImageUrl = cat.imageUrl ?? cat.image_url;
  const imageUrl = hasExplicitImageUrl
    ? (typeof rawImageUrl === 'string' ? rawImageUrl.trim() || null : null)
    : legacyCategoryImageUrl(icon);
  return {
    id: cat.id,
    name: cat.name,
    image_url: imageUrl,
    icon: legacyCategoryImageUrl(icon) ? null : icon || null,
    color: cat.color ?? null,
    sort_order: cat.displayOrder ?? cat.sortOrder ?? cat.sort_order ?? 0,
    updated_at: cat.updatedAt ?? cat.updated_at ?? null,
    // Windows sends null so the repo COALESCE keeps the local KSO flag.
    kitchen_print: null,
  };
}

// ─── Order sync helpers (ported from src/main/sync/order-sync.ts) ──────────

/** Max transient sync attempts before shelving (order-sync.ts:11). */
const MAX_SYNC_ATTEMPTS = 5;

/** order-sync.ts:14-20 — business-rule rejections are never retried. */
const BUSINESS_ERROR_PATTERNS = [
  /insufficient stock/i,
  /stock.*not available/i,
  /price.*mismatch/i,
  /tender.*less than/i,
  /invalid.*product/i,
];

/** order-sync.ts:23-29. */
function classifyError(msg: string): { kind: 'business' | 'transient'; code?: string } {
  if (BUSINESS_ERROR_PATTERNS.some((p) => p.test(msg))) {
    if (/insufficient stock/i.test(msg)) return { kind: 'business', code: 'INSUFFICIENT_STOCK' };
    return { kind: 'business', code: 'BUSINESS_RULE' };
  }
  return { kind: 'transient' };
}

/** order-sync.ts:31-36. */
function getBackendOrderNumber(response: any): string | undefined {
  const direct = response?.orderNumber ?? response?.order_number;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const nested = response?.order?.orderNumber ?? response?.order?.order_number;
  return typeof nested === 'string' && nested.trim() ? nested : undefined;
}

/** order-sync.ts:38-44. */
function normalizePosLocalCreatedAt(value: string | null | undefined): string | undefined {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** order-sync.ts:187-191 — local payment method → backend enum. */
const PM_MAP: Record<string, string> = {
  CASH: 'CASH', CARD: 'CARD', BLIK: 'BLIK',
  TRANSFER: 'BANK_TRANSFER', BANK_TRANSFER: 'BANK_TRANSFER',
  CREDIT: 'CREDIT', INVOICE: 'BANK_TRANSFER',
};

/**
 * Build the CreateB2BPOSOrderDto from a local order row + items — ported
 * byte-for-byte from order-sync.ts:163-224. LOCAL rows are integer grosze;
 * the BACKEND DTO carries PLN decimals (/100) — the S1 §2.F trap.
 */
function buildOrderDto(order: any, items: any[]): Record<string, any> {
  const dto: Record<string, any> = {
    id: order.id, // idempotency key
    priceType: 'brutto',
    requiresInvoice: !!order.customer_nip,
    posLocalCreatedAt: normalizePosLocalCreatedAt(order.created_at),
    items: items
      .filter((item) => item.variant_id || item.id)
      .map((item) => buildBackendOrderItem(item)),
  };
  const tendersJson = order.payment_tenders;
  if (tendersJson) {
    try {
      const tenders = JSON.parse(tendersJson) as Array<{ method: string; amount: number }>;
      if (tenders.length > 0) {
        dto.tenders = tenders.map((t) => ({ method: PM_MAP[t.method] || t.method, amount: t.amount / 100 }));
      }
    } catch { /* single method fallback below */ }
  }
  if (order.payment_method) dto.paymentMethod = PM_MAP[order.payment_method] || 'CASH';
  if (order.staff_id) dto.staffId = order.staff_id;
  if (order.staff_name) dto.staffName = order.staff_name;
  if (order.shift_id) dto.shiftId = order.shift_id;
  if (order.customer_id) dto.customerId = order.customer_id;
  if (order.customer_nip) dto.customerNip = order.customer_nip;
  if (order.customer_name) dto.customerName = order.customer_name;
  if (order.source) dto.source = order.source;
  if (order.order_type) dto.orderType = order.order_type;
  if (order.mode) dto.mode = order.mode;
  if (order.discount > 0) dto.discountAmount = order.discount / 100;
  if (order.payment_amount > 0) dto.paymentAmount = order.payment_amount / 100;
  if (order.change_amount > 0) dto.changeAmount = order.change_amount / 100;
  if (order.tip && order.tip > 0) dto.tip = order.tip / 100;
  return dto;
}

/**
 * ported from product-sync.ts:151-168. A v2 cursor that the backend has marked
 * as unsafe (status 409 + code PRODUCT_SYNC_CURSOR_UNSAFE + resetRequired) —
 * the only error that triggers a cursor reset rather than a retry.
 */
function isUnsafeProductSyncCursorError(error: any): boolean {
  const body = error?.serverBody;
  const envelopeError = body?.error && typeof body.error === 'object' ? body.error : null;
  const details = error?.details ?? body?.details ?? envelopeError?.details;
  const code = String(
    error?.code ?? body?.code ?? envelopeError?.code ?? '',
  ).trim().toUpperCase();
  const resetRequired = error?.resetRequired === true
    || details?.resetRequired === true
    || body?.resetRequired === true
    || envelopeError?.resetRequired === true;
  return Number(error?.status) === 409
    && code === 'PRODUCT_SYNC_CURSOR_UNSAFE'
    && resetRequired === true;
}

// ─── Transport ─────────────────────────────────────────────────────────────

export interface RealTransportOptions {
  configStore: ShimConfigStore;
  tokenStore: TokenStore;
  /** Passed to initAndroidDb on first catalog/sync use (tests inject locateFile: null). */
  dbInit?: AndroidDbInitOptions;
}

/** Outcome of the most recent refresh attempt — disambiguates the boolean
 *  refresh() return for onExpired + getUser (the api-client's boolean interface
 *  cannot, by design — see port/api-client.ts header). */
type RefreshOutcome = 'success' | 'rejected' | 'no-refresh-token' | 'transient' | 'none';

/**
 * Build the real ShimTransport. Owns: a PosApiClient, the TokenProvider wired to
 * TokenStore, an auth-expired + products-synced emitter, and a lazily-initialized
 * SQL.js catalog DB. Returned object also carries the two event-subscription
 * hooks (`onAuthExpired` / `onProductsSynced`) the shim's auth/sync namespaces
 * delegate to.
 */
export interface RealTransportEvents {
  onAuthExpired(cb: () => void): () => void;
  onProductsSynced(cb: () => void): () => void;
  onOrderSynced(cb: (payload: { orderId: string; backendId: string }) => void): () => void;
  onOrderSyncFailed(cb: (payload: { orderId: string; orderNumber: string | null; error: string; code?: string }) => void): () => void;
}

export function createRealTransport(options: RealTransportOptions): ShimTransport & RealTransportEvents {
  const { configStore, tokenStore } = options;
  const baseUrl = resolveApiUrl(configStore);

  const client = new PosApiClient({
    baseUrl,
    tokenProvider: undefined as unknown as TokenProvider, // assigned below
    salonSlug: configStore.getRawConfig().salonSlug ?? undefined,
  });

  const expiredListeners = new Set<() => void>();
  const productsSyncedListeners = new Set<() => void>();
  const orderSyncedListeners = new Set<(payload: { orderId: string; backendId: string }) => void>();
  const orderSyncFailedListeners = new Set<(payload: { orderId: string; orderNumber: string | null; error: string; code?: string }) => void>();
  let lastRefreshOutcome: RefreshOutcome = 'none';
  let orderSyncInFlight: Promise<void> | null = null;

  /** Clear the session identity (keep local DB — logout ≠ wipe, S1 §2.B note). */
  const clearSessionIdentity = () => {
    configStore.setConfig({
      authUser: undefined,
      salonName: undefined,
      salonSlug: undefined,
    });
  };

  const tokenProvider: TokenProvider = {
    getAccessToken: () => tokenStore.getAccessToken(),
    refresh: async () => {
      const refreshToken = await tokenStore.getRefreshToken();
      if (!refreshToken) {
        // No refresh token → unrecoverable this run (auth-refresh.ts:95-98).
        lastRefreshOutcome = 'no-refresh-token';
        return false;
      }
      try {
        const body = await client.refreshAccessToken(refreshToken);
        // Backend rotates the refresh token on success (auth-refresh.ts:158-162).
        await tokenStore.setTokens(body.access_token, body.refresh_token ?? null);
        lastRefreshOutcome = 'success';
        return true;
      } catch (err: any) {
        if (err?.status === 401) {
          // Refresh rejected — dead session. Clear tokens (auth-refresh.ts:132-135).
          await tokenStore.clear();
          lastRefreshOutcome = 'rejected';
        } else {
          // Transient (network / 5xx / malformed) — tokens stay (auth-refresh.ts:138-142).
          lastRefreshOutcome = 'transient';
        }
        return false;
      }
    },
    onExpired: () => {
      // The api-client fires onExpired whenever refresh() returns false. Only a
      // genuinely dead session (rejected / no-refresh-token) clears identity +
      // emits auth.onExpired; a transient blip is a no-op so the cashier stays
      // in POS and the boot getUser() falls back to the cached authUser
      // (resolveCurrentUser semantics, auth-get-user.ts:81-108).
      if (lastRefreshOutcome === 'rejected' || lastRefreshOutcome === 'no-refresh-token') {
        clearSessionIdentity();
        for (const cb of [...expiredListeners]) {
          try { cb(); } catch { /* a listener throwing must not break others */ }
        }
      }
    },
  };
  // Assign the now-circular provider (constructor needs the client; provider
  // closes over the client). PosApiClient reads tokenProvider lazily per call.
  (client as unknown as { tokenProvider: TokenProvider }).tokenProvider = tokenProvider;

  // Keep X-Salon-Slug fresh on the client (Windows reads it per-call from
  // config; here we sync it before each catalog/sync HTTP call).
  const syncSalonSlug = () => {
    client.salonSlug = configStore.getRawConfig().salonSlug ?? undefined;
  };

  // ── Lazy SQL.js catalog DB (initAndroidDb on first use, S5) ──────────────
  let dbPromise: Promise<AndroidDatabase> | null = null;
  const db = (): Promise<AndroidDatabase> => {
    if (!dbPromise) dbPromise = initAndroidDb(options.dbInit);
    return dbPromise;
  };

  const transport: ShimTransport & RealTransportEvents = {
    // ── Auth (S1 §2.B) ─────────────────────────────────────────────────────
    async loginWithEmail(email, password): Promise<ShimLoginResult> {
      try {
        const result = await client.loginWithEmail(email, password);
        if (!result?.access_token) {
          return { success: false, error: 'No access token received' };
        }
        const authUser = buildLoginAuthUser(result, configStore.getRawConfig().salonName);
        if (!authUser.salonId) {
          return { success: false, error: 'Login response missing salon id' };
        }
        // Store the staff JWT (NO pa_ key, NO /print-agent/connect — S1 §2.B rail).
        await tokenStore.setTokens(result.access_token, result.refresh_token ?? null);
        const salonSlug = resolveAuthSalonSlug(result);
        // setConfig side-effect (auth.module.ts:795), minus the print-agent auto-connect.
        configStore.setConfig({
          authUser,
          salonId: authUser.salonId,
          salonName: authUser.salonName ?? '',
          salonSlug,
          posEnabled: true,
          posMode: 'retail',
        } as Partial<AgentConfig>);
        client.salonSlug = salonSlug || client.salonSlug;
        // Seed the staff picker with the logged-in cashier (documented
        // divergence: Windows fills `staff` via its staff sync worker; the
        // Android staff-sync packet lands later).
        try {
          const database = await db();
          createOrderRepo(database).upsertStaff({
            id: authUser.id,
            user_id: authUser.id,
            name: [authUser.firstName, authUser.lastName].filter(Boolean).join(' ') || authUser.email,
            role: authUser.role,
          });
        } catch { /* staff seeding must never fail a login */ }
        return { success: true, data: { user: authUser } };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    },

    async getUser(): Promise<ShimGetUserResult> {
      const token = await tokenStore.getAccessToken();
      if (!token) {
        // No persisted token → not authenticated (first install / after logout).
        return { success: true, data: { isAuthenticated: false } };
      }
      syncSalonSlug();
      try {
        const raw = await client.getMe();
        const user = resolveAuthUser(raw, configStore.getRawConfig().salonName);
        return { success: true, data: { isAuthenticated: true, user } };
      } catch (err: any) {
        const message = String(err?.message ?? err);
        if (/\b401\b/.test(message)) {
          // refresh already ran inside the api-client 401-retry path.
          if (lastRefreshOutcome === 'transient') {
            // Transient refresh failure — fall back to the cached profile so a
            // startup network blip does not kick the cashier to login
            // (auth-get-user.ts:81-88, 103-108).
            const cached = configStore.getRawConfig().authUser;
            if (cached?.id) {
              return { success: true, data: { isAuthenticated: true, user: cached } };
            }
          }
          // Dead session (refresh rejected / no-refresh-token / a freshly-rotated
          // token that the backend still rejects) → drop to login.
          return { success: true, data: { isAuthenticated: false } };
        }
        // Generic network error (5xx / timeout / DNS) outside the refresh path —
        // token might still be valid; fall back to the cached profile.
        const cached = configStore.getRawConfig().authUser;
        if (cached?.id) {
          return { success: true, data: { isAuthenticated: true, user: cached } };
        }
        return { success: true, data: { isAuthenticated: false } };
      }
    },

    async logout() {
      // Clear tokens + identity; KEEP the local SQL.js mirror (S1 §2.B note —
      // logout ≠ wipe; a re-login to the same salon stays healthy).
      await tokenStore.clear();
      clearSessionIdentity();
      return { success: true };
    },

    // ── Catalog reads (S1 §2.D) — served from the local SQL.js mirror ──────
    async getProducts(): Promise<ShimPosProduct[]> {
      return createProductRepo(await db()).getAll();
    },
    async getProductById(id): Promise<ShimPosProduct | null> {
      return createProductRepo(await db()).getById(id);
    },
    async getProductByBarcode(barcode): Promise<ShimPosProduct | null> {
      return createProductRepo(await db()).getByBarcode(barcode);
    },
    async searchProducts(query): Promise<ShimPosProduct[]> {
      return createProductRepo(await db()).search(query);
    },
    async getCategories(): Promise<ShimPosCategory[]> {
      return createCategoryRepo(await db()).getCategories();
    },

    // ── Catalog sync (S1 §2.E) — ported cursor loop (product-sync.ts) ──────
    async syncProducts(): Promise<{ success: boolean; productsCount?: number; error?: string }> {
      const token = await tokenStore.getAccessToken();
      if (!token) {
        // Silent no-auth (the periodic timer / boot may fire before login).
        return { success: false, error: 'no-auth' };
      }
      syncSalonSlug();
      const database = await db();
      const productRepo = createProductRepo(database);
      const categoryRepo = createCategoryRepo(database);
      const syncMeta = createSyncMeta(database);

      // The Android S5 schema stores ONE cursor key (Windows has v2 + legacy);
      // the v2 nextSyncCursor is written here for both modes.
      const since = syncMeta.getSyncMeta().cursor ?? undefined;

      let result;
      try {
        result = await client.getPosProducts(since, { cursorV2: true });
      } catch (err: any) {
        // Unsafe v2 cursor → reset + one fresh full sync (product-sync.ts:339-356).
        if (isUnsafeProductSyncCursorError(err)) {
          syncMeta.setSyncMeta(null);
          const fresh = await client.getPosProducts(undefined, { cursorV2: true });
          result = fresh;
        } else {
          return { success: false, error: err?.message || String(err) };
        }
      }

      const products: AndroidProductRow[] = [];
      for (const item of result.products ?? []) {
        const row = normalizeProductRow(item);
        if (row) products.push(row);
      }
      const categories: AndroidCategoryRow[] = [];
      const seenCategoryId = new Set<string>();
      for (const cat of result.categories ?? []) {
        const row = normalizeCategoryRow(cat);
        if (row && !seenCategoryId.has(row.id)) {
          seenCategoryId.add(row.id);
          categories.push(row);
        }
      }

      // Advance the cursor atomically with the upserts (product-sync.ts:401-409:
      // the cursor write shares the database.transaction() with the row writes).
      // v2 always carries nextSyncCursor; the api-client port already throws
      // SYNC_CURSOR_INVALID if the final page is missing it.
      const nextCursor = result.nextSyncCursor ?? result.nextSince ?? null;

      const productsCount = products.length;
      database.transaction(() => {
        if (products.length > 0) productRepo.upsertProducts(products);
        if (categories.length > 0) categoryRepo.upsertCategories(categories);
        // Soft-delete products the backend marked deleted (product-sync.ts:394-396).
        if (result.deletedIds && result.deletedIds.length > 0) {
          for (const id of result.deletedIds) {
            database.run('UPDATE product_variants SET is_active = 0 WHERE id = ?', [id]);
          }
        }
        // Advance ONLY on a successful batch (Windows writes the final cursor
        // inside the same transaction; a partial-page throw rolls it back).
        if (nextCursor) {
          syncMeta.setSyncMeta(nextCursor);
        }
      });
      // Order-relevant writes (catalog) flush immediately so a crash preserves them
      // (mirrors the Windows paid-order durability barrier; the debounce also runs).
      await database.flush().catch(() => { /* debounced flush still pending */ });

      // Emit pos.sync.onProductsSynced (S1 §2.E) — `()` payload, no data.
      for (const cb of [...productsSyncedListeners]) {
        try { cb(); } catch { /* a listener throwing must not break others */ }
      }

      return { success: true, productsCount };
    },

    // ── Orders: CASH create + push (S8 — ported pos.module.ts:3053-3121 and
    //    order-sync.ts:97-292) ─────────────────────────────────────────────
    async createOrder(order: any, items: any[]): Promise<{ success: boolean; id?: string; error?: string }> {
      try {
        const database = await db();
        const orderRepo = createOrderRepo(database);
        const productRepo = createProductRepo(database);
        const normalizedOrder = { ...(order || {}) };
        const isPosOrder = (normalizedOrder.source ?? 'POS') === 'POS';
        if (isPosOrder) {
          // Shift enforcement — ported from pos.module.ts:3057-3095.
          const activeShift = orderRepo.getActiveShift();
          const staffMissing = !String(normalizedOrder.staff_name || '').trim();
          const staffIdMissing = !String(normalizedOrder.staff_id || '').trim();
          const shiftMissing = !normalizedOrder.shift_id;
          if (activeShift && (staffMissing || shiftMissing || staffIdMissing)) {
            normalizedOrder.shift_id = activeShift.id;
            normalizedOrder.staff_id = activeShift.staff_id;
            normalizedOrder.staff_name = activeShift.staff_name;
          }
          const requestedShiftId = String(normalizedOrder.shift_id || '').trim();
          if (!requestedShiftId || !String(normalizedOrder.staff_id || '').trim() || !String(normalizedOrder.staff_name || '').trim()) {
            return { success: false, error: 'Cannot create POS order without an active shift staff. Close and reopen the shift before payment.' };
          }
          const orderShift = orderRepo.getOpenShiftById(requestedShiftId);
          if (!orderShift) {
            return { success: false, error: 'Cannot create POS order without a local active shift. Close and reopen the shift before payment.' };
          }
          normalizedOrder.shift_id = orderShift.id;
          normalizedOrder.staff_id = orderShift.staff_id;
          normalizedOrder.staff_name = orderShift.staff_name;
        }

        // Item normalization — ported from pos.module.ts:3097-3119.
        const normalizedItems = (items || []).map((item: any) => {
          const product = item.variant_id ? productRepo.getById(item.variant_id) : null;
          const sell_by = getLineSellBy({
            ...item,
            sell_by: item.sell_by ?? item.sellBy ?? (product as any)?.sell_by ?? 'PIECE',
          });
          const sale_quantity = getLineSaleQuantity({ ...item, sell_by });
          const sale_unit = getLineSaleUnit({
            ...item,
            sell_by,
            sale_unit: item.sale_unit ?? item.saleUnit ?? (product as any)?.sale_unit ?? null,
          });
          const price = Math.max(0, Math.round(Number(item.price) || 0));
          return {
            ...item,
            price,
            quantity: sale_quantity,
            sale_quantity,
            sale_unit,
            sell_by,
            total: getLineTotalGrosze({ ...item, price, quantity: sale_quantity, sale_quantity, sell_by }),
          };
        });

        const id = orderRepo.create(normalizedOrder, normalizedItems);

        // Local stock decrement — ported from pos.module.ts:3132-3139.
        const allowNegative = (configStore.getRawConfig() as any).allowOversell === true;
        for (const item of normalizedItems) {
          if (item.variant_id && item.quantity > 0) {
            database.run(
              allowNegative
                ? 'UPDATE product_variants SET in_stock = in_stock - ?, available_qty = available_qty - ? WHERE id = ?'
                : 'UPDATE product_variants SET in_stock = MAX(0, in_stock - ?), available_qty = MAX(0, available_qty - ?) WHERE id = ?',
              [item.quantity, item.quantity, item.variant_id],
            );
          }
        }

        // Paid orders must survive a crash — flush immediately (order-repo.ts:249-250).
        await database.flush().catch(() => { /* debounced flush still pending */ });
        return { success: true, id };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    },

    /** Drain pending orders — ported loop from order-sync.ts:87-292 (minus the
     *  Windows local-variant-import deferral, which has no Android source). */
    async syncOrders(): Promise<void> {
      if (orderSyncInFlight) return orderSyncInFlight;
      orderSyncInFlight = (async () => {
        const token = await tokenStore.getAccessToken();
        if (!token) return;
        const database = await db();
        const orderRepo = createOrderRepo(database);
        orderRepo.recoverStrandedSyncing();
        const pending = orderRepo.getUnsynced();
        for (const order of pending) {
          const attempts = order.sync_attempts ?? 0;
          if (attempts >= MAX_SYNC_ATTEMPTS) {
            orderRepo.shelve(order.id, order.sync_error ?? 'Max retries exceeded');
            continue;
          }
          try {
            const items = orderRepo.getItemsByOrderId(order.id);
            orderRepo.markSyncing(order.id);
            database.run('UPDATE orders SET sync_attempts = sync_attempts + 1 WHERE id = ?', [order.id]);
            if (items.length === 0) {
              orderRepo.markSynced(order.id, 'no-items');
              continue;
            }
            const dto = buildOrderDto(order, items);
            if (dto.items.length === 0) {
              orderRepo.markSynced(order.id, 'no-valid-items');
              continue;
            }
            const result = await client.createPosOrder(dto);
            const backendId = String(result.id ?? result.orderId ?? order.id);
            let backendOrderNumber = getBackendOrderNumber(result);
            // Finalize immediately — triggers backend stock deduction
            // (order-sync.ts:230-238). finishOrder failure is non-fatal.
            try {
              const finishResult = await client.finishOrder(backendId);
              backendOrderNumber = getBackendOrderNumber(finishResult) ?? backendOrderNumber;
            } catch { /* non-fatal, matches Windows */ }
            orderRepo.markSynced(order.id, backendId, backendOrderNumber);
            database.run('UPDATE orders SET sync_error = NULL WHERE id = ?', [order.id]);
            for (const cb of [...orderSyncedListeners]) {
              try { cb({ orderId: order.id, backendId }); } catch { /* listener isolation */ }
            }
          } catch (err: any) {
            const errMsg = String(err?.message || err).substring(0, 500);
            const classified = classifyError(errMsg);
            if (classified.kind === 'business') {
              orderRepo.shelve(order.id, errMsg);
              for (const cb of [...orderSyncFailedListeners]) {
                try {
                  cb({ orderId: order.id, orderNumber: order.order_number ?? null, error: errMsg, code: classified.code });
                } catch { /* listener isolation */ }
              }
            } else {
              orderRepo.markSyncFailed(order.id);
              database.run('UPDATE orders SET sync_error = ? WHERE id = ?', [errMsg, order.id]);
            }
          }
        }
        await database.flush().catch(() => { /* debounced flush still pending */ });
      })().finally(() => { orderSyncInFlight = null; });
      return orderSyncInFlight;
    },

    async getOrderHistory(filters: any): Promise<{ orders: any[]; total: number; page: number; limit: number }> {
      return createOrderRepo(await db()).getHistory(filters);
    },
    async getOrderDetail(orderId: string): Promise<{ order: any; items: any[] } | null> {
      const orderRepo = createOrderRepo(await db());
      const order = orderRepo.getById(orderId);
      if (!order) return null;
      return { order, items: orderRepo.getItemsByOrderId(orderId) };
    },

    // ── Shifts (S9 — local-first port of shift-controller.ts:75-170 +
    //    pos.module.ts:4650-4666) ────────────────────────────────────────────
    async openShift(data: { staffId: string; staffName: string; openingCash: number }): Promise<{ success: boolean; shiftId?: string; error?: string }> {
      try {
        const database = await db();
        const orderRepo = createOrderRepo(database);
        const shiftId = (globalThis.crypto?.randomUUID?.() ?? `shift-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        orderRepo.openShift(shiftId, data.staffId, data.staffName, data.openingCash);
        await database.flush().catch(() => { /* debounced flush still pending */ });
        // Async backend sync, non-blocking (shift-controller.ts:88).
        void client.openPosShift({ staffId: data.staffId, openingCash: data.openingCash })
          .catch(() => { /* backend outage never blocks the local shift */ });
        return { success: true, shiftId };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    },
    async closeShift(data: { shiftId: string; closingCash: number; fiscalOnly?: boolean }): Promise<{ success: boolean; report?: any; error?: string }> {
      try {
        const database = await db();
        const orderRepo = createOrderRepo(database);
        // Ghost shift → clear gracefully (pos.module.ts:4663-4676).
        if (!orderRepo.getOpenShiftById(data.shiftId)) {
          void client.closePosShift(data.shiftId, { closingCash: data.closingCash })
            .catch(() => { /* best-effort server ghost close */ });
          return { success: true, report: null };
        }
        // Pre-close order drain, never blocking (pos.module.ts:4680-4700 —
        // Windows races a 2s timeout; the Android drain is awaited best-effort).
        await (transport.syncOrders?.() ?? Promise.resolve()).catch(() => { /* offline close is fine */ });
        const report = orderRepo.closeShift(data.shiftId, data.closingCash);
        await database.flush().catch(() => { /* debounced flush still pending */ });
        void client.closePosShift(data.shiftId, { closingCash: data.closingCash })
          .catch(() => { /* backend outage never blocks the local Z-report */ });
        return { success: true, report };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    },
    async getStaff(): Promise<any[]> {
      return createOrderRepo(await db()).getStaff();
    },

    // ── Event subscription hooks (delegated to by stubs.ts) ─────────────────
    onAuthExpired(cb: () => void): () => void {
      expiredListeners.add(cb);
      return () => { expiredListeners.delete(cb); };
    },
    onProductsSynced(cb: () => void): () => void {
      productsSyncedListeners.add(cb);
      return () => { productsSyncedListeners.delete(cb); };
    },
    onOrderSynced(cb: (payload: { orderId: string; backendId: string }) => void): () => void {
      orderSyncedListeners.add(cb);
      return () => { orderSyncedListeners.delete(cb); };
    },
    onOrderSyncFailed(cb: (payload: { orderId: string; orderNumber: string | null; error: string; code?: string }) => void): () => void {
      orderSyncFailedListeners.add(cb);
      return () => { orderSyncFailedListeners.delete(cb); };
    },
  };

  return transport;
}
