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
    await expect(t.billiardSyncStatus()).resolves.toMatchObject({ pending: 0, online: true });
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
});
