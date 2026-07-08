import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Tags } from 'lucide-react';
import { diffNameTranslations, parseTranslations, resolveName } from '../../../shared/catalog-names';
import { classifyProductSale } from '../../../shared/product-sale-classifier';
import { normalizeSellBy } from '../../../shared/pos-sale';
import type { ProductAdminStockAdjustmentInput, ProductAdminUpdateVariantInput } from '../../../shared/types';
import type { Category } from '../../hooks/usePosDb';
import type { ProductListItem } from '../../hooks/useProducts';
import { grossFromNet, netFromGross, parsePriceNumber } from './price-vat';
import ConfirmActionDialog from '../pos/ConfirmActionDialog';
import { createStableMutationKeyStore } from './mutation-idempotency';
import { useProductVatRates } from './product-vat-rates';
import { executeProductSave } from './save-product-changes';

interface ProductEditFormProps {
  product: ProductListItem;
  categories: Category[];
  language: string;
  t: (key: string) => string;
  canManageCategories: boolean;
  canAdjustStock: boolean;
  canEditDisplayName: boolean;
  displayNameAffectsMultipleVariants: boolean;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onManageCategories: () => void;
  onProductChanged: () => Promise<void> | void;
  onSaved: (outcome: { stockBefore?: number; stockAfter?: number }) => Promise<void> | void;
}

const DISPLAY_NAME_LOCALES = ['vi', 'pl', 'en'] as const;

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function moneyInputFromGrosze(value: number | null | undefined): string {
  return ((Number(value) || 0) / 100).toFixed(2);
}

