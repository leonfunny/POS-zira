/**
 * Billiard (Bi-a) online-only transport (P1). No local DB, no offline queue —
 * the Windows counterpart caches in SQLite + replays a mutation queue
 * (src/main/sync/billiard-sync.ts); here reads hit the backend directly with a
 * 10s-poll in-memory cache and writes (`billiard.mutate`) go straight through
 * with the real error surfaced. The server is the source of truth for every
 * charge, so `billiardMutate` MUST reject on failure — no catch fakes success
 * (plan money-path rule; incident history: billiard estimateCharge pause bug).
 *
 * Task 4 of the billiard Android port — see
 * docs/android-pos/2026-07-21-billiard-android-port-plan.md. This module owns
 * exactly the `billiard*` / `apiCall` members of `ShimTransport`
 * (transport.ts §2.N) plus `dispose()` to stop the poll timer; real-transport
 * spreads it into the real transport and disposes it on logout / auth-expired.
 *
 * Network seam: the transport never imports `fetch` — it is constructed with an
 * injected `request(method, path, body)` bound to the SAME PosApiClient the real
 * transport builds (staff JWT + refresh-on-401, path '/billiard/x' →
 * '<base>/api/v1/billiard/x'). That keeps it inside the shim boundary graph and
 * avoids duplicating auth/refresh logic.
 */

import { NO_PRINTER_RESULT } from './stubs';
import { ApiReachabilityTracker } from '../../../shared/api-reachability';
import { isBilliardNetworkError } from '../../../shared/billiard-contract';

/** Authenticated JSON request seam — bound to PosApiClient.request by the real
 *  transport. `path` is an /api/v1-relative path beginning with '/' (e.g.
 *  '/billiard/dashboard'); the client prepends the base + '/api/v1'. Throws on
 *  any non-2xx (the mutate money path relies on this — never fake success). */
export interface BilliardTransportDeps {
  request: (method: string, path: string, body?: any) => Promise<any>;
  /** Dashboard poll interval. Default 10s to match Windows (billiard-sync.ts:163). */
  pollMs?: number;
  /**
   * LOCAL catalog readers (the SQL.js product mirror) — the F&B product list of
   * the billiard add-item modal.
   *
   * There is no `/billiard/fnb/*` route on the backend and there never was:
   * Windows serves this list from the SAME local ProductSync cache
   * (sync.module.ts:245-263 → productRepo.getAll/search/getByCategory +
   * getCategories). Android has that mirror already, so it reads it the same
   * way instead of hitting the network.
   *
   * Optional: a transport built without a catalog (the S2 synthetic tests)
   * keeps returning empty lists.
   */
  catalog?: {
    getAll(): Promise<any[]>;
    search(query: string, categoryId?: string): Promise<any[]>;
    getByCategory(categoryId: string): Promise<any[]>;
    getCategories(): Promise<any[]>;
  };
}

/** The exact `billiard*` / `apiCall` members of ShimTransport + dispose(). */
export interface BilliardTransportMethods {
  billiardGetOverview: () => Promise<any>;
  billiardGetSession: (id: string) => Promise<any>;
  billiardGetCombos: (activeOnly?: boolean) => Promise<any[]>;
  billiardGetFloorPlans: () => Promise<any[]>;
  billiardGetFnbProducts: (search?: string, categoryId?: string) => Promise<any[]>;
  billiardGetFnbCategories: () => Promise<any[]>;
  billiardGetResourceType: (code: string) => Promise<any>;
  billiardGetRestaurantCombos: () => Promise<any[]>;
  billiardMutate: (op: string, method: string, path: string, body?: any) => Promise<any>;
  billiardSyncStatus: () => Promise<{
    pending: number;
    lastSync: string | null;
    online: boolean;
    apiReachable?: boolean | null;
  }>;
  billiardOnDataUpdated: (cb: (d: { type: string }) => void) => () => void;
  billiardPrintReceipt: (sessionId: string, payment: { method: string; amount: number }) => Promise<{ success: boolean; receiptPrinted: boolean }>;
  apiCall: (method: string, path: string, body?: any) => Promise<any>;
  /** Stop the poll timer + drop listeners. Called on logout / auth-expired. */
  dispose: () => void;
}

