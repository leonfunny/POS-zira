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