function parseMoneyToGrosze(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
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
  return Number(product.available_qty ?? product.in_stock ?? 0) || 0;
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

export default function ProductEditForm({
  product,
  categories,
  language,
  t,
  canManageCategories,
  canAdjustStock,
  canEditDisplayName,
  displayNameAffectsMultipleVariants,
  onCancel,
  onDirtyChange,
  onManageCategories,
  onProductChanged,
  onSaved,
}: ProductEditFormProps) {
  const originalSellBy = productSellBy(product);
  const originalVatRate = vatRateFromProduct(product);
  const [name, setName] = useState(product.name || '');
  const [priceGross, setPriceGross] = useState(moneyInputFromGrosze(product.retail_price));
  const [vatRate, setVatRate] = useState(String(originalVatRate));
  const [priceNet, setPriceNet] = useState(
    netFromGross(moneyInputFromGrosze(product.retail_price), String(originalVatRate)),
  );
  const [barcode, setBarcode] = useState(product.barcode || '');
  const [sku, setSku] = useState(product.sku || '');
  const [categoryId, setCategoryId] = useState(product.category_id || '');
  const [sellBy, setSellBy] = useState<'PIECE' | 'WEIGHT'>(productSellBy(product));
  const [saleUnit, setSaleUnit] = useState(product.sale_unit || '');
  const [stockQty, setStockQty] = useState(stockInputFromProduct(product));
  const [imageUrl, setImageUrl] = useState(product.image_url || '');
  const [displayNames, setDisplayNames] = useState<Record<string, string>>(() => displayNamesFromProduct(product));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [stockResetNotice, setStockResetNotice] = useState(false);
  const [pendingCancelConfirm, setPendingCancelConfirm] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const stockMutationKeyStore = useRef(createStableMutationKeyStore());
  const vatRates = useProductVatRates(originalVatRate);

  useEffect(() => {
    setName(product.name || '');
    setPriceGross(moneyInputFromGrosze(product.retail_price));
    setVatRate(String(originalVatRate));
    setPriceNet(
      netFromGross(moneyInputFromGrosze(product.retail_price), String(originalVatRate)),
    );
    setBarcode(product.barcode || '');
    setSku(product.sku || '');
    setCategoryId(product.category_id || '');
    setSellBy(originalSellBy);
    setSaleUnit(product.sale_unit || '');
    setStockQty(stockInputFromProduct(product));
    setImageUrl(product.image_url || '');
    setDisplayNames(displayNamesFromProduct(product));
    setBusy(false);
    setMessage(null);
    setStockResetNotice(false);
    setAdvancedOpen(false);
    stockMutationKeyStore.current.clear();
  }, [product.id]);

  const sortedCategories = useMemo(() => {
    return [...categories].sort((a, b) =>
      resolveName(a, language).localeCompare(resolveName(b, language)),
    );
  }, [categories, language]);

  const originalDisplayNames = useMemo(
    () => displayNamesFromProduct(product),
    [product.id, product.name_translations],
  );
  const nameTranslationsPatch = useMemo(
    () => canEditDisplayName
      ? diffNameTranslations(originalDisplayNames, displayNames, DISPLAY_NAME_LOCALES)
      : {},
    [canEditDisplayName, displayNames, originalDisplayNames],
  );
  const translationsDirty = Object.keys(nameTranslationsPatch).length > 0;

  const variantFieldsDirty = useMemo(() => (
    name !== (product.name || '')
    || priceGross !== moneyInputFromGrosze(product.retail_price)
    || vatRate !== String(originalVatRate)
    || barcode !== (product.barcode || '')
    || sku !== (product.sku || '')
    || categoryId !== (product.category_id || '')
    || sellBy !== originalSellBy
    || saleUnit !== (product.sale_unit || '')
    || imageUrl !== (product.image_url || '')
  ), [barcode, categoryId, imageUrl, name, originalSellBy, priceGross, product, saleUnit, sellBy, sku, vatRate]);

  const productDirty = variantFieldsDirty || translationsDirty;
  const stockDirty = canAdjustStock && stockQty !== stockInputFromProduct(product);
  const dirty = productDirty || stockDirty;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const validate = (): string | null => {
    if (!name.trim()) return tOr(t, 'products.edit.nameRequired', 'Enter product name');
    if (parseMoneyToGrosze(priceGross) === null) return tOr(t, 'products.edit.priceInvalid', 'Enter a valid price');
    const vat = Number(vatRate);
    if (!vatRates.includes(vat)) return tOr(t, 'products.edit.vatInvalid', 'Select a valid VAT rate');
    if (canAdjustStock && parseStockQuantity(stockQty, sellBy) === null) {
      return sellBy === 'WEIGHT'
        ? tOr(t, 'products.create.stockWeightPrecision', 'Enter kg stock with up to 3 decimal places')
        : tOr(t, 'products.create.stockPieceInvalid', 'Piece stock must be a whole number');
    }
    return null;
  };

  const handleSave = async () => {
    const validationError = validate();
    if (validationError) {
      setMessage({ ok: false, text: validationError });
      return;
    }

    const priceGrossGrosze = parseMoneyToGrosze(priceGross);
    if (priceGrossGrosze === null) return;
    const parsedStockQty = canAdjustStock ? parseStockQuantity(stockQty, sellBy) : null;
    if (canAdjustStock && parsedStockQty === null) return;

    const payload: ProductAdminUpdateVariantInput = {
      expectedUpdatedAt: product.updated_at || undefined,
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
        sellBy,
        imageUrl: imageUrl.trim() || null,
        isActive: product.is_active !== 0,
      });
    }
    if (translationsDirty && canEditDisplayName) {
      payload.nameTranslations = nameTranslationsPatch;
    }

    setBusy(true);
    setMessage(null);
    try {
      const stockIntent = JSON.stringify({
        productId: product.id,
        mode: 'recount',
        newQuantity: parsedStockQty ?? 0,
      });
      const result = await executeProductSave({
        productDirty,
        stockDirty,
        expectedUpdatedAt: product.updated_at || undefined,
        updateProduct: () => window.electronAPI.pos.productAdmin.updateVariant(product.id, payload),
        adjustStock: (expectedUpdatedAt) => {
          const stockPayload: ProductAdminStockAdjustmentInput = {
            mode: 'recount',
            newQuantity: parsedStockQty ?? 0,
            expectedUpdatedAt,
            idempotencyKey: stockMutationKeyStore.current.get(stockIntent),
          };
          return window.electronAPI.pos.productAdmin.adjustStock(product.id, stockPayload);
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
        if (result.productSaved) await onProductChanged();
        const failure = result.error || tOr(t, 'products.stock.failed', 'Could not adjust stock');
        setMessage({
          ok: false,
          text: result.productSaved
            ? `${tOr(t, 'products.edit.stockFailed', 'Product saved, but stock could not be updated')}: ${failure}`
            : failure,
        });
        return;
      }

      if (stockDirty) stockMutationKeyStore.current.clear();
      setMessage({ ok: true, text: tOr(t, 'products.edit.success', 'Product saved') });
      await onSaved({
        stockBefore: stockDirty ? currentStock(product) : undefined,
        stockAfter: stockDirty ? parsedStockQty ?? 0 : undefined,
      });
      onDirtyChange?.(false);
      onCancel();
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message || tOr(t, 'products.edit.failed', 'Could not save product') });
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = () => {
    if (dirty) {
      setPendingCancelConfirm(true);
      return;
    }
    onCancel();
  };

  const changeSellBy = (value: string) => {
    const nextSellBy = normalizeSellBy(value);
    setSellBy(nextSellBy);
    if (nextSellBy === originalSellBy) {
      setSaleUnit(product.sale_unit || (nextSellBy === 'WEIGHT' ? 'kg' : 'szt'));
      setStockQty(stockInputFromProduct(product));
      setStockResetNotice(false);
      return;
    }
    setSaleUnit(nextSellBy === 'WEIGHT' ? 'kg' : 'szt');
    setStockQty('0');
    setStockResetNotice(true);
  };

  return (
    <>
    <section className="mt-5 rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-950">{tOr(t, 'products.edit.title', 'Edit product')}</h3>
      </div>
      <div className="space-y-4 p-4">
        <label className="block">
          <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
            {tOr(t, 'products.drawer.canonicalName', 'Canonical name')}
          </span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
          />
        </label>

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
              {displayNameAffectsMultipleVariants ? (
                <span className="text-xs font-medium text-amber-700">
                  {tOr(t, 'products.edit.displayNameAllVariants', 'Applies to all variants of this product')}
                </span>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-slate-600">
                  {tOr(t, 'products.edit.displayNameVi', 'Vietnamese')}
                </span>
                <input
                  value={displayNames.vi}
                  onChange={(event) => setDisplayNames((current) => ({ ...current, vi: event.target.value }))}
                  placeholder={name.trim() || product.name}
                  maxLength={255}
                  className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-slate-600">
                  {tOr(t, 'products.edit.displayNamePl', 'Polish')}
                </span>
                <input
                  value={displayNames.pl}
                  onChange={(event) => setDisplayNames((current) => ({ ...current, pl: event.target.value }))}
                  placeholder={name.trim() || product.name}
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
                  placeholder={name.trim() || product.name}
                  maxLength={255}
                  className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
                />
              </label>
            </div>
          </div>
        ) : null}

        <div className={`grid grid-cols-1 gap-3 ${advancedOpen ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
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
                if (parsePriceNumber(priceNet) !== null) {
                  setPriceGross(grossFromNet(priceNet, nextVat));
                } else {
                  setPriceNet(netFromGross(priceGross, nextVat));
                }
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

        <div className="grid grid-cols-2 gap-3">
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
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.drawer.sellBy', 'Sell by')}
            </span>
            <select
              value={sellBy}
              onChange={(event) => changeSellBy(event.target.value)}
              className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500"
            >
              <option value="PIECE">{tOr(t, 'products.drawer.sellByPiece', 'Piece')}</option>
              <option value="WEIGHT">{tOr(t, 'products.drawer.sellByWeight', 'Weight / kg')}</option>
            </select>
          </label>
        </div>

        <div className={`grid gap-3 ${advancedOpen ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {advancedOpen ? (
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.drawer.saleUnit', 'Sale unit')}
              </span>
              <input
                value={saleUnit}
                onChange={(event) => setSaleUnit(event.target.value)}
                className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
              />
            </label>
          ) : null}
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {sellBy === 'WEIGHT'
              ? tOr(t, 'products.drawer.weightHint', 'POS will read the scale and multiply kg by the price per kg.')
              : tOr(t, 'products.drawer.pieceHint', 'Normal products keep the existing piece-based flow.')}
          </div>
        </div>

        {canAdjustStock ? (
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {sellBy === 'WEIGHT'
                ? tOr(t, 'products.edit.stockKg', 'Actual stock (kg)')
                : tOr(t, 'products.edit.stockPieces', 'Actual stock (pcs)')}
            </span>
            <input
              inputMode="decimal"
              value={stockQty}
              onChange={(event) => setStockQty(event.target.value)}
              step={sellBy === 'WEIGHT' ? '0.001' : '1'}
              className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
            />
            {stockResetNotice ? (
              <span className="mt-2 block rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                {tOr(t, 'products.edit.stockResetNotice', 'Changing the sale unit clears current stock - re-enter the quantity in the new unit.')}
              </span>
            ) : null}
          </label>
        ) : null}

        {advancedOpen ? (
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.edit.imageUrl', 'Image URL')}
            </span>
            <input
              value={imageUrl}
              onChange={(event) => setImageUrl(event.target.value)}
              className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
            />
          </label>
        ) : null}

        {message ? (
          <div className={`rounded-md border px-3 py-2 text-sm ${
            message.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}>
            {message.text}
          </div>
        ) : null}
      </div>

      <footer className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
        <button
          type="button"
          onClick={handleCancel}
          className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100"
        >
          {tOr(t, 'products.edit.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy || !dirty}
          className="h-11 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? tOr(t, 'products.edit.saving', 'Saving...') : tOr(t, 'products.edit.save', 'Save')}
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
        onConfirm={() => {
          setPendingCancelConfirm(false);
          onCancel();
        }}
        onCancel={() => setPendingCancelConfirm(false)}
      />
    )}
    </>
  );
}
