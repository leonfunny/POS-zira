/**
 * L5 (first slice) — the Android billiard handoff PREFLIGHT.
 *
 * This is the gate the shared PaymentDialog calls before it ends a session
 * (`onPreflightPos`). Ending is the point of no return: the clock stops and the
 * bill freezes. So every case below asserts the tablet REFUSES rather than
 * proceeding on a guess — a refusal leaves the table running, which is always
 * recoverable.
 *
 * Decisions under test: D1 (fiscal readiness = ASSIGNED + a live print-agent
 * link) and D2 (an unpaired tablet cannot settle), plan §5.
 */
import { describe, expect, test } from 'vitest';

import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { ShimPosStore } from '../src/renderer/android-pos/shim/pos-store';
import { createBilliardHandoff } from '../src/renderer/android-pos/shim/billiard-handoff';
import { createBilliardHandoffRepo } from '../src/renderer/android-pos/shim/db/billiard-handoff-repo';

const NODE_LOCATE_FILE = null;

function mapStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

const SHIFT = { id: 'shift-1', staffId: 'u1', staffName: 'Anna' };

interface Harness {
  database: AndroidDatabase;
  configStore: ShimConfigStore;
  posStore: ShimPosStore;
  handoff: ReturnType<typeof createBilliardHandoff>;
}

async function makeHarness(opts: {
  paired?: boolean;
  openShift?: boolean;
  assigned?: boolean;
  agentConnected?: boolean;
  allowRealFiscalPrint?: boolean;
  fiscalOnCashSale?: string;
  db?: AndroidDatabase;
} = {}): Promise<Harness> {
  const database = opts.db ?? await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
  const configStore = new ShimConfigStore({
    storage: mapStorage(),
    seed: {
      salonId: 'salon-1',
      authUser: { id: 'u1', email: 'a@b.c', firstName: 'Anna', lastName: '', role: 'STAFF', salonId: 'salon-1', salonName: 'Bia' },
      // D2: `agentId` is the ONLY server-known register identity a tablet has,
      // and it exists only after /print-agent/connect succeeded.
      ...(opts.paired === false ? {} : { agentId: 'agent-1' }),
      ...(opts.allowRealFiscalPrint === undefined ? {} : { allowRealFiscalPrint: opts.allowRealFiscalPrint }),
      ...(opts.fiscalOnCashSale === undefined ? {} : { fiscalOnCashSale: opts.fiscalOnCashSale }),
    } as any,
  });

  const posStore = new ShimPosStore();
  if (opts.openShift !== false) {
    database.run(
      'INSERT INTO shifts (id, staff_id, staff_name, opening_cash) VALUES (?, ?, ?, ?)',
      [SHIFT.id, SHIFT.staffId, SHIFT.staffName, 0],
    );
    posStore.dispatch({
      type: 'session/open',
      payload: { shiftId: SHIFT.id, staffId: SHIFT.staffId, staffName: SHIFT.staffName, openedAt: '2026-08-03T08:00:00.000Z' },
    });
  }

  const handoff = createBilliardHandoff({
    configStore,
    posStore,
    db: async () => database,
    isFiscalPrinterAssigned: async () => opts.assigned ?? false,
    isPrintAgentConnected: () => opts.agentConnected ?? false,
  });

  return { database, configStore, posStore, handoff };
}

describe('preflight — D2, the tablet must be paired', () => {
  test('an unpaired tablet is refused with a message that names the fix', async () => {
    const { handoff } = await makeHarness({ paired: false });
    const result = await handoff.preflight();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pair/i);
    expect(result.error).toMatch(/print-agent/i);
    // Not the raw "register identity is incomplete" — a cashier cannot act on that.
    expect(result.error).not.toMatch(/identity is incomplete/i);
  });

  test('a paired tablet with a clean shift and no fiscal route passes', async () => {
    const { handoff } = await makeHarness();
    await expect(handoff.preflight()).resolves.toEqual({ success: true });
  });
});

describe('preflight — the shift must be real', () => {
  test('no open shift at all is refused', async () => {
    const { handoff } = await makeHarness({ openShift: false });
    const result = await handoff.preflight();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/shift/i);
  });

  test('an in-memory session with no local journal row is refused', async () => {
    // The store says a shift is open but the payment journal has no such row —
    // exactly the state a crash or a wiped DB leaves behind.
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const { handoff, posStore } = await makeHarness({ openShift: false, db: database });
    posStore.dispatch({
      type: 'session/open',
      payload: { shiftId: 'ghost', staffId: 'u1', staffName: 'Anna', openedAt: 'now' },
    });
    const result = await handoff.preflight();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/local payment journal|not open/i);
  });

  test('two open shifts are refused rather than guessed between', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const { handoff } = await makeHarness({ db: database });
    database.run('INSERT INTO shifts (id, staff_id, staff_name, opening_cash) VALUES (?, ?, ?, ?)', ['shift-2', 'u1', 'Anna', 0]);
    const result = await handoff.preflight();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Multiple local POS shifts/i);
  });
});

describe('preflight — D1, fiscal readiness on a device that owns no printer', () => {
  test('assigned printer + DEAD print-agent socket is refused', async () => {
    // The bill cannot reach the printer, so the session must not end.
    const { handoff } = await makeHarness({
      allowRealFiscalPrint: true,
      assigned: true,
      agentConnected: false,
    });
    const result = await handoff.preflight();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/fiscal printer is not ready/i);
  });

  test('assigned printer + live print-agent socket passes', async () => {
    const { handoff } = await makeHarness({
      allowRealFiscalPrint: true,
      assigned: true,
      agentConnected: true,
    });
    await expect(handoff.preflight()).resolves.toEqual({ success: true });
  });

  test('fiscalOnCashSale=always with no printer assigned is refused', async () => {
    const { handoff } = await makeHarness({
      allowRealFiscalPrint: true,
      fiscalOnCashSale: 'always',
      assigned: false,
      agentConnected: true,
    });
    const result = await handoff.preflight();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/fiscal printer is not ready/i);
  });

  test('the production go-live gate still bites on a tablet', async () => {
    const { handoff } = await makeHarness({
      fiscalOnCashSale: 'always',
      allowRealFiscalPrint: false,
      assigned: true,
      agentConnected: true,
    });
    const result = await handoff.preflight();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/REAL_FISCAL_PRINT_DISABLED/);
  });

  test('a failing assignment lookup counts as NOT assigned, never as ready', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const { configStore, posStore } = await makeHarness({ db: database, allowRealFiscalPrint: true });
    const handoff = createBilliardHandoff({
      configStore,
      posStore,
      db: async () => database,
      isFiscalPrinterAssigned: async () => { throw new Error('lookup 500'); },
      isPrintAgentConnected: () => true,
    });
    const result = await handoff.preflight();
    // allowRealFiscalPrint alone still requires readiness, and a failed lookup
    // must not be read as "no fiscal route, carry on".
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/fiscal printer is not ready/i);
  });
});

