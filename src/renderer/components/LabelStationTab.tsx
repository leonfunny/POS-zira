import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, LogOut, Minus, Plus, Printer, RefreshCw, Search, Tag } from 'lucide-react';
import { resolveName } from '../../shared/catalog-names';
import type { AgentConfig } from '../../shared/types';
import type { Category, Product } from '../hooks/usePosDb';
import type { Language } from '../i18n/translations';
import rlog from '../utils/logger';
import { formatProductLabelPriceText } from '../utils/product-label';

type LabelStationProduct = Product & { ean?: string | null };

type PrintState =
  | { type: 'idle'; message: string }
  | { type: 'printing'; message: string }
  | { type: 'success'; message: string }
  | { type: 'error'; message: string };

interface RecentPrint {
  id: string;
  productName: string;
  barcode: string;
  copies: number;
  printedAt: Date;
}

interface LabelStationTabProps {
  config: AgentConfig | null;
  language: Language;
  onExit: () => void;
}

const TEXT = {
  title: 'Label Station',
  subtitle: 'POS3 counter labels',
  allCategories: 'All categories',
  search: 'Search name, SKU, EAN, category...',
  products: 'products',
  ean: 'EAN',
  sku: 'SKU',
  category: 'Category',
  price: 'Price',
  copies: 'Copies',
  print: 'In nh\u00e3n',
  missingEan: 'Thi\u1ebfu m\u00e3 EAN',
  noProducts: 'No products in the selected categories',
  noMatch: 'No products match this search',
  loading: 'Loading catalog...',
  refresh: 'Refresh catalog',
  exit: 'Exit',
  enterPin: 'Enter exit PIN',
  incorrectPin: 'Incorrect PIN',
  cancel: 'Cancel',
  unlock: 'Unlock',
  recent: 'Recent prints',
  printerError: 'Label printer error',
  printed: 'Label sent',
};

