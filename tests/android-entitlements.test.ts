/**
 * Real salon entitlements on Android (shim/entitlements.ts).
 *
 * Before this the shim answered every question with syntheticEntitlements
 * (all features enabled) — the Bi-a tab showed for EVERY salon regardless of
 * plan. These tests pin: the server payload decides, the 1h cache, the
 * offline fallback order (this salon's last known BEFORE Windows defaults),
 * the tenant boundary (salon A's record never serves salon B), and change
 * notification.
 */
import { describe, it, expect, vi } from 'vitest';
import { createEntitlementsController } from '../src/renderer/android-pos/shim/entitlements';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';

function makeMapStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    _map: map,
  };
}

function makeConfigStore(salonId: string) {
  const store = new ShimConfigStore({ storage: makeMapStorage(), seed: { salonId } });
  store.setConfig({ salonId, salonName: `Salon ${salonId}` });
  return store;
}

/** Server payload with billiard OFF (a salon that did not buy the module). */
const BILLIARD_OFF = {
  salonId: 'salon-a',
  salonCode: '1234',
  salonName: 'Salon A',
  plan: 'basic',
  suggestedPosMode: 'retail',
  features: {
    pos: { enabled: true },
    billiard: { enabled: false },
  },
};

describe('android entitlements — the plan decides which tabs exist', () => {
  it('a server payload with billiard disabled turns the flag OFF (no more synthetic all-enabled)', async () => {
    const request = vi.fn(async () => BILLIARD_OFF);
    const c = createEntitlementsController({ configStore: makeConfigStore('salon-a'), request, storage: makeMapStorage() });
    const e = await c.get();
    expect(request).toHaveBeenCalledWith('GET', '/admin/desktop/entitlements');
    expect(e.features.billiard.enabled).toBe(false);
    expect(e.features.pos.enabled).toBe(true);
    await expect(c.isEnabled('billiard')).resolves.toBe(false);
  });

  it('normalizes like Windows: unknown server keys ignored, invalid posMode nulled, missing keys keep defaults', async () => {
    const request = vi.fn(async () => ({
      salonId: 'salon-a',
      plan: 'pro',
      suggestedPosMode: 'spaceship', // not a template the renderer has
      features: { billiard: { enabled: true }, notARealFeature: { enabled: true } },
    }));
    const c = createEntitlementsController({ configStore: makeConfigStore('salon-a'), request, storage: makeMapStorage() });
    const e = await c.fetch();
    expect(e.suggestedPosMode).toBeNull();
    expect((e.features as any).notARealFeature).toBeUndefined();
    expect(e.features.billiard.enabled).toBe(true);
    // A key the server omitted keeps the Windows default (status is always on).
    expect(e.features.status.enabled).toBe(true);
  });

  it('caches for 1h — a second get() does not hit the network, and an expired one refetches', async () => {
    let clock = 1_000_000;
    const request = vi.fn(async () => BILLIARD_OFF);
    const c = createEntitlementsController({
      configStore: makeConfigStore('salon-a'), request, storage: makeMapStorage(), now: () => clock,
    });
    await c.get();
    await c.get();
    expect(request).toHaveBeenCalledTimes(1);
    clock += 60 * 60 * 1000 + 1; // TTL elapsed
    await c.get();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('offline: this salon\'s LAST KNOWN answer wins over the all-on Windows defaults', async () => {
    const storage = makeMapStorage();
    const configStore = makeConfigStore('salon-a');
    let fail = false;
    const request = vi.fn(async () => {
      if (fail) throw new Error('offline');
      return BILLIARD_OFF;
    });
    const c1 = createEntitlementsController({ configStore, request, storage });
    await c1.get(); // persists billiard:false for salon-a
    // Fresh controller (app restart) with the network down + expired cache:
    let clock = Date.now() + 2 * 60 * 60 * 1000; // past the 1h TTL
    fail = true;
    const c2 = createEntitlementsController({ configStore, request, storage, now: () => clock });
    const e = await c2.get();
    // DEFAULT_ENTITLEMENTS.billiard is true — the persisted false must win, or
    // an offline tablet at a non-billiard salon would show a dead Bi-a tab.
    expect(e.features.billiard.enabled).toBe(false);
  });

  it('offline with no record at all falls back to the Windows defaults (parity)', async () => {
    const request = vi.fn(async () => { throw new Error('offline'); });
    const c = createEntitlementsController({ configStore: makeConfigStore('salon-new'), request, storage: makeMapStorage() });
    const e = await c.get();
    expect(e.features.billiard.enabled).toBe(true); // DEFAULT_ENTITLEMENTS parity
    expect(e.plan).toBe('free');
  });

  it('tenant boundary: salon A\'s persisted record is never served to salon B', async () => {
    const storage = makeMapStorage();
    const aStore = makeConfigStore('salon-a');
    const okRequest = vi.fn(async () => BILLIARD_OFF);
    await createEntitlementsController({ configStore: aStore, request: okRequest, storage }).get();
    // Salon B logs in on the same device and the network is down.
    const bStore = makeConfigStore('salon-b');
    const failing = vi.fn(async () => { throw new Error('offline'); });
    const cB = createEntitlementsController({ configStore: bStore, request: failing, storage });
    const e = await cB.get();
    // Salon A said billiard:false / plan basic — B must NOT inherit it.
    expect(e.salonId).toBe('salon-b');
    expect(e.plan).toBe('free'); // defaults, not A's 'basic'
  });

  it('clear() wipes memory and storage so the next session refetches', async () => {
    const storage = makeMapStorage();
    const request = vi.fn(async () => BILLIARD_OFF);
    const c = createEntitlementsController({ configStore: makeConfigStore('salon-a'), request, storage });
    await c.get();
    expect(storage._map.size).toBe(1);
    c.clear();
    expect(storage._map.size).toBe(0);
    await c.get();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('onChanged fires only when the feature set actually changes', async () => {
    const storage = makeMapStorage();
    let payload: any = { ...BILLIARD_OFF };
    const request = vi.fn(async () => payload);
    const c = createEntitlementsController({ configStore: makeConfigStore('salon-a'), request, storage });
    const cb = vi.fn();
    c.onChanged(cb);
    await c.fetch(); // first fetch: no previous record → notify
    expect(cb).toHaveBeenCalledTimes(1);
    await c.fetch(); // identical payload → no notification
    expect(cb).toHaveBeenCalledTimes(1);
    payload = { ...BILLIARD_OFF, features: { ...BILLIARD_OFF.features, billiard: { enabled: true } } };
    await c.fetch(); // salon bought billiard → notify
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0].features.billiard.enabled).toBe(true);
  });

  it('a corrupt persisted record is treated as absent, not a crash', async () => {
    const storage = makeMapStorage();
    storage.setItem('zira-android-pos-entitlements', '{not json');
    const request = vi.fn(async () => BILLIARD_OFF);
    const c = createEntitlementsController({ configStore: makeConfigStore('salon-a'), request, storage });
    await expect(c.get()).resolves.toMatchObject({ salonId: 'salon-a' });
  });
});
