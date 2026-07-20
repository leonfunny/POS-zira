import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PosApiClient } from '../src/renderer/android-pos/port/api-client';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { createRemotePrintCoordinator } from '../src/renderer/android-pos/shim/remote-print';
import type { RemotePrintCoordinator } from '../src/renderer/android-pos/shim/remote-print';
import { installShim, __resetShimForTest } from '../src/renderer/android-pos/shim/index';
import type { ShimTransport } from '../src/renderer/android-pos/shim/transport';
import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { TokenStore, type TokenStoreStorage } from '../src/renderer/android-pos/shim/token-store';

// ── Shared helpers (mirror tests/android-remote-print.test.ts) ────────────────

/** Node-friendly sql.js load (mirrors tests/android-shim-db.test.ts). */
const NODE_LOCATE_FILE = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A stub staff-JWT token provider — refresh/expire never fire in these tests. */
const STAFF_TOKEN_PROVIDER = {
  getAccessToken: async () => 'jwt-staff-1',
  refresh: async () => false,
  onExpired: () => undefined,
};

/** Seeded local order + items (grosze integers, CASH — the pilot profile). */
const ORDER = {
  id: 'order-1',
  order_number: 'POS-TEST-1',
  status: 'COMPLETED',
  subtotal: 4900,
  discount: 0,
  tax: 0,
  total: 4900,
  payment_method: 'CASH',
  payment_amount: 5000,
  change_amount: 100,
  staff_name: 'Ala Nowak',
  source: 'POS',
  mode: 'retail',
};
const ITEMS = [{
  id: 'l1', order_id: 'order-1', variant_id: 'p1', name: 'Gel Polish',
  sku: 'SKU-1', price: 4900, quantity: 1, sell_by: 'PIECE', total: 4900, vat_rate: 23,
}];

/** Assignment envelopes. ASSIGNED_FISCAL binds the FISCAL_RECEIPT role (the role
 *  the Windows shared-FISCAL route uses — shared-fiscal-printer.ts:24). */
const ASSIGNED_FISCAL = {
  assignments: [{ id: 'af1', salonId: 'salon-1', role: 'FISCAL_RECEIPT', printerId: 'fiscal-1' }],
};
/** Both a receipt-copy printer AND a fiscal printer bound — proves the two jobs
 *  for the same order use DISJOINT idempotency keys (no collision). */
const ASSIGNED_BOTH = {
  assignments: [
    { id: 'a1', salonId: 'salon-1', role: 'SELF_CHECKOUT_RECEIPT', printerId: 'printer-1' },
    { id: 'af1', salonId: 'salon-1', role: 'FISCAL_RECEIPT', printerId: 'fiscal-1' },
  ],
};
const NO_PRINTER = { assignments: [] };

interface RoutedCall { url: string; method: string; body: any; headers: Record<string, string>; }

function callsOf(mock: ReturnType<typeof vi.fn>): RoutedCall[] {
  return mock.mock.calls.map((call: unknown[]) => {
    const [url, init] = call as [unknown, RequestInit | undefined];
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = v;
    let body: any = undefined;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); }
    }
    return { url: String(url), method: String(init?.method ?? 'GET'), body, headers };
  });
}

/** Hard-rail guards for the PRINT PATH: staff JWT only, the pa_ key never rides
 *  a REST header/Bearer, never the pa_-keyed `agents` printer-CRUD routes.
 *  E-PARITY-1 (owner decision 2026-07-19): a trusted Sunmi terminal MAY call
 *  /print-agent/connect + /print-agent/my-key and open the agent socket at
 *  LOGIN — those two login endpoints are skipped here so this still asserts the
 *  print path is pa_-free (the pa_ key lives in the socket auth + connect body). */
