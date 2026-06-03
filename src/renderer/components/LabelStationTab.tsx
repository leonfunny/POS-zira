import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  LogOut,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  RotateCw,
  Search,
  Tag,
  X,
} from 'lucide-react';
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
  productId: string;
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

const HIGH_COPY_CONFIRM_THRESHOLD = 10;
const RECENT_PRINT_LIMIT = 5;

const TEXT = {
  title: 'Trạm in nhãn',
  subtitle: 'Chọn sản phẩm, kiểm tra nhãn, rồi in',
  allCategories: 'Tất cả danh mục',
  search: 'Tìm theo tên, SKU, EAN, danh mục',
  clearSearch: 'Xóa tìm kiếm',
  products: 'sản phẩm',
  selected: 'Đang chọn',
  labelPanel: 'Bảng in nhãn',
  labelPreview: 'Xem trước nhãn',
  productInfo: 'Thông tin sản phẩm',
  ean: 'EAN',
  sku: 'SKU',
  category: 'Danh mục',
  price: 'Giá',
  unit: 'Đơn vị',
  copies: 'Số bản in',
  print: 'In nhãn',
  printing: 'Đang in...',
  ready: 'Sẵn sàng in',
  printed: 'Đã in thành công',
  printerError: 'Lỗi máy in nhãn',
  noProductSelected: 'Chưa chọn sản phẩm',
  missingEan: 'Thiếu mã EAN',
  noProducts: 'Không có sản phẩm trong danh mục đã chọn',
  noMatch: 'Không tìm thấy sản phẩm phù hợp',
  loading: 'Đang tải danh mục...',
  refresh: 'Làm mới danh mục',
  exit: 'Thoát',
  enterPin: 'Nhập PIN để thoát',
  incorrectPin: 'Sai mã PIN',
  cancel: 'Hủy',
  unlock: 'Mở khóa',
  recent: 'Lịch sử in gần đây',
  noRecent: 'Chưa có nhãn nào được in',
  reprint: 'In lại',
  shortcuts: 'Enter in nhãn - / tìm kiếm - Esc xóa tìm kiếm',
  printCopies: (quantity: number) => `In ${quantity} nhãn`,
  highCopyConfirm: (quantity: number) => `Bạn sắp in ${quantity} nhãn. Xác nhận để tránh in nhầm số lượng lớn?`,
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

function productUnit(product: LabelStationProduct | null): string {
  if (!product) return '-';
  const saleUnit = String(product.sale_unit || '').trim();
  if (saleUnit) return saleUnit;
  return product.sell_by === 'WEIGHT' ? 'kg' : 'cái';
}

function formatRecentTime(date: Date): string {
  return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function barcodeBars(barcode: string): number[] {
  const seed = barcode || '0000000000000';
  return Array.from(seed.slice(0, 24)).map((char, index) => {
    const code = char.charCodeAt(0) + index * 7;
    return 2 + (code % 4);
  });
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

function BarcodePreview({ barcode }: { barcode: string }) {
  const bars = barcodeBars(barcode);
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-3" aria-label="Barcode preview">
      <div className="flex h-14 items-end justify-center gap-[2px] overflow-hidden rounded bg-white">
        {bars.map((width, index) => (
          <span
            key={`${barcode || 'empty'}-${index}`}
            className="block bg-slate-950"
            style={{
              width: `${width}px`,
              height: `${34 + ((index * 11) % 18)}px`,
            }}
          />
        ))}
      </div>
      <div className="mt-2 text-center font-mono text-sm font-bold tracking-[0.12em] text-slate-800">
        {barcode || '------------'}
      </div>
    </div>
  );
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
  const searchInputRef = useRef<HTMLInputElement | null>(null);

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
      setError(err?.message || 'Không tải được danh mục');
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
  const selectedUnit = productUnit(selectedProduct);
  const normalizedCopies = clampCopies(copies);
  const canPrint = !!selectedProduct && !!selectedBarcode && printState.type !== 'printing';
  const statusText = printState.message || (
    selectedProduct ? (selectedBarcode ? TEXT.ready : TEXT.missingEan) : TEXT.noProductSelected
  );
  const printButtonText = printState.type === 'printing'
    ? TEXT.printing
    : selectedProduct && selectedBarcode
      ? TEXT.printCopies(normalizedCopies)
      : TEXT.noProductSelected;

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

  const printProduct = useCallback(async (
    product: LabelStationProduct,
    requestedCopies: number,
    options: { confirmHighCopy?: boolean } = {},
  ) => {
    const barcode = resolveLabelBarcode(product);
    const quantity = clampCopies(requestedCopies);
    const displayName = resolveName(product, language) || product.name || barcode;
    const priceText = formatProductLabelPriceText(product, 'zl');

    setSelectedProduct(product);
    setCopies(quantity);

    if (!barcode) {
      setPrintState({ type: 'error', message: TEXT.missingEan });
      return;
    }

    if (options.confirmHighCopy !== false && quantity > HIGH_COPY_CONFIRM_THRESHOLD) {
      const confirmed = window.confirm(TEXT.highCopyConfirm(quantity));
      if (!confirmed) {
        setPrintState({ type: 'idle', message: TEXT.ready });
        return;
      }
    }

    setPrintState({ type: 'printing', message: TEXT.printing });
    try {
      const result = await window.electronAPI.printLabel(barcode, displayName, {
        priceText,
        sku: product.sku?.trim() || undefined,
        quantity,
      });
      if (!result?.success) {
        setPrintState({ type: 'error', message: result?.error || TEXT.printerError });
        return;
      }
      setPrintState({ type: 'success', message: `${TEXT.printed}: ${displayName}` });
      setRecentPrints((prev) => [
        {
          id: `${Date.now()}-${product.id}`,
          productId: product.id,
          productName: displayName,
          barcode,
          copies: quantity,
          printedAt: new Date(),
        },
        ...prev,
      ].slice(0, RECENT_PRINT_LIMIT));
      window.setTimeout(() => setPrintState({ type: 'idle', message: '' }), 3200);
    } catch (err: any) {
      rlog.error('[LabelStation] printLabel failed:', err);
      setPrintState({ type: 'error', message: err?.message || TEXT.printerError });
    }
  }, [language]);

  const handlePrint = useCallback(() => {
    if (!selectedProduct) {
      setPrintState({ type: 'error', message: TEXT.noProductSelected });
      return;
    }
    void printProduct(selectedProduct, copies);
  }, [copies, printProduct, selectedProduct]);

  const handleQuickReprint = useCallback((entry: RecentPrint) => {
    const product = products.find((row) => row.id === entry.productId);
    if (!product) {
      setPrintState({ type: 'error', message: 'Không tìm thấy sản phẩm để in lại' });
      return;
    }
    void printProduct(product, entry.copies);
  }, [printProduct, products]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isTyping = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';

      if (event.key === '/' || (event.ctrlKey && event.key.toLowerCase() === 'f')) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (event.key === 'Escape') {
        if (query) {
          event.preventDefault();
          setQuery('');
        }
        return;
      }

      if (isTyping) return;

      if (event.key === 'Enter') {
        event.preventDefault();
        handlePrint();
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setCopies((value) => clampCopies(value + 1));
        return;
      }
      if (event.key === '-') {
        event.preventDefault();
        setCopies((value) => clampCopies(value - 1));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlePrint, query]);

  return (
    <div className="h-full min-h-0 w-full overflow-hidden bg-slate-100 text-slate-900">
      <div className="h-full min-h-0 grid grid-rows-[auto,1fr]">
        <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <div className="h-11 w-11 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
            <Tag size={23} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-extrabold leading-tight truncate">{TEXT.title}</h1>
            <p className="text-xs font-semibold text-slate-500 truncate">{TEXT.subtitle}</p>
          </div>
          <div className="hidden lg:block text-xs font-semibold text-slate-400">
            {TEXT.shortcuts}
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
            className="h-10 px-3 rounded-md border border-slate-200 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50 inline-flex items-center gap-2"
          >
            <LogOut size={16} />
            {TEXT.exit}
          </button>
        </header>

        <div className="min-h-0 grid grid-cols-[minmax(0,1fr),400px] gap-3 p-3">
          <section className="min-h-0 flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div className="px-4 py-3 border-b border-slate-200 space-y-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    ref={searchInputRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={TEXT.search}
                    className="h-11 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-11 text-base font-semibold outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      aria-label={TEXT.clearSearch}
                      title={TEXT.clearSearch}
                      className="absolute right-1.5 top-1/2 h-8 w-8 -translate-y-1/2 rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                    >
                      <X size={17} className="mx-auto" />
                    </button>
                  )}
                </div>
                <div className="h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-600 flex items-center shrink-0">
                  <span className="font-extrabold text-slate-950 tabular-nums">{visibleProducts.length}</span>
                  <span className="ml-1 font-bold">{TEXT.products}</span>
                </div>
              </div>

              <div className="flex gap-2 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => setActiveCategoryId('')}
                  className={`min-h-11 px-3 rounded-md border text-sm font-bold whitespace-nowrap ${
                    activeCategoryId === ''
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
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
                    className={`min-h-11 px-3 rounded-md border text-sm font-bold whitespace-nowrap ${
                      activeCategoryId === category.id
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {resolveName(category, language)}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {loading ? (
                <div className="h-full flex items-center justify-center text-sm font-semibold text-slate-500">{TEXT.loading}</div>
              ) : error ? (
                <div className="h-full flex items-center justify-center text-sm font-bold text-red-600">{error}</div>
              ) : visibleProducts.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm font-semibold text-slate-500">
                  {query.trim() ? TEXT.noMatch : TEXT.noProducts}
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
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
                        className={`relative min-h-[176px] rounded-lg border-2 text-left overflow-hidden transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-emerald-300 ${
                          selected
                            ? 'border-emerald-600 bg-emerald-50 shadow-sm'
                            : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        {selected && (
                          <span className="absolute right-2 top-2 z-[1] rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-extrabold uppercase text-white shadow-sm">
                            {TEXT.selected}
                          </span>
                        )}
                        <div className="aspect-[4/3] bg-slate-100 flex items-center justify-center overflow-hidden">
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
                        <div className="p-2.5 space-y-1.5">
                          <div className="min-h-[36px] text-sm font-extrabold leading-tight text-slate-950 line-clamp-2">
                            {displayName}
                          </div>
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate font-semibold text-slate-500">{category ? resolveName(category, language) : '-'}</span>
                            <span className="shrink-0 font-extrabold text-slate-950">{priceText || '-'}</span>
                          </div>
                          <div className={`max-w-full text-[11px] font-bold rounded-md px-2 py-1 truncate ${
                            barcode ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-50 text-amber-700'
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

          <aside className="sticky top-3 min-h-0 h-full rounded-lg border border-slate-200 border-l border-l-slate-300 bg-white flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-200">
              <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">{TEXT.labelPanel}</div>
              <h2 className="mt-1 text-lg font-extrabold text-slate-950 leading-tight line-clamp-2">
                {selectedName || TEXT.noProductSelected}
              </h2>
            </div>

            <div className="p-4 space-y-4 flex-1 overflow-y-auto">
              <div
                className={`rounded-lg border px-3 py-2 text-sm font-bold inline-flex w-full items-center gap-2 ${
                  printState.type === 'success'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : printState.type === 'error' || !selectedBarcode
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : printState.type === 'printing'
                        ? 'border-sky-200 bg-sky-50 text-sky-800'
                        : 'border-slate-200 bg-slate-50 text-slate-700'
                }`}
              >
                {printState.type === 'success' ? <CheckCircle2 size={17} /> : printState.type === 'error' || !selectedBarcode ? <AlertTriangle size={17} /> : <Printer size={17} />}
                <span>{statusText}</span>
              </div>

              {selectedProduct ? (
                <>
                  <section className="space-y-2">
                    <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">{TEXT.productInfo}</div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="rounded-lg bg-slate-50 px-3 py-2">
                        <div className="text-xs font-bold text-slate-400">{TEXT.ean}</div>
                        <div className={`mt-1 font-extrabold break-all ${selectedBarcode ? 'text-slate-900' : 'text-amber-700'}`}>
                          {selectedBarcode || TEXT.missingEan}
                        </div>
                      </div>
                      <div className="rounded-lg bg-slate-50 px-3 py-2">
                        <div className="text-xs font-bold text-slate-400">{TEXT.price}</div>
                        <div className="mt-1 font-extrabold text-slate-900">{selectedPriceText || '-'}</div>
                      </div>
                      <div className="rounded-lg bg-slate-50 px-3 py-2">
                        <div className="text-xs font-bold text-slate-400">{TEXT.category}</div>
                        <div className="mt-1 font-extrabold text-slate-900 truncate">{selectedCategory ? resolveName(selectedCategory, language) : '-'}</div>
                      </div>
                      <div className="rounded-lg bg-slate-50 px-3 py-2">
                        <div className="text-xs font-bold text-slate-400">{TEXT.unit}</div>
                        <div className="mt-1 font-extrabold text-slate-900">{selectedUnit}</div>
                      </div>
                      <div className="col-span-2 rounded-lg bg-slate-50 px-3 py-2">
                        <div className="text-xs font-bold text-slate-400">{TEXT.sku}</div>
                        <div className="mt-1 font-extrabold text-slate-900 break-all">{selectedProduct.sku || '-'}</div>
                      </div>
                    </div>
                  </section>

                  <section className="space-y-2">
                    <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">{TEXT.labelPreview}</div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div className="rounded-lg bg-white p-3 shadow-sm">
                        <div className="text-base font-black leading-tight text-slate-950 line-clamp-2">{selectedName}</div>
                        <div className="mt-2 flex items-baseline justify-between gap-3">
                          <span className="text-2xl font-black tabular-nums text-slate-950">{selectedPriceText || '-'}</span>
                          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-extrabold text-slate-600">{selectedUnit}</span>
                        </div>
                        <div className="mt-3">
                          <BarcodePreview barcode={selectedBarcode} />
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-bold text-slate-500">
                          {selectedProduct.sku && <span className="rounded bg-slate-100 px-2 py-1">SKU {selectedProduct.sku}</span>}
                          {selectedCategory && <span className="rounded bg-slate-100 px-2 py-1">{resolveName(selectedCategory, language)}</span>}
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="space-y-2">
                    <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">{TEXT.copies}</div>
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
                    {normalizedCopies > HIGH_COPY_CONFIRM_THRESHOLD && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
                        Số lượng lớn sẽ cần xác nhận trước khi in.
                      </div>
                    )}
                  </section>

                  <section className="space-y-2">
                    <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">{TEXT.recent}</div>
                    {recentPrints.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-sm font-semibold text-slate-400">
                        {TEXT.noRecent}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {recentPrints.map((entry) => (
                          <div key={entry.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-xs font-extrabold text-slate-900 truncate">{entry.productName}</div>
                                <div className="mt-1 flex items-center gap-2 text-[11px] font-bold text-slate-500">
                                  <Clock size={12} />
                                  <span>{formatRecentTime(entry.printedAt)}</span>
                                  <span>x{entry.copies}</span>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleQuickReprint(entry)}
                                className="h-8 shrink-0 rounded-md border border-slate-200 bg-white px-2 text-[11px] font-extrabold text-slate-700 hover:bg-slate-100 inline-flex items-center gap-1"
                              >
                                <RotateCw size={12} />
                                {TEXT.reprint}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </>
              ) : (
                <div className="text-sm font-semibold text-slate-500">{TEXT.noProductSelected}</div>
              )}
            </div>

            <div className="shrink-0 p-4 border-t border-slate-200 bg-white">
              <button
                type="button"
                onClick={handlePrint}
                disabled={!canPrint}
                className={`w-full h-14 rounded-xl text-base font-black inline-flex items-center justify-center gap-2 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:ring-offset-2 ${
                  canPrint
                    ? 'bg-slate-950 text-white hover:bg-black active:bg-slate-800 shadow-lg shadow-slate-950/20'
                    : 'bg-slate-200 text-slate-500 cursor-not-allowed'
                }`}
              >
                {printState.type === 'printing' ? <RefreshCw size={20} className="animate-spin" /> : <Printer size={20} />}
                {printButtonText}
              </button>
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
