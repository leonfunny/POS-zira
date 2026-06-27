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

function pos2606270086Payload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'POS260627-0086',
    orderNumber: 'POS260627-0086',
    status: 'PENDING_STOCK',
    subtotal: '41.95',
    discountAmount: '0.00',
    taxAmount: '2.10',
    total: '44.05',
    paidAmount: '44.05',
    paymentMethod: 'CASH',
    priceType: 'brutto',
    taxIncluded: false,
    posMode: 'retail',
    createdAt: '2026-06-27T15:54:08.864Z',
    items: [
      {
        id: 'line-khoai-so',
        productName: 'Khoai sọ',
        variantId: 'variant-khoai-so',
        variantSku: 'MOON-260529-OY7',
        unitPrice: 25,
        totalPrice: 12.5,
        taxRate: '5.00',
        taxAmount: '0.60',
        saleQuantity: '0.500',
        saleUnit: 'kg',
        totalUnits: 1,
        packQuantity: 1,
        product: { id: 'variant-khoai-so', sku: 'MOON-260529-OY7', name: 'Khoai sọ', sellBy: 'WEIGHT', saleUnit: 'kg' },
      },
      {
        id: 'line-khoai-lang',
        productName: 'Khoai lang tím',
        variantId: 'variant-khoai-lang',
        variantSku: 'slodkie-ziemniaki-fioletowe',
        unitPrice: 45,
        totalPrice: 22.05,
        taxRate: '5.00',
        taxAmount: '1.05',
        saleQuantity: '0.490',
        saleUnit: 'kg',
        totalUnits: 1,
        packQuantity: 1,
        product: { id: 'variant-khoai-lang', sku: 'slodkie-ziemniaki-fioletowe', name: 'Khoai lang tím', sellBy: 'WEIGHT', saleUnit: 'kg' },
      },
      {
        id: 'line-su-hao',
        productName: 'Su hào',
        variantId: 'variant-su-hao',
        variantSku: 'MOON-260529-9Y8',
        unitPrice: 3.5,
        totalPrice: 3.5,
        taxRate: '5.00',
        taxAmount: '0.17',
        totalUnits: 1,
        packQuantity: 1,
        product: { id: 'variant-su-hao', sku: 'MOON-260529-9Y8', name: 'Su hào', sellBy: 'PIECE', saleUnit: 'củ' },
      },
      {
        id: 'line-rau-cai-ngot',
        productName: 'Rau cải ngọt',
        variantId: 'variant-rau-cai-ngot',
        variantSku: 'kapusta-pak-choi-swieza',
        unitPrice: 6,
        totalPrice: 6,
        taxRate: '5.00',
        taxAmount: '0.29',
        totalUnits: 1,
        packQuantity: 1,
        product: { id: 'variant-rau-cai-ngot', sku: 'kapusta-pak-choi-swieza', name: 'Rau cải ngọt', sellBy: 'PIECE', saleUnit: 'szt.' },
      },
    ],
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
      String(sql).includes('UPDATE order_items'),
    );
    expect(updateCalls.map(([, params]) => params)).toEqual([
      [700, 1, 1, 'szt', 'PIECE', 700, 23, 'POS260607-0085', 'line-1'],
      [1000, 1, 1, 'szt', 'PIECE', 1000, 8, 'POS260607-0085', 'line-2'],
    ]);
    expect(updateCalls.reduce((sum, [, params]) => sum + Number((params as any[])[5]), 0)).toBe(1700);
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

  it('repairs double-grossed SERVER mirrored item rows from raw gross totals that reconcile', () => {
    vi.mocked(database.all).mockImplementation((sql: string) => {
      if (sql.includes('FROM orders o')) {
        return [
          candidate({
            id: 'POS260627-0086',
            order_number: 'POS260627-0086',
            backend_id: 'POS260627-0086',
            total: 4405,
            local_sum: 4626,
            payload: JSON.stringify(pos2606270086Payload()),
          }),
        ] as any;
      }
      if (sql.includes('FROM order_items WHERE order_id = ?')) {
        return [
          { id: 'line-khoai-so', total: 1313 },
          { id: 'line-khoai-lang', total: 2315 },
          { id: 'line-su-hao', total: 368 },
          { id: 'line-rau-cai-ngot', total: 630 },
        ] as any;
      }
      return [] as any;
    });

    const result = orderRepo.repairServerMirroredGrossItemPrices();

    expect(result).toMatchObject({ scanned: 1, repaired: 1, skipped: 0 });
    const updateCalls = vi.mocked(database.run).mock.calls.filter(([sql]) =>
      String(sql).includes('UPDATE order_items'),
    );
    expect(updateCalls.map(([, params]) => params)).toEqual([
      [2500, 0.5, 0.5, 'kg', 'WEIGHT', 1250, 5, 'POS260627-0086', 'line-khoai-so'],
      [4500, 0.49, 0.49, 'kg', 'WEIGHT', 2205, 5, 'POS260627-0086', 'line-khoai-lang'],
      [350, 1, 1, 'củ', 'PIECE', 350, 5, 'POS260627-0086', 'line-su-hao'],
      [600, 1, 1, 'szt.', 'PIECE', 600, 5, 'POS260627-0086', 'line-rau-cai-ngot'],
    ]);
    expect(updateCalls.reduce((sum, [, params]) => sum + Number((params as any[])[5]), 0)).toBe(4405);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('items_sum 4626 -> 4405'));
  });

  it('skips non-server and unreconciled payload candidates without writing', () => {
    const unreconciledRawPayload = pos2606070085Payload({
      items: [
        {
          id: 'line-1',
          productName: 'Unreconciled raw item',
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
        candidate({ id: 'unreconciled-raw-order', payload: JSON.stringify(unreconciledRawPayload) }),
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
        adapted_sum_mismatch: 2,
      },
    });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.run).not.toHaveBeenCalled();
    expect(database.markDirty).not.toHaveBeenCalled();
  });
});
