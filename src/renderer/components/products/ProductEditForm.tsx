import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Tags } from 'lucide-react';
import { diffNameTranslations, parseTranslations, resolveName } from '../../../shared/catalog-names';
import { generateUniqueInternalEan } from '../../../shared/internal-ean';
import { classifyProductSale } from '../../../shared/product-sale-classifier';
import { getProductItemTypePolicy, isStockTracked, productItemType } from '../../../shared/product-stock-tracking';
import { parseProductMoneyInputToGrosze } from '../../../shared/product-money';
import type { ProductAdminItemType, ProductAdminStockAdjustmentInput, ProductAdminUpdateVariantInput } from '../../../shared/types';
import type { Category } from '../../hooks/usePosDb';
import type { ProductListItem } from '../../hooks/useProducts';
import { grossFromNet, netFromGross } from './price-vat';
import ConfirmActionDialog from '../pos/ConfirmActionDialog';
import {
  completeCommittedMutation,
  createImmutableMutationAttemptStore,
  createMutationOutcomeTracker,
} from './mutation-idempotency';
import { sanitizeDecimalText } from './decimal-input';
import ProductImageField, { isValidProductImageUrl, type PendingProductImage } from './ProductImageField';
import { useProductVatRates } from './product-vat-rates';
import { executeProductSave } from './save-product-changes';
import { receiptNamePreview } from './receipt-name-preview';

interface ProductEditFormProps {
  product: ProductListItem;
  categories: Category[];
  language: string;
  t: (key: string) => string;
  canManageCategories: boolean;
  canAdjustStock: boolean;
  supportsItemType: boolean;
  canChangeInventoryMode: boolean;
  canViewPurchasePrice?: boolean;
  purchasePriceGrosze?: number | null;
  purchasePriceLoaded?: boolean;
  purchasePriceLoading?: boolean;
  purchasePriceError?: string | null;
  onReloadAdminDetail?: () => void;
  canReplaceMainImage?: boolean;
  /** 4-digit salon code (capabilities.salonCode) — enables the internal-EAN generate button. */
  salonCode?: string | null;
  /** Catalog-wide code collision check supplied by ProductModule (barcode/ean/sku). */
  isBarcodeTaken?: (code: string) => boolean;
  canEditDisplayName: boolean;
  displayNameAffectsMultipleVariants: boolean;
  onCancel: () => void;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onManageCategories: () => void;
  onProductChanged: () => Promise<void> | void;
  onSaved: (outcome: { stockBefore?: number; stockAfter?: number; vatChanged?: boolean }) => Promise<void> | void;
}

type ProductEditStockAttempt = Omit<ProductAdminStockAdjustmentInput, 'idempotencyKey'> & {
  variantId: string;
};

export interface ProductEditBaseline {
  readonly expectedUpdatedAt?: string;
  readonly product: ProductListItem;
  readonly purchasePriceInput?: string;
}

export function createProductEditBaseline(
  product: ProductListItem,
  purchasePriceInput?: string,
): ProductEditBaseline {
  const snapshot = Object.freeze({ ...product });
  return Object.freeze({
    expectedUpdatedAt: snapshot.updated_at || undefined,
    product: snapshot,
    purchasePriceInput,
  });
}

export function advanceProductEditBaselineAfterSave(
  baseline: ProductEditBaseline,
  committedFields: Partial<ProductListItem>,
  expectedUpdatedAt?: string,
  purchasePriceInput: string | undefined = baseline.purchasePriceInput,
  committedStock?: number,
): ProductEditBaseline {
  const nextExpectedUpdatedAt = expectedUpdatedAt || baseline.expectedUpdatedAt;
  return createProductEditBaseline({
    ...baseline.product,
    ...committedFields,
    id: baseline.product.id,
    in_stock: committedStock ?? baseline.product.in_stock,
    // Recount commits total on-hand. Available stock can differ while units are
    // reserved, and this response path does not carry the new available value.
    available_qty: baseline.product.available_qty,
    updated_at: nextExpectedUpdatedAt || baseline.product.updated_at,
  }, purchasePriceInput);
}

export function reconcileProductEditBaseline(
  baseline: ProductEditBaseline,
  product: ProductListItem,
  dirty: boolean,
): { baseline: ProductEditBaseline; conflict: boolean } {
  if (baseline.product.id !== product.id) {
    return { baseline: createProductEditBaseline(product), conflict: false };
  }
  return {
    baseline,
    conflict: dirty && (product.updated_at || undefined) !== baseline.expectedUpdatedAt,
  };
}

export function productEditNavigationState(busy: boolean): {
  cancelDisabled: boolean;
  backDisabled: boolean;
} {
  return {
    cancelDisabled: busy,
    backDisabled: busy,
  };
}

export function canChangeExistingProductItemType(
  currentTracked: boolean,
  currentSellBy: 'PIECE' | 'WEIGHT',
  nextItemType: ProductAdminItemType,
  canChangeInventoryMode: boolean,
): boolean {
  const nextPolicy = getProductItemTypePolicy(nextItemType, currentSellBy);
  if (nextPolicy.sellBy !== currentSellBy) return false;
  if (currentTracked && !nextPolicy.stockApplies) {
    return canChangeInventoryMode;
  }
  // Disabling tracking is validated against canonical stock by the backend.
  return currentTracked || !nextPolicy.stockApplies;
}

export async function runProductPostCommitBestEffort(
  callbacks: Array<() => Promise<void> | void>,
): Promise<void> {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch {
      // The canonical mutation already committed. Local mirror/detail refreshes
      // must never turn that success into a retryable mutation failure.
    }
  }
}