function assertHardRails(mock: ReturnType<typeof vi.fn>): void {
  const calls = callsOf(mock);
  for (const c of calls) {
    // Skip the trusted-terminal login endpoints — the print path guard follows.
    if (/\/print-agent\/(?:connect|my-key)(?=$|[/?])/.test(c.url)) continue;
    // Never the pa_-keyed agent printer-CRUD routes.
    expect(c.url).not.toMatch(/\/print-agent\/agents?\//i);
    // Never a websocket upgrade on a REST call.
    expect(c.url).not.toMatch(/^wss?:\/\//);
    expect(String(c.headers.upgrade ?? '').toLowerCase()).not.toBe('websocket');
    // No pa_ API-key header, no pa_ token value anywhere in the headers.
    for (const [k, v] of Object.entries(c.headers)) {
      expect(k.toLowerCase()).not.toBe('x-print-agent-api-key');
      expect(k.toLowerCase()).not.toBe('x-api-key');
      expect(String(v)).not.toMatch(/^pa_/);
    }
  }
}

function countJobsPosts(mock: ReturnType<typeof vi.fn>): number {
  return callsOf(mock).filter((c) => c.method === 'POST' && /\/print-agent\/jobs$/.test(c.url)).length;
}
function countSafeRetryPosts(mock: ReturnType<typeof vi.fn>): number {
  return callsOf(mock).filter((c) => c.method === 'POST' && /\/print-agent\/jobs\/[^/]+\/safe-retry/.test(c.url)).length;
}

/** Build a coordinator backed by a fresh in-memory SQL.js db (seeded with a paid
 *  CASH order) + a real api-client (fetch stubbed by the test). */
async function buildCoordinator(overrides: {
  machineId?: string;
  pollIntervalMs?: number;
  totalWaitMs?: number;
} = {}): Promise<{ coordinator: RemotePrintCoordinator; fetchMock: ReturnType<typeof vi.fn> }> {
  const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
  createOrderRepo(db).create(ORDER, ITEMS);
  const configStore = new ShimConfigStore({ seed: { salonName: 'Test Salon' } as never });
  const client = new PosApiClient({
    baseUrl: 'https://api.enail.pro',
    tokenProvider: STAFF_TOKEN_PROVIDER,
    salonSlug: 'test-salon',
  });
  const coordinator = createRemotePrintCoordinator({
    client,
    db: async () => db,
    configStore,
    machineId: overrides.machineId ?? 'device-1',
    // Tight, deterministic budgets so the timeout scenario does not hang.
    pollIntervalMs: overrides.pollIntervalMs ?? 5,
    totalWaitMs: overrides.totalWaitMs ?? 60,
    assignmentCacheTtlMs: 1000,
  });
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  return { coordinator, fetchMock };
}

// ── Coordinator tests (the fiscal twin of android-remote-print.test.ts) ───────

describe('android remote fiscal-print coordinator (E-FISCAL)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('no fiscal printer assigned → fiscalPrinted:false skipped, creates no job, no HTTP on the repeat (negative cache)', async () => {
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockResolvedValue(jsonResponse(NO_PRINTER)); // no FISCAL_RECEIPT assignment

    const r1 = await coordinator.requestFiscalPrint('order-1');
    expect(r1).toMatchObject({ success: true, fiscalPrinted: false, skipped: true, reason: 'no-fiscal-printer' });
    // No print job was created (no POST /print-agent/jobs).
    expect(countJobsPosts(fetchMock)).toBe(0);
    assertHardRails(fetchMock);

    // Negative-cached re-skip → ZERO HTTP (the fiscal assignment is remembered for the TTL).
    const callsBefore = fetchMock.mock.calls.length;
    const r2 = await coordinator.requestFiscalPrint('order-1');
    expect(r2).toMatchObject({ fiscalPrinted: false, skipped: true, reason: 'no-fiscal-printer' });
    expect(fetchMock.mock.calls.length).toBe(callsBefore); // no HTTP at all
  });

  test('fiscal printer assigned + job COMPLETED → fiscalPrinted:true, ONE job, fiscal contract body', async () => {
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      if (u.includes('/printer-assignments')) return jsonResponse(ASSIGNED_FISCAL);
      if (method === 'POST' && /\/print-agent\/jobs$/.test(u)) return jsonResponse({ jobId: 'fj-1', status: 'COMPLETED' });
      return jsonResponse({ error: `unexpected ${u}` }, 404);
    });

    const r = await coordinator.requestFiscalPrint('order-1');
    expect(r).toMatchObject({ success: true, fiscalPrinted: true });
    expect(r.reason ?? 'printed').not.toBe('unknown');
    // Exactly ONE createPrintJob (POST /print-agent/jobs), no safe-retry (E-FISCAL never auto-retries).
    expect(countJobsPosts(fetchMock)).toBe(1);
    expect(countSafeRetryPosts(fetchMock)).toBe(0);
    assertHardRails(fetchMock);

    // The job body is the staff-JWT FISCAL contract: RECEIPT job type, FISCAL
    // printer type, the assigned fiscal printerId, referenceType
    // POS_FISCAL_RECEIPT, an idempotency key, and the SAME sale payload the
    // receipt COPY uses (buildSaleReceiptData).
    const create = callsOf(fetchMock).find((c) => c.method === 'POST' && /\/print-agent\/jobs$/.test(c.url))!;
    expect(create.body).toMatchObject({
      jobType: 'RECEIPT',
      printerType: 'FISCAL',
      printerId: 'fiscal-1',
      referenceType: 'POS_FISCAL_RECEIPT',
      referenceId: 'order-1',
      waitForCompletion: true,
    });
    // The fiscal idempotency key (kind 'fiscal', purpose 'default') — DISJOINT
    // from the receipt-copy key (pos-receipt:…:order:v1).
    expect(create.body.idempotencyKey).toBe('pos-fiscal:device-1:order-1:default:v1');
    expect(create.body.payload).toMatchObject({
      orderId: 'order-1',
      orderNumber: 'POS-TEST-1',
      total: 4900,
      payment: { method: 'CASH', amount: 5000 },
    });
    expect(create.body.payload.items[0]).toMatchObject({ name: 'Gel Polish', quantity: 1, totalPrice: 4900, vatRate: 23 });
  });

  test('job FAILED SAFE_BEFORE_PRINT → fiscalPrinted:false reason:safe-before-print, NEVER auto-retries', async () => {
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      if (u.includes('/printer-assignments')) return jsonResponse(ASSIGNED_FISCAL);
      if (method === 'POST' && /\/print-agent\/jobs$/.test(u)) {
        return jsonResponse({
          jobId: 'fj-1', status: 'FAILED',
          failureClass: 'SAFE_BEFORE_PRINT', retryAllowed: true, errorMessage: 'printer out of paper',
        });
      }
      return jsonResponse({ error: `unexpected ${u}` }, 404);
    });

    const r = await coordinator.requestFiscalPrint('order-1');
    expect(r).toMatchObject({ success: true, fiscalPrinted: false, reason: 'safe-before-print' });
    expect(r.error).toContain('paper');
    // Nothing printed; a fresh reissue is the cashier's manual action — E-FISCAL
    // does NOT port Windows' safe-retry loop (divergence #1).
    expect(countJobsPosts(fetchMock)).toBe(1);
    expect(countSafeRetryPosts(fetchMock)).toBe(0);
    const statusPolls = callsOf(fetchMock).filter((c) => c.method === 'GET' && /\/print-agent\/jobs\/fj-1$/.test(c.url));
    expect(statusPolls).toHaveLength(0);
    assertHardRails(fetchMock);
  });

  test('job FAILED UNCERTAIN_AFTER_PRINT → fiscalPrinted:false reason:unknown, NEVER auto-retries (no duplicate fiscal document)', async () => {
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      if (u.includes('/printer-assignments')) return jsonResponse(ASSIGNED_FISCAL);
      if (method === 'POST' && /\/print-agent\/jobs$/.test(u)) {
        // The paper may already have come out — STOP_RECONCILE_REQUIRED.
        return jsonResponse({
          jobId: 'fj-1', status: 'FAILED',
          failureClass: 'UNCERTAIN_AFTER_PRINT', errorMessage: 'paper jam after print',
        });
      }
      return jsonResponse({ error: `unexpected ${u}` }, 404);
    });

    const r = await coordinator.requestFiscalPrint('order-1');
    expect(r).toMatchObject({ success: true, fiscalPrinted: false, reason: 'unknown' });
    expect(countJobsPosts(fetchMock)).toBe(1);
    expect(countSafeRetryPosts(fetchMock)).toBe(0);
    assertHardRails(fetchMock);
  });

  test('timeout / still-in-flight after the wait budget → fiscalPrinted:false reason:unknown, NEVER auto-retries', async () => {
    const { coordinator, fetchMock } = await buildCoordinator({ pollIntervalMs: 10, totalWaitMs: 45 });
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      if (u.includes('/printer-assignments')) return jsonResponse(ASSIGNED_FISCAL);
      if (method === 'POST' && /\/print-agent\/jobs$/.test(u)) return jsonResponse({ jobId: 'fj-1', status: 'PRINTING' });
      // The job never reaches a terminal state → the budget expires → UNCERTAIN.
      if (/\/print-agent\/jobs\/fj-1$/.test(u)) return jsonResponse({ jobId: 'fj-1', status: 'PRINTING' });
      return jsonResponse({ error: `unexpected ${u}` }, 404);
    });

    const r = await coordinator.requestFiscalPrint('order-1');
    expect(r).toMatchObject({ success: true, fiscalPrinted: false, reason: 'unknown' });
    expect(countJobsPosts(fetchMock)).toBe(1);    // one create
    expect(countSafeRetryPosts(fetchMock)).toBe(0); // NEVER auto-retry an uncertain fiscal job
    // It polled status at least once before giving up (bounded, not infinite).
    const statusPolls = callsOf(fetchMock).filter((c) => c.method === 'GET' && /\/print-agent\/jobs\/fj-1$/.test(c.url));
    expect(statusPolls.length).toBeGreaterThanOrEqual(1);
    assertHardRails(fetchMock);
  });

  test('repeated printFiscalReceipt for the same order reuses ONE job (idempotent — never a duplicate fiscal document)', async () => {
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      if (u.includes('/printer-assignments')) return jsonResponse(ASSIGNED_FISCAL);
      if (method === 'POST' && /\/print-agent\/jobs$/.test(u)) return jsonResponse({ jobId: 'fj-1', status: 'COMPLETED' });
      // Resume path polls the SAME fiscal job instead of re-creating it.
      if (/\/print-agent\/jobs\/fj-1$/.test(u)) return jsonResponse({ jobId: 'fj-1', status: 'COMPLETED' });
      return jsonResponse({ error: `unexpected ${u}` }, 404);
    });

    const r1 = await coordinator.requestFiscalPrint('order-1');
    expect(r1).toMatchObject({ fiscalPrinted: true });
    const r2 = await coordinator.requestFiscalPrint('order-1');
    expect(r2).toMatchObject({ fiscalPrinted: true });

    // ONE createPrintJob across both calls — the second tap resumed the known fiscal job.
    expect(countJobsPosts(fetchMock)).toBe(1);
    const statusPolls = callsOf(fetchMock).filter((c) => c.method === 'GET' && /\/print-agent\/jobs\/fj-1$/.test(c.url));
    expect(statusPolls.length).toBeGreaterThanOrEqual(1);
    assertHardRails(fetchMock);
  });

  test('fiscal + receipt jobs for the same order use DISJOINT idempotency keys (two independent jobs)', async () => {
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      if (u.includes('/printer-assignments')) return jsonResponse(ASSIGNED_BOTH);
      if (method === 'POST' && /\/print-agent\/jobs$/.test(u)) return jsonResponse({ jobId: 'job-' + Math.random(), status: 'COMPLETED' });
      return jsonResponse({ error: `unexpected ${u}` }, 404);
    });

    const receipt = await coordinator.requestReceiptPrint('order-1');
    const fiscal = await coordinator.requestFiscalPrint('order-1');
    expect(receipt).toMatchObject({ receiptPrinted: true });
    expect(fiscal).toMatchObject({ fiscalPrinted: true });

    // Two creates (one receipt-copy + one fiscal) — the jobs are independent.
    expect(countJobsPosts(fetchMock)).toBe(2);
    const creates = callsOf(fetchMock).filter((c) => c.method === 'POST' && /\/print-agent\/jobs$/.test(c.url));
    const receiptCreate = creates.find((c) => c.body.printerType === 'RECEIPT');
    const fiscalCreate = creates.find((c) => c.body.printerType === 'FISCAL');
    expect(receiptCreate?.body.idempotencyKey).toBe('pos-receipt:device-1:order-1:order:v1');
    expect(fiscalCreate?.body.idempotencyKey).toBe('pos-fiscal:device-1:order-1:default:v1');
    expect(receiptCreate?.body.referenceType).toBe('POS_RECEIPT');
    expect(fiscalCreate?.body.referenceType).toBe('POS_FISCAL_RECEIPT');
    assertHardRails(fetchMock);
  });

  test('getFiscalPrinterStatus reflects the FISCAL_RECEIPT assignment', async () => {
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockResolvedValue(jsonResponse(ASSIGNED_FISCAL));
    const status = await coordinator.getFiscalPrinterStatus();
    expect(status).toMatchObject({ assigned: true, printerId: 'fiscal-1' });
    assertHardRails(fetchMock);

    // No fiscal assignment → unassigned.
    fetchMock.mockResolvedValue(jsonResponse(NO_PRINTER));
    const status2 = await coordinator.getFiscalPrinterStatus(true); // forceRefresh past the positive cache
    expect(status2).toMatchObject({ assigned: false });
  });
});

