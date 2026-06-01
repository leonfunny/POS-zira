import React, { useMemo, useState } from 'react';
import { Check, Plus, Printer, Search, Settings, Tag, X } from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import { useConfig } from '../../hooks/useConfig';
import { useProducts } from '../../hooks/useProducts';
import type { ProductListItem } from '../../hooks/useProducts';
import type { Language } from '../../i18n/translations';
import rlog from '../../utils/logger';

interface LabelModuleProps {
  language: Language;
}

type LabelStatus =
  | { type: 'idle'; message: string }
  | { type: 'printing'; message: string; productId: string }
  | { type: 'success'; message: string }
  | { type: 'error'; message: string };

const COPY: Record<string, Record<string, string>> = {
  en: {
    title: 'Label',
    subtitle: 'Quick labels for meat and seafood counter',
    settings: 'Settings',
    sync: 'Sync products',
    search: 'Search labels...',
    addSearch: 'Search product to add...',
    allCategories: 'All categories',
    products: 'products',
    selected: 'selected',
    tapToPrint: 'Tap photo to print',
    noProducts: 'No products in Label module',
    noProductsHint: 'Open Settings and add the products sold at this counter.',
    addProducts: 'Add products',
    moduleSettings: 'Label module settings',
    moduleSettingsHint: 'Choose products that should appear on this counter screen.',
    availableProducts: 'Available products',
    configuredProducts: 'Configured products',
    remove: 'Remove',
    added: 'Added',
    print: 'Print',
    printing: 'Printing label...',
    printed: 'Label sent to printer',
    noMatch: 'No matching products',
  },
  vi: {
    title: 'Label',
    subtitle: 'In tem nhanh cho quầy thịt và hải sản',
    settings: 'Cài đặt',
    sync: 'Đồng bộ sản phẩm',
    search: 'Tìm tem...',
    addSearch: 'Tìm sản phẩm để thêm...',
    allCategories: 'Tất cả nhóm',
    products: 'sản phẩm',
    selected: 'đã chọn',
    tapToPrint: 'Chạm ảnh để in',
    noProducts: 'Chưa có sản phẩm trong Label module',
    noProductsHint: 'Mở Cài đặt và thêm các sản phẩm bán ở quầy này.',
    addProducts: 'Thêm sản phẩm',
    moduleSettings: 'Cài đặt Label module',
    moduleSettingsHint: 'Chọn sản phẩm sẽ hiện trên màn hình quầy này.',
    availableProducts: 'Sản phẩm có thể thêm',
    configuredProducts: 'Sản phẩm đã cấu hình',
    remove: 'Gỡ',
    added: 'Đã thêm',
    print: 'In',
    printing: 'Đang in tem...',
    printed: 'Đã gửi tem đến máy in',
    noMatch: 'Không tìm thấy sản phẩm',
  },
  pl: {
    title: 'Label',
    subtitle: 'Szybkie etykiety na ladę mięsną i owoce morza',
    settings: 'Ustawienia',
    sync: 'Synchronizuj produkty',
    search: 'Szukaj etykiet...',
    addSearch: 'Szukaj produktu do dodania...',
    allCategories: 'Wszystkie kategorie',
    products: 'produkty',
    selected: 'wybrane',
    tapToPrint: 'Dotknij zdjęcia, aby drukować',
    noProducts: 'Brak produktów w module Label',
    noProductsHint: 'Otwórz Ustawienia i dodaj produkty dla tej lady.',
    addProducts: 'Dodaj produkty',
    moduleSettings: 'Ustawienia modułu Label',
    moduleSettingsHint: 'Wybierz produkty widoczne na ekranie tej lady.',
    availableProducts: 'Dostępne produkty',
    configuredProducts: 'Skonfigurowane produkty',
    remove: 'Usuń',
    added: 'Dodano',
    print: 'Drukuj',
    printing: 'Drukowanie etykiety...',
    printed: 'Etykieta wysłana do drukarki',
    noMatch: 'Brak pasujących produktów',
  },
};

function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function resolveLabelCode(product: ProductListItem): string {
  const raw = String(product.barcode || product.sku || product.id.replace(/^draft:/, '')).trim();
  if (raw.length === 13 && !/^\d{13}$/.test(raw)) return `P-${raw}`;
  return raw;
}

function productMatches(product: ProductListItem, query: string, language: string): boolean {
  if (!query) return true;
  const haystack = [product.name, resolveName(product, language), product.sku, product.barcode]
    .filter(Boolean)
    .join(' ');
  return normalizeSearch(haystack).includes(query);
}

function productImage(product: ProductListItem): string | null {
  return (product.thumbnail_url || product.image_url || null) as string | null;
}