const DISPLAY_NAME_LOCALES = ['vi', 'pl', 'en'] as const;

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function moneyInputFromGrosze(value: number | null | undefined): string {
  return ((Number(value) || 0) / 100).toFixed(2);
}

function optionalMoneyInputFromGrosze(value: number | null | undefined): string {
  return value == null ? '' : (Number(value) / 100).toFixed(2);
}

function parseMoneyToGrosze(value: string): number | null {
  const parsed = parseProductMoneyInputToGrosze(value, { allowZero: true });
  return typeof parsed === 'number' ? parsed : null;
}

function parseOptionalMoneyToGrosze(value: string): number | null | undefined {
  return parseProductMoneyInputToGrosze(value, { allowBlank: true, allowZero: true });
}

function decimalPlaces(value: string): number {
  const [, fraction = ''] = value.split('.');
  return fraction.length;
}

function parseStockQuantity(value: string, sellBy: 'PIECE' | 'WEIGHT'): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return 0;
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (sellBy === 'PIECE') return Number.isInteger(parsed) ? parsed : null;
  if (decimalPlaces(normalized) > 3) return null;
  return Math.round(parsed * 1000) / 1000;
}

function currentStock(product: ProductListItem): number {
  return Number(product.in_stock ?? product.available_qty ?? 0) || 0;
}

function trackInventoryFlag(product: ProductListItem): boolean {
  return product.track_inventory !== 0;
}

function stockInputFromProduct(product: ProductListItem): string {
  return String(currentStock(product));
}

function vatRateFromProduct(product: ProductListItem): number {
  const vatRate = Number(product.vat_rate);
  return Number.isFinite(vatRate) && vatRate >= 0 ? vatRate : 23;
}

function productSellBy(product: ProductListItem): 'PIECE' | 'WEIGHT' {
  return classifyProductSale(product).sellBy;
}

function displayNamesFromProduct(product: ProductListItem): Record<string, string> {
  const translations = parseTranslations(product.name_translations);
  return {
    vi: translations.vi ?? '',
    pl: translations.pl ?? '',
    en: translations.en ?? '',
  };
}

export function productEditFormInputsFromBaseline(baseline: ProductEditBaseline) {
  const product = baseline.product;
  const vatRate = String(vatRateFromProduct(product));
  const priceGross = moneyInputFromGrosze(product.retail_price);
  const itemType = productItemType(product);
  const originalSellBy = productSellBy(product);
  const sellBy = getProductItemTypePolicy(itemType, originalSellBy).sellBy;
  return {
    name: product.name || '',
    priceGross,
    priceNet: netFromGross(priceGross, vatRate),
    purchasePrice: baseline.purchasePriceInput,
    vatRate,
    barcode: product.barcode || '',
    sku: product.sku || '',
    categoryId: product.category_id || '',
    sellBy,
    saleUnit: sellBy === originalSellBy ? product.sale_unit || '' : 'szt',
    itemType,
    trackInventory: trackInventoryFlag(product),
    stockQty: stockInputFromProduct(product),
    imageUrl: product.image_url || '',
    displayNames: displayNamesFromProduct(product),
  };
}

