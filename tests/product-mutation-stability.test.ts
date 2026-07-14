import { describe, expect, it } from 'vitest';
import {
  completeCommittedMutation,
  createImmutableMutationAttemptStore,
  createMutationOutcomeTracker,
  createStableMutationKeyStore,
  isDefinitiveMutationRejection,
} from '../src/renderer/components/products/mutation-idempotency';
import { executeProductSave } from '../src/renderer/components/products/save-product-changes';

describe('product mutation idempotency', () => {
  it('reuses the key for the same intent', () => {
    let sequence = 0;
    const store = createStableMutationKeyStore(() => `key-${++sequence}`);

    expect(store.get('receive:5')).toBe('key-1');
    expect(store.get('receive:5')).toBe('key-1');
  });

  it('rotates the key when the intent changes or succeeds', () => {
    let sequence = 0;
    const store = createStableMutationKeyStore(() => `key-${++sequence}`);

    expect(store.get('receive:5')).toBe('key-1');
    expect(store.get('receive:6')).toBe('key-2');
    store.clear();
    expect(store.get('receive:6')).toBe('key-3');
  });

  it('replays the first dispatched receipt body and key even if the form later changes', () => {
    let sequence = 0;
    const store = createImmutableMutationAttemptStore(() => `receipt-key-${++sequence}`);
    const first = store.dispatch({
      quantity: 2,
      unitCostGrosze: 500,
      lotNumber: 'LOT-A',
      reason: 'delivery one',
      expectedUpdatedAt: 'T1',
    });
    const retryAfterEdit = store.dispatch({
      quantity: 3,
      unitCostGrosze: 600,
      lotNumber: 'LOT-B',
      reason: 'delivery two',
      expectedUpdatedAt: 'T2',
    });

    expect(retryAfterEdit).toBe(first);
    expect(retryAfterEdit).toEqual({
      quantity: 2,
      unitCostGrosze: 500,
      lotNumber: 'LOT-A',
      reason: 'delivery one',
      expectedUpdatedAt: 'T1',
      idempotencyKey: 'receipt-key-1',
    });
    expect(Object.isFrozen(retryAfterEdit)).toBe(true);
  });

  it('replays the first dispatched delta adjustment instead of applying an edited delta', () => {
    const store = createImmutableMutationAttemptStore(() => 'adjustment-key-1');
    const first = store.dispatch({
      mode: 'damage',
      quantity: 1,
      reason: 'broken bottle',
      expectedUpdatedAt: 'T1',
    });
    const retryAfterRefresh = store.dispatch({
      mode: 'loss',
      quantity: 4,
      reason: 'missing case',
      expectedUpdatedAt: 'T2',
    });

    expect(retryAfterRefresh).toBe(first);
    expect(retryAfterRefresh).toMatchObject({
      mode: 'damage',
      quantity: 1,
      expectedUpdatedAt: 'T1',
      idempotencyKey: 'adjustment-key-1',
    });
  });

  it('treats the server commit as terminal when the follow-up refresh callback rejects', async () => {
    let closed = false;

    await expect(completeCommittedMutation(
      async () => { throw new Error('local refresh failed'); },
      () => { closed = true; },
    )).resolves.toBeUndefined();

    expect(closed).toBe(true);
  });

  it.each([
    [{ ok: false, status: 400, code: 'INVALID_PRICE' }, true],
    [{ ok: false, status: 409, code: 'DUPLICATE_BARCODE' }, true],
    [{ ok: false, status: 409, code: 'STALE_PRODUCT' }, true],
    [{ ok: false, status: 422, code: 'INVALID_STOCK_QUANTITY' }, true],
    [{ ok: false, code: 'UNSUPPORTED_CAPABILITY' }, true],
    [{ ok: false, code: 'INVALID_STOCK_QUANTITY' }, true],
    [{ ok: false, status: 408, code: 'REQUEST_TIMEOUT' }, false],
    [{ ok: false, status: 409, code: 'IDEMPOTENCY_CONFLICT' }, true],
    [{ ok: false, code: 'IDEMPOTENCY_CONFLICT' }, false],
    [{ ok: false, status: 503, code: 'SERVICE_UNAVAILABLE' }, false],
    [{ ok: false, status: 503, code: 'INVALID_PRICE' }, false],
    [{ ok: false, error: 'fetch failed' }, false],
  ] as const)('classifies terminal rejection %j as %s', (result, expected) => {
    expect(isDefinitiveMutationRejection(result)).toBe(expected);
  });

  it('never releases an uncertain attempt after a later local definitive rejection', () => {
    const tracker = createMutationOutcomeTracker();

    expect(tracker.shouldRelease({ ok: false, status: 503, code: 'SERVICE_UNAVAILABLE' }))
      .toBe(false);
    expect(tracker.isUncertain()).toBe(true);
    expect(tracker.shouldRelease({ ok: false, code: 'UNAUTHORIZED_PRODUCT_ADMIN' }))
      .toBe(false);

    tracker.clear();
    expect(tracker.shouldRelease({ ok: false, status: 400, code: 'INVALID_PRICE' }))
      .toBe(true);
  });
});

describe('product partial save recovery', () => {
  it('preserves committed field state when the following stock request throws', async () => {
    const result = await executeProductSave({
      productDirty: true,
      stockDirty: true,
      expectedUpdatedAt: 'T1',
      updateProduct: async () => ({
        ok: true,
        data: { variant: { updatedAt: 'T2' } },
      }),
      adjustStock: async () => {
        throw new Error('connection reset after dispatch');
      },
    });

    expect(result).toEqual({
      status: 'stock-failed',
      productSaved: true,
      expectedUpdatedAt: 'T2',
      error: 'connection reset after dispatch',
    });
  });

  it('returns the updated concurrency token when stock fails after product fields save', async () => {
    let stockExpectedUpdatedAt: string | undefined;
    const result = await executeProductSave({
      productDirty: true,
      stockDirty: true,
      expectedUpdatedAt: 'old-version',
      updateProduct: async () => ({
        ok: true,
        data: { variant: { updatedAt: 'new-version' } },
      }),
      adjustStock: async (expectedUpdatedAt) => {
        stockExpectedUpdatedAt = expectedUpdatedAt;
        return { ok: false, error: 'stock unavailable' };
      },
    });

    expect(stockExpectedUpdatedAt).toBe('new-version');
    expect(result).toEqual({
      status: 'stock-failed',
      productSaved: true,
      expectedUpdatedAt: 'new-version',
      error: 'stock unavailable',
    });
  });

  it('skips product update when retrying only the remaining stock change', async () => {
    let productUpdateCalls = 0;
    let stockExpectedUpdatedAt: string | undefined;
    const result = await executeProductSave({
      productDirty: false,
      stockDirty: true,
      expectedUpdatedAt: 'new-version',
      updateProduct: async () => {
        productUpdateCalls += 1;
        return { ok: true };
      },
      adjustStock: async (expectedUpdatedAt) => {
        stockExpectedUpdatedAt = expectedUpdatedAt;
        return { ok: true };
      },
    });

    expect(productUpdateCalls).toBe(0);
    expect(stockExpectedUpdatedAt).toBe('new-version');
    expect(result.status).toBe('success');
  });
});