// ── Real-transport wiring (build()/loggedIn harness — transport delegates) ────

function memoryStorage(): TokenStoreStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const LOGIN_BODY = {
  access_token: 'jwt-access-1',
  refresh_token: 'jwt-refresh-1',
  user: {
    id: 'staff-1',
    email: 'staff@salon.pl',
    firstName: 'Ala',
    lastName: 'Nowak',
    role: 'STAFF',
    salonId: 'salon-1',
    salon: { id: 'salon-1', name: 'Test Salon', slug: 'test-salon' },
  },
};

const CASH_ORDER = (shiftId: string) => ({
  id: 'local-order-1',
  order_number: null,
  number_series: 'ORDER',
  status: 'COMPLETED',
  subtotal: 4900,
  discount: 0,
  tax: 0,
  total: 4900,
  payment_method: 'CASH',
  payment_amount: 5000,
  change_amount: 100,
  shift_id: shiftId,
  source: 'POS',
  mode: 'retail',
  synced: 0,
});
const CASH_ITEMS = [{
  id: 'line-1', order_id: 'local-order-1', variant_id: 'p1', name: 'Gel Polish',
  sku: 'SKU-1', price: 4900, quantity: 1, sell_by: 'PIECE', total: 4900, vat_rate: 23,
}];