export default function ProductEditForm({
  product,
  categories,
  language,
  t,
  canManageCategories,
  canAdjustStock,
  supportsItemType,
  canChangeInventoryMode,
  canViewPurchasePrice = false,
  purchasePriceGrosze,
  purchasePriceLoaded = false,
  purchasePriceLoading = false,
  purchasePriceError,
  onReloadAdminDetail = () => undefined,
  canReplaceMainImage = false,
  salonCode,
  isBarcodeTaken,
  canEditDisplayName,
  displayNameAffectsMultipleVariants,
  onCancel,
  onBusyChange,
  onDirtyChange,
  onManageCategories,
  onProductChanged,
  onSaved,
}: ProductEditFormProps) {
  // A same-ID catalog refresh must not replace any part of the edit session's
  // comparison/OCC baseline while the form still contains the older values.
  const sessionStartBaseline = useMemo(() => createProductEditBaseline(
    product,
    purchasePriceLoaded ? optionalMoneyInputFromGrosze(purchasePriceGrosze) : undefined,
  ), [product.id]);
  const [committedBaseline, setCommittedBaseline] = useState(sessionStartBaseline);
  const editBaseline = committedBaseline.product.id === product.id
    ? committedBaseline
    : sessionStartBaseline;
  const baselineProduct = editBaseline.product;
  const originalVatRate = vatRateFromProduct(baselineProduct);
  const originalItemType = productItemType(baselineProduct);
  const originalSellBy = productSellBy(baselineProduct);
  const initialSellBy = getProductItemTypePolicy(originalItemType, originalSellBy).sellBy;
  const stockTracked = isStockTracked(baselineProduct);
  const originalTrackInventory = trackInventoryFlag(baselineProduct);
  const expectedUpdatedAt = editBaseline.expectedUpdatedAt;
  const [name, setName] = useState(baselineProduct.name || '');
  const [priceGross, setPriceGross] = useState(moneyInputFromGrosze(baselineProduct.retail_price));
  const [vatRate, setVatRate] = useState(String(originalVatRate));
  const [priceNet, setPriceNet] = useState(
    netFromGross(moneyInputFromGrosze(baselineProduct.retail_price), String(originalVatRate)),
  );
  const [purchasePrice, setPurchasePrice] = useState(
    purchasePriceLoaded ? optionalMoneyInputFromGrosze(purchasePriceGrosze) : '',
  );
  const [barcode, setBarcode] = useState(baselineProduct.barcode || '');
  const [sku, setSku] = useState(baselineProduct.sku || '');
  const [categoryId, setCategoryId] = useState(baselineProduct.category_id || '');
  const [sellBy, setSellBy] = useState<'PIECE' | 'WEIGHT'>(initialSellBy);
  const [saleUnit, setSaleUnit] = useState(
    initialSellBy === originalSellBy ? baselineProduct.sale_unit || '' : 'szt',
  );
  const [itemType, setItemType] = useState(originalItemType);
  const [trackInventory, setTrackInventory] = useState(originalTrackInventory);
  const [stockQty, setStockQty] = useState(stockInputFromProduct(baselineProduct));
  const [imageUrl, setImageUrl] = useState(baselineProduct.image_url || '');
  const [pendingImage, setPendingImage] = useState<PendingProductImage | null>(null);
  const [displayNames, setDisplayNames] = useState<Record<string, string>>(() => displayNamesFromProduct(baselineProduct));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pendingCancelConfirm, setPendingCancelConfirm] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [stockAttemptDispatched, setStockAttemptDispatched] = useState(false);
  const stockMutationAttemptStore = useRef(createImmutableMutationAttemptStore<ProductEditStockAttempt>());
  const stockMutationOutcomeTracker = useRef(createMutationOutcomeTracker());
  const vatRates = useProductVatRates(originalVatRate);

  useEffect(() => {
    const sessionProduct = sessionStartBaseline.product;
    const sessionVatRate = vatRateFromProduct(sessionProduct);
    const sessionItemType = productItemType(sessionProduct);
    const sessionSellBy = productSellBy(sessionProduct);
    setCommittedBaseline(sessionStartBaseline);
    setName(sessionProduct.name || '');
    setPriceGross(moneyInputFromGrosze(sessionProduct.retail_price));
    setVatRate(String(sessionVatRate));
    setPriceNet(
      netFromGross(moneyInputFromGrosze(sessionProduct.retail_price), String(sessionVatRate)),
    );
    setPurchasePrice(sessionStartBaseline.purchasePriceInput || '');
    setBarcode(sessionProduct.barcode || '');
    setSku(sessionProduct.sku || '');
    setCategoryId(sessionProduct.category_id || '');
    const nextSellBy = getProductItemTypePolicy(sessionItemType, sessionSellBy).sellBy;
    setSellBy(nextSellBy);
    setSaleUnit(nextSellBy === sessionSellBy ? sessionProduct.sale_unit || '' : 'szt');
    setItemType(sessionItemType);
    setTrackInventory(trackInventoryFlag(sessionProduct));
    setStockQty(stockInputFromProduct(sessionProduct));
    setImageUrl(sessionProduct.image_url || '');
    setPendingImage(null);
    setDisplayNames(displayNamesFromProduct(sessionProduct));
    setBusy(false);
    setMessage(null);
    setAdvancedOpen(false);
    setStockAttemptDispatched(false);
    stockMutationAttemptStore.current.clear();
    stockMutationOutcomeTracker.current.clear();
  }, [sessionStartBaseline]);

  useEffect(() => {
    if (!canViewPurchasePrice || !purchasePriceLoaded) return;
    if (editBaseline.purchasePriceInput !== undefined) return;
    const purchasePriceInput = optionalMoneyInputFromGrosze(purchasePriceGrosze);
    setCommittedBaseline(Object.freeze({ ...editBaseline, purchasePriceInput }));
    setPurchasePrice(purchasePriceInput);
  }, [canViewPurchasePrice, editBaseline, purchasePriceGrosze, purchasePriceLoaded]);

  const sortedCategories = useMemo(() => {
    return [...categories].sort((a, b) =>
      resolveName(a, language).localeCompare(resolveName(b, language)),
    );
  }, [categories, language]);

  const originalDisplayNames = useMemo(
    () => displayNamesFromProduct(baselineProduct),
    [baselineProduct],
  );
  const nameTranslationsPatch = useMemo(
    () => canEditDisplayName
      ? diffNameTranslations(originalDisplayNames, displayNames, DISPLAY_NAME_LOCALES)
      : {},
    [canEditDisplayName, displayNames, originalDisplayNames],
  );
  const translationsDirty = Object.keys(nameTranslationsPatch).length > 0;
  const itemPolicy = getProductItemTypePolicy(itemType, sellBy);
  const inventoryTrackingEditable = supportsItemType
    && canChangeInventoryMode
    && itemType === 'stockable';
  const inventoryTrackingDirty = inventoryTrackingEditable
    && trackInventory !== originalTrackInventory;
  const receiptPreview = useMemo(
    () => receiptNamePreview(name, displayNames),
    [displayNames, name],
  );

  const purchasePriceDirty = canViewPurchasePrice
    && purchasePriceLoaded
    && purchasePrice !== (editBaseline.purchasePriceInput
      ?? optionalMoneyInputFromGrosze(purchasePriceGrosze));
  const imageUrlDirty = pendingImage === null && imageUrl !== (baselineProduct.image_url || '');
  const variantFieldsDirty = useMemo(() => (
    name !== (baselineProduct.name || '')
    || priceGross !== moneyInputFromGrosze(baselineProduct.retail_price)
    || vatRate !== String(originalVatRate)
    || barcode !== (baselineProduct.barcode || '')
    || sku !== (baselineProduct.sku || '')
    || categoryId !== (baselineProduct.category_id || '')
    || saleUnit !== (baselineProduct.sale_unit || '')
    || imageUrlDirty
    || purchasePriceDirty
    || (supportsItemType && itemType !== originalItemType)
    || inventoryTrackingDirty
  ), [barcode, baselineProduct, categoryId, imageUrlDirty, inventoryTrackingDirty, itemType, name, originalItemType, priceGross, purchasePriceDirty, saleUnit, sku, supportsItemType, vatRate]);

  const productDirty = variantFieldsDirty || translationsDirty;
  // Enabling tracking commits before the optional recount in executeProductSave,
  // so a zero-stock untracked product can be enabled and initialized in one save.
  const stockEditable = canAdjustStock
    && itemPolicy.stockApplies
    && itemType === 'stockable'
    && trackInventory;
  const stockDirty = stockEditable && stockQty !== stockInputFromProduct(baselineProduct);
  const mediaDirty = pendingImage !== null;
  const dirty = productDirty || stockDirty || mediaDirty;
  const mutationLocked = busy || stockAttemptDispatched;
  const navigationState = productEditNavigationState(mutationLocked);

  useEffect(() => {
    onBusyChange?.(mutationLocked);
  }, [mutationLocked, onBusyChange]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const applyCommittedBaselineInputs = (
    baseline: ProductEditBaseline,
    includeStock: boolean,
  ) => {
    const inputs = productEditFormInputsFromBaseline(baseline);
    setName(inputs.name);
    setPriceGross(inputs.priceGross);
    setPriceNet(inputs.priceNet);
    setVatRate(inputs.vatRate);
    if (inputs.purchasePrice !== undefined) setPurchasePrice(inputs.purchasePrice);
    setBarcode(inputs.barcode);
    setSku(inputs.sku);
    setCategoryId(inputs.categoryId);
    setSellBy(inputs.sellBy);
    setSaleUnit(inputs.saleUnit);
    setItemType(inputs.itemType);
    setTrackInventory(inputs.trackInventory);
    setImageUrl(inputs.imageUrl);
    setDisplayNames(inputs.displayNames);
    if (includeStock) {
      setStockQty(inputs.stockQty);
    }
  };

  const validate = (): string | null => {
    if (!name.trim()) return tOr(t, 'products.edit.nameRequired', 'Enter product name');
    if (parseMoneyToGrosze(priceGross) === null) return tOr(t, 'products.edit.priceInvalid', 'Enter a valid price');
    const vat = Number(vatRate);
    if (!vatRates.includes(vat)) return tOr(t, 'products.edit.vatInvalid', 'Select a valid VAT rate');
    if (purchasePriceDirty) {
      const parsedPurchasePrice = parseOptionalMoneyToGrosze(purchasePrice);
      if (parsedPurchasePrice === undefined) {
        return tOr(t, 'products.purchase.invalid', 'Enter a valid purchase price with up to 2 decimal places');
      }
      if (parsedPurchasePrice === null) {
        return tOr(t, 'products.purchase.blankUpdate', 'Enter 0 explicitly instead of leaving a changed purchase price blank');
      }
    }
    if (imageUrlDirty && !isValidProductImageUrl(imageUrl)) {
      return tOr(t, 'products.media.urlInvalid', 'Use a complete http:// or https:// image URL');
    }
    if (stockEditable && parseStockQuantity(stockQty, sellBy) === null) {
      return sellBy === 'WEIGHT'
        ? tOr(t, 'products.create.stockWeightPrecision', 'Enter kg stock with up to 3 decimal places')
        : tOr(t, 'products.create.stockPieceInvalid', 'Piece stock must be a whole number');
    }
    return null;
  };

  const handleSave = async () => {
    setPendingCancelConfirm(false);
    const validationError = validate();
    if (validationError) {
      setMessage({ ok: false, text: validationError });
      return;
    }

    const priceGrossGrosze = parseMoneyToGrosze(priceGross);
    if (priceGrossGrosze === null) return;
    const parsedStockQty = stockEditable ? parseStockQuantity(stockQty, sellBy) : null;
    if (stockEditable && parsedStockQty === null) return;

    const payload: ProductAdminUpdateVariantInput = {
      expectedUpdatedAt,
    };
    if (variantFieldsDirty) {
      Object.assign(payload, {
        name: name.trim(),
        barcode: barcode.trim() || null,
        sku: sku.trim() || null,
        priceGrossGrosze,
        vatRate: Number(vatRate),
        categoryId: categoryId || null,
        saleUnit: saleUnit.trim() || null,
        isActive: baselineProduct.is_active !== 0,
      });
      if (imageUrlDirty) {
        payload.imageUrl = imageUrl.trim() || null;
      }
      if (supportsItemType
        && itemType !== originalItemType
        && canChangeExistingProductItemType(stockTracked, originalSellBy, itemType as ProductAdminItemType, canChangeInventoryMode)) {
        payload.itemType = itemType as ProductAdminItemType;
      }
      if (inventoryTrackingDirty) {
        payload.trackInventory = trackInventory;
      }
      if (purchasePriceDirty) {
        const parsedPurchasePrice = parseOptionalMoneyToGrosze(purchasePrice);
        if (parsedPurchasePrice !== null && parsedPurchasePrice !== undefined) {
          payload.purchasePriceGrosze = parsedPurchasePrice;
        }
      }
    }
    if (translationsDirty && canEditDisplayName) {
      payload.nameTranslations = nameTranslationsPatch;
    }

    const committedFields: Partial<ProductListItem> = {};
    if (variantFieldsDirty) {
      Object.assign(committedFields, {
        name: name.trim(),
        barcode: barcode.trim() || null,
        sku: sku.trim() || null,
        retail_price: priceGrossGrosze,
        vat_rate: Number(vatRate),
        category_id: categoryId || null,
        sale_unit: saleUnit.trim() || null,
        is_active: baselineProduct.is_active,
      });
      if (imageUrlDirty) committedFields.image_url = imageUrl.trim() || null;
      if (supportsItemType
        && itemType !== originalItemType
        && canChangeExistingProductItemType(stockTracked, originalSellBy, itemType as ProductAdminItemType, canChangeInventoryMode)) {
        committedFields.item_type = itemType;
      }
      if (inventoryTrackingDirty) {
        committedFields.track_inventory = trackInventory ? 1 : 0;
      }
    }
    if (translationsDirty && canEditDisplayName) {
      const committedTranslations = { ...parseTranslations(baselineProduct.name_translations) };
      for (const locale of DISPLAY_NAME_LOCALES) {
        const value = (displayNames[locale] || '').trim();
        if (value) committedTranslations[locale] = value;
        else delete committedTranslations[locale];
      }
      committedFields.name_translations = JSON.stringify(committedTranslations);
    }

    let committedSessionBaseline = editBaseline;
    let committedStockQuantity = parsedStockQty ?? 0;
    const shouldRunStockMutation = stockDirty
      || stockMutationAttemptStore.current.current() !== null;
    setBusy(true);
    setMessage(null);
    try {
      const result = await executeProductSave({
        productDirty,
        stockDirty: shouldRunStockMutation,
        expectedUpdatedAt,
        updateProduct: () => window.electronAPI.pos.productAdmin.updateVariant(baselineProduct.id, payload),
        adjustStock: async (stockExpectedUpdatedAt) => {
          let attempt = stockMutationAttemptStore.current.current();
          if (!attempt) {
            attempt = stockMutationAttemptStore.current.dispatch({
              variantId: baselineProduct.id,
              mode: 'recount',
              newQuantity: parsedStockQty ?? 0,
              expectedUpdatedAt: stockExpectedUpdatedAt,
            });
            setStockAttemptDispatched(true);
          }
          committedStockQuantity = Number(attempt.newQuantity) || 0;
          const { variantId, idempotencyKey, ...stockPayload } = attempt;

          try {
            const stockResult = await window.electronAPI.pos.productAdmin.adjustStock(variantId, {
              ...stockPayload,
              idempotencyKey,
            });
            if (stockResult?.ok) {
              stockMutationAttemptStore.current.clear();
              stockMutationOutcomeTracker.current.clear();
              setStockAttemptDispatched(false);
            } else if (stockMutationOutcomeTracker.current.shouldRelease(stockResult)) {
              stockMutationAttemptStore.current.clear();
              stockMutationOutcomeTracker.current.clear();
              setStockAttemptDispatched(false);
            }
            return stockResult;
          } catch (error) {
            stockMutationOutcomeTracker.current.markAmbiguous();
            throw error;
          }
        },
      });

      if (result.status === 'product-failed') {
        setMessage({
          ok: false,
          text: result.error || tOr(t, 'products.edit.failed', 'Could not save product'),
        });
        return;
      }

      if (result.status === 'stock-failed') {
        if (result.productSaved) {
          const nextBaseline = advanceProductEditBaselineAfterSave(
            editBaseline,
            committedFields,
            result.expectedUpdatedAt,
            purchasePriceDirty ? purchasePrice : editBaseline.purchasePriceInput,
          );
          committedSessionBaseline = nextBaseline;
          setCommittedBaseline(nextBaseline);
          applyCommittedBaselineInputs(nextBaseline, false);
          await runProductPostCommitBestEffort([
            onProductChanged,
            onReloadAdminDetail,
          ]);
        }
        const failure = result.error || tOr(t, 'products.stock.failed', 'Could not adjust stock');
        setMessage({
          ok: false,
          text: result.productSaved
            ? `${tOr(t, 'products.edit.stockFailed', 'Product saved, but stock could not be updated')}: ${failure}`
            : failure,
        });
        return;
      }

      if (result.productSaved || shouldRunStockMutation) {
        const nextBaseline = advanceProductEditBaselineAfterSave(
          editBaseline,
          committedFields,
          result.expectedUpdatedAt,
          purchasePriceDirty ? purchasePrice : editBaseline.purchasePriceInput,
          shouldRunStockMutation ? committedStockQuantity : undefined,
        );
        committedSessionBaseline = nextBaseline;
        setCommittedBaseline(nextBaseline);
        applyCommittedBaselineInputs(nextBaseline, shouldRunStockMutation);
      }
      if (pendingImage) {
        const uploadResult = await window.electronAPI.pos.productAdmin.uploadMainImage(baselineProduct.id, {
          dataUrl: pendingImage.dataUrl,
          fileName: pendingImage.fileName,
          mimeType: pendingImage.mimeType,
          expectedUpdatedAt: result.expectedUpdatedAt,
        });
        if (!uploadResult?.ok || !uploadResult.data) {
          if (result.productSaved || shouldRunStockMutation) {
            await runProductPostCommitBestEffort([
              onProductChanged,
              onReloadAdminDetail,
            ]);
          }
          setMessage({
            ok: false,
            text: (result.productSaved || shouldRunStockMutation)
              ? `${tOr(t, 'products.media.otherChangesSaved', 'Other changes were saved, but the image upload failed')}: ${uploadResult?.error || uploadResult?.code || tOr(t, 'products.media.uploadFailed', 'Could not upload image')}`
              : uploadResult?.error || uploadResult?.code || tOr(t, 'products.media.uploadFailed', 'Could not upload image'),
          });
          return;
        }
        const uploadedImageBaseline = advanceProductEditBaselineAfterSave(
          committedSessionBaseline,
          {
            image_url: uploadResult.data.image.url,
            thumbnail_url: uploadResult.data.image.thumbnailUrl,
          },
          uploadResult.data.variant.canonicalUpdatedAt ?? uploadResult.data.variant.updatedAt,
        );
        committedSessionBaseline = uploadedImageBaseline;
        setCommittedBaseline(uploadedImageBaseline);
        applyCommittedBaselineInputs(uploadedImageBaseline, true);
        setPendingImage(null);
      }
      setMessage({ ok: true, text: tOr(t, 'products.edit.success', 'Product saved') });
      await completeCommittedMutation(
        () => onSaved({
          stockBefore: shouldRunStockMutation ? currentStock(sessionStartBaseline.product) : undefined,
          stockAfter: shouldRunStockMutation ? committedStockQuantity : undefined,
          vatChanged: vatRate !== String(vatRateFromProduct(sessionStartBaseline.product)),
        }),
        () => {
          onDirtyChange?.(false);
          onCancel();
        },
      );
    } catch (err: any) {
      const failure = err?.message || tOr(t, 'products.edit.failed', 'Could not save product');
      if (committedSessionBaseline !== editBaseline) {
        await runProductPostCommitBestEffort([
          onProductChanged,
          onReloadAdminDetail,
        ]);
      }
      setMessage({
        ok: false,
        text: committedSessionBaseline !== editBaseline
          ? `${tOr(t, 'products.media.otherChangesSaved', 'Other changes were saved, but the image upload failed')}: ${failure}`
          : failure,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = () => {
    if (navigationState.cancelDisabled) return;
    if (dirty) {
      setPendingCancelConfirm(true);
      return;
    }
    onCancel();
  };

  const changeItemType = (value: string) => {
    const nextItemType = value as ProductAdminItemType;
    if (!canChangeExistingProductItemType(stockTracked, originalSellBy, nextItemType, canChangeInventoryMode)) return;
    setItemType(nextItemType);
  };

  return (
    <>
    <section className="mt-5 rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-950">{tOr(t, 'products.edit.title', 'Edit product')}</h3>
      </div>
      <fieldset disabled={mutationLocked} className="min-w-0 space-y-4 border-0 p-4">
        {stockAttemptDispatched ? (
          <div role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {tOr(t, 'products.mutation.retryLocked', 'The previous request may have reached the server. Editing and closing are locked; retry the exact request.')}
          </div>
        ) : null}
        <label className="block">
          <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
            {tOr(t, 'products.drawer.canonicalName', 'Internal name (backend sync)')}
          </span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
          />
        </label>

        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase text-amber-800">
              {tOr(t, 'products.edit.displayNamePl', 'Receipt / fiscal name (Polish)')}
            </span>
            {displayNameAffectsMultipleVariants ? (
              <span className="text-xs font-medium text-amber-700">
                {tOr(t, 'products.edit.displayNameAllVariants', 'Applies to all variants of this product')}
              </span>
            ) : null}
          </div>
          <input
            value={displayNames.pl}
            onChange={(event) => setDisplayNames((current) => ({ ...current, pl: event.target.value }))}
            placeholder={name.trim() || baselineProduct.name}
            maxLength={255}
            readOnly={!canEditDisplayName}
            className="h-11 w-full rounded-md border border-amber-300 bg-white px-3 text-sm outline-none focus:border-amber-500 read-only:cursor-not-allowed read-only:bg-slate-50 read-only:text-slate-500"
          />
          {!canEditDisplayName ? (
            <p className="mt-2 text-xs font-medium text-amber-800">
              {tOr(t, 'products.edit.displayNameUnavailable', 'This backend cannot edit receipt display names.')}
            </p>
          ) : null}
          {receiptPreview.source === 'canonical' ? (
            <p className="mt-2 text-xs font-medium text-amber-800">
              {tOr(t, 'products.edit.receiptFallbackWarning', 'Polish receipt name is blank, so receipts will print the internal name.')}
            </p>
          ) : null}
          <div className="mt-2 grid grid-cols-1 gap-2 text-xs text-slate-700 sm:grid-cols-2">
            <div>
              <span className="font-semibold text-slate-600">{tOr(t, 'products.edit.receiptPrints', 'Receipt prints')}:</span>{' '}
              <span className="font-medium text-slate-950">{receiptPreview.value || '-'}</span>
            </div>
            <div>
              <span className="font-semibold text-slate-600">{tOr(t, 'products.edit.receiptFiscalFold', 'Fiscal-safe text')}:</span>{' '}
              <span className="font-mono text-slate-950">{receiptPreview.fiscalSafe || '-'}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setAdvancedOpen((value) => !value)}
          aria-expanded={advancedOpen}
          className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100"
        >
          {tOr(t, 'products.advanced', 'Advanced')}
        </button>

        {advancedOpen && canEditDisplayName ? (
          <div className="border-t border-slate-200 pt-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.edit.displayNames', 'Display names')}
              </h4>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-slate-600">
                  {tOr(t, 'products.edit.displayNameVi', 'Vietnamese')}
                </span>
                <input
                  value={displayNames.vi}
                  onChange={(event) => setDisplayNames((current) => ({ ...current, vi: event.target.value }))}
                  placeholder={name.trim() || baselineProduct.name}
                  maxLength={255}
                  className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-slate-600">
                  {tOr(t, 'products.edit.displayNameEn', 'English (optional)')}
                </span>
                <input
                  value={displayNames.en}
                  onChange={(event) => setDisplayNames((current) => ({ ...current, en: event.target.value }))}
                  placeholder={name.trim() || baselineProduct.name}
                  maxLength={255}
                  className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
                />
              </label>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {advancedOpen ? (
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {sellBy === 'WEIGHT'
                  ? tOr(t, 'products.drawer.priceNetPerKg', 'Net price / kg')
                  : tOr(t, 'products.drawer.priceNet', 'Net price')}
              </span>
              <input
                inputMode="decimal"
                value={priceNet}
                onChange={(event) => {
                  const next = event.target.value;
                  setPriceNet(next);
                  setPriceGross(grossFromNet(next, vatRate));
                }}
                className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
              />
            </label>
          ) : null}
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.drawer.vat', 'VAT')} %
            </span>
            <select
              value={vatRate}
              onChange={(event) => {
                const nextVat = event.target.value;
                setVatRate(nextVat);
                setPriceNet(netFromGross(priceGross, nextVat));
              }}
              className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500"
            >
              {vatRates.map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {sellBy === 'WEIGHT'
                ? tOr(t, 'products.drawer.priceGrossPerKg', 'Gross price / kg')
                : tOr(t, 'products.drawer.priceGross', 'Gross price')}
            </span>
            <input
              inputMode="decimal"
              value={priceGross}
              onChange={(event) => {
                const next = event.target.value;
                setPriceGross(next);
                setPriceNet(netFromGross(next, vatRate));
              }}
              className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
            />
          </label>
          {canViewPurchasePrice ? (
            <div>
              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                  {tOr(t, 'products.purchase.price', 'Purchase price')}
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={purchasePrice}
                  onChange={(event) => setPurchasePrice(sanitizeDecimalText(event.target.value))}
                  disabled={!purchasePriceLoaded || purchasePriceLoading}
                  placeholder={purchasePriceLoading
                    ? tOr(t, 'products.purchase.loading', 'Loading...')
                    : tOr(t, 'products.purchase.notSet', 'Not set')}
                  className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500 disabled:bg-slate-100 disabled:text-slate-500"
                />
              </label>
              {purchasePriceLoading ? (
                <div role="status" className="mt-2 text-xs text-slate-500">
                  {tOr(t, 'products.purchase.loadingHint', 'Loading protected purchase price...')}
                </div>
              ) : purchasePriceError ? (
                <div role="alert" className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <div>{tOr(t, 'products.purchase.unavailable', 'Purchase price is unavailable and will not be changed.')}</div>
                  <button
                    type="button"
                    onClick={onReloadAdminDetail}
                    className="mt-2 h-11 rounded-md border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100"
                  >
                    {tOr(t, 'common.retry', 'Retry')}
                  </button>
                </div>
              ) : (
                <div className="mt-2 text-xs text-slate-500">
                  {tOr(t, 'products.purchase.defaultHint', 'Default cost for future receiving; it does not revalue existing stock.')}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className={`grid gap-3 ${advancedOpen ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.drawer.barcode', 'Barcode')}
            </span>
            <input
              value={barcode}
              onChange={(event) => setBarcode(event.target.value)}
              className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
            />
            {salonCode && isBarcodeTaken && !barcode.trim() ? (
              <button
                type="button"
                onClick={() => {
                  // Unique against the whole local catalog (incl. inactive);
                  // regenerates on collision, backend 409 stays the last net.
                  const generated = generateUniqueInternalEan(salonCode, isBarcodeTaken);
                  if (generated) {
                    setBarcode(generated);
                    setMessage(null);
                  } else {
                    setMessage({ ok: false, text: tOr(t, 'products.barcode.generateFailed', 'Could not generate a unique code — try again.') });
                  }
                }}
                className="mt-2 inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100"
              >
                {tOr(t, 'products.barcode.generate', 'Generate internal code')}
              </button>
            ) : null}
          </label>
          {advancedOpen ? (
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.drawer.sku', 'SKU')}
              </span>
              <input
                value={sku}
                onChange={(event) => setSku(event.target.value)}
                className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
              />
            </label>
          ) : null}
        </div>

        <div className={`grid gap-3 ${itemPolicy.sellBySelectable ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.drawer.category', 'Category')}
            </span>
            <div className="flex gap-2">
              <select
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
                className="h-11 min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500"
              >
                <option value="">{tOr(t, 'products.uncategorised', 'Uncategorised')}</option>
                {sortedCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {resolveName(category, language)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={onManageCategories}
                disabled={!canManageCategories}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                title={tOr(t, 'products.category.manage', 'Categories')}
              >
                <Tags size={17} />
              </button>
            </div>
          </label>
          {itemPolicy.sellBySelectable ? (
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.drawer.sellBy', 'Price by')}
              </span>
              <select
                value={sellBy}
                disabled
                className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500"
              >
                <option value="PIECE">{tOr(t, 'products.drawer.sellByPiece', 'Quantity')}</option>
                <option value="WEIGHT">{tOr(t, 'products.drawer.sellByWeight', 'Weight (kg)')}</option>
              </select>
              <span className="mt-2 block text-xs text-slate-500">
                {tOr(
                  t,
                  'products.edit.inventoryModeLocked',
                  'Quantity/weight mode is locked for existing products. Create a new product to use a different mode.',
                )}
              </span>
            </label>
          ) : null}
        </div>

        <div className={`grid gap-3 ${advancedOpen ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {advancedOpen ? (
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.drawer.saleUnit', 'Receipt unit')}
              </span>
              <input
                value={saleUnit}
                onChange={(event) => setSaleUnit(event.target.value)}
                className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
              />
            </label>
          ) : null}
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {itemType === 'service'
              ? tOr(t, 'products.itemType.serviceSaleHint', 'Each add to an order counts as one service.')
              : itemType === 'consumable'
                ? tOr(t, 'products.itemType.consumableSaleHint', 'POS calculates the sold quantity but does not deduct stock.')
                : sellBy === 'WEIGHT'
                  ? tOr(t, 'products.drawer.weightHint', 'POS will read the scale and multiply kg by the price per kg.')
                  : tOr(t, 'products.drawer.pieceHint', 'POS calculates the price from the quantity sold.')}
          </div>
        </div>

        {supportsItemType ? (
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.itemType.label', 'Item kind')}
            </span>
            <select
              value={itemType}
              onChange={(event) => changeItemType(event.target.value)}
              className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500"
            >
              <option value="stockable" disabled={!canChangeExistingProductItemType(stockTracked, originalSellBy, 'stockable', canChangeInventoryMode)}>{tOr(t, 'products.itemType.stockable', 'Stocked goods')}</option>
              <option value="service" disabled={!canChangeExistingProductItemType(stockTracked, originalSellBy, 'service', canChangeInventoryMode)}>{tOr(t, 'products.itemType.service', 'Service')}</option>
              <option value="consumable" disabled={!canChangeExistingProductItemType(stockTracked, originalSellBy, 'consumable', canChangeInventoryMode)}>{tOr(t, 'products.itemType.consumable', 'Consumable (not counted)')}</option>
            </select>
            {stockTracked ? (
              <span className="mt-2 block text-xs text-slate-500">
                {canChangeInventoryMode
                  ? tOr(
                    t,
                    'products.edit.inventoryTrackingZeroRequired',
                    'Stock must be zero before changing an existing product to a service or non-tracked consumable.',
                  )
                  : tOr(
                    t,
                    'products.edit.inventoryTrackingUnavailable',
                    'The connected server does not support changing inventory tracking for existing products.',
                  )}
              </span>
            ) : null}
            {itemType !== 'stockable' ? (
              <span className="mt-2 block text-xs text-slate-500">
                {itemType === 'service'
                  ? tOr(t, 'products.itemType.serviceHint', 'Fees or work sold without inventory tracking.')
                  : tOr(t, 'products.itemType.consumableHint', 'Physical goods sold without inventory deductions.')}
              </span>
            ) : null}
          </label>
        ) : null}

        {supportsItemType && itemType === 'stockable' ? (
          <label className="flex min-h-11 items-center gap-3 rounded-md border border-slate-300 bg-white px-3 py-2">
            <input
              type="checkbox"
              checked={trackInventory}
              onChange={(event) => setTrackInventory(event.target.checked)}
              disabled={!canChangeInventoryMode}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:cursor-not-allowed"
            />
            <span className="text-sm font-semibold text-slate-800">
              {tOr(t, 'products.edit.trackInventory', 'Track inventory')}
            </span>
          </label>
        ) : null}

        {stockEditable ? (
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {sellBy === 'WEIGHT'
                ? tOr(t, 'products.edit.stockKg', 'Actual stock (kg)')
                : tOr(t, 'products.edit.stockPieces', 'Actual stock (pcs)')}
            </span>
            <input
              inputMode={sellBy === 'WEIGHT' ? 'decimal' : 'numeric'}
              value={stockQty}
              onChange={(event) => setStockQty(event.target.value)}
              step={sellBy === 'WEIGHT' ? '0.001' : '1'}
              className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
            />
          </label>
        ) : null}

        <ProductImageField
          imageUrl={imageUrl}
          pendingImage={pendingImage}
          supportsUpload={canReplaceMainImage}
          showUrlError={imageUrlDirty}
          disabled={mutationLocked}
          t={t}
          onImageUrlChange={setImageUrl}
          onPendingImageChange={setPendingImage}
        />

        {message ? (
          <div className={`rounded-md border px-3 py-2 text-sm ${
            message.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}>
            {message.text}
          </div>
        ) : null}
      </fieldset>

      <footer className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
        <button
          type="button"
          onClick={handleCancel}
          disabled={navigationState.cancelDisabled}
          className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {tOr(t, 'products.edit.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy || (!dirty && !stockAttemptDispatched)}
          className="h-11 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy
            ? tOr(t, 'products.edit.saving', 'Saving...')
            : stockAttemptDispatched
              ? tOr(t, 'products.mutation.retry', 'Retry exact request')
              : tOr(t, 'products.edit.save', 'Save')}
        </button>
      </footer>
    </section>
    {pendingCancelConfirm && (
      <ConfirmActionDialog
        open
        tier="light"
        title={tOr(t, 'common.confirmTitle', 'Please confirm')}
        body={tOr(t, 'products.edit.discardConfirm', 'Discard unsaved changes?')}
        confirmLabel={tOr(t, 'common.confirm', 'Confirm')}
        cancelLabel={tOr(t, 'common.cancel', 'Cancel')}
        danger
        busy={mutationLocked}
        onConfirm={() => {
          if (mutationLocked) return;
          setPendingCancelConfirm(false);
          onCancel();
        }}
        onCancel={() => {
          if (mutationLocked) return;
          setPendingCancelConfirm(false);
        }}
      />
    )}
    </>
  );
}