describe('preflight — durability and identity', () => {
  test('an occupied ordinary cart is refused while the Billiard table is still running', async () => {
    const { handoff, database, posStore } = await makeHarness();
    posStore.dispatch({ type: 'cart/addItem', payload: ordinaryLine() as any });
    const before = posStore.getState();

    const result = await handoff.preflight();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Hold the current cart manually/i);
    expect(database.all('SELECT 1 FROM pos_billiard_handoffs')).toHaveLength(0);
    expect(database.all('SELECT 1 FROM pos_hold_orders')).toHaveLength(0);
    expect(posStore.getState()).toEqual(before);
  });

  test('a failed durability barrier refuses instead of ending the session', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const { configStore, posStore } = await makeHarness({ db: database });
    (database as any).flush = async () => { throw new Error('quota exceeded'); };
    const handoff = createBilliardHandoff({
      configStore,
      posStore,
      db: async () => database,
      isFiscalPrinterAssigned: async () => false,
      isPrintAgentConnected: () => false,
    });
    const result = await handoff.preflight();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not durable/i);
    expect(result.error).toMatch(/quota exceeded/);
  });

  test('a logout landing DURING the preflight abandons it', async () => {
    // The epoch guard only matters across an await — invalidating before the
    // call would simply be captured as the new epoch. Model the real race: the
    // cashier logs out while the DB handle is being opened.
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const { configStore, posStore } = await makeHarness({ db: database });
    let handoff: ReturnType<typeof createBilliardHandoff>;
    handoff = createBilliardHandoff({
      configStore,
      posStore,
      db: async () => { handoff.invalidateAuth(); return database; },
      isFiscalPrinterAssigned: async () => false,
      isPrintAgentConnected: () => false,
    });
    const result = await handoff.preflight();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/POS user changed/i);
  });

  test('a salon switch mid-flight also abandons it', async () => {
    const { handoff, configStore } = await makeHarness();
    const original = configStore.getRawConfig.bind(configStore);
    let calls = 0;
    (configStore as any).getRawConfig = () => {
      calls += 1;
      const config = original();
      // After the scope is captured, the device is re-bound to another salon.
      return calls >= 2 ? { ...config, salonId: 'salon-2' } : config;
    };
    const result = await handoff.preflight();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/POS user changed/i);
  });
});

// ── prepare ─────────────────────────────────────────────────────────────────

/** The exact frozen allocation shape the server sends (same fixture the Windows
 *  handoff tests use, so a drift in the contract fails on both platforms). */
function bundle(overrides: Record<string, any> = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    checkoutId: 'checkout-1',
    discountGrosze: 3300,
    totalGrosze: 17000,
    lines: [
      {
        lineKey: 'time-1', kind: 'TIME', variantId: 'billiard-service', displayName: 'Playing time',
        quantity: 1, sellBy: 'PIECE', saleUnit: 'min',
        unitPriceGrosze: 12300, grossTotalGrosze: 12300, allocatedDiscountGrosze: 2300, payableGrosze: 10000,
        vatRate: 23, durationMinutes: 60, inventoryPolicy: 'NONE', refundPolicy: 'FORBIDDEN',
      },
      {
        lineKey: 'fnb-1', kind: 'FNB', sessionItemId: 'session-item-1', variantId: 'cola-variant', displayName: 'Cola',
        quantity: 1, sellBy: 'PIECE', saleUnit: 'szt',
        unitPriceGrosze: 8000, grossTotalGrosze: 8000, allocatedDiscountGrosze: 1000, payableGrosze: 7000,
        vatRate: 8, inventoryPolicy: 'ALREADY_CONSUMED', refundPolicy: 'ALLOWED_NO_RESTOCK',
      },
    ],
    ...overrides,
  };
}

function ordinaryLine() {
  return {
    id: 'own-1', variantId: 'v9', name: 'Piwo', sku: 'P1',
    price: 900, quantity: 1, total: 900, vatRate: 23,
  };
}

