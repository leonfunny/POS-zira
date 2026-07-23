/**
 * Task 4 — real online-only billiard transport unit tests (mocked `request`).
 *
 * The transport never touches `fetch` directly — it is constructed with an
 * injected `request(method, path, body)` (the same PosApiClient instance the
 * real transport builds, see real-transport.ts). These tests mock that single
 * seam against the Task 2 captured fixtures so the overview assembly, the
 * money-path error propagation, the sync-status bookkeeping, the
 * onDataUpdated emit, and the apiCall allowlist are all pinned without any
 * network.
 */
import { describe, it, expect, vi } from 'vitest';
import { createBilliardTransport } from '../src/renderer/android-pos/shim/billiard-transport';
import { NO_PRINTER_RESULT } from '../src/renderer/android-pos/shim/stubs';
import dashboard from './fixtures/billiard/dashboard.json';
import floorPlans from './fixtures/billiard/floor-plans.json';

/** Build a deterministic request mock from a `${METHOD} ${path}` → value map.
 *  An Error value is thrown (money-path failure propagation); an unmapped call
 *  throws "unexpected …" so a missing route surfaces loudly. */
function makeRequest(map: Record<string, any>) {
  return vi.fn(async (method: string, path: string, _body?: any) => {
    const hit = map[`${method} ${path}`];
    if (hit instanceof Error) throw hit;
    if (hit === undefined) throw new Error(`unexpected ${method} ${path}`);
    return hit;
  });
}

