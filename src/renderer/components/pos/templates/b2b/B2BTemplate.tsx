import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { Product, Category } from '../../../../hooks/usePosDb';
import type { PosState, PosAction } from '../../../../hooks/usePosStore';
import CategoryTabs from '../../CategoryTabs';
import SearchBar from '../../SearchBar';
import ProductGrid from '../../ProductGrid';
import Cart from '../../Cart';
import PaymentModal from '../../PaymentModal';
import CustomerPanel from './CustomerPanel';

interface B2BCustomer {
  id: string;
  name: string;
  nip: string | null;
  email: string | null;
  phone: string | null;
  credit_limit: number;
  current_debt: number;
  payment_terms: number;
}

interface B2BTemplateProps {
  state: PosState;
  dispatch: (action: PosAction) => void;
  t: (key: string) => string;
  language?: string;
  session: PosState['session'];
}

export default function B2BTemplate({ state, dispatch, t, language, session }: B2BTemplateProps) {
  const [customers, setCustomers] = useState<B2BCustomer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<B2BCustomer | null>(null);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCustomerPrompt, setShowCustomerPrompt] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [paymentPrefillCashGrosze, setPaymentPrefillCashGrosze] = useState<number | undefined>(undefined);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  const cart = state.cart;
  const lang = language || 'pl';
  const canSell = !!selectedCustomer;
  const tOr = useCallback((key: string, fallback: string) => {
    const value = t(key);
    return value !== key ? value : fallback;
  }, [t]);
  const shiftPaymentOpen = session.isOpen;
  const shiftBlockedMessage = !session.isOpen
    ? tOr('pos.shift.openRequired', 'Open a shift to accept payments')
    : undefined;

  // Load customers
  useEffect(() => {
    window.electronAPI.pos.customers.getAll().then(setCustomers);
  }, []);

  // Load categories + products
  useEffect(() => {
    window.electronAPI.pos.categories.getAll().then(setCategories);
  }, []);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let result: Product[];
      if (searchQuery) {
        result = await window.electronAPI.pos.products.search(searchQuery);
        if (activeCategoryId) result = result.filter((p) => p.category_id === activeCategoryId);
      } else if (activeCategoryId) {
        result = await window.electronAPI.pos.products.getByCategory(activeCategoryId);
      } else {
        result = await window.electronAPI.pos.products.getAll();
      }
      if (!cancelled) setProducts(result);
    };
    if (searchQuery) {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(load, 250);
    } else {
      load();
    }
    return () => { cancelled = true; if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [activeCategoryId, searchQuery]);

  useEffect(() => {
    const unsub = window.electronAPI.pos.sync.onProductsSynced(() => {
      window.electronAPI.pos.products.getAll().then(setProducts);
      window.electronAPI.pos.categories.getAll().then(setCategories);
    });
    return unsub;
  }, []);

  const handleSelectCustomer = useCallback((customer: B2BCustomer | null) => {
    setSelectedCustomer(customer);
    if (customer) {
      dispatch({ type: 'customer/select', payload: { id: customer.id, name: customer.name, nip: customer.nip || undefined } });
    } else {
      dispatch({ type: 'customer/clear' });
    }
  }, [dispatch]);

  const handleAddProduct = useCallback((product: Product) => {
    if (product.category_id !== 'cat-5' && (product.available_qty ?? product.in_stock) <= 0) return;
    if (!selectedCustomer) {
      setShowCustomerPrompt(true);
      return;
    }
    dispatch({
      type: 'cart/addItem',
      payload: {
        id: crypto.randomUUID(),
        variantId: product.id,
        name: product.name,
        name_translations: product.name_translations ?? null,
        sku: product.sku || '',
        price: product.retail_price,
        quantity: 1,
        total: product.retail_price,
        saleUnit: product.sale_unit ?? null,
        sellBy: product.sell_by ?? 'PIECE',
        imageUrl: product.image_url || undefined,
        vatRate: product.vat_rate,
      },
    });
  }, [dispatch, selectedCustomer]);

  const handleBarcodeScanned = useCallback(async (barcode: string) => {
    const product = await window.electronAPI.pos.products.getByBarcode(barcode);
    if (product) handleAddProduct(product);
  }, [handleAddProduct]);

  const creditLimit = selectedCustomer?.credit_limit ?? 0;
  const currentDebt = selectedCustomer?.current_debt ?? 0;
  const afterDebt = selectedCustomer ? currentDebt + cart.total : 0;
  const remaining = selectedCustomer ? Math.max(0, creditLimit - currentDebt) : 0;
  const usagePercent = creditLimit > 0 ? Math.min(100, Math.round((afterDebt / creditLimit) * 100)) : 0;

  const canPayInvoice = selectedCustomer
    ? afterDebt <= creditLimit
    : false;

  const handleOpenPayment = useCallback((prefillCashGrosze?: number) => {
    if (!selectedCustomer) {
      setShowCustomerPrompt(true);
      return;
    }
    if (cart.items.length === 0 || !shiftPaymentOpen) return;
    setPaymentPrefillCashGrosze(prefillCashGrosze);
    setShowPayment(true);
  }, [cart.items.length, selectedCustomer, shiftPaymentOpen]);

  const handleClosePayment = useCallback(() => {
    setShowPayment(false);
    setPaymentPrefillCashGrosze(undefined);
  }, []);

  return (
    <>
      {/* Customer header bar */}
      <CustomerPanel
        customers={customers}
        selectedCustomer={selectedCustomer}
        onSelectCustomer={handleSelectCustomer}
        t={t}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Left: Products */}
        <div className="flex-1 flex flex-col p-3 gap-3 overflow-hidden">
          {!selectedCustomer && (
            <div className="px-3 py-2 rounded border border-amber-700/40 bg-amber-900/20 text-amber-300 text-xs">
              {t('pos.b2b.selectCustomerFirst') || 'Select a customer to start a B2B order.'}
            </div>
          )}
          <SearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            onBarcodeScanned={handleBarcodeScanned}
            placeholder={t('pos.search')}
          />
          <CategoryTabs
            categories={categories}
            activeId={activeCategoryId}
            onSelect={setActiveCategoryId}
            allLabel={t('pos.allCategories')}
            lang={lang}
          />
          <div className="relative flex-1 overflow-hidden">
            <ProductGrid products={products} onAddProduct={handleAddProduct} t={t} lang={lang} />
            {!canSell && (
              <div className="absolute inset-0 bg-slate-900/70 flex items-center justify-center text-sm text-slate-300">
                {t('pos.b2b.locked') || 'Select customer to enable ordering'}
              </div>
            )}
          </div>
        </div>

        {/* Right: Cart sidebar */}
        <div className="w-80 xl:w-96 border-l border-slate-700 flex flex-col bg-slate-850 shrink-0">
          {!selectedCustomer && (
            <div className="p-3 border-b border-slate-700 text-xs text-slate-400">
              {t('pos.b2b.customerRequired') || 'Customer required for wholesale orders.'}
            </div>
          )}
          {selectedCustomer && (
            <div className="p-3 border-b border-slate-700 bg-slate-800/50 space-y-1">
              <div className="font-semibold text-sm">{selectedCustomer.name}</div>
              {selectedCustomer.nip && (
                <div className="text-xs text-slate-400">{t('pos.b2b.nip')}: {selectedCustomer.nip}</div>
              )}
              <div className="flex gap-3 text-xs">
                <span className="text-green-400">
                  {t('pos.b2b.creditLimit')}: {(creditLimit / 100).toFixed(2)} {t('pos.currency')}
                </span>
                <span className={selectedCustomer.current_debt > 0 ? 'text-amber-400' : 'text-slate-400'}>
                  {t('pos.b2b.currentDebt')}: {(currentDebt / 100).toFixed(2)} {t('pos.currency')}
                </span>
              </div>
              <div className="text-xs text-slate-500">
                {t('pos.b2b.paymentTerms')}: {selectedCustomer.payment_terms} {t('pos.b2b.days')}
              </div>
              <div className="mt-2">
                <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                  <span>{t('pos.b2b.remaining') || 'Remaining'}: {(remaining / 100).toFixed(2)} {t('pos.currency')}</span>
                  <span>{t('pos.b2b.afterOrder') || 'After order'}: {(afterDebt / 100).toFixed(2)} {t('pos.currency')}</span>
                </div>
                <div className="h-2 bg-slate-700 rounded">
                  <div
                    className={`h-2 rounded ${usagePercent >= 90 ? 'bg-red-500' : usagePercent >= 70 ? 'bg-amber-500' : 'bg-green-500'}`}
                    style={{ width: `${usagePercent}%` }}
                  />
                </div>
              </div>
            </div>
          )}
          <Cart
            cart={cart}
            dispatch={dispatch}
            onPay={handleOpenPayment}
            t={t}
            shiftOpen={shiftPaymentOpen}
            shiftBlockReason={shiftBlockedMessage}
            lang={lang}
          />
          {/* Invoice credit warning */}
          {selectedCustomer && !canPayInvoice && cart.total > 0 && (
            <div className="px-3 py-2 bg-red-900/30 border-t border-red-700/50 text-red-400 text-xs">
              {t('pos.b2b.exceedsCredit')}
            </div>
          )}
        </div>
      </div>

      {showPayment && (
        <PaymentModal
          cart={cart}
          dispatch={dispatch}
          onClose={handleClosePayment}
          t={t}
          shiftId={session.shiftId}
          staffId={session.staffId}
          staffName={session.staffName}
          initialCashAmountGrosze={paymentPrefillCashGrosze}
          checkoutDraft={state.checkoutDraft}
          extraOrderFields={{
            customer_id: selectedCustomer?.id,
            customer_name: selectedCustomer?.name,
            customer_nip: selectedCustomer?.nip,
            mode: 'b2b',
            canPayInvoice: selectedCustomer ? canPayInvoice : false,
          }}
        />
      )}
      {showCustomerPrompt && !selectedCustomer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowCustomerPrompt(false)}>
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm text-white font-semibold mb-2">{t('pos.b2b.selectCustomer') || 'Select customer'}</div>
            <div className="text-xs text-slate-400 mb-3">
              {t('pos.b2b.selectCustomerFirst') || 'Please choose a customer before adding items.'}
            </div>
            <button
              onClick={() => setShowCustomerPrompt(false)}
              className="w-full py-2 text-xs rounded bg-slate-700 text-slate-200 hover:bg-slate-600"
            >
              {t('pos.ok') || 'OK'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
