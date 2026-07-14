import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProductListItem } from '../src/renderer/hooks/useProducts';
import {
  createImmutableMutationAttemptStore,
  createMutationOutcomeTracker,
  createStableMutationKeyStore,
} from '../src/renderer/components/products/mutation-idempotency';
import { executeProductSave } from '../src/renderer/components/products/save-product-changes';
import * as ProductEditLifecycle from '../src/renderer/components/products/ProductEditForm';

type EditBaseline = {
  expectedUpdatedAt?: string;
  product: ProductListItem;
};

type LifecycleExports = {
  createProductEditBaseline?: (product: ProductListItem) => EditBaseline;
  reconcileProductEditBaseline?: (
    baseline: EditBaseline,
    product: ProductListItem,
    dirty: boolean,
  ) => { baseline: EditBaseline; conflict: boolean };
  productEditNavigationState?: (busy: boolean) => {
    cancelDisabled: boolean;
    backDisabled: boolean;
  };
  advanceProductEditBaselineAfterSave?: (
    baseline: EditBaseline,
    committedFields: Partial<ProductListItem>,
    expectedUpdatedAt?: string,
    purchasePriceInput?: string,
    committedStock?: number,
  ) => EditBaseline;
  productEditFormInputsFromBaseline?: (baseline: EditBaseline) => {
    name: string;
    stockQty: string;
  };
  runProductPostCommitBestEffort?: (
    callbacks: Array<() => Promise<void> | void>,
  ) => Promise<void>;
};

const lifecycle = ProductEditLifecycle as LifecycleExports;

function product(overrides: Partial<ProductListItem> = {}): ProductListItem {
  return {
    id: 'variant-1',
    template_id: 'template-1',
    name: 'Polish red',
    sku: 'RED-1',
    barcode: '5900000000017',
    retail_price: 2500,
    category_id: 'category-1',
    image_url: null,
    in_stock: 10,
    available_qty: 10,
    vat_rate: 23,
    is_active: 1,
    updated_at: 'T1',
    ...overrides,
  };
}

