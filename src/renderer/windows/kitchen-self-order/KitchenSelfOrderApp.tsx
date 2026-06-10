import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChefHat,
  Clock,
  Home,
  Image as ImageIcon,
  Minus,
  Plus,
  Printer,
  ReceiptText,
  Search,
  ShoppingCart,
} from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import {
  normalizeKitchenSelfOrderFulfillment,
  normalizeKitchenSelfOrderLanguage,
  normalizeKitchenSelfOrderQuantity,
  sanitizeKitchenSelfOrderNote,
  type KitchenSelfOrderFulfillment,
  type KitchenSelfOrderLanguage,
} from '../../../shared/kitchen-self-order';
import {
  getCategoryDepartment,
  getProductPriceGrosze,
  normalizeCatalogText,
} from '../self-checkout/catalog-model';
import type {
  CatalogCategory,
  SearchProduct,
} from '../self-checkout/types';

declare global {
  interface Window {
    electronAPI: any;
  }
}

type Step = 'menu' | 'confirm' | 'done';

interface CartItem {
  lineId: string;
  product: SearchProduct;
  quantity: number;
  note: string;
  options: string[];
}

interface SubmitResult {
  success?: boolean;
  orderNumber?: string;
  kitchenPrinted?: boolean;
  customerSlipPrinted?: boolean;
  error?: string | null;
}

const QUICK_OPTIONS: Record<KitchenSelfOrderLanguage, string[]> = {
  pl: ['bez cebuli', 'mniej ostre', 'extra sos', 'bez kolendry'],
  vi: ['khong hanh', 'it cay', 'them sot', 'khong rau mui'],
  en: ['no onion', 'less spicy', 'extra sauce', 'no coriander'],
};

const COPY = {
  pl: {
    chooseLanguage: 'Wybierz jezyk',
    fulfillmentTitle: 'Gdzie jesz?',
    dineIn: 'Na miejscu',
    takeaway: 'Na wynos',
    menu: 'Menu',
    all: 'Wszystko',
    search: 'Szukaj dania',
    cart: 'Koszyk',
    emptyCart: 'Dodaj dania z menu.',
    confirm: 'Sprawdz zamowienie',
    submit: 'Zloz zamowienie',
    submitting: 'Wysylanie...',
    back: 'Wstecz',
    note: 'Notatka dla kuchni',
    doneTitle: 'Numer zamowienia',
    keepNumber: 'Zachowaj numer zamowienia.',
    newOrder: 'Nowe zamowienie',
    kitchenPrinted: 'Kuchnia wydrukowana',
    kitchenFailed: 'Druk kuchni nieudany',
    slipPrinted: 'Slip wydrukowany',
    slipMissing: 'Slip nie jest wydrukowany',
    change: 'Zmien',
    noProducts: 'Brak pozycji menu.',
  },
  vi: {
    chooseLanguage: 'Chon ngon ngu',
    fulfillmentTitle: 'Ban an o dau?',
    dineIn: 'An tai quan',
    takeaway: 'Mang di',
    menu: 'Menu',
    all: 'Tat ca',
    search: 'Tim mon',
    cart: 'Gio mon',
    emptyCart: 'Chon mon trong menu.',
    confirm: 'Kiem tra don',
    submit: 'Dat mon',
    submitting: 'Dang gui...',
    back: 'Quay lai',
    note: 'Ghi chu cho bep',
    doneTitle: 'So don',
    keepNumber: 'Vui long giu so nay de nhan mon.',
    newOrder: 'Don moi',
    kitchenPrinted: 'Da in bep',
    kitchenFailed: 'Chua in duoc bep',
    slipPrinted: 'Da in slip',
    slipMissing: 'Chua in slip',
    change: 'Doi',
    noProducts: 'Chua co mon trong menu.',
  },
  en: {
    chooseLanguage: 'Choose language',
    fulfillmentTitle: 'Where will you eat?',
    dineIn: 'Dine in',
    takeaway: 'Takeaway',
    menu: 'Menu',
    all: 'All',
    search: 'Search dishes',
    cart: 'Cart',
    emptyCart: 'Add dishes from the menu.',
    confirm: 'Review order',
    submit: 'Place order',
    submitting: 'Sending...',
    back: 'Back',
    note: 'Kitchen note',
    doneTitle: 'Order number',
    keepNumber: 'Keep this number for pickup.',
    newOrder: 'New order',
    kitchenPrinted: 'Kitchen printed',
    kitchenFailed: 'Kitchen print failed',
    slipPrinted: 'Slip printed',
    slipMissing: 'Slip not printed',
    change: 'Change',
    noProducts: 'No menu items.',
  },
};
type CopyText = (typeof COPY)[KitchenSelfOrderLanguage];

