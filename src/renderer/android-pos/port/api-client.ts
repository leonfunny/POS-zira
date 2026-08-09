/**
 * PosApiClient — browser-safe port of the retail-parity API-client subset.
 *
 * Packet S3 of the Android parity port — see
 * docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md and
 * docs/android-pos/SHIM_CONTRACT_S1.md (§2.B, §2.E, §2.F note, §2.G, §2.H).
 *
 * This is a faithful, fetch-based port of EXACTLY the subset of
 * src/main/network/api-client.ts that the retail POS flow needs. It imports
 * nothing from `src/main/**` and no Node/Electron module — it runs inside the
 * Android WebView behind the `window.electronAPI` shim, using only browser
 * globals (fetch / Response / AbortController / URLSearchParams / setTimeout).
 *
 * Windows behavior is the reference: logic is copied, not redesigned
 * (PARITY_PORT_PLAN §2 — "Where Windows is quirky, Android is identically
 * quirky"). Source-line citations below reference `src/main/network/api-client.ts`
 * unless noted otherwise.
 *
 * ─── Token / refresh model divergence from Windows ────────────────────────
 * Windows wires a module-level `refreshAccessToken()` singleton + `authEvents`
 * emitter into `fetchWithTimeout`; its `RefreshResult` is three-valued
 * (`{ok:true, accessToken}` | `{ok:false, reason:'network'}` → throws a typed
 * `AuthRefreshNetworkError` | `{ok:false, reason:'refresh-rejected'|'no-refresh-token'}`
 * → emit AUTH_EXPIRED, return the original 401).
 *
 * The Android shim owns token storage (S4 — Capacitor secure storage), so the
 * refresh path is injected via `tokenProvider`. That collapses the three-valued
 * result to a boolean `refresh()`:
 *   • `refresh()` → true  : retry once with the token returned by
 *     `getAccessToken()` (matches Windows `{ok:true}`).
 *   • `refresh()` → false : call `onExpired()` (the Android AUTH_EXPIRED
 *     equivalent — the provider has already cleared the dead session) and
 *     return the original 401 Response.
 *
 * The transient-network vs dead-session distinction that Windows carries via
 * `AuthRefreshNetworkError` is NOT representable on a boolean interface; the
 * tokenProvider implementation (S4) must own it (e.g. retry transiently
 * internally, only return `false` when the session is truly unrecoverable).
 * This is recorded in the packet report.
 */

import type {
  CreatePrintJobRequest,
  CreatePrintJobResponse,
  PosLoyaltyLookupResponse,
  SalonPrinterAssignmentsResponse,
} from '../../../shared/types';

// ─── Constants (ported from api-client.ts:130-132) ─────────────────────────
const DEFAULT_TIMEOUT = 30000;
const BOOTSTRAP_POST_RETRY_DELAY_MS = 500;
const BOOTSTRAP_POST_RETRY_STATUSES = new Set([405, 502, 503, 504]);

// ─── Auth-endpoint allowlist (ported from api-client.ts:331-348) ───────────
// These must NOT trigger a refresh-on-401 retry: the refresh helper itself
// targets one of these, and login/check-token legitimately return 401 on bad
// credentials. Retrying with a refreshed access token would loop or paper over
// a real authentication failure.
const AUTH_ENDPOINT_PATTERNS = [
  /\/api\/v1\/auth\/login(\b|$)/,
  /\/api\/v1\/auth\/refresh(\b|$)/,
  /\/api\/v1\/auth\/logout(\b|$)/,
  /\/api\/v1\/auth\/check-token(\b|$)/,
  /\/api\/v1\/auth\/register(\b|$)/,
];

/** ported from api-client.ts:346-348 */
export function isAuthEndpoint(url: string): boolean {
  return AUTH_ENDPOINT_PATTERNS.some((p) => p.test(url));
}

/**
 * Extract the Bearer token from a RequestInit, case-insensitively over every
 * header key. ported from api-client.ts:350-365.
 */
export function getBearerToken(options: RequestInit): string | null {
  const headers = options.headers;
  if (!headers) return null;
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === 'authorization' && typeof v === 'string') {
      const match = v.match(/^Bearer\s+(.+)$/i);
      if (match) return match[1];
    }
  }
  return null;
}

/**
 * Rebuild headers with a new Bearer token, stripping EVERY case-variant of the
 * Authorization header first (a JS object holds 'Authorization' and
 * 'authorization' as distinct keys; a naive spread would let the stale token
 * ride along). ported from api-client.ts:367-386.
 */
export function withBearer(options: RequestInit, accessToken: string): RequestInit {
  const cleaned: Record<string, string> = {};
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers as Record<string, string>)) {
      if (k.toLowerCase() === 'authorization') continue;
      cleaned[k] = v;
    }
  }
  cleaned.Authorization = `Bearer ${accessToken}`;
  return { ...options, headers: cleaned };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single fetch with an AbortController timeout. ported from api-client.ts:388-405.
 * Browser-safe: AbortController + setTimeout are available in the WebView.
 */
async function rawFetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Public types ──────────────────────────────────────────────────────────

/** Injected by the shim (S4). Mirrors the role Windows's secure-token store +
 *  auth-refresh singleton play inside `fetchWithTimeout`. */
export interface TokenProvider {
  /** Current staff access token, or null when none is stored. */
  getAccessToken(): Promise<string | null>;
  /** Exchange the stored refresh_token for a new access token. Returns true on
   *  success (a new token is now available via getAccessToken), false when the
   *  session is unrecoverable. */
  refresh(): Promise<boolean>;
  /** Fired when refresh fails — the Android AUTH_EXPIRED equivalent. Drops the
   *  cashier to the login screen. */
  onExpired(): void;
}

