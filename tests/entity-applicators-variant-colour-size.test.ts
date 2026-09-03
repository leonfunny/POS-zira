import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Colour and size on a synced variant.
 *
 * The backend has always returned `colorName`/`sizeName` in the POS payload;
 * the local mirror simply had no columns for them. Now that it does, the two
 * things worth pinning are that a payload carrying them stores them, and that a
 * payload that omits them does not blank what is already on the machine —
 * `upsertMany` rewrites the whole row, so "omitted" and "cleared" are one
 * keystroke apart.
 */

vi.mock('../src/main/database/database', () => ({
  database: {
    run: vi.fn(),
    get: vi.fn(),
    save: vi.fn(),
    markDirty: vi.fn(),
    transaction: vi.fn((fn: () => void) => fn()),
  },
}));

vi.mock('../src/main/database/repos/product-repo', () => ({
  productRepo: {
    getById: vi.fn(),
    upsertMany: vi.fn(),
    applySyncTombstones: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/order-repo', () => ({
  orderRepo: { getById: vi.fn(), upsertFromServer: vi.fn() },
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

import { productRepo } from '../src/main/database/repos/product-repo';
import { applyEntry, type SyncLogEntry } from '../src/main/sync/entity-applicators';

function productEntry(payload: Record<string, any>): SyncLogEntry {
  return {
    seq: 1,
    entity_type: 'product',
    entity_id: 'variant-1',
    event: 'updated',
    payload: { name: 'KURTKA', sku: 'LOT114-BEZOWY-M', taxRate: 23, ...payload },
    source: 'server',
    source_tx: 'tx-1',
    created_at: '2026-09-03T10:00:00.000Z',
  };
}

const mirrored = () => vi.mocked(productRepo.upsertMany).mock.calls[0][0][0];

describe('entity applicators — variant colour and size', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores the colour and size a sync payload carries', () => {
    vi.mocked(productRepo.getById).mockReturnValue(undefined as any);

    applyEntry(productEntry({ colorName: 'BEŻOWY', sizeName: 'M' }));

    expect(mirrored()).toMatchObject({ color_name: 'BEŻOWY', size_name: 'M' });
  });

  it('accepts the snake_case spelling too', () => {
    vi.mocked(productRepo.getById).mockReturnValue(undefined as any);

    applyEntry(productEntry({ color_name: 'CZARNY', size_name: 'L' }));

    expect(mirrored()).toMatchObject({ color_name: 'CZARNY', size_name: 'L' });
  });

  it('keeps what is stored when the payload omits both fields', () => {
    vi.mocked(productRepo.getById).mockReturnValue({
      id: 'variant-1',
      name: 'KURTKA',
      color_name: 'BEŻOWY',
      size_name: 'M',
    } as any);

    applyEntry(productEntry({}));

    expect(mirrored()).toMatchObject({ color_name: 'BEŻOWY', size_name: 'M' });
  });

  it('lets an explicit null clear a colour that was set by mistake', () => {
    vi.mocked(productRepo.getById).mockReturnValue({
      id: 'variant-1',
      name: 'KURTKA',
      color_name: 'BEŻOWY',
      size_name: 'M',
    } as any);

    applyEntry(productEntry({ colorName: null, sizeName: null }));

    expect(mirrored()).toMatchObject({ color_name: null, size_name: null });
  });

  it('leaves a plain product without colour or size', () => {
    vi.mocked(productRepo.getById).mockReturnValue(undefined as any);

    applyEntry(productEntry({}));

    expect(mirrored()).toMatchObject({ color_name: null, size_name: null });
  });
});
