import React, { useEffect, useRef, useState } from 'react';
import { Package, ScanBarcode } from 'lucide-react';
import type { ProductListItem } from '../../hooks/useProducts';
import Modal from '../shared/Modal';

interface ProductAddFlowProps {
  open: boolean;
  initialBarcode?: string;
  language: string;
  t: (key: string) => string;
  onClose: () => void;
  onImported: () => Promise<void> | void;
  onOpenProduct: (product: ProductListItem) => void;
}

interface DraftPreview {
  id?: string;
  name: string;
  barcode: string;
  retail_price: number;
  in_stock: number;
  vat_rate: number;
  image_url: string | null;
  status?: string | null;
}

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function moneyToGrosze(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number.isInteger(n) && Math.abs(n) >= 100 ? n : Math.round(n * 100);
}

function draftPreviewFromLocal(draft: any, fallbackBarcode: string): DraftPreview | null {
  if (!draft) return null;
  return {
    id: draft.id,
    name: String(draft.name || fallbackBarcode),
    barcode: String(draft.barcode || fallbackBarcode),
    retail_price: Number(draft.retail_price) || 0,
    in_stock: Number(draft.in_stock) || 0,
    vat_rate: Number(draft.vat_rate) || 23,
    image_url: draft.image_url ?? null,
    status: draft.status ?? null,
  };
}

function draftPreviewFromLookup(response: any, fallbackBarcode: string): DraftPreview | null {
  const source = response?.draft ?? response?.product ?? response?.result ?? response?.existingProduct ?? response?.existing_product ?? null;
  if (!source) return null;
  const image = Array.isArray(source.images) ? source.images[0] : source.imageUrl ?? source.image_url ?? null;
  return {
    id: source.draftId ?? source.draft_id ?? source.id ?? source.variantId ?? source.variant_id,
    name: source.namePreferred ?? source.name ?? source.productName ?? source.product_name ?? source.title ?? fallbackBarcode,
    barcode: source.ean ?? source.barcode ?? fallbackBarcode,
    retail_price: moneyToGrosze(source.suggestedRetailPrice ?? source.retailPrice ?? source.retail_price),
    in_stock: Number(source.stockQty ?? source.stock_qty ?? source.currentStock ?? source.in_stock ?? 0) || 0,
    vat_rate: Number(source.taxRate ?? source.vat_rate ?? source.vatRate ?? 23) || 23,
    image_url: image ?? null,
    status: response?.mode ?? source.status ?? null,
  };
}

function saleUnitImpliesWeight(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'kg' || normalized === 'kilogram' || normalized === 'kilograms';
}

function variantToProduct(variant: any): ProductListItem {
  const saleUnit = variant.sale_unit ?? variant.saleUnit ?? null;
  return {
    id: variant.id,
    template_id: variant.template_id ?? null,
    name: variant.name ?? '',
    sku: variant.sku ?? null,
    barcode: variant.barcode ?? null,
    retail_price: Number(variant.retail_price) || 0,
    category_id: variant.category_id ?? null,
    image_url: variant.image_url ?? null,
    in_stock: Number(variant.in_stock) || 0,
    vat_rate: Number(variant.vat_rate) || 23,
    is_active: Number(variant.is_active ?? 1),
    updated_at: variant.updated_at ?? null,
    available_qty: Number(variant.available_qty ?? variant.in_stock) || 0,
    price_gross: Number(variant.price_gross) || undefined,
    price_net: Number(variant.price_net) || undefined,
    vat_amount: Number(variant.vat_amount) || undefined,
    is_on_sale: Number(variant.is_on_sale) || undefined,
    thumbnail_url: variant.thumbnail_url ?? null,
    sale_unit: saleUnit,
    sell_by: variant.sell_by ?? variant.sellBy ?? (saleUnitImpliesWeight(saleUnit) ? 'WEIGHT' : 'PIECE'),
    name_translations: variant.name_translations ?? null,
  };
}

