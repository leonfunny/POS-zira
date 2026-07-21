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

/** Authenticated JSON request seam — bound to PosApiClient.request by the real
 *  transport. `path` is an /api/v1-relative path beginning with '/' (e.g.
 *  '/billiard/dashboard'); the client prepends the base + '/api/v1'. Throws on
 *  any non-2xx (the mutate money path relies on this — never fake success). */
export interface BilliardTransportDeps {
  request: (method: string, path: string, body?: any) => Promise<any>;
  /** Dashboard poll interval. Default 10s to match Windows (billiard-sync.ts:163). */
  pollMs?: number;
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
  billiardSyncStatus: () => Promise<{ pending: number; lastSync: string | null; online: boolean }>;
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
// legitimate call. Trailing-slash prefixes cover children; the bare '/resources'
// covers the exact collection.
const API_ALLOWED_PREFIXES = ['/billiard/', '/resources/', '/restaurant/', '/resources'];
const ALLOWED_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Validate a generic billiard write/proxy request the SAME way apiCall does — a
 * real HTTP verb, no path traversal (`..` / `//`), and an allowlisted prefix.
 * Throws on a violation (the async callers turn the throw into a rejection, so
 * the money path still propagates a real error — it never fakes success).
 * Returns the normalized method so callers pass the uppercased verb to request.
 */
function assertAllowedRequest(method: string, path: string): string {
  const m = method.toUpperCase();
  if (!ALLOWED_HTTP_METHODS.includes(m)) {
    throw new Error(`Invalid HTTP method: ${method}`);
  }
  if (path.includes('..') || path.includes('//')) {
    throw new Error('Invalid API path');
  }
  if (!API_ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
    throw new Error(`API path not allowed: ${path}`);
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
function assembleOverview(dashboard: any, floorPlansResp: any): {
  tables: any[];
  floorPlans: any[];
  layouts: any[];
  sessions: any[];
  pendingPayments: any[];
  _fromCache: boolean;
} {
  const tables: any[] = Array.isArray(dashboard) ? dashboard : [];
  const floorPlans: any[] = Array.isArray(floorPlansResp) ? floorPlansResp : [];

  const layouts: any[] = [];
  for (const fp of floorPlans) {
    const fpLayouts = fp && Array.isArray(fp.layouts) ? fp.layouts : [];
    for (const l of fpLayouts) layouts.push(l);
  }

  const sessions: any[] = [];
  const pendingPayments: any[] = [];
  for (const t of tables) {
    const s = t?.session;
    if (s) {
      sessions.push(s);
      // A session not yet settled (PAID) is a pending payment — mirrors the
      // billiardSessionRepo.getPendingPayments() row set the Windows overview
      // surfaces in the Unsettled panel.
      if (s.paymentStatus !== 'PAID') pendingPayments.push(s);
    }
  }

  return { tables, floorPlans, layouts, sessions, pendingPayments, _fromCache: false };
}

export function createBilliardTransport({ request, pollMs = 10_000 }: BilliardTransportDeps): BilliardTransportMethods {
  let cache: { overview: any | null; fetchedAt: number } = { overview: null, fetchedAt: 0 };
  let lastSync: string | null = null;
  let online = false;
  const listeners = new Set<(d: { type: string }) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  // The backend has NO /billiard/fnb/* routes (verified 404 in Task 2). The
  // add-item product modal therefore shows an empty list until a real F&B route
  // ships (P2 follow-up). Log once so a developer sees why, then stay silent.
  let fnbMissingLogged = false;

  const logFnbMissingOnce = () => {
    if (fnbMissingLogged) return;
    fnbMissingLogged = true;
    try {
      (globalThis.console?.warn ?? (() => {}))(
        '[billiard-transport] /billiard/fnb/* routes are not deployed on this backend; F&B product list stays empty (P2 follow-up).',
      );
    } catch { /* console must never break the read */ }
  };

  const emit = (type: string) => {
    for (const cb of listeners) {
      try { cb({ type }); } catch { /* a listener throwing must not break others */ }
    }
  };

  async function refreshOverview(): Promise<any> {
    const [dash, plans] = await Promise.all([
      request('GET', '/billiard/dashboard'),
      request('GET', '/billiard/floor-plans').catch(() => []),
    ]);
    const overview = assembleOverview(dash, plans);
    cache = { overview, fetchedAt: Date.now() };
    lastSync = new Date().toISOString();
    online = true;
    return overview;
  }

  function startPolling() {
    if (timer) return;
    // Best-effort background refresh every pollMs (matches the Windows 10s
    // dashboard poll). A failed poll flips offline but never throws to the
    // timer — the next caller's getOverview surfaces a hard failure.
    timer = setInterval(() => {
      refreshOverview().then(() => emit('dashboard')).catch(() => { online = false; });
    }, pollMs);
  }

  return {
    billiardGetOverview: async () => {
      try {
        const o = await refreshOverview();
        startPolling();
        return o;
      } catch (e) {
        online = false;
        // Serve the stale cache (marked) so a brief blip leaves the floor plan
        // visible; only re-throw when there is genuinely nothing to show.
        if (cache.overview) return { ...cache.overview, _fromCache: true };
        throw e;
      }
    },
    billiardGetSession: (id: string) => request('GET', `/billiard/sessions/${encodeURIComponent(id)}`),
    billiardGetCombos: async (activeOnly?: boolean) => {
      const combos = await request('GET', '/billiard/combos');
      const list = Array.isArray(combos) ? combos : combos?.data ?? [];
      return activeOnly ? list.filter((c: any) => c.isActive !== false) : list;
    },
    billiardGetFloorPlans: () => request('GET', '/billiard/floor-plans'),
    // /billiard/fnb/* is not deployed (Task 2) — empty list + one-time warn.
    billiardGetFnbProducts: () => { logFnbMissingOnce(); return Promise.resolve([]); },
    billiardGetFnbCategories: () => { logFnbMissingOnce(); return Promise.resolve([]); },
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
    billiardGetRestaurantCombos: () => request('GET', '/restaurant/combos').catch(() => []),
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
      const result = await request(m, path, body);
      refreshOverview().then(() => emit('dashboard')).catch(() => { /* best-effort refresh */ });
      return result;
    },
    billiardSyncStatus: async () => ({ pending: 0, lastSync, online }),
    billiardOnDataUpdated: (cb: (d: { type: string }) => void) => {
      listeners.add(cb);
      startPolling();
      return () => { listeners.delete(cb); };
    },
    // No local receipt printer on Android — mirror the Windows no-printer return
    // (sync.module.ts:390) so payment settle never blocks on printing. Task 5
    // revisits wiring this through the remote-print shim if the UI requires it.
    billiardPrintReceipt: async (_sessionId: string, _payment: { method: string; amount: number }) => NO_PRINTER_RESULT,
    apiCall: async (method: string, path: string, body?: any) => {
      const m = assertAllowedRequest(method, path); // throws → rejection (see above)
      return request(m, path, body);
    },
    dispose: () => { if (timer) clearInterval(timer); timer = null; listeners.clear(); },
  };
}