function parseCategoryIds(value: string | null | undefined): string[] {
  return String(value || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function normalizeSearch(value: string): string {
  return value
    .replace(/[\u0110\u0111]/g, (ch) => (ch === '\u0110' ? 'D' : 'd'))
    .replace(/[\u0141\u0142]/g, (ch) => (ch === '\u0141' ? 'L' : 'l'))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function clampCopies(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(999, Math.round(parsed)));
}

function resolveLabelBarcode(product: LabelStationProduct | null): string {
  if (!product) return '';
  return String(product.barcode ?? product.ean ?? '').trim();
}

function productImage(product: LabelStationProduct): string | null {
  return product.thumbnail_url || product.image_url || null;
}

function productMatches(
  product: LabelStationProduct,
  query: string,
  categoryById: Map<string, Category>,
  language: Language,
): boolean {
  if (!query) return true;
  const category = product.category_id ? categoryById.get(product.category_id) : null;
  const haystack = [
    product.name,
    resolveName(product, language),
    product.sku,
    product.barcode,
    product.ean,
    category?.name,
    category ? resolveName(category, language) : '',
  ].filter(Boolean).join(' ');
  return normalizeSearch(haystack).includes(query);
}

export default function LabelStationTab({ config, language, onExit }: LabelStationTabProps) {
  const [products, setProducts] = useState<LabelStationProduct[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<LabelStationProduct | null>(null);
  const [activeCategoryId, setActiveCategoryId] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copies, setCopies] = useState(() => clampCopies(config?.labelStationCopies ?? 1));
  const [printState, setPrintState] = useState<PrintState>({ type: 'idle', message: '' });
  const [recentPrints, setRecentPrints] = useState<RecentPrint[]>([]);
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [pinValue, setPinValue] = useState('');
  const [pinError, setPinError] = useState('');

  const allowedCategoryIds = useMemo(
    () => new Set(parseCategoryIds(config?.labelStationCategoryIds)),
    [config?.labelStationCategoryIds],
  );
  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories]);

  const loadCatalog = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [productRows, categoryRows] = await Promise.all([
        window.electronAPI.pos.products.getAll(),
        window.electronAPI.pos.categories.getAll(),
      ]);
      setProducts((productRows || []) as LabelStationProduct[]);
      setCategories((categoryRows || []) as Category[]);
    } catch (err: any) {
      rlog.error('[LabelStation] Failed to load catalog:', err);
      setProducts([]);
      setCategories([]);
      setError(err?.message || 'Failed to load catalog');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog(false);
  }, [loadCatalog]);

  useEffect(() => {
    const reload = () => { void loadCatalog(true); };
    const unsubProducts = window.electronAPI.pos.sync.onProductsSynced(reload);
    const unsubCatalog = window.electronAPI.pos.sync.onCatalogUpdated(reload);
    const unsubStock = window.electronAPI.pos.sync.onStockUpdated(reload);
    return () => {
      unsubProducts?.();
      unsubCatalog?.();
      unsubStock?.();
    };
  }, [loadCatalog]);

  useEffect(() => {
    setCopies(clampCopies(config?.labelStationCopies ?? 1));
  }, [config?.labelStationCopies]);

  const stationCategories = useMemo(() => {
    if (allowedCategoryIds.size === 0) return categories;
    return categories.filter((category) => allowedCategoryIds.has(category.id));
  }, [allowedCategoryIds, categories]);

  useEffect(() => {
    if (activeCategoryId && !stationCategories.some((category) => category.id === activeCategoryId)) {
      setActiveCategoryId('');
    }
  }, [activeCategoryId, stationCategories]);

  const visibleProducts = useMemo(() => {
    const normalizedQuery = normalizeSearch(query);
    return products
      .filter((product) => allowedCategoryIds.size === 0 || (product.category_id && allowedCategoryIds.has(product.category_id)))
      .filter((product) => !activeCategoryId || product.category_id === activeCategoryId)
      .filter((product) => productMatches(product, normalizedQuery, categoryById, language));
  }, [activeCategoryId, allowedCategoryIds, categoryById, language, products, query]);

  useEffect(() => {
    if (visibleProducts.length === 0) {
      if (selectedProduct) setSelectedProduct(null);
      return;
    }
    if (!selectedProduct || !visibleProducts.some((product) => product.id === selectedProduct.id)) {
      setSelectedProduct(visibleProducts[0]);
    }
  }, [selectedProduct, visibleProducts]);

  const selectedBarcode = resolveLabelBarcode(selectedProduct);
  const selectedName = selectedProduct ? (resolveName(selectedProduct, language) || selectedProduct.name || selectedBarcode) : '';
  const selectedPriceText = selectedProduct ? formatProductLabelPriceText(selectedProduct, 'zl') : undefined;
  const selectedCategory = selectedProduct?.category_id ? categoryById.get(selectedProduct.category_id) : null;
  const canPrint = !!selectedProduct && !!selectedBarcode && printState.type !== 'printing';

  const handleExitClick = () => {
    const configuredPin = String(config?.labelStationExitPin || '').trim();
    if (!configuredPin) {
      onExit();
      return;
    }
    setPinValue('');
    setPinError('');
    setExitDialogOpen(true);
  };

  const handleSubmitExitPin = (event: React.FormEvent) => {
    event.preventDefault();
    const configuredPin = String(config?.labelStationExitPin || '').trim();
    if (pinValue.trim() === configuredPin) {
      setExitDialogOpen(false);
      onExit();
      return;
    }
    setPinError(TEXT.incorrectPin);
  };

  const handlePrint = async () => {
    if (!selectedProduct || !selectedBarcode) return;
    const quantity = clampCopies(copies);
    const displayName = selectedName || selectedProduct.name || selectedBarcode;
    setCopies(quantity);
    setPrintState({ type: 'printing', message: `${TEXT.print}...` });
    try {
      const result = await window.electronAPI.printLabel(selectedBarcode, displayName, {
        priceText: selectedPriceText,
        sku: selectedProduct.sku?.trim() || undefined,
        quantity,
      });
      if (!result?.success) {
        setPrintState({ type: 'error', message: result?.error || TEXT.printerError });
        return;
      }
      setPrintState({ type: 'success', message: `${TEXT.printed}: ${displayName}` });
      setRecentPrints((prev) => [
        {
          id: `${Date.now()}-${selectedProduct.id}`,
          productName: displayName,
          barcode: selectedBarcode,
          copies: quantity,
          printedAt: new Date(),
        },
        ...prev,
      ].slice(0, 6));
      window.setTimeout(() => setPrintState({ type: 'idle', message: '' }), 3200);
    } catch (err: any) {
      rlog.error('[LabelStation] printLabel failed:', err);
      setPrintState({ type: 'error', message: err?.message || TEXT.printerError });
    }
  };

  return (
    <div className="h-full min-h-0 w-full overflow-hidden bg-slate-100 text-slate-900">
      <div className="h-full min-h-0 grid grid-rows-[auto,1fr]">
        <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <div className="h-11 w-11 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
            <Tag size={23} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-extrabold leading-tight truncate">{TEXT.title}</h1>
            <p className="text-xs text-slate-500 truncate">{TEXT.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={() => void loadCatalog(false)}
            className="h-10 w-10 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 inline-flex items-center justify-center"
            title={TEXT.refresh}
            aria-label={TEXT.refresh}
          >
            <RefreshCw size={17} />
          </button>
          <button
            type="button"
            onClick={handleExitClick}
            className="h-10 px-3 rounded-md border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 inline-flex items-center gap-2"
          >
            <LogOut size={16} />
            {TEXT.exit}
          </button>
        </header>

        <div className="min-h-0 grid grid-cols-[minmax(0,1fr),340px]">
          <section className="min-h-0 flex flex-col border-r border-slate-200">
            <div className="bg-white px-4 py-3 border-b border-slate-200 space-y-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={TEXT.search}
                    className="h-11 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-3 text-base outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
                <div className="h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-600 flex items-center shrink-0">
                  <span className="font-bold text-slate-900">{visibleProducts.length}</span>
                  <span className="ml-1">{TEXT.products}</span>
                </div>
              </div>

              <div className="flex gap-2 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => setActiveCategoryId('')}
                  className={`h-9 px-3 rounded-md border text-sm font-semibold whitespace-nowrap ${
                    activeCategoryId === ''
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {TEXT.allCategories}
                </button>
                {stationCategories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => setActiveCategoryId(category.id)}
                    className={`h-9 px-3 rounded-md border text-sm font-semibold whitespace-nowrap ${
                      activeCategoryId === category.id
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {resolveName(category, language)}
                  </button>
                ))}
              </div>
            </div>

            {printState.message && (
              <div
                className={`mx-4 mt-3 rounded-lg border px-4 py-2 text-sm font-semibold inline-flex items-center gap-2 ${
                  printState.type === 'success'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : printState.type === 'error'
                      ? 'border-red-200 bg-red-50 text-red-700'
                      : 'border-sky-200 bg-sky-50 text-sky-700'
                }`}
              >
                {printState.type === 'success' && <CheckCircle2 size={17} />}
                {printState.type === 'error' && <AlertTriangle size={17} />}
                <span>{printState.message}</span>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {loading ? (
                <div className="h-full flex items-center justify-center text-sm font-medium text-slate-500">{TEXT.loading}</div>
              ) : error ? (
                <div className="h-full flex items-center justify-center text-sm font-semibold text-red-600">{error}</div>
              ) : visibleProducts.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm font-medium text-slate-500">
                  {query.trim() ? TEXT.noMatch : TEXT.noProducts}
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(156px,1fr))] gap-3">
                  {visibleProducts.map((product) => {
                    const displayName = resolveName(product, language) || product.name;
                    const barcode = resolveLabelBarcode(product);
                    const priceText = formatProductLabelPriceText(product, 'zl');
                    const category = product.category_id ? categoryById.get(product.category_id) : null;
                    const img = productImage(product);
                    const selected = selectedProduct?.id === product.id;
                    const showImage = img && !imageErrors[product.id];
                    return (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => setSelectedProduct(product)}
                        className={`min-h-[188px] rounded-lg border bg-white text-left overflow-hidden transition-colors ${
                          selected
                            ? 'border-emerald-500 ring-2 ring-emerald-100'
                            : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        <div className="h-24 bg-slate-100 flex items-center justify-center overflow-hidden">
                          {showImage ? (
                            <img
                              src={img}
                              alt=""
                              className="h-full w-full object-cover"
                              onError={() => setImageErrors((prev) => ({ ...prev, [product.id]: true }))}
                            />
                          ) : (
                            <Tag size={28} className="text-slate-300" />
                          )}
                        </div>
                        <div className="p-3 space-y-2">
                          <div className="min-h-[38px] text-sm font-extrabold leading-tight text-slate-900 line-clamp-2">
                            {displayName}
                          </div>
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate text-slate-500">{category ? resolveName(category, language) : '-'}</span>
                            <span className="font-bold text-slate-700">{priceText || '-'}</span>
                          </div>
                          <div className={`text-[11px] font-semibold rounded-md px-2 py-1 truncate ${
                            barcode ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                          }`}>
                            {barcode || TEXT.missingEan}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <aside className="min-h-0 bg-white flex flex-col">
            <div className="p-4 border-b border-slate-200">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{TEXT.print}</div>
              <h2 className="mt-1 text-lg font-extrabold text-slate-900 leading-tight">{selectedName || '-'}</h2>
            </div>

            <div className="p-4 space-y-4 flex-1 overflow-y-auto">
              {selectedProduct ? (
                <>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-xs font-semibold text-slate-400">{TEXT.ean}</div>
                      <div className={`mt-1 font-bold break-all ${selectedBarcode ? 'text-slate-800' : 'text-amber-700'}`}>
                        {selectedBarcode || TEXT.missingEan}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-slate-400">{TEXT.price}</div>
                      <div className="mt-1 font-bold text-slate-800">{selectedPriceText || '-'}</div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-slate-400">{TEXT.category}</div>
                      <div className="mt-1 font-bold text-slate-800">{selectedCategory ? resolveName(selectedCategory, language) : '-'}</div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-slate-400">{TEXT.sku}</div>
                      <div className="mt-1 font-bold text-slate-800 break-all">{selectedProduct.sku || '-'}</div>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-slate-400 mb-2">{TEXT.copies}</div>
                    <div className="grid grid-cols-[44px,1fr,44px] gap-2">
                      <button
                        type="button"
                        onClick={() => setCopies((value) => clampCopies(value - 1))}
                        className="h-11 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center"
                        aria-label="Decrease copies"
                      >
                        <Minus size={18} />
                      </button>
                      <input
                        type="number"
                        min={1}
                        max={999}
                        value={copies}
                        onChange={(event) => setCopies(clampCopies(event.target.value))}
                        className="h-11 rounded-lg border border-slate-200 text-center text-lg font-extrabold outline-none focus:ring-2 focus:ring-emerald-200"
                      />
                      <button
                        type="button"
                        onClick={() => setCopies((value) => clampCopies(value + 1))}
                        className="h-11 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center"
                        aria-label="Increase copies"
                      >
                        <Plus size={18} />
                      </button>
                    </div>
                  </div>

                  {!selectedBarcode && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 inline-flex items-center gap-2">
                      <AlertTriangle size={17} />
                      {TEXT.missingEan}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-sm font-medium text-slate-500">{TEXT.noProducts}</div>
              )}
            </div>

            <div className="p-4 border-t border-slate-200 space-y-3">
              <button
                type="button"
                onClick={() => void handlePrint()}
                disabled={!canPrint}
                className={`w-full h-14 rounded-lg text-base font-extrabold inline-flex items-center justify-center gap-2 transition-colors ${
                  canPrint
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'bg-slate-200 text-slate-500 cursor-not-allowed'
                }`}
              >
                <Printer size={20} />
                {printState.type === 'printing' ? `${TEXT.print}...` : TEXT.print}
              </button>

              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">{TEXT.recent}</div>
                <div className="space-y-2">
                  {recentPrints.length === 0 ? (
                    <div className="text-xs text-slate-400">-</div>
                  ) : recentPrints.map((entry) => (
                    <div key={entry.id} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                      <div className="text-xs font-bold text-slate-800 truncate">{entry.productName}</div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                        <span className="truncate">{entry.barcode}</span>
                        <span className="font-semibold">x{entry.copies}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>

      {exitDialogOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form onSubmit={handleSubmitExitPin} className="w-full max-w-sm rounded-lg bg-white shadow-xl border border-slate-200 p-4">
            <h2 className="text-lg font-extrabold text-slate-900">{TEXT.enterPin}</h2>
            <input
              type="password"
              inputMode="numeric"
              value={pinValue}
              onChange={(event) => {
                setPinValue(event.target.value);
                setPinError('');
              }}
              autoFocus
              className="mt-3 h-11 w-full rounded-lg border border-slate-300 px-3 text-lg font-bold tracking-widest outline-none focus:ring-2 focus:ring-emerald-200"
            />
            {pinError && <div className="mt-2 text-sm font-semibold text-red-600">{pinError}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setExitDialogOpen(false)}
                className="h-10 px-3 rounded-md border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                {TEXT.cancel}
              </button>
              <button
                type="submit"
                className="h-10 px-4 rounded-md bg-slate-900 text-sm font-semibold text-white hover:bg-slate-800"
              >
                {TEXT.unlock}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