describe('prepare — freezing the bill', () => {
  test('an empty cart gets the frozen bill, journalled READY, with an auto-open intent', async () => {
    const { handoff, database, posStore } = await makeHarness();
    const result = await handoff.prepare({ posCheckout: bundle(), tableName: 'Stół #1' });

    expect(result.success).toBe(true);
    expect(result.intent).toMatchObject({
      checkoutId: 'checkout-1',
      sessionId: 'session-1',
      clientAttemptId: 'billiard:checkout-1',
      shouldAutoOpen: true,
    });

    const row = database.get<{ state: string; interrupted_hold_id: string | null }>(
      'SELECT state, interrupted_hold_id FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    );
    expect(row?.state).toBe('POS_READY');
    expect(row?.interrupted_hold_id).toBeNull();

    // The cart on screen IS the server's allocation: locked lines, its total.
    const state = posStore.getState();
    expect(state.cart.items).toHaveLength(2);
    expect(state.cart.items.every((i) => i.locked)).toBe(true);
    expect(state.cart.total).toBe(17000);
    expect(state.checkoutDraft.billiard?.origin.checkoutId).toBe('checkout-1');
    expect(state.checkoutDraft.billiard?.tableName).toBe('Stół #1');
    expect(state.checkoutDraft.billiard?.orderCommitted).toBe(false);
  });

  test("a cashier's in-progress cart is refused before any journal or Hold write", async () => {
    const { handoff, database, posStore } = await makeHarness();
    posStore.dispatch({ type: 'cart/addItem', payload: ordinaryLine() as any });
    const before = posStore.getState();

    const result = await handoff.prepare({ posCheckout: bundle() });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Hold the current cart manually/i);
    expect(database.all('SELECT 1 FROM pos_billiard_handoffs')).toHaveLength(0);
    expect(database.all('SELECT 1 FROM pos_hold_orders')).toHaveLength(0);
    expect(posStore.getState()).toEqual(before);
    expect(posStore.getState().checkoutDraft.billiard).toBeUndefined();
  });

  test('repeating the refused prepare never creates a journal or Hold row', async () => {
    const { handoff, database, posStore } = await makeHarness();
    posStore.dispatch({ type: 'cart/addItem', payload: ordinaryLine() as any });
    const before = posStore.getState();

    const first = await handoff.prepare({ posCheckout: bundle() });
    const second = await handoff.prepare({ posCheckout: bundle() });

    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    expect(first.error).toMatch(/Hold the current cart manually/i);
    expect(second.error).toMatch(/Hold the current cart manually/i);
    expect(database.all('SELECT 1 FROM pos_billiard_handoffs')).toHaveLength(0);
    expect(database.all('SELECT 1 FROM pos_hold_orders')).toHaveLength(0);
    expect(posStore.getState()).toEqual(before);
    expect(posStore.getState().checkoutDraft.billiard).toBeUndefined();
  });

  test('a failed durability barrier leaves NO journal row, NO hold, and the live cart intact', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const { configStore, posStore } = await makeHarness({ db: database });
    const realFlush = database.flush.bind(database);
    let failNext = true;
    (database as any).flush = async () => {
      if (failNext) { failNext = false; throw new Error('quota exceeded'); }
      return realFlush();
    };
    const handoff = createBilliardHandoff({
      configStore, posStore, db: async () => database,
      isFiscalPrinterAssigned: async () => false,
      isPrintAgentConnected: () => false,
    });

    const result = await handoff.prepare({ posCheckout: bundle() });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Could not safely persist the Billiard checkout/);
    expect(result.error).toMatch(/quota exceeded/);

    expect(database.all('SELECT 1 FROM pos_billiard_handoffs')).toHaveLength(0);
    expect(database.all('SELECT 1 FROM pos_hold_orders')).toHaveLength(0);
    // Nothing was frozen into the empty cashier screen.
    expect(posStore.getState().cart.items).toHaveLength(0);
    expect(posStore.getState().checkoutDraft.billiard).toBeUndefined();
  });

  test('two concurrent prepares for the same checkout share ONE attempt', async () => {
    const { handoff, database } = await makeHarness();
    const first = handoff.prepare({ posCheckout: bundle() });
    const second = handoff.prepare({ posCheckout: bundle() });
    const [a, b] = await Promise.all([first, second]);
    // Identity, not just equality: the second call joined the SAME attempt
    // instead of racing a second freeze.
    expect(a).toBe(b);
    expect(a.success).toBe(true);
    expect(database.all('SELECT 1 FROM pos_billiard_handoffs')).toHaveLength(1);
  });

  test('a malformed checkout is refused before anything is written', async () => {
    const { handoff, database } = await makeHarness();
    const result = await handoff.prepare({ posCheckout: bundle({ totalGrosze: 999 }) });
    expect(result.success).toBe(false);
    expect(database.all('SELECT 1 FROM pos_billiard_handoffs')).toHaveLength(0);
  });
});

describe('prepare — resuming an already frozen checkout', () => {
  test('the same bundle re-activates the cart without a second journal row', async () => {
    const { handoff, database, posStore } = await makeHarness();
    await handoff.prepare({ posCheckout: bundle() });
    posStore.dispatch({ type: 'display/setMode', payload: { mode: 'idle' } as any });

    const again = await handoff.prepare({ posCheckout: bundle() });
    expect(again.success).toBe(true);
    expect(again.intent?.recovered).toBe(true);
    expect(database.all('SELECT 1 FROM pos_billiard_handoffs')).toHaveLength(1);
    expect(posStore.getState().checkoutDraft.billiard?.origin.checkoutId).toBe('checkout-1');
  });

  test('a DIFFERENT bundle under the same checkout id is refused', async () => {
    const { handoff } = await makeHarness();
    await handoff.prepare({ posCheckout: bundle() });
    // Valid on its own (totals still reconcile) but NOT the bundle that was
    // frozen — only the stored-snapshot comparison can catch this.
    const relabelled = bundle();
    relabelled.lines[1].displayName = 'Cola Zero';
    const tampered = await handoff.prepare({ posCheckout: relabelled });
    expect(tampered.success).toBe(false);
    expect(tampered.error).toMatch(/already has a different frozen snapshot/i);
  });

  test('an ambiguous tender outcome returns outcomeUncertain and never reopens payment', async () => {
    const { handoff, database } = await makeHarness();
    await handoff.prepare({ posCheckout: bundle() });
    const journal = createBilliardHandoffRepo(database);
    journal.markPaymentOpened('checkout-1');
    journal.markTenderCommitting('checkout-1');
    journal.markTenderUncertain('checkout-1');

    const result = await handoff.prepare({ posCheckout: bundle() });
    expect(result.success).toBe(true);
    expect(result.outcomeUncertain).toBe(true);
    expect(result.intent?.shouldAutoOpen).toBe(false);
    expect(result.intent?.tenderOutcomeUncertain).toBe(true);
  });

  test('a second, unrelated checkout is refused while one is unresolved', async () => {
    const { handoff, database } = await makeHarness();
    await handoff.prepare({ posCheckout: bundle() });
    const other = await handoff.prepare({
      posCheckout: bundle({ checkoutId: 'checkout-2', sessionId: 'session-2' }),
    });
    expect(other.success).toBe(false);
    expect(other.error).toMatch(/still unresolved on this register|already active/i);
    expect(database.all('SELECT 1 FROM pos_billiard_handoffs')).toHaveLength(1);
  });

  test('an unpaired tablet cannot prepare either', async () => {
    const { handoff } = await makeHarness({ paired: false });
    const result = await handoff.prepare({ posCheckout: bundle() });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pair/i);
  });
});

// ── the payment boundary ────────────────────────────────────────────────────

