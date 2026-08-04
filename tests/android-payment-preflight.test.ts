/**
 * The ordinary payment boundary on Android.
 *
 * Windows verifies, before every ordinary POS payment, that the local open
 * shift matches the session AND that the server still considers that shift the
 * register's active one (pos.module.ts prepareOrdinaryPosPayment). The Android
 * shim used to return `{success: true, token: 'android:' + orderId}` and check
 * nothing at all, so the single case this gate exists for — an owner closing
 * the shift from the web dashboard while the tablet keeps selling — went
 * straight through.
 *
 * The half that is easy to get wrong is the offline branch. Blocking payment
 * because the tablet lost signal would stop a shop from selling, so a transport
 * failure must NOT be treated as a mismatch. Windows says so in as many words
 * ("A transport/HTTP failure is not proof of a mismatch") and these tests pin
 * both directions.
 */
import { describe, expect, test } from 'vitest';

import { createServerShiftConsistency } from '../src/shared/pos/server-shift-consistency';
import { getVerifiedServerShiftMismatch } from '../src/shared/pos/open-shift-recovery';

describe('server shift consistency — sticky, and offline-tolerant', () => {
  test('a verified agreement leaves the boundary open', () => {
    const c = createServerShiftConsistency();
    c.recordVerified(null);
    expect(() => c.assertConsistent()).not.toThrow();
    expect(c.current()).toBeNull();
  });

  test('a verified disagreement blocks payment with the server message', () => {
    const c = createServerShiftConsistency();
    c.recordVerified('Local POS shift S1 is open, but the server confirmed that this register has no active shift.');
    expect(() => c.assertConsistent()).toThrow(/server confirmed/i);
  });

  test('BEING OFFLINE DOES NOT BLOCK THE TILL', () => {
    // The whole reason this is not a simple "verify before every payment":
    // a shop on flaky 4G must keep selling.
    const c = createServerShiftConsistency();
    c.recordUnreachable();
    expect(() => c.assertConsistent()).not.toThrow();
    expect(c.current()).toBeNull();
  });

  test('a mismatch STAYS blocking while the tablet is offline', () => {
    // The stickiness is the point. Without it a cashier who hits a verified
    // mismatch could pull the network and retry straight past the check that
    // just failed — the one path where money lands in a shift the server
    // considers closed.
    const c = createServerShiftConsistency();
    c.recordVerified('Local POS shift S1 does not match server shift S2.');
    c.recordUnreachable();
    c.recordUnreachable();
    expect(() => c.assertConsistent()).toThrow(/does not match server shift/i);
  });

  test('a later verified agreement clears a remembered mismatch', () => {
    const c = createServerShiftConsistency();
    c.recordVerified('Local POS shift S1 does not match server shift S2.');
    c.recordVerified(null);
    expect(() => c.assertConsistent()).not.toThrow();
  });

  test('reset forgets everything — a new session inherits no verdict', () => {
    const c = createServerShiftConsistency();
    c.recordVerified('mismatch from the previous cashier');
    c.reset();
    expect(c.current()).toBeNull();
    expect(() => c.assertConsistent()).not.toThrow();
  });

  test('an empty or whitespace message counts as agreement, not a silent block', () => {
    const c = createServerShiftConsistency();
    c.recordVerified('   ');
    expect(() => c.assertConsistent()).not.toThrow();
  });
});

describe('the comparator the boundary feeds on (shared with Windows)', () => {
  test('local shift open + server says none → blocks', () => {
    expect(getVerifiedServerShiftMismatch({
      localShiftId: 'S1', localBackendShiftId: null, serverShiftId: null,
    })).toMatch(/no active shift/i);
  });

  test('different ids → blocks', () => {
    expect(getVerifiedServerShiftMismatch({
      localShiftId: 'S1', localBackendShiftId: null, serverShiftId: 'S2',
    })).toMatch(/does not match/i);
  });

  test('server id matching the local BACKEND id is agreement, not a mismatch', () => {
    // A locally-generated shift that synced keeps its local id and gains a
    // backend id; the server answers with the backend one.
    expect(getVerifiedServerShiftMismatch({
      localShiftId: 'local-1', localBackendShiftId: 'srv-1', serverShiftId: 'srv-1',
    })).toBeNull();
  });

  test('no local shift → nothing for this gate to say', () => {
    // Payment is already refused earlier by the local open-shift assert; this
    // comparator must not invent a second, confusing error.
    expect(getVerifiedServerShiftMismatch({
      localShiftId: null, localBackendShiftId: null, serverShiftId: 'S2',
    })).toBeNull();
  });
});

/**
 * WIRING — the half the pure tests above cannot see.
 *
 * A perfect consistency object is worthless if the preflight never consults it,
 * or if it consults it and then hands back a token anyway. These drive the real
 * transport.
 */
