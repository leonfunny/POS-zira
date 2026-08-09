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
import { shouldDecrementStockAtCheckout } from '../../../shared/pos/order-line-contract';
import { createServerShiftConsistency } from '../../../shared/pos/server-shift-consistency';
import { assertLocalOpenShiftMatchesSession, getVerifiedServerShiftMismatch } from '../../../shared/pos/open-shift-recovery';
import { currentPosSnapshotScope } from '../../../shared/pos/billiard-pos-handoff';
import { createPeriodicOrderDrain } from '../../../shared/order-drain';
import { resolvePosMode, SYNTHETIC_AUTH_USER } from './config-store';
import { PosApiClient, type TokenProvider } from '../../android-pos/port/api-client';
import { adaptServerOrder, adaptServerOrderItem } from '../port/server-order-adapter';
import type {
  ShimGetUserResult,
  ShimLoginResult,
  ShimPosCategory,
  ShimPosProduct,
  ShimTransport,
} from './transport';
import type { ShimConfigStore } from './config-store';
import type { TokenStore } from './token-store';
import type { ShimPosStore } from './pos-store';
import { initAndroidDb, type AndroidDatabase, type AndroidDbInitOptions } from './db/db';
import { createProductRepo, type AndroidProductRow } from './db/product-repo';
import { createCategoryRepo, type AndroidCategoryRow } from './db/category-repo';
import { createSyncMeta } from './db/sync-meta';
import { POS_SNAPSHOT_CART_KEY, createPosSnapshotRepo } from './db/pos-snapshot-repo';
import { createRemotePrintCoordinator } from './remote-print';
import { createAgentConnection, type AgentConnection } from './agent-connect';
import { createProductAdminSurface } from './product-admin';
import { createBilliardTransport } from './billiard-transport';
import { createBilliardHandoff, type AndroidBilliardHandoff } from './billiard-handoff';
import { createHoldOrders, type AndroidHoldOrders } from './hold-orders';
import { createBilliardHandoffRepo } from './db/billiard-handoff-repo';
import { createEntitlementsController } from './entitlements';
import { createDeviceCommandHandler, type DeviceCommandEvent, type DeviceCommandResult } from './device-command';
import {
  buildBackendOrderItem,
  createOrderRepo,
  getLineSaleQuantity,
  getLineSaleUnit,
  getLineSellBy,
  getLineTotalGrosze,
} from './db/order-repo';
import { normalizeVatRate } from '../../../shared/pos/vat-rate';

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
    // A readable rate wins, INCLUDING 0% (exports / intra-EU). Only an
    // unreadable one falls back to 23 — see shared/pos/vat-rate.ts.
    vat_rate: normalizeVatRate(template.taxRate ?? template.tax_rate ?? item.vat_rate),
    is_active: (item.isActive ?? item.is_active ?? true) ? 1 : 0,
    is_on_sale: (item.isOnSale ?? item.is_on_sale) ? 1 : 0,
    thumbnail_url: item.thumbnailUrl ?? item.thumbnail_url ?? null,
    sale_unit: item.saleUnit ?? item.sale_unit ?? template.baseUnit ?? template.base_unit ?? null,
    sell_by: item.sellBy ?? item.sell_by ?? template.sellBy ?? template.sell_by ?? 'PIECE',
    // Services / non-inventory items are not stock-decremented locally (Windows
    // STOCK_TRACKED_GUARD_SQL: item_type='stockable' AND track_inventory=1).
    track_inventory: resolveTrackInventory(item, template),
    updated_at: item.canonicalUpdatedAt ?? item.canonical_updated_at ?? item.updatedAt ?? item.updated_at ?? null,
  };
}

/**
 * Whether a catalog row is stock-tracked. Mirrors the Windows guard: only
 * `item_type='stockable'` with `track_inventory` truthy is decremented. A
 * service/consumable item_type, or an explicit track_inventory=false, is 0.
 * Absent metadata defaults to tracked (1) — the safe default for retail goods.
 */
