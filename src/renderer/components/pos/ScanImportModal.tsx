import React, { useEffect, useRef, useState } from 'react';
import { useKeyboardAwareFocus } from '../../hooks/useKeyboardAwareFocus';

export interface ScanImportDraftPreview {
  id?: string;
  name: string;
  barcode: string | null;
  retail_price: number;
  purchase_price?: number;
  stock_qty?: number;
  vat_rate: number;
  image_url: string | null;
  status?: string;
  source?: string;
  suggestedCategoryId?: string | null;
}

export interface ScanImportCategoryOption {
  id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  sort_order?: number;
  updated_at?: string | null;
  name_translations?: string | null;
}

interface ScanImportModalProps {
  open: boolean;
  preview: ScanImportDraftPreview | null;
  ean: string;
  categoryOptions?: ScanImportCategoryOption[];
  onConfirm: (
    retailPriceGrosze: number,
    categoryId: string | undefined,
    stockQty: number,
  ) => void | Promise<void>;
  onCancel: () => void;
  loading?: boolean;
  error?: string | null;
  t: (key: string) => string;
}

function parsePriceInput(value: string): number | null {
  const n = Number(value.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export function parseOptionalScanImportStock(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return 0;
  if (!/^\d+$/.test(normalized)) return null;
  const quantity = Number(normalized);
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 999_999_999) {
    return null;
  }
  return quantity;
}

export function hasScanImportCategoryOptions(categoryOptions: ScanImportCategoryOption[]): boolean {
  return categoryOptions.length > 0;
}

export function resolveInitialScanImportCategoryId(
  preview: ScanImportDraftPreview | null,
  categoryOptions: ScanImportCategoryOption[],
): string {
  const suggestedCategoryId = String(preview?.suggestedCategoryId ?? '').trim();
  if (!suggestedCategoryId) return '';
  return categoryOptions.some((category) => category.id === suggestedCategoryId)
    ? suggestedCategoryId
    : '';
}

function isDraftCategorySelectionSource(source: string | undefined): boolean {
  return source !== 'open_food_facts' && source !== 'google_custom_search';
}

export default function ScanImportModal({
  open,
  preview,
  ean,
  categoryOptions = [],
  onConfirm,
  onCancel,
  loading,
  error,
  t,
}: ScanImportModalProps) {
  const [closing, setClosing] = useState(false);
  const [priceInput, setPriceInput] = useState('');
  const [stockInput, setStockInput] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const handleKeyboardAwareFocus = useKeyboardAwareFocus(panelRef, open);

  useEffect(() => {
    if (!open) return;
    setClosing(false);
    setPriceInput('');
    setStockInput('');
    setSelectedCategoryId(resolveInitialScanImportCategoryId(preview, categoryOptions));
  }, [open, preview?.id, preview?.barcode, preview?.suggestedCategoryId, categoryOptions]);

  if (!open) return null;

  const tOr = (key: string, fallback: string) => {
    const v = t(key);
    return v && v !== key ? v : fallback;
  };

  const handleCancel = () => {
    if (loading) return;
    setClosing(true);
    onCancel();
  };

  const retailPriceGrosze = parsePriceInput(priceInput);
  const stockQty = parseOptionalScanImportStock(stockInput);
  const vatText = preview ? `VAT ${preview.vat_rate}%` : '';
  const showDraftFields =
    !!preview && isDraftCategorySelectionSource(preview.source);
  const showCategorySelect =
    showDraftFields && hasScanImportCategoryOptions(categoryOptions);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-3 py-4"
      style={{ bottom: 'var(--touch-keyboard-inset, 0px)' }}
      onClick={handleCancel}
    >
      <div
        ref={panelRef}
        className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-brand-500/40 bg-slate-800 shadow-2xl"
        style={{ maxHeight: 'calc(100dvh - var(--touch-keyboard-inset, 0px) - 2rem)' }}
        onClick={(event) => event.stopPropagation()}
        onFocusCapture={handleKeyboardAwareFocus}
      >
        <div className="px-5 py-4 border-b border-slate-700 bg-gradient-to-r from-emerald-700/30 to-brand-700/30">
          <div className="text-xs uppercase tracking-wider text-emerald-300 font-semibold">
            {tOr('pos.scanImport.title', 'New product from catalog')}
          </div>
          <div className="mt-1 text-xs text-slate-400 font-mono">{ean}</div>
        </div>

        <div className="min-h-0 overflow-y-auto">
          {preview ? (
            <div className="p-5">
            <div className="flex gap-4 items-start">
              {preview.image_url ? (
                <img
                  src={preview.image_url}
                  alt={preview.name}
                  className="w-20 h-20 rounded-lg object-cover bg-slate-900 border border-slate-700 shrink-0"
                />
              ) : (
                <div className="w-20 h-20 rounded-lg bg-slate-900 border border-slate-700 flex items-center justify-center text-slate-600 shrink-0">
                  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-lg font-semibold text-white truncate">{preview.name}</div>
                <div className="mt-1 text-xs text-slate-400">{vatText}</div>
                {preview.status ? (
                  <div className="mt-2 inline-flex px-2 py-0.5 rounded-md bg-brand-900/40 border border-brand-500/30 text-[10px] uppercase tracking-wide text-brand-300">
                    {preview.status}
                  </div>
                ) : null}
              </div>
            </div>
            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-emerald-300">
                {tOr('pos.scanImport.salePrice', 'Selling price')}
              </span>
              <input
                value={priceInput}
                onChange={(event) => setPriceInput(event.target.value)}
                inputMode="decimal"
                autoFocus
                className="h-12 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-2xl font-bold text-white outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/30"
                placeholder="0.00"
              />
              <div className="mt-1 text-xs text-slate-400">
                {tOr('pos.scanImport.salePriceHint', 'This price will be saved to the product and used for this cart line.')}
              </div>
            </label>
            {showDraftFields ? (
              <label className="mt-4 block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-emerald-300">
                  {tOr('pos.scanImport.stock', 'Tồn kho cửa hàng (không bắt buộc)')}
                </span>
                <input
                  value={stockInput}
                  onChange={(event) => setStockInput(event.target.value)}
                  inputMode="numeric"
                  className="h-11 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-base font-semibold text-white outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/30"
                  placeholder="0"
                />
                <div className="mt-1 text-xs text-slate-400">
                  {tOr('pos.scanImport.stockHint', 'Để trống sẽ lưu tồn kho cửa hàng bằng 0.')}
                </div>
              </label>
            ) : null}
            {showCategorySelect ? (
              <label className="mt-4 block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-emerald-300">
                  {tOr('pos.scanImport.category', 'Danh mục')}
                </span>
                <select
                  value={selectedCategoryId}
                  onChange={(event) => setSelectedCategoryId(event.target.value)}
                  className="h-11 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-base font-semibold text-white outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/30"
                >
                  <option value="">{tOr('pos.scanImport.defaultCategory', 'Chưa phân loại (mặc định)')}</option>
                  {categoryOptions.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-slate-400">
              {tOr('pos.scanImport.notFound', 'No draft found for this code.')}
            </div>
          )}

          {error ? (
            <div className="mx-5 mb-3 px-3 py-2 rounded-md bg-red-900/40 border border-red-500/30 text-xs text-red-200">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 gap-3 border-t border-slate-700 bg-slate-900/40 p-4">
          <button
            type="button"
            onClick={handleCancel}
            disabled={loading}
            className="flex-1 h-12 rounded-lg border border-slate-600 text-slate-200 font-medium hover:bg-slate-700/60 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {tOr('pos.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={() => {
              if (retailPriceGrosze == null || stockQty == null) return;
              onConfirm(
                retailPriceGrosze,
                selectedCategoryId || undefined,
                stockQty,
              );
            }}
            disabled={
              loading ||
              !preview ||
              retailPriceGrosze == null ||
              stockQty == null
            }
            className="flex-2 h-12 px-6 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold shadow-lg shadow-emerald-900/40 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            style={{ flex: 2 }}
          >
            {loading ? (
              <>
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 60" />
                </svg>
                {tOr('pos.scanImport.importing', 'Importing…')}
              </>
            ) : (
              tOr('pos.scanImport.confirm', 'Thêm sản phẩm')
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
