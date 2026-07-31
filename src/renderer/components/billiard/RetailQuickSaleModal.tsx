/**
 * Walk-in retail (quick sale): sell F&B to guests without a table. The server
 * creates a settled fnb_only billiard session in one shot, so the revenue
 * lands in billiard analytics and the kitchen flush pipeline — unlike the
 * generic POS cart. Online-only: the receipt needs the server's session id
 * and authoritative change amount.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Banknote,
  CreditCard,
  Loader2,
  Minus,
  Plus,
  Printer,
  ShoppingCart,
  Smartphone,
  Landmark,
  Trash2,
  X,
} from 'lucide-react';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useToast } from './Toast';
import {
  useFnbCategories,
  useFnbProducts,
  useQuickSale,
  QuickSaleItemInput,
} from '../../hooks/useBilliardData';
import TextInput from '../shared/TextInput';
import { normalizeBilliardCatalogProduct } from '../../../shared/billiard-contract';
import {
  HOME_KEY,
  filterProductsByFacility,
  groupCategoriesByFacility,
  stripFacilityPrefix,
} from './fnb-facilities';

interface RetailQuickSaleModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  language: Language;
  online: boolean;
  onSold?: () => void;
}

type PayMethod = 'CASH' | 'CARD' | 'BLIK' | 'TRANSFER';

interface CartLine extends QuickSaleItemInput {
  /** Stable row key: variantId for catalog lines, synthetic for custom ones. */
  key: string;
  displayName: string;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(value);
}

