/**
 * Step 3.3 — the shim's `pos.billiardCheckout` namespace must actually reach
 * the ported orchestration.
 *
 * This is the gap guard 1/2 (android-preload-surface-parity) documents but
 * cannot close: the namespace has existed on both platforms all along while
 * every Android method returned `'desktop-only'`, so NAME parity was green the
 * whole time the tablet could not settle a table. These tests pin behaviour.
 */
import { describe, expect, test, vi } from 'vitest';

import { __resetShimForTest, installShim } from '../src/renderer/android-pos/shim/index';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import type { ShimTransport } from '../src/renderer/android-pos/shim/transport';

function mapStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

function install(transport?: Partial<ShimTransport>) {
  __resetShimForTest();
  return installShim({
    transport: transport as ShimTransport,
    configStore: new ShimConfigStore({ storage: mapStorage() }),
    reinstall: true,
  });
}

describe('pos.billiardCheckout delegates to the transport', () => {
  test('every implemented method reaches the orchestration with its arguments', async () => {
    const calls: Record<string, unknown[]> = {};
    const record = (name: string) => vi.fn(async (...args: unknown[]) => {
      calls[name] = args;
      return { success: true, from: name };
    });
    const transport = {
      billiardPreflight: record('preflight'),
      billiardPrepare: record('prepare'),
      billiardRecover: record('recover'),
      billiardMarkPaymentOpened: record('markPaymentOpened'),
      billiardBeginTender: record('beginTender'),
      billiardBeginRestoredTender: record('beginRestoredTender'),
      billiardComplete: record('complete'),
      billiardResolveUncertainTender: record('resolveUncertainTender'),
    };
    const { api } = install(transport);

    await expect(api.pos.billiardCheckout.preflight()).resolves.toMatchObject({ from: 'preflight' });
    await expect(api.pos.billiardCheckout.prepare({ posCheckout: { a: 1 } })).resolves.toMatchObject({ from: 'prepare' });
    await expect(api.pos.billiardCheckout.recover()).resolves.toMatchObject({ from: 'recover' });
    await expect(api.pos.billiardCheckout.markPaymentOpened('co1')).resolves.toMatchObject({ from: 'markPaymentOpened' });
    await expect(api.pos.billiardCheckout.beginTender('co1', 'tok')).resolves.toMatchObject({ from: 'beginTender' });
    await expect(api.pos.billiardCheckout.beginRestoredTender('hold-1', 'restored-tok')).resolves.toMatchObject({ from: 'beginRestoredTender' });
    await expect(api.pos.billiardCheckout.complete('co1', 'ord1')).resolves.toMatchObject({ from: 'complete' });
    await expect(api.pos.billiardCheckout.resolveUncertainTender({ reason: 'x' })).resolves.toMatchObject({ from: 'resolveUncertainTender' });

    // Arguments survive the hop — a checkout id landing in the wrong slot would
    // resolve the wrong table.
    expect(calls.prepare).toEqual([{ posCheckout: { a: 1 } }]);
    expect(calls.markPaymentOpened).toEqual(['co1']);
    expect(calls.beginTender).toEqual(['co1', 'tok']);
    expect(calls.beginRestoredTender).toEqual(['hold-1', 'restored-tok']);
    expect(calls.complete).toEqual(['co1', 'ord1']);
    expect(calls.resolveUncertainTender).toEqual([{ reason: 'x' }]);
  });

  test('a transport without the orchestration still refuses — never a fake success', async () => {
    const { api } = install({});
    await expect(api.pos.billiardCheckout.preflight()).resolves.toMatchObject({ success: false });
    await expect(api.pos.billiardCheckout.prepare({})).resolves.toMatchObject({ success: false });
    await expect(api.pos.billiardCheckout.markPaymentOpened('co1')).resolves.toMatchObject({ success: false });
    await expect(api.pos.billiardCheckout.beginTender('co1', 't')).resolves.toMatchObject({ success: false });
    await expect(api.pos.billiardCheckout.beginRestoredTender('hold-1', 't')).resolves.toMatchObject({ success: false });
    await expect(api.pos.billiardCheckout.complete('co1', 'o')).resolves.toMatchObject({ success: false });
    await expect(api.pos.billiardCheckout.resolveUncertainTender({})).resolves.toMatchObject({ success: false });
    // recover() is the one that may legitimately say "nothing to resume".
    await expect(api.pos.billiardCheckout.recover()).resolves.toEqual({ success: true, intent: null });
  });

  test('beginRestoredTender never aliases ordinary Billiard tender and has no fake fallback', async () => {
    const ordinary = vi.fn(async () => ({ success: true }));
    const withOrchestration = install({ billiardBeginTender: ordinary });
    await expect(withOrchestration.api.pos.billiardCheckout.beginRestoredTender('hold-1', 'tok'))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/durable Android transport/i) });
    expect(ordinary).not.toHaveBeenCalled();
  });

  test('installShim hands the POS store to a transport that asks for it', () => {
    const attachPosStore = vi.fn();
    const installed = install({ attachPosStore });
    expect(attachPosStore).toHaveBeenCalledTimes(1);
    // The SAME store the renderer reads — two stores would be two carts.
    expect(attachPosStore.mock.calls[0][0]).toBe(installed.posStore);
  });
});