// Both generic write/proxy seams (apiCall AND billiard.mutate) are allowlisted
// to the billiard / resources / restaurant prefixes so a hostile/buggy caller —
// or an XSS in the WebView that reaches window.electronAPI — cannot pivot a
// billiard write onto an arbitrary staff-JWT route (auth, admin, /print-agent/
// connect/my-key). Every real billiard flow (useBilliardData.ts +
// useBilliardApi.ts) targets one of these prefixes, so the guard never blocks a
// legitimate call. Trailing-slash prefixes cover children; the exact-match set
// covers the bare collections ('/resources' POST create) WITHOUT opening
// sibling routes like '/resources-admin' to a startsWith match.
const API_ALLOWED_PREFIXES = ['/billiard/', '/resources/', '/restaurant/'];
const API_ALLOWED_EXACT = ['/resources'];
const ALLOWED_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Repeatedly percent-decode until stable so nested encodings (%252e → %2e →
 *  '.') cannot smuggle traversal past the checks. Malformed or >3-deep
 *  encodings are hostile by definition — reject. */
function fullyDecodePath(path: string): string {
  let current = path;
  for (let i = 0; i < 3; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      throw new Error('Invalid API path');
    }
    if (decoded === current) return decoded;
    current = decoded;
  }
  throw new Error('Invalid API path');
}

/**
 * Validate a generic billiard write/proxy request the SAME way apiCall does — a
 * real HTTP verb, no path traversal, and an allowlisted prefix. Traversal is
 * checked on the FULLY DECODED path (so '/billiard/%2e%2e/admin' is rejected,
 * not forwarded for the backend router to maybe-normalize), and the prefix
 * must hold for both the raw and decoded forms. Throws on a violation (the
 * async callers turn the throw into a rejection, so the money path still
 * propagates a real error — it never fakes success). Returns the normalized
 * method so callers pass the uppercased verb to request.
 */
function assertAllowedRequest(method: string, path: string): string {
  const m = method.toUpperCase();
  if (!ALLOWED_HTTP_METHODS.includes(m)) {
    throw new Error(`Invalid HTTP method: ${method}`);
  }
  // Scheme smuggling is checked on the RAW input (a scheme can only sit at the
  // start, before any '?').
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new Error('Invalid API path');
  }
  // All routing-relevant checks run on the PATHNAME only. Query values are
  // data, not routing — user-typed text there ("50%", "a..b", a URL) must not
  // be rejected, and conversely '?x=/billiard/' must not rescue a bad path.
  const rawPathname = path.split('?')[0];
  const decodedPathname = fullyDecodePath(rawPathname);
  for (const candidate of [rawPathname, decodedPathname]) {
    if (candidate.includes('..') || candidate.includes('//') || candidate.includes('\\')) {
      throw new Error('Invalid API path');
    }
    if (
      !API_ALLOWED_EXACT.includes(candidate)
      && !API_ALLOWED_PREFIXES.some((p) => candidate.startsWith(p))
    ) {
      throw new Error(`API path not allowed: ${path}`);
    }
  }
  return m;
}

/**
 * Assemble the floor overview the BilliardFloorPlan UI consumes.
 *
 * Strategy DECIDED by the Task-2 fixtures (tests/fixtures/billiard/):
 *  - GET /billiard/dashboard returns a BARE ARRAY of { resource, status,
 *    layout, session } — the per-table shape is already identical to
 *    getLocalFloorOverview().tables[] (billiard-sync.ts:633 post-merge), so
 *    `tables` is a pass-through.
 *  - GET /billiard/floor-plans returns the floor-plan list, each element
 *    embedding its own `layouts[]`; `floorPlans` is the response as-is and the
 *    flat `layouts` key is derived from it (mirroring the separate top-level
 *    `layouts` array getLocalFloorOverview emits).
 *  - `sessions` / `pendingPayments` are derived from tables where
 *    `session != null` (Windows hydrates them from the active-session repo; the
 *    dashboard already embeds the live session per table).
 *
 * Top-level keys mirror getLocalFloorOverview() (billiard-sync.ts:633) EXACTLY:
 * tables, floorPlans, layouts, sessions, pendingPayments, _fromCache.
 */