describe('billiard online-only transport', () => {
  it('getFloorOverview returns tables with embedded layout+session', async () => {
    const request = makeRequest({ 'GET /billiard/dashboard': dashboard, 'GET /billiard/floor-plans': floorPlans });
    const t = createBilliardTransport({ request });
    const overview = await t.billiardGetOverview();
    expect(Array.isArray(overview.tables)).toBe(true);
    // shape contract with BilliardFloorPlan — DECIDED BY TASK-2 FIXTURES:
    // server dashboard = bare array of { resource, status, layout, session },
    // identical per-table shape to getLocalFloorOverview().tables[] (now at
    // billiard-sync.ts:633 post-merge). Fields nest under table.resource.*
    for (const table of overview.tables) {
      expect(table).toHaveProperty('resource.id');
      expect(table).toHaveProperty('resource.name');
      expect(table).toHaveProperty('resource.pricingRules');
      expect(table).toHaveProperty('status');
      expect(table).toHaveProperty('layout');
    }
    t.dispose();
  });

  it('mutate does a direct call and refreshes the cache', async () => {
    const request = makeRequest({
      'GET /billiard/dashboard': dashboard, 'GET /billiard/floor-plans': floorPlans,
      'PATCH /billiard/floor-plans/fp1': { ok: true },
    });
    const t = createBilliardTransport({ request });
    await expect(t.billiardMutate('update_floor_plan', 'PATCH', '/billiard/floor-plans/fp1', { name: 'x' })).resolves.toEqual({ ok: true });
    t.dispose();
  });

  it('mutate failure propagates — never fakes success', async () => {
    const request = makeRequest({ 'POST /billiard/sessions/s1/pay': new Error('HTTP 400 already-paid') });
    const t = createBilliardTransport({ request });
    await expect(t.billiardMutate('pay', 'POST', '/billiard/sessions/s1/pay', {})).rejects.toThrow('already-paid');
    t.dispose();
  });

  it('mutate rejects a non-allowlisted path before any network call (no pivoting onto arbitrary staff-JWT routes)', async () => {
    const request = makeRequest({});
    const t = createBilliardTransport({ request });
    // A bad prefix is refused — a compromised renderer cannot reach /admin, /auth,
    // or /print-agent/connect through the billiard mutate surface.
    await expect(t.billiardMutate('x', 'POST', '/admin/users', {})).rejects.toThrow(/not allowed/);
    // Path traversal is refused too.
    await expect(t.billiardMutate('x', 'GET', '/billiard/../auth')).rejects.toThrow(/Invalid/);
    // Neither reached the request seam.
    expect(request).not.toHaveBeenCalled();
    t.dispose();
  });

  it('sync status flips online after a successful read, offline after a failed one', async () => {
    const request = makeRequest({ 'GET /billiard/dashboard': dashboard, 'GET /billiard/floor-plans': floorPlans });
    const t = createBilliardTransport({ request });
    await t.billiardGetOverview();
    await expect(t.billiardSyncStatus()).resolves.toMatchObject({
      pending: 0,
      online: true,
      apiReachable: true,
    });
    t.dispose();
  });

  it('tracks direct REST reads independently from dashboard online state', async () => {
    const request = makeRequest({
      'GET /billiard/sessions/s1': { id: 's1', status: 'ACTIVE' },
    });
    const t = createBilliardTransport({ request });

    await expect(t.billiardSyncStatus()).resolves.toMatchObject({
      online: false,
      apiReachable: null,
    });
    await expect(t.billiardGetSession('s1')).resolves.toMatchObject({ id: 's1' });
    await expect(t.billiardSyncStatus()).resolves.toMatchObject({
      // `online` remains the dashboard/cache signal; the REST signal is what
      // gates cashier actions.
      online: false,
      apiReachable: true,
    });
    t.dispose();
  });

  it('keeps REST reachable on an authoritative HTTP error', async () => {
    const conflict = Object.assign(new Error('Session is already completed'), { status: 409 });
    const request = makeRequest({ 'POST /billiard/sessions/s1/end': conflict });
    const t = createBilliardTransport({ request });

    await expect(
      t.apiCall('POST', '/billiard/sessions/s1/end'),
    ).rejects.toThrow('already completed');
    await expect(t.billiardSyncStatus()).resolves.toMatchObject({
      online: false,
      apiReachable: true,
    });
    t.dispose();
  });

  it('marks REST unreachable when a direct request loses the network', async () => {
    const request = makeRequest({
      'GET /billiard/sessions/s1': new Error('fetch failed'),
    });
    const t = createBilliardTransport({ request });

    await expect(t.billiardGetSession('s1')).rejects.toThrow('fetch failed');
    await expect(t.billiardSyncStatus()).resolves.toMatchObject({
      online: false,
      apiReachable: false,
    });
    t.dispose();
  });

  it('a successful direct mutation restores REST reachability before its background refresh', async () => {
    const request = vi.fn(async (method: string, path: string) => {
      if (`${method} ${path}` === 'GET /billiard/sessions/s1') {
        throw new Error('network timeout');
      }
      if (`${method} ${path}` === 'PATCH /billiard/sessions/s1/pause') {
        return { id: 's1', status: 'PAUSED' };
      }
      // Keep the best-effort post-mutation refresh in flight so this assertion
      // observes the mutation probe itself.
      if (`${method} ${path}` === 'GET /billiard/dashboard') {
        return new Promise(() => {});
      }
      if (`${method} ${path}` === 'GET /billiard/floor-plans') return [];
      if (`${method} ${path}` === 'GET /billiard/sessions/pending-payments') return [];
      throw new Error(`unexpected ${method} ${path}`);
    });
    const t = createBilliardTransport({ request });

    await expect(t.billiardGetSession('s1')).rejects.toThrow('network timeout');
    await expect(t.billiardSyncStatus()).resolves.toMatchObject({ apiReachable: false });
    await expect(
      t.billiardMutate('pause_session', 'PATCH', '/billiard/sessions/s1/pause'),
    ).resolves.toMatchObject({ status: 'PAUSED' });
    await expect(t.billiardSyncStatus()).resolves.toMatchObject({ apiReachable: true });
    t.dispose();
  });

  it('ignores a late network failure from an older direct request', async () => {
    let rejectOld!: (error: Error) => void;
    const request = vi.fn(async (method: string, path: string) => {
      if (`${method} ${path}` === 'GET /billiard/sessions/slow') {
        return new Promise((_resolve, reject) => { rejectOld = reject; });
      }
      if (`${method} ${path}` === 'GET /billiard/combos') return [];
      throw new Error(`unexpected ${method} ${path}`);
    });
    const t = createBilliardTransport({ request });

    const oldRead = t.billiardGetSession('slow');
    await expect(t.billiardGetCombos()).resolves.toEqual([]);
    rejectOld(new Error('socket hang up'));
    await expect(oldRead).rejects.toThrow('socket hang up');

    await expect(t.billiardSyncStatus()).resolves.toMatchObject({
      online: false,
      apiReachable: true,
    });
    t.dispose();
  });

  it('onDataUpdated fires after a mutate-triggered refresh', async () => {
    const request = makeRequest({
      'GET /billiard/dashboard': dashboard, 'GET /billiard/floor-plans': floorPlans,
      'PATCH /billiard/floor-plans/fp1': { ok: true },
    });
    const t = createBilliardTransport({ request });
    const cb = vi.fn();
    t.billiardOnDataUpdated(cb);
    await t.billiardMutate('update_floor_plan', 'PATCH', '/billiard/floor-plans/fp1', {});
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith({ type: 'dashboard' }));
    t.dispose();
  });

  it('apiCall allowlists billiard/resources/restaurant paths only', async () => {
    const request = makeRequest({ 'GET /billiard/combos': [] });
    const t = createBilliardTransport({ request });
    await expect(t.apiCall('GET', '/billiard/combos')).resolves.toEqual([]);
    await expect(t.apiCall('GET', '/admin/users')).rejects.toThrow(/not allowed/);
    await expect(t.apiCall('GET', '/billiard/../auth')).rejects.toThrow(/Invalid/);
    t.dispose();
  });

  // Task 5 — payment-vs-print contract. On Android there is no local receipt
  // printer, so billiardPrintReceipt must resolve to the SAME literal the
  // Windows no-printer path returns (sync.module.ts:388-390:
  // `{ success: true, receiptPrinted: false }`), NOT reject. This pins the
  // contract so a cash settle on the billiard floor never blocks on printing.
  //
  // Call-site evidence (Task 5 Step 1): the billiard PaymentDialog
  // (src/renderer/components/billiard/PaymentDialog.tsx) does NOT call
  // billiard.printReceipt at all — payment success is decided solely by
  // `result.paymentStatus === 'PAID'` (PaymentDialog.tsx:141); the receipt is
  // dispatched server-side by BilliardPaymentService and the client only opens
  // the cash drawer in a best-effort try/catch (PaymentDialog.tsx:146). So
  // printReceipt is off the money path today; this test guards the day it is
  // wired in.
  it('billiardPrintReceipt resolves to the exact Windows no-printer literal (payment never blocks on print)', async () => {
    const request = makeRequest({}); // no network needed — print is purely local
    const t = createBilliardTransport({ request });
    await expect(t.billiardPrintReceipt('s1', { method: 'CASH', amount: 100 }))
      .resolves.toEqual(NO_PRINTER_RESULT);
    // And the literal itself is the benign "done, receipt skipped" shape:
    expect(NO_PRINTER_RESULT).toEqual({ success: true, receiptPrinted: false });
    expect(request).not.toHaveBeenCalled();
    t.dispose();
  });

  // ── 2026-07-22 review-hardening regressions ────────────────────────────────

  it('dispose wipes the cache — salon B can never be served salon A\'s floor data (cross-tenant boundary)', async () => {
    const map: Record<string, any> = { 'GET /billiard/dashboard': dashboard, 'GET /billiard/floor-plans': floorPlans };
    const request = vi.fn(async (method: string, path: string) => {
      const hit = map[`${method} ${path}`];
      if (hit instanceof Error) throw hit;
      if (hit === undefined) throw new Error(`unexpected ${method} ${path}`);
      return hit;
    });
    const t = createBilliardTransport({ request });
    await t.billiardGetOverview(); // salon A cached
    t.dispose(); // logout
    // salon B logs in, network fails on its first read — the transport must
    // reject (nothing to show), NOT fall back to salon A's cached overview.
    map['GET /billiard/dashboard'] = new Error('network down');
    await expect(t.billiardGetOverview()).rejects.toThrow('network down');
    await expect(t.billiardSyncStatus()).resolves.toMatchObject({ online: false, lastSync: null });
  });

  it('an in-flight refresh started before dispose() never writes the cache (epoch guard)', async () => {
    let resolveDash!: (v: any) => void;
    const request = vi.fn(async (method: string, path: string) => {
      if (`${method} ${path}` === 'GET /billiard/dashboard') {
        return new Promise((res) => { resolveDash = res; }); // hang until we say so
      }
      if (`${method} ${path}` === 'GET /billiard/floor-plans') return floorPlans;
      throw new Error(`unexpected ${method} ${path}`);
    });
    const t = createBilliardTransport({ request });
    const inflight = t.billiardGetOverview(); // starts, blocks on dashboard
    t.dispose(); // logout while the old session's refresh is still in flight
    resolveDash(dashboard); // old response finally lands
    await inflight; // caller still gets its data back...
    // ...but the shared cache/status stayed wiped — the old session's response
    // did not resurrect online/lastSync after logout.
    await expect(t.billiardSyncStatus()).resolves.toMatchObject({ online: false, lastSync: null });
  });

  it('unsubscribing the last onDataUpdated listener stops the poll timer (no background polling after tab switch)', async () => {
    vi.useFakeTimers();
    try {
      const request = makeRequest({ 'GET /billiard/dashboard': dashboard, 'GET /billiard/floor-plans': floorPlans });
      const t = createBilliardTransport({ request, pollMs: 1000 });
      const unsubscribe = t.billiardOnDataUpdated(() => {});
      await vi.advanceTimersByTimeAsync(2100);
      const callsWhileSubscribed = request.mock.calls.length;
      expect(callsWhileSubscribed).toBeGreaterThan(0); // poll ran
      unsubscribe(); // Bi-a → POS tab switch
      await vi.advanceTimersByTimeAsync(5000);
      expect(request.mock.calls.length).toBe(callsWhileSubscribed); // no further polls
      t.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an older slow refresh cannot overwrite a newer applied one (ordering guard on money state)', async () => {
    const dashOld = [{ resource: { id: 'r1' }, status: 'occupied', layout: null, session: { id: 's1', paymentStatus: 'PENDING' } }];
    const dashNew = [{ resource: { id: 'r1' }, status: 'free', layout: null, session: null }];
    let call = 0;
    let failAll = false; // flag-keyed (NOT call-order-keyed) so reordering
    let resolveFirst!: (v: any) => void; // Promise.all args can't misdirect it
    const request = vi.fn(async (method: string, path: string) => {
      if (failAll) throw new Error('blip');
      if (`${method} ${path}` === 'GET /billiard/floor-plans') return [];
      if (`${method} ${path}` === 'GET /billiard/sessions/pending-payments') return [];
      if (`${method} ${path}` === 'GET /billiard/dashboard') {
        call += 1;
        if (call === 1) return new Promise((res) => { resolveFirst = res; }); // slow pre-payment read
        return dashNew; // fast post-payment read
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const t = createBilliardTransport({ request });
    const slow = t.billiardGetOverview(); // seq 1 — hangs
    await t.billiardGetOverview(); // seq 2 — applies dashNew (paid/free)
    resolveFirst(dashOld); // stale pre-payment response lands LAST
    // The RETURN path must also refuse the stale snapshot — the slow caller
    // gets the newer applied cache, not the pre-payment state.
    const slowResult = await slow;
    expect(slowResult._fromCache).toBe(true);
    expect(slowResult.tables).toEqual(dashNew);
    // A failing read now serves the cache — it must be the NEWER (paid) state.
    failAll = true;
    const served = await t.billiardGetOverview();
    expect(served._fromCache).toBe(true);
    expect(served.tables).toEqual(dashNew);
    t.dispose();
  });

  it('a transient floor-plans failure keeps the previous plans instead of wiping them', async () => {
    const map: Record<string, any> = { 'GET /billiard/dashboard': dashboard, 'GET /billiard/floor-plans': floorPlans };
    const request = vi.fn(async (method: string, path: string) => {
      const hit = map[`${method} ${path}`];
      if (hit instanceof Error) throw hit;
      if (hit === undefined) throw new Error(`unexpected ${method} ${path}`);
      return hit;
    });
    const t = createBilliardTransport({ request });
    const first = await t.billiardGetOverview();
    expect(first.floorPlans.length).toBeGreaterThan(0);
    map['GET /billiard/floor-plans'] = new Error('HTTP 500'); // transient blip
    const second = await t.billiardGetOverview();
    expect(second.floorPlans).toEqual(first.floorPlans); // kept, not []
    t.dispose();
  });

  it('a failed mutate still triggers a reconcile refresh (server may have committed before the response was lost)', async () => {
    const request = vi.fn(async (method: string, path: string) => {
      if (`${method} ${path}` === 'POST /billiard/sessions/s1/pay') throw new Error('socket hang up');
      if (`${method} ${path}` === 'GET /billiard/dashboard') return dashboard;
      if (`${method} ${path}` === 'GET /billiard/floor-plans') return floorPlans;
      throw new Error(`unexpected ${method} ${path}`);
    });
    const t = createBilliardTransport({ request });
    await expect(t.billiardMutate('pay', 'POST', '/billiard/sessions/s1/pay', {})).rejects.toThrow('socket hang up');
    await vi.waitFor(() => {
      expect(request.mock.calls.some(([m, p]) => m === 'GET' && p === '/billiard/dashboard')).toBe(true);
    });
    t.dispose();
  });

  it('pendingPayments comes from the pending-payments endpoint, not from active sessions (Windows semantics: COMPLETED + unpaid)', async () => {
    const activeSession = { id: 's-active', status: 'ACTIVE', paymentStatus: 'PENDING' };
    const dashWithActive = [{ resource: { id: 'r1' }, status: 'occupied', layout: null, session: activeSession }];
    const endedUnpaid = [{ id: 's-ended', status: 'COMPLETED', paymentStatus: 'UNPAID', resource: { id: 'r2', name: 'Bàn #2' } }];
    const request = makeRequest({
      'GET /billiard/dashboard': dashWithActive,
      'GET /billiard/floor-plans': [],
      'GET /billiard/sessions/pending-payments': endedUnpaid,
    });
    const t = createBilliardTransport({ request });
    const overview = await t.billiardGetOverview();
    // The mid-game table must NOT appear in the Unsettled panel...
    expect(overview.pendingPayments).toEqual(endedUnpaid);
    expect(overview.pendingPayments.some((s: any) => s.id === 's-active')).toBe(false);
    // ...but its session is still in the active-sessions list.
    expect(overview.sessions.some((s: any) => s.id === 's-active')).toBe(true);
    t.dispose();
  });

  it('a transient pending-payments failure keeps the previous Unsettled rows instead of wiping them', async () => {
    const endedUnpaid = [{ id: 's-ended', status: 'COMPLETED', paymentStatus: 'UNPAID' }];
    const map: Record<string, any> = {
      'GET /billiard/dashboard': dashboard,
      'GET /billiard/floor-plans': floorPlans,
      'GET /billiard/sessions/pending-payments': endedUnpaid,
    };
    const request = vi.fn(async (method: string, path: string) => {
      const hit = map[`${method} ${path}`];
      if (hit instanceof Error) throw hit;
      if (hit === undefined) throw new Error(`unexpected ${method} ${path}`);
      return hit;
    });
    const t = createBilliardTransport({ request });
    const first = await t.billiardGetOverview();
    expect(first.pendingPayments).toEqual(endedUnpaid);
    map['GET /billiard/sessions/pending-payments'] = new Error('HTTP 500');
    const second = await t.billiardGetOverview();
    expect(second.pendingPayments).toEqual(endedUnpaid); // kept, not []
    t.dispose();
  });

  it('allowlist rejects encoded traversal, sibling prefixes, backslashes and absolute URLs; allows the bare collections', async () => {
    const request = makeRequest({ 'GET /resources': [], 'GET /resources?limit=1': [] });
    const t = createBilliardTransport({ request });
    // Encoded traversal — single and double encoded — must die BEFORE the network.
    await expect(t.apiCall('GET', '/billiard/%2e%2e/admin/users')).rejects.toThrow(/Invalid/);
    await expect(t.billiardMutate('x', 'POST', '/billiard/%252e%252e/admin', {})).rejects.toThrow(/Invalid/);
    // startsWith('/resources') must not open sibling routes.
    await expect(t.apiCall('GET', '/resources-admin')).rejects.toThrow(/not allowed/);
    // Backslash and scheme smuggling.
    await expect(t.apiCall('GET', '/billiard/..\\admin')).rejects.toThrow(/Invalid/);
    await expect(t.apiCall('GET', 'https://evil.example/billiard/')).rejects.toThrow(/Invalid/);
    // Query string cannot rescue a disallowed path.
    await expect(t.apiCall('GET', '/admin?x=/billiard/')).rejects.toThrow(/not allowed/);
    expect(request).not.toHaveBeenCalled();
    // The legitimate bare collection (and with a query) still works.
    await expect(t.apiCall('GET', '/resources')).resolves.toEqual([]);
    await expect(t.apiCall('GET', '/resources?limit=1')).resolves.toEqual([]);
    t.dispose();
  });

  it('allowlist treats query values as data — user text with dots/percent in the query is not rejected', async () => {
    const request = makeRequest({
      'GET /billiard/guests?q=a..b': [],
      'GET /billiard/bookings?note=50%25': [],
    });
    const t = createBilliardTransport({ request });
    await expect(t.apiCall('GET', '/billiard/guests?q=a..b')).resolves.toEqual([]);
    await expect(t.apiCall('GET', '/billiard/bookings?note=50%25')).resolves.toEqual([]);
    t.dispose();
  });

  it('reconstructs floorPlans from dashboard-embedded layouts when the plans list is empty (blank-floor trap)', async () => {
    const layout = {
      id: 'l1', resourceId: 'r1', floorPlanId: 'fp-uuid-1',
      positionX: '10', positionY: '10',
      floorPlan: { name: 'Floor 1', floorNumber: 1, roomWidthM: '16.00', roomHeightM: '10.00' },
    };
    const dash = [{ resource: { id: 'r1', name: 'Bàn #1' }, status: 'free', layout, session: null }];
    const request = makeRequest({
      'GET /billiard/dashboard': dash,
      'GET /billiard/floor-plans': new Error('HTTP 500'), // fresh login + blip: no cached fallback
      'GET /billiard/sessions/pending-payments': [],
    });
    const t = createBilliardTransport({ request });
    const overview = await t.billiardGetOverview();
    // Without reconstruction the UI derives legacy floors and the UUID
    // floorPlanId filter hides every table — the floor must not go blank.
    expect(overview.floorPlans).toHaveLength(1);
    expect(overview.floorPlans[0]).toMatchObject({ id: 'fp-uuid-1', name: 'Floor 1', floorNumber: 1 });
    expect(overview.layouts).toHaveLength(1);
    expect(overview.layouts[0].floorPlanId).toBe('fp-uuid-1');
    t.dispose();
  });
});