export default function ProductAddFlow({
  open,
  initialBarcode,
  language: _language,
  t,
  onClose,
  onImported,
  onOpenProduct,
}: ProductAddFlowProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [barcode, setBarcode] = useState('');
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  const lookup = async (barcodeOverride?: string) => {
    const code = (barcodeOverride ?? barcode).trim();
    if (!code) {
      setError(tOr(t, 'products.add.missingBarcode', 'Enter or scan a barcode first'));
      return;
    }
    setLoading(true);
    setPreview(null);
    setMessage(null);
    setError(null);
    try {
      const existing = await window.electronAPI.pos.products.getByBarcode(code);
      if (existing) {
        onOpenProduct(variantToProduct(existing));
        onClose();
        return;
      }

      const localDraft = await window.electronAPI.pos.draftProducts.getByBarcode(code);
      let nextPreview = draftPreviewFromLocal(localDraft, code);
      if (!nextPreview) {
        const lookupResult = await window.electronAPI.pos.masterCatalog.lookupByEan(code);
        if (lookupResult?.ok) nextPreview = draftPreviewFromLookup(lookupResult, code);
      }

      if (nextPreview) {
        setPreview(nextPreview);
        setMessage(tOr(t, 'products.add.draftFound', 'Draft product found. Review it before importing.'));
      } else {
        setError(`${tOr(t, 'products.add.notFound', 'No local product or draft found for this barcode.')} ${tOr(t, 'products.add.serverRequired', 'Manual product creation needs product management support.')}`);
      }
    } catch (err: any) {
      setError(err?.message || tOr(t, 'products.add.lookupFailed', 'Could not check this barcode'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const code = initialBarcode || '';
    setBarcode(code);
    setPreview(null);
    setMessage(null);
    setError(null);
    setLoading(false);
    setImporting(false);
    setTimeout(() => inputRef.current?.focus(), 0);
    if (code) setTimeout(() => void lookup(code), 0);
  }, [initialBarcode, open]);

  if (!open) return null;

  const importDraft = async () => {
    const ean = (preview?.barcode || barcode).trim();
    if (!ean) return;
    setImporting(true);
    setError(null);
    try {
      const result = await window.electronAPI.pos.masterCatalog.importDraft({ ean });
      if (!result?.ok) {
        setError(result?.error || 'Import failed');
        return;
      }
      await onImported();
      const variant = result.variant ?? await window.electronAPI.pos.products.getByBarcode(ean);
      if (variant) onOpenProduct(variantToProduct(variant));
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open
      keyboardAware
      size="lg"
      title={tOr(t, 'products.add.title', 'Add product by barcode')}
      onClose={onClose}
      busy={loading || importing}
      closeLabel={tOr(t, 'products.drawer.close', 'Close')}
    >
        <div className="space-y-4 p-5">
            <p className="mt-1 text-sm text-slate-500">
              {tOr(t, 'products.add.description', 'Scan or type a barcode first. Existing items open for review; draft items can be imported safely.')}
            </p>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.add.barcode', 'Barcode')}
            </span>
            <div className="relative">
              <ScanBarcode size={20} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void lookup();
                  }
                }}
                className="h-12 w-full rounded-md border border-slate-300 pl-11 pr-3 text-base font-semibold tracking-wide text-slate-950 outline-none transition duration-150 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 motion-reduce:transition-none"
                inputMode="numeric"
                autoComplete="off"
              />
            </div>
          </label>

          <button
            type="button"
            onClick={() => void lookup()}
            disabled={loading || importing}
            className="inline-flex h-12 w-full items-center justify-center rounded-md bg-brand-600 px-4 text-sm font-semibold text-white transition duration-150 hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
          >
            {loading ? tOr(t, 'products.loading', 'Loading products...') : tOr(t, 'products.add.lookup', 'Find')}
          </button>

          {preview ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex gap-3">
                {preview.image_url ? (
                  <img src={preview.image_url} alt={preview.name} className="h-20 w-20 rounded-md border border-slate-200 object-cover" />
                ) : (
                  <div className="flex h-20 w-20 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-400">
                    <Package size={26} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-slate-950">{preview.name}</div>
                  <div className="mt-1 font-mono text-xs text-slate-500">{preview.barcode}</div>
                  <div className="mt-2 text-sm text-slate-700">
                    {(preview.retail_price / 100).toFixed(2)} {tOr(t, 'pos.currency', 'zl')} - {preview.in_stock} - VAT {preview.vat_rate}%
                  </div>
                  {preview.status ? <div className="mt-2 text-xs font-semibold uppercase text-violet-700">{preview.status}</div> : null}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void importDraft()}
                disabled={importing || loading}
                className="mt-3 inline-flex h-11 w-full items-center justify-center rounded-md bg-emerald-600 px-4 text-sm font-semibold text-white transition duration-150 hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
              >
                {importing ? tOr(t, 'products.add.importing', 'Importing...') : tOr(t, 'products.add.importDraft', 'Import draft')}
              </button>
            </div>
          ) : null}

          {message ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {message}
            </div>
          ) : null}
          {error ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          ) : null}
        </div>
    </Modal>
  );
}
