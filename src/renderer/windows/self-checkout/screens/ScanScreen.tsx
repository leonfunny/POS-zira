// Scan + cart screen. Scanner remains the primary path; category
// browsing is a fallback for products without a readable barcode.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Hand,
  Minus,
  PackageSearch,
  Plus,
  ScanBarcode,
  ShoppingCart,
  Trash2,
  X,
} from 'lucide-react';
import { ScLanguage, SC_LANGUAGES, getScStrings } from '../i18n';
import { ScCartItem, formatPLN } from '../useScCart';

interface ScCategory {
  id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
}

interface BrowseProduct {
  id: string;
  template_id?: string | null;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  retail_price?: number;
  price?: number;
  price_gross?: number;
  vat_rate?: number;
  image_url?: string | null;
  thumbnail_url?: string | null;
  in_stock?: number;
  available_qty?: number;
}

interface ScanScreenProps {
  lang: ScLanguage;
  cartItems: ScCartItem[];
  totalGrosze: number;
  categories: ScCategory[];
  onScan: (ean: string) => Promise<unknown> | unknown;
  scanQuantity: number;
  onScanQuantityChange: (quantity: number) => void;
  onProductSelect: (product: BrowseProduct) => void;
  onIncrement: (variantId: string) => void;
  onDecrement: (variantId: string) => void;
  onRemove: (variantId: string) => void;
  onCheckout: () => void;
  onCallStaff: () => void;
  onAbandon: () => void;
  onLangChange: (lang: ScLanguage) => void;
  toast?: { kind: 'ok' | 'error'; text: string } | null;
}

