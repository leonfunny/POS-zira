import { describe, it, expect } from 'vitest';
import { buildBilliardNamespace, buildApiCall } from '../src/renderer/android-pos/shim/stubs';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';

// ── helpers (mirror the fakeConfigStore/makeMapStorage pattern from tests/android-shim.test.ts) ──

function makeMapStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    __map: map,
  };
}

function fakeConfigStore() {
  return new ShimConfigStore({ storage: makeMapStorage() });
}

// Exact literal the Windows `billiard:print:receipt` handler returns when no
// receipt printer is connected — src/main/modules/sync.module.ts:390
// (`return { success: true, receiptPrinted: false };`). Pinned so Android
// payment settle never blocks on printing when there is no local printer.
const NO_PRINTER_RESULT = { success: true, receiptPrinted: false };

const deps = { configStore: fakeConfigStore(), transport: {} } as any;

describe('billiard shim stub defaults (contract S1 §2.N)', () => {
  it('getFloorOverview returns empty overview', async () => {
    const b = buildBilliardNamespace(deps);
    await expect(b.getFloorOverview()).resolves.toEqual({ tables: [], floorPlans: [], layouts: [], sessions: [], pendingPayments: [], _fromCache: true });
  });
  it('getSyncStatus reports offline with no transport', async () => {
    const b = buildBilliardNamespace(deps);
    await expect(b.getSyncStatus()).resolves.toEqual({
      pending: 0,
      lastSync: null,
      online: false,
      apiReachable: false,
    });
  });
  it('mutate without transport rejects (money path must not fake success)', async () => {
    const b = buildBilliardNamespace(deps);
    await expect(b.mutate('update_floor_plan', 'PATCH', '/billiard/floor-plans/x', {})).rejects.toThrow();
  });
  it('printReceipt mirrors Windows no-printer result', async () => {
    const b = buildBilliardNamespace(deps);
    await expect(b.printReceipt('s1', { method: 'CASH', amount: 100 })).resolves.toEqual(NO_PRINTER_RESULT);
  });
  it('onDataUpdated returns a no-op unsubscribe', () => {
    const b = buildBilliardNamespace(deps);
    expect(typeof b.onDataUpdated(() => {})()).toBe('undefined');
  });
  it('apiCall without transport rejects with offline error', async () => {
    const api = buildApiCall(deps);
    await expect(api('GET', '/billiard/floor-plans')).rejects.toThrow();
  });
});