describe('android fiscal-print real-transport wiring (E-FISCAL)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function build() {
    const configStore = new ShimConfigStore({ storage: memoryStorage() });
    const tokenStore = new TokenStore({ storage: memoryStorage() });
    const transport = createRealTransport({
      configStore,
      tokenStore,
      dbInit: { locateFile: NODE_LOCATE_FILE },
    });
    return { configStore, tokenStore, transport };
  }

  test('transport.requestFiscalPrint delegates to the coordinator over the staff-JWT route', async () => {
    const { transport } = build();
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      if (u.includes('/auth/login')) return jsonResponse(LOGIN_BODY);
      if (u.includes('/pos/shifts/open')) return jsonResponse({ shiftId: 'server-shift' });
      if (u.includes('/printer-assignments')) return jsonResponse(ASSIGNED_FISCAL);
      if (method === 'POST' && /\/print-agent\/jobs$/.test(u)) return jsonResponse({ jobId: 'fj-rt', status: 'COMPLETED' });
      throw new Error(`unexpected fetch: ${u}`);
    });

    await transport.loginWithEmail!('staff@salon.pl', 'pw');
    const open = await transport.openShift!({ staffId: 'staff-1', staffName: 'Ala Nowak', openingCash: 10000 });
    await transport.createOrder!(CASH_ORDER(open.shiftId!), CASH_ITEMS);

    const r = await transport.requestFiscalPrint!('local-order-1');
    expect(r).toMatchObject({ success: true, fiscalPrinted: true, jobId: 'fj-rt' });

    // The created job is the staff-JWT FISCAL contract.
    const create = callsOf(fetchMock).find((c) => c.method === 'POST' && /\/print-agent\/jobs$/.test(c.url))!;
    expect(create.body).toMatchObject({
      jobType: 'RECEIPT', printerType: 'FISCAL', printerId: 'fiscal-1',
      referenceType: 'POS_FISCAL_RECEIPT', referenceId: 'local-order-1',
    });
    assertHardRails(fetchMock);
  });

  test('transport.getFiscalPrinterStatus reflects the FISCAL_RECEIPT assignment', async () => {
    const { transport } = build();
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/auth/login')) return jsonResponse(LOGIN_BODY);
      if (u.includes('/printer-assignments')) return jsonResponse(ASSIGNED_FISCAL);
      throw new Error(`unexpected fetch: ${u}`);
    });
    await transport.loginWithEmail!('staff@salon.pl', 'pw');
    const status = await transport.getFiscalPrinterStatus!();
    expect(status).toMatchObject({ assigned: true, printerId: 'fiscal-1' });
    assertHardRails(fetchMock);
  });
});

