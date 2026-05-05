/**
 * applyOrder — inbound update payload normalisation.
 *
 * The server emits sync_log `entity_type='order'` for refund / cancel
 * via `order.updated` and `order.status-changed` events; the payload
 * is the camelCase REST shape from b2b-pos.service.findOrderById. The
 * applicator must:
 *
 *  - convert refundAmount string ("12.34") to grosze (1234), not store
 *    it as text;
 *  - persist refundReason;
 *  - mirror REFUNDED / PARTIAL_REFUND / CANCELLED into the local
 *    `orders.status` column so Order History + the refund gate see a
 *    consistent state;
 *  - normalise refundedLines into the same JSON shape pos-order-adapter
 *    uses for the initial full mirror (camelCase, grosze, vatRate
 *    not taxRate).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    run: vi.fn(),
    get: vi.fn(),
    save: vi.fn(),
    transaction: vi.fn((fn: () => void) => fn()),
  },
}));

vi.mock('../src/main/database/repos/order-repo', () => ({
  orderRepo: {
    getById: vi.fn(),
    upsertFromServer: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/product-repo', () => ({
  productRepo: { getById: vi.fn() },
}));
vi.mock('../src/main/database/repos/staff-repo', () => ({
  staffRepo: { upsertMany: vi.fn() },
}));
vi.mock('../src/main/database/repos/salon-customer-repo', () => ({
  salonCustomerRepo: { upsertMany: vi.fn() },
}));
vi.mock('../src/main/database/repos/booking-repo', () => ({
  bookingRepo: { upsertMany: vi.fn() },
}));
vi.mock('../src/main/database/repos/service-repo', () => ({
  serviceRepo: { upsertMany: vi.fn() },
}));
vi.mock('../src/main/database/repos/service-rule-repo', () => ({
  serviceRuleRepo: { upsertMany: vi.fn() },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { database } from '../src/main/database/database';
import { orderRepo } from '../src/main/database/repos/order-repo';
import { applyEntry, type SyncLogEntry } from '../src/main/sync/entity-applicators';

function entry(payload: Record<string, any>): SyncLogEntry {
  return {
    seq: 1,
    entity_type: 'order',
    entity_id: 'local-order-1',
    event: 'status_changed',
    payload,
    source: 'server',
    source_tx: 'tx-1',
    created_at: '2026-05-05T08:30:00.000Z',
  };
}

function findRunCall(matcher: RegExp) {
  return vi
    .mocked(database.run)
    .mock.calls.find(
      (c) => typeof c[0] === 'string' && matcher.test(c[0] as string),
    );
}

describe('applyOrder refund normalisation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Local row exists — exercise the update branch, not the
    // upsertFromServer mirror branch.
    vi.mocked(orderRepo.getById).mockReturnValue({ id: 'local-order-1' } as any);
  });

  it('converts a refundAmount string to grosze instead of storing the raw text', () => {
    applyEntry(entry({ refundAmount: '12.34', refundReason: 'spoiled' }));

    const refundUpdate = findRunCall(/UPDATE orders[\s\S]*refund_amount/i);
    expect(refundUpdate, 'expected refund UPDATE call').toBeDefined();
    const params = refundUpdate![1] as unknown[];
    // First param is the grosze integer, second is reason, third is
    // refund_lines json (null here), last is the local order id.
    expect(params[0]).toBe(1234);
    expect(params[1]).toBe('spoiled');
    expect(params[params.length - 1]).toBe('local-order-1');
  });

  it('treats a numeric refundAmount in PLN the same way (12.34 → 1234 grosze)', () => {
    applyEntry(entry({ refundAmount: 12.34, refundReason: 'manual' }));
    const params = findRunCall(/UPDATE orders[\s\S]*refund_amount/i)![1] as unknown[];
    expect(params[0]).toBe(1234);
    expect(params[1]).toBe('manual');
  });

  it('persists refundReason as null when the payload omits it', () => {
    applyEntry(entry({ refundAmount: '5.00' }));
    const params = findRunCall(/UPDATE orders[\s\S]*refund_amount/i)![1] as unknown[];
    expect(params[0]).toBe(500);
    expect(params[1]).toBeNull();
  });

  it('mirrors REFUNDED / PARTIAL_REFUND / CANCELLED into the local orders.status column', () => {
    for (const status of ['REFUNDED', 'PARTIAL_REFUND', 'CANCELLED']) {
      vi.mocked(database.run).mockReset();
      applyEntry(entry({ status }));
      const localStatusUpdate = vi
        .mocked(database.run)
        .mock.calls.find(
          (c) =>
            typeof c[0] === 'string' &&
            /UPDATE orders SET status\s*=/i.test(c[0] as string),
        );
      expect(localStatusUpdate, `expected status mirror for ${status}`).toBeDefined();
      expect((localStatusUpdate![1] as unknown[])[0]).toBe(status);
    }
  });

  it('does NOT mirror non-terminal statuses (CHECKED_IN, IN_SERVICE) into local status', () => {
    applyEntry(entry({ status: 'CHECKED_IN' }));
    const localStatusUpdate = vi
      .mocked(database.run)
      .mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          /UPDATE orders SET status\s*=/i.test(c[0] as string),
      );
    expect(
      localStatusUpdate,
      'non-terminal statuses must not overwrite local status',
    ).toBeUndefined();
  });

  it('normalises refundedLines into the local refund_lines JSON shape (camelCase, grosze, vatRate)', () => {
    applyEntry(
      entry({
        refundAmount: '12.34',
        refundReason: 'partial',
        refundedLines: [
          {
            name: 'Bulka',
            quantity: 2,
            unitPrice: '1.50',
            refundAmount: '3.00',
            taxRate: 5,
            sku: 'BULKA-1',
          },
          {
            // Edge cases: missing taxRate (defaults to 23), string
            // quantity, missing sku.
            name: 'Chleb',
            quantity: '1',
            unitPrice: '4.99',
            refundAmount: '4.99',
          },
        ],
      }),
    );

    const refundUpdate = findRunCall(/UPDATE orders[\s\S]*refund_amount/i);
    const params = refundUpdate![1] as unknown[];
    // refund_lines is the third bound parameter in the UPDATE.
    const refundLinesJson = params[2] as string;
    expect(typeof refundLinesJson).toBe('string');
    const parsed = JSON.parse(refundLinesJson);
    expect(parsed).toEqual([
      {
        name: 'Bulka',
        quantity: 2,
        unitPrice: 150,
        refundAmount: 300,
        vatRate: 5,
        sku: 'BULKA-1',
      },
      {
        name: 'Chleb',
        quantity: 1,
        unitPrice: 499,
        refundAmount: 499,
        vatRate: 23,
      },
    ]);
  });

  it('leaves refund_lines untouched (COALESCE) when the payload omits refundedLines', () => {
    applyEntry(entry({ refundAmount: '7.00', refundReason: 'admin' }));
    const refundUpdate = findRunCall(/UPDATE orders[\s\S]*refund_amount/i);
    const sql = refundUpdate![0] as string;
    // The COALESCE wrapper is what protects an existing local
    // refund_lines from being wiped by a follow-up status_changed
    // entry that only carries amount/reason.
    expect(sql).toMatch(/COALESCE\s*\(\s*\?\s*,\s*refund_lines\s*\)/i);
    const params = refundUpdate![1] as unknown[];
    expect(params[2]).toBeNull();
  });

  // ─── Bug 3 regression: refundAmount=0 must NOT stamp refunded_at ─
  // Full order payloads emitted by b2b-pos.service.findOrderById carry
  // refundAmount='0.00' on every status_changed/updated event for
  // non-refunded orders. The refund block must skip entirely so the
  // COALESCE-protected refunded_at column doesn't get pinned to a
  // bogus datetime('now') that would survive any later real refund.

  it('does NOT run the refund UPDATE when refundAmount is "0.00" (string)', () => {
    applyEntry(entry({ status: 'DELIVERED', total: '12.34', refundAmount: '0.00' }));
    const refundUpdate = findRunCall(/UPDATE orders[\s\S]*refund_amount/i);
    expect(refundUpdate, 'refundAmount=0 must not write the refund UPDATE').toBeUndefined();

    const refundedAtWrite = vi
      .mocked(database.run)
      .mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          /refunded_at\s*=/i.test(c[0] as string),
      );
    expect(refundedAtWrite, 'refundAmount=0 must not stamp refunded_at').toBeUndefined();
  });

  it('does NOT run the refund UPDATE when refundAmount is 0 (number)', () => {
    applyEntry(entry({ refundAmount: 0 }));
    const refundUpdate = findRunCall(/UPDATE orders[\s\S]*refund_amount/i);
    expect(refundUpdate).toBeUndefined();
  });

  it('does NOT run the refund UPDATE when refundAmount is null', () => {
    applyEntry(entry({ refundAmount: null }));
    const refundUpdate = findRunCall(/UPDATE orders[\s\S]*refund_amount/i);
    expect(refundUpdate).toBeUndefined();
  });
});
