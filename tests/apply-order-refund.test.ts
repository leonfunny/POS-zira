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
    markDirty: vi.fn(),
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

  it('maps backend DELIVERED into local COMPLETED status for the UI status column', () => {
    applyEntry(entry({ status: 'DELIVERED' }));

    const localStatusUpdate = vi
      .mocked(database.run)
      .mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          /UPDATE orders SET status\s*=/i.test(c[0] as string),
      );

    expect(localStatusUpdate).toBeDefined();
    expect((localStatusUpdate![1] as unknown[])[0]).toBe('COMPLETED');
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

  it('preserves local refund event metadata when the inbound snapshot omits it', () => {
    vi.mocked(database.get).mockReturnValueOnce({
      total: 2000,
      refund_lines: JSON.stringify([{
        variantId: 'variant-kg',
        sku: 'GINGER',
        name: 'Gừng tươi',
        quantity: 0.75,
        refundAmount: 1500,
        refundedAt: '2026-07-17T10:00:00.000Z',
        refundRequestId: 'refund-kg-1',
        reason: 'customerRequest',
        refundMethod: 'SPLIT',
      }]),
    } as any);

    applyEntry(entry({
      refundAmount: '15.00',
      total: '20.00',
      refundedLines: [{
        orderItemId: 'server-item-kg',
        variantId: 'variant-kg',
        sku: 'GINGER',
        name: 'Gừng tươi',
        quantity: 0.75,
        unit: 'kg',
        unitPrice: '20.00',
        refundAmount: '15.00',
      }],
    }));

    const params = findRunCall(/UPDATE orders[\s\S]*refund_amount/i)![1] as unknown[];
    expect(JSON.parse(params[2] as string)).toEqual([expect.objectContaining({
      orderItemId: 'server-item-kg',
      unit: 'kg',
      refundedAt: '2026-07-17T10:00:00.000Z',
      refundRequestId: 'refund-kg-1',
      reason: 'customerRequest',
      refundMethod: 'SPLIT',
    })]);
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

  // ─── Bug 2 regression: derive local status from refundAmount/total ─
  // Backend can ship a refunded order with status='DELIVERED' and
  // refundAmount > 0. OrderHistory's getRefundStatus() reads
  // order.status only, so without deriving here, the cashier can
  // attempt a second refund on a fully-refunded sale.

  it('derives REFUNDED into local status when status=DELIVERED + refundAmount fully covers total', () => {
    applyEntry(
      entry({
        status: 'DELIVERED',
        total: '12.34',
        refundAmount: '12.34',
        refundReason: 'full refund',
      }),
    );
    const statusUpdates = vi
      .mocked(database.run)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === 'string' &&
          /UPDATE orders SET status\s*=/i.test(c[0] as string),
      );
    expect(
      statusUpdates.length,
      'expected at least one local status mirror',
    ).toBeGreaterThan(0);
    // The derived status write is the last status mutation to run.
    const last = statusUpdates[statusUpdates.length - 1];
    expect((last[1] as unknown[])[0]).toBe('REFUNDED');
  });

  it('derives PARTIAL_REFUND into local status when status=DELIVERED + refundAmount < total', () => {
    applyEntry(
      entry({
        status: 'DELIVERED',
        total: '12.34',
        refundAmount: '5.00',
        refundReason: 'partial refund',
      }),
    );
    const statusUpdates = vi
      .mocked(database.run)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === 'string' &&
          /UPDATE orders SET status\s*=/i.test(c[0] as string),
      );
    expect(statusUpdates.length).toBeGreaterThan(0);
    const last = statusUpdates[statusUpdates.length - 1];
    expect((last[1] as unknown[])[0]).toBe('PARTIAL_REFUND');
  });

  it('falls back to local row total when payload omits total but has refundAmount', () => {
    // status_changed payloads frequently omit total. Look up the
    // local row to decide REFUNDED vs PARTIAL_REFUND.
    vi.mocked(database.get).mockImplementation(((sql: string) => {
      if (/SELECT\s+total\s*,\s*refund_lines\s+FROM\s+orders/i.test(sql)) {
        return { total: 1234, refund_lines: null } as any;
      }
      return undefined;
    }) as any);

    applyEntry(entry({ refundAmount: '12.34', refundReason: 'full' }));

    const statusUpdates = vi
      .mocked(database.run)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === 'string' &&
          /UPDATE orders SET status\s*=/i.test(c[0] as string),
      );
    expect(statusUpdates.length).toBeGreaterThan(0);
    expect((statusUpdates[statusUpdates.length - 1][1] as unknown[])[0]).toBe(
      'REFUNDED',
    );
  });

  it('locks a refund update when backend has refundAmount but omits refundedLines', () => {
    applyEntry(
      entry({
        status: 'PARTIAL_REFUND',
        total: '42.00',
        refundAmount: '28.00',
        refundReason: 'partial refund',
        refundedLines: [],
      }),
    );

    const refundUpdate = findRunCall(/UPDATE orders[\s\S]*refund_amount/i);
    expect(refundUpdate, 'expected refund UPDATE call').toBeDefined();
    const params = refundUpdate![1] as unknown[];
    expect(params[0]).toBe(2800);
    expect(params[2]).toBeNull();
    expect(params[3]).toContain('missing refundedLines');

    const statusUpdates = vi
      .mocked(database.run)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === 'string' &&
          /UPDATE orders SET status\s*=/i.test(c[0] as string),
      );
    expect((statusUpdates[statusUpdates.length - 1][1] as unknown[])[0]).toBe(
      'PARTIAL_REFUND',
    );
  });

  it('flags backend over-refund rows in sync_error and clamps status to refunded', () => {
    applyEntry(
      entry({
        status: 'REFUNDED',
        total: '42.00',
        refundAmount: '51.66',
        refundReason: 'duplicate refund',
        refundedLines: [],
      }),
    );

    const refundUpdate = findRunCall(/UPDATE orders[\s\S]*refund_amount/i);
    expect(refundUpdate, 'expected refund UPDATE call').toBeDefined();
    const params = refundUpdate![1] as unknown[];
    expect(params[0]).toBe(5166);
    expect(params[2]).toBeNull();
    expect(params[3]).toContain('exceeds local order total');

    const statusUpdates = vi
      .mocked(database.run)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === 'string' &&
          /UPDATE orders SET status\s*=/i.test(c[0] as string),
      );
    expect((statusUpdates[statusUpdates.length - 1][1] as unknown[])[0]).toBe(
      'REFUNDED',
    );
  });

  it('clears stale refund sync_error when a later valid backend refund payload includes refundedLines', () => {
    applyEntry(
      entry({
        status: 'PARTIAL_REFUND',
        total: '42.00',
        refundAmount: '28.00',
        refundedLines: [],
      }),
    );
    applyEntry(
      entry({
        status: 'PARTIAL_REFUND',
        total: '42.00',
        refundAmount: '28.00',
        refundedLines: [
          {
            name: 'Refunded item',
            quantity: 2,
            unitPrice: '14.00',
            refundAmount: '28.00',
            taxRate: 23,
            sku: 'SKU-14',
          },
        ],
      }),
    );

    const refundUpdates = vi
      .mocked(database.run)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === 'string' &&
          /UPDATE orders[\s\S]*refund_amount/i.test(c[0] as string),
      );
    expect(refundUpdates).toHaveLength(2);
    const validUpdate = refundUpdates[1];
    const sql = validUpdate[0] as string;
    const params = validUpdate[1] as unknown[];
    expect(sql).toMatch(/sync_error\s*=\s*CASE/i);
    expect(sql).toMatch(/sync_error LIKE 'Backend refund%'/i);
    expect(sql).toMatch(/THEN NULL/i);
    expect(params[2]).toEqual(expect.any(String));
    expect(params[3]).toBeNull();
    expect(params[5]).toBe(1);
  });

  it('locks refunds when backend sends refund status without refundAmount', () => {
    applyEntry(
      entry({
        status: 'PARTIAL_REFUND',
        total: '42.00',
      }),
    );

    const refundAmountUpdate = findRunCall(/UPDATE orders[\s\S]*refund_amount/i);
    expect(refundAmountUpdate, 'must not fabricate refund_amount or refund_lines').toBeUndefined();

    const syncErrorUpdate = vi
      .mocked(database.run)
      .mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          /UPDATE orders SET sync_error\s*=\s*\? WHERE id\s*=\s*\?/i.test(c[0] as string),
      );
    expect(syncErrorUpdate, 'expected refund sync_error lock').toBeDefined();
    expect((syncErrorUpdate![1] as unknown[])[0]).toContain('refundAmount/refundedLines');
  });

  it('mirrors a missing split-payment order with local tender JSON', () => {
    vi.mocked(orderRepo.getById).mockReturnValue(null as any);
    vi.mocked(database.get).mockReturnValue(undefined as any);

    applyEntry(
      entry({
        id: 'local-order-1',
        status: 'PAID',
        subtotal: '45.37',
        discountAmount: '0.00',
        taxAmount: '2.27',
        total: '47.64',
        paidAmount: '47.64',
        paymentMethod: 'SPLIT',
        posMode: 'retail',
        createdAt: '2026-05-22T12:02:08.000Z',
        tenders: [
          { method: 'CASH', amount: 20 },
          { method: 'CARD', amount: '27.64' },
        ],
        items: [
          {
            id: 'item-1',
            productName: 'Test item',
            variantSku: 'SKU-1',
            unitPrice: '47.64',
            totalPrice: '47.64',
            taxRate: '5.00',
            packQuantity: 1,
          },
        ],
      }),
    );

    expect(orderRepo.upsertFromServer).toHaveBeenCalledOnce();
    const [adapted, adaptedItems] = vi.mocked(orderRepo.upsertFromServer).mock.calls[0];
    expect(adapted.payment_method).toBe('SPLIT');
    expect(JSON.parse(adapted.payment_tenders)).toEqual([
      { method: 'CASH', amount: 2000 },
      { method: 'CARD', amount: 2764 },
    ]);
    expect(adaptedItems).toHaveLength(1);
  });
});