// ── Stub wiring (stubs.ts buildPaymentNamespace → transport) ──────────────────

describe('android fiscal-print stub wiring (stubs.ts → transport)', () => {
  beforeEach(() => __resetShimForTest());
  afterEach(() => __resetShimForTest());

  test('hasFiscalPrinter maps a FISCAL assignment to configured + connected', async () => {
    const transport: ShimTransport = {
      getFiscalPrinterStatus: async () => ({ assigned: true, printerId: 'fiscal-1' }),
    };
    const { api } = installShim({ transport });
    expect(await api.pos.payment.hasFiscalPrinter()).toEqual({ success: true, configured: true, connected: true });
  });

  test('hasFiscalPrinter reports unconfigured when no fiscal printer is assigned', async () => {
    const transport: ShimTransport = {
      getFiscalPrinterStatus: async () => ({ assigned: false }),
    };
    const { api } = installShim({ transport });
    expect(await api.pos.payment.hasFiscalPrinter()).toEqual({ success: true, configured: false, connected: false });
  });

  test('printFiscalReceipt delegates to transport.requestFiscalPrint', async () => {
    const transport: ShimTransport = {
      requestFiscalPrint: async () => ({ success: true, fiscalPrinted: true, jobId: 'fj-1', printerId: 'fiscal-1' }),
    };
    const { api } = installShim({ transport });
    expect(await api.pos.payment.printFiscalReceipt('o1')).toEqual({
      success: true, fiscalPrinted: true, jobId: 'fj-1', printerId: 'fiscal-1',
    });
  });

  test('with no transport the Wave-1 fiscal fallbacks stay fiscalPrinted:false / unconfigured', async () => {
    const { api } = installShim();
    expect(await api.pos.payment.printFiscalReceipt('o1')).toEqual({ success: true, fiscalPrinted: false });
    expect(await api.pos.payment.hasFiscalPrinter()).toEqual({ success: true, configured: false, connected: false });
  });
});
