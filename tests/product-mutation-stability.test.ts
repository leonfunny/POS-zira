import { describe, expect, it } from 'vitest';
import { createStableMutationKeyStore } from '../src/renderer/components/products/mutation-idempotency';
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
});

describe('product partial save recovery', () => {
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
