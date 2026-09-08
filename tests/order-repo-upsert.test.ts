import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    get: vi.fn(),
    all: vi.fn(() => []),
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

vi.mock('../src/main/events/pos-event-emitter', () => ({
  posEventEmitter: {
    emitOrderFinalized: vi.fn(),
  },
}));

import { database } from '../src/main/database/database';
import { orderRepo } from '../src/main/database/repos/order-repo';
import { adaptServerOrder } from '../src/main/sync/pos-order-adapter';

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
    vi.mocked(database.all).mockReturnValue([]);
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

  const restaurantOrder = () => adaptServerOrder({ id: 'server-order-1', posMode: 'restaurant', posOrderType: 'dine_in',
    subtotal: 10, discountAmount: 0, taxAmount: 0, total: 10, paidAmount: 10,
    externalMetadata: { meta: { restaurant: { schemaVersion: 1, tableId: 'A', covers: 3 } } } });

  it('persists proven table/covers/service type on a new mirror', () => {
    orderRepo.upsertFromServer(restaurantOrder(), items as any);
    const insertParams = vi.mocked(database.run).mock.calls.find(call => call[0].includes('INSERT INTO orders'))![1] as unknown[];
    expect(insertParams.slice(17, 20)).toEqual(['A', 3, 'dine_in']);
    expect(insertParams[6]).toBe(1000);
    const lineParams = vi.mocked(database.run).mock.calls.find(call => call[0].includes('INSERT INTO order_items'))![1] as unknown[];
    expect(lineParams[0]).toBe('item-1');
    expect(lineParams[14]).toBeNull(); // No invented preparation note.
    expect(lineParams[15]).toBeNull(); // Unknown course, not guessed first course.
  });

  const linkedItems = () => [
    { ...items[0], id: 'server-a', variant_id: 'tea', restaurant_line_id: 'local-a', notes: 'No sugar', course: 2 },
    { ...items[0], id: 'server-b', variant_id: 'tea', restaurant_line_id: 'local-b', notes: 'Extra sugar', course: 3 },
  ];

  it('inserts verified notes/course and durable provenance without replacing server IDs', () => {
    orderRepo.upsertFromServer(restaurantOrder(), linkedItems() as any);
    expect(database.run).toHaveBeenCalledWith('UPDATE order_items SET restaurant_line_id = ? WHERE id = ? AND order_id = ?', ['local-a', 'server-a', 'server-order-1']);
    const params = vi.mocked(database.run).mock.calls.filter(call => call[0].includes('INSERT INTO order_items')).map(call => call[1] as unknown[]);
    expect(params.map(p => [p[0], p[14], p[15]])).toEqual([['server-a', 'No sugar', 2], ['server-b', 'Extra sugar', 3]]);
  });

  it('repairs exact SERVER rows in reversed order without touching money or IDs', () => {
    vi.mocked(database.get).mockReturnValue({ id: 'server-order-1', source: 'SERVER' } as any);
    vi.mocked(database.all).mockReturnValue(linkedItems().reverse().map(item => ({ ...item, restaurant_line_id: null, notes: null, course: 1 })) as any);
    orderRepo.upsertFromServer(restaurantOrder(), linkedItems() as any);
    expect(database.run).toHaveBeenCalledWith(expect.stringContaining('SET notes = ?, course = ?, restaurant_line_id = ?'), ['No sugar', 2, 'local-a', 'server-a', 'server-order-1', 'tea']);
    expect(vi.mocked(database.run).mock.calls.some(call => /SET total|SET id|SET variant_id|DELETE FROM order_items/.test(call[0]))).toBe(false);
  });

  it.each(['local-origin', 'different-id', 'different-product', 'conflicting-proof', 'partial-links'])('does not grant/replace provenance for %s', scenario => {
    vi.mocked(database.get).mockReturnValue({ id: 'server-order-1', source: scenario === 'local-origin' ? 'POS' : 'SERVER' } as any);
    const local = linkedItems(); const incoming = linkedItems();
    if (scenario === 'different-id') local[0].id = 'other-server-id';
    if (scenario === 'different-product') local[0].variant_id = 'coffee';
    if (scenario === 'conflicting-proof') local[0].restaurant_line_id = 'another-original-local-id';
    if (scenario === 'partial-links') delete (incoming[0] as any).restaurant_line_id;
    vi.mocked(database.all).mockReturnValue(local as any);
    orderRepo.upsertFromServer(restaurantOrder(), incoming as any);
    expect(vi.mocked(database.run).mock.calls.some(call => /UPDATE order_items/.test(call[0]))).toBe(false);
  });

  it('repairs existing server-mirror headers while leaving items and financial values untouched', () => {
    vi.mocked(database.get).mockReturnValue({ id: 'server-order-1', source: 'SERVER', table_id: null, covers: null, order_type: 'standard' } as any);
    orderRepo.upsertFromServer(restaurantOrder(), items as any);
    expect(database.run).toHaveBeenCalledWith(expect.stringContaining('SET table_id = ?, covers = ?, order_type = ?'), ['A', 3, 'dine_in', 'server-order-1', 'SERVER']);
    expect(vi.mocked(database.run).mock.calls.some(call => /UPDATE order_items|DELETE FROM order_items|SET total/.test(call[0]))).toBe(false);
  });

  it.each(['POS', 'SERVER'])('missing metadata never clears richer existing %s history', source => {
    vi.mocked(database.get).mockReturnValue({ id: 'server-order-1', source, table_id: 'local-A', covers: 9, order_type: 'dine_in' } as any);
    orderRepo.upsertFromServer(adaptedOrder({ mode: 'restaurant' }), items as any);
    expect(vi.mocked(database.run).mock.calls.some(call => call[0].includes('SET table_id'))).toBe(false);
  });

  it('does not replace locally originated context or frozen payload with server history', () => {
    vi.mocked(database.get).mockReturnValue({ id: 'server-order-1', source: 'POS', table_id: 'local-A', covers: 9, sync_payload_json: 'frozen' } as any);
    orderRepo.upsertFromServer(restaurantOrder(), items as any);
    expect(vi.mocked(database.run).mock.calls.some(call => /SET table_id|sync_payload_json|UPDATE order_items/.test(call[0]))).toBe(false);
  });

  it('keeps legacy retail course defaults unchanged', () => {
    orderRepo.upsertFromServer(adaptedOrder(), items as any);
    const lineParams = vi.mocked(database.run).mock.calls.find(call => call[0].includes('INSERT INTO order_items'))![1] as unknown[];
    expect(lineParams[15]).toBe(1);
  });

  it('preserves an explicit server shift_id when the adapted order has one', () => {
    orderRepo.upsertFromServer(adaptedOrder({ shift_id: 'server-shift-1' }), items as any);

    const insertParams = vi.mocked(database.run).mock.calls[0][1] as unknown[];
    expect(insertParams[15]).toBe('server-shift-1');
  });

  it('owns a transaction by default for standalone REST mirroring', () => {
    orderRepo.upsertFromServer(adaptedOrder(), items as any);

    expect(database.transaction).toHaveBeenCalledOnce();
  });

  it('does not open a nested transaction when the sync pull owns it', () => {
    orderRepo.upsertFromServer(
      adaptedOrder(),
      items as any,
      { callerOwnsTransaction: true },
    );

    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.run).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO orders/),
      expect.any(Array),
    );
  });
});