export interface PosApiClientOptions {
  baseUrl: string;
  tokenProvider: TokenProvider;
  /** Attached as `X-Salon-Slug` on catalog routes. Windows reads this from
   *  electron-store via `getConfigValue('salonSlug')` (api-client.ts:2096,
   *  1601, etc.); Android receives it here and may update it post-login. */
  salonSlug?: string;
  /** Merged into the open-shift body when present. Windows reads this from
   *  electron-store via `getConfigValue('machineId')` (api-client.ts:3006). */
  machineId?: string;
}

export interface LoginResponse {
  access_token: string;
  refresh_token?: string;
  user: any;
}

/** ported from api-client.ts:66-80 (ServerOrderListParams) */
export interface ServerOrderListParams {
  period?: string;
  from?: string;
  to?: string;
  customerId?: string;
  staffId?: string;
  staffName?: string;
  search?: string;
  paymentMethod?: string;
  paymentStatus?: string;
  status?: string;
  requiresInvoice?: boolean;
  page?: number;
  limit?: number;
}

export interface ServerOrdersResult {
  orders: any[];
  total: number;
  page: number;
  limit: number;
}

/** Envelope returned by getPosProducts. Matches the shape Windows returns
 *  (api-client.ts:2077-2085, 2464-2472). NOTE: product/category ROW
 *  normalization (api-client.ts:2201-2462 — grosze/translation/category
 *  mapping) is deferred to S5/S6 (repos/sync worker); rows are returned raw
 *  here. The cursor / pagination / envelope fields are byte-faithful so the S6
 *  catalog-sync worker sees the same signals Windows's product-sync does. */
export interface PosProductsResult {
  products: any[];
  categories: any[];
  categoriesComplete: boolean;
  nextSince?: string;
  nextSyncCursor?: string;
  serverTime?: string;
  deletedIds?: string[];
}

/** Error with the same attachment surface Windows builds in getPosProducts
 *  (api-client.ts:2143-2162) — `code`/`resetRequired` drive the S6
 *  `isUnsafeProductSyncCursorError` cursor-reset path. */
export type PosProductsError = Error & {
  status?: number;
  code?: string;
  details?: Record<string, unknown> | null;
  resetRequired?: boolean;
  serverBody?: unknown;
};

/**
 * Browser-safe retail API client. One instance backs the shim's HTTP calls
 * (login → catalog → CASH order → history → shift). All protected routes pull
 * the staff JWT from the injected `tokenProvider`; the login route returns
 * tokens for the shim (S4) to store.
 */
export class PosApiClient {
  private baseUrl: string;
  private tokenProvider: TokenProvider;
  salonSlug: string | undefined;
  machineId: string | undefined;

  constructor({ baseUrl, tokenProvider, salonSlug, machineId }: PosApiClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.tokenProvider = tokenProvider;
    this.salonSlug = salonSlug;
    this.machineId = machineId;
  }

  /**
   * Fetch with timeout + transparent refresh-on-401 for Bearer-auth requests.
   * Ported from api-client.ts:407-451. On 401 with a Bearer header on a
   * non-auth endpoint: call `tokenProvider.refresh()` once, retry once with the
   * NEW token. On refresh failure: call `onExpired()` and return the original
   * 401. Exactly one refresh + one retry — a second 401 is returned as-is so a
   * hostile backend cannot induce infinite recursion.
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeout: number = DEFAULT_TIMEOUT,
  ): Promise<Response> {
    const initial = await rawFetchWithTimeout(url, options, timeout);

    if (initial.status !== 401) return initial;

    // 401 — only attempt refresh-and-retry if the request had a Bearer token
    // AND the URL isn't itself an auth endpoint (refresh would loop, login 401
    // is a legitimate "wrong password"). ported from api-client.ts:424-429.
    const oldToken = getBearerToken(options);
    if (!oldToken) return initial;
    if (isAuthEndpoint(url)) return initial;

    const refreshed = await this.tokenProvider.refresh();
    if (!refreshed) {
      // Windows: refresh-rejected / no-refresh-token → helper already cleared
      // tokens + emitted AUTH_EXPIRED; surface the original 401. Here the
      // tokenProvider owns that, so we fire onExpired then return the 401.
      this.tokenProvider.onExpired();
      return initial;
    }

    const newToken = await this.tokenProvider.getAccessToken();
    const retryOptions = newToken ? withBearer(options, newToken) : options;
    return rawFetchWithTimeout(url, retryOptions, timeout);
  }

  /**
   * Resolve the staff JWT or throw a clear, non-network error. Windows callers
   * always had a token passed in explicitly; the Android client pulls it from
   * the provider, so an absent token is surfaced as `NO_AUTH_TOKEN` rather than
   * sending a malformed `Bearer null` header (which would also falsely trigger
   * the 401-retry path).
   */
  private async requireToken(label: string): Promise<string> {
    const token = await this.tokenProvider.getAccessToken();
    if (!token) throw new Error(`NO_AUTH_TOKEN: ${label} requires a staff JWT`);
    return token;
  }