export default function LabelModule({ language }: LabelModuleProps) {
  const copy = COPY[language] || COPY.en;
  const { config, saveConfig } = useConfig();
  const { allProducts, categories, loading, syncProducts, syncing } = useProducts(language);
  const [query, setQuery] = useState('');
  const [addQuery, setAddQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<LabelStatus>({ type: 'idle', message: '' });
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});

  const selectedIds = useMemo(
    () => new Set((config?.labelModuleProductIds || []) as string[]),
    [config?.labelModuleProductIds],
  );

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const labelProducts = useMemo(() => {
    return allProducts
      .filter((product) => selectedIds.has(product.id))
      .filter((product) => !categoryId || product.category_id === categoryId)
      .filter((product) => productMatches(product, normalizeSearch(query.trim()), language));
  }, [allProducts, categoryId, language, query, selectedIds]);

  const addableProducts = useMemo(() => {
    const normalized = normalizeSearch(addQuery.trim());
    return allProducts
      .filter((product) => productMatches(product, normalized, language))
      .slice(0, 120);
  }, [addQuery, allProducts, language]);

  const selectedProducts = useMemo(
    () => allProducts.filter((product) => selectedIds.has(product.id)),
    [allProducts, selectedIds],
  );

  const persistSelectedIds = async (ids: string[]) => {
    try {
      await saveConfig({ labelModuleProductIds: ids });
    } catch (err: any) {
      rlog.error('[LabelModule] Failed to save label products:', err);
      setStatus({ type: 'error', message: err?.message || 'Failed to save settings' });
    }
  };

  const addProduct = (productId: string) => {
    if (selectedIds.has(productId)) return;
    void persistSelectedIds([...Array.from(selectedIds), productId]);
  };

  const removeProduct = (productId: string) => {
    void persistSelectedIds(Array.from(selectedIds).filter((id) => id !== productId));
  };

  const printProductLabel = async (product: ProductListItem) => {
    const barcode = resolveLabelCode(product);
    const labelText = resolveName(product, language) || product.name || barcode;
    setStatus({ type: 'printing', message: copy.printing, productId: product.id });
    try {
      const result = await window.electronAPI.printLabel(barcode, labelText);
      if (!result?.success) {
        setStatus({ type: 'error', message: result?.error || 'Label printer error' });
        return;
      }
      setStatus({ type: 'success', message: `${copy.printed}: ${labelText}` });
      window.setTimeout(() => setStatus({ type: 'idle', message: '' }), 3500);
    } catch (err: any) {
      rlog.error('[LabelModule] printLabel failed:', err);
      setStatus({ type: 'error', message: err?.message || 'Label printer error' });
    }
  };

  return (
    <div className="h-full min-h-[calc(100vh-2rem)] bg-slate-50 text-slate-900">
      <div className="h-full flex flex-col gap-3">
        <header className="bg-white border border-slate-200 rounded-lg px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
            <Tag size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-extrabold leading-tight">{copy.title}</h1>
            <p className="text-xs text-slate-500">{copy.subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void syncProducts()}
              disabled={syncing}
              className="h-10 px-3 rounded-md border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              {syncing ? '...' : copy.sync}
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              className="h-10 px-3 rounded-md bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 inline-flex items-center gap-2"
            >
              <Settings size={16} />
              {copy.settings}
            </button>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={copy.search}
              className="w-full h-11 rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-emerald-200"
            />
          </div>
          <select
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            className="h-11 min-w-[180px] rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-emerald-200"
          >
            <option value="">{copy.allCategories}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {resolveName(category, language)}
              </option>
            ))}
          </select>
          <div className="h-11 px-3 rounded-lg bg-white border border-slate-200 text-sm text-slate-600 flex items-center">
            <span className="font-bold text-slate-900">{selectedIds.size}</span>
            <span className="ml-1">{copy.selected}</span>
          </div>
        </div>

        {status.message && (
          <div
            className={`rounded-lg border px-4 py-2 text-sm font-semibold ${
              status.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : status.type === 'error'
                  ? 'bg-red-50 border-red-200 text-red-700'
                  : 'bg-blue-50 border-blue-200 text-blue-700'
            }`}
          >
            {status.message}
          </div>
        )}

        <div className={`flex-1 min-h-0 grid gap-3 ${settingsOpen ? 'lg:grid-cols-[1fr_360px]' : 'grid-cols-1'}`}>
          <section className="min-h-0 overflow-y-auto">
            {loading ? (
              <div className="h-full min-h-[360px] rounded-lg bg-white border border-slate-200 flex items-center justify-center text-sm text-slate-500">
                Loading...
              </div>
            ) : labelProducts.length === 0 ? (
              <div className="h-full min-h-[360px] rounded-lg bg-white border border-slate-200 flex items-center justify-center p-8 text-center">
                <div>
                  <Tag className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <h2 className="text-base font-bold text-slate-800">{copy.noProducts}</h2>
                  <p className="mt-1 text-sm text-slate-500">{copy.noProductsHint}</p>
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(true)}
                    className="mt-4 h-10 px-4 rounded-md bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 inline-flex items-center gap-2"
                  >
                    <Plus size={16} />
                    {copy.addProducts}
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))] 2xl:[grid-template-columns:repeat(auto-fill,minmax(190px,1fr))] gap-2 pb-3">
                {labelProducts.map((product) => {
                  const displayName = resolveName(product, language);
                  const img = productImage(product);
                  const isPrinting = status.type === 'printing' && status.productId === product.id;
                  const category = product.category_id ? categoryById.get(product.category_id) : null;
                  const showImage = img && !imageErrors[product.id];

                  return (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => void printProductLabel(product)}
                      disabled={isPrinting}
                      className="group text-left bg-white border border-slate-200 rounded-lg p-1.5 min-h-[214px] flex flex-col hover:shadow-md active:scale-[0.99] transition disabled:opacity-70"
                    >
                      <div className="relative rounded-md overflow-hidden bg-slate-100 aspect-[4/3] w-full">
                        {showImage ? (
                          <img
                            src={img}
                            alt={displayName}
                            loading="lazy"
                            onError={() => setImageErrors((prev) => ({ ...prev, [product.id]: true }))}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-emerald-50 text-emerald-700">
                            <Tag size={32} />
                          </div>
                        )}
                        <span className="absolute left-2 bottom-2 rounded-md bg-white/95 px-2 py-1 text-[11px] font-extrabold text-emerald-700 shadow-sm inline-flex items-center gap-1">
                          <Printer size={12} />
                          {isPrinting ? '...' : copy.print}
                        </span>
                      </div>
                      <div className="pt-2 flex-1 min-w-0">
                        <p className="text-sm font-extrabold text-slate-900 leading-snug line-clamp-2">{displayName}</p>
                        {category && (
                          <p className="mt-1 text-[11px] text-slate-500 truncate">{resolveName(category, language)}</p>
                        )}
                      </div>
                      <div className="pt-1 flex items-center justify-between gap-2">
                        <span className="text-xs text-slate-500 truncate">{copy.tapToPrint}</span>
                        <span className="text-sm font-black text-slate-900 tabular-nums">
                          {(Number(product.retail_price || 0) / 100).toFixed(2)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {settingsOpen && (
            <aside className="min-h-0 bg-white border border-slate-200 rounded-lg flex flex-col">
              <div className="p-4 border-b border-slate-200 flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                  <Settings size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-extrabold text-slate-900">{copy.moduleSettings}</h2>
                  <p className="mt-0.5 text-xs text-slate-500">{copy.moduleSettingsHint}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  className="w-8 h-8 rounded-md text-slate-500 hover:bg-slate-100 flex items-center justify-center"
                  aria-label="Close"
                >
                  <X size={17} />
                </button>
              </div>

              <div className="p-3 border-b border-slate-200">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                  <input
                    value={addQuery}
                    onChange={(event) => setAddQuery(event.target.value)}
                    placeholder={copy.addSearch}
                    className="w-full h-10 rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                <div className="text-[11px] uppercase tracking-wide text-slate-400 font-bold">
                  {copy.availableProducts}
                </div>
                {addableProducts.length === 0 ? (
                  <div className="text-sm text-slate-500 py-6 text-center">{copy.noMatch}</div>
                ) : (
                  addableProducts.map((product) => {
                    const displayName = resolveName(product, language);
                    const added = selectedIds.has(product.id);
                    const img = productImage(product);
                    return (
                      <div key={product.id} className="flex items-center gap-2 rounded-lg border border-slate-100 p-2">
                        <div className="w-11 h-11 rounded-md overflow-hidden bg-slate-100 shrink-0">
                          {img ? (
                            <img src={img} alt={displayName} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-400">
                              <Tag size={18} />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold text-slate-900 line-clamp-2">{displayName}</p>
                          <p className="text-[11px] text-slate-400 truncate">{product.sku || product.barcode || product.id}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => added ? removeProduct(product.id) : addProduct(product.id)}
                          className={`w-9 h-9 rounded-md flex items-center justify-center shrink-0 ${
                            added
                              ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                              : 'bg-slate-900 text-white hover:bg-slate-800'
                          }`}
                          title={added ? copy.remove : copy.addProducts}
                        >
                          {added ? <Check size={16} /> : <Plus size={16} />}
                        </button>
                      </div>
                    );
                  })
                )}

                {selectedProducts.length > 0 && (
                  <div className="pt-3">
                    <div className="text-[11px] uppercase tracking-wide text-slate-400 font-bold mb-2">
                      {copy.configuredProducts}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedProducts.map((product) => (
                        <button
                          key={product.id}
                          type="button"
                          onClick={() => removeProduct(product.id)}
                          className="max-w-full rounded-md bg-slate-100 text-slate-700 px-2 py-1 text-xs font-semibold hover:bg-red-50 hover:text-red-700 inline-flex items-center gap-1"
                        >
                          <span className="truncate">{resolveName(product, language)}</span>
                          <X size={12} />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