describe('markPaymentOpened / beginTender — not charging twice', () => {
  async function frozen(opts: Parameters<typeof makeHarness>[0] = {}) {
    const h = await makeHarness(opts);
    const prepared = await h.handoff.prepare({ posCheckout: bundle() });
    expect(prepared.success).toBe(true);
    return h;
  }

  test('opening payment moves the journal to POS_PAYMENT_OPEN and issues a token', async () => {
    const { handoff, database } = await frozen();
    const opened = await handoff.markPaymentOpened('checkout-1');
    expect(opened.success).toBe(true);
    expect(opened.token).toBeTruthy();
    expect(opened.expiresAt).toBeGreaterThan(Date.now());
    expect(database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('POS_PAYMENT_OPEN');
  });

  test('a checkout from another register is not found', async () => {
    const { handoff, configStore } = await frozen();
    configStore.setConfig({ agentId: 'agent-OTHER' } as any);
    const opened = await handoff.markPaymentOpened('checkout-1');
    expect(opened.success).toBe(false);
    expect(opened.error).toMatch(/not found on this register/i);
  });

  test('a cart that does not match the frozen snapshot blocks payment', async () => {
    // The realistic drift on a tablet: the app was killed, the in-memory cart
    // is gone, but the journal survived on disk. The bill must not be charged
    // against a cart this process cannot verify.
    // (Note the L4 reducer already refuses to overwrite an active frozen
    // checkout, so drifting the cart by dispatch is not even possible.)
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const { configStore } = await frozen({ db: database });
    const restartedStore = new ShimPosStore();
    restartedStore.dispatch({
      type: 'session/open',
      payload: { shiftId: SHIFT.id, staffId: SHIFT.staffId, staffName: SHIFT.staffName, openedAt: 'now' },
    });
    const afterRestart = createBilliardHandoff({
      configStore,
      posStore: restartedStore,
      db: async () => database,
      isFiscalPrinterAssigned: async () => false,
      isPrintAgentConnected: () => false,
    });

    const opened = await afterRestart.markPaymentOpened('checkout-1');
    expect(opened.success).toBe(false);
    expect(opened.error).toMatch(/does not match this frozen Billiard checkout/i);
    // And the journal was not advanced.
    expect(database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('POS_READY');
  });

  test('a failed durability barrier rolls the payment-open boundary back', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const { handoff } = await frozen({ db: database });
    const realFlush = database.flush.bind(database);
    (database as any).flush = async () => { throw new Error('quota exceeded'); };

    const opened = await handoff.markPaymentOpened('checkout-1');
    expect(opened.success).toBe(false);
    expect(opened.error).toMatch(/quota exceeded/);
    // Back to READY: a payment modal must not open over an unpersisted boundary.
    expect(database.get<{ state: string; auto_open_consumed: number }>(
      'SELECT state, auto_open_consumed FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )).toMatchObject({ state: 'POS_READY', auto_open_consumed: 0 });
    (database as any).flush = realFlush;
  });

  test('the happy path: open → tender crosses to POS_TENDER_COMMITTING', async () => {
    const { handoff, database } = await frozen();
    const opened = await handoff.markPaymentOpened('checkout-1');
    const tender = await handoff.beginTender('checkout-1', opened.token!);
    expect(tender.success).toBe(true);
    expect(database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('POS_TENDER_COMMITTING');
  });

  test('tender without a token, or with a stale one, is refused', async () => {
    const { handoff } = await frozen();
    const noToken = await handoff.beginTender('checkout-1', '');
    expect(noToken.success).toBe(false);
    expect(noToken.error).toMatch(/preflight is missing or expired/i);

    const opened = await handoff.markPaymentOpened('checkout-1');
    // A logout between opening payment and collecting it invalidates the token.
    handoff.invalidateAuth();
    const stale = await handoff.beginTender('checkout-1', opened.token!);
    expect(stale.success).toBe(false);
    expect(stale.error).toMatch(/POS user changed after payment preflight/i);
  });

  test('a shift change between opening payment and tendering is refused', async () => {
    const { handoff, database, posStore } = await frozen();
    const opened = await handoff.markPaymentOpened('checkout-1');
    // Cashier closed and reopened the shift while the modal sat open.
    database.run("UPDATE shifts SET closed_at = datetime('now') WHERE id = ?", [SHIFT.id]);
    database.run('INSERT INTO shifts (id, staff_id, staff_name, opening_cash) VALUES (?, ?, ?, ?)', ['shift-2', 'u1', 'Anna', 0]);
    posStore.dispatch({
      type: 'session/open',
      payload: { shiftId: 'shift-2', staffId: 'u1', staffName: 'Anna', openedAt: 'now' },
    });
    const tender = await handoff.beginTender('checkout-1', opened.token!);
    expect(tender.success).toBe(false);
    expect(tender.error).toMatch(/shift changed after payment preflight/i);
  });

  test('a second tender on a boundary already crossed is uncertain, never a re-charge', async () => {
    const { handoff } = await frozen();
    const opened = await handoff.markPaymentOpened('checkout-1');
    await handoff.beginTender('checkout-1', opened.token!);

    const again = await handoff.beginTender('checkout-1', opened.token!);
    expect(again.success).toBe(false);
    expect(again.outcomeUncertain).toBe(true);
    expect(again.error).toMatch(/Do not charge again/i);
  });

  test('an order already committed locally reports paymentCommitted instead of charging', async () => {
    const { handoff, database } = await frozen();
    const opened = await handoff.markPaymentOpened('checkout-1');
    const orderId = database.get<{ order_id: string }>(
      'SELECT order_id FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )!.order_id;
    database.run('INSERT INTO orders (id, total) VALUES (?, ?)', [orderId, 17000]);

    const tender = await handoff.beginTender('checkout-1', opened.token!);
    expect(tender.success).toBe(false);
    expect(tender.paymentCommitted).toBe(true);
    expect(tender.orderId).toBe(orderId);
    expect(tender.error).toMatch(/already recorded locally/i);
  });

  test('a failed tender-boundary flush rolls back to POS_PAYMENT_OPEN', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const { handoff } = await frozen({ db: database });
    const opened = await handoff.markPaymentOpened('checkout-1');
    const realFlush = database.flush.bind(database);
    (database as any).flush = async () => { throw new Error('disk gone'); };

    const tender = await handoff.beginTender('checkout-1', opened.token!);
    expect(tender.success).toBe(false);
    expect(tender.error).toMatch(/disk gone/);
    // The renderer was never released past the boundary, so this rollback is safe.
    expect(database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('POS_PAYMENT_OPEN');
    (database as any).flush = realFlush;
  });
});

describe('order-repo keeps the billiard identity the renderer sends (schema v7)', () => {
  test('client_attempt_id, origin and per-line metadata survive a create', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const { createOrderRepo } = await import('../src/renderer/android-pos/shim/db/order-repo');
    const repo = createOrderRepo(database);
    repo.create(
      {
        id: 'order-1', total: 17000, subtotal: 20300, discount: 3300, tax: 3000,
        client_attempt_id: 'billiard:checkout-1',
        billiard_origin_json: JSON.stringify({ type: 'BILLIARD_SESSION', sessionId: 'session-1', checkoutId: 'checkout-1', snapshotVersion: 1 }),
      },
      [{
        id: 'order-1:time-1', order_id: 'order-1', variant_id: 'billiard-service', name: 'Playing time',
        price: 12300, quantity: 1, total: 12300, vat_rate: 23,
        billiard_json: JSON.stringify({ lineKey: 'time-1', kind: 'TIME' }),
        inventory_policy: 'NONE', refund_policy: 'FORBIDDEN',
        allocated_discount: 2300, payable_total: 10000,
      }],
    );

    const order = repo.getById('order-1');
    expect(order.client_attempt_id).toBe('billiard:checkout-1');
    expect(JSON.parse(order.billiard_origin_json).checkoutId).toBe('checkout-1');

    const [line] = repo.getItemsByOrderId('order-1');
    expect(JSON.parse(line.billiard_json).lineKey).toBe('time-1');
    expect(line.inventory_policy).toBe('NONE');
    expect(line.refund_policy).toBe('FORBIDDEN');
    expect(line.allocated_discount).toBe(2300);
    expect(line.payable_total).toBe(10000);
  });

  test('an ordinary line defaults payable_total to its own total', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const { createOrderRepo } = await import('../src/renderer/android-pos/shim/db/order-repo');
    const repo = createOrderRepo(database);
    repo.create({ id: 'order-2', total: 900 }, [
      { id: 'i1', order_id: 'order-2', variant_id: 'v9', name: 'Piwo', price: 900, quantity: 1, total: 900, vat_rate: 23 },
    ]);
    const [line] = repo.getItemsByOrderId('order-2');
    expect(line.payable_total).toBe(900);
    expect(line.allocated_discount).toBe(0);
    expect(line.billiard_json).toBeNull();
  });
});

// ── complete ────────────────────────────────────────────────────────────────

/**
 * Build the committed order + lines the way the SHARED PaymentModal does
 * (PaymentModal.tsx:673-705). If this stops satisfying the shared verifier,
 * the renderer contract has drifted — which is exactly what we want to hear.
 */
function committedOrderFrom(record: { orderId: string; clientAttemptId: string; sessionId: string; checkoutId: string }, b = bundle()) {
  const order = {
    id: record.orderId,
    subtotal: b.lines.reduce((s, l) => s + l.grossTotalGrosze, 0),
    discount: b.discountGrosze,
    // The frozen cart's tax, as stored in the snapshot (23% on 10000 + 8% on 7000).
    tax: Math.round(10000 - (10000 * 100) / 123) + Math.round(7000 - (7000 * 100) / 108),
    total: b.totalGrosze,
    payment_method: 'CASH',
    client_attempt_id: record.clientAttemptId,
    billiard_origin_json: JSON.stringify({
      type: 'BILLIARD_SESSION', sessionId: record.sessionId, checkoutId: record.checkoutId, snapshotVersion: 1,
    }),
  };
  const items = b.lines.map((line: any) => ({
    id: `${record.orderId}:${line.lineKey}`,
    order_id: record.orderId,
    variant_id: line.variantId,
    name: line.displayName,
    sku: line.sku ?? '',
    price: line.unitPriceGrosze,
    quantity: line.quantity,
    sale_quantity: line.quantity,
    sale_unit: line.saleUnit,
    sell_by: line.sellBy,
    total: line.grossTotalGrosze,
    vat_rate: line.vatRate,
    billiard_json: JSON.stringify({
      kind: line.kind, sessionItemId: line.sessionItemId, lineKey: line.lineKey,
      durationMinutes: line.durationMinutes, displayName: line.displayName,
      inventoryPolicy: line.inventoryPolicy, refundPolicy: line.refundPolicy,
      sellBy: line.sellBy, saleUnit: line.saleUnit,
      grossTotalGrosze: line.grossTotalGrosze,
      allocatedDiscountGrosze: line.allocatedDiscountGrosze,
      payableGrosze: line.payableGrosze,
    }),
    inventory_policy: line.inventoryPolicy,
    refund_policy: line.refundPolicy,
    allocated_discount: line.allocatedDiscountGrosze,
    payable_total: line.payableGrosze,
  }));
  return { order, items };
}

describe('complete — settling after the money is in', () => {
  async function tendered(opts: Parameters<typeof makeHarness>[0] = {}) {
    const h = await makeHarness(opts);
    await h.handoff.prepare({ posCheckout: bundle() });
    const opened = await h.handoff.markPaymentOpened('checkout-1');
    await h.handoff.beginTender('checkout-1', opened.token!);
    const record = h.database.get<{ order_id: string; client_attempt_id: string }>(
      'SELECT order_id, client_attempt_id FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )!;
    return {
      ...h,
      record: {
        orderId: record.order_id,
        clientAttemptId: record.client_attempt_id,
        sessionId: 'session-1',
        checkoutId: 'checkout-1',
      },
    };
  }

  test('a faithful committed order settles the journal and clears the cart', async () => {
    const { handoff, database, posStore, record } = await tendered();
    const { createOrderRepo } = await import('../src/renderer/android-pos/shim/db/order-repo');
    const { order, items } = committedOrderFrom(record);
    createOrderRepo(database).create(order, items);

    const result = await handoff.complete('checkout-1', record.orderId);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('POS_PAID_SYNC_PENDING');
    // Cashier gets a clean screen back.
    expect(posStore.getState().cart.items).toHaveLength(0);
    expect(posStore.getState().checkoutDraft.billiard).toBeUndefined();
  });

  test('an order whose TOTAL differs from the frozen bill refuses — and keeps the cart', async () => {
    const { handoff, database, posStore, record } = await tendered();
    const { createOrderRepo } = await import('../src/renderer/android-pos/shim/db/order-repo');
    const { order, items } = committedOrderFrom(record);
    createOrderRepo(database).create({ ...order, total: order.total - 100 }, items);

    const result = await handoff.complete('checkout-1', record.orderId);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/totals or identity do not match/i);
    // The cart is the last local evidence of what was owed — it must survive.
    expect(posStore.getState().cart.items).toHaveLength(2);
    expect(database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).not.toBe('SETTLED');
  });

  test('a tampered LINE refuses even when the order totals still add up', async () => {
    const { handoff, database, posStore, record } = await tendered();
    const { createOrderRepo } = await import('../src/renderer/android-pos/shim/db/order-repo');
    const { order, items } = committedOrderFrom(record);
    // Same money on the order, but a line now claims a different payable split.
    items[1] = { ...items[1], payable_total: items[1].payable_total - 1, allocated_discount: items[1].allocated_discount + 1 };
    createOrderRepo(database).create(order, items);

    const result = await handoff.complete('checkout-1', record.orderId);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/differs from the frozen server snapshot/i);
    expect(posStore.getState().cart.items).toHaveLength(2);
  });

  test('a missing billiard origin refuses', async () => {
    const { handoff, database, record } = await tendered();
    const { createOrderRepo } = await import('../src/renderer/android-pos/shim/db/order-repo');
    const { order, items } = committedOrderFrom(record);
    createOrderRepo(database).create({ ...order, billiard_origin_json: null }, items);

    const result = await handoff.complete('checkout-1', record.orderId);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid origin metadata/i);
  });

  test('a wrong orderId, or no local order at all, cannot be verified', async () => {
    const { handoff, record } = await tendered();
    await expect(handoff.complete('checkout-1', 'some-other-order'))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/could not be verified/i) });
    // Right id, but nothing was committed locally.
    await expect(handoff.complete('checkout-1', record.orderId))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/could not be verified/i) });
  });
});

