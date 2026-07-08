import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveName } from '../../../shared/catalog-names';
import type { ProductAdminCreateProductInput, ProductAdminVariant } from '../../../shared/types';
import type { Category } from '../../hooks/usePosDb';
import type { ProductListItem } from '../../hooks/useProducts';
import ConfirmActionDialog from '../pos/ConfirmActionDialog';
import Modal from '../shared/Modal';
import { grossFromNet, netFromGross, parsePriceNumber } from './price-vat';
import { useProductVatRates } from './product-vat-rates';
import { findDuplicateBarcodeSet } from './scan-match';

interface ProductCreateDialogProps {
  open: boolean;
  categories: Category[];
  products: ProductListItem[];
  language: string;
  t: (key: string) => string;
  initialCategoryId?: string | null;
  initialBarcode?: string;
  onClose: () => void;
  onCreated: (variant: ProductAdminVariant) => Promise<void> | void;
}

type SellByMode = 'PIECE' | 'WEIGHT';

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function parseMoneyToGrosze(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const grosze = Math.round(parsed * 100);
  if (grosze < 1) return null;
  return grosze;
}

function decimalPlaces(value: string): number {
  const [, fraction = ''] = value.split('.');
  return fraction.length;
}

function parseStockQuantity(value: string, sellBy: SellByMode): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return 0;
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (sellBy === 'PIECE') {
    return Number.isInteger(parsed) ? parsed : null;
  }
  if (decimalPlaces(normalized) > 3) return null;
  return Math.round(parsed * 1000) / 1000;
}

