import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/network/api-client', () => ({
  apiClient: {
    lookupByEan: vi.fn(),
    scanCreate: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/product-repo', () => ({
  productRepo: {
    getById: vi.fn(),
    getAllCategories: vi.fn(),
    deactivateByIds: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/local-variant-imports-repo', () => ({
  localVariantImportsRepo: {
    getPending: vi.fn(),
    getPendingByVariantId: vi.fn(),
    getSyncedAliases: vi.fn(),
    storeIntent: vi.fn(),
    markIntentDispatched: vi.fn(),
    resetLegacyUncertainIntent: vi.fn(),
    markAttempt: vi.fn(),
    markFailed: vi.fn(),
    markDefinitivelyRejected: vi.fn(),
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
import { database } from '../src/main/database/database';
import { buildLocalImportMutationKey, ProductSync } from '../src/main/sync/product-sync';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('buildLocalImportMutationKey', () => {
  const intent = {
    variantId: ' local-variant-1 ',
    ean: ' 8935039500400 ',
    purchasePrice: 0,
    retailPrice: 17.64,
    stockQty: 24,
    taxRate: 5,
    categoryId: ' 11111111-1111-1111-1111-111111111111 ',
  };

  it('is stable for the same normalized scan-create intent', () => {
    expect(buildLocalImportMutationKey(intent)).toBe(buildLocalImportMutationKey({
      ...intent,
      variantId: 'local-variant-1',
      ean: '8935039500400',
      categoryId: '11111111-1111-1111-1111-111111111111',
    }));
  });

  it('changes when a requeued scan-create intent is edited', () => {
    expect(buildLocalImportMutationKey(intent)).not.toBe(buildLocalImportMutationKey({
      ...intent,
      ean: '8935039500499',
    }));
    expect(buildLocalImportMutationKey(intent)).not.toBe(buildLocalImportMutationKey({
      ...intent,
      categoryId: null,
    }));
  });
});

describe('ProductSync.reconcileLocalVariantImports', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValue([]);
    vi.mocked(localVariantImportsRepo.getPendingByVariantId).mockReturnValue(null);
    vi.mocked(localVariantImportsRepo.getSyncedAliases).mockReturnValue([]);
    vi.mocked(productRepo.getAllCategories).mockReturnValue([]);
    vi.mocked(database.save).mockResolvedValue({ success: true });
  });

  it('coalesces concurrent reconciliation of the same variant into one network mutation', async () => {
    const row: any = {
      variant_id: 'single-flight-variant',
      draft_id: 'single-flight-draft',
      ean: '8935039500411',
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      created_at: '2026-07-13 10:00:00',
      synced_at: null,
      server_variant_id: null,
      category_id: null,
      intent_payload_json: null,
      intent_idempotency_key: null,
      intent_dispatched_at: null,
    };
    const response = deferred<any>();
    vi.mocked(localVariantImportsRepo.getPending).mockImplementation(() => (
      row.status === 'PENDING' ? [{ ...row }] : []
    ));
    vi.mocked(productRepo.getById).mockReturnValue({
      id: row.variant_id,
      retail_price: 1000,
      in_stock: 2,
      available_qty: 2,
      vat_rate: 23,
      category_id: null,
    } as any);
    vi.mocked(localVariantImportsRepo.storeIntent).mockImplementation((_variantId, payloadJson, key) => {
      row.intent_payload_json = payloadJson;
      row.intent_idempotency_key = key;
    });
    vi.mocked(localVariantImportsRepo.markIntentDispatched).mockImplementation(() => {
      row.intent_dispatched_at = '2026-07-13 10:00:01';
    });
    vi.mocked(localVariantImportsRepo.markSynced).mockImplementation((_variantId, serverVariantId) => {
      row.status = 'SYNCED';
      row.server_variant_id = serverVariantId;
    });
    vi.mocked(apiClient.lookupByEan).mockResolvedValue({
      mode: 'IMPORT_DRAFT',
      draft: { draftId: row.draft_id, ean: row.ean },
    });
    vi.mocked(apiClient.scanCreate).mockReturnValue(response.promise);

    const first = new ProductSync().reconcileLocalVariantImports();
    await vi.waitFor(() => expect(apiClient.scanCreate).toHaveBeenCalledTimes(1));
    const second = new ProductSync().reconcileLocalVariantImports();
    await Promise.resolve();
    expect(apiClient.scanCreate).toHaveBeenCalledTimes(1);

    response.resolve({ mode: 'IMPORT_DRAFT', variantId: 'server-single-flight' });

    await expect(Promise.all([first, second])).resolves.toEqual([1, 0]);
    expect(apiClient.scanCreate).toHaveBeenCalledTimes(1);
    expect(localVariantImportsRepo.markSynced).toHaveBeenCalledTimes(1);
  });

  it('replays the durable first-dispatch payload after a lost response even when local stock changes', async () => {
    const row: any = {
      variant_id: 'local-variant-replay',
      draft_id: 'draft-replay',
      ean: '8935039500488',
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      created_at: '2026-07-13 10:00:00',
      synced_at: null,
      server_variant_id: null,
      category_id: null,
      intent_payload_json: null,
      intent_idempotency_key: null,
      intent_dispatched_at: null,
    };
    vi.mocked(localVariantImportsRepo.getPending).mockImplementation(() => [{ ...row }]);
    vi.mocked(localVariantImportsRepo.storeIntent).mockImplementation((_variantId, payloadJson, key) => {
      row.intent_payload_json = payloadJson;
      row.intent_idempotency_key = key;
      return { ...row };
    });
    vi.mocked(localVariantImportsRepo.markIntentDispatched).mockImplementation(() => {
      row.intent_dispatched_at = '2026-07-13 10:00:01';
    });
    vi.mocked(localVariantImportsRepo.markAttempt).mockImplementation((_variantId, error) => {
      row.attempts += 1;
      row.last_error = error;
    });
    vi.mocked(productRepo.getById)
      .mockReturnValueOnce({
        id: row.variant_id,
        retail_price: 1764,
        in_stock: 24,
        available_qty: 24,
        vat_rate: 5,
        category_id: null,
      } as any)
      .mockReturnValueOnce({
        id: row.variant_id,
        retail_price: 1999,
        in_stock: 23,
        available_qty: 23,
        vat_rate: 23,
        category_id: null,
      } as any);
    vi.mocked(apiClient.scanCreate)
      .mockRejectedValueOnce(new Error('response lost after request'))
      .mockResolvedValueOnce({ outcome: 'IMPORT_DRAFT', variantId: 'server-replay' });
    vi.mocked(apiClient.lookupByEan).mockResolvedValueOnce({
      mode: 'IMPORT_DRAFT',
      draft: { draftId: row.draft_id, ean: row.ean },
    });

    const sync = new ProductSync();
    await sync.reconcileLocalVariantImports();
    await sync.reconcileLocalVariantImports();

    expect(apiClient.scanCreate).toHaveBeenCalledTimes(2);
    const firstRequest = vi.mocked(apiClient.scanCreate).mock.calls[0][1];
    const retryRequest = vi.mocked(apiClient.scanCreate).mock.calls[1][1];
    expect(firstRequest).toMatchObject({
      ean: row.ean,
      retailPrice: 17.64,
      stockQty: 24,
      taxRate: 5,
    });
    expect(retryRequest).toEqual(firstRequest);
    expect(apiClient.lookupByEan).toHaveBeenCalledOnce();
    expect(vi.mocked(apiClient.lookupByEan).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(apiClient.scanCreate).mock.invocationCallOrder[1]);
    expect(productRepo.getById).toHaveBeenCalledTimes(1);
    expect(localVariantImportsRepo.storeIntent).toHaveBeenCalledTimes(1);
    expect(database.save).toHaveBeenCalledTimes(2);
    expect(vi.mocked(database.save).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(apiClient.scanCreate).mock.invocationCallOrder[0]);
  });

  it('does not dispatch when the intent ledger cannot be flushed to disk', async () => {
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValueOnce([{
      variant_id: 'local-variant-disk-failure',
      draft_id: 'draft-disk-failure',
      ean: '8935039500466',
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      created_at: '2026-07-13 10:00:00',
      synced_at: null,
      server_variant_id: null,
      category_id: null,
    } as any]);
    vi.mocked(productRepo.getById).mockReturnValueOnce({
      id: 'local-variant-disk-failure',
      retail_price: 1000,
      in_stock: 2,
      available_qty: 2,
      vat_rate: 23,
      category_id: null,
    } as any);
    vi.mocked(database.save).mockResolvedValueOnce({
      success: false,
      error: 'disk full',
    });

    await new ProductSync().reconcileLocalVariantImports();

    expect(localVariantImportsRepo.storeIntent).toHaveBeenCalledOnce();
    expect(localVariantImportsRepo.markIntentDispatched).toHaveBeenCalledOnce();
    expect(apiClient.scanCreate).not.toHaveBeenCalled();
    expect(localVariantImportsRepo.markAttempt).toHaveBeenCalledWith(
      'local-variant-disk-failure',
      expect.stringContaining('not durable before dispatch'),
    );
  });

  it('releases a definitively rejected 4xx intent so the operator can correct it', async () => {
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValueOnce([{
      variant_id: 'definitive-rejection',
      draft_id: 'draft-rejection',
      ean: '8935039500465',
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      created_at: '2026-07-13 10:00:00',
      synced_at: null,
      server_variant_id: null,
      category_id: null,
      intent_payload_json: null,
      intent_idempotency_key: null,
      intent_dispatched_at: null,
    }]);
    vi.mocked(productRepo.getById).mockReturnValueOnce({
      id: 'definitive-rejection',
      retail_price: 1000,
      in_stock: 2,
      available_qty: 2,
      vat_rate: 23,
      category_id: null,
    } as any);
    vi.mocked(apiClient.scanCreate).mockRejectedValueOnce(Object.assign(
      new Error('Category is invalid'),
      { status: 422, serverBody: { code: 'INVALID_CATEGORY' } },
    ));

    await new ProductSync().reconcileLocalVariantImports();

    expect(localVariantImportsRepo.markDefinitivelyRejected).toHaveBeenCalledWith(
      'definitive-rejection',
      'Category is invalid',
    );
    expect(localVariantImportsRepo.markAttempt).not.toHaveBeenCalled();
  });

  it('keeps an HTTP 408 intent immutable because its outcome is ambiguous', async () => {
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValueOnce([{
      variant_id: 'timeout-rejection',
      draft_id: 'draft-timeout',
      ean: '8935039500464',
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      created_at: '2026-07-13 10:00:00',
      synced_at: null,
      server_variant_id: null,
      category_id: null,
      intent_payload_json: null,
      intent_idempotency_key: null,
      intent_dispatched_at: null,
    }]);
    vi.mocked(productRepo.getById).mockReturnValueOnce({
      id: 'timeout-rejection',
      retail_price: 1000,
      in_stock: 2,
      available_qty: 2,
      vat_rate: 23,
      category_id: null,
    } as any);
    vi.mocked(apiClient.scanCreate).mockRejectedValueOnce(Object.assign(
      new Error('Request timed out'),
      { status: 408, serverBody: { code: 'REQUEST_TIMEOUT' } },
    ));

    await new ProductSync().reconcileLocalVariantImports();

    expect(localVariantImportsRepo.markDefinitivelyRejected).not.toHaveBeenCalled();
    expect(localVariantImportsRepo.markAttempt).toHaveBeenCalledWith(
      'timeout-rejection',
      'Request timed out',
    );
  });

  it('keeps an idempotency conflict immutable because the key may have prior commit history', async () => {
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValueOnce([{
      variant_id: 'idempotency-conflict',
      draft_id: 'draft-idempotency-conflict',
      ean: '8935039500463',
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      created_at: '2026-07-13 10:00:00',
      synced_at: null,
      server_variant_id: null,
      category_id: null,
      intent_payload_json: null,
      intent_idempotency_key: null,
      intent_dispatched_at: null,
    }]);
    vi.mocked(productRepo.getById).mockReturnValueOnce({
      id: 'idempotency-conflict',
      retail_price: 1000,
      in_stock: 2,
      available_qty: 2,
      vat_rate: 23,
      category_id: null,
    } as any);
    vi.mocked(apiClient.scanCreate).mockRejectedValueOnce(Object.assign(
      new Error('Idempotency key conflict'),
      { status: 409, serverBody: { code: 'IDEMPOTENCY_CONFLICT' } },
    ));

    await new ProductSync().reconcileLocalVariantImports();

    expect(localVariantImportsRepo.markDefinitivelyRejected).not.toHaveBeenCalled();
    expect(localVariantImportsRepo.markAttempt).toHaveBeenCalledWith(
      'idempotency-conflict',
      'Idempotency key conflict',
    );
  });

  it('quarantines a legacy uncertain import when lookup finds active salon stock', async () => {
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValueOnce([{
      variant_id: 'legacy-uncertain',
      draft_id: 'legacy-draft',
      ean: '8935039500477',
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      created_at: '2026-07-12 10:00:00',
      synced_at: null,
      server_variant_id: null,
      category_id: null,
      intent_payload_json: null,
      intent_idempotency_key: null,
      intent_dispatched_at: '2026-07-12 10:00:00',
    }]);
    vi.mocked(apiClient.lookupByEan).mockResolvedValueOnce({
      mode: 'RESTOCK',
      existingProduct: {
        variantId: 'server-existing',
        ean: '8935039500477',
        isActive: true,
      },
    });

    const reconciled = await new ProductSync().reconcileLocalVariantImports();

    expect(reconciled).toBe(0);
    expect(localVariantImportsRepo.markFailed).toHaveBeenCalledWith(
      'legacy-uncertain',
      expect.stringContaining('manual audit'),
    );
    expect(localVariantImportsRepo.markSynced).not.toHaveBeenCalled();
    expect(localVariantImportsRepo.resetLegacyUncertainIntent).not.toHaveBeenCalled();
    expect(apiClient.scanCreate).not.toHaveBeenCalled();
  });

  it('rebuilds a durable request only when lookup proves a legacy draft is not imported', async () => {
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValueOnce([{
      variant_id: 'legacy-safe-retry',
      draft_id: 'legacy-draft',
      ean: '8935039500478',
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      created_at: '2026-07-12 10:00:00',
      synced_at: null,
      server_variant_id: null,
      category_id: null,
      intent_payload_json: null,
      intent_idempotency_key: null,
      intent_dispatched_at: '2026-07-12 10:00:00',
    }]);
    vi.mocked(apiClient.lookupByEan).mockResolvedValueOnce({
      mode: 'IMPORT_DRAFT',
      draft: { draftId: 'legacy-draft', ean: '8935039500478' },
    });
    vi.mocked(productRepo.getById).mockReturnValueOnce({
      id: 'legacy-safe-retry',
      retail_price: 1000,
      in_stock: 2,
      available_qty: 2,
      vat_rate: 23,
      category_id: null,
    } as any);
    vi.mocked(apiClient.scanCreate).mockResolvedValueOnce({
      mode: 'IMPORT_DRAFT',
      variantId: 'server-created',
    });

    const reconciled = await new ProductSync().reconcileLocalVariantImports();

    expect(reconciled).toBe(1);
    expect(localVariantImportsRepo.resetLegacyUncertainIntent).toHaveBeenCalledWith(
      'legacy-safe-retry',
    );
    expect(localVariantImportsRepo.storeIntent).toHaveBeenCalledOnce();
    expect(apiClient.scanCreate).toHaveBeenCalledOnce();
    expect(localVariantImportsRepo.markSynced).toHaveBeenCalledWith(
      'legacy-safe-retry',
      'server-created',
    );
  });

  it('keeps a legacy MISS quarantined because it cannot prove the mutation outcome', async () => {
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValueOnce([{
      variant_id: 'legacy-miss',
      draft_id: 'legacy-draft',
      ean: '8935039500479',
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      created_at: '2026-07-12 10:00:00',
      synced_at: null,
      server_variant_id: null,
      category_id: null,
      intent_payload_json: null,
      intent_idempotency_key: null,
      intent_dispatched_at: '2026-07-12 10:00:00',
    }]);
    vi.mocked(apiClient.lookupByEan).mockResolvedValueOnce({ mode: 'MISS' });

    await new ProductSync().reconcileLocalVariantImports();

    expect(localVariantImportsRepo.resetLegacyUncertainIntent).not.toHaveBeenCalled();
    expect(localVariantImportsRepo.markFailed).toHaveBeenCalledWith(
      'legacy-miss',
      expect.stringContaining('cannot safely retry'),
    );
    expect(apiClient.scanCreate).not.toHaveBeenCalled();
  });

  it('does not replay a durable request when lookup finds active stock with an unknowable delta', async () => {
    const payload = {
      ean: '8935039500488',
      purchasePrice: 0,
      retailPrice: 17.64,
      stockQty: 24,
      taxRate: 5,
      categoryId: null,
    };
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValueOnce([{
      variant_id: 'durable-uncertain-restock',
      draft_id: 'draft-restock',
      ean: payload.ean,
      status: 'PENDING',
      attempts: 1,
      last_error: 'response lost after request',
      created_at: '2026-07-13 10:00:00',
      synced_at: null,
      server_variant_id: null,
      category_id: null,
      intent_payload_json: JSON.stringify(payload),
      intent_idempotency_key: buildLocalImportMutationKey({
        variantId: 'durable-uncertain-restock',
        ...payload,
      }),
      intent_dispatched_at: '2026-07-13 10:00:01',
    }]);
    vi.mocked(apiClient.lookupByEan).mockResolvedValueOnce({
      mode: 'RESTOCK',
      existingProduct: {
        variantId: 'server-existing',
        ean: payload.ean,
        isActive: true,
      },
    });

    const reconciled = await new ProductSync().reconcileLocalVariantImports();

    expect(reconciled).toBe(0);
    expect(apiClient.scanCreate).not.toHaveBeenCalled();
    expect(localVariantImportsRepo.markSynced).not.toHaveBeenCalled();
    expect(localVariantImportsRepo.markFailed).toHaveBeenCalledWith(
      'durable-uncertain-restock',
      expect.stringContaining('manual audit'),
    );
  });

  it('reconciles the requested import instead of the oldest pending row', async () => {
    vi.mocked(localVariantImportsRepo.getPendingByVariantId).mockReturnValueOnce({
      variant_id: 'target-variant',
      draft_id: 'target-draft',
      ean: '8935039500499',
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      created_at: '2026-05-17 10:05:00',
      synced_at: null,
      server_variant_id: null,
      category_id: null,
    });
    vi.mocked(productRepo.getById).mockReturnValueOnce({
      id: 'target-variant',
      template_id: null,
      name: 'Target draft',
      sku: null,
      barcode: '8935039500499',
      retail_price: 1599,
      category_id: null,
      image_url: null,
      in_stock: 3,
      vat_rate: 5,
      is_active: 1,
      updated_at: null,
      available_qty: 3,
      price_gross: 1599,
      price_net: 1523,
      vat_amount: 76,
      is_on_sale: 0,
      thumbnail_url: null,
      sale_unit: null,
      name_translations: null,
    });
    vi.mocked(apiClient.scanCreate).mockResolvedValueOnce({
      outcome: 'IMPORT_DRAFT',
      variantId: 'server-target-variant',
    });

    const reconciled = await new ProductSync().reconcileLocalVariantImports(1, 'target-variant');

    expect(reconciled).toBe(1);
    expect(localVariantImportsRepo.getPending).not.toHaveBeenCalled();
    expect(localVariantImportsRepo.getPendingByVariantId).toHaveBeenCalledWith('target-variant');
    expect(apiClient.scanCreate).toHaveBeenCalledWith(null, expect.objectContaining({
      ean: '8935039500499',
      idempotencyKey: expect.stringMatching(/^local-import-v2-[a-f0-9]{64}$/),
    }));
    expect(localVariantImportsRepo.markSynced).toHaveBeenCalledWith(
      'target-variant',
      'server-target-variant',
    );
  });

  it('forces a targeted legacy requeue through read-only lookup before rebuilding its request', async () => {
    vi.mocked(localVariantImportsRepo.getPendingByVariantId).mockReturnValueOnce({
      variant_id: 'legacy-requeued-target',
      draft_id: 'legacy-draft',
      ean: '8935039500478',
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      created_at: '2026-07-12 10:00:00',
      synced_at: null,
      server_variant_id: null,
      category_id: null,
      intent_payload_json: null,
      intent_idempotency_key: null,
      intent_dispatched_at: '2026-07-12 10:00:00',
    });
    vi.mocked(apiClient.lookupByEan).mockResolvedValueOnce({
      mode: 'IMPORT_DRAFT',
      draft: { draftId: 'legacy-draft', ean: '8935039500478' },
    });
    vi.mocked(productRepo.getById).mockReturnValueOnce({
      id: 'legacy-requeued-target',
      retail_price: 1000,
      in_stock: 2,
      available_qty: 2,
      vat_rate: 23,
      category_id: null,
    } as any);
    vi.mocked(apiClient.scanCreate).mockResolvedValueOnce({
      mode: 'IMPORT_DRAFT',
      variantId: 'server-created',
    });

    const reconciled = await new ProductSync().reconcileLocalVariantImports(
      1,
      'legacy-requeued-target',
    );

    expect(reconciled).toBe(1);
    expect(localVariantImportsRepo.getPending).not.toHaveBeenCalled();
    expect(apiClient.lookupByEan).toHaveBeenCalledWith(null, '8935039500478');
    expect(vi.mocked(apiClient.lookupByEan).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(localVariantImportsRepo.storeIntent).mock.invocationCallOrder[0]);
    expect(apiClient.scanCreate).toHaveBeenCalledOnce();
    expect(localVariantImportsRepo.markSynced).toHaveBeenCalledWith(
      'legacy-requeued-target',
      'server-created',
    );
  });

  it('creates the online product with scan-create using local price, stock, and VAT', async () => {
    const backendCategoryId = '11111111-1111-1111-1111-111111111111';
    vi.mocked(productRepo.getAllCategories).mockReturnValueOnce([
      { id: backendCategoryId } as any,
    ]);
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
        category_id: backendCategoryId,
      },
    ]);
    vi.mocked(productRepo.getById).mockReturnValueOnce({
      id: 'local-variant-1',
      template_id: null,
      name: 'Draft product',
      sku: null,
      barcode: '8935039500400',
      retail_price: 1764,
      category_id: backendCategoryId,
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
      categoryId: backendCategoryId,
      idempotencyKey: expect.stringMatching(/^local-import-v2-[a-f0-9]{64}$/),
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
        category_id: null,
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

  it('does not send a local numeric category id to scan-create', async () => {
    vi.mocked(productRepo.getAllCategories).mockReturnValueOnce([
      { id: '1214553906' } as any,
    ]);
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValueOnce([
      {
        variant_id: 'local-variant-2',
        draft_id: 'draft-2',
        ean: '8935039500401',
        status: 'PENDING',
        attempts: 0,
        last_error: null,
        created_at: '2026-05-17 10:00:00',
        synced_at: null,
        server_variant_id: null,
        category_id: '1214553906',
      },
    ]);
    vi.mocked(productRepo.getById).mockReturnValueOnce({
      id: 'local-variant-2',
      template_id: null,
      name: 'Draft product',
      sku: null,
      barcode: '8935039500401',
      retail_price: 990,
      category_id: '1214553906',
      image_url: null,
      in_stock: 5,
      vat_rate: 23,
      is_active: 1,
      updated_at: null,
      available_qty: 5,
      price_gross: 990,
      price_net: 805,
      vat_amount: 185,
      is_on_sale: 0,
      thumbnail_url: null,
      sale_unit: null,
      name_translations: null,
    });
    vi.mocked(apiClient.scanCreate).mockResolvedValueOnce({
      outcome: 'IMPORT_DRAFT',
      variantId: 'server-variant-10',
    });

    await new ProductSync().reconcileLocalVariantImports();

    expect(apiClient.scanCreate).toHaveBeenCalledWith(null, expect.objectContaining({
      ean: '8935039500401',
      categoryId: null,
    }));
  });

  it('maps VARIANT_EXISTS conflicts to the active backend variant returned by lookup-by-ean', async () => {
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValueOnce([
      {
        variant_id: 'local-variant-3',
        draft_id: 'draft-3',
        ean: '8935039500402',
        status: 'PENDING',
        attempts: 0,
        last_error: null,
        created_at: '2026-05-17 10:00:00',
        synced_at: null,
        server_variant_id: null,
        category_id: null,
      },
    ]);
    vi.mocked(productRepo.getById).mockReturnValueOnce({
      id: 'local-variant-3',
      template_id: null,
      name: 'Draft product',
      sku: null,
      barcode: '8935039500402',
      retail_price: 1200,
      category_id: null,
      image_url: null,
      in_stock: 2,
      vat_rate: 23,
      is_active: 1,
      updated_at: null,
      available_qty: 2,
      price_gross: 1200,
      price_net: 976,
      vat_amount: 224,
      is_on_sale: 0,
      thumbnail_url: null,
      sale_unit: null,
      name_translations: null,
    });
    vi.mocked(apiClient.scanCreate).mockRejectedValueOnce(Object.assign(
      new Error('HTTP 409 VARIANT_EXISTS'),
      { status: 409, serverBody: { code: 'VARIANT_EXISTS' } },
    ));
    vi.mocked(apiClient.lookupByEan).mockResolvedValueOnce({
      variant: {
        id: 'server-variant-existing',
        ean: '8935039500402',
        isActive: true,
        sku: 'SKU-EXISTING',
      },
    });

    const reconciled = await new ProductSync().reconcileLocalVariantImports();

    expect(reconciled).toBe(1);
    expect(apiClient.lookupByEan).toHaveBeenCalledWith(null, '8935039500402');
    expect(localVariantImportsRepo.markSynced).toHaveBeenCalledWith(
      'local-variant-3',
      'server-variant-existing',
    );
    expect(localVariantImportsRepo.markFailed).not.toHaveBeenCalled();
  });

  it('shelves a pending local import after the retry cap is reached', async () => {
    vi.mocked(localVariantImportsRepo.getPending).mockReturnValueOnce([
      {
        variant_id: 'local-variant-4',
        draft_id: 'draft-4',
        ean: '8935039500403',
        status: 'PENDING',
        attempts: 50,
        last_error: 'previous failure',
        created_at: '2026-05-17 10:00:00',
        synced_at: null,
        server_variant_id: null,
        category_id: null,
      },
    ]);

    const reconciled = await new ProductSync().reconcileLocalVariantImports();

    expect(reconciled).toBe(0);
    expect(productRepo.getById).not.toHaveBeenCalled();
    expect(apiClient.scanCreate).not.toHaveBeenCalled();
    expect(localVariantImportsRepo.markFailed).toHaveBeenCalledWith(
      'local-variant-4',
      expect.stringContaining('Max retry exceeded (50/50)'),
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
        category_id: null,
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
        category_id: null,
      },
    ]);
    vi.mocked(productRepo.getById).mockReturnValueOnce({ id: 'server-variant-9' } as any);
    vi.mocked(orderRepo.hasUnsyncedOrdersForVariant).mockReturnValueOnce(true);

    (new ProductSync() as any).cleanupSyncedLocalAliases();

    expect(productRepo.deactivateByIds).not.toHaveBeenCalled();
  });
});
