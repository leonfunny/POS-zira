import React, { useEffect, useMemo, useState } from 'react';
import { Tags } from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import { classifyProductSale } from '../../../shared/product-sale-classifier';
import { normalizeSellBy } from '../../../shared/pos-sale';
import type { ProductAdminStockAdjustmentInput, ProductAdminUpdateVariantInput } from '../../../shared/types';
import type { Category } from '../../hooks/usePosDb';
import type { ProductListItem } from '../../hooks/useProducts';

interface ProductEditFormProps {
  product: ProductListItem;
  categories: Category[];
  language: string;
  t: (key: string) => string;
  canManageCategories: boolean;
  canAdjustStock: boolean;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onManageCategories: () => void;
  onSaved: () => Promise<void> | void;
}

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

function makeIdempotencyKey(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  return `product-stock-recount-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function looksLikeFreshScaleCategory(category: Category | undefined): boolean {
  const raw = `${category?.name || ''} ${category?.name_translations || ''}`.toLowerCase();
  return /\bscale\b|\bfresh\b|tươi|tuoi|đồ tươi|do tuoi/.test(raw);
}

function productSellBy(product: ProductListItem): 'PIECE' | 'WEIGHT' {
  return classifyProductSale(product).sellBy;
}

export default function ProductEditForm({
  product,
  categories,
  language,
  t,
  canManageCategories,
  canAdjustStock,
  onCancel,
  onDirtyChange,
  onManageCategories,
  onSaved,
}: ProductEditFormProps) {
  const [name, setName] = useState(product.name || '');
  const [priceGross, setPriceGross] = useState(moneyInputFromGrosze(product.retail_price));
  const [vatRate, setVatRate] = useState(String(Number(product.vat_rate) || 23));
  const [barcode, setBarcode] = useState(product.barcode || '');
  const [sku, setSku] = useState(product.sku || '');
  const [categoryId, setCategoryId] = useState(product.category_id || '');
  const [sellBy, setSellBy] = useState<'PIECE' | 'WEIGHT'>(productSellBy(product));
  const [saleUnit, setSaleUnit] = useState(product.sale_unit || '');
  const [stockQty, setStockQty] = useState(stockInputFromProduct(product));
  const [imageUrl, setImageUrl] = useState(product.image_url || '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setName(product.name || '');
    setPriceGross(moneyInputFromGrosze(product.retail_price));
    setVatRate(String(Number(product.vat_rate) || 23));
    setBarcode(product.barcode || '');
    setSku(product.sku || '');
    setCategoryId(product.category_id || '');
    setSellBy(productSellBy(product));
    setSaleUnit(product.sale_unit || '');
    setStockQty(stockInputFromProduct(product));
    setImageUrl(product.image_url || '');
    setBusy(false);
    setMessage(null);
  }, [product.id]);

  const sortedCategories = useMemo(() => {
    return [...categories].sort((a, b) =>
      resolveName(a, language).localeCompare(resolveName(b, language)),
    );
  }, [categories, language]);

  const productDirty = useMemo(() => (
    name !== (product.name || '')
    || priceGross !== moneyInputFromGrosze(product.retail_price)
    || vatRate !== String(Number(product.vat_rate) || 23)
    || barcode !== (product.barcode || '')
    || sku !== (product.sku || '')
    || categoryId !== (product.category_id || '')
    || sellBy !== productSellBy(product)
    || saleUnit !== (product.sale_unit || '')
    || imageUrl !== (product.image_url || '')
  ), [barcode, categoryId, imageUrl, name, priceGross, product, saleUnit, sellBy, sku, vatRate]);

  const stockDirty = canAdjustStock && stockQty !== stockInputFromProduct(product);
  const dirty = productDirty || stockDirty;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const validate = (): string | null => {
    if (!name.trim()) return tOr(t, 'products.edit.nameRequired', 'Enter product name');
    if (parseMoneyToGrosze(priceGross) === null) return tOr(t, 'products.edit.priceInvalid', 'Enter a valid price');
    const vat = Number(vatRate);
    if (!Number.isFinite(vat) || vat < 0) return tOr(t, 'products.edit.vatInvalid', 'Enter a valid VAT rate');
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
      name: name.trim(),
      barcode: barcode.trim() || null,
      sku: sku.trim() || null,
      priceGrossGrosze,
      vatRate: Number(vatRate),
      categoryId: categoryId || null,
      saleUnit: saleUnit.trim() || null,
      imageUrl: imageUrl.trim() || null,
      isActive: product.is_active !== 0,
      expectedUpdatedAt: product.updated_at || undefined,
    };

    setBusy(true);
    setMessage(null);
    try {
      let expectedUpdatedAtForStock = product.updated_at || undefined;
      let savedProductFields = false;

      if (productDirty) {
        const result = await window.electronAPI.pos.productAdmin.updateVariant(product.id, payload);
        if (!result?.ok) {
          setMessage({
            ok: false,
            text: result?.error || result?.code || tOr(t, 'products.edit.failed', 'Could not save product'),
          });
          return;
        }
        expectedUpdatedAtForStock = result.data?.variant?.updatedAt || expectedUpdatedAtForStock;
        savedProductFields = true;
      }

      if (stockDirty) {
        const stockPayload: ProductAdminStockAdjustmentInput = {
          mode: 'recount',
          newQuantity: parsedStockQty ?? 0,
          expectedUpdatedAt: expectedUpdatedAtForStock,
          idempotencyKey: makeIdempotencyKey(),
        };
        const stockResult = await window.electronAPI.pos.productAdmin.adjustStock(product.id, stockPayload);
        if (!stockResult?.ok) {
          const failure = stockResult?.error || stockResult?.code || tOr(t, 'products.stock.failed', 'Could not adjust stock');
          setMessage({
            ok: false,
            text: savedProductFields
              ? `${tOr(t, 'products.edit.stockFailed', 'Product saved, but stock could not be updated')}: ${failure}`
              : failure,
          });
          return;
        }
      }

      setMessage({ ok: true, text: tOr(t, 'products.edit.success', 'Product saved') });
      await onSaved();
      onDirtyChange?.(false);
      onCancel();
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message || tOr(t, 'products.edit.failed', 'Could not save product') });
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = () => {
    if (dirty && !window.confirm(tOr(t, 'products.edit.discardConfirm', 'Discard unsaved changes?'))) return;
    onCancel();
  };

  return (
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

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {sellBy === 'WEIGHT'
                ? tOr(t, 'products.drawer.priceGrossPerKg', 'Gross price per kg')
                : tOr(t, 'products.drawer.priceGross', 'Gross price')}
            </span>
            <input
              inputMode="decimal"
              value={priceGross}
              onChange={(event) => setPriceGross(event.target.value)}
              className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.drawer.vat', 'VAT')}
            </span>
            <input
              type="number"
              min="0"
              step="1"
              value={vatRate}
              onChange={(event) => setVatRate(event.target.value)}
              className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
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
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.drawer.category', 'Category')}
            </span>
            <div className="flex gap-2">
              <select
                value={categoryId}
                onChange={(event) => {
                  const nextCategoryId = event.target.value;
                  setCategoryId(nextCategoryId);
                  const nextCategory = categories.find((category) => category.id === nextCategoryId);
                  if (looksLikeFreshScaleCategory(nextCategory)) {
                    setSellBy('WEIGHT');
                    setSaleUnit('kg');
                  }
                }}
                className="h-11 min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500"
              >
                <option value="">{tOr(t, 'products.allCategories', 'All categories')}</option>
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
              onChange={(event) => {
                const nextSellBy = normalizeSellBy(event.target.value);
                setSellBy(nextSellBy);
                if (nextSellBy === 'WEIGHT') setSaleUnit('kg');
                if (nextSellBy === 'PIECE' && (!saleUnit.trim() || saleUnit.trim().toLowerCase() === 'kg')) {
                  setSaleUnit('szt');
                }
                if (nextSellBy === 'PIECE' && stockQty.includes('.')) {
                  setStockQty(String(Math.floor(Number(stockQty) || 0)));
                }
              }}
              className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500"
            >
              <option value="PIECE">{tOr(t, 'products.drawer.sellByPiece', 'Piece')}</option>
              <option value="WEIGHT">{tOr(t, 'products.drawer.sellByWeight', 'Weight / kg')}</option>
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
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
          </label>
        ) : null}

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
          disabled={busy}
          className="h-11 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? tOr(t, 'products.edit.saving', 'Saving...') : tOr(t, 'products.edit.save', 'Save')}
        </button>
      </footer>
    </section>
  );
}
