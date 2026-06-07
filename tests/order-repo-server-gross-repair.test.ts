import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
    transaction: vi.fn((fn: () => void) => fn()),
    markDirty: vi.fn(),
  },
}));

vi.mock('../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { database } from '../src/main/database/database';
import logger from '../src/main/logger';
import { orderRepo } from '../src/main/database/repos/order-repo';

function pos2606070085Payload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'POS260607-0085',
    orderNumber: 'POS260607-0085',
    status: 'PAID',
    subtotal: '14.95',
    discountAmount: '0.00',
    taxAmount: '2.05',
    total: '17.00',
    paidAmount: '17.00',
    paymentMethod: 'CASH',
    priceType: 'brutto',
    posMode: 'retail',
    createdAt: '2026-06-07T10:21:10.675Z',
    items: [
      {
        id: 'line-1',
        variantId: 'variant-23',
        productName: 'VAT 23 item',
        unitPrice: '7',
        totalPrice: '7',
        netUnitPrice: '5.6911',
        netTotalPrice: '5.69',
        grossUnitPrice: '7',
        grossTotalPrice: '7',
        taxRate: '23.00',
        totalUnits: 1,
      },
      {
        id: 'line-2',
        variantId: 'variant-8',
        productName: 'VAT 8 item',
        unitPrice: '10',
        totalPrice: '10',
        netUnitPrice: '9.2593',
        netTotalPrice: '9.26',
        grossUnitPrice: '10',
        grossTotalPrice: '10',
        taxRate: '8.00',
        totalUnits: 1,
      },
    ],
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'POS260607-0085',
    order_number: 'POS260607-0085',
    backend_id: 'POS260607-0085',
    source: 'SERVER',
    total: 1700,
    discount: 0,
    local_sum: 1941,
    payload: JSON.stringify(pos2606070085Payload()),
    ...overrides,
  };
}

describe('orderRepo.repairServerMirroredGrossItemPrices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(database.transaction).mockImplementation((fn: () => void) => fn());
  });

  it('repairs double-grossed SERVER mirrored item rows from explicit gross payload fields and is idempotent', () => {
    let candidates = [candidate()];
    vi.mocked(database.all).mockImplementation((sql: string) => {
      if (sql.includes('FROM orders o')) return candidates as any;
      if (sql.includes('FROM order_items WHERE order_id = ?')) {
        return [
          { id: 'line-1', total: 861 },
          { id: 'line-2', total: 1080 },
        ] as any;
      }
      return [] as any;
    });

    const result = orderRepo.repairServerMirroredGrossItemPrices();

    expect(result).toMatchObject({ scanned: 1, repaired: 1, skipped: 0 });
    const updateCalls = vi.mocked(database.run).mock.calls.filter(([sql]) =>
      String(sql).startsWith('UPDATE order_items SET price = ?, total = ?'),
    );
    expect(updateCalls.map(([, params]) => params)).toEqual([
      [700, 700, 'POS260607-0085', 'line-1'],
      [1000, 1000, 'POS260607-0085', 'line-2'],
    ]);
    expect(updateCalls.reduce((sum, [, params]) => sum + Number((params as any[])[1]), 0)).toBe(1700);
    expect(database.markDirty).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('items_sum 1941 -> 1700'));

    candidates = [];
    vi.mocked(database.run).mockClear();
    vi.mocked(database.markDirty).mockClear();

    const secondRun = orderRepo.repairServerMirroredGrossItemPrices();

    expect(secondRun).toMatchObject({ scanned: 0, repaired: 0, skipped: 0 });
    expect(database.run).not.toHaveBeenCalled();
    expect(database.markDirty).not.toHaveBeenCalled();
  });

  it('skips non-server, missing gross, and unreconciled payload candidates without writing', () => {
    const missingGrossPayload = pos2606070085Payload({
      items: [
        {
          id: 'line-1',
          productName: 'Missing gross item',
          unitPrice: '7',
          totalPrice: '7',
          taxRate: '23.00',
          totalUnits: 1,
        },
      ],
    });
    const unreconciledPayload = pos2606070085Payload({
      items: [
        {
          id: 'line-1',
          productName: 'Wrong gross item',
          unitPrice: '7',
          totalPrice: '7',
          grossUnitPrice: '7',
          grossTotalPrice: '7',
          taxRate: '23.00',
          totalUnits: 1,
        },
      ],
    });

    vi.mocked(database.all).mockImplementation((sql: string) => {
      if (!sql.includes('FROM orders o')) return [] as any;
      return [
        candidate({ id: 'pos-owned-order', source: 'POS' }),
        candidate({ id: 'missing-gross-order', payload: JSON.stringify(missingGrossPayload) }),
        candidate({ id: 'bad-sum-order', payload: JSON.stringify(unreconciledPayload) }),
      ] as any;
    });

    const result = orderRepo.repairServerMirroredGrossItemPrices();

    const candidateSql = vi.mocked(database.all).mock.calls[0][0] as string;
    expect(candidateSql).toContain("WHERE o.source = 'SERVER'");
    expect(result).toMatchObject({
      scanned: 3,
      repaired: 0,
      skipped: 3,
      skipped_reasons: {
        source_not_server: 1,
        missing_gross_fields: 1,
        adapted_sum_mismatch: 1,
      },
    });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.run).not.toHaveBeenCalled();
    expect(database.markDirty).not.toHaveBeenCalled();
  });
});