function assembleOverview(dashboard: any, floorPlansResp: any, pendingResp: any): {
  tables: any[];
  floorPlans: any[];
  layouts: any[];
  sessions: any[];
  pendingPayments: any[];
  _fromCache: boolean;
} {
  const tables: any[] = Array.isArray(dashboard) ? dashboard : [];
  let floorPlans: any[] = Array.isArray(floorPlansResp) ? floorPlansResp : [];

  // Blank-floor trap: with an empty plans list (fresh login + floor-plans blip,
  // so no cached fallback either) the UI derives legacy floors from
  // floorNumber, but every dashboard layout carries a REAL floorPlanId UUID —
  // the floor filter then matches nothing and all tables vanish silently.
  // The dashboard layouts embed their own floorPlan {name, floorNumber, …}, so
  // reconstruct a minimal plans list from them instead of rendering a blank
  // floor until the next poll.
  if (floorPlans.length === 0) {
    const reconstructed = new Map<string, any>();
    for (const t of tables) {
      const l = t?.layout;
      if (!l?.floorPlanId) continue;
      let fp = reconstructed.get(l.floorPlanId);
      if (!fp) {
        fp = { ...(l.floorPlan ?? {}), id: l.floorPlanId, layouts: [] };
        reconstructed.set(l.floorPlanId, fp);
      }
      fp.layouts.push(l);
    }
    floorPlans = [...reconstructed.values()];
  }

  const layouts: any[] = [];
  for (const fp of floorPlans) {
    const fpLayouts = fp && Array.isArray(fp.layouts) ? fp.layouts : [];
    for (const l of fpLayouts) layouts.push(l);
  }

  const sessions: any[] = [];
  for (const t of tables) {
    const s = t?.session;
    if (s) sessions.push(s);
  }

  // pendingPayments comes from GET /billiard/sessions/pending-payments — the
  // SAME server source Windows syncs (billiard-sync.ts:841): sessions with
  // status COMPLETED and paymentStatus UNPAID/PARTIAL, each embedding its
  // resource/items. Deriving it from the dashboard's embedded sessions is
  // WRONG twice over: those are the ACTIVE sessions (a table mid-game showed
  // up as "Nierozliczone"), and ended-unsettled sessions are absent from the
  // dashboard entirely (the real unsettled rows would be missed).
  const pendingPayments: any[] = Array.isArray(pendingResp) ? pendingResp : [];

  return { tables, floorPlans, layouts, sessions, pendingPayments, _fromCache: false };
}