// ── recover ─────────────────────────────────────────────────────────────────

describe('recover — picking the journal back up after the app was killed', () => {
  /** A tablet restart: same database, brand-new (empty) in-memory POS store. */
  async function afterRestart(h: Harness, opts: { role?: string } = {}) {
    if (opts.role) h.configStore.setConfig({ authUser: { ...(h.configStore.getRawConfig().authUser as any), role: opts.role } } as any);
    const posStore = new ShimPosStore();
    posStore.dispatch({
      type: 'session/open',
      payload: { shiftId: SHIFT.id, staffId: SHIFT.staffId, staffName: SHIFT.staffName, openedAt: 'now' },
    });
    return {
      posStore,
      handoff: createBilliardHandoff({
        configStore: h.configStore,
        posStore,
        db: async () => h.database,
        isFiscalPrinterAssigned: async () => false,
        isPrintAgentConnected: () => false,
      }),
    };
  }

  test('nothing to resume returns a null intent, not an error', async () => {
    const { handoff } = await makeHarness();
    await expect(handoff.recover()).resolves.toEqual({ success: true, intent: null });
  });

  test('a frozen-but-unpaid bill is put back on the screen', async () => {
    const h = await makeHarness();
    await h.handoff.prepare({ posCheckout: bundle() });
    const restarted = await afterRestart(h);

    const result = await restarted.handoff.recover();
    expect(result.success).toBe(true);
    expect(result.intent).toMatchObject({ checkoutId: 'checkout-1', recovered: true });
    expect(restarted.posStore.getState().cart.items).toHaveLength(2);
    expect(restarted.posStore.getState().checkoutDraft.billiard?.origin.checkoutId).toBe('checkout-1');
  });

  test('DYING MID-TENDER marks the outcome UNCERTAIN — payment is never reopened', async () => {
    const h = await makeHarness();
    await h.handoff.prepare({ posCheckout: bundle() });
    const opened = await h.handoff.markPaymentOpened('checkout-1');
    await h.handoff.beginTender('checkout-1', opened.token!);
    // …and the process dies right here, with the charge in an unknown state.
    const restarted = await afterRestart(h);

    const result = await restarted.handoff.recover();
    expect(result.success).toBe(true);
    expect(result.outcomeUncertain).toBe(true);
    expect(result.intent?.tenderOutcomeUncertain).toBe(true);
    expect(result.intent?.shouldAutoOpen).toBe(false);
    expect(h.database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('POS_TENDER_UNCERTAIN');
    // The cart is NOT reactivated for a fresh charge.
    expect(restarted.posStore.getState().cart.items).toHaveLength(0);
  });

  test('a settle whose order ALREADY reached the server closes the journal instead of wedging the register', async () => {
    // The 2026-08-04 device wedge: the order synced, but the journal write that
    // closes it never happened (older build). Because an unresolved checkout
    // blocks the register, every later table refused with "Another Billiard
    // checkout is still unresolved on this register" — and sync could never
    // clear it, since a synced order is never offered to sync again.
    const h = await makeHarness();
    await h.handoff.prepare({ posCheckout: bundle() });
    const opened = await h.handoff.markPaymentOpened('checkout-1');
    await h.handoff.beginTender('checkout-1', opened.token!);
    const row = h.database.get<{ order_id: string; client_attempt_id: string }>(
      'SELECT order_id, client_attempt_id FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )!;
    const { createOrderRepo } = await import('../src/renderer/android-pos/shim/db/order-repo');
    const { order, items } = committedOrderFrom({
      orderId: row.order_id, clientAttemptId: row.client_attempt_id,
      sessionId: 'session-1', checkoutId: 'checkout-1',
    });
    createOrderRepo(h.database).create(order, items);
    // The server accepted it; only the closing state was lost.
    createOrderRepo(h.database).markSynced(row.order_id, 'backend-order-1');

    const restarted = await afterRestart(h);
    const result = await restarted.handoff.recover();

    expect(result.success).toBe(true);
    expect(result.paymentCommitted).toBe(true);
    // Nothing to resume: no banner, no cart, no blocked register.
    expect(result.intent).toBeNull();
    expect(h.database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('SETTLED');
    expect(restarted.posStore.getState().cart.items).toHaveLength(0);
  });

  test('the reconcile survives a record interrupted BEFORE payment opened (illegal jump would throw at boot)', async () => {
    // SETTLED is only reachable from POS_PAID_SYNC_PENDING and the repo throws
    // on an illegal jump. recover() runs at boot, so a throw here is not a
    // failed recovery — it is an app that will not start.
    const h = await makeHarness();
    await h.handoff.prepare({ posCheckout: bundle() });
    const row = h.database.get<{ order_id: string; client_attempt_id: string; state: string }>(
      'SELECT order_id, client_attempt_id, state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )!;
    expect(row.state).toBe('POS_READY');
    const { createOrderRepo } = await import('../src/renderer/android-pos/shim/db/order-repo');
    const { order, items } = committedOrderFrom({
      orderId: row.order_id, clientAttemptId: row.client_attempt_id,
      sessionId: 'session-1', checkoutId: 'checkout-1',
    });
    createOrderRepo(h.database).create(order, items);
    createOrderRepo(h.database).markSynced(row.order_id, 'backend-order-1');

    const restarted = await afterRestart(h);
    await expect(restarted.handoff.recover()).resolves.toMatchObject({ success: true, intent: null });
    expect(h.database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('SETTLED');
  });

  test('an order that is committed but NOT yet synced still asks for sync — it is not closed early', async () => {
    // The distinction that keeps the reconcile honest: local commit alone is
    // not proof the server has the money. Only synced=1 + a backend id is.
    const h = await makeHarness();
    await h.handoff.prepare({ posCheckout: bundle() });
    const opened = await h.handoff.markPaymentOpened('checkout-1');
    await h.handoff.beginTender('checkout-1', opened.token!);
    const row = h.database.get<{ order_id: string; client_attempt_id: string }>(
      'SELECT order_id, client_attempt_id FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )!;
    const { createOrderRepo } = await import('../src/renderer/android-pos/shim/db/order-repo');
    const { order, items } = committedOrderFrom({
      orderId: row.order_id, clientAttemptId: row.client_attempt_id,
      sessionId: 'session-1', checkoutId: 'checkout-1',
    });
    createOrderRepo(h.database).create(order, items);

    const restarted = await afterRestart(h);
    const result = await restarted.handoff.recover();

    expect(result.paymentCommitted).toBe(true);
    expect(result.intent).not.toBeNull();
    expect(h.database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('POS_PAID_SYNC_PENDING');
  });

  test('an already-uncertain checkout stays uncertain and is not re-locked', async () => {
    const h = await makeHarness();
    await h.handoff.prepare({ posCheckout: bundle() });
    const opened = await h.handoff.markPaymentOpened('checkout-1');
    await h.handoff.beginTender('checkout-1', opened.token!);
    const restarted = await afterRestart(h);
    await restarted.handoff.recover();

    const second = await (await afterRestart(h)).handoff.recover();
    expect(second.success).toBe(true);
    expect(second.outcomeUncertain).toBe(true);
  });

  test('a cashier does not see another cashier\'s uncertain checkout, an OWNER does', async () => {
    const h = await makeHarness();
    await h.handoff.prepare({ posCheckout: bundle() });
    const opened = await h.handoff.markPaymentOpened('checkout-1');
    await h.handoff.beginTender('checkout-1', opened.token!);
    await (await afterRestart(h)).handoff.recover(); // → UNCERTAIN

    // Another cashier signs in on the same register.
    h.configStore.setConfig({ authUser: { ...(h.configStore.getRawConfig().authUser as any), id: 'u2', role: 'STAFF' } } as any);
    const staff = await afterRestart(h);
    await expect(staff.handoff.recover()).resolves.toEqual({ success: true, intent: null });

    // The owner can find it — they are the one who can reconcile it.
    const owner = await afterRestart(h, { role: 'OWNER' });
    const found = await owner.handoff.recover();
    expect(found.success).toBe(true);
    expect(found.outcomeUncertain).toBe(true);
    expect(found.intent?.checkoutId).toBe('checkout-1');
  });

  test('a commit that landed before the crash is recognised, not charged again', async () => {
    const h = await makeHarness();
    await h.handoff.prepare({ posCheckout: bundle() });
    const opened = await h.handoff.markPaymentOpened('checkout-1');
    await h.handoff.beginTender('checkout-1', opened.token!);
    const row = h.database.get<{ order_id: string; client_attempt_id: string }>(
      'SELECT order_id, client_attempt_id FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )!;
    const { createOrderRepo } = await import('../src/renderer/android-pos/shim/db/order-repo');
    const { order, items } = committedOrderFrom({
      orderId: row.order_id, clientAttemptId: row.client_attempt_id,
      sessionId: 'session-1', checkoutId: 'checkout-1',
    });
    createOrderRepo(h.database).create(order, items);
    const restarted = await afterRestart(h);

    const result = await restarted.handoff.recover();
    expect(result.success).toBe(true);
    expect(result.paymentCommitted).toBe(true);
    expect(result.outcomeUncertain).toBeUndefined();
    expect(h.database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('POS_PAID_SYNC_PENDING');
  });

  test('a committed order that does NOT match the frozen bill refuses recovery', async () => {
    const h = await makeHarness();
    await h.handoff.prepare({ posCheckout: bundle() });
    const row = h.database.get<{ order_id: string; client_attempt_id: string }>(
      'SELECT order_id, client_attempt_id FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )!;
    const { createOrderRepo } = await import('../src/renderer/android-pos/shim/db/order-repo');
    const { order, items } = committedOrderFrom({
      orderId: row.order_id, clientAttemptId: row.client_attempt_id,
      sessionId: 'session-1', checkoutId: 'checkout-1',
    });
    createOrderRepo(h.database).create({ ...order, total: order.total + 500 }, items);

    const result = await (await afterRestart(h)).handoff.recover();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/totals or identity do not match/i);
  });

  test('recovery refuses to overwrite a different cart the cashier already started', async () => {
    const h = await makeHarness();
    await h.handoff.prepare({ posCheckout: bundle() });
    const restarted = await afterRestart(h);
    restarted.posStore.dispatch({ type: 'cart/addItem', payload: ordinaryLine() as any });

    const result = await restarted.handoff.recover();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Another POS cart is active/i);
    // Their cart is untouched.
    expect(restarted.posStore.getState().cart.items).toHaveLength(1);
  });
});

// ── resolveUncertainTender ──────────────────────────────────────────────────

describe('resolveUncertainTender — the OWNER lane out of a dead end', () => {
  /** Drive a checkout into POS_TENDER_UNCERTAIN the way it really happens:
   *  tender starts, the process dies, recovery locks the outcome. */
  async function uncertain() {
    const h = await makeHarness();
    await h.handoff.prepare({ posCheckout: bundle() });
    const opened = await h.handoff.markPaymentOpened('checkout-1');
    await h.handoff.beginTender('checkout-1', opened.token!);
    const restartedStore = new ShimPosStore();
    restartedStore.dispatch({
      type: 'session/open',
      payload: { shiftId: SHIFT.id, staffId: SHIFT.staffId, staffName: SHIFT.staffName, openedAt: 'now' },
    });
    const afterCrash = createBilliardHandoff({
      configStore: h.configStore,
      posStore: restartedStore,
      db: async () => h.database,
      isFiscalPrinterAssigned: async () => false,
      isPrintAgentConnected: () => false,
    });
    await afterCrash.recover();
    expect(h.database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('POS_TENDER_UNCERTAIN');
    return { ...h, posStore: restartedStore, handoff: afterCrash };
  }

  function asOwner(h: { configStore: ShimConfigStore }) {
    h.configStore.setConfig({
      authUser: { ...(h.configStore.getRawConfig().authUser as any), role: 'OWNER' },
    } as any);
  }

  const GOOD = { target: { type: 'BILLIARD', checkoutId: 'checkout-1' }, reason: 'Terminal shows no charge', confirmedNoPaymentRemains: true };

  test('a cashier cannot resolve it', async () => {
    const h = await uncertain();
    const result = await h.handoff.resolveUncertainTender(GOOD);
    expect(result.success).toBe(false);
    expect(result.code).toBe('OWNER_REQUIRED');
  });

  test('an owner must give a real reason and an explicit confirmation', async () => {
    const h = await uncertain();
    asOwner(h);

    await expect(h.handoff.resolveUncertainTender({ ...GOOD, reason: 'no' }))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/3 to 500 characters/) });
    await expect(h.handoff.resolveUncertainTender({ ...GOOD, reason: 'x'.repeat(501) }))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/3 to 500 characters/) });
    await expect(h.handoff.resolveUncertainTender({ ...GOOD, confirmedNoPaymentRemains: false }))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/Explicit confirmation/) });

    // None of the refusals touched the journal.
    expect(h.database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('POS_TENDER_UNCERTAIN');
  });

  test('a restored cart is refused with a pointer to the counter', async () => {
    const h = await uncertain();
    asOwner(h);
    const result = await h.handoff.resolveUncertainTender({
      ...GOOD, target: { type: 'RESTORED_CART', holdId: 'h1' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Windows counter/i);
  });

  test('a checkout on another register is not found', async () => {
    const h = await uncertain();
    asOwner(h);
    h.configStore.setConfig({ agentId: 'agent-OTHER' } as any);
    const result = await h.handoff.resolveUncertainTender(GOOD);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found for this owner\/register/i);
  });

  test('a checkout that is NOT uncertain cannot be reset', async () => {
    const h = await makeHarness();
    await h.handoff.prepare({ posCheckout: bundle() });
    asOwner(h);
    const result = await h.handoff.resolveUncertainTender(GOOD);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot be resolved from state POS_READY/);
  });

  test('a paid local order means reconcile, not reset', async () => {
    const h = await uncertain();
    asOwner(h);
    const row = h.database.get<{ order_id: string }>(
      'SELECT order_id FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )!;
    h.database.run('INSERT INTO orders (id, total) VALUES (?, ?)', [row.order_id, 17000]);

    const result = await h.handoff.resolveUncertainTender(GOOD);
    expect(result.success).toBe(false);
    expect(result.paymentCommitted).toBe(true);
    expect(result.error).toMatch(/Reconcile it instead/i);
  });

  test('the owner resolution reopens payment, records the audit and restores the cart', async () => {
    const h = await uncertain();
    asOwner(h);
    const result = await h.handoff.resolveUncertainTender(GOOD);

    expect(result.success).toBe(true);
    expect(result.resolved).toBe(true);
    expect(result.targetType).toBe('BILLIARD');
    expect(result.audit).toMatchObject({ reason: 'Terminal shows no charge', action: 'NO_PAYMENT_REMAINS' });
    expect((result.audit as any).ownerUserId).toBe('u1');
    expect(result.intent?.tenderOutcomeUncertain).toBeUndefined();

    expect(h.database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('POS_PAYMENT_OPEN');
    // The audit is append-only evidence, stored with the journal.
    const stored = JSON.parse(h.database.get<{ snapshot_json: string }>(
      'SELECT snapshot_json FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )!.snapshot_json);
    expect(stored.tenderResolutionAudits).toHaveLength(1);
    // …and the frozen bill is back on screen for the owner to take payment.
    expect(h.posStore.getState().cart.items).toHaveLength(2);
  });

  test('a failed durability barrier undoes the resolution — an audit off disk did not happen', async () => {
    const h = await uncertain();
    asOwner(h);
    const realFlush = h.database.flush.bind(h.database);
    let fail = true;
    (h.database as any).flush = async () => {
      if (fail) { fail = false; throw new Error('quota exceeded'); }
      return realFlush();
    };

    const result = await h.handoff.resolveUncertainTender(GOOD);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/quota exceeded/);
    expect(h.database.get<{ state: string }>(
      'SELECT state FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )?.state).toBe('POS_TENDER_UNCERTAIN');
    const stored = JSON.parse(h.database.get<{ snapshot_json: string }>(
      'SELECT snapshot_json FROM pos_billiard_handoffs WHERE checkout_id = ?', ['checkout-1'],
    )!.snapshot_json);
    expect(stored.tenderResolutionAudits ?? []).toHaveLength(0);
  });
});
