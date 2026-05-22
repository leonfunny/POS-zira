import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/network/api-client', () => ({
  apiClient: {
    scanCreate: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/product-repo', () => ({
  productRepo: {
    getById: vi.fn(),
    deactivateByIds: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/local-variant-imports-repo', () => ({
  localVariantImportsRepo: {
    getPending: vi.fn(),
    getSyncedAliases: vi.fn(),
    markAttempt: vi.fn(),
    markFailed: vi.fn(),
    markSynced: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/order-repo', () => ({
  orderRepo: {
    hasUnsyncedOrdersForVariant: vi.fn(),
  },
}));

vi.mock('../src/main/database/database', () => ({
  database: {
    save: vi.fn(),
    markDirty: vi.fn(),
  },
}));

vi.mock('../src/main/config/store', () => ({
  getSecureAuthToken: vi.fn(() => null),
}));

vi.mock('../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { apiClient } from '../src/main/network/api-client';
import { productRepo } from '../src/main/database/repos/product-repo';
import { localVariantImportsRepo } from '../src/main/database/repos/local-variant-imports-repo';
import { orderRepo } from '../src/main/database/repos/order-repo';
import { ProductSync } from '../src/main/sync/product-sync';

describe('ProductSync.reconcileLocalVariantImports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the online product with scan-create using local price, stock, and VAT', async () => {
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValueOnce([
      {
        variant_id: 'local-variant-1',
        draft_id: 'draft-1',
        ean: '8935039500400',
        status: 'PENDING',
        attempts: 0,
        last_error: null,
        created_at: '2026-05-17 10:00:00',
        synced_at: null,
        server_variant_id: null,
      },
    ]);
    vi.mocked(productRepo.getById).mockReturnValueOnce({
      id: 'local-variant-1',
      template_id: null,
      name: 'Draft product',
      sku: null,
      barcode: '8935039500400',
      retail_price: 1764,
      category_id: null,
      image_url: null,
      in_stock: 24,
      vat_rate: 5,
      is_active: 1,
      updated_at: null,
      available_qty: 24,
      price_gross: 1764,
      price_net: 1680,
      vat_amount: 84,
      is_on_sale: 0,
      thumbnail_url: null,
      sale_unit: null,
      name_translations: null,
    });
    vi.mocked(apiClient.scanCreate).mockResolvedValueOnce({
      outcome: 'IMPORT_DRAFT',
      variantId: 'server-variant-9',
    });

    const reconciled = await new ProductSync().reconcileLocalVariantImports();

    expect(reconciled).toBe(1);
    expect(apiClient.scanCreate).toHaveBeenCalledWith(null, {
      ean: '8935039500400',
      purchasePrice: 0,
      retailPrice: 17.64,
      stockQty: 24,
      taxRate: 5,
      idempotencyKey: 'local-import-local-variant-1',
    });
    expect(localVariantImportsRepo.markSynced).toHaveBeenCalledWith(
      'local-variant-1',
      'server-variant-9',
    );
  });

  it('does not invent online stock or price when local draft data is incomplete', async () => {
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValueOnce([
      {
        variant_id: 'local-variant-1',
        draft_id: 'draft-1',
        ean: '8935039500400',
        status: 'PENDING',
        attempts: 0,
        last_error: null,
        created_at: '2026-05-17 10:00:00',
        synced_at: null,
        server_variant_id: null,
      },
    ]);
    vi.mocked(productRepo.getById).mockReturnValueOnce({
      id: 'local-variant-1',
      template_id: null,
      name: 'Draft product',
      sku: null,
      barcode: '8935039500400',
      retail_price: 0,
      category_id: null,
      image_url: null,
      in_stock: 0,
      vat_rate: 23,
      is_active: 1,
      updated_at: null,
      available_qty: 0,
      price_gross: 0,
      price_net: 0,
      vat_amount: 0,
      is_on_sale: 0,
      thumbnail_url: null,
      sale_unit: null,
      name_translations: null,
    });

    const reconciled = await new ProductSync().reconcileLocalVariantImports();

    expect(reconciled).toBe(0);
    expect(apiClient.scanCreate).not.toHaveBeenCalled();
    expect(localVariantImportsRepo.markFailed).toHaveBeenCalledWith(
      'local-variant-1',
      expect.stringContaining('retailPrice >= 0.01'),
    );
  });

  it('hides the temporary local alias after the server variant is present and dependent orders are synced', () => {
    vi.mocked(localVariantImportsRepo.getSyncedAliases).mockReturnValueOnce([
      {
        variant_id: 'local-variant-1',
        draft_id: 'draft-1',
        ean: '8935039500400',
        status: 'SYNCED',
        attempts: 0,
        last_error: null,
        created_at: '2026-05-17 10:00:00',
        synced_at: '2026-05-17 10:01:00',
        server_variant_id: 'server-variant-9',
      },
    ]);
    vi.mocked(productRepo.getById).mockReturnValueOnce({ id: 'server-variant-9' } as any);
    vi.mocked(orderRepo.hasUnsyncedOrdersForVariant).mockReturnValueOnce(false);

    (new ProductSync() as any).cleanupSyncedLocalAliases();

    expect(productRepo.deactivateByIds).toHaveBeenCalledWith(['local-variant-1']);
  });

  it('keeps the temporary local alias visible while any dependent order is unsynced', () => {
    vi.mocked(localVariantImportsRepo.getSyncedAliases).mockReturnValueOnce([
      {
        variant_id: 'local-variant-1',
        draft_id: 'draft-1',
        ean: '8935039500400',
        status: 'SYNCED',
        attempts: 0,
        last_error: null,
        created_at: '2026-05-17 10:00:00',
        synced_at: '2026-05-17 10:01:00',
        server_variant_id: 'server-variant-9',
      },
    ]);
    vi.mocked(productRepo.getById).mockReturnValueOnce({ id: 'server-variant-9' } as any);
    vi.mocked(orderRepo.hasUnsyncedOrdersForVariant).mockReturnValueOnce(true);

    (new ProductSync() as any).cleanupSyncedLocalAliases();

    expect(productRepo.deactivateByIds).not.toHaveBeenCalled();
  });
});