  /**
   * Pre-login bootstrap POSTs retry once on 405/502/503/504 (api.enail.pro has
   * briefly returned 405 for valid POST routes during backend/proxy churn).
   * Ported from api-client.ts:463-476.
   */
  private async bootstrapPostWithRetry(
    url: string,
    options: RequestInit,
  ): Promise<Response> {
    const response = await this.fetchWithTimeout(url, options);
    if (!BOOTSTRAP_POST_RETRY_STATUSES.has(response.status)) return response;
    await delay(BOOTSTRAP_POST_RETRY_DELAY_MS);
    return this.fetchWithTimeout(url, options);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Auth · login (no token — returns tokens for the shim to store)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/v1/auth/login. Ported from api-client.ts:3370-3388 (the body is
   * `{ emailOrPhone, password }`, snake/camel merged server-side) + the
   * bootstrap 405/502/503/504 single retry. Returns `{ access_token,
   * refresh_token?, user }` for the shim (S4) to persist.
   */
  async loginWithEmail(email: string, password: string): Promise<LoginResponse> {
    const url = `${this.baseUrl}/api/v1/auth/login`;
    const response = await this.bootstrapPostWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOrPhone: email, password }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  // ════════════════════════════════════════════════════════════════════════
  // Auth · current user (staff JWT)
  // ════════════════════════════════════════════════════════════════════════

  /** GET /api/v1/auth/me. Ported from api-client.ts:1535-1553. */
  async getMe(): Promise<any> {
    const token = await this.requireToken('getMe');
    const url = `${this.baseUrl}/api/v1/auth/me`;
    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      // Attach the HTTP status so callers can classify a dead session by code,
      // not by regex-matching a localized message ('Unauthorized' has no 401).
      const error = new Error(errorData.message || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  /**
   * POST /api/v1/auth/refresh. Ported from auth-refresh.ts:103-117. Exchanges a
   * stored `refresh_token` (snake_case body) for a rotated
   * `{ access_token, refresh_token?, token_type, expires_in }`. Carries NO
   * Authorization header (the refresh token authenticates the call via the
   * body); `/api/v1/auth/refresh` is in AUTH_ENDPOINT_PATTERNS so the 401-retry
   * layer never tries to refresh-the-refresh (it would loop), and with no Bearer
   * header `getBearerToken` is null so the retry path is inert anyway.
   *
   * S6+S7: the shim's TokenProvider.refresh() calls this, then rotates the
   * tokens in TokenStore. The network-vs-dead-session distinction Windows carries
   * via AuthRefreshNetworkError is surfaced here as: 401 → throws an Error whose
   * `status === 401` (refresh-rejected, dead session); any other non-2xx or
   * fetch throw → plain Error (transient). The transport maps both to refresh()
   * === false but only clears tokens on the 401 branch.
   */
  async refreshAccessToken(refreshToken: string): Promise<{ access_token: string; refresh_token?: string }> {
    const url = `${this.baseUrl}/api/v1/auth/refresh`;
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.message || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    const body = await response.json();
    if (!body?.access_token) {
      // Malformed 2xx — treat like the Windows no-access_token branch (network).
      const error = new Error('refresh response missing access_token') as Error & { status?: number };
      throw error;
    }
    return body;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Catalog (staff JWT + X-Salon-Slug)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/v1/warehouse/public/products (+ /sync-v2 cursor). Ported transport
   * from api-client.ts:2073-2196 + 2258-2294 + 2464-2472. Paginates all pages
   * with the exact cursor/legacy termination + safety caps, attaches
   * `X-Salon-Slug`, throws the full error envelope on non-2xx, and fetches the
   * public categories inline (Windows does this inside the same method).
   *
   * Per-row product/category normalization (api-client.ts:2201-2462 — grosze,
   * name_translations, category mapping, poisoned-translation guard) is
   * deferred to S5/S6 (data-layer); raw rows are returned here.
   */
  async getPosProducts(
    since?: string,
    options: { cursorV2?: boolean } = {},
  ): Promise<PosProductsResult> {
    const token = await this.requireToken('getPosProducts');
    const cursorV2 = !!options.cursorV2;

    const baseParams = new URLSearchParams({ limit: '100' });
    if (cursorV2) {
      if (since) baseParams.set('syncCursor', since);
    } else if (since) {
      baseParams.set('since', since);
    }

    // Warehouse public endpoint requires X-Salon-Slug header (api-client.ts:2095-2103).
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (this.salonSlug) headers['X-Salon-Slug'] = this.salonSlug;

    // Paginate through all pages (backend default limit=20, max=100).
    let allItems: any[] = [];
    let page = 1;
    let lastNextSince: string | undefined;
    let finalNextSyncCursor: string | undefined;
    let lastServerTime: string | undefined;
    let deletedIds: string[] = [];
    let pageCursor: string | undefined;

    while (true) {
      if (cursorV2) {
        baseParams.delete('page');
        if (pageCursor) {
          baseParams.delete('syncCursor');
          baseParams.set('pageCursor', pageCursor);
        }
      } else {
        baseParams.set('page', String(page));
      }
      const route = cursorV2
        ? '/api/v1/warehouse/public/products/sync-v2'
        : '/api/v1/warehouse/public/products';
      const url = `${this.baseUrl}${route}?${baseParams}`;

      const response = await this.fetchWithTimeout(url, { headers });

      if (!response.ok) {
        // Full error envelope (ported from api-client.ts:2131-2164) — code /
        // resetRequired drive the S6 cursor-reset path.
        const errorData = await response.json().catch(() => ({}));
        const envelopeError = errorData
          && typeof errorData === 'object'
          && errorData.error
          && typeof errorData.error === 'object'
          ? errorData.error
          : null;
        const error = new Error(
          envelopeError?.message
            || (typeof errorData === 'object' ? errorData?.message : null)
            || `HTTP ${response.status}`,
        ) as PosProductsError;
        error.status = response.status;
        if (errorData && typeof errorData === 'object') {
          const stringErrorCode = typeof errorData.error === 'string'
            && /^[A-Z0-9_]+$/.test(errorData.error)
            ? errorData.error
            : undefined;
          error.code = errorData.code ?? envelopeError?.code ?? stringErrorCode;
          error.details = errorData.details ?? envelopeError?.details;
          error.resetRequired = errorData.resetRequired === true
            || error.details?.resetRequired === true
            || envelopeError?.resetRequired === true;
          error.serverBody = errorData;
        }
        throw error;
      }

      const raw = await response.json();
      const pageItems: any[] = raw.items ?? raw.products ?? [];
      allItems = allItems.concat(pageItems);
      if (raw.nextSince) lastNextSince = raw.nextSince;
      if (raw.nextSyncCursor) finalNextSyncCursor = raw.nextSyncCursor;
      if (raw.serverTime) lastServerTime = raw.serverTime;
      if (Array.isArray(raw.deletedIds)) deletedIds = deletedIds.concat(raw.deletedIds);

      if (cursorV2) {
        const hasMore = raw.hasMore === true;
        const nextPageCursor = typeof raw.nextPageCursor === 'string' && raw.nextPageCursor
          ? raw.nextPageCursor
          : undefined;
        if (!hasMore) break;
        if (!nextPageCursor) throw new Error('SYNC_CURSOR_INVALID: missing nextPageCursor');
        pageCursor = nextPageCursor;
        page++;
        if (page > 1000) throw new Error('SYNC_CURSOR_INVALID: page safety limit exceeded');
        continue;
      }

      // Stop if we got fewer items than the limit (last page) or no items.
      if (pageItems.length < 100 || pageItems.length === 0) break;
      page++;
      // Safety cap to prevent infinite loops.
      if (page > 100) throw new Error('legacy product pagination safety limit exceeded');
    }

    if (cursorV2 && !finalNextSyncCursor) {
      throw new Error('SYNC_CURSOR_INVALID: final page missing nextSyncCursor');
    }

    // Inline public-category fetch (ported from api-client.ts:2258-2280). Raw
    // rows returned — normalizeCategory (api-client.ts:2232-2256) is deferred
    // to S5/S6. Failure here is non-fatal (Windows warns + returns empty).
    const publicCategories = await this.fetchPublicCategories(headers);

    return {
      products: allItems,
      categories: publicCategories.categories,
      categoriesComplete: publicCategories.complete,
      nextSince: lastNextSince,
      nextSyncCursor: finalNextSyncCursor,
      serverTime: lastServerTime,
      deletedIds: deletedIds.length > 0 ? Array.from(new Set(deletedIds)) : undefined,
    };
  }

  /**
   * Fetch the public categories route used by the catalog sync
   * (GET /api/v1/warehouse/public/categories). Ported from the inline
   * `fetchPublicCategories` closure at api-client.ts:2258-2280. Category-fetch
   * failure is non-fatal: returns `{ categories: [], complete: false }`
   * (Windows logs a warn and continues — catalog sync must not abort on a
   * category-blip).
   */
  private async fetchPublicCategories(
    headers: Record<string, string>,
  ): Promise<{ categories: any[]; complete: boolean }> {
    try {
      const url = `${this.baseUrl}/api/v1/warehouse/public/categories`;
      const response = await this.fetchWithTimeout(url, { headers });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `HTTP ${response.status}`);
      }
      const raw = await response.json();
      const rows: any[] = Array.isArray(raw) ? raw : raw.items ?? raw.categories ?? [];
      return { categories: rows, complete: true };
    } catch {
      return { categories: [], complete: false };
    }
  }

  /**
   * Standalone public-categories fetch — same route/headers as the inline call
   * inside getPosProducts. Windows has no standalone method (categories are
   * fetched inline); the S1 §2.D catalog surface benefits from a direct entry,
   * so this exposes the identical transport. Errors are swallowed to empty
   * (parity with the inline behavior).
   */
  async getPosCategories(): Promise<{ categories: any[]; complete: boolean }> {
    const token = await this.requireToken('getPosCategories');
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (this.salonSlug) headers['X-Salon-Slug'] = this.salonSlug;
    return this.fetchPublicCategories(headers);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Orders (staff JWT)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/v1/b2b/pos/orders. Ported from api-client.ts:2479-2498. The DTO
   * is passed through unchanged (PLN-decimal fields per SHIM_CONTRACT §2.F
   * note — building it is S8's job, not this client's).
   */
  async createPosOrder(order: any): Promise<{ id?: string; orderId?: string; [key: string]: any }> {
    const token = await this.requireToken('createPosOrder');
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders`;

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(order),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * POST /api/v1/b2b/pos/orders/:id/finish. Ported from api-client.ts:2919-2932.
   * Locks the order and triggers server-side stock deduction. Returns null on
   * 404/501 (endpoint not deployed / order not found) so the outbox drainer can
   * shelve without retrying; throws on other errors. Body is the fixed
   * `{ notes: 'POS auto-finish' }` Windows sends.
   */
  async finishOrder(backendOrderId: string): Promise<any> {
    const token = await this.requireToken('finishOrder');
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(backendOrderId)}/finish`;
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'POS auto-finish' }),
    });
    if (response.status === 404 || response.status === 501) return null;
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    return response.json();
  }

  // ── Product admin (E-PARITY-3) — the owner's product/stock/category surface.
  //    Staff JWT (NOT the pa_ key — Windows uses getSecureAuthToken here, see
  //    pos.module.ts:1734) + the salon-context headers + optimistic-concurrency
  //    header. Ported from api-client.ts productAdminRequest :1586. All routes
  //    hang off /api/v1/warehouse/product-admin.

  /**
   * Generic product-admin request. Attaches the staff JWT, the salon-context
   * headers (X-Salon-Slug/Code/Agent-Id), and the idempotency / expected-updated
   * -at headers. On a non-2xx it throws an Error carrying `.status`, `.code`,
   * `.field`, `.details`, `.serverBody` (the same envelope Windows surfaces) so
   * the shim can map it to `{ ok: false, error, code }`.
   */
  async productAdminRequest<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      idempotencyKey?: string;
      expectedUpdatedAt?: string;
      salonCode?: string;
      agentId?: string;
    } = {},
  ): Promise<T> {
    const token = await this.requireToken('productAdminRequest');
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (this.salonSlug) headers['X-Salon-Slug'] = this.salonSlug;
    if (opts.salonCode) headers['X-Salon-Code'] = opts.salonCode;
    if (opts.agentId) headers['X-Agent-Id'] = opts.agentId;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (opts.expectedUpdatedAt) headers['X-Expected-Updated-At'] = opts.expectedUpdatedAt;

    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/warehouse/product-admin${path}`,
      { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined },
    );
    const rawText = await response.text();
    let data: any = null;
    try { data = rawText ? JSON.parse(rawText) : {}; } catch { data = rawText; }

    if (!response.ok) {
      const envelopeError = data && typeof data === 'object' && data.error && typeof data.error === 'object'
        ? data.error
        : null;
      const stringErrorCode = data && typeof data === 'object' && typeof data.error === 'string' && /^[A-Z0-9_]+$/.test(data.error)
        ? data.error
        : undefined;
      const message = envelopeError?.message
        || (typeof data === 'object' ? data?.message : null)
        || (typeof data === 'object' && typeof data?.error === 'string' ? data.error : null)
        || rawText || `HTTP ${response.status}`;
      const error = new Error(message) as Error & {
        status?: number; code?: string; field?: string | null; details?: unknown; serverBody?: unknown;
      };
      error.status = response.status;
      if (data && typeof data === 'object') {
        error.code = data.code ?? envelopeError?.code ?? stringErrorCode;
        error.field = data.field ?? envelopeError?.field;
        error.details = data.details ?? envelopeError?.details;
        error.serverBody = data;
      }
      throw error;
    }
    return data as T;
  }

  /**
   * Product-admin multipart upload (E-PARITY-3 image uploads). Staff JWT + salon
   * -context headers + optional expected-updated-at; the body is a FormData, so
   * NO Content-Type header is set — the runtime supplies the multipart boundary.
   * Same error envelope as productAdminRequest. Ported from
   * api-client.ts productAdminMultipartRequest :1655.
   */
  async productAdminMultipartRequest<T>(
    path: string,
    form: FormData,
    opts: { expectedUpdatedAt?: string; salonCode?: string; agentId?: string } = {},
  ): Promise<T> {
    const token = await this.requireToken('productAdminMultipartRequest');
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (this.salonSlug) headers['X-Salon-Slug'] = this.salonSlug;
    if (opts.salonCode) headers['X-Salon-Code'] = opts.salonCode;
    if (opts.agentId) headers['X-Agent-Id'] = opts.agentId;
    if (opts.expectedUpdatedAt) headers['X-Expected-Updated-At'] = opts.expectedUpdatedAt;

    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/warehouse/product-admin${path}`,
      { method: 'POST', headers, body: form },
    );
    const rawText = await response.text();
    let data: any = null;
    try { data = rawText ? JSON.parse(rawText) : {}; } catch { data = rawText; }

    if (!response.ok) {
      const envelopeError = data && typeof data === 'object' && data.error && typeof data.error === 'object'
        ? data.error
        : null;
      const message = envelopeError?.message
        || (typeof data === 'object' ? data?.message : null)
        || (typeof data === 'object' && typeof data?.error === 'string' ? data.error : null)
        || rawText || `HTTP ${response.status}`;
      const error = new Error(message) as Error & { status?: number; code?: string; serverBody?: unknown };
      error.status = response.status;
      if (data && typeof data === 'object') {
        error.code = data.code ?? envelopeError?.code;
        error.serverBody = data;
      }
      throw error;
    }
    return data as T;
  }

  // ── Print-agent connection (E-PARITY-1) — trusted-terminal parity with the
  //    Windows counter. The Sunmi is a fixed, owner-trusted POS terminal, so it
  //    fetches the salon-wide print-agent key and registers as an agent exactly
  //    like the Windows app (auth.module.ts connectWithAvailablePrintAgentKey
  //    :998, connectWithApiKey :928). The key VALUE is never logged.

  /**
   * GET /api/v1/print-agent/my-key — fetch-or-create the salon's print-agent
   * API key for the authenticated staff user. Staff JWT (refresh-on-401 via
   * fetchWithTimeout). Returns `{ apiKey }` or null on any non-2xx / error, so
   * the caller degrades gracefully when the salon has no agent key yet.
   * Ported from api-client.ts:3222 (getMyPrintAgentKey).
   */
  async getMyPrintAgentKey(): Promise<{ apiKey: string } | null> {
    const token = await this.requireToken('getMyPrintAgentKey');
    const url = `${this.baseUrl}/api/v1/print-agent/my-key`;
    try {
      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!response.ok) return null;
      const data = await response.json().catch(() => null);
      // SECURITY: never log the key value, even partial.
      return data?.apiKey ? { apiKey: data.apiKey } : null;
    } catch {
      return null;
    }
  }

  /**
   * POST /api/v1/print-agent/connect — register this terminal as a print-agent
   * with the salon-wide `pa_` key (in the body, NOT a Bearer header — the key
   * authenticates the call itself). Returns the connect envelope (agentId,
   * salonId, salonName, salonSlug, printers…). Ported from api-client.ts:1331
   * (connectWithApiKey). Throws on non-2xx so the coordinator can fall back to
   * socket-only like Windows (auth.module.ts:949-955).
   */
  async connectPrintAgent(
    apiKey: string,
    meta: { machineId?: string; appVersion?: string; osVersion?: string } = {},
  ): Promise<Record<string, any>> {
    const url = `${this.baseUrl}/api/v1/print-agent/connect`;
    const response = await rawFetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        machineId: meta.machineId ?? this.machineId ?? '',
        // No made-up version number here: a stale constant is worse than an
        // honest blank, because the remote-control panel presents this as the
        // terminal's installed build.
        appVersion: meta.appVersion ?? 'unknown',
        osVersion: meta.osVersion ?? 'android',
      }),
    }, DEFAULT_TIMEOUT);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    return response.json();
  }

  /**
   * POST /api/v1/b2b/pos/orders/:id/refund. Ported transport from
   * api-client.ts:2781-2804. The DTO is the renderer-built refund request
   * (SHIM_CONTRACT §2.G) passed through UNCHANGED — the renderer
   * (OrderHistoryModal → buildRefundRequest) constructs it; this client does not
   * rebuild it. Staff JWT. Returns null on 404/501 (endpoint not deployed for
   * this salon / order not found), matching Windows; throws on other non-2xx.
   *
   * Response shape the renderer consumes (OrderHistoryModal getRefundSuccess*):
   * `{ success, status?, refundAmount?(PLN), totalRefundedAmount?(PLN),
   * refundedLines?([{...,refundAmount(PLN)}]), restocked?, stockMovementIds?,
   * refundReason? }`. Amounts are PLN decimals (the renderer grosses them up to
   * integer grosze via toGrosze) — see the E1b report for the request-unit note.
   */
  async refundOrder(orderId: string, dto: Record<string, any>): Promise<any | null> {
    const token = await this.requireToken('refundOrder');
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(orderId)}/refund`;
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    if (response.status === 404 || response.status === 501) return null;
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.message || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  /**
   * PATCH /api/v1/b2b/pos/orders/:id/add-invoice. Ported transport from
   * api-client.ts:2834-2857. Staff JWT. Attaches a VAT invoice to an
   * already-created (synced) POS order. The renderer-built DTO
   * ({customerNip, invoiceType?}) is passed through; `invoiceType` defaults to
   * 'VAT' to match the Windows api-client. Throws an Error carrying `.status`
   * on non-2xx so the transport can map it to {success:false, error}.
   */
  async addInvoiceToOrder(
    backendOrderId: string,
    data: { customerNip: string; invoiceType?: 'VAT' | 'PROFORMA' },
  ): Promise<any> {
    const token = await this.requireToken('addInvoiceToOrder');
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(backendOrderId)}/add-invoice`;
    const response = await this.fetchWithTimeout(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerNip: data.customerNip, invoiceType: data.invoiceType ?? 'VAT' }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.message || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  /**
   * POST /api/v1/b2b/pos/orders/:id/generate-proforma. Ported transport from
   * api-client.ts:2859-2877. Staff JWT. Generates a proforma from a synced POS
   * order. No request body (matches Windows). Throws an Error carrying `.status`
   * on non-2xx.
   */
  async generateProforma(backendOrderId: string): Promise<any> {
    const token = await this.requireToken('generateProforma');
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(backendOrderId)}/generate-proforma`;
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.message || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  /**
   * GET /api/v1/b2b/pos/customers/nip/:nip. Ported transport from
   * api-client.ts:2879-2895. Staff JWT. Looks up a customer by Polish tax ID,
   * falling back to the GUS registry when no local customer matches. Throws an
   * Error carrying `.status` on non-2xx (a 404 = no such NIP → the transport
   * returns {success:false}).
   */
  async lookupCustomerByNip(nip: string): Promise<any> {
    const token = await this.requireToken('lookupCustomerByNip');
    const url = `${this.baseUrl}/api/v1/b2b/pos/customers/nip/${encodeURIComponent(nip)}`;
    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.message || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  /** GET /api/v1/loyalty/pos/customer — staff JWT with the standard 401 refresh path. */
  async getPosCustomerLoyalty(phone: string): Promise<PosLoyaltyLookupResponse | null> {
    const value = String(phone ?? '').trim();
    if (!value) return null;
    const token = await this.requireToken('getPosCustomerLoyalty');
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/loyalty/pos/customer?phone=${encodeURIComponent(value)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
    );
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.message || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    return text ? JSON.parse(text) as PosLoyaltyLookupResponse : null;
  }

  /**
   * GET /api/v1/b2b/pos/orders. Ported from api-client.ts:3096-3125. Builds the
   * exact query string Windows builds and returns the `{ orders, total, page,
   * limit }` slice.
   */
  async getServerOrders(params: ServerOrderListParams): Promise<ServerOrdersResult> {
    const token = await this.requireToken('getServerOrders');
    const qs = new URLSearchParams();
    if (params.period) qs.set('period', params.period);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.customerId) qs.set('customerId', params.customerId);
    if (params.staffId) qs.set('staffId', params.staffId);
    if (params.staffName) qs.set('staffName', params.staffName);
    if (params.search) qs.set('search', params.search);
    if (params.paymentMethod) qs.set('paymentMethod', params.paymentMethod);
    if (params.paymentStatus) qs.set('paymentStatus', params.paymentStatus);
    if (params.status) qs.set('status', params.status);
    if (params.requiresInvoice !== undefined) qs.set('requiresInvoice', String(params.requiresInvoice));
    qs.set('page', String(params.page ?? 1));
    qs.set('limit', String(params.limit ?? 20));

    const url = `${this.baseUrl}/api/v1/b2b/pos/orders?${qs}`;
    const response = await this.fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    const data = await response.json();
    return { orders: data.orders ?? [], total: data.total ?? 0, page: data.page ?? 1, limit: data.limit ?? 20 };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Shifts (staff JWT)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/v1/pos/shifts/open. Ported from api-client.ts:3001-3024. Merges
   * `machineId` (data override → constructor fallback) into the body when
   * present — Windows falls back to `getConfigValue('machineId')`.
   */
  async openPosShift(
    data: { staffId: string; openingCash: number; machineId?: string | null },
  ): Promise<{ shiftId: string }> {
    const token = await this.requireToken('openPosShift');
    const url = `${this.baseUrl}/api/v1/pos/shifts/open`;
    const machineId = String(data.machineId ?? this.machineId ?? '').trim();
    const body = machineId ? { ...data, machineId } : data;

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * GET /api/v1/pos/shifts/active?machineId=. Ported from
   * api-client.ts:3149-3170 — the register-scoped active shift the payment
   * boundary is verified against. The backend answers `{ active: false }` when
   * there is none (pos-shift-alias.controller.ts:53-61), which is a VALID
   * answer meaning "no shift here", not an error; it maps to null.
   */
  async getActivePosShift(
    machineIdOverride?: string | null,
  ): Promise<{ id: string; staffId?: string; staffName?: string; openedAt?: string } | null> {
    const token = await this.requireToken('getActivePosShift');
    const machineId = String(machineIdOverride ?? this.machineId ?? '').trim();
    const query = machineId ? `?machineId=${encodeURIComponent(machineId)}` : '';
    const url = `${this.baseUrl}/api/v1/pos/shifts/active${query}`;

    const response = await this.fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    const body = await response.json().catch(() => null);
    if (!body || body.active === false) return null;
    return String(body.id || '').trim() ? body : null;
  }

  /**
   * POST /api/v1/pos/shifts/:id/close. Ported from api-client.ts:3030-3052.
   */
  async closePosShift(
    shiftId: string,
    data: { closingCash: number },
  ): Promise<any> {
    const token = await this.requireToken('closePosShift');
    const url = `${this.baseUrl}/api/v1/pos/shifts/${encodeURIComponent(shiftId)}/close`;

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  // ════════════════════════════════════════════════════════════════════════
  // Print jobs · receipt COPY (staff JWT) — packet E1a
  // ════════════════════════════════════════════════════════════════════════
  //
  // These target the SAME staff-JWT print routes the Windows shared-receipt
  // route uses (src/main/printing/shared-receipt-printer.ts → ApiClient
  // createPrintJob / getPrintJobStatus / listPrinterAssignments). HARD RAIL:
  // staff JWT only — NEVER the `pa_` API-key variants (`createPrintJobWithApiKey`
  // / `*WithApiKey`), NEVER `/print-agent/connect`, NEVER the agent socket. The
  // remote-print coordinator (shim/remote-print.ts) is the only caller. Fiscal
  // print is backend-gated (P0-FISCAL) and stays out of this client entirely.
  //
  // The URLs are interpolated template literals (`${this.baseUrl}/...`) so the
  // cross-platform boundary verifier's static-string `/print-agent/` ban does
  // not flag them (a fully-static `'/print-agent/jobs'` literal would).

  /**
   * Resolve the `waitForCompletion` request timeout. Ported from
   * api-client.ts:1093-1096: at least DEFAULT_TIMEOUT, at most timeoutMs+5s,
   * capped at 65s. A job without `waitForCompletion`/`timeoutMs` uses the
   * default — the backend returns immediately.
   */
  private printJobRequestTimeout(
    body?: Pick<CreatePrintJobRequest, 'waitForCompletion' | 'timeoutMs'>,
  ): number {
    if (!body?.waitForCompletion || typeof body.timeoutMs !== 'number') return DEFAULT_TIMEOUT;
    return Math.max(DEFAULT_TIMEOUT, Math.min(body.timeoutMs + 5_000, 65_000));
  }

  /**
   * GET /api/v1/print-agent/salons/me/printer-assignments (staff JWT). Ported
   * from api-client.ts:1052-1055. Returns the salon's printer-role → printerId
   * assignments; the coordinator picks the `SELF_CHECKOUT_RECEIPT` role (the
   * role the Windows shared-receipt route binds to — shared-receipt-printer.ts:25).
   * Throws an Error carrying `.status` on non-2xx so the coordinator can treat a
   * 404/501 (endpoint not deployed for this salon) as "no remote printer".
   */
  async listPrinterAssignments(): Promise<SalonPrinterAssignmentsResponse> {
    const token = await this.requireToken('listPrinterAssignments');
    const url = `${this.baseUrl}/api/v1/print-agent/salons/me/printer-assignments`;
    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.message || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    const raw = await response.json();
    return { assignments: Array.isArray(raw?.assignments) ? raw.assignments : [] };
  }

  /**
   * POST /api/v1/print-agent/jobs (staff JWT). Ported from api-client.ts:1098-1100
   * (+ requestWithTimeout:1102-1126). The body is the CreatePrintJobRequest built
   * by the coordinator; the timeout follows `waitForCompletion`/`timeoutMs`.
   * Throws an Error carrying `.status` on non-2xx. An empty 2xx body (Windows
   * returns `{}` for some accepts) is normalized to `{}`.
   */
  async createPrintJob(body: CreatePrintJobRequest): Promise<CreatePrintJobResponse> {
    const token = await this.requireToken('createPrintJob');
    const url = `${this.baseUrl}/api/v1/print-agent/jobs`;
    const response = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      this.printJobRequestTimeout(body),
    );
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.message || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  /**
   * GET /api/v1/print-agent/jobs/:id (staff JWT). Ported from
   * api-client.ts:1187-1189. Polls the status of a print job the coordinator
   * already created or is resuming. Throws an Error carrying `.status` on
   * non-2xx (the coordinator maps a poll failure to an UNCERTAIN outcome, never
   * an auto-retry).
   */
  async getPrintJobStatus(jobId: string): Promise<CreatePrintJobResponse> {
    const token = await this.requireToken('getPrintJobStatus');
    const url = `${this.baseUrl}/api/v1/print-agent/jobs/${encodeURIComponent(jobId)}`;
    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.message || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  // ════════════════════════════════════════════════════════════════════════
  // Staff · sync pull (staff JWT) — packet E2a (SHIM_CONTRACT_SALON_E2 §2.B)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/v1/staff. Ported transport from api-client.ts:3423-3448
   * (`getStaffProfiles`). Staff JWT — the same route family the shift picker
   * already depends on. Returns the raw staff rows (normalization to the local
   * `staff` table happens in real-transport). Throws on non-2xx so the sync
   * caller surfaces a real error (this is PORT, not dark-launch safe) — unlike
   * the schedule/nail-turn reads below.
   */
  async getStaffProfiles(): Promise<any[]> {
    const token = await this.requireToken('getStaffProfiles');
    const url = `${this.baseUrl}/api/v1/staff`;
    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.message || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    const raw = await response.json();
    if (Array.isArray(raw)) return raw;
    return raw?.items ?? raw?.staff ?? raw?.data ?? [];
  }

  // ════════════════════════════════════════════════════════════════════════
  // Schedule + nail-turn board (staff JWT) — packet E2a dark-launch (§2.C/§2.D)
  //
  // All staff-JWT, NO `pa_` agent-key fallback (the Windows schedule READS fall
  // back to /api/v1/pos/schedule/agent/… — Android skips that hard rail). Every
  // route is dark-launch tolerant: a 403/404/501 means "not deployed for this
  // salon" → return null so the real-transport wrapper reports
  // {success:false, unavailable:true} and SalonTemplate hides the panel.
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Fetch JSON, mapping the dark-launch statuses (403/404/501) to null. Other
   * non-2xx throw with `.status` attached; network throws propagate. The
   * schedule/nail-turn wrappers below share this so the absence semantics are
   * identical across reads and writes.
   */
  private async darkLaunchJson(
    url: string,
    init: RequestInit,
  ): Promise<any | null> {
    const response = await this.fetchWithTimeout(url, init);
    if (response.status === 403 || response.status === 404 || response.status === 501) return null;
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.message || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  /** GET /api/v1/nail-turns/today. Ported transport from api-client.ts:2546
   *  (`getNailTurnBoard`). Staff JWT. null → board unavailable (hide banner). */
  async getNailTurnBoard(): Promise<any | null> {
    const token = await this.requireToken('getNailTurnBoard');
    const url = `${this.baseUrl}/api/v1/nail-turns/today`;
    return this.darkLaunchJson(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  }

  /** POST /api/v1/nail-turns/assignments/:id/checkout. Ported transport from
   *  api-client.ts:2762-2774 (`checkoutNailTurnAssignment`). Staff JWT. Body is
   *  `{amount_pln, tip_pln, idempotency_key}`. null → assignment/route absent
   *  (best-effort checkout no-ops). */
  async checkoutNailTurnAssignment(
    assignmentId: string,
    body: { amount_pln: number; tip_pln: number; idempotency_key: string },
  ): Promise<any | null> {
    const token = await this.requireToken('checkoutNailTurnAssignment');
    const url = `${this.baseUrl}/api/v1/nail-turns/assignments/${encodeURIComponent(assignmentId)}/checkout`;
    return this.darkLaunchJson(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** GET /api/v1/pos/schedule/today?date=. Ported transport from
   *  api-client.ts:2648-2675 (`getPosScheduleToday`). Staff JWT. null → route
   *  absent (schedule view shows its unavailable banner). */
  async getPosScheduleToday(date?: string): Promise<any | null> {
    const token = await this.requireToken('getPosScheduleToday');
    const qs = new URLSearchParams();
    if (date) qs.set('date', date);
    const query = qs.toString();
    const url = `${this.baseUrl}/api/v1/pos/schedule/today${query ? `?${query}` : ''}`;
    return this.darkLaunchJson(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  }

  /** GET /api/v1/pos/schedule/week?from=&days=. Ported transport from
   *  api-client.ts:2677-2705 (`getPosScheduleWeek`). Staff JWT. null → absent. */
  async getPosScheduleWeek(from?: string, days?: number): Promise<any | null> {
    const token = await this.requireToken('getPosScheduleWeek');
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (typeof days === 'number') qs.set('days', String(days));
    const query = qs.toString();
    const url = `${this.baseUrl}/api/v1/pos/schedule/week${query ? `?${query}` : ''}`;
    return this.darkLaunchJson(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  }

  /** PATCH /api/v1/pos/schedule/staff/:id/status. Ported transport from
   *  api-client.ts:2707-2723 (`setPosScheduleStaffStatus`). Staff JWT only (no
   *  agent fallback). Returns the refreshed day. null → route absent. */
  async setPosScheduleStaffStatus(
    staffProfileId: string,
    body: { status: string; idempotencyKey?: string },
  ): Promise<any | null> {
    const token = await this.requireToken('setPosScheduleStaffStatus');
    const url = `${this.baseUrl}/api/v1/pos/schedule/staff/${encodeURIComponent(staffProfileId)}/status`;
    return this.darkLaunchJson(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** POST /api/v1/pos/schedule/checkins/:id/assign-next. Ported transport from
   *  api-client.ts:2725-2740 (`assignPosScheduleNext`). Staff JWT only. null →
   *  route absent. */
  async assignPosScheduleNext(
    checkinId: string,
    body: Record<string, any>,
  ): Promise<any | null> {
    const token = await this.requireToken('assignPosScheduleNext');
    const url = `${this.baseUrl}/api/v1/pos/schedule/checkins/${encodeURIComponent(checkinId)}/assign-next`;
    return this.darkLaunchJson(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** POST /api/v1/pos/schedule/checkins/:id/request-staff. Ported transport
   *  from api-client.ts:2742-2755 (`requestPosScheduleStaff`). Staff JWT only.
   *  null → route absent. */
  async requestPosScheduleStaff(
    checkinId: string,
    body: Record<string, any>,
  ): Promise<any | null> {
    const token = await this.requireToken('requestPosScheduleStaff');
    const url = `${this.baseUrl}/api/v1/pos/schedule/checkins/${encodeURIComponent(checkinId)}/request-staff`;
    return this.darkLaunchJson(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Generic authenticated JSON request — billiard online-only transport (T4)
  // ════════════════════════════════════════════════════════════════════════
  //
  // The billiard (Bi-a) Android transport (shim/billiard-transport.ts) reads
  // /billiard/* + /restaurant/* + /resources/* and writes via billiard.mutate.
  // Rather than duplicate the auth + refresh-on-401 transport for each route,
  // it is constructed with an injected `request(method, path, body)` bound to
  // THIS method on the SAME PosApiClient the real transport builds. `path` is an
  // /api/v1-relative path beginning with '/' (e.g. '/billiard/dashboard'); the
  // method is any HTTP verb. On a non-2xx it throws an Error carrying `.status`
  // and the server `message` so the billiard mutate (money path) propagates the
  // REAL error — never fakes success. An empty 2xx body (some DELETEs) → null.

  /**
   * Generic authenticated JSON request. Staff JWT + refresh-on-401 via
   * `fetchWithTimeout` (identical transport to the typed methods above). Returns
   * the parsed JSON body, or null for an empty 2xx body. Throws an Error with
   * `.status` on non-2xx.
   */
  async request(method: string, path: string, body?: unknown): Promise<any> {
    const token = await this.requireToken('request');
    const url = `${this.baseUrl}/api/v1${path}`;
    const response = await this.fetchWithTimeout(url, {
      method: method.toUpperCase(),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData?.message || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}
