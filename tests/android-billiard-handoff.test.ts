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

  test("a cashier's in-progress cart is parked in a PROTECTED hold, never discarded", async () => {
    const { handoff, database, posStore } = await makeHarness();
    posStore.dispatch({ type: 'cart/addItem', payload: ordinaryLine() as any });
    expect(posStore.getState().cart.items).toHaveLength(1);

    const result = await handoff.prepare({ posCheckout: bundle() });
    expect(result.success).toBe(true);

    const holds = database.all<{ id: string; payload: string }>('SELECT id, payload FROM pos_hold_orders');
    expect(holds).toHaveLength(1);
    expect(holds[0].id).toBe('billiard-interruption:checkout-1');
    const payload = JSON.parse(holds[0].payload);
    expect(payload.protected).toBe(true);
    expect(payload.holdReason).toBe('BILLIARD_INTERRUPTION');
    expect(payload.snapshot.state.cart.items).toHaveLength(1);
    expect(payload.autoRestoreForCheckoutId).toBe('checkout-1');

    // Screen now shows the billiard bill, not the parked cart.
    expect(posStore.getState().cart.items.map((i) => i.name)).toEqual(['Playing time', 'Cola']);
  });

  test('a failed durability barrier leaves NO journal row, NO hold, and the live cart intact', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const { configStore, posStore } = await makeHarness({ db: database });
    posStore.dispatch({ type: 'cart/addItem', payload: ordinaryLine() as any });
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
    expect(result.error).toMatch(/Could not safely hold the current POS cart/);
    expect(result.error).toMatch(/quota exceeded/);

    expect(database.all('SELECT 1 FROM pos_billiard_handoffs')).toHaveLength(0);
    expect(database.all('SELECT 1 FROM pos_hold_orders')).toHaveLength(0);
    // The cashier still owns their cart — nothing was frozen.
    expect(posStore.getState().cart.items).toHaveLength(1);
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