function makeIdempotencyKey(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  return `product-create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createDuplicateMessage(code: string | null | undefined, t: (key: string) => string): string | null {
  const normalized = String(code || '').toUpperCase();
  if (normalized === 'DUPLICATE_SKU') return tOr(t, 'products.create.duplicateSku', 'SKU already exists');
  if (normalized === 'DUPLICATE_BARCODE' || normalized === 'DUPLICATE_PRODUCT') {
    return tOr(t, 'products.create.duplicateBarcode', 'Barcode already exists');
  }
  return null;
}

export default function ProductCreateDialog({
  open,
  categories,
  products,
  language,
  t,
  initialCategoryId,
  initialBarcode,
  onClose,
  onCreated,
}: ProductCreateDialogProps) {
  const barcodeInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState('');
  const [sku, setSku] = useState('');
  const [priceGross, setPriceGross] = useState('');
  const [priceNet, setPriceNet] = useState('');
  const [vatRate, setVatRate] = useState('23');
  const [categoryId, setCategoryId] = useState('');
  const [sellBy, setSellBy] = useState<SellByMode>('PIECE');
  const [saleUnit, setSaleUnit] = useState('szt');
  const [stockQty, setStockQty] = useState('0');
  const [imageUrl, setImageUrl] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCloseConfirm, setPendingCloseConfirm] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const vatRates = useProductVatRates();

  useEffect(() => {
    if (!open) return;
    setName('');
    setBarcode(initialBarcode ?? '');
    setSku('');
    setPriceGross('');
    setPriceNet('');
    setVatRate('23');
    setCategoryId(initialCategoryId ?? '');
    setSellBy('PIECE');
    setSaleUnit('szt');
    setStockQty('0');
    setImageUrl('');
    setIdempotencyKey(makeIdempotencyKey());
    setBusy(false);
    setError(null);
    setPendingCloseConfirm(false);
    setAdvancedOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setVatRate((current) => (vatRates.includes(Number(current)) ? current : String(vatRates[0] ?? 23)));
  }, [open, vatRates]);

  const sortedCategories = useMemo(() => {
    return [...categories].sort((a, b) =>
      resolveName(a, language).localeCompare(resolveName(b, language)),
    );
  }, [categories, language]);

  const activeProducts = useMemo(
    () => products.filter((product) => !product._isDraft),
    [products],
  );

  const getDuplicateBarcodeMessage = useCallback((rawBarcode: string): string | null => {
    const normalizedBarcode = rawBarcode.trim();
    if (!normalizedBarcode) return null;
    const duplicateProducts = findDuplicateBarcodeSet(normalizedBarcode, activeProducts);
    if (duplicateProducts.length === 0) return null;
    const firstDuplicate = duplicateProducts[0];
    const duplicateName = resolveName(firstDuplicate, language) || firstDuplicate.name || normalizedBarcode;
    return `${tOr(t, 'products.create.duplicateBarcode', 'Barcode already exists')}: ${duplicateName}`;
  }, [activeProducts, language, t]);

  const applyBarcodeScan = useCallback((rawBarcode: string) => {
    const normalizedScan = rawBarcode.trim();
    setBarcode(normalizedScan);
    const duplicateMessage = getDuplicateBarcodeMessage(normalizedScan);
    setError(duplicateMessage);
  }, [getDuplicateBarcodeMessage]);

  useEffect(() => {
    if (!open) return undefined;
    const unsubscribe = window.electronAPI.onBarcodeScanned((scannedBarcode: string) => {
      applyBarcodeScan(scannedBarcode);
      barcodeInputRef.current?.focus();
    });
    return () => unsubscribe?.();
  }, [open, applyBarcodeScan]);

  const changeSellBy = (nextSellBy: SellByMode) => {
    setSellBy(nextSellBy);
    setSaleUnit((current) => {
      const normalized = current.trim().toLowerCase();
      if (nextSellBy === 'WEIGHT') return 'kg';
      return !normalized || normalized === 'kg' ? 'szt' : current;
    });
    if (nextSellBy === 'WEIGHT' && stockQty === '1') setStockQty('0');
    if (nextSellBy === 'PIECE' && stockQty.includes('.')) setStockQty(String(Math.floor(Number(stockQty) || 0)));
  };

  const validate = (): { priceGrossGrosze: number; initialStockQty: number } | string => {
    if (!name.trim()) return tOr(t, 'products.create.nameRequired', 'Enter product name');
    const priceGrossGrosze = parseMoneyToGrosze(priceGross);
    if (priceGrossGrosze === null) return tOr(t, 'products.edit.priceInvalid', 'Enter a valid price');
    const vat = Number(vatRate);
    if (!vatRates.includes(vat)) return tOr(t, 'products.edit.vatInvalid', 'Select a valid VAT rate');

    const initialStockQty = parseStockQuantity(stockQty, sellBy);
    if (initialStockQty === null) {
      return sellBy === 'WEIGHT'
        ? tOr(t, 'products.create.stockWeightPrecision', 'Enter kg stock with up to 3 decimal places')
        : tOr(t, 'products.create.stockPieceInvalid', 'Piece stock must be a whole number');
    }

    return { priceGrossGrosze, initialStockQty };
  };

  const handleSubmit = async () => {
    const validation = validate();
    if (typeof validation === 'string') {
      setError(validation);
      return;
    }

    const normalizedBarcode = barcode.trim();
    if (normalizedBarcode) {
      const duplicateMessage = getDuplicateBarcodeMessage(normalizedBarcode);
      if (duplicateMessage) {
        setError(duplicateMessage);
        return;
      }
    }

    const normalizedSku = sku.trim();
    if (normalizedSku) {
      const duplicateSku = activeProducts.find((product) => product.sku?.trim() === normalizedSku);
      if (duplicateSku) {
        const duplicateName = resolveName(duplicateSku, language) || duplicateSku.name || normalizedSku;
        setError(`${tOr(t, 'products.create.duplicateSku', 'SKU already exists')}: ${duplicateName}`);
        return;
      }
    }

    const unit = saleUnit.trim() || (sellBy === 'WEIGHT' ? 'kg' : 'szt');
    const payload: ProductAdminCreateProductInput = {
      name: name.trim(),
      barcode: normalizedBarcode || null,
      sku: normalizedSku || null,
      priceGrossGrosze: validation.priceGrossGrosze,
      vatRate: Number(vatRate),
      initialStockQty: validation.initialStockQty,
      categoryId: categoryId || null,
      saleUnit: unit,
      sellBy,
      imageUrl: imageUrl.trim() || null,
      idempotencyKey,
    };

    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.pos.productAdmin.createProduct(payload);
      if (!result?.ok || !result.data?.variant) {
        const duplicateMessage = createDuplicateMessage(result?.code, t);
        setError(duplicateMessage || result?.error || result?.code || tOr(t, 'products.create.failed', 'Could not create product'));
        return;
      }
      await onCreated(result.data.variant);
      onClose();
    } catch (err: any) {
      setError(err?.message || tOr(t, 'products.create.failed', 'Could not create product'));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const dirty = name !== ''
    || barcode !== (initialBarcode ?? '')
    || sku !== ''
    || priceGross !== ''
    || priceNet !== ''
    || vatRate !== String(vatRates[0] ?? 23)
    || categoryId !== (initialCategoryId ?? '')
    || sellBy !== 'PIECE'
    || saleUnit !== 'szt'
    || stockQty !== '0'
    || imageUrl !== '';

  const requestClose = () => {
    if (dirty) setPendingCloseConfirm(true);
    else onClose();
  };

  return (
    <>
      <Modal
        open
        size="full"
        title={tOr(t, 'products.create.title', 'Create product')}
        onClose={onClose}
        busy={busy}
        guardUnsaved={dirty}
        onGuardedClose={() => setPendingCloseConfirm(true)}
        panelClassName="sm:max-w-2xl"
        closeLabel={tOr(t, 'products.drawer.close', 'Close')}
        footer={(
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={requestClose}
              disabled={busy}
              className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              {tOr(t, 'products.edit.cancel', 'Cancel')}
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={busy || !idempotencyKey}
              className="h-11 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? tOr(t, 'products.create.creating', 'Creating...') : tOr(t, 'products.create.submit', 'Create product')}
            </button>
          </div>
        )}
      >
        <div className="space-y-4 p-5">
            <p className="mt-1 text-sm text-slate-500">
              {tOr(t, 'products.create.description', 'Add a product with its selling price, stock, and barcode.')}
            </p>
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.drawer.canonicalName', 'Canonical name')}
            </span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
              autoFocus
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

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.drawer.barcode', 'Barcode')}
              </span>
              <input
                ref={barcodeInputRef}
                value={barcode}
                onChange={(event) => applyBarcodeScan(event.target.value)}
                placeholder={tOr(t, 'products.create.barcodeOptional', 'Optional')}
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
                  placeholder={tOr(t, 'products.create.skuOptional', 'Optional')}
                  className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
                />
              </label>
            ) : null}
          </div>

          <div className={`grid grid-cols-1 gap-3 ${advancedOpen ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
            {advancedOpen ? (
              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                  {sellBy === 'WEIGHT'
                    ? tOr(t, 'products.drawer.priceNetPerKg', 'Net price / kg')
                    : tOr(t, 'products.drawer.priceNet', 'Net price')}
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={priceNet}
                  onChange={(event) => {
                    const next = event.target.value;
                    setPriceNet(next);
                    setPriceGross(grossFromNet(next, vatRate));
                  }}
                  placeholder="0.00"
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
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={priceGross}
                onChange={(event) => {
                  const next = event.target.value;
                  setPriceGross(next);
                  setPriceNet(netFromGross(next, vatRate));
                }}
                placeholder="0.00"
                className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.drawer.category', 'Category')}
              </span>
              <select
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
                className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500"
              >
                <option value="">{tOr(t, 'products.uncategorised', 'Uncategorised')}</option>
                {sortedCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {resolveName(category, language)}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.drawer.sellBy', 'Sell by')}
              </span>
              <div className="grid grid-cols-2 gap-2 rounded-md bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => changeSellBy('PIECE')}
                  className={`h-11 rounded-md text-sm font-semibold transition duration-150 motion-reduce:transition-none ${
                    sellBy === 'PIECE' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tOr(t, 'products.drawer.sellByPiece', 'Piece')}
                </button>
                <button
                  type="button"
                  onClick={() => changeSellBy('WEIGHT')}
                  className={`h-11 rounded-md text-sm font-semibold transition duration-150 motion-reduce:transition-none ${
                    sellBy === 'WEIGHT' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tOr(t, 'products.drawer.sellByWeight', 'Weight / kg')}
                </button>
              </div>
            </div>
          </div>

          <div className={`grid grid-cols-1 gap-3 ${advancedOpen ? 'md:grid-cols-2' : ''}`}>
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {sellBy === 'WEIGHT'
                  ? tOr(t, 'products.create.stockKg', 'Initial stock (kg)')
                  : tOr(t, 'products.create.stockPieces', 'Initial stock (pcs)')}
              </span>
              <input
                inputMode="decimal"
                value={stockQty}
                onChange={(event) => setStockQty(event.target.value)}
                step={sellBy === 'WEIGHT' ? '0.001' : '1'}
                className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
              />
            </label>
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
          </div>

          {advancedOpen ? (
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.edit.imageUrl', 'Image URL')}
              </span>
              <input
                value={imageUrl}
                onChange={(event) => setImageUrl(event.target.value)}
                placeholder={tOr(t, 'products.create.imageOptional', 'Optional')}
                className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
              />
            </label>
          ) : null}

          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {sellBy === 'WEIGHT'
              ? tOr(t, 'products.drawer.weightHint', 'POS will read the scale and multiply kg by the price per kg.')
              : tOr(t, 'products.drawer.pieceHint', 'Normal products keep the existing piece-based flow.')}
          </div>

          {error ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          ) : null}
        </div>
      </Modal>
      {pendingCloseConfirm ? (
        <ConfirmActionDialog
          open
          tier="light"
          title={tOr(t, 'common.confirmTitle', 'Please confirm')}
          body={tOr(t, 'products.edit.discardConfirm', 'Discard unsaved changes?')}
          confirmLabel={tOr(t, 'common.confirm', 'Confirm')}
          cancelLabel={tOr(t, 'common.cancel', 'Cancel')}
          danger
          onConfirm={() => {
            setPendingCloseConfirm(false);
            onClose();
          }}
          onCancel={() => setPendingCloseConfirm(false)}
        />
      ) : null}
    </>
  );
}