function resolveTrackInventory(item: any, template: any): number {
  const itemType = String(item.itemType ?? item.item_type ?? template.itemType ?? template.item_type ?? '').toLowerCase();
  if (itemType && itemType !== 'stockable' && itemType !== 'product') return 0;
  const track = item.trackInventory ?? item.track_inventory ?? template.trackInventory ?? template.track_inventory;
  if (track === false || track === 0 || track === '0' || track === 'false') return 0;
  return 1;
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

// ─── Staff normalization (E2a — staffSync.pullStaff → staffRepo) ───────────

/**
 * Normalize one backend staff profile (GET /api/v1/staff) into the local
 * `staff` table column set. The backend may return camelCase or snake_case,
 * a flat `name` or split `firstName`/`lastName`, and a 0–100 commission rate.
 * Mirrors the defensive mapping the Windows staff-sync worker applies before
 * the staffRepo bulk upsert (staff-sync.ts:17 → staffRepo). Returns null for a
 * row without an id or any resolvable name (skipped, never throws).
 */
function normalizeStaffRow(raw: any): {
  id: string;
  user_id: string | null;
  name: string;
  commission_rate: number;
  is_active: number;
  role: string | null;
} | null {
  if (!raw) return null;
  const id = raw.id ?? raw.staffProfileId ?? raw.staff_profile_id ?? raw.userId ?? raw.user_id;
  if (!id) return null;
  // The REAL /staff response nests the person under `user`
  // ({ items: [{ id, user: { full_name, is_active, role, ... }, status, ... }] });
  // the old mapper read only flat fields, so EVERY row normalized to null,
  // bulkUpsertStaff([]) wiped the table (login seed included), and the
  // open-shift dialog showed "no active staff" on the first device run.
  // This is now a faithful port of the Windows mapBackendStaff
  // (staff-sync.ts) — || semantics on the name chain, because an empty
  // joined string must FALL THROUGH, which `??` does not do.
  const user = raw.user || {};
  const name = String(
    raw.name || raw.fullName || raw.full_name || user.full_name
    || `${raw.firstName || raw.first_name || ''} ${raw.lastName || raw.last_name || ''}`.trim()
    || raw.email || user.email || '',
  ).trim();
  if (!name) return null;
  const commission = Number(raw.commissionRate ?? raw.commission_rate ?? raw.commissionPercent ?? raw.commission_percent ?? 0);
  // Windows: an explicit isActive wins; otherwise the row is active only while
  // the linked user is not deactivated AND the profile status is ACTIVE.
  const status = String(raw.status || 'ACTIVE').toUpperCase();
  const userActive = user.is_active !== false;
  const explicit = raw.isActive ?? raw.is_active;
  const rowActive = explicit !== undefined && explicit !== null
    ? !(explicit === false || explicit === 0 || explicit === '0')
    : userActive && status === 'ACTIVE';
  return {
    id: String(id),
    user_id: raw.userId ?? raw.user_id ?? user.id ?? null,
    name,
    commission_rate: Number.isFinite(commission) ? commission : 0,
    is_active: rowActive ? 1 : 0,
    role: raw.role ?? user.role ?? null,
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

/**
 * Tender validation (E-PARITY-2). The Sunmi is a trusted, fixed POS terminal
 * (owner decision 2026-07-19) and accepts the SAME manual tenders the Windows
 * salon counter does: CASH plus the manual electronic tenders (CARD / BLIK /
 * TRANSFER / …). The Windows salon PaymentModal drives a STANDALONE card
 * terminal — the cashier keys the amount on the terminal and confirms approval;
 * there is no integrated capture reference, exactly like this port. The backend
 * P0-PAY-1 gap (it marks any non-CREDIT tender PAID without capture proof) is
 * accepted here on the same cashier-attestation basis as the Windows counter.
 *
 * Returns an error string only for a genuinely UNKNOWN/unreadable tender (a
 * method the backend enum map cannot accept), else null. An empty/absent
 * payment_method is treated as CASH (the local default).
 */
function assertTenderAllowed(order: any): string | null {
  const isKnown = (m: string): boolean =>
    m === '' || Object.prototype.hasOwnProperty.call(PM_MAP, m);
  const method = String(order?.payment_method ?? 'CASH').trim().toUpperCase();
  if (!isKnown(method)) {
    return `Unsupported payment method: ${method}.`;
  }
  const tendersJson = order?.payment_tenders;
  if (tendersJson) {
    try {
      const tenders = JSON.parse(tendersJson) as Array<{ method?: string }>;
      const bad = tenders.find((t) => !isKnown(String(t?.method ?? 'CASH').trim().toUpperCase()));
      if (bad) return `Unsupported split tender: ${String(bad.method)}.`;
    } catch {
      return 'Unreadable tender data.';
    }
  }
  return null;
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
  // BILLIARD IDENTITY — without these the backend has no way to know this order
  // settles a frozen billiard checkout: it creates a plain POS order, the
  // session stays UNPAID with posOrderId null, and the table looks unsettled
  // forever even though the money was taken. Windows sends both
  // (order-sync.ts:178-185); Android was dropping them, which the first real
  // device run surfaced (session ce99bb35 on 2026-08-04).
  if (order.billiard_origin_json) {
    try {
      dto.billiardOrigin = JSON.parse(order.billiard_origin_json);
      dto.clientAttemptId = order.client_attempt_id;
    } catch {
      throw new Error('Invalid persisted billiard order origin');
    }
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

/**
 * Order ids whose durability flush failed AND whose rollback transaction also
 * threw, so the in-memory order row survived. The duplicate-by-id guard in
 * createOrder must not answer a retry for one of these with a lying
 * `{success:true, duplicate:true}` — the row exists only in RAM and the image
 * on disk is stale/unknown. Module-scope so it outlives a transport rebuild
 * within the same page session (the process must be restarted to clear it).
 */
const durabilityFailedOrders = new Set<string>();

// ─── Transport ─────────────────────────────────────────────────────────────

export interface RealTransportOptions {
  configStore: ShimConfigStore;
  tokenStore: TokenStore;
  /** Passed to initAndroidDb on first catalog/sync use (tests inject locateFile: null). */
  dbInit?: AndroidDbInitOptions;
  /**
   * E-PARITY-1: the print-agent connection. Defaults to the real
   * createAgentConnection (fetch key -> connect -> socket). Injectable so tests
   * that don't exercise the agent can pass a no-op and keep their fetch mocks
   * deterministic — login fires connect() in the background, which would
   * otherwise make an unmocked /print-agent/my-key call.
   */
  agentConnection?: AgentConnection;
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
  onStaffUpdated(cb: (data?: { count?: number } | undefined) => void): () => void;
  onNailTurnsUpdated(cb: (data: { orderId?: string; checkedOut?: number }) => void): () => void;
}

export function createRealTransport(options: RealTransportOptions): ShimTransport & RealTransportEvents {
  const { configStore, tokenStore } = options;
  const baseUrl = resolveApiUrl(configStore);

  const client = new PosApiClient({
    baseUrl,
    tokenProvider: undefined as unknown as TokenProvider, // assigned below
    salonSlug: configStore.getRawConfig().salonSlug ?? undefined,
  });

  // Billiard (Bi-a) online-only transport (T4). Bound to the SAME client's
  // generic request() — staff JWT + refresh-on-401, with no duplicated auth.
  // Its methods are spread into the returned transport below; dispose() runs on
  // logout and on the auth-expired teardown path so the 10s poll timer + listener
  // set never leak across a session. Constructed eagerly (just closures — no
  // fetch and no poll timer until a billiard read actually runs).
  const billiard = createBilliardTransport({
    request: (method, path, body) => client.request(method, path, body),
    // F&B list for the billiard add-item modal = the LOCAL catalog mirror, the
    // same source the Windows counter uses (sync.module.ts:245-263). These
    // closures are lazy — `db()` is defined below and is only invoked when the
    // modal actually reads, never during construction.
    catalog: {
      getAll: async () => createProductRepo(await db()).getAll(),
      search: async (query, categoryId) => createProductRepo(await db()).search(query, categoryId),
      getByCategory: async (categoryId) => createProductRepo(await db()).getByCategory(categoryId),
      getCategories: async () => createCategoryRepo(await db()).getCategories(),
    },
  });

  // Real salon entitlements (shim/entitlements.ts): the plan decides which tabs
  // exist, replacing the synthetic all-enabled answer. Same request seam (staff
  // JWT + refresh-on-401); cleared on logout / dead session like billiard.
  const entitlements = createEntitlementsController({
    configStore,
    request: (method, path, body) => client.request(method, path, body),
  });

  const expiredListeners = new Set<() => void>();
  const productsSyncedListeners = new Set<() => void>();
  const orderSyncedListeners = new Set<(payload: { orderId: string; backendId: string }) => void>();
  const orderSyncFailedListeners = new Set<(payload: { orderId: string; orderNumber: string | null; error: string; code?: string }) => void>();
  // E2a salon emitters: staff-updated (after a staff pull) + nail-turns-updated
  // (after a salon checkout closes a technician's turn).
  const staffUpdatedListeners = new Set<(data?: { count?: number } | undefined) => void>();
  const nailTurnsUpdatedListeners = new Set<(data: { orderId?: string; checkedOut?: number }) => void>();
  let lastRefreshOutcome: RefreshOutcome = 'none';
  let orderSyncInFlight: Promise<void> | null = null;
  const orderDrain = createPeriodicOrderDrain(() => transport.syncOrders?.() ?? Promise.resolve());
  // Server-side shift agreement for the payment boundary (Windows
  // pos.module.ts:663-668 + 987-1097). Sticky: only a verified disagreement
  // blocks payment, and it keeps blocking until a later verified agreement
  // clears it — otherwise a cashier could retry into an offline window and be
  // waved through the very check that just failed.
  const shiftConsistency = createServerShiftConsistency();
  let shiftVerificationInFlight: Promise<void> | null = null;
  // Single-flight refresh (Windows auth-refresh.ts:73-91): the backend ROTATES
  // the refresh token on every success, so two concurrent 401s must NOT each
  // POST the same token — the loser would 401 and clear the just-rotated pair,
  // logging the cashier out of a recoverable session. Concurrent callers share
  // this one promise.
  let refreshInFlight: Promise<boolean> | null = null;

  /** Clear the session identity (keep local DB — logout ≠ wipe, S1 §2.B note). */
  const clearSessionIdentity = () => {
    configStore.setConfig({
      authUser: undefined,
      salonName: undefined,
      salonSlug: undefined,
    });
  };

  const runRefresh = async (): Promise<boolean> => {
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
  };

  const tokenProvider: TokenProvider = {
    getAccessToken: () => tokenStore.getAccessToken(),
    refresh: () => {
      // Coalesce concurrent refreshes onto one in-flight promise so the rotated
      // refresh token is exchanged exactly once.
      if (refreshInFlight) return refreshInFlight;
      refreshInFlight = runRefresh().finally(() => { refreshInFlight = null; });
      return refreshInFlight;
    },
    onExpired: () => {
      // The api-client fires onExpired whenever refresh() returns false. Only a
      // genuinely dead session (rejected / no-refresh-token) clears identity +
      // emits auth.onExpired; a transient blip is a no-op so the cashier stays
      // in POS and the boot getUser() falls back to the cached authUser
      // (resolveCurrentUser semantics, auth-get-user.ts:81-108).
      if (lastRefreshOutcome === 'rejected' || lastRefreshOutcome === 'no-refresh-token') {
        clearSessionIdentity();
        // Stop the billiard poll timer + drop its listeners — the session is
        // dead, the renderer is dropping to login, so the 10s background refresh
        // must not keep firing 401s against a dead token. Recoverable: after
        // re-login the remounted floor plan resubscribes via onDataUpdated,
        // which re-arms the timer (polling is listener-gated since 917cb6a — a
        // bare read alone no longer restarts it).
        billiard.dispose();
        // Any in-flight handoff work belongs to the dead session — abandon it
        // so a late resolve cannot land under the next cashier.
        handoff?.invalidateAuth();
        // Tenant boundary: drop the cached plan too, so the next login cannot
        // inherit the dead session's feature flags (and its persisted record is
        // removed from storage).
        entitlements.clear();
        orderDrain.stop();
        shiftConsistency.reset();
        holds?.invalidateAuth();
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

  // ── Remote receipt-print coordinator (E1a) — receipt COPY over the staff-JWT
  //    print routes. Built lazily on first use so a transport that never prints
  //    (e.g. the auth-only tests) pays no setup cost. Shares the same `client`
  //    (staff JWT + refresh-on-401) + SQL.js `db()` + config store.
  // E-PARITY-1: the print-agent connection (trusted-terminal parity with the
  // Windows counter). Created eagerly — this is just closures, NO socket opens
  // until connect() runs after login. Its socket-pushed job statuses feed the
  // print coordinator as the PRIMARY completion signal (HTTP poll is fallback).
  let deviceCommandHandler = async (_command: DeviceCommandEvent): Promise<DeviceCommandResult> => ({
    status: 'FAILED',
    error: 'device-command-handler-not-ready',
  });
  const agentConnection: AgentConnection = options.agentConnection ?? createAgentConnection({
    client,
    tokenStore,
    configStore,
    apiUrl: baseUrl,
    handleDeviceCommand: (command) => deviceCommandHandler(command),
  });

  let printCoordinatorPromise: ReturnType<typeof createRemotePrintCoordinator> | null = null;
  const printCoordinator = () => {
    if (!printCoordinatorPromise) {
      printCoordinatorPromise = createRemotePrintCoordinator({
        client,
        db,
        configStore,
        // Socket-push primary (E-PARITY-1): the coordinator consults the agent
        // socket before each HTTP status poll.
        getPushedJobStatus: (jobId) => agentConnection.getPushedJobStatus(jobId),
      });
    }
    return printCoordinatorPromise;
  };

  // ── Billiard POS-handoff (L5) ────────────────────────────────────────────
  // Needs the POS store, which installShim owns, so it is built lazily the
  // first time a handoff method runs after attachPosStore(). Before that every
  // method refuses rather than pretending — the shim's own desktop-only
  // fallbacks would have been indistinguishable from a real refusal.
  /**
   * Verify the local open shift against the register's shift on the server.
   * Single-flight: a second caller awaits the first rather than firing another
   * request at the payment boundary.
   */
  function verifyServerShift(): Promise<void> {
    if (shiftVerificationInFlight) return shiftVerificationInFlight;
    let run: Promise<void>;
    run = (async () => {
      try {
        const database = await db();
        const local = createOrderRepo(database).getActiveShift();
        const cfg = configStore.getRawConfig() as any;
        const machineId = String(cfg.registerCode || cfg.machineId || cfg.agentId || '').trim();
        const serverShift = await client.getActivePosShift(machineId || null);
        shiftConsistency.recordVerified(getVerifiedServerShiftMismatch({
          localShiftId: local?.id ?? null,
          localBackendShiftId: local?.backend_id ?? null,
          serverShiftId: serverShift?.id ?? null,
        }));
      } catch {
        // A transport/HTTP failure is not proof of a mismatch (Windows
        // pos.module.ts:1093-1097). Keep the last verified answer and keep
        // selling — a shop on flaky 4G must not lose its till.
        shiftConsistency.recordUnreachable();
      }
    })().finally(() => {
      if (shiftVerificationInFlight === run) shiftVerificationInFlight = null;
    });
    shiftVerificationInFlight = run;
    return run;
  }

  let transport: ShimTransport & RealTransportEvents;
  let attachedPosStore: ShimPosStore | null = null;
  deviceCommandHandler = createDeviceCommandHandler({
    configStore,
    db,
    getPosStore: () => attachedPosStore,
    syncProducts: () => transport.syncProducts?.() ?? Promise.resolve({ success: false, error: 'unsupported' }),
    syncStaff: () => transport.syncStaff?.() ?? Promise.resolve({ success: false, error: 'unsupported' }),
  });
  let handoff: AndroidBilliardHandoff | null = null;
  let holds: AndroidHoldOrders | null = null;
  /** Same lazy seam as the billiard handoff: no pos store attached yet → refuse
   *  rather than pretend, because a hold without the live cart is meaningless. */
  const holdOrders = (): AndroidHoldOrders | null => {
    if (!attachedPosStore) return null;
    if (!holds) holds = createHoldOrders({ configStore, posStore: attachedPosStore, db });
    return holds;
  };
  const billiardHandoff = (): AndroidBilliardHandoff | null => {
    if (!attachedPosStore) return null;
    if (!handoff) {
      handoff = createBilliardHandoff({
        configStore,
        posStore: attachedPosStore,
        db,
        // D1: a fiscal printer ASSIGNED to this salon, and a LIVE print-agent
        // socket — the tablet owns no printer, so that socket is the fiscal path.
        isFiscalPrinterAssigned: async () => {
          const status = await printCoordinator().getFiscalPrinterStatus();
          return !!status?.assigned;
        },
        isPrintAgentConnected: () => agentConnection.isConnected(),
        assertServerShiftConsistent: async () => {
          await verifyServerShift();
          shiftConsistency.assertConsistent();
        },
      });
    }
    return handoff;
  };
  const NO_HANDOFF = { success: false, error: 'POS is not ready.' };

  /** Emit pos:nail-turns-updated (E2a §2.D) — fires after a salon checkout
   *  closes at least one technician's turn so SalonTemplate reloads the board. */
  const emitNailTurnsUpdated = (payload: { orderId?: string; checkedOut?: number }) => {
    for (const cb of [...nailTurnsUpdatedListeners]) {
      try { cb(payload); } catch { /* listener isolation */ }
    }
  };

  /**
   * E2a §2.D (SHIM_CONTRACT_SALON_E2): best-effort nail-turn checkout for a
   * salon sale. After a salon-mode order is created, close each technician's
   * active turn on the nail-turn board so revenue + tip share are credited.
   * Fully swallowed / fire-and-forget — no-ops when there is no token, the
   * board is unavailable (403/404/501), or no active assignment matches a cart
   * line's staff (pos.module.ts:897,912,926). Emits pos:nail-turns-updated only
   * when a checkout actually succeeded.
   *
   * Cart lines carry `staff_id` (= the staff table id = the user id in the
   * cashier seed); the board keys technicians by `staff_profile_id`, so the
   * board's `staff[].user_id → staff_profile_id` map resolves the cross-key.
   */
  const syncNailTurnCheckoutForOrder = async (order: any, items: any[]) => {
    try {
      if (String(order?.mode ?? '').toLowerCase() !== 'salon') return;
      const token = await tokenStore.getAccessToken();
      if (!token) return;
      const board = await client.getNailTurnBoard();
      if (!board) return; // turn board not deployed today → no-op
      const assignments: any[] = Array.isArray(board.active_assignments) ? board.active_assignments : [];
      if (assignments.length === 0) return;
      const staffSummaries: any[] = Array.isArray(board.staff) ? board.staff : [];
      const userToProfile = new Map<string, string>();
      for (const s of staffSummaries) {
        const profile = s.staff_profile_id ?? s.staffProfileId;
        const user = s.user_id ?? s.userId;
        if (profile && user) userToProfile.set(String(user), String(profile));
      }
      // Group cart lines by staff_id, summing grosze totals (pos.module.ts:3180).
      const totalsByStaff = new Map<string, number>();
      for (const item of items) {
        const sid = item.staff_id ?? item.staffId;
        if (!sid) continue;
        const total = Math.max(0, Math.round(Number(item.total ?? 0) || 0));
        totalsByStaff.set(String(sid), (totalsByStaff.get(String(sid)) ?? 0) + total);
      }
      if (totalsByStaff.size === 0) return;
      const orderTipGrosze = Math.max(0, Math.round(Number(order?.tip ?? 0) || 0));
      const staffIds = [...totalsByStaff.keys()];
      const tipPerStaff = orderTipGrosze > 0 ? Math.floor(orderTipGrosze / staffIds.length) : 0;
      let checkedOut = 0;
      for (const staffId of staffIds) {
        const profileId = userToProfile.get(staffId);
        if (!profileId) continue;
        const assignment = assignments.find(
          (a) => String(a.staff_profile_id ?? a.staffProfileId ?? '') === profileId,
        );
        if (!assignment?.id) continue;
        const amountGrosze = totalsByStaff.get(staffId) ?? 0;
        const result = await client.checkoutNailTurnAssignment(String(assignment.id), {
          amount_pln: amountGrosze / 100,
          tip_pln: tipPerStaff / 100,
          idempotency_key: `pos-zira:nail-turn-checkout:${order.id}:${assignment.id}`,
        });
        if (result) checkedOut += 1;
      }
      if (checkedOut > 0) emitNailTurnsUpdated({ orderId: order.id, checkedOut });
    } catch {
      // Best-effort: a checkout failure never breaks the sale (the order is
      // already created + flushed). Technician revenue/turn tracking just lags.
    }
  };

  transport = {
    // ── Billiard (Bi-a) online-only (T4) — reads + 10s poll, direct mutate,
    //    allowlisted apiCall. Spread in (no key collides with the ports below).
    ...billiard,

    // ── Real salon entitlements — the plan decides which tabs exist ─────────
    entitlementsGet: () => entitlements.get(),
    entitlementsFetch: () => entitlements.fetch(),
    entitlementsIsEnabled: (feature: string) => entitlements.isEnabled(feature),
    entitlementsOnChanged: (cb) => entitlements.onChanged(cb),

    // ── Product/stock/category admin (E-PARITY-3, owner-only) ──────────────
    productAdmin: createProductAdminSurface({ client, configStore }),

    // ── Billiard POS-handoff (L5) — delegated to the orchestration ─────────
    /**
     * The ordinary (non-billiard) payment boundary — Windows
     * prepareOrdinaryPosPayment (pos.module.ts:681-707). The shim used to
     * return success with a token derived from the order id and verify nothing,
     * so the one thing this gate exists to catch — a shift the server no longer
     * considers open — sailed straight through.
     *
     * The returned token is a SUCCESS SIGNAL, not a capability: PaymentModal
     * refuses to tender without one. Nothing validates the ordinary token later
     * (true on Windows too), so there is deliberately no write-only registry
     * here; the billiard tender path has its own registry and does validate,
     * in billiard-handoff.ts.
     */
    async paymentPreflight(orderId: string): Promise<{ success: boolean; token?: string; expiresAt?: number; error?: string }> {
      try {
        const normalizedOrderId = String(orderId || '').trim();
        if (!normalizedOrderId) {
          return { success: false, error: 'A stable POS order ID is required before payment preflight.' };
        }
        const database = await db();
        const scopeBefore = currentPosSnapshotScope(configStore.getRawConfig());
        const openShift = assertLocalOpenShiftMatchesSession(database as any, attachedPosStore as any);

        await verifyServerShift();
        shiftConsistency.assertConsistent();

        // Re-check what the await could have changed underneath us.
        const scopeAfter = currentPosSnapshotScope(configStore.getRawConfig());
        if (
          scopeAfter.salonId !== scopeBefore.salonId
          || scopeAfter.userId !== scopeBefore.userId
          || scopeAfter.registerId !== scopeBefore.registerId
        ) {
          return { success: false, error: 'POS user changed while payment safety was being verified.' };
        }
        const verifiedShift = assertLocalOpenShiftMatchesSession(database as any, attachedPosStore as any);
        if (verifiedShift.id !== openShift.id) {
          return { success: false, error: 'The POS shift changed while payment safety was being verified.' };
        }

        return {
          success: true,
          token: `pf-${(globalThis as any).crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
          expiresAt: Date.now() + 15 * 60 * 1000,
        };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    },
    holdCreateCurrent: async (id: string, title: string) =>
      holdOrders()?.createCurrent(id, title) ?? { success: false, error: 'POS is not ready.' },
    holdRecall: async (id: string) =>
      holdOrders()?.recall(id) ?? { success: false, error: 'POS is not ready.' },
    holdList: async () => holdOrders()?.list() ?? [],
    holdGet: async (id: string) => holdOrders()?.get(id) ?? null,
    holdRemove: async (id: string) =>
      holdOrders()?.remove(id) ?? { success: false, error: 'POS is not ready.' },
    attachPosStore(posStore: unknown) { attachedPosStore = posStore as ShimPosStore; },
    billiardPreflight: async () => billiardHandoff()?.preflight() ?? NO_HANDOFF,
    billiardPrepare: async (input) => billiardHandoff()?.prepare(input) ?? NO_HANDOFF,
    billiardRecover: async () => billiardHandoff()?.recover() ?? NO_HANDOFF,
    billiardMarkPaymentOpened: async (checkoutId) => billiardHandoff()?.markPaymentOpened(checkoutId) ?? NO_HANDOFF,
    billiardBeginTender: async (checkoutId, token) => billiardHandoff()?.beginTender(checkoutId, token) ?? NO_HANDOFF,
    billiardComplete: async (checkoutId, orderId) => billiardHandoff()?.complete(checkoutId, orderId) ?? NO_HANDOFF,
    billiardResolveUncertainTender: async (input) => billiardHandoff()?.resolveUncertainTender(input as any) ?? NO_HANDOFF,
    billiardInvalidateAuth: () => { handoff?.invalidateAuth(); },

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
        // Tenant switch: if a DIFFERENT salon was previously bound to this
        // device, wipe its local mirror before adopting the new identity —
        // otherwise the cashier could sell the previous salon's catalog or sync
        // its queued orders under the new salon (cross-tenant leak). Parity with
        // the Windows archive-then-clear on salon change (auth.module.ts:767-800).
        const previousSalonId = configStore.getRawConfig().salonId;
        if (
          previousSalonId
          && previousSalonId !== SYNTHETIC_AUTH_USER.salonId
          && previousSalonId !== authUser.salonId
        ) {
          // E-PARITY-1 cross-tenant guard: the PREVIOUS salon's pa_ key must
          // never connect THIS new salon's terminal to the old salon's
          // print-agent. Windows re-validates the stored key's salonId and
          // clears on mismatch (auth.module.ts:1009-1027); here we drop the key
          // on any salon change so the post-login connect() re-fetches the
          // correct salon's key via /print-agent/my-key. Also tears down any
          // socket still open to the old salon.
          await agentConnection.disconnect();
          // The previous salon's plan must not decide THIS salon's tabs. The
          // controller already refuses a record whose salonId differs, but drop
          // it here too so nothing stale sits in storage across the switch.
          entitlements.clear();
          // Abort the login if the wipe does not durably persist — otherwise
          // config (localStorage) would flip to salon B while salon A's catalog
          // image (IndexedDB) survives a failed flush, a cross-tenant leak on
          // the next boot. Do NOT swallow the flush error here.
          try {
            const database = await db();
            database.clearSalonData();
            await database.flush();
          } catch {
            return { success: false, error: 'Could not clear the previous salon data; login aborted to protect tenant isolation.' };
          }
        }
        // Store the staff JWT (NO pa_ key, NO /print-agent/connect — S1 §2.B rail).
        await tokenStore.setTokens(result.access_token, result.refresh_token ?? null);
        const salonSlug = resolveAuthSalonSlug(result);
        // setConfig side-effect (auth.module.ts:795), minus the print-agent auto-connect.
        // E2a: do NOT hard-seed 'retail' on every login — resolve the POS mode so a
        // salon boots salon (the Android/shared-layout fallback) and a retail-configured device
        // stays retail. The resolved value reflects the config the cashier already
        // has (device/driver choice authoritative); SHIM_CONTRACT_SALON_E2 §0.1.
        configStore.setConfig({
          authUser,
          salonId: authUser.salonId,
          salonName: authUser.salonName ?? '',
          salonSlug,
          posEnabled: true,
          posMode: resolvePosMode(configStore.getRawConfig()),
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
        // E-PARITY-1: connect to the print-agent exactly like Windows does after
        // login (fetch pa_ key → /print-agent/connect → open the socket). Fully
        // best-effort + non-blocking: a salon with no agent key, or an offline
        // agent, must NEVER fail or delay the cashier's login — the terminal
        // simply stays REST-only until the agent is reachable.
        void agentConnection.connect().catch(() => { /* connection is best-effort */ });
        orderDrain.start();
        return { success: true, data: { user: authUser } };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    },

    async getUser(): Promise<ShimGetUserResult> {
      // Every "still signed in" answer goes through here, so the drain is armed
      // in one place instead of at each return. A restored session is the
      // ordinary morning case (a cashier types a password once and then reopens
      // the app for weeks), and the cached-profile branches below are the
      // offline boot — precisely when a backlog of unsynced orders is waiting
      // for the network to come back. start() is idempotent.
      const authenticated = (user: AuthUser): ShimGetUserResult => {
        orderDrain.start();
        return { success: true, data: { isAuthenticated: true, user } };
      };
      const token = await tokenStore.getAccessToken();
      if (!token) {
        // No persisted token → not authenticated (first install / after logout).
        return { success: true, data: { isAuthenticated: false } };
      }
      syncSalonSlug();
      try {
        const raw = await client.getMe();
        const user = resolveAuthUser(raw, configStore.getRawConfig().salonName);
        return authenticated(user);
      } catch (err: any) {
        // Classify by HTTP status (getMe now attaches err.status), not by
        // regex-matching a message — a NestJS 401 body carries 'Unauthorized'
        // with no '401' substring, so the old regex misfired and left a dead
        // session logged in.
        if (err?.status === 401) {
          // refresh already ran inside the api-client 401-retry path.
          if (lastRefreshOutcome === 'transient') {
            // Transient refresh failure — fall back to the cached profile so a
            // startup network blip does not kick the cashier to login
            // (auth-get-user.ts:81-88, 103-108).
            const cached = configStore.getRawConfig().authUser;
            if (cached?.id) {
              return authenticated(cached);
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
          return authenticated(cached);
        }
        return { success: true, data: { isAuthenticated: false } };
      }
    },

    async logout() {
      // E-PARITY-1: tear down the print-agent socket + drop the pa_ key before
      // clearing the session (mirror Windows disconnect-on-logout).
      await agentConnection.disconnect();
      // Stop the billiard poll timer + drop its listeners on this explicit
      // teardown path (T4) — the 10s background refresh must not outlive the
      // session.
      billiard.dispose();
      handoff?.invalidateAuth();
      // Drop the cached plan: the next login may be a different salon, and its
      // tabs must be decided by ITS entitlements, never the previous session's.
      entitlements.clear();
      orderDrain.stop();
      shiftConsistency.reset();
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
    async getByCategory(categoryId): Promise<ShimPosProduct[]> {
      // E2a §2.A: salon service-grid reader (category-filtered catalog).
      return createProductRepo(await db()).getByCategory(categoryId);
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

        // Idempotent create (parity with pos.module.ts:3196-3208): a retried
        // create with the same client order id returns the existing order
        // instead of throwing a PK violation — otherwise the renderer would
        // re-ring under a new id and double-charge the customer.
        if (normalizedOrder.id && orderRepo.getById(normalizedOrder.id)) {
          if (durabilityFailedOrders.has(normalizedOrder.id)) {
            return {
              success: false,
              error: 'order-durability-failed: this order could not be persisted and its rollback also failed; restart the app before retrying.',
            };
          }
          return { success: true, id: normalizedOrder.id, duplicate: true } as any;
        }

        // Tender validation (E-PARITY-2). The trusted Sunmi terminal accepts the
        // same MANUAL tenders as the Windows salon counter (CASH/CARD/BLIK/
        // TRANSFER); only a genuinely unknown/unreadable tender is refused. Card
        // is cashier-attested (standalone terminal), so the backend P0-PAY-1 gap
        // is accepted on the same basis as Windows — see assertTenderAllowed +
        // the owner decision recorded in EXPANSION_PLAN_2026-07-19.md.
        const tenderError = assertTenderAllowed(normalizedOrder);
        if (tenderError) return { success: false, error: tenderError };

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

        // Local stock decrement — the billiard term is not optional: F&B is
        // consumed when it is added to the table session, so settling the bill
        // must not deduct it a second time (pos.module.ts guards the same loop
        // with the same predicate). The shared helper is imported rather than
        // restated inline because hand-copying this condition is exactly how the
        // guard went missing here in the first place.
        const allowNegative = (configStore.getRawConfig() as any).allowOversell === true;
        // Durability rollback needs the PRE-decrement rows, captured verbatim.
        // Arithmetic reverse (+quantity) would fabricate phantom stock whenever
        // the MAX(0, …) clamp below truncated the decrement, and
        // orderRepo.deleteLocalUnsynced is not reusable here (it refuses
        // billiard-origin orders outright and restocks on a DIFFERENT predicate
        // than shouldDecrementStockAtCheckout). The WebView is single-threaded
        // and this function runs synchronously between capture and rollback, so
        // no other writer can interleave.
        const stockSnapshot: Array<{ id: string; in_stock: number; available_qty: number }> = [];
        // Capture each variant AT MOST ONCE. The cart merges lines only when
        // variantId AND staffId AND course all match (pos-store.ts
        // cart/addItem), so one variant can legitimately span several lines —
        // the same service sold by two technicians. A per-line capture would
        // read the already-decremented value on the second pass and restore
        // short by that line's quantity.
        const snapshotted = new Set<string>();
        for (const item of normalizedItems) {
          if (shouldDecrementStockAtCheckout(item, Boolean(normalizedOrder.billiard_origin_json))) {
            const variantId = String(item.variant_id ?? '');
            if (variantId && !snapshotted.has(variantId)) {
              snapshotted.add(variantId);
              const before = database.get<{ in_stock: number; available_qty: number }>(
                'SELECT in_stock, available_qty FROM product_variants WHERE id = ?',
                [item.variant_id],
              );
              if (before) {
                stockSnapshot.push({
                  id: variantId,
                  in_stock: before.in_stock,
                  available_qty: before.available_qty,
                });
              }
            }
            // Guard on track_inventory (Windows STOCK_TRACKED_GUARD_SQL) so
            // services / non-inventory items are not driven to phantom 0 stock.
            database.run(
              allowNegative
                ? 'UPDATE product_variants SET in_stock = in_stock - ?, available_qty = available_qty - ? WHERE id = ? AND track_inventory = 1'
                : 'UPDATE product_variants SET in_stock = MAX(0, in_stock - ?), available_qty = MAX(0, available_qty - ?) WHERE id = ? AND track_inventory = 1',
              [item.quantity, item.quantity, item.variant_id],
            );
          }
        }

        // Paid orders must survive a crash — flush immediately (order-repo.ts:249-250).
        // This is the durability barrier: until it succeeds the sale is NOT
        // recorded, so a swallowed failure would tell the cashier a paid order
        // exists when it only lives in RAM. Windows awaits database.save() and
        // lets the failure surface; hold-orders.ts:117-128 fails closed on the
        // same barrier. Do the same here.
        let flushError: string | undefined;
        try {
          await database.flush();
        } catch (e: any) {
          flushError = e?.message || String(e);
        }

        if (flushError) {
          // Undo the whole create in memory: the order rows go away and every
          // captured variant row is written back verbatim (see stockSnapshot).
          let rollbackDurabilityError: string | undefined;
          try {
            database.transaction(() => {
              database.run('DELETE FROM order_items WHERE order_id = ?', [id]);
              database.run('DELETE FROM orders WHERE id = ?', [id]);
              for (const row of stockSnapshot) {
                database.run(
                  'UPDATE product_variants SET in_stock = ?, available_qty = ? WHERE id = ?',
                  [row.in_stock, row.available_qty, row.id],
                );
              }
            });
            try {
              await database.flush();
            } catch (e: any) {
              // The row is gone from memory (a retry still re-creates cleanly),
              // but the persisted image is stale/unknown — say so.
              rollbackDurabilityError = e?.message || String(e);
            }
          } catch (e: any) {
            // sql.js should not fail on in-memory DELETE/UPDATE, but if it did
            // the order row survives and the duplicate-by-id guard above would
            // answer a retry with a lying {success:true, duplicate:true}.
            if (id) durabilityFailedOrders.add(String(id));
            rollbackDurabilityError = e?.message || String(e);
          }
          const failure: Record<string, unknown> = {
            success: false,
            error: `order-durability-failed: ${flushError}`,
          };
          if (rollbackDurabilityError) failure.rollbackDurabilityError = rollbackDurabilityError;
          return failure as { success: boolean; error: string };
        }

        // E2a §2.D: salon sales best-effort close each technician's turn on the
        // nail-turn board (mode:'salon' only). Fire-and-forget + swallowed — it
        // no-ops when the board is absent, so it can never break the sale.
        // Success path only — a rolled-back order must not touch the board.
        void syncNailTurnCheckoutForOrder(normalizedOrder, normalizedItems);
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
            if (!order.billiard_origin_json) {
              // Finalize immediately — triggers backend stock deduction
              // (order-sync.ts:230-238). finishOrder failure is non-fatal.
              try {
                const finishResult = await client.finishOrder(backendId);
                backendOrderNumber = getBackendOrderNumber(finishResult) ?? backendOrderNumber;
              } catch { /* non-fatal, matches Windows */ }
            }
            // else: the authoritative billiard create endpoint atomically
            // creates a DELIVERED order AND settles the checkout, so calling
            // finish again is a false failure ("already finished") —
            // order-sync.ts:241-256.
            orderRepo.markSynced(order.id, backendId, backendOrderNumber);
            // The frozen checkout is now settled server-side; close the local
            // journal so recovery stops offering it (order-sync.ts:258-262).
            const settledHandoff = createBilliardHandoffRepo(database).getByOrderId(order.id);
            if (settledHandoff?.state === 'POS_PAID_SYNC_PENDING') {
              createBilliardHandoffRepo(database).markState(settledHandoff.checkoutId, 'SETTLED');
            }
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

    /** Android-only: the in-progress cart, persisted beside orders so ONE
     *  durability barrier covers both. Failures are swallowed — a snapshot that
     *  cannot be written must never break a sale in progress. */
    async posSnapshotSave(json: string): Promise<void> {
      try {
        const database = await db();
        createPosSnapshotRepo(database).save(POS_SNAPSHOT_CART_KEY, json);
        await database.flush();
      } catch { /* snapshotting is best-effort */ }
    },
    async posSnapshotLoad(): Promise<string | null> {
      try {
        return createPosSnapshotRepo(await db()).load(POS_SNAPSHOT_CART_KEY);
      } catch {
        return null;
      }
    },
    async posSnapshotClear(): Promise<void> {
      try {
        const database = await db();
        createPosSnapshotRepo(database).clear(POS_SNAPSHOT_CART_KEY);
        await database.flush();
      } catch { /* best-effort */ }
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
    getServerOrders: async (params: any) => {
      const limit = params?.limit ?? 20;
      const unconfigured = { orders: [], items: {}, total: 0, page: 1, limit, source: 'unconfigured' as const };
      // Windows parity (pos.module.ts:6971-6978): no token → 'unconfigured',
      // not an error.
      const token = await tokenStore.getAccessToken().catch(() => null);
      if (!token) return unconfigured;
      try {
        const data = await client.getServerOrders(params ?? {});
        const itemsMap: Record<string, any[]> = {};
        const orders = data.orders.map((s: any) => {
          const adapted = adaptServerOrder(s);
          if (Array.isArray(s.items)) {
            itemsMap[adapted.id] = s.items.map((item: any) => adaptServerOrderItem(item, adapted.id, s));
          }
          return adapted;
        });
        return { orders, items: itemsMap, total: data.total, page: data.page, limit: data.limit, source: 'server' as const };
      } catch (err: any) {
        return { orders: [], items: {}, total: 0, page: 1, limit, source: 'network-error' as const, error: err?.message ?? String(err) };
      }
    },

    /** Cancel a not-yet-synced order: delete it locally + restock so it is
     *  never pushed to the backend (the S2 stub returned a fake success and
     *  let the "cancelled" order sync anyway). A synced order is refused. */
    /** Recover a shelved (business-rejected or attempt-capped) order: reset it
     *  to pending, then drain. Returns the SyncFailurePanel shape
     *  ({result:{status}}) the renderer checks — the S2 stub lied success and
     *  left the order shelved forever. */
    async retryOrderSync(orderId: string): Promise<{ success: boolean; result?: { status: string; error?: string }; error?: string }> {
      const database = await db();
      const reset = createOrderRepo(database).resetForRetry(orderId);
      if (!reset) {
        return { success: true, result: { status: 'failed', error: 'Order is not in a retryable state' } };
      }
      await (transport.syncOrders?.() ?? Promise.resolve());
      const order = createOrderRepo(await db()).getById(orderId);
      if (order?.synced === 1) return { success: true, result: { status: 'synced' } };
      return { success: true, result: { status: 'failed', error: order?.sync_error ?? 'Retry did not sync' } };
    },
    async cancelOrder(orderId: string): Promise<{ success: boolean; restocked?: number; error?: string }> {
      const database = await db();
      const result = createOrderRepo(database).deleteLocalUnsynced(orderId);
      await database.flush().catch(() => { /* debounced flush still pending */ });
      if (!result.deleted) return { success: false, error: result.error };
      return { success: true, restocked: result.restocked };
    },
    async deleteLocalOrder(orderId: string): Promise<{ success: boolean; restocked?: number; error?: string }> {
      const database = await db();
      const result = createOrderRepo(database).deleteLocalUnsynced(orderId);
      await database.flush().catch(() => { /* debounced flush still pending */ });
      if (!result.deleted) return { success: false, restocked: 0, error: result.error };
      return { success: true, restocked: result.restocked };
    },

    // ── Refund (E1b — ported pos.module.ts:3727-3892, minus the Windows DTO
    //    rebuild + response validator). The renderer-built refund DTO is POSTed
    //    VERBATIM (the renderer builds it — see the E1b report for the
    //    request-unit note); on success the local order is marked refunded and
    //    the restock:true lines are restocked (track_inventory=1 only).
    async refundOrder(orderId: string, dto: any): Promise<{
      success: boolean;
      refundedLines?: any[];
      refundAmount?: number;
      receiptPrinted?: boolean;
      mutationDetected?: boolean;
      requiresRefresh?: boolean;
      error?: string;
    }> {
      try {
        const database = await db();
        const orderRepo = createOrderRepo(database);

        // Order must exist + be synced (pos.module.ts:3729-3732). An unsynced
        // order has no backend identity to refund against — cancelling it
        // locally (cancelOrder) is the correct action, not a server refund.
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced to server yet' };
        if (order.status === 'REFUNDED') return { success: false, error: 'Order already fully refunded' };

        // Refunds are shift-scoped — an active shift is required (pos.module.ts:3743-3746).
        if (!orderRepo.getActiveShift()) {
          return { success: false, error: 'Cannot refund without an active shift. Open a shift first.' };
        }

        const token = await tokenStore.getAccessToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        // POST the renderer-built refund DTO verbatim (pass-through).
        const result: any = await client.refundOrder(order.backend_id, dto);
        if (result === null) return { success: false, error: 'Refund endpoint not available' };

        // Resolve the cumulative refunded grosze + FULL/PARTIAL status. Windows
        // derives these from validateRefundBackendResponse; the Android port does
        // not rebuild that validator. Prefer the backend's cumulative
        // totalRefundedAmount (PLN→grosze), else alreadyRefunded + the requested
        // delta, else the cashier-requested amount.
        const alreadyRefunded = order.refund_amount ?? 0;
        const orderTotal = order.total ?? 0;
        const linesTotalGrosze = Array.isArray(dto?.lines)
          ? dto.lines.reduce((s: number, l: any) => s + (Number(l?.refundAmount) || 0), 0)
          : 0;
        const requestedAmountGrosze = dto?.type === 'FULL'
          ? Math.max(0, orderTotal - alreadyRefunded)
          : (Number(dto?.amount) || linesTotalGrosze);
        const plnToGrosze = (v: unknown): number | null => {
          if (v == null) return null;
          const n = typeof v === 'number' ? v : parseFloat(String(v));
          return Number.isFinite(n) ? Math.round(n * 100) : null;
        };
        const cumulativeFromBackend = plnToGrosze(result?.totalRefundedAmount);
        const refundedAmount = cumulativeFromBackend ?? (alreadyRefunded + requestedAmountGrosze);
        const status: 'FULL' | 'PARTIAL' =
          result?.status === 'REFUNDED' || (requestedAmountGrosze >= orderTotal && orderTotal > 0)
            ? 'FULL'
            : 'PARTIAL';
        const refundReason = result?.refundReason || dto?.reason || '';

        // Mark refunded locally + restock the restock:true lines (track_inventory=1
        // only — the local mirror; the backend deducts server-side too). One
        // transaction so a partial failure cannot leave the order marked refunded
        // with un-restocked stock.
        database.transaction(() => {
          orderRepo.markRefunded(orderId, refundedAmount, refundReason, status, dto?.lines);
          if (Array.isArray(dto?.lines)) {
            for (const line of dto.lines) {
              const qty = Number(line?.quantity) || 0;
              if (line?.restock && line.variantId && qty > 0) {
                database.run(
                  'UPDATE product_variants SET in_stock = in_stock + ?, available_qty = available_qty + ? WHERE id = ? AND track_inventory = 1',
                  [qty, qty, line.variantId],
                );
              }
            }
          }
        });
        await database.flush().catch(() => { /* debounced flush still pending */ });

        // Renderer-shaped result. refundAmount is PLN (the renderer grosses it up
        // via toGrosze); fall back to the requested grosze/100. No auto-print —
        // the cashier prints the refund receipt via printRefundReceipt (E1a).
        return {
          success: true,
          refundedLines: Array.isArray(result?.refundedLines) ? result.refundedLines : undefined,
          refundAmount: result?.refundAmount ?? requestedAmountGrosze / 100,
          receiptPrinted: false,
        };
      } catch (e: any) {
        const detail = e?.message || e?.code || (typeof e === 'string' ? e : '') || 'Refund failed';
        return { success: false, error: detail };
      }
    },

    // ── Invoicing (E3a — ported pos.module.ts:3924-3981, minus the Windows
    //    logger). NIP/GUS lookup + attach-invoice + generate-proforma, all
    //    staff-JWT over the b2b/pos routes. addInvoice/generateProforma require a
    //    SYNCED order (backend_id present) — an unsynced order has no backend
    //    identity to invoice against, so it is refused before any HTTP call
    //    (PATCHing a local id the backend has never seen would 404 every time).
    async lookupNip(nip: string): Promise<{ success: boolean; data?: any; error?: string }> {
      try {
        const token = await tokenStore.getAccessToken();
        if (!token) return { success: false, error: 'Not authenticated' };
        // Sanitize + validate the NIP exactly like the Windows handler
        // (pos.module.ts:3974-3975): digits only, must be exactly 10 long.
        const cleanNip = String(nip ?? '').replace(/\D/g, '');
        if (cleanNip.length !== 10) return { success: false, error: 'NIP must be 10 digits' };
        const data = await client.lookupCustomerByNip(cleanNip);
        return { success: true, data };
      } catch (e: any) {
        // 404 (no such NIP in GUS), other 4xx/5xx, or network — the api-client
        // attaches err.status; map every throw to the renderer {success:false}.
        return { success: false, error: e?.message || String(e) };
      }
    },
    async addInvoice(
      orderId: string,
      data: { customerNip: string; invoiceType?: 'VAT' | 'PROFORMA' },
    ): Promise<{ success: boolean; order?: any; error?: string }> {
      try {
        const database = await db();
        const orderRepo = createOrderRepo(database);
        // Order must exist + be synced (pos.module.ts:3926-3928). An unsynced
        // order has no backend identity to attach an invoice against — refuse it
        // with NO HTTP call rather than PATCHing a local id the backend has
        // never seen.
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced to server yet' };

        const token = await tokenStore.getAccessToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        // Sanitize + validate the NIP (pos.module.ts:3933-3934).
        const nip = String(data?.customerNip ?? '').replace(/\D/g, '');
        if (nip.length !== 10) return { success: false, error: 'NIP must be 10 digits' };

        // Pass the renderer DTO through (the api-client adds the invoiceType
        // default); do not rebuild it from the local order row.
        const result: any = await client.addInvoiceToOrder(order.backend_id, {
          customerNip: nip,
          invoiceType: data?.invoiceType,
        });

        // Persist the invoiced NIP locally so getDetail reflects it
        // (pos.module.ts:3941). If the backend response carries a new status,
        // reflect that too — the Windows handler does not, but the task asks for
        // it conditionally (only when the response says so).
        database.transaction(() => {
          database.run('UPDATE orders SET customer_nip = ? WHERE id = ?', [nip, orderId]);
          const newStatus = result?.order?.status ?? result?.status;
          if (typeof newStatus === 'string' && newStatus.trim()) {
            database.run('UPDATE orders SET status = ? WHERE id = ?', [newStatus, orderId]);
          }
        });
        await database.flush().catch(() => { /* debounced flush still pending */ });

        return { success: true, order: result };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    },
    async generateProforma(orderId: string): Promise<{ success: boolean; proforma?: any; error?: string }> {
      try {
        const database = await db();
        const orderRepo = createOrderRepo(database);
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced to server yet' };

        const token = await tokenStore.getAccessToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        const result: any = await client.generateProforma(order.backend_id);
        // No local mutation — Windows returns the proforma as-is.
        return { success: true, proforma: result };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
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

    // ── Salon mode (E2a) — getByCategory is defined with the other catalog
    //    readers above; syncStaff + schedule/nail-turn reads follow. ─────────
    /** Pull the salon technicians (GET /api/v1/staff, staff JWT), replace the
     *  local staff table, emit onStaffUpdated so the SalonTemplate per-line
     *  picker refreshes. Non-fatal: a failed pull keeps the local cache. */
    async syncStaff(): Promise<{ success: boolean; count?: number; error?: string }> {
      const token = await tokenStore.getAccessToken();
      if (!token) return { success: false, error: 'no-auth' };
      let profiles: any[];
      try {
        profiles = await client.getStaffProfiles();
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
      // normalizeStaffRow maps every observed backend shape (camelCase /
      // snake_case / split names / 0–100 commission) onto the staff table
      // columns, dropping rows without an id+name.
      const rows = (Array.isArray(profiles) ? profiles : [])
        .map((p: any) => normalizeStaffRow(p))
        .filter((r): r is NonNullable<typeof r> => r !== null);
      // Windows guard (staff-sync.ts "No usable staff rows returned"): zero
      // usable rows must NOT touch the table. bulkUpsertStaff is DELETE-ALL +
      // insert, so replacing with [] would wipe the roster — including the
      // login-seeded cashier — and lock the shift dialog on "no active staff".
      if (rows.length === 0) {
        return { success: false, error: 'no-usable-staff-rows' };
      }
      const database = await db();
      createOrderRepo(database).bulkUpsertStaff(rows);
      await database.flush().catch(() => { /* debounced flush still pending */ });
      for (const cb of [...staffUpdatedListeners]) {
        try { cb({ count: rows.length }); } catch { /* listener isolation */ }
      }
      return { success: true, count: rows.length };
    },

    // ── Schedule + nail-turn board (E2c reads) — dark-launch safe ───────────
    // The api-client darkLaunch* helpers return null on 403/404/501/network, so
    // an undeployed salon transparently hides these panels (unavailable:true).
    async getNailTurnBoard() {
      const board = await client.getNailTurnBoard().catch(() => null);
      return board ? { success: true, board } : { success: false, unavailable: true };
    },
    async getPosScheduleToday(date?: string) {
      const schedule = await client.getPosScheduleToday(date).catch(() => null);
      return schedule ? { success: true, schedule } : { success: false, unavailable: true };
    },
    async getPosScheduleWeek(from?: string, days?: number) {
      const week = await client.getPosScheduleWeek(from, days).catch(() => null);
      return week ? { success: true, week } : { success: false, unavailable: true };
    },
    async setPosScheduleStaffStatus(payload: any) {
      const schedule = await client
        .setPosScheduleStaffStatus(payload.staffProfileId, {
          status: payload.status,
          idempotencyKey: payload.idempotencyKey,
        })
        .catch(() => null);
      return schedule ? { success: true, schedule } : { success: false, unavailable: true };
    },
    async assignPosScheduleNext(payload: any) {
      const schedule = await client
        .assignPosScheduleNext(payload.checkinLogId, payload)
        .catch(() => null);
      return schedule ? { success: true, schedule } : { success: false, unavailable: true };
    },
    async requestPosScheduleStaff(payload: any) {
      const schedule = await client
        .requestPosScheduleStaff(payload.checkinLogId, payload)
        .catch(() => null);
      return schedule ? { success: true, schedule } : { success: false, unavailable: true };
    },
    async getActiveShift(): Promise<{ success: boolean; shift?: { id: string; staff_id: string | null; staff_name: string | null; opened_at: string } | null; error?: string }> {
      const active = createOrderRepo(await db()).getActiveShift();
      if (!active) return { success: false, error: 'no-active-shift' };
      return { success: true, shift: { id: active.id, staff_id: active.staff_id, staff_name: active.staff_name, opened_at: active.opened_at } };
    },

    // ── Remote receipt COPY print (E1a) — delegated to the coordinator ──────
    async requestReceiptPrint(orderId, options) {
      return printCoordinator().requestReceiptPrint(orderId, options);
    },
    async getPrinterStatus() {
      return printCoordinator().getPrinterStatus();
    },

    // ── Remote FISCAL receipt print (E-FISCAL) — delegated to the coordinator.
    //    Same staff-JWT /print-agent/jobs route, role FISCAL_RECEIPT,
    //    printerType FISCAL. The coordinator owns the fiscal status mapping
    //    (NEVER auto-retries an uncertain job). hasFiscalPrinter (stubs.ts)
    //    resolves `configured`+`connected` from getFiscalPrinterStatus.assigned.
    async requestFiscalPrint(orderId) {
      return printCoordinator().requestFiscalPrint(orderId);
    },
    async getFiscalPrinterStatus() {
      return printCoordinator().getFiscalPrinterStatus();
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
    onStaffUpdated(cb: (data?: { count?: number } | undefined) => void): () => void {
      staffUpdatedListeners.add(cb);
      return () => { staffUpdatedListeners.delete(cb); };
    },
    onNailTurnsUpdated(cb: (data: { orderId?: string; checkedOut?: number }) => void): () => void {
      nailTurnsUpdatedListeners.add(cb);
      return () => { nailTurnsUpdatedListeners.delete(cb); };
    },
  };

  return transport;
}