describe('product edit concurrency baseline', () => {
  it('replays the exact embedded stock attempt after an ambiguous result even if edited input changes', () => {
    const attempts = createImmutableMutationAttemptStore(() => 'edit-stock-key');
    const outcomes = createMutationOutcomeTracker();
    const first = attempts.dispatch({
      variantId: 'variant-1',
      mode: 'recount' as const,
      newQuantity: 12,
      expectedUpdatedAt: 'T2',
    });
    outcomes.markAmbiguous();

    const retryAfterEdit = attempts.dispatch({
      variantId: 'variant-1',
      mode: 'recount' as const,
      newQuantity: 99,
      expectedUpdatedAt: 'T9',
    });

    expect(retryAfterEdit).toBe(first);
    expect(retryAfterEdit).toMatchObject({
      newQuantity: 12,
      expectedUpdatedAt: 'T2',
      idempotencyKey: 'edit-stock-key',
    });
    expect(outcomes.shouldRelease({ ok: false, code: 'UNAUTHORIZED_PRODUCT_ADMIN' }))
      .toBe(false);
  });

  it('allows an embedded stock form to unlock after its first definitive rejection', () => {
    const attempts = createImmutableMutationAttemptStore(() => 'edit-stock-key');
    const outcomes = createMutationOutcomeTracker();
    attempts.dispatch({ mode: 'recount' as const, newQuantity: 12 });

    expect(outcomes.shouldRelease({ ok: false, status: 409, code: 'STALE_PRODUCT' }))
      .toBe(true);
    attempts.clear();
    outcomes.clear();

    expect(attempts.current()).toBeNull();
    expect(outcomes.isUncertain()).toBe(false);
  });

  it('runs every post-commit callback without surfacing refresh failures as mutation failures', async () => {
    expect(lifecycle.runProductPostCommitBestEffort).toBeTypeOf('function');
    if (!lifecycle.runProductPostCommitBestEffort) return;
    const calls: string[] = [];

    await expect(lifecycle.runProductPostCommitBestEffort([
      async () => {
        calls.push('refresh');
        throw new Error('local refresh failed');
      },
      () => { calls.push('detail'); },
    ])).resolves.toBeUndefined();

    expect(calls).toEqual(['refresh', 'detail']);
  });

  it('keeps the original stock and OCC token when the same product refreshes in the background', () => {
    expect(lifecycle.createProductEditBaseline).toBeTypeOf('function');
    expect(lifecycle.reconcileProductEditBaseline).toBeTypeOf('function');
    if (!lifecycle.createProductEditBaseline || !lifecycle.reconcileProductEditBaseline) return;

    const productAtT1 = product();
    const baselineAtT1 = lifecycle.createProductEditBaseline(productAtT1);
    const productAtT2 = product({ in_stock: 9, available_qty: 9, updated_at: 'T2' });

    expect(baselineAtT1.expectedUpdatedAt).toBe('T1');
    expect(baselineAtT1.product.in_stock).toBe(10);
    expect(lifecycle.reconcileProductEditBaseline(baselineAtT1, productAtT2, true)).toEqual({
      baseline: baselineAtT1,
      conflict: true,
    });
  });

  it('uses total on-hand stock instead of available stock for the edit baseline', () => {
    expect(lifecycle.createProductEditBaseline).toBeTypeOf('function');
    expect(lifecycle.productEditFormInputsFromBaseline).toBeTypeOf('function');
    expect(lifecycle.advanceProductEditBaselineAfterSave).toBeTypeOf('function');
    if (!lifecycle.createProductEditBaseline
      || !lifecycle.productEditFormInputsFromBaseline
      || !lifecycle.advanceProductEditBaselineAfterSave) return;

    const baseline = lifecycle.createProductEditBaseline(product({
      in_stock: 10,
      available_qty: 7,
    }));
    const committed = lifecycle.advanceProductEditBaselineAfterSave(
      baseline,
      {},
      'T2',
      undefined,
      12,
    );

    expect(lifecycle.productEditFormInputsFromBaseline(baseline).stockQty).toBe('10');
    expect(committed.product).toMatchObject({ in_stock: 12, available_qty: 7 });
    expect(lifecycle.productEditFormInputsFromBaseline(committed).stockQty).toBe('12');
  });

  it('disables both edit exits while the form reports a mutation in flight', () => {
    expect(lifecycle.productEditNavigationState).toBeTypeOf('function');
    if (!lifecycle.productEditNavigationState) return;

    expect(lifecycle.productEditNavigationState(true)).toEqual({
      cancelDisabled: true,
      backDisabled: true,
    });
    expect(lifecycle.productEditNavigationState(false)).toEqual({
      cancelDisabled: false,
      backDisabled: false,
    });
  });

  it('retries only pending stock with the committed token and the same mutation key', async () => {
    expect(lifecycle.advanceProductEditBaselineAfterSave).toBeTypeOf('function');
    if (!lifecycle.createProductEditBaseline || !lifecycle.advanceProductEditBaselineAfterSave) return;

    let baseline = lifecycle.createProductEditBaseline(product());
    const edited = { name: 'Polish blue', stock: 12 };
    const mutationKeys = createStableMutationKeyStore((() => {
      let sequence = 0;
      return () => `stock-key-${++sequence}`;
    })());
    const productTokens: Array<string | undefined> = [];
    const stockAttempts: Array<{ token?: string; key: string }> = [];

    const save = (stockSucceeds: boolean) => executeProductSave({
      productDirty: edited.name !== baseline.product.name,
      stockDirty: edited.stock !== baseline.product.in_stock,
      expectedUpdatedAt: baseline.expectedUpdatedAt,
      updateProduct: async () => {
        productTokens.push(baseline.expectedUpdatedAt);
        return { ok: true, data: { variant: { updatedAt: 'T2' } } };
      },
      adjustStock: async (token) => {
        stockAttempts.push({
          token,
          key: mutationKeys.get(JSON.stringify({
            productId: baseline.product.id,
            mode: 'recount',
            newQuantity: edited.stock,
          })),
        });
        return stockSucceeds ? { ok: true } : { ok: false, error: 'stock unavailable' };
      },
    });

    const first = await save(false);
    expect(first).toMatchObject({
      status: 'stock-failed',
      productSaved: true,
      expectedUpdatedAt: 'T2',
    });

    baseline = lifecycle.advanceProductEditBaselineAfterSave(
      baseline,
      { name: edited.name, in_stock: edited.stock, available_qty: edited.stock },
      first.expectedUpdatedAt,
    );

    expect(baseline).toMatchObject({
      expectedUpdatedAt: 'T2',
      product: { name: 'Polish blue', in_stock: 10, available_qty: 10 },
    });
    expect(edited.name !== baseline.product.name).toBe(false);
    expect(edited.stock !== baseline.product.in_stock).toBe(true);

    const second = await save(true);
    expect(second.status).toBe('success');
    expect(productTokens).toEqual(['T1']);
    expect(stockAttempts).toEqual([
      { token: 'T2', key: 'stock-key-1' },
      { token: 'T2', key: 'stock-key-1' },
    ]);

    edited.name = 'Polish violet';
    expect(edited.name !== baseline.product.name).toBe(true);
  });

  it('advances each chained save step with the canonical product revision', async () => {
    const stockTokens: Array<string | undefined> = [];

    const result = await executeProductSave({
      productDirty: true,
      stockDirty: true,
      expectedUpdatedAt: 'T1',
      updateProduct: async () => ({
        ok: true,
        data: { variant: { updatedAt: 'T2-variant', canonicalUpdatedAt: 'T2-canonical' } },
      }),
      adjustStock: async (token) => {
        stockTokens.push(token);
        return {
          ok: true,
          data: { variant: { updatedAt: 'T3-variant', canonicalUpdatedAt: 'T3-canonical' } },
        };
      },
    });

    expect(stockTokens).toEqual(['T2-canonical']);
    expect(result).toMatchObject({ status: 'success', expectedUpdatedAt: 'T3-canonical' });
  });

  it('wires partial-save recovery into the form before refreshing product props', () => {
    const source = readFileSync(resolve(
      __dirname,
      '../src/renderer/components/products/ProductEditForm.tsx',
    ), 'utf8').replace(/\r\n/g, '\n');

    expect(source).toContain('setCommittedBaseline(nextBaseline);');
    expect(source.indexOf('setCommittedBaseline(nextBaseline);'))
      .toBeLessThan(source.indexOf('await runProductPostCommitBestEffort(['));
  });

  it('retries only the pending image after product and stock committed before upload failed', async () => {
    expect(lifecycle.advanceProductEditBaselineAfterSave).toBeTypeOf('function');
    if (!lifecycle.createProductEditBaseline || !lifecycle.advanceProductEditBaselineAfterSave) return;

    let baseline = lifecycle.createProductEditBaseline(product());
    const edited = { name: 'Polish green', stock: 12 };
    const mutationKeys = createStableMutationKeyStore(() => 'stock-key-1');
    let productUpdates = 0;
    let stockUpdates = 0;
    let imageUploads = 0;
    let pendingImage: { fileName: string } | null = { fileName: 'green.jpg' };
    const usedStockKeys: string[] = [];

    const saveMutations = () => executeProductSave({
      productDirty: edited.name !== baseline.product.name,
      stockDirty: edited.stock !== baseline.product.in_stock,
      expectedUpdatedAt: baseline.expectedUpdatedAt,
      updateProduct: async () => {
        productUpdates += 1;
        return { ok: true, data: { variant: { updatedAt: 'T2' } } };
      },
      adjustStock: async () => {
        stockUpdates += 1;
        usedStockKeys.push(mutationKeys.get(JSON.stringify({
          productId: baseline.product.id,
          mode: 'recount',
          newQuantity: edited.stock,
        })));
        return { ok: true, data: { variant: { updatedAt: 'T3' } } };
      },
    });
    const uploadImage = async (succeeds: boolean) => {
      imageUploads += 1;
      if (succeeds) pendingImage = null;
      return succeeds;
    };

    const first = await saveMutations();
    expect(first).toMatchObject({ status: 'success', expectedUpdatedAt: 'T3' });
    mutationKeys.clear();
    baseline = lifecycle.advanceProductEditBaselineAfterSave(
      baseline,
      { name: edited.name },
      first.expectedUpdatedAt,
      undefined,
      edited.stock,
    );
    await uploadImage(false);

    expect(baseline).toMatchObject({
      expectedUpdatedAt: 'T3',
      product: { name: 'Polish green', in_stock: 12, available_qty: 10 },
    });
    expect(pendingImage).toEqual({ fileName: 'green.jpg' });

    const retry = await saveMutations();
    await uploadImage(true);

    expect(retry.status).toBe('success');
    expect({ productUpdates, stockUpdates, imageUploads }).toEqual({
      productUpdates: 1,
      stockUpdates: 1,
      imageUploads: 2,
    });
    expect(usedStockKeys).toEqual(['stock-key-1']);
    expect(pendingImage).toBeNull();
  });

  it('canonicalizes committed text and stock before an image-only retry', async () => {
    expect(lifecycle.createProductEditBaseline).toBeTypeOf('function');
    expect(lifecycle.advanceProductEditBaselineAfterSave).toBeTypeOf('function');
    expect(lifecycle.productEditFormInputsFromBaseline).toBeTypeOf('function');
    if (!lifecycle.createProductEditBaseline
      || !lifecycle.advanceProductEditBaselineAfterSave
      || !lifecycle.productEditFormInputsFromBaseline) return;

    let baseline = lifecycle.createProductEditBaseline(product());
    let edited = { name: 'Polish green ', stockQty: '12.0' };
    let productUpdates = 0;
    let stockUpdates = 0;
    let imageUploads = 0;
    let pendingImage = true;

    const saveMutations = () => executeProductSave({
      productDirty: edited.name !== baseline.product.name,
      stockDirty: edited.stockQty !== String(baseline.product.in_stock),
      expectedUpdatedAt: baseline.expectedUpdatedAt,
      updateProduct: async () => {
        productUpdates += 1;
        return { ok: true, data: { variant: { updatedAt: 'T2' } } };
      },
      adjustStock: async () => {
        stockUpdates += 1;
        return { ok: true, data: { variant: { updatedAt: 'T3' } } };
      },
    });

    const first = await saveMutations();
    expect(first).toMatchObject({ status: 'success', expectedUpdatedAt: 'T3' });
    baseline = lifecycle.advanceProductEditBaselineAfterSave(
      baseline,
      { name: edited.name.trim() },
      first.expectedUpdatedAt,
      undefined,
      Number(edited.stockQty),
    );
    edited = lifecycle.productEditFormInputsFromBaseline(baseline);
    imageUploads += 1;
    expect(pendingImage).toBe(true);

    const retry = await saveMutations();
    imageUploads += 1;
    pendingImage = false;

    expect(retry.status).toBe('success');
    expect(edited).toMatchObject({ name: 'Polish green', stockQty: '12' });
    expect({ productUpdates, stockUpdates, imageUploads }).toEqual({
      productUpdates: 1,
      stockUpdates: 1,
      imageUploads: 2,
    });
    expect(pendingImage).toBe(false);
  });

  it('applies canonical committed inputs after each successful save phase', () => {
    const source = readFileSync(resolve(
      __dirname,
      '../src/renderer/components/products/ProductEditForm.tsx',
    ), 'utf8').replace(/\r\n/g, '\n');

    expect(source).toContain('applyCommittedBaselineInputs(nextBaseline, false);');
    expect(source).toContain('applyCommittedBaselineInputs(nextBaseline, shouldRunStockMutation);');
  });

  it('commits successful fields and stock before attempting a pending image upload', () => {
    const source = readFileSync(resolve(
      __dirname,
      '../src/renderer/components/products/ProductEditForm.tsx',
    ), 'utf8').replace(/\r\n/g, '\n');
    const commitStock = 'shouldRunStockMutation ? committedStockQuantity : undefined,';

    expect(source).toContain(commitStock);
    expect(source.indexOf(commitStock)).toBeLessThan(source.indexOf('if (pendingImage) {'));
    expect(source).toContain('expectedUpdatedAt: result.expectedUpdatedAt,');
  });

  it('adopts the uploaded image revision before terminal post-commit callbacks', () => {
    const source = readFileSync(resolve(
      __dirname,
      '../src/renderer/components/products/ProductEditForm.tsx',
    ), 'utf8').replace(/\r\n/g, '\n');
    const uploadSuccess = source.indexOf('const uploadedImageBaseline = advanceProductEditBaselineAfterSave(');
    const adoptRevision = source.indexOf('uploadResult.data.variant.updatedAt', uploadSuccess);
    const terminalCallback = source.indexOf('completeCommittedMutation(', uploadSuccess);

    expect(uploadSuccess).toBeGreaterThan(-1);
    expect(adoptRevision).toBeGreaterThan(uploadSuccess);
    expect(terminalCallback).toBeGreaterThan(adoptRevision);
    expect(source).toContain('image_url: uploadResult.data.image.url');
    expect(source).toContain('thumbnail_url: uploadResult.data.image.thumbnailUrl');
  });

  it('freezes ordinary edit controls while a mutation is in flight', () => {
    const source = readFileSync(resolve(
      __dirname,
      '../src/renderer/components/products/ProductEditForm.tsx',
    ), 'utf8').replace(/\r\n/g, '\n');
    const fieldsetStart = source.indexOf('<fieldset disabled={mutationLocked}');
    const nameInput = source.indexOf('value={name}', fieldsetStart);
    const stockInput = source.indexOf('value={stockQty}', fieldsetStart);
    const fieldsetEnd = source.indexOf('</fieldset>', fieldsetStart);

    expect(fieldsetStart).toBeGreaterThan(-1);
    expect(nameInput).toBeGreaterThan(fieldsetStart);
    expect(stockInput).toBeGreaterThan(fieldsetStart);
    expect(fieldsetEnd).toBeGreaterThan(stockInput);
  });

  it('keeps embedded stock uncertainty locked while leaving only exact Save retry enabled', () => {
    const source = readFileSync(resolve(
      __dirname,
      '../src/renderer/components/products/ProductEditForm.tsx',
    ), 'utf8').replace(/\r\n/g, '\n');

    expect(source).toContain('createImmutableMutationAttemptStore<ProductEditStockAttempt>()');
    expect(source).toContain('createMutationOutcomeTracker()');
    expect(source).toContain('const mutationLocked = busy || stockAttemptDispatched;');
    expect(source).toContain('<fieldset disabled={mutationLocked}');
    expect(source).toContain('onBusyChange?.(mutationLocked);');
    expect(source).toContain("? tOr(t, 'products.mutation.retry', 'Retry exact request')");
    expect(source).toContain('.shouldRelease(stockResult)');
    expect(source).toContain('.markAmbiguous()');
  });

  it('cannot confirm a stale discard dialog after save starts or stock becomes uncertain', () => {
    const source = readFileSync(resolve(
      __dirname,
      '../src/renderer/components/products/ProductEditForm.tsx',
    ), 'utf8').replace(/\r\n/g, '\n');
    const handleSave = source.match(/const handleSave = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
    const discardDialog = source.match(/\{pendingCancelConfirm && \([\s\S]*?\n    \)\}/)?.[0] ?? '';

    expect(handleSave.indexOf('setPendingCancelConfirm(false);'))
      .toBeLessThan(handleSave.indexOf('const validationError = validate();'));
    expect(discardDialog).toContain('busy={mutationLocked}');
    expect(discardDialog.match(/if \(mutationLocked\) return;/g)).toHaveLength(2);
  });
});
