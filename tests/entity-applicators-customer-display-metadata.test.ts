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

vi.mock('../src/main/database/repos/product-repo', () => ({
  productRepo: {
    getById: vi.fn(),
    upsertMany: vi.fn(),
    applySyncTombstones: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/order-repo', () => ({
  orderRepo: {
    getById: vi.fn(),
    upsertFromServer: vi.fn(),
  },
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
import { productRepo } from '../src/main/database/repos/product-repo';
import { applyEntry, type SyncLogEntry } from '../src/main/sync/entity-applicators';

function syncEntry(
  entity_type: SyncLogEntry['entity_type'],
  payload: Record<string, any>,
  entity_id = `${entity_type}-1`,
): SyncLogEntry {
  return {
    seq: 1,
    entity_type,
    entity_id,
    event: 'updated',
    payload,
    source: 'server',
    source_tx: 'tx-1',
    created_at: '2026-05-21T10:00:00.000Z',
  };
}

describe('entity applicators customer display metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps deleted product events as hidden local tombstones', () => {
    const deleted = syncEntry('product', {}, 'deleted-product');
    deleted.event = 'deleted';

    expect(applyEntry(deleted)).toBe(true);
    expect(productRepo.applySyncTombstones).toHaveBeenCalledWith([{
      id: 'deleted-product',
      reason: 'LEGACY_DELETED',
      canonicalUpdatedAt: deleted.created_at,
    }]);
  });

  it('preserves product customer display metadata when sync payload omits those fields', () => {
    vi.mocked(productRepo.getById).mockReturnValue({
      id: 'product-1',
      name: 'Existing product',
      name_translations: '{"pl":"Existing"}',
      customer_display_enabled: 0,
      customer_display_sort_order: 25,
    } as any);

    const applied = applyEntry(syncEntry('product', {
      name: 'Updated product',
      sku: 'SKU-1',
      retailPrice: 12.34,
      taxRate: 23,
      updatedAt: '2026-05-21T10:01:00.000Z',
    }, 'product-1'));

    expect(applied).toBe(true);
    expect(productRepo.upsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'product-1',
        name_translations: '{"pl":"Existing"}',
        customer_display_enabled: 0,
        customer_display_sort_order: 25,
      }),
    ]);
  });

  it('lets explicit product customer display sort null clear the previous sort value', () => {
    vi.mocked(productRepo.getById).mockReturnValue({
      id: 'product-1',
      name: 'Existing product',
      customer_display_enabled: 1,
      customer_display_sort_order: 25,
    } as any);

    applyEntry(syncEntry('product', {
      name: 'Updated product',
      customerDisplaySortOrder: null,
    }, 'product-1'));

    expect(productRepo.upsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        customer_display_enabled: 1,
        customer_display_sort_order: null,
      }),
    ]);
  });

  it('treats a lightweight product event as an invalidation without erasing local fields', () => {
    vi.mocked(productRepo.getById).mockReturnValue({
      id: 'product-1',
      template_id: 'template-1',
      name: 'Existing product',
      sku: 'SKU-1',
      barcode: '5900000000017',
      retail_price: 1234,
      category_id: 'category-1',
      image_url: 'https://example.test/image.png',
      in_stock: 7,
      available_qty: 5,
      vat_rate: 8,
      is_active: 1,
      updated_at: '2026-05-21T09:00:00.000Z',
      price_gross: 1234,
      price_net: 1143,
      vat_amount: 91,
      is_on_sale: 0,
      thumbnail_url: 'https://example.test/thumb.png',
      sale_unit: 'szt',
      sell_by: 'PIECE',
      item_type: 'stockable',
      track_inventory: 1,
    } as any);

    const applied = applyEntry(syncEntry('product', {
      id: 'product-1',
      variantId: 'product-1',
      templateId: 'template-1',
    }, 'product-1'));

    expect(applied).toBe(true);
    expect(productRepo.upsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'product-1',
        name: 'Existing product',
        sku: 'SKU-1',
        barcode: '5900000000017',
        retail_price: 1234,
        category_id: 'category-1',
        in_stock: 7,
        available_qty: 5,
        updated_at: '2026-05-21T09:00:00.000Z',
        item_type: 'stockable',
        track_inventory: 1,
      }),
    ]);
  });

  it('does not create a blank product from an invalidation before canonical sync', () => {
    vi.mocked(productRepo.getById).mockReturnValue(undefined as any);

    const applied = applyEntry(syncEntry('product', {
      id: 'product-1',
      variantId: 'product-1',
      templateId: 'template-1',
    }, 'product-1'));

    expect(applied).toBe(false);
    expect(productRepo.upsertMany).not.toHaveBeenCalled();
  });

  it('preserves category customer display metadata when sync payload omits those fields', () => {
    vi.mocked(database.get).mockReturnValue({
      name_translations: '{"pl":"Existing category"}',
      customer_display_enabled: 0,
      customer_display_section: 'retail',
      customer_display_sort_order: 9,
    } as any);

    const applied = applyEntry(syncEntry('category', {
      name: 'Updated category',
      sortOrder: 3,
    }, 'category-1'));

    expect(applied).toBe(true);
    const params = vi.mocked(database.run).mock.calls[0][1] as unknown[];
    expect(params.slice(6, 10)).toEqual([
      '{"pl":"Existing category"}',
      0,
      'retail',
      9,
    ]);
  });

  it('applies explicit category display metadata from the sync payload', () => {
    vi.mocked(database.get).mockReturnValue({
      name_translations: '{"pl":"Existing category"}',
      customer_display_enabled: 0,
      customer_display_section: 'retail',
      customer_display_sort_order: 9,
    } as any);

    applyEntry(syncEntry('category', {
      name: 'Updated category',
      nameTranslations: { pl: 'Nowa kategoria' },
      customerDisplayEnabled: true,
      customerDisplaySection: ' Food ',
      customerDisplaySortOrder: '2',
    }, 'category-1'));

    const params = vi.mocked(database.run).mock.calls[0][1] as unknown[];
    expect(params.slice(6, 10)).toEqual([
      '{"pl":"Nowa kategoria"}',
      1,
      'food',
      2,
    ]);
  });
});
