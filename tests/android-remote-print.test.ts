import { afterEach, describe, expect, test, vi } from 'vitest';

import { PosApiClient } from '../src/renderer/android-pos/port/api-client';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { createRemotePrintCoordinator } from '../src/renderer/android-pos/shim/remote-print';
import type { RemotePrintCoordinator } from '../src/renderer/android-pos/shim/remote-print';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/** An assignment envelope with one salon receipt printer bound to the
 *  SELF_CHECKOUT_RECEIPT role (the role the Windows shared-receipt route uses). */
const ASSIGNED = {
  assignments: [{ id: 'a1', salonId: 'salon-1', role: 'SELF_CHECKOUT_RECEIPT', printerId: 'printer-1' }],
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

/** Hard-rail guards (every scenario): staff JWT only, never the pa_ key, never
 *  /print-agent/connect, never the agent socket. */
function assertHardRails(mock: ReturnType<typeof vi.fn>): void {
  const calls = callsOf(mock);
  for (const c of calls) {
    // Never the agent connect / handshake / pa_-keyed agent routes.
    expect(c.url).not.toContain('/print-agent/connect');
    expect(c.url).not.toContain('/print-agent/my-key');
    expect(c.url).not.toMatch(/\/print-agent\/agent\//); // the *WithApiKey routes
    // Never a websocket upgrade.
    expect(c.url).not.toMatch(/^wss?:\/\//);
    expect(String(c.headers.upgrade ?? '').toLowerCase()).not.toBe('websocket');
    // No pa_ API-key header, no pa_ token value anywhere in the headers.
    for (const [k, v] of Object.entries(c.headers)) {
      expect(k.toLowerCase()).not.toBe('x-print-agent-api-key');
      expect(k.toLowerCase()).not.toBe('x-api-key');
      expect(String(v)).not.toMatch(/^pa_/);
    }
  }
  // At least one call IS staff-JWT authenticated (Bearer, not pa_).
  const bearer = calls.find((c) => /^Bearer\s+\S+$/i.test(c.headers.Authorization ?? ''));
  expect(bearer, 'expected a staff-JWT Bearer Authorization header').toBeTruthy();
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
  assignmentCacheTtlMs?: number;
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
    assignmentCacheTtlMs: overrides.assignmentCacheTtlMs ?? 1000,
  });
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  return { coordinator, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('android remote receipt-print coordinator (E1a)', () => {
  test('no-printer path returns receiptPrinted:true skipped, creates no job, and re-skips with no HTTP (negative cache)', async () => {
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockResolvedValue(jsonResponse(NO_PRINTER)); // no SELF_CHECKOUT_RECEIPT assignment

    const r1 = await coordinator.requestReceiptPrint('order-1');
    expect(r1).toMatchObject({ success: true, receiptPrinted: true, skipped: true, reason: 'no-printer' });
    // No print job was created (no POST /print-agent/jobs).
    expect(countJobsPosts(fetchMock)).toBe(0);
    assertHardRails(fetchMock);

    // Negative-cached re-skip → ZERO HTTP (the assignment is remembered for the TTL).
    const callsBefore = fetchMock.mock.calls.length;
    const r2 = await coordinator.requestReceiptPrint('order-1');
    expect(r2).toMatchObject({ receiptPrinted: true, skipped: true, reason: 'no-printer' });
    expect(fetchMock.mock.calls.length).toBe(callsBefore); // no HTTP at all
  });

  test('no-printer skip via a FAILING assignment lookup surfaces the resolver error (fields unchanged)', async () => {
    // P1.3 (2026-08-06): a transient 401/5xx on the assignment lookup must
    // surface in the skip result so it is diagnosable — without the `error`
    // field a flaky backend is indistinguishable from "no receipt printer". The
    // skip outcome (receiptPrinted:true) is unchanged; only an optional `error`
    // is added (divergence #2 stays).
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/printer-assignments')) throw new Error('backend 502'); // lookup THROWS
      throw new Error(`unexpected fetch ${u}`);
    });

    const result = await coordinator.requestReceiptPrint('order-1');
    expect(result).toMatchObject({ success: true, receiptPrinted: true, skipped: true, reason: 'no-printer' });
    expect(result.error).toContain('backend 502');
    expect(countJobsPosts(fetchMock)).toBe(0);
    assertHardRails(fetchMock);
  });

  test('printer-assigned happy path creates ONE job, polls to PRINTED, returns receiptPrinted:true', async () => {
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      if (u.includes('/printer-assignments')) return jsonResponse(ASSIGNED);
      if (method === 'POST' && /\/print-agent\/jobs$/.test(u)) return jsonResponse({ jobId: 'job-1', status: 'PRINTING' });
      if (/\/print-agent\/jobs\/job-1$/.test(u)) return jsonResponse({ jobId: 'job-1', status: 'COMPLETED' });
      return jsonResponse({ error: `unexpected ${u}` }, 404);
    });

    const r = await coordinator.requestReceiptPrint('order-1');
    expect(r).toMatchObject({ success: true, receiptPrinted: true });
    expect(r.reason ?? 'printed').not.toBe('unknown');
    // Exactly ONE createPrintJob (POST /print-agent/jobs), polled to terminal.
    expect(countJobsPosts(fetchMock)).toBe(1);
    expect(countSafeRetryPosts(fetchMock)).toBe(0);
    assertHardRails(fetchMock);

    // The job body is the staff-JWT RECEIPT contract: RECEIPT job/printer type,
    // the assigned printerId, referenceType POS_RECEIPT, an idempotency key, and
    // the receipt payload built from the local order.
    const create = callsOf(fetchMock).find((c) => c.method === 'POST' && /\/print-agent\/jobs$/.test(c.url))!;
    expect(create.body).toMatchObject({
      jobType: 'RECEIPT',
      printerType: 'RECEIPT',
      printerId: 'printer-1',
      referenceType: 'POS_RECEIPT',
      referenceId: 'order-1',
      waitForCompletion: true,
    });
    expect(create.body.idempotencyKey).toBe('pos-receipt:device-1:order-1:order:v1');
    expect(create.body.payload).toMatchObject({
      orderId: 'order-1',
      orderNumber: 'POS-TEST-1',
      total: 4900,
      payment: { method: 'CASH', amount: 5000 },
    });
    expect(create.body.payload.items[0]).toMatchObject({ name: 'Gel Polish', quantity: 1, totalPrice: 4900, vatRate: 23 });
  });

  test('job failed SAFE_BEFORE_PRINT → receiptPrinted:false, no auto-retry', async () => {
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      if (u.includes('/printer-assignments')) return jsonResponse(ASSIGNED);
      if (method === 'POST' && /\/print-agent\/jobs$/.test(u)) {
        return jsonResponse({
          jobId: 'job-1', status: 'FAILED',
          failureClass: 'SAFE_BEFORE_PRINT', retryAllowed: true, errorMessage: 'printer out of paper',
        });
      }
      return jsonResponse({ error: `unexpected ${u}` }, 404);
    });

    const r = await coordinator.requestReceiptPrint('order-1');
    expect(r).toMatchObject({ success: true, receiptPrinted: false, reason: 'safe-before-print' });
    expect(r.error).toContain('paper');
    // The job is terminal on create → no status poll, no safe-retry (E1a never auto-retries).
    expect(countJobsPosts(fetchMock)).toBe(1);
    expect(countSafeRetryPosts(fetchMock)).toBe(0);
    const statusPolls = callsOf(fetchMock).filter((c) => c.method === 'GET' && /\/print-agent\/jobs\/job-1$/.test(c.url));
    expect(statusPolls).toHaveLength(0);
    assertHardRails(fetchMock);
  });

  test('timeout / still-in-flight after the wait budget → receiptPrinted:false reason:unknown, NEVER auto-retries', async () => {
    const { coordinator, fetchMock } = await buildCoordinator({ pollIntervalMs: 10, totalWaitMs: 45 });
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      if (u.includes('/printer-assignments')) return jsonResponse(ASSIGNED);
      if (method === 'POST' && /\/print-agent\/jobs$/.test(u)) return jsonResponse({ jobId: 'job-1', status: 'PRINTING' });
      // The job never reaches a terminal state → the budget expires → UNCERTAIN.
      if (/\/print-agent\/jobs\/job-1$/.test(u)) return jsonResponse({ jobId: 'job-1', status: 'PRINTING' });
      return jsonResponse({ error: `unexpected ${u}` }, 404);
    });

    const r = await coordinator.requestReceiptPrint('order-1');
    expect(r).toMatchObject({ success: true, receiptPrinted: false, reason: 'unknown' });
    expect(countJobsPosts(fetchMock)).toBe(1);   // one create
    expect(countSafeRetryPosts(fetchMock)).toBe(0); // NEVER auto-retry an uncertain job
    // It polled status at least once before giving up (bounded, not infinite).
    const statusPolls = callsOf(fetchMock).filter((c) => c.method === 'GET' && /\/print-agent\/jobs\/job-1$/.test(c.url));
    expect(statusPolls.length).toBeGreaterThanOrEqual(1);
    assertHardRails(fetchMock);
  });

  test('repeated printReceipt for the same order reuses the same job (idempotent — ONE createPrintJob)', async () => {
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      if (u.includes('/printer-assignments')) return jsonResponse(ASSIGNED);
      if (method === 'POST' && /\/print-agent\/jobs$/.test(u)) return jsonResponse({ jobId: 'job-1', status: 'COMPLETED' });
      // Resume path polls the SAME job instead of re-creating it.
      if (/\/print-agent\/jobs\/job-1$/.test(u)) return jsonResponse({ jobId: 'job-1', status: 'COMPLETED' });
      return jsonResponse({ error: `unexpected ${u}` }, 404);
    });

    const r1 = await coordinator.requestReceiptPrint('order-1');
    expect(r1).toMatchObject({ receiptPrinted: true });
    const r2 = await coordinator.requestReceiptPrint('order-1');
    expect(r2).toMatchObject({ receiptPrinted: true });

    // ONE createPrintJob across both calls — the second tap resumed the known job.
    expect(countJobsPosts(fetchMock)).toBe(1);
    // The resume polled the existing job's status (GET /jobs/job-1) rather than POSTing again.
    const statusPolls = callsOf(fetchMock).filter((c) => c.method === 'GET' && /\/print-agent\/jobs\/job-1$/.test(c.url));
    expect(statusPolls.length).toBeGreaterThanOrEqual(1);
    assertHardRails(fetchMock);
  });

  test('reprint creates a fresh POS_RECEIPT_REPRINT job (isReprint, no idempotency key)', async () => {
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      if (u.includes('/printer-assignments')) return jsonResponse(ASSIGNED);
      if (method === 'POST' && /\/print-agent\/jobs$/.test(u)) return jsonResponse({ jobId: 'job-reprint', status: 'COMPLETED' });
      return jsonResponse({ error: `unexpected ${u}` }, 404);
    });

    const r = await coordinator.requestReceiptPrint('order-1', { isReprint: true });
    expect(r).toMatchObject({ receiptPrinted: true });
    const create = callsOf(fetchMock).find((c) => c.method === 'POST' && /\/print-agent\/jobs$/.test(c.url))!;
    expect(create.body.referenceType).toBe('POS_RECEIPT_REPRINT');
    expect(create.body.payload.isReprint).toBe(true);
    // Reprints carry no idempotency key and do not hold for completion (fresh job each time).
    expect(create.body.idempotencyKey).toBeUndefined();
    expect(create.body.waitForCompletion).toBeUndefined();
    assertHardRails(fetchMock);
  });

  test('getPrinterStatus reports assigned=true when a receipt printer is bound', async () => {
    const { coordinator, fetchMock } = await buildCoordinator();
    fetchMock.mockResolvedValue(jsonResponse(ASSIGNED));
    const status = await coordinator.getPrinterStatus();
    expect(status).toMatchObject({ assigned: true, printerId: 'printer-1' });
    assertHardRails(fetchMock);
  });

  test('assignment lookup ERRORS are cached briefly, not for the full TTL (B2)', async () => {
    // B2 (2026-08-06): a transient 401/5xx/network error on the assignment
    // lookup was negative-cached for the FULL TTL — so one transient error
    // silently routed up to a minute of sales down the no-printer path. An
    // error result is now cached only briefly; a genuine "no assignment" 200
    // keeps the full TTL.
    let calls = 0;
    const { coordinator, fetchMock } = await buildCoordinator({ assignmentCacheTtlMs: 60_000 });
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/printer-assignments')) {
        calls += 1;
        if (calls === 1) throw new Error('backend 502');   // transient error
        return jsonResponse(ASSIGNED);                      // then healthy
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    vi.useFakeTimers();
    try {
      const first = await coordinator.getPrinterStatus(false);
      expect(first.assigned).toBe(false);            // error → unresolved this attempt

      // > 5s error TTL, well inside the 60s full TTL → the error cache must have
      // expired and the lookup re-resolved.
      await vi.advanceTimersByTimeAsync(6_000);
      const second = await coordinator.getPrinterStatus(false);
      expect(second.assigned).toBe(true);            // error cache expired → re-resolved
      expect(calls).toBe(2);
      assertHardRails(fetchMock);
    } finally {
      vi.useRealTimers();
    }
  });
});