export default function ScanScreen({
  lang,
  cartItems,
  totalGrosze,
  categories,
  onScan,
  scanQuantity,
  onScanQuantityChange,
  onProductSelect,
  onIncrement,
  onDecrement,
  onRemove,
  onCheckout,
  onCallStaff,
  onAbandon,
  onLangChange,
  toast,
}: ScanScreenProps) {
  const t = getScStrings(lang);
  const [categoryOpen, setCategoryOpen] = useState<ScCategory | null>(null);
  const [categoryProducts, setCategoryProducts] = useState<BrowseProduct[]>([]);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const scannerInputRef = useRef<HTMLInputElement>(null);
  const scannerBuffer = useRef<string>('');
  const scannerLastKey = useRef<number>(0);
  const lastScanRef = useRef<{ code: string; at: number } | null>(null);

  const handleScannedCode = useCallback(
    (rawCode: string) => {
      const code = rawCode.trim();
      if (code.length < 4) return;
      const now = Date.now();
      if (lastScanRef.current?.code === code && now - lastScanRef.current.at < 600) return;
      lastScanRef.current = { code, at: now };
      setCategoryOpen(null);
      void onScan(code);
    },
    [onScan],
  );

  const focusScannerInput = useCallback(() => {
    scannerInputRef.current?.focus();
  }, []);

  const handleScannerInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const code = e.currentTarget.value;
      e.currentTarget.value = '';
      handleScannedCode(code);
    },
    [handleScannedCode],
  );

  useEffect(() => {
    focusScannerInput();
    const handler = () => setTimeout(focusScannerInput, 50);
    document.addEventListener('pointerdown', handler);
    const interval = setInterval(focusScannerInput, 1000);
    return () => {
      document.removeEventListener('pointerdown', handler);
      clearInterval(interval);
    };
  }, [focusScannerInput]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.dataset?.scannerCapture === 'true') return;
      const now = Date.now();
      if (now - scannerLastKey.current > 150) {
        scannerBuffer.current = '';
      }
      scannerLastKey.current = now;
      if (e.key === 'Enter') {
        const code = scannerBuffer.current.trim();
        scannerBuffer.current = '';
        handleScannedCode(code);
        return;
      }
      if (e.key.length === 1 && /[0-9A-Za-z\-_]/.test(e.key)) {
        scannerBuffer.current += e.key;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleScannedCode]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onBarcodeScanned?.((barcode: string) => {
      handleScannedCode(barcode);
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [handleScannedCode]);

  const openCategory = useCallback(async (category: ScCategory) => {
    setCategoryOpen(category);
    setCategoryProducts([]);
    setCategoryLoading(true);
    try {
      const products = await window.electronAPI?.pos?.products?.getByCategory?.(category.id);
      if (Array.isArray(products)) setCategoryProducts(products.slice(0, 30));
    } catch {
      setCategoryProducts([]);
    } finally {
      setCategoryLoading(false);
    }
  }, []);

  const productCount = cartItems.reduce((sum, item) => sum + (item.isBagFee ? 0 : item.quantity), 0);

  return (
    <div className="sc-shell flex h-screen w-screen flex-col overflow-hidden select-none">
      <input
        ref={scannerInputRef}
        onKeyDown={handleScannerInputKeyDown}
        inputMode="none"
        data-scanner-capture="true"
        aria-label="Barcode scanner"
        tabIndex={-1}
        className="pointer-events-none fixed h-px w-px opacity-0"
      />
      <header className="flex items-center justify-between border-b border-[var(--sc-border)] bg-white/95 px-8 py-4">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--sc-primary)] text-xl font-black text-white">
            Z
          </div>
          <div>
            <div className="text-sm font-black uppercase tracking-[0.16em] text-[var(--sc-primary-deep)]">
              Zira AI
            </div>
            <div className="text-sm font-semibold text-[var(--sc-muted)]">
              Self-checkout
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden gap-2 md:flex">
            {SC_LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => onLangChange(l.code)}
                className="sc-language-button sc-focusable !min-h-[46px] !min-w-[58px]"
                data-active={l.code === lang}
                aria-label={l.label}
              >
                {l.flag}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onCallStaff}
            className="sc-secondary-action sc-focusable flex items-center gap-2 px-5 text-base text-amber-800"
          >
            <Hand size={20} />
            {t.callStaff}
          </button>
          <button
            type="button"
            onClick={onAbandon}
            className="sc-danger-action sc-focusable px-5 text-base"
          >
            {t.abandon}
          </button>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_430px] gap-5 p-5">
        <section className="flex min-h-0 flex-col gap-5">
          <div className="sc-surface flex min-h-[330px] flex-1 flex-col justify-center p-8">
            <div className="flex items-center gap-8">
              <div className="flex h-32 w-32 shrink-0 items-center justify-center rounded-[34px] bg-[var(--sc-primary-soft)] text-[var(--sc-primary-deep)]">
                <ScanBarcode size={82} />
              </div>
              <div className="min-w-0">
                <h1 className="text-6xl font-black tracking-tight text-[var(--sc-ink)]">
                  {t.scanPrompt}
                </h1>
                <p className="mt-4 text-2xl font-semibold leading-9 text-[var(--sc-muted)]">
                  {t.scanHint}
                </p>
                <div className="mt-7 inline-flex items-center gap-4 rounded-3xl border-2 border-[var(--sc-border)] bg-white p-3">
                  <div className="px-3">
                    <div className="text-base font-black text-[var(--sc-ink)]">
                      {t.scanQuantity}
                    </div>
                    <div className="text-sm font-semibold text-[var(--sc-muted)]">
                      {t.scanQuantityHint}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onScanQuantityChange(scanQuantity - 1)}
                    disabled={scanQuantity <= 1}
                    className="sc-focusable flex h-16 w-16 items-center justify-center rounded-2xl border-2 border-[var(--sc-border)] bg-[var(--sc-surface-muted)] text-[var(--sc-ink)] disabled:opacity-35"
                    aria-label="-"
                  >
                    <Minus size={28} />
                  </button>
                  <div className="sc-tabular flex h-16 min-w-[88px] items-center justify-center rounded-2xl bg-[var(--sc-primary-soft)] px-5 text-4xl font-black text-[var(--sc-primary-deep)]">
                    {scanQuantity}
                  </div>
                  <button
                    type="button"
                    onClick={() => onScanQuantityChange(scanQuantity + 1)}
                    disabled={scanQuantity >= 99}
                    className="sc-focusable flex h-16 w-16 items-center justify-center rounded-2xl border-2 border-[var(--sc-border)] bg-[var(--sc-surface-muted)] text-[var(--sc-ink)] disabled:opacity-35"
                    aria-label="+"
                  >
                    <Plus size={28} />
                  </button>
                </div>
              </div>
            </div>

            {toast && (
              <div
                role={toast.kind === 'error' ? 'alert' : 'status'}
                className={`mt-8 rounded-2xl border px-5 py-4 text-xl font-black ${
                  toast.kind === 'ok'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-red-200 bg-red-50 text-[var(--sc-danger)]'
                }`}
              >
                {toast.text}
              </div>
            )}
          </div>

          <div className="sc-surface-flat p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-2xl font-black text-[var(--sc-ink)]">
                {t.popularCategories}
              </h2>
              <span className="text-sm font-semibold text-[var(--sc-muted)]">
                {t.scanAgain}
              </span>
            </div>
            {categories.length > 0 ? (
              <div className="grid grid-cols-4 gap-3">
                {categories.slice(0, 8).map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => openCategory(category)}
                    className="sc-secondary-action sc-focusable flex min-h-[76px] items-center justify-center px-3 text-center text-lg leading-tight"
                  >
                    {category.name}
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl bg-[var(--sc-surface-muted)] px-5 py-6 text-lg font-semibold text-[var(--sc-muted)]">
                {t.noCategories}
              </div>
            )}
          </div>
        </section>

        <aside className="sc-surface flex min-h-0 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--sc-border)] px-5 py-4">
            <div className="flex items-center gap-3">
              <ShoppingCart size={26} className="text-[var(--sc-primary-deep)]" />
              <div>
                <div className="text-2xl font-black text-[var(--sc-ink)]">
                  {t.total}
                </div>
                <div className="text-sm font-semibold text-[var(--sc-muted)]">
                  {productCount} {t.items}
                </div>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {cartItems.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                <PackageSearch size={64} className="mb-5 text-[var(--sc-border)]" />
                <div className="text-2xl font-black text-[var(--sc-ink)]">
                  {t.emptyCart}
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-[var(--sc-border)]">
                {cartItems.map((item) => (
                  <li
                    key={item.variantId + (item.isBagFee ? '-bag' : '')}
                    className="px-5 py-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-xl font-black leading-snug text-[var(--sc-ink)]">
                          {item.name}
                        </div>
                        <div className="mt-1 text-base font-semibold text-[var(--sc-muted)]">
                          {formatPLN(item.price)}
                          {item.sku ? ` · ${item.sku}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onRemove(item.variantId)}
                        className="sc-focusable flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-[var(--sc-muted)] hover:bg-red-50 hover:text-[var(--sc-danger)]"
                        aria-label={t.remove}
                      >
                        <Trash2 size={22} />
                      </button>
                    </div>
                    <div className="mt-4 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => onDecrement(item.variantId)}
                        className="sc-focusable flex h-12 w-12 items-center justify-center rounded-xl border-2 border-[var(--sc-border)] bg-white font-black hover:bg-[var(--sc-surface-muted)]"
                        aria-label="-"
                      >
                        <Minus size={22} />
                      </button>
                      <span className="sc-tabular min-w-[3ch] text-center text-2xl font-black">
                        {item.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => onIncrement(item.variantId)}
                        disabled={item.isBagFee}
                        className="sc-focusable flex h-12 w-12 items-center justify-center rounded-xl border-2 border-[var(--sc-border)] bg-white font-black hover:bg-[var(--sc-surface-muted)] disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label="+"
                      >
                        <Plus size={22} />
                      </button>
                      <span className="sc-tabular ml-auto text-xl font-black text-[var(--sc-ink)]">
                        {formatPLN(item.price * item.quantity)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-[var(--sc-border)] bg-white p-5">
            <div className="mb-4 flex items-end justify-between gap-4">
              <span className="text-xl font-black text-[var(--sc-muted)]">
                {t.total}
              </span>
              <span className="sc-tabular text-5xl font-black tracking-tight text-[var(--sc-ink)]">
                {formatPLN(totalGrosze)}
              </span>
            </div>
            <button
              type="button"
              onClick={onCheckout}
              disabled={cartItems.length === 0}
              className="sc-action sc-action-success sc-focusable flex w-full items-center justify-center gap-3 text-2xl"
            >
              {t.pay}
            </button>
          </div>
        </aside>
      </main>

      {categoryOpen && (
        <CategoryBrowser
          title={categoryOpen.name}
          t={t}
          products={categoryProducts}
          loading={categoryLoading}
          onClose={() => setCategoryOpen(null)}
          onSelect={(product) => {
            onProductSelect(product);
            setCategoryOpen(null);
          }}
        />
      )}
    </div>
  );
}

interface CategoryBrowserProps {
  title: string;
  t: ReturnType<typeof getScStrings>;
  products: BrowseProduct[];
  loading: boolean;
  onClose: () => void;
  onSelect: (product: BrowseProduct) => void;
}

function CategoryBrowser({
  title,
  t,
  products,
  loading,
  onClose,
  onSelect,
}: CategoryBrowserProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-8">
      <section className="sc-surface flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-[var(--sc-border)] px-6 py-5">
          <div>
            <div className="text-sm font-bold uppercase tracking-[0.12em] text-[var(--sc-muted)]">
              {t.productsInCategory}
            </div>
            <h2 className="mt-1 text-3xl font-black text-[var(--sc-ink)]">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="sc-focusable flex h-14 w-14 items-center justify-center rounded-2xl border-2 border-[var(--sc-border)] bg-white hover:bg-[var(--sc-surface-muted)]"
            aria-label={t.close}
          >
            <X size={26} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex min-h-[320px] items-center justify-center text-2xl font-black text-[var(--sc-muted)]">
              ...
            </div>
          ) : products.length === 0 ? (
            <div className="flex min-h-[320px] items-center justify-center text-2xl font-black text-[var(--sc-muted)]">
              {t.emptyCart}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4">
              {products.map((product) => {
                const price = product.retail_price ?? product.price ?? product.price_gross ?? 0;
                return (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => onSelect(product)}
                    className="sc-focusable min-h-[150px] rounded-2xl border border-[var(--sc-border)] bg-white p-4 text-left hover:border-[var(--sc-primary)] hover:bg-[var(--sc-primary-soft)]"
                  >
                    <div className="line-clamp-2 text-xl font-black leading-tight text-[var(--sc-ink)]">
                      {product.name}
                    </div>
                    <div className="mt-3 text-sm font-semibold text-[var(--sc-muted)]">
                      {product.sku || product.barcode || ''}
                    </div>
                    <div className="mt-5 flex items-end justify-between gap-3">
                      <span className="sc-tabular text-2xl font-black text-[var(--sc-ink)]">
                        {formatPLN(Math.round(Number(price) || 0))}
                      </span>
                      <span className="rounded-full bg-[var(--sc-primary)] px-4 py-2 text-sm font-black text-white">
                        {t.addProduct}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

interface ManualNumpadProps {
  title: string;
  value: string;
  onChange: (next: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  okLabel: string;
  cancelLabel: string;
  maxLength?: number;
}

export function ManualNumpad({
  title,
  value,
  onChange,
  onCancel,
  onSubmit,
  okLabel,
  cancelLabel,
  maxLength = 14,
}: ManualNumpadProps) {
  const press = (k: string) => {
    if (k === '<') onChange(value.slice(0, -1));
    else if (value.length < maxLength) onChange(value + k);
  };
  const keys = ['1','2','3','4','5','6','7','8','9','<','0','OK'];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-6">
      <div className="sc-surface w-[440px] p-6">
        {title && (
          <h3 className="mb-4 text-center text-3xl font-black text-[var(--sc-ink)]">
            {title}
          </h3>
        )}
        <div className="sc-tabular mb-4 h-20 rounded-2xl border-2 border-[var(--sc-border)] bg-[var(--sc-surface-muted)] px-4 text-center text-4xl font-black leading-[76px] tracking-widest text-[var(--sc-ink)]">
          {value || <span className="text-[var(--sc-muted)]">-</span>}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {keys.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => (k === 'OK' ? onSubmit() : press(k))}
              className={`sc-focusable h-20 rounded-2xl text-2xl font-black transition-colors ${
                k === 'OK'
                  ? 'bg-[var(--sc-success)] text-white hover:bg-emerald-800'
                  : 'border-2 border-[var(--sc-border)] bg-white text-[var(--sc-ink)] hover:bg-[var(--sc-surface-muted)]'
              }`}
              aria-label={k}
            >
              {k === '<' ? 'Del' : k === 'OK' ? okLabel : k}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="sc-secondary-action sc-focusable mt-4 w-full text-lg"
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
