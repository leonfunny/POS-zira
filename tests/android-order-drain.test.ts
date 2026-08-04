import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPeriodicOrderDrain,
  ORDER_SYNC_INTERVAL_MS,
  ORDER_SYNC_MAX_JITTER_MS,
} from '../src/shared/order-drain';

describe('Android periodic order drain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('runs once after the startup jitter and first 30s interval', async () => {
    const drain = vi.fn(async () => undefined);
    const timer = createPeriodicOrderDrain(drain, () => 0.5);

    timer.start();
    await vi.advanceTimersByTimeAsync(2_500 + ORDER_SYNC_INTERVAL_MS);

    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('runs on two ticks', async () => {
    const drain = vi.fn(async () => undefined);
    const timer = createPeriodicOrderDrain(drain, () => 0);

    timer.start();
    await vi.advanceTimersByTimeAsync(ORDER_SYNC_INTERVAL_MS * 2);

    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('skips a tick while a drain is still in flight, then resumes', async () => {
    let resolveFirst!: () => void;
    const drain = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(undefined);
    const timer = createPeriodicOrderDrain(drain, () => 0);

    timer.start();
    await vi.advanceTimersByTimeAsync(ORDER_SYNC_INTERVAL_MS * 2);
    expect(drain).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(ORDER_SYNC_INTERVAL_MS);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('stops subsequent ticks', async () => {
    const drain = vi.fn(async () => undefined);
    const timer = createPeriodicOrderDrain(drain, () => 0);

    timer.start();
    await vi.advanceTimersByTimeAsync(ORDER_SYNC_INTERVAL_MS);
    timer.stop();
    await vi.advanceTimersByTimeAsync(ORDER_SYNC_INTERVAL_MS * 3);

    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('does not arm the interval when stopped during startup jitter', async () => {
    const drain = vi.fn(async () => undefined);
    const timer = createPeriodicOrderDrain(drain, () => 0.8);

    timer.start();
    await vi.advanceTimersByTimeAsync(2_000);
    timer.stop();
    await vi.advanceTimersByTimeAsync(4_000 + ORDER_SYNC_INTERVAL_MS * 4);

    expect(drain).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('swallows a rejected drain and keeps running', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const drain = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const timer = createPeriodicOrderDrain(drain, () => 0);

    timer.start();
    await vi.advanceTimersByTimeAsync(ORDER_SYNC_INTERVAL_MS * 2);

    expect(drain).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });
});

/**
 * WIRING — the half a timer test cannot see.
 *
 * The drain was first wired only into loginWithEmail. That looks right and is
 * wrong in practice: a cashier types a password once and then reopens the app
 * for weeks, so on every ordinary morning the retry timer would simply never be
 * armed. Every "still signed in" answer must arm it, including the
 * cached-profile branches that keep the session alive while the tablet is
 * offline — exactly when a backlog is waiting for the network to return.
 */
describe('drain wiring: a restored session arms the timer, teardown disarms it', () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function transportWithSession(getMeResponder: () => Promise<Response>) {
    const { ShimConfigStore } = await import('../src/renderer/android-pos/shim/config-store');
    const { TokenStore } = await import('../src/renderer/android-pos/shim/token-store');
    const { createRealTransport } = await import('../src/renderer/android-pos/shim/real-transport');

    const mem = () => {
      const data = new Map<string, string>();
      return {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => { data.set(k, v); },
        removeItem: (k: string) => { data.delete(k); },
      };
    };
    const configStore = new ShimConfigStore({ storage: mem() as any });
    const tokenStore = new TokenStore({ storage: mem() as any });
    await tokenStore.setTokens('restored-access-token');

    const syncOrders = vi.fn(async () => ({ success: true, count: 0 }));
    globalThis.fetch = vi.fn(async (input: unknown) => {
      if (String(input).includes('/auth/me')) return getMeResponder();
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    const transport = createRealTransport({
      configStore,
      tokenStore,
      dbInit: { locateFile: null },
    });
    // The drain calls transport.syncOrders; spy on it without changing wiring.
    (transport as any).syncOrders = syncOrders;
    return { transport, syncOrders, configStore };
  }

  const okUser = () => Promise.resolve(new Response(
    JSON.stringify({ id: 'u1', email: 'a@b.c', role: 'MANAGER', salonId: 's1' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));

  it('arms the drain when getUser restores a live session (no fresh login)', async () => {
    const { transport, syncOrders } = await transportWithSession(okUser);
    vi.useFakeTimers();

    const result = await transport.getUser!();
    expect(result).toMatchObject({ success: true, data: { isAuthenticated: true } });

    await vi.advanceTimersByTimeAsync(ORDER_SYNC_MAX_JITTER_MS + ORDER_SYNC_INTERVAL_MS);
    expect(syncOrders, 'a restored session left the retry timer off').toHaveBeenCalled();
  });

  it('arms the drain on the offline cached-profile branch too', async () => {
    // getMe fails with a generic network error → the shim keeps the cached
    // profile and stays signed in. Orders are piling up locally; the drain is
    // what pushes them once connectivity returns.
    const { transport, syncOrders, configStore } = await transportWithSession(
      () => Promise.reject(Object.assign(new Error('network down'), { status: 0 })),
    );
    configStore.setConfig({ authUser: { id: 'u1', email: 'a@b.c', role: 'MANAGER', salonId: 's1' } as any });
    vi.useFakeTimers();

    const result = await transport.getUser!();
    expect(result).toMatchObject({ success: true, data: { isAuthenticated: true } });

    await vi.advanceTimersByTimeAsync(ORDER_SYNC_MAX_JITTER_MS + ORDER_SYNC_INTERVAL_MS);
    expect(syncOrders, 'the offline branch left the retry timer off').toHaveBeenCalled();
  });

  it('disarms the drain on logout', async () => {
    const { transport, syncOrders } = await transportWithSession(okUser);
    vi.useFakeTimers();
    await transport.getUser!();
    await vi.advanceTimersByTimeAsync(ORDER_SYNC_MAX_JITTER_MS + ORDER_SYNC_INTERVAL_MS);
    const callsBeforeLogout = syncOrders.mock.calls.length;
    expect(callsBeforeLogout).toBeGreaterThan(0);

    await transport.logout!();
    await vi.advanceTimersByTimeAsync(ORDER_SYNC_INTERVAL_MS * 3);
    expect(syncOrders, 'the timer outlived the session').toHaveBeenCalledTimes(callsBeforeLogout);
  });
});
