import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidProductImageUrl } from '../src/renderer/components/products/ProductImageField';
import {
  expiryPreset,
  isWeightedReceiptProduct,
  receiveUnitCostGrosze,
} from '../src/renderer/components/products/ReceiveStockDialog';
import {
  currentStock as stockAdjustmentCurrentStock,
  parseStockAdjustmentQuantity,
} from '../src/renderer/components/products/StockAdjustmentDialog';

const root = resolve(__dirname, '..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

describe('native Product workspace renderer', () => {
  it('uses total on-hand stock instead of available stock for adjustments', () => {
    expect(stockAdjustmentCurrentStock({
      id: 'variant-1',
      name: 'Reserved item',
      retail_price: 1000,
      in_stock: 10,
      available_qty: 7,
    })).toBe(10);

    const editView = source('src/renderer/components/products/ProductEditView.tsx');
    expect(editView).toContain('const stock = product.in_stock ?? product.available_qty ?? 0;');
  });

  it('locks sibling product mutations for the whole edit session but keeps label printing available', () => {
    const editView = source('src/renderer/components/products/ProductEditView.tsx');

    expect(editView).toContain('const siblingMutationsLocked = editing || editBusy || stockOpen || receiveOpen || deactivateOpen || reactivateBusy;');
    expect(editView).toContain('if (!canEditProduct || siblingMutationsLocked) return;');
    expect(editView).toContain('if (!canOpenStockAdjustment || siblingMutationsLocked) return;');
    expect(editView).toContain('if (!canStopSelling || siblingMutationsLocked) return;');
    expect(editView).toContain('disabled={!canEditProduct || siblingMutationsLocked}');
    expect(editView).toContain('disabled={!canOpenStockAdjustment || siblingMutationsLocked}');
    expect(editView).toContain('disabled={!canReactivate || reactivateBusy || siblingMutationsLocked}');
    expect(editView).toContain('disabled={!canStopSelling || siblingMutationsLocked}');
    expect(editView).toContain('disabled={!canPrintLabel}');
  });

  it('validates standalone stock quantities against the product sale mode', () => {
    expect(parseStockAdjustmentQuantity('2', 'PIECE')).toBe(2);
    expect(parseStockAdjustmentQuantity('2.5', 'PIECE')).toBeNull();
    expect(parseStockAdjustmentQuantity('1.234', 'WEIGHT')).toBe(1.234);
    expect(parseStockAdjustmentQuantity('1.2345', 'WEIGHT')).toBeNull();
  });

  it('gates protected cost, image upload, and lot receiving with backend permissions', () => {
    const moduleSource = source('src/renderer/components/products/ProductModule.tsx');

    expect(moduleSource).toContain('supportsPurchasePrice === true && adminCapabilities?.canViewPurchasePrice === true');
    expect(moduleSource).toContain('supportsMainImageUpload === true && adminCapabilities?.canReplaceMainImage === true');
    expect(moduleSource).toContain('supportsStockLots === true && adminCapabilities?.canReceiveStock === true');
    expect(moduleSource).toContain('supportsLotReceiving === true && adminCapabilities?.canReceiveStock === true');
  });

  it('loads purchase price from authenticated detail and never treats unknown as zero', () => {
    const view = source('src/renderer/components/products/ProductEditView.tsx');
    const form = source('src/renderer/components/products/ProductEditForm.tsx');

    expect(view).toContain('productAdmin.getVariant(product.id)');
    expect(view).toContain('purchasePriceLoaded={adminVariant !== null}');
    expect(view).toContain('purchasePriceLoading');
    expect(form).toContain("return value == null ? '' : (Number(value) / 100).toFixed(2)");
    expect(form).toContain('if (purchasePriceDirty)');
    expect(form).toContain('payload.purchasePriceGrosze = parsedPurchasePrice');
    expect(form).not.toContain('payload.purchasePriceGrosze = parseOptionalMoneyToGrosze(purchasePrice) ?? null');
  });

  it('keeps URL as a first-class image source while local/camera uploads remain pending until save', () => {
    const media = source('src/renderer/components/products/ProductImageField.tsx');
    const form = source('src/renderer/components/products/ProductEditForm.tsx');

    expect(media).toContain('type="file"');
    expect(media).toContain("parsed.protocol === 'http:' || parsed.protocol === 'https:'");
    expect(media).toContain("device.kind === 'videoinput'");
    expect(media).toContain('if (!active) {\n        releaseSharedEnvironmentCameraStream();');
    expect(media).toContain("onImageUrlChange('')");
    expect(form).toContain('if (imageUrlDirty) {\n        payload.imageUrl = imageUrl.trim() || null;');
    expect(form).toContain('productAdmin.uploadMainImage(baselineProduct.id');
    expect(form).toContain('expectedUpdatedAt: result.expectedUpdatedAt,');
    expect(source('src/renderer/components/products/ProductCreateDialog.tsx'))
      .toContain('expectedUpdatedAt: createdVariant.canonicalUpdatedAt ?? createdVariant.updatedAt,');
  });

  it('uses lot-aware receiving with stable retry identity and refreshes the lot summary', () => {
    const dialog = source('src/renderer/components/products/ReceiveStockDialog.tsx');
    const stockDialog = source('src/renderer/components/products/StockAdjustmentDialog.tsx');
    const view = source('src/renderer/components/products/ProductEditView.tsx');
    const committedReceive = dialog.match(/await completeCommittedMutation\([\s\S]*?\n\s*\);/)?.[0] ?? '';
    const committedAdjustment = stockDialog.match(/await completeCommittedMutation\([\s\S]*?\n\s*\);/)?.[0] ?? '';

    expect(dialog).toContain('createImmutableMutationAttemptStore');
    expect(dialog).toContain('mutationAttemptStore.current.dispatch');
    expect(dialog).toContain('disabled={attemptDispatched}');
    expect(stockDialog).toContain('createImmutableMutationAttemptStore');
    expect(stockDialog).toContain('mutationAttemptStore.current.dispatch');
    expect(stockDialog).toContain('disabled={attemptDispatched}');
    expect(committedReceive.indexOf('() => onReceived(result.data!)'))
      .toBeLessThan(committedReceive.indexOf('mutationAttemptStore.current.clear()'));
    expect(committedAdjustment.indexOf('() => (result.data ? onAdjusted(result.data) : undefined)'))
      .toBeLessThan(committedAdjustment.indexOf('mutationAttemptStore.current.clear()'));
    expect(dialog).toContain('sanitizeDecimalText(event.target.value)');
    expect(dialog).toContain('maxLength={255}');
    expect(view).toContain('setLotRefreshToken((value) => value + 1)');
    expect(view).toContain('refreshToken={lotRefreshToken}');
    expect(view).toContain('product.is_active === 0 && !importPending');
  });

  it('retains uncertain stock attempts, blocks every dismiss path, and keeps the session OCC basis', () => {
    const receive = source('src/renderer/components/products/ReceiveStockDialog.tsx');
    const adjust = source('src/renderer/components/products/StockAdjustmentDialog.tsx');

    for (const dialog of [receive, adjust]) {
      expect(dialog).toContain('if (busy || mutationAttemptStore.current.current()) return;');
      expect(dialog).toContain('onClose={requestClose}');
      expect(dialog).toContain('onClick={requestClose}');
      expect(dialog).toContain('disabled={busy || attemptDispatched}');
      expect(dialog).toContain('createMutationOutcomeTracker');
      expect(dialog).toContain('.shouldRelease(result)');
      expect(dialog).toContain('.markAmbiguous()');
      expect(dialog).toContain('mutationAttemptStore.current.clear();');
      expect(dialog).toContain('setAttemptDispatched(false);');
    }

    expect(receive).toContain('weighted: isWeightedReceiptProduct(product),');
    expect(receive).toContain('variantId: session.variantId,');
    expect(receive).toContain('expectedUpdatedAt: session.expectedUpdatedAt,');
    expect(adjust).toContain('stockBefore: currentStock(product),');
    expect(adjust).toContain('sellBy: classifyProductSale(product).sellBy,');
    expect(adjust).toContain('const stockBefore = session.stockBefore;');
    expect(adjust).toContain('const sellBy = session.sellBy;');
    expect(adjust).toContain('variantId: session.variantId,');
    expect(adjust).toContain('expectedUpdatedAt: session.expectedUpdatedAt,');
  });

  it('locks create payload and dismissal only after the first locally valid dispatch', () => {
    const create = source('src/renderer/components/products/ProductCreateDialog.tsx');
    const submit = create.match(/const handleSubmit = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';

    expect(create).toContain('const dispatchedCreateAttemptRef = useRef<ProductAdminCreateProductInput | null>(null);');
    expect(create).toContain('const dispatchedImageRef = useRef<PendingProductImage | null>(null);');
    expect(create).toContain('if (busy || dispatchedCreateAttemptRef.current) return;');
    expect(create).toContain('onClose={requestClose}');
    expect(create).toContain('<fieldset disabled={attemptDispatched}');
    expect(create).toContain('disabled={busy || attemptDispatched}');
    expect(create).not.toContain('guardUnsaved={dirty}');
    expect(submit).toContain('let createAttempt = dispatchedCreateAttemptRef.current;');
    expect(submit).toContain('dispatchedCreateAttemptRef.current = createAttempt;');
    expect(submit).toContain('window.electronAPI.pos.productAdmin.createProduct(createAttempt)');
    expect(create).toContain('createMutationOutcomeTracker');
    expect(submit).toContain('.shouldRelease(result)');
    expect(submit).toContain('.markAmbiguous()');
    expect(submit).toContain('setIdempotencyKey(makeIdempotencyKey());');
    expect(submit).toContain('setAttemptDispatched(false);');
    expect(submit.indexOf("if (typeof validation === 'string')"))
      .toBeLessThan(submit.indexOf('setAttemptDispatched(true)'));
  });

  it('shows committed stock success before the best-effort catalog refresh', () => {
    const view = source('src/renderer/components/products/ProductEditView.tsx');
    const receiveCallback = view.match(/onReceived=\{async[\s\S]*?\n\s*\}\}/)?.[0] ?? '';
    const adjustCallback = view.match(/onAdjusted=\{async[\s\S]*?\n\s*\}\}/)?.[0] ?? '';

    expect(receiveCallback.indexOf('setLotRefreshToken'))
      .toBeLessThan(receiveCallback.indexOf('await onProductChanged()'));
    expect(receiveCallback.indexOf('setLabelMessage'))
      .toBeLessThan(receiveCallback.indexOf('await onProductChanged()'));
    expect(adjustCallback.indexOf('await onStockAdjusted(product, result)'))
      .toBeLessThan(adjustCallback.indexOf('await onProductChanged()'));
  });

  it('shows committed create success before the best-effort catalog refresh', () => {
    const moduleSource = source('src/renderer/components/products/ProductModule.tsx');
    const callback = moduleSource.match(/const handleCreatedProduct = useCallback\(async[\s\S]*?\n  \}, \[/)?.[0] ?? '';

    expect(callback.indexOf('setToast({')).toBeGreaterThanOrEqual(0);
    expect(callback.indexOf('setToast({')).toBeLessThan(callback.indexOf('await refresh();'));
  });

  it('shows committed edit success before best-effort refresh and closes terminally', () => {
    const view = source('src/renderer/components/products/ProductEditView.tsx');
    const form = source('src/renderer/components/products/ProductEditForm.tsx');
    const savedCallback = view.match(/onSaved=\{async[\s\S]*?\n\s*\}\}/)?.[0] ?? '';

    expect(savedCallback.indexOf('await onProductSaved(product, outcome)'))
      .toBeLessThan(savedCallback.indexOf('onProductChanged'));
    expect(savedCallback).toContain('runProductPostCommitBestEffort');
    expect(form).toContain('await completeCommittedMutation(');
  });

  it('cannot confirm a stale back dialog after product save starts', () => {
    const view = source('src/renderer/components/products/ProductEditView.tsx');
    const backDialog = view.match(/\{pendingBackConfirm \? \([\s\S]*?\n\s*\) : null\}/)?.[0] ?? '';

    expect(view).toContain('if (editBusy) setPendingBackConfirm(false);');
    expect(backDialog).toContain('busy={editBusy}');
    expect(backDialog.match(/if \(editBusy\) return;/g)).toHaveLength(2);
  });

  it('keeps immutable import identity read-only while allowing a retired category to be verified', () => {
    const moduleSource = source('src/renderer/components/products/ProductModule.tsx');
    const mainSource = source('src/main/modules/pos.module.ts');
    const electronTypes = source('src/shared/electron.d.ts');

    expect(moduleSource).toContain('function savedFailedImportIntentIdentity(');
    expect(moduleSource).toContain('const immutableVerificationIdentity = failedImportVerificationIdentity(item);');
    expect(moduleSource).toContain('const retiredImmutableCategoryId =');
    expect(moduleSource.match(/disabled=\{busy \|\| identityVerificationLocked\}/g)).toHaveLength(2);
    expect(mainSource).toContain('const exactLegacyVerification =');
    expect(mainSource).toContain('const exactSavedIntentVerification =');
    expect(mainSource).toContain('(exactLegacyVerification || exactSavedIntentVerification)');
    expect(electronTypes).toContain('intent_payload_json: string | null;');
    expect(electronTypes).toContain('intent_idempotency_key: string | null;');
    expect(electronTypes).toContain('intent_dispatched_at: string | null;');
  });

  it('does not refetch protected detail, lots, or restart camera when only translator identity changes', () => {
    const view = source('src/renderer/components/products/ProductEditView.tsx');
    const lots = source('src/renderer/components/products/ProductLotSummary.tsx');
    const image = source('src/renderer/components/products/ProductImageField.tsx');

    expect(view).toContain('const tRef = useRef(t);');
    expect(view).toContain('}, [canViewPurchasePrice, importPending, product._isDraft, product.id]);');
    expect(lots).toContain('const tRef = useRef(t);');
    expect(lots).toContain('}, [refreshToken, retryToken, variantId]);');
    expect(image).toContain('const tRef = useRef(t);');
    expect(image).toContain('}, [open]);');
    expect(view).not.toContain('product.id, t]);');
    expect(lots).not.toContain('retryToken, t, variantId]);');
    expect(image).not.toContain('[open, t]');
  });

  it('clamps month expiry presets instead of overflowing into the following month', () => {
    expect(expiryPreset(new Date(2026, 0, 31), 1, 'months')).toBe('2026-02-28');
    expect(expiryPreset(new Date(2026, 0, 31), 3, 'months')).toBe('2026-04-30');
    expect(expiryPreset(new Date(2026, 6, 13), 14, 'days')).toBe('2026-07-27');
  });

  it('omits protected unit cost for receive-only operators', () => {
    expect(receiveUnitCostGrosze('12.34', false)).toBeNull();
    expect(receiveUnitCostGrosze('12.34', true)).toBe(1234);
    expect(receiveUnitCostGrosze('', true)).toBeNull();
    expect(receiveUnitCostGrosze('12.345', true)).toBeUndefined();
  });

  it('uses the shared sale classifier for legacy weight units', () => {
    expect(isWeightedReceiptProduct({ sale_unit: 'kg' })).toBe(true);
    expect(isWeightedReceiptProduct({ sale_unit: 'kilogram' })).toBe(true);
    expect(isWeightedReceiptProduct({ sale_unit: 'kilograms' })).toBe(true);
    expect(isWeightedReceiptProduct({ sell_by: 'PIECE', sale_unit: 'pcs' })).toBe(false);
  });

  it('accepts only blank or http(s) image URLs', () => {
    expect(isValidProductImageUrl('')).toBe(true);
    expect(isValidProductImageUrl('https://img.example.com/product.jpg')).toBe(true);
    expect(isValidProductImageUrl('http://img.example.com/product.png')).toBe(true);
    expect(isValidProductImageUrl('/legacy-relative.jpg')).toBe(false);
    expect(isValidProductImageUrl('file:///C:/photo.jpg')).toBe(false);
    expect(isValidProductImageUrl('javascript:alert(1)')).toBe(false);
  });

  it('keeps URL updates compatible while enforcing purchase-price capabilities in main IPC', () => {
    const main = source('src/main/modules/pos.module.ts');

    expect(main).toContain('requestPayload.purchasePriceGrosze !== undefined');
    expect(main).toContain('normalizedPayload.purchasePriceGrosze !== undefined');
    expect(main).not.toContain('payload?.imageUrl !== undefined && capabilities.canReplaceMainImage !== true');
    expect(main).toContain('delete input.unitCostGrosze');
    expect(main).toContain('payload.unitCostGrosze !== undefined && !canAccessProductPurchasePrice(capabilities)');
    expect(main).toContain('redactProductAdminPurchaseData(rawData)');
    expect(main.indexOf('redactProductAdminPurchaseData(rawData)'))
      .toBeLessThan(main.indexOf('if (afterSuccess) {'));
    expect(main).not.toContain("mirrorProductAdminVariant(data.variant, 'product_admin_detail')");
  });

  it('ships English, Vietnamese, and Polish copy for the workspace essentials', () => {
    const create = source('src/renderer/components/products/ProductCreateDialog.tsx');
    const translations = source('src/renderer/i18n/translations.ts');
    expect(create).toContain("products.create.expiryStockHint");
    for (const key of [
      'products.purchase.price',
      'products.media.title',
      'products.lots.title',
      'products.receive.title',
      'products.receive.failed',
      'products.create.expiryStockHint',
      'products.mutation.retry',
      'products.mutation.retryLocked',
    ]) {
      expect(translations.match(new RegExp(`'${key}'`, 'g'))).toHaveLength(3);
    }
  });
});