function formatPLN(grosze: number): string {
  if (!Number.isFinite(grosze) || grosze <= 0) return '';
  return `${(Math.round(grosze) / 100).toFixed(2).replace('.', ',')} zl`;
}

function makeLineId(productId: string): string {
  return `${productId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isKitchenCategory(category: CatalogCategory | undefined): boolean {
  return !!category && (category.kitchen_print === 1 || getCategoryDepartment(category) === 'kitchen');
}

function buildKitchenCatalog(categories: CatalogCategory[], products: SearchProduct[]) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const kitchenProducts = products.filter((product) => isKitchenCategory(product.category_id ? byId.get(product.category_id) : undefined));
  if (kitchenProducts.length === 0) {
    return { categories, products };
  }
  const ids = new Set(kitchenProducts.map((product) => product.category_id).filter(Boolean));
  return {
    categories: categories.filter((category) => ids.has(category.id)),
    products: kitchenProducts,
  };
}

export default function KitchenSelfOrderApp() {
  const [step, setStep] = useState<Step>('menu');
  const [language, setLanguage] = useState<KitchenSelfOrderLanguage>('pl');
  const [fulfillment, setFulfillment] = useState<KitchenSelfOrderFulfillment>('DINE_IN');
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [products, setProducts] = useState<SearchProduct[]>([]);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const t = COPY[language];

  const refreshCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    try {
      const [categoryRows, productRows] = await Promise.all([
        window.electronAPI?.pos?.categories?.getAll?.().catch(() => []),
        window.electronAPI?.pos?.products?.getAll?.().catch(() => []),
      ]);
      const built = buildKitchenCatalog(categoryRows || [], productRows || []);
      setCategories(built.categories);
      setProducts(built.products);
      setActiveCategoryId((current) => current && built.categories.some((category) => category.id === current) ? current : null);
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  useEffect(() => {
    void refreshCatalog();
    const unsubscribe = window.electronAPI?.pos?.sync?.onProductsSynced?.(() => {
      void refreshCatalog();
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [refreshCatalog]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await window.electronAPI?.getConfig?.();
        if (cancelled || !config) return;
        setLanguage(normalizeKitchenSelfOrderLanguage(config.kitchenSelfOrderLanguage));
        setFulfillment(normalizeKitchenSelfOrderFulfillment(config.kitchenSelfOrderDefaultFulfillment));
      } catch {
        /* keep defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleProducts = useMemo(() => {
    const normalized = normalizeCatalogText(query);
    return products
      .filter((product) => !activeCategoryId || product.category_id === activeCategoryId)
      .filter((product) => {
        if (!normalized) return true;
        const haystack = normalizeCatalogText(`${product.name || ''} ${product.sku || ''} ${product.barcode || ''}`);
        return haystack.includes(normalized);
      })
      .slice(0, 80);
  }, [activeCategoryId, products, query]);

  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  const addProduct = (product: SearchProduct) => {
    setCart((current) => {
      const existing = current.find((item) => item.product.id === product.id && item.note === '' && item.options.length === 0);
      if (existing) {
        return current.map((item) => item.lineId === existing.lineId
          ? { ...item, quantity: normalizeKitchenSelfOrderQuantity(item.quantity + 1) }
          : item);
      }
      return [
        ...current,
        {
          lineId: makeLineId(product.id),
          product,
          quantity: 1,
          note: '',
          options: [],
        },
      ];
    });
  };

  const updateCartLine = (lineId: string, patch: Partial<CartItem>) => {
    setCart((current) => current
      .map((item) => item.lineId === lineId ? { ...item, ...patch } : item)
      .filter((item) => item.quantity > 0));
  };

  const resetSession = () => {
    setCart([]);
    setQuery('');
    setActiveCategoryId(null);
    setSubmitResult(null);
    setSubmitting(false);
    setStep('menu');
  };

  const submitOrder = async () => {
    if (cart.length === 0 || submitting) return;
    setSubmitting(true);
    setSubmitResult(null);
    try {
      const result = await window.electronAPI?.kitchenSelfOrder?.submit?.({
        customerLanguage: language,
        fulfillmentType: fulfillment,
        items: cart.map((item) => ({
          variantId: item.product.id,
          productId: item.product.template_id || null,
          name: item.product.name,
          quantity: item.quantity,
          note: sanitizeKitchenSelfOrderNote(item.note),
          options: item.options,
        })),
      });
      setSubmitResult(result || { success: false, error: 'no_response' });
      if (result?.success) {
        setCart([]);
        setStep('done');
      }
    } catch (err: any) {
      setSubmitResult({ success: false, error: err?.message || String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  if (step === 'confirm') {
    return (
      <KioskShell>
        <div className="grid h-full grid-rows-[auto_1fr_auto] gap-5 p-5">
          <header className="flex items-center justify-between gap-4">
            <TopBack onBack={() => setStep('menu')} label={t.back} />
            <h1 className="text-3xl font-black text-[var(--sc-ink)]">{t.confirm}</h1>
            <div className="flex items-center gap-3">
              <FulfillmentToggle
                t={t}
                fulfillment={fulfillment}
                onChange={setFulfillment}
              />
              <LanguageToggle language={language} onChange={setLanguage} />
            </div>
          </header>

          <div className="overflow-y-auto rounded-2xl border border-[var(--sc-border)] bg-white p-4">
            <CartList
              cart={cart}
              language={language}
              t={t}
              editable
              onUpdate={updateCartLine}
            />
          </div>

          {submitResult?.error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
              {submitResult.error}
            </div>
          )}

          <button
            type="button"
            disabled={cart.length === 0 || submitting}
            onClick={submitOrder}
            className="sc-action flex min-h-[78px] items-center justify-center gap-3 text-2xl"
          >
            <ReceiptText size={26} />
            {submitting ? t.submitting : t.submit}
          </button>
        </div>
      </KioskShell>
    );
  }

  if (step === 'done') {
    const orderNumber = submitResult?.orderNumber || 'K----';
    return (
      <KioskShell>
        <div className="mx-auto flex h-full max-w-4xl flex-col items-center justify-center gap-7 px-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <Check size={38} />
          </div>
          <div>
            <div className="text-2xl font-black text-[var(--sc-muted)]">{t.doneTitle}</div>
            <div className="mt-3 rounded-[28px] bg-[var(--sc-ink)] px-12 py-7 text-7xl font-black text-white">
              {orderNumber}
            </div>
            <p className="mt-5 text-2xl font-bold text-[var(--sc-ink)]">{t.keepNumber}</p>
          </div>

          <div className="grid w-full gap-3 md:grid-cols-2">
            <StatusPill
              ok={!!submitResult?.kitchenPrinted}
              icon={<ChefHat size={22} />}
              label={submitResult?.kitchenPrinted ? t.kitchenPrinted : t.kitchenFailed}
            />
            <StatusPill
              ok={!!submitResult?.customerSlipPrinted}
              icon={<Printer size={22} />}
              label={submitResult?.customerSlipPrinted ? t.slipPrinted : t.slipMissing}
            />
          </div>

          <button
            type="button"
            onClick={resetSession}
            className="sc-action flex min-h-[72px] min-w-[260px] items-center justify-center gap-3 px-8 text-xl"
          >
            <Home size={24} />
            {t.newOrder}
          </button>
        </div>
      </KioskShell>
    );
  }

  return (
    <KioskShell>
      <div className="grid h-full grid-cols-[minmax(0,1fr)_390px] gap-5 p-5">
        <main className="grid min-h-0 grid-rows-[auto_auto_1fr] gap-4">
          <header className="flex items-center justify-between gap-5">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-black uppercase tracking-[0.16em] text-[var(--sc-primary-deep)]">
                Saigon Market
              </div>
              <h1 className="text-4xl font-black leading-tight text-[var(--sc-ink)]">{t.menu}</h1>
              <div className="mt-1 flex items-center gap-2 text-base font-bold text-[var(--sc-muted)]">
                <Clock size={16} />
                {fulfillment === 'TAKEAWAY' ? t.takeaway : t.dineIn}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <FulfillmentToggle
                t={t}
                fulfillment={fulfillment}
                onChange={setFulfillment}
              />
              <LanguageToggle language={language} onChange={setLanguage} />
            </div>
          </header>

          <div className="flex gap-3 overflow-x-auto pb-1">
            <CategoryButton
              label={t.all}
              active={!activeCategoryId}
              onClick={() => setActiveCategoryId(null)}
            />
            {categories.map((category) => (
              <CategoryButton
                key={category.id}
                label={resolveName(category, language)}
                active={activeCategoryId === category.id}
                onClick={() => setActiveCategoryId(category.id)}
              />
            ))}
          </div>

          <div className="grid min-h-0 grid-rows-[auto_1fr] gap-4">
            <label className="flex h-14 items-center gap-3 rounded-2xl border border-[var(--sc-border)] bg-white px-4">
              <Search size={22} className="text-[var(--sc-muted)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t.search}
                className="h-full min-w-0 flex-1 bg-transparent text-xl font-bold text-[var(--sc-ink)] outline-none placeholder:text-[var(--sc-muted)]"
              />
            </label>

            <div className="min-h-0 overflow-y-auto pr-1">
              {loadingCatalog ? (
                <div className="flex h-full items-center justify-center rounded-2xl border border-[var(--sc-border)] bg-white text-xl font-bold text-[var(--sc-muted)]">
                  {t.menu}
                </div>
              ) : visibleProducts.length === 0 ? (
                <div className="flex h-full items-center justify-center rounded-2xl border border-[var(--sc-border)] bg-white text-xl font-bold text-[var(--sc-muted)]">
                  {t.noProducts}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
                  {visibleProducts.map((product) => (
                    <ProductCard
                      key={product.id}
                      product={product}
                      language={language}
                      onAdd={addProduct}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </main>

        <aside className="grid min-h-0 grid-rows-[auto_1fr_auto] rounded-2xl border border-[var(--sc-border)] bg-white">
          <div className="flex items-center justify-between border-b border-[var(--sc-border)] p-4">
            <h2 className="flex items-center gap-2 text-2xl font-black text-[var(--sc-ink)]">
              <ShoppingCart size={25} />
              {t.cart}
            </h2>
            <span className="rounded-full bg-[var(--sc-primary-soft)] px-3 py-1 text-sm font-black text-[var(--sc-primary-deep)]">
              {cartCount}
            </span>
          </div>
          <div className="min-h-0 overflow-y-auto p-4">
            <CartList
              cart={cart}
              language={language}
              t={t}
              editable
              onUpdate={updateCartLine}
            />
          </div>
          <div className="border-t border-[var(--sc-border)] p-4">
            <button
              type="button"
              disabled={cart.length === 0}
              onClick={() => setStep('confirm')}
              className="sc-action flex w-full items-center justify-center gap-3 text-xl"
            >
              <Check size={24} />
              {t.confirm}
            </button>
          </div>
        </aside>
      </div>
    </KioskShell>
  );
}

function KioskShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="sc-shell h-full overflow-hidden">
      {children}
    </div>
  );
}

function TopBack({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex min-h-[48px] items-center gap-2 rounded-full border border-[var(--sc-border)] bg-white px-4 text-base font-black text-[var(--sc-ink)]"
    >
      <ArrowLeft size={20} />
      {label}
    </button>
  );
}

function FulfillmentToggle({
  t,
  fulfillment,
  onChange,
}: {
  t: CopyText;
  fulfillment: KitchenSelfOrderFulfillment;
  onChange: (value: KitchenSelfOrderFulfillment) => void;
}) {
  return (
    <div className="flex rounded-full border border-[var(--sc-border)] bg-white p-1">
      {[
        ['DINE_IN', t.dineIn],
        ['TAKEAWAY', t.takeaway],
      ].map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value as KitchenSelfOrderFulfillment)}
          className={`min-h-[42px] rounded-full px-4 text-sm font-black ${
            fulfillment === value
              ? 'bg-[var(--sc-ink)] text-white'
              : 'text-[var(--sc-muted)]'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function LanguageToggle({
  language,
  onChange,
}: {
  language: KitchenSelfOrderLanguage;
  onChange: (value: KitchenSelfOrderLanguage) => void;
}) {
  return (
    <div className="flex rounded-full border border-[var(--sc-border)] bg-white p-1">
      {[
        ['pl', 'PL'],
        ['vi', 'VI'],
        ['en', 'EN'],
      ].map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value as KitchenSelfOrderLanguage)}
          className={`min-h-[42px] rounded-full px-3 text-sm font-black ${
            language === value
              ? 'bg-[var(--sc-primary)] text-white'
              : 'text-[var(--sc-muted)]'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function CategoryButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[46px] shrink-0 rounded-full border px-5 text-base font-black ${
        active
          ? 'border-[var(--sc-ink)] bg-[var(--sc-ink)] text-white'
          : 'border-[var(--sc-border)] bg-white text-[var(--sc-ink)]'
      }`}
    >
      {label}
    </button>
  );
}

function ProductCard({
  product,
  language,
  onAdd,
}: {
  product: SearchProduct;
  language: KitchenSelfOrderLanguage;
  onAdd: (product: SearchProduct) => void;
}) {
  const imageUrl = product.thumbnail_url || product.image_url || '';
  const price = formatPLN(getProductPriceGrosze(product));
  return (
    <button
      type="button"
      onClick={() => onAdd(product)}
      className="sc-focusable flex min-h-[190px] flex-col overflow-hidden rounded-2xl border border-[var(--sc-border)] bg-white text-left shadow-[0_12px_28px_rgba(32,36,33,0.07)]"
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          className="h-24 w-full object-cover"
          onError={(event) => { (event.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      ) : (
        <div className="flex h-24 w-full items-center justify-center bg-[var(--sc-surface-muted)] text-[var(--sc-muted)]">
          <ImageIcon size={34} />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <div className="line-clamp-2 text-lg font-black leading-snug text-[var(--sc-ink)]">
          {resolveName(product, language)}
        </div>
        <div className="mt-auto pt-2 text-lg font-black text-[var(--sc-primary-deep)]">
          {price}
        </div>
      </div>
    </button>
  );
}

function CartList({
  cart,
  language,
  t,
  editable,
  onUpdate,
}: {
  cart: CartItem[];
  language: KitchenSelfOrderLanguage;
  t: CopyText;
  editable: boolean;
  onUpdate: (lineId: string, patch: Partial<CartItem>) => void;
}) {
  if (cart.length === 0) {
    return (
      <div className="flex min-h-[180px] items-center justify-center rounded-xl bg-[var(--sc-surface-muted)] px-4 text-center text-lg font-bold text-[var(--sc-muted)]">
        {t.emptyCart}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {cart.map((item) => (
        <div key={item.lineId} className="rounded-xl border border-[var(--sc-border)] bg-white p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-base font-black leading-snug text-[var(--sc-ink)]">
                {resolveName(item.product, language)}
              </div>
              {item.options.length > 0 && (
                <div className="mt-1 text-sm font-bold text-[var(--sc-primary-deep)]">
                  {item.options.join(', ')}
                </div>
              )}
            </div>
            {editable && (
              <div className="flex shrink-0 items-center gap-2">
                <QtyButton onClick={() => onUpdate(item.lineId, { quantity: item.quantity - 1 })}>
                  <Minus size={18} />
                </QtyButton>
                <div className="w-8 text-center text-lg font-black">{item.quantity}</div>
                <QtyButton onClick={() => onUpdate(item.lineId, { quantity: normalizeKitchenSelfOrderQuantity(item.quantity + 1) })}>
                  <Plus size={18} />
                </QtyButton>
              </div>
            )}
          </div>

          {editable && (
            <>
              <div className="mt-3 flex flex-wrap gap-2">
                {QUICK_OPTIONS[language].map((option) => {
                  const selected = item.options.includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => onUpdate(item.lineId, {
                        options: selected
                          ? item.options.filter((value) => value !== option)
                          : [...item.options, option],
                      })}
                      className={`rounded-full border px-3 py-2 text-xs font-black ${
                        selected
                          ? 'border-[var(--sc-primary)] bg-[var(--sc-primary-soft)] text-[var(--sc-primary-deep)]'
                          : 'border-[var(--sc-border)] bg-white text-[var(--sc-muted)]'
                      }`}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
              <input
                value={item.note}
                onChange={(event) => onUpdate(item.lineId, { note: event.target.value })}
                placeholder={t.note}
                className="mt-3 h-11 w-full rounded-xl border border-[var(--sc-border)] bg-[var(--sc-surface-muted)] px-3 text-sm font-bold text-[var(--sc-ink)] outline-none focus:ring-2 focus:ring-[var(--sc-primary)]/30"
              />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function QtyButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--sc-border)] bg-[var(--sc-surface-muted)] text-[var(--sc-ink)]"
    >
      {children}
    </button>
  );
}

function StatusPill({
  ok,
  icon,
  label,
}: {
  ok: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div className={`flex min-h-[62px] items-center justify-center gap-2 rounded-xl border px-4 text-base font-black ${
      ok
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
        : 'border-amber-200 bg-amber-50 text-amber-800'
    }`}>
      {icon}
      {label}
    </div>
  );
}