describe('paymentPreflight wiring on the real transport', () => {
  const OPEN_SHIFT = { staffId: 'staff-1', staffName: 'Anna', openingCash: 0 };

  async function harness(activeShiftResponder: (url: string) => Response | Promise<Response>) {
    const { ShimConfigStore } = await import('../src/renderer/android-pos/shim/config-store');
    const { TokenStore } = await import('../src/renderer/android-pos/shim/token-store');
    const { createRealTransport } = await import('../src/renderer/android-pos/shim/real-transport');
    const { ShimPosStore } = await import('../src/renderer/android-pos/shim/pos-store');

    const mem = () => {
      const data = new Map<string, string>();
      return {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => { data.set(k, v); },
        removeItem: (k: string) => { data.delete(k); },
      };
    };
    const configStore = new ShimConfigStore({
      storage: mem() as any,
      seed: { machineId: 'REG-1', salonId: 'salon-1', authUser: { id: 'u1', salonId: 'salon-1' } } as any,
    });
    const tokenStore = new TokenStore({ storage: mem() as any });
    await tokenStore.setTokens('t');

    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('/pos/shifts/active')) return activeShiftResponder(url);
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    const transport = createRealTransport({ configStore, tokenStore, dbInit: { locateFile: null } });
    const shift = await transport.openShift!(OPEN_SHIFT);
    expect(shift.success).toBe(true);

    const posStore = new ShimPosStore();
    posStore.dispatch({
      type: 'session/open',
      payload: { shiftId: shift.shiftId!, staffId: OPEN_SHIFT.staffId, staffName: OPEN_SHIFT.staffName, openedAt: 'now' },
    });
    transport.attachPosStore!(posStore);
    return { transport, shiftId: shift.shiftId! };
  }

  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });

  test('server agrees → releases the boundary with an opaque token', async () => {
    // The responder is only invoked during paymentPreflight, by which point the
    // harness has filled in the shift it opened.
    const opened: { id: string | null } = { id: null };
    const { transport, shiftId } = await harness(() => json({ id: opened.id }));
    opened.id = shiftId;

    const r = await transport.paymentPreflight!('order-1');
    expect(r.success).toBe(true);
    expect(r.token).toBeTruthy();
    // Not derivable from the order id — that was the old stub's whole design.
    expect(r.token).not.toContain('order-1');
    expect(r.expiresAt).toBeGreaterThan(Date.now());
  });

  test('server says this register has NO active shift → refuses to take money', async () => {
    const { transport } = await harness(() => json({ active: false }));
    const r = await transport.paymentPreflight!('order-1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no active shift/i);
    expect(r.token).toBeUndefined();
  });

  test('server reports a DIFFERENT shift → refuses', async () => {
    const { transport } = await harness(() => json({ id: 'some-other-shift' }));
    const r = await transport.paymentPreflight!('order-1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/does not match server shift/i);
  });

  test('OFFLINE still sells — an unreachable server is not a mismatch', async () => {
    const { transport } = await harness(() => { throw new Error('network down'); });
    const r = await transport.paymentPreflight!('order-1');
    expect(r.success, 'losing signal must never freeze the till').toBe(true);
    expect(r.token).toBeTruthy();
  });

  test('a 500 from the shift endpoint also sells', async () => {
    const { transport } = await harness(() => new Response('boom', { status: 500 }));
    const r = await transport.paymentPreflight!('order-1');
    expect(r.success).toBe(true);
  });

  test('a remembered mismatch keeps refusing after the server goes away', async () => {
    let mode: 'mismatch' | 'offline' = 'mismatch';
    const { transport } = await harness(() => {
      if (mode === 'offline') throw new Error('network down');
      return json({ id: 'some-other-shift' });
    });
    expect((await transport.paymentPreflight!('order-1')).success).toBe(false);
    mode = 'offline';
    const r = await transport.paymentPreflight!('order-2');
    expect(r.success, 'going offline must not clear a verified mismatch').toBe(false);
  });

  test('refuses without a blank order id, before touching the network', async () => {
    let asked = false;
    const { transport } = await harness(() => { asked = true; return json({ active: false }); });
    const r = await transport.paymentPreflight!('   ');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/order ID/i);
    expect(asked).toBe(false);
  });
});

/**
 * DELEGATION — the seam between the two blocks above.
 *
 * Everything can be right and still not connected: the transport can verify
 * perfectly while `pos.payment.preflight` (the method the renderer actually
 * calls) keeps handing back the old unverified success. The tests above drive
 * the transport directly and would ALL still pass in that state — verified by
 * restoring the old stub literal, which left them green.
 */
describe('pos.payment.preflight delegates to the verifying transport', () => {
  test('a verified mismatch reaches the renderer through the shim surface', async () => {
    const { installShim, __resetShimForTest } = await import('../src/renderer/android-pos/shim/index');
    __resetShimForTest();
    try {
      const transport = {
        paymentPreflight: async () => ({ success: false, error: 'Local POS shift S1 does not match server shift S2.' }),
      } as any;
      const { api } = installShim({ transport });
      const r = await api.pos.payment.preflight('order-1');
      expect(r.success, 'the shim answered without asking the transport').toBe(false);
      expect(r.error).toMatch(/does not match server shift/i);
    } finally {
      __resetShimForTest();
    }
  });

  test('the token the renderer receives comes from the transport, not from the order id', async () => {
    const { installShim, __resetShimForTest } = await import('../src/renderer/android-pos/shim/index');
    __resetShimForTest();
    try {
      const transport = {
        paymentPreflight: async () => ({ success: true, token: 'pf-from-transport', expiresAt: Date.now() + 1000 }),
      } as any;
      const { api } = installShim({ transport });
      const r = await api.pos.payment.preflight('order-1');
      expect(r.token).toBe('pf-from-transport');
      expect(r.token).not.toContain('order-1');
    } finally {
      __resetShimForTest();
    }
  });
});
