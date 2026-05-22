import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    get: vi.fn(),
    run: vi.fn(),
    save: vi.fn(),
    markDirty: vi.fn(),
    transaction: vi.fn((fn: () => void) => fn()),
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
import { orderRepo } from '../src/main/database/repos/order-repo';

function adaptedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'server-order-1',
    order_number: 'POS260427-0001',
    status: 'COMPLETED',
    subtotal: 1000,
    discount: 0,
    tax: 0,
    total: 1000,
    payment_method: 'CARD',
    payment_amount: 1000,
    change_amount: 0,
    staff_id: null,
    staff_name: null,
    customer_id: null,
    customer_name: null,
    customer_nip: null,
    shift_id: null,
    mode: 'retail',
    _origin: 'server',
    ...overrides,
  };
}

const items = [
  {
    id: 'item-1',
    order_id: 'server-order-1',
    variant_id: null,
    name: 'Service',
    sku: null,
    price: 1000,
    quantity: 1,
    total: 1000,
    vat_rate: 23,
    staff_id: null,
    staff_name: null,
    notes: null,
    course: null,
  },
];

describe('orderRepo.upsertFromServer shift assignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(database.get).mockImplementation((sql: string) => {
      if (sql.includes('FROM orders')) return null;
      if (sql.includes('FROM shifts')) return { id: 'active-local-shift' };
      return null;
    });
  });

  it('does not assign the active local shift to mirrored server orders', () => {
    orderRepo.upsertFromServer(adaptedOrder({ shift_id: null }), items as any);

    const insertParams = vi.mocked(database.run).mock.calls[0][1] as unknown[];
    expect(insertParams[15]).toBeNull();
  });

  it('preserves an explicit server shift_id when the adapted order has one', () => {
    orderRepo.upsertFromServer(adaptedOrder({ shift_id: 'server-shift-1' }), items as any);

    const insertParams = vi.mocked(database.run).mock.calls[0][1] as unknown[];
    expect(insertParams[15]).toBe('server-shift-1');
  });
});