function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (event.key !== 'Tab' || !dialog) return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ));
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!dialog.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function RetailQuickSaleModal({
  open,
  onOpenChange,
  language,
  online,
  onSold,
}: RetailQuickSaleModalProps) {
  const { t } = useTranslation(language);
  const toast = useToast();
  const dialogRef = useRef<HTMLDivElement>(null);

  const tOr = (key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  };

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedFacility, setSelectedFacility] = useState(HOME_KEY);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [method, setMethod] = useState<PayMethod>('CASH');
  const [cashReceived, setCashReceived] = useState('');
  const [done, setDone] = useState<{
    sessionId: string;
    total: number;
    changeAmount: number;
    method: PayMethod;
  } | null>(null);

  const quickSale = useQuickSale();

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    if (!open) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !quickSale.isPending) onOpenChange(false);
      trapDialogFocus(event, dialogRef.current);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [open, onOpenChange, quickSale.isPending]);

  const { data: categoriesData } = useFnbCategories();
  const {
    data: productsData,
    loading: productsLoading,
  } = useFnbProducts(
    { search: debouncedSearch || undefined, categoryId: selectedCategory || undefined },
    { enabled: open },
  );
  const categories = (categoriesData ?? []) as any[];
  const products = (productsData ?? []) as any[];

  const facilityGrouping = useMemo(
    () => groupCategoriesByFacility(categories),
    [categories],
  );
  const activeFacility =
    facilityGrouping.facilities.find((f) => f.key === selectedFacility)
    ?? facilityGrouping.facilities[0];
  const visibleCategories = facilityGrouping.hasTags
    ? activeFacility?.categories ?? []
    : categories;
  const visibleProducts = useMemo(
    () => filterProductsByFacility(
      products,
      activeFacility?.key ?? HOME_KEY,
      facilityGrouping,
    ),
    [products, facilityGrouping, activeFacility?.key],
  );

  const total = cart.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const cashValue = Number.parseFloat(cashReceived.replace(',', '.'));
  const cashOk = method !== 'CASH' || (!Number.isNaN(cashValue) && cashValue >= total);

  const addToCart = (product: any) => {
    const item = normalizeBilliardCatalogProduct(product);
    if (!item.variantId || !item.hasStock) return;
    const key = `${item.variantId}:${item.price}`;
    setCart((prev) => {
      const existing = prev.find((line) => line.key === key);
      if (existing) {
        return prev.map((line) =>
          line.key === key ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [...prev, {
        key,
        variantId: item.variantId,
        name: item.name,
        displayName: stripFacilityPrefix(item.name),
        quantity: 1,
        unitPrice: item.price,
      }];
    });
  };

  const bumpQuantity = (key: string, delta: number) => {
    setCart((prev) => prev
      .map((line) => (line.key === key ? { ...line, quantity: line.quantity + delta } : line))
      .filter((line) => line.quantity > 0));
  };

  const reset = () => {
    setCart([]);
    setCustomerName('');
    setMethod('CASH');
    setCashReceived('');
    setDone(null);
  };

  const handleSell = async () => {
    if (cart.length === 0 || !cashOk || quickSale.isPending) return;
    try {
      const result = await quickSale.mutate({
        items: cart.map(({ variantId, name, quantity, unitPrice }) => ({
          variantId, name, quantity, unitPrice,
        })),
        paymentMethod: method,
        cashReceived: method === 'CASH' && !Number.isNaN(cashValue) ? cashValue : undefined,
        customerName: customerName.trim() || undefined,
      });
      const session = result?.session;
      if (!session?.id) throw new Error(tOr('billiard.retailSaleFailed', 'Sale failed'));
      setDone({
        sessionId: session.id,
        total,
        changeAmount: Number(result?.changeAmount ?? 0),
        method,
      });
      if (method === 'CASH') {
        void window.electronAPI.billiard.openCashDrawer?.();
      }
      onSold?.();
    } catch (err: any) {
      toast.error(err?.message || tOr('billiard.retailSaleFailed', 'Sale failed'));
    }
  };

  const handlePrint = async () => {
    if (!done) return;
    try {
      await window.electronAPI.billiard.printReceipt(done.sessionId, {
        method: done.method,
        amount: done.total,
      });
      toast.success(tOr('billiard.receiptPrinted', 'Receipt printed'));
    } catch (err: any) {
      toast.error(err?.message || tOr('billiard.printFailed', 'Print failed'));
    }
  };

  if (!open) return null;

  const methodButtons: Array<{ key: PayMethod; label: string; icon: typeof Banknote }> = [
    { key: 'CASH', label: tOr('billiard.cash', 'Cash'), icon: Banknote },
    { key: 'CARD', label: tOr('billiard.card', 'Card'), icon: CreditCard },
    { key: 'BLIK', label: 'BLIK', icon: Smartphone },
    { key: 'TRANSFER', label: tOr('billiard.payTransfer', 'Transfer'), icon: Landmark },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-2 sm:p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="flex h-full max-h-[44rem] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold text-slate-800">
            <ShoppingCart className="h-5 w-5 text-brand-600" />
            {tOr('billiard.retailQuickSale', 'Retail sale (no table)')}
          </div>
          <button
            type="button"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
            onClick={() => onOpenChange(false)}
            disabled={quickSale.isPending}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {done ? (
          /* ── Success screen ── */
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <div className="text-lg font-semibold text-emerald-600">
              {tOr('billiard.retailSaleDone', 'Paid')} — {formatCurrency(done.total)}
            </div>
            {done.method === 'CASH' && (
              <div className="text-3xl font-bold tabular-nums text-slate-800">
                {tOr('billiard.change', 'Change')}: {formatCurrency(done.changeAmount)}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-slate-800 px-4 font-semibold text-white hover:bg-slate-700"
                onClick={() => void handlePrint()}
              >
                <Printer className="h-4 w-4" />
                {tOr('billiard.printReceipt', 'Print receipt')}
              </button>
              <button
                type="button"
                className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-brand-600 px-4 font-semibold text-white hover:bg-brand-500"
                onClick={reset}
              >
                <Plus className="h-4 w-4" />
                {tOr('billiard.retailNewSale', 'New sale')}
              </button>
              <button
                type="button"
                className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-4 font-semibold text-slate-600 hover:bg-slate-50"
                onClick={() => { reset(); onOpenChange(false); }}
              >
                {tOr('common.close', 'Close')}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* ── Catalog ── */}
            <div className="flex min-w-0 flex-1 flex-col border-r border-slate-200">
              {facilityGrouping.hasTags && (
                <div className="flex gap-1 overflow-x-auto border-b border-slate-100 px-3 pt-2">
                  {facilityGrouping.facilities.map((facility) => (
                    <button
                      key={facility.key}
                      type="button"
                      className={`whitespace-nowrap rounded-t-lg px-3 py-1.5 text-sm font-medium ${
                        facility.key === (activeFacility?.key ?? HOME_KEY)
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-slate-500 hover:bg-slate-50'
                      }`}
                      onClick={() => { setSelectedFacility(facility.key); setSelectedCategory(null); }}
                    >
                      {facility.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2 p-3">
                <TextInput
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={tOr('billiard.searchProducts', 'Search products…')}
                  className="flex-1"
                />
              </div>
              <div className="flex gap-1 overflow-x-auto px-3 pb-2">
                <button
                  type="button"
                  className={`whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium ${
                    selectedCategory === null
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                  }`}
                  onClick={() => setSelectedCategory(null)}
                >
                  {tOr('billiard.allCategories', 'All')}
                </button>
                {visibleCategories.map((category: any) => (
                  <button
                    key={category.id}
                    type="button"
                    className={`whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium ${
                      selectedCategory === category.id
                        ? 'border-brand-500 bg-brand-50 text-brand-700'
                        : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                    }`}
                    onClick={() => setSelectedCategory(category.id)}
                  >
                    {stripFacilityPrefix(category.name)}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                {productsLoading && !products ? (
                  <div className="flex justify-center py-10">
                    <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {visibleProducts.map((product: any) => {
                      const item = normalizeBilliardCatalogProduct(product);
                      const disabled = !item.variantId || !item.hasStock;
                      return (
                        <button
                          key={item.variantId || product.id}
                          type="button"
                          disabled={disabled}
                          className={`flex min-h-[5.5rem] flex-col justify-between rounded-lg border p-2 text-left ${
                            disabled
                              ? 'cursor-not-allowed border-slate-100 bg-slate-50 opacity-50'
                              : 'border-slate-200 bg-white hover:border-brand-400 hover:bg-brand-50/40'
                          }`}
                          onClick={() => addToCart(product)}
                        >
                          <span className="line-clamp-2 text-sm font-medium text-slate-800">
                            {stripFacilityPrefix(item.name)}
                          </span>
                          <span className="text-sm font-semibold tabular-nums text-brand-700">
                            {formatCurrency(item.price)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* ── Cart + payment ── */}
            <div className="flex w-[19rem] shrink-0 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {cart.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center text-center text-sm text-slate-400">
                    <ShoppingCart className="mb-2 h-8 w-8 opacity-40" />
                    {tOr('billiard.retailEmptyCart', 'Pick products from the left')}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {cart.map((line) => (
                      <div key={line.key} className="rounded-lg border border-slate-200 p-2">
                        <div className="flex items-start justify-between gap-2">
                          <span className="line-clamp-2 text-sm font-medium text-slate-800">
                            {line.displayName}
                          </span>
                          <button
                            type="button"
                            className="p-1 text-slate-400 hover:text-red-600"
                            onClick={() => bumpQuantity(line.key, -line.quantity)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="mt-1 flex items-center justify-between">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              className="rounded border border-slate-200 p-1 hover:bg-slate-50"
                              onClick={() => bumpQuantity(line.key, -1)}
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <span className="w-8 text-center text-sm tabular-nums">{line.quantity}</span>
                            <button
                              type="button"
                              className="rounded border border-slate-200 p-1 hover:bg-slate-50"
                              onClick={() => bumpQuantity(line.key, 1)}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <span className="text-sm font-semibold tabular-nums text-slate-700">
                            {formatCurrency(line.quantity * line.unitPrice)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2 border-t border-slate-200 p-3">
                <TextInput
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder={tOr('billiard.retailCustomerName', 'Customer name (optional)')}
                />
                <div className="grid grid-cols-4 gap-1">
                  {methodButtons.map(({ key, label, icon: Icon }) => (
                    <button
                      key={key}
                      type="button"
                      className={`flex min-h-11 flex-col items-center justify-center rounded-lg border text-[11px] font-medium ${
                        method === key
                          ? 'border-brand-500 bg-brand-50 text-brand-700'
                          : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                      }`}
                      onClick={() => setMethod(key)}
                    >
                      <Icon className="mb-0.5 h-4 w-4" />
                      {label}
                    </button>
                  ))}
                </div>
                {method === 'CASH' && (
                  <TextInput
                    value={cashReceived}
                    onChange={(e) => setCashReceived(e.target.value)}
                    placeholder={tOr('billiard.retailCashReceived', 'Cash received')}
                    inputMode="decimal"
                  />
                )}
                {!online && (
                  <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
                    {tOr('billiard.retailNeedsNetwork', 'Network required for retail sale')}
                  </div>
                )}
                <button
                  type="button"
                  disabled={!online || cart.length === 0 || !cashOk || quickSale.isPending}
                  className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 font-semibold text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void handleSell()}
                >
                  {quickSale.isPending
                    ? <Loader2 className="h-5 w-5 animate-spin" />
                    : <Banknote className="h-5 w-5" />}
                  {tOr('billiard.retailPayNow', 'Take payment')} · {formatCurrency(total)}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