export function createBilliardTransport({ request, pollMs = 10_000, catalog }: BilliardTransportDeps): BilliardTransportMethods {
  let cache: { overview: any | null; fetchedAt: number } = { overview: null, fetchedAt: 0 };
  let lastSync: string | null = null;
  let online = false;
  let apiReachability = new ApiReachabilityTracker();
  const listeners = new Set<(d: { type: string }) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  // Tenant/lifecycle epoch: dispose() bumps it and wipes the cache, so an
  // in-flight refresh started before logout can NEVER write salon A's data
  // into the cache salon B reads after re-login (the transport is a
  // process-lifetime singleton reused across logins).
  let epoch = 0;
  // Refresh ordering: only a refresh newer than the last applied one may write
  // the cache — a slow pre-mutation response resolving after the post-payment
  // refresh must not revert the floor plan to stale money state.
  let refreshSeq = 0;
  let appliedSeq = 0;
  // Warn once when the F&B list cannot be served from the local catalog (no
  // catalog injected, or a read threw) — Windows logs the same situation and
  // returns [] rather than breaking the add-item modal (sync.module.ts:249-252).
  let fnbCatalogWarned = false;

  interface ApiProbe {
    tracker: ApiReachabilityTracker;
    id: number;
    epoch: number;
  }

  const beginApiProbe = (): ApiProbe => ({
    tracker: apiReachability,
    id: apiReachability.beginProbe(),
    epoch,
  });

  const setApiReachable = (probe: ApiProbe, reachable: boolean) => {
    // The transport object survives logout/re-login. Never let a response from
    // the previous salon update the next salon's REST-health signal.
    if (probe.epoch !== epoch || probe.tracker !== apiReachability) return;
    probe.tracker.apply(probe.id, reachable);
  };

  const trackedRequest = async <T>(run: () => Promise<T>): Promise<T> => {
    const probe = beginApiProbe();
    try {
      const result = await run();
      setApiReachable(probe, true);
      return result;
    } catch (error) {
      // HTTP 4xx/5xx proves that HTTPS reached the backend. Only transport
      // failures should close online-only cashier actions.
      setApiReachable(probe, !isBilliardNetworkError(error));
      throw error;
    }
  };

  const warnFnbCatalogOnce = (reason: string) => {
    if (fnbCatalogWarned) return;
    fnbCatalogWarned = true;
    try {
      (globalThis.console?.warn ?? (() => {}))(
        `[billiard-transport] F&B list unavailable from the local catalog (${reason}); returning an empty list.`,
      );
    } catch { /* console must never break the read */ }
  };

  /**
   * F&B reads are LOCAL (SQL.js mirror) — deliberately outside trackedRequest:
   * they issue no HTTP, so they must not move the REST-reachability signal that
   * gates the online-only cashier actions.
   *
   * Failure policy copied from Windows (sync.module.ts:245-263): log and return
   * an empty list; a catalog hiccup must not break the add-item modal.
   */
  const readFnb = async (read: () => Promise<any[]>, reason: string): Promise<any[]> => {
    if (!catalog) {
      warnFnbCatalogOnce('no local catalog wired into this transport');
      return [];
    }
    try {
      const rows = await read();
      return Array.isArray(rows) ? rows : [];
    } catch (e: any) {
      warnFnbCatalogOnce(`${reason}: ${e?.message || e}`);
      return [];
    }
  };

  const emit = (type: string) => {
    for (const cb of listeners) {
      try { cb({ type }); } catch { /* a listener throwing must not break others */ }
    }
  };

  async function refreshOverview(): Promise<any> {
    const myEpoch = epoch;
    const mySeq = ++refreshSeq;
    const [dash, plans, pending] = await trackedRequest(() => Promise.all([
      request('GET', '/billiard/dashboard'),
      // A transient floor-plans / pending-payments failure must NOT wipe the
      // visible plans or the Unsettled panel while the dashboard read
      // succeeded — fall back to the previously cached value (null = "keep
      // previous"). Windows tolerates a missing pending-payments endpoint the
      // same way (billiard-sync.ts pendingPaymentsEndpointMissingWarned).
      request('GET', '/billiard/floor-plans').catch(() => null),
      request('GET', '/billiard/sessions/pending-payments').catch(() => null),
    ]));
    const plansResp = plans === null ? (cache.overview?.floorPlans ?? []) : plans;
    const pendingResp = pending === null ? (cache.overview?.pendingPayments ?? []) : pending;
    const overview = assembleOverview(dash, plansResp, pendingResp);
    // Drop the write when a dispose() happened mid-flight (tenant boundary) —
    // the dying tenant's caller still gets its own data back, the cache stays
    // wiped for the next tenant.
    if (myEpoch !== epoch) return overview;
    // Ordering: a refresh that lost the race must not be RETURNED either — the
    // caller would setData(stale) last and re-render pre-payment money state
    // (the exact bug the cache guard kills, relocated to the return path).
    // Serve the newer applied cache instead.
    if (mySeq <= appliedSeq) {
      return cache.overview ? { ...cache.overview, _fromCache: true } : overview;
    }
    appliedSeq = mySeq;
    cache = { overview, fetchedAt: Date.now() };
    lastSync = new Date().toISOString();
    online = true;
    return overview;
  }

  function startPolling() {
    if (timer) return;
    // Poll only while someone is listening — the timer is started by
    // onDataUpdated subscriptions and stopped when the last subscriber leaves
    // (stopPollingIfIdle), so switching away from the Bi-a tab does not keep
    // hitting the backend every pollMs for the rest of the session.
    // Best-effort background refresh every pollMs (matches the Windows 10s
    // dashboard poll). A failed poll flips offline but never throws to the
    // timer — the next caller's getOverview surfaces a hard failure.
    timer = setInterval(() => {
      refreshOverview().then(() => emit('dashboard')).catch(() => { online = false; });
    }, pollMs);
  }

  function stopPollingIfIdle() {
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    billiardGetOverview: async () => {
      try {
        const o = await refreshOverview();
        // Polling stays subscription-driven (onDataUpdated) — a lone read must
        // not arm a timer nobody is listening to.
        if (listeners.size > 0) startPolling();
        return o;
      } catch (e) {
        online = false;
        // Serve the stale cache (marked) so a brief blip leaves the floor plan
        // visible; only re-throw when there is genuinely nothing to show.
        if (cache.overview) return { ...cache.overview, _fromCache: true };
        throw e;
      }
    },
    billiardGetSession: (id: string) => trackedRequest(
      () => request('GET', `/billiard/sessions/${encodeURIComponent(id)}`),
    ),
    billiardGetCombos: async (activeOnly?: boolean) => {
      const combos = await trackedRequest(() => request('GET', '/billiard/combos'));
      const list = Array.isArray(combos) ? combos : combos?.data ?? [];
      return activeOnly ? list.filter((c: any) => c.isActive !== false) : list;
    },
    billiardGetFloorPlans: () => trackedRequest(() => request('GET', '/billiard/floor-plans')),
    // F&B products/categories come from the LOCAL catalog mirror, exactly like
    // the Windows counter (sync.module.ts:245-263) — same precedence:
    // search wins over categoryId, categoryId over the full list.
    billiardGetFnbProducts: (search?: string, categoryId?: string) => {
      const query = typeof search === 'string' ? search.trim() : '';
      const category = typeof categoryId === 'string' ? categoryId.trim() : '';
      if (query) return readFnb(() => catalog!.search(query, category || undefined), 'search');
      if (category) return readFnb(() => catalog!.getByCategory(category), 'getByCategory');
      return readFnb(() => catalog!.getAll(), 'getAll');
    },
    billiardGetFnbCategories: () => readFnb(() => catalog!.getCategories(), 'getCategories'),
    billiardGetResourceType: async (code: string) => {
      const o = cache.overview ?? await refreshOverview();
      const tables: any[] = Array.isArray(o?.tables) ? o.tables : [];
      // sync.module.ts:266-279 derives the type from the first resource whose
      // type matches `code`. The dashboard fixture embeds resource.resourceType
      // {id, name, code} — prefer it; fall back to the legacy typeName/typeId.
      for (const t of tables) {
        const rt = t?.resource?.resourceType;
        if (rt && (rt.code === code || rt.id === code || rt.name === code)) {
          return { id: rt.id, code: rt.code ?? code, name: rt.name ?? rt.code ?? code };
        }
      }
      const match = tables.find(
        (t) => t?.resource?.typeName === code
          || t?.resource?.typeId === code
          || t?.resource?.resourceTypeId === code,
      );
      if (match) {
        const r = match.resource;
        return { id: r.typeId ?? r.resourceTypeId, code, name: r.typeName ?? code };
      }
      return null;
    },
    billiardGetRestaurantCombos: () => trackedRequest(
      () => request('GET', '/restaurant/combos'),
    ).catch(() => []),
    billiardMutate: async (_op: string, method: string, path: string, body?: any) => {
      // `op` is the Windows queue key (e.g. 'update_floor_plan'); the online-only
      // transport performs the HTTP call directly and does not branch on it.
      // Validate the request against the same allowlist as apiCall BEFORE the
      // network — a throw here becomes a rejection (propagated), so a bad path
      // surfaces as a real error and never reaches the staff JWT. This does NOT
      // fake success; it refuses before any charge can be issued.
      const m = assertAllowedRequest(method, path);
      // MONEY PATH: the request throws on failure and we let it propagate — no
      // catch fakes success. A post-mutation cache refresh is best-effort so a
      // refresh blip never swallows a write error or hides a charge.
      try {
        const result = await trackedRequest(() => request(m, path, body));
        refreshOverview().then(() => emit('dashboard')).catch(() => { /* best-effort refresh */ });
        return result;
      } catch (err) {
        // The server may have COMMITTED the write even though the response was
        // lost (network drop after commit). Reconcile with an authoritative
        // refresh so the cashier does not retry a charge against stale "unpaid"
        // data — then still propagate the original error (never fake success).
        refreshOverview().then(() => emit('dashboard')).catch(() => { /* reconcile is best-effort */ });
        throw err;
      }
    },
    billiardSyncStatus: async () => ({
      pending: 0,
      lastSync,
      online,
      apiReachable: apiReachability.get(),
    }),
    billiardOnDataUpdated: (cb: (d: { type: string }) => void) => {
      listeners.add(cb);
      startPolling();
      return () => {
        listeners.delete(cb);
        // Last subscriber gone (e.g. Bi-a → POS tab switch unmounted the floor
        // plan) → stop hitting the backend every pollMs.
        stopPollingIfIdle();
      };
    },
    // No local receipt printer on Android — mirror the Windows no-printer return
    // (sync.module.ts:390) so payment settle never blocks on printing. Task 5
    // revisits wiring this through the remote-print shim if the UI requires it.
    billiardPrintReceipt: async (_sessionId: string, _payment: { method: string; amount: number }) => NO_PRINTER_RESULT,
    apiCall: async (method: string, path: string, body?: any) => {
      const m = assertAllowedRequest(method, path); // throws → rejection (see above)
      return trackedRequest(() => request(m, path, body));
    },
    dispose: () => {
      if (timer) clearInterval(timer);
      timer = null;
      listeners.clear();
      // Tenant boundary: the transport is a process-lifetime singleton reused
      // across logout → re-login. Wipe the cached overview and bump the epoch
      // so (a) salon B can never be served salon A's tables/sessions/charges
      // from the stale-cache fallback, and (b) an in-flight refresh from the
      // old session cannot write after this point.
      epoch += 1;
      cache = { overview: null, fetchedAt: 0 };
      lastSync = null;
      online = false;
      apiReachability = new ApiReachabilityTracker();
    },
  };
}
