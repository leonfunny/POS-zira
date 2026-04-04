import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { Product, Category } from '../../../../hooks/usePosDb';
import type { PosState, PosAction } from '../../../../hooks/usePosStore';
import PaymentModal from '../../PaymentModal';
import SearchBar from '../../SearchBar';

interface StaffMember {
  id: string;
  name: string;
  commission_rate: number;
  is_active: number;
}

interface SalonTemplateProps {
  state: PosState;
  dispatch: (action: PosAction) => void;
  t: (key: string) => string;
  session: PosState['session'];
}

const PLACEHOLDER_COLORS = [
  'bg-brand-100 text-brand-600',
  'bg-purple-100 text-purple-600',
  'bg-blue-100 text-blue-600',
  'bg-green-100 text-green-600',
  'bg-amber-100 text-amber-600',
  'bg-orange-100 text-orange-600',
  'bg-teal-100 text-teal-600',
  'bg-brand-100 text-brand-600',
];

function placeholderColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return PLACEHOLDER_COLORS[Math.abs(hash) % PLACEHOLDER_COLORS.length];
}

export default function SalonTemplate({ state, dispatch, t, session }: SalonTemplateProps) {
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPayment, setShowPayment] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const productGridRef = useRef<HTMLDivElement>(null);

  const cart = state.cart;
  const tip = state.tip ?? 0;
  const currency = t('pos.currency');

  // Load staff and categories once
  useEffect(() => {
    window.electronAPI.pos.staff.getAll().then(setStaffList);
  }, []);

  useEffect(() => {
    window.electronAPI.pos.categories.getAll().then(setCategories);
    window.electronAPI.pos.products.getAll().then(setAllProducts);
  }, []);

  // Reset product grid scroll when category changes
  useEffect(() => {
    productGridRef.current?.scrollTo({ top: 0 });
  }, [activeCategoryId]);

  // Load filtered products
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
    return () => {
      cancelled = true;
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [activeCategoryId, searchQuery]);

  // Refresh on sync
  useEffect(() => {
    const unsub = window.electronAPI.pos.sync.onProductsSynced(() => {
      window.electronAPI.pos.products.getAll().then((all) => {
        setAllProducts(all);
        setProducts(all);
      });
      window.electronAPI.pos.categories.getAll().then(setCategories);
    });
    return unsub;
  }, []);

  const handleAddProduct = useCallback(
    (product: Product) => {
      dispatch({
        type: 'cart/addItem',
        payload: {
          id: crypto.randomUUID(),
          variantId: product.id,
          name: product.name,
          sku: product.sku || '',
          price: product.retail_price,
          quantity: 1,
          total: product.retail_price,
          imageUrl: product.image_url || undefined,
          vatRate: product.vat_rate,
        },
      });
    },
    [dispatch],
  );

  const handleBarcodeScanned = useCallback(async (barcode: string) => {
    const product = await window.electronAPI.pos.products.getByBarcode(barcode);
    if (product) handleAddProduct(product);
  }, [handleAddProduct]);

  const grandTotal = cart.total + tip;

  return (
    <>
      <div className="flex-1 flex overflow-hidden bg-slate-50">

        {/* ── Left panel ── */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">

          {/* Toolbar: search + category pills */}
          <div className="flex items-center gap-2.5 px-4 pt-4 pb-2 shrink-0">
            {/* Search */}
            <div className="w-56 shrink-0">
              <SearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                onBarcodeScanned={handleBarcodeScanned}
                placeholder={t('pos.search') || 'Search services...'}
              />
            </div>

            {/* Category pills */}
            <div className="flex-1 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              <button
                onClick={() => setActiveCategoryId(null)}
                className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-150 cursor-pointer touch-manipulation border ${
                  activeCategoryId === null
                    ? 'bg-brand-500 text-white border-brand-500 shadow-sm'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-brand-300 hover:text-brand-600'
                }`}
              >
                {t('pos.allCategories') || 'All'}
              </button>
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategoryId(activeCategoryId === cat.id ? null : cat.id)}
                  className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-150 cursor-pointer touch-manipulation border ${
                    activeCategoryId === cat.id
                      ? 'text-white shadow-sm'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-brand-300 hover:text-brand-600'
                  }`}
                  style={
                    activeCategoryId === cat.id
                      ? { backgroundColor: cat.color || 'var(--color-brand-500)', borderColor: cat.color || 'var(--color-brand-500)' }
                      : undefined
                  }
                >
                  {cat.name}
                </button>
              ))}
            </div>
          </div>

          {/* Service grid */}
          <div ref={productGridRef} className="flex-1 overflow-y-auto px-4 pb-4">
            {products.length === 0 ? (
              <div className="h-full flex items-center justify-center text-gray-400 text-sm">
                {t('pos.noProducts') || 'No services found'}
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-2.5">
                {products.map((product) => {
                  const colorClass = placeholderColor(product.name);
                  return (
                    <div
                      key={product.id}
                      className="bg-white border border-gray-100 rounded-xl overflow-hidden shadow-sm hover:shadow-md hover:border-brand-200 transition-all duration-200 group"
                    >
                      {/* Image / placeholder */}
                      <div className="relative aspect-[3/2] w-full overflow-hidden bg-slate-50">
                        {product.image_url ? (
                          <img
                            src={product.image_url}
                            alt={product.name}
                            loading="lazy"
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                        ) : (
                          <div className={`w-full h-full flex items-center justify-center text-2xl font-bold ${colorClass}`}>
                            {product.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        {/* Circular add button */}
                        <button
                          onClick={() => handleAddProduct(product)}
                          aria-label={`Add ${product.name}`}
                          className="absolute bottom-1.5 right-1.5 w-8 h-8 bg-brand-500 hover:bg-brand-600 active:bg-brand-700 text-white rounded-full flex items-center justify-center shadow-md active:scale-95 transition-all cursor-pointer touch-manipulation"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                          </svg>
                        </button>
                      </div>

                      {/* Name + price */}
                      <div className="px-2.5 py-2">
                        <div className="text-xs font-medium text-gray-800 leading-snug truncate">
                          {product.name}
                        </div>
                        <div className="text-xs font-bold text-brand-500 mt-0.5">
                          {(product.retail_price / 100).toFixed(2)}&nbsp;{currency}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Right panel: Current Order ── */}
        <div className="w-80 xl:w-[340px] border-l border-gray-200 flex flex-col bg-white shrink-0">

          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
            <h2 className="font-bold text-gray-900 text-sm">
              {t('pos.cart') || 'Current Order'}
              {cart.items.length > 0 && (
                <span className="ml-1.5 text-gray-400 font-normal text-xs">
                  ({cart.items.length})
                </span>
              )}
            </h2>
            {cart.items.length > 0 && (
              <button
                onClick={() => dispatch({ type: 'cart/clear' })}
                className="text-xs text-gray-400 hover:text-red-500 hover:bg-red-50 px-2 py-1 rounded transition-colors cursor-pointer font-medium"
              >
                {t('pos.cart.clear') || 'Clear'}
              </button>
            )}
          </div>

          {/* Cart items */}
          <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
            {cart.items.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">
                {t('pos.cart.empty') || 'No items yet'}
              </div>
            ) : (
              cart.items.map((item) => {
                const colorClass = placeholderColor(item.name);
                return (
                  <div key={item.id} className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      {/* Thumbnail */}
                      <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0">
                        {item.imageUrl ? (
                          <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" />
                        ) : (
                          <div className={`w-full h-full flex items-center justify-center text-sm font-bold ${colorClass}`}>
                            {item.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-800 leading-snug truncate">
                          {item.name}
                        </div>
                        {staffList.length > 0 && (
                          <select
                            value={item.staffId || ''}
                            onChange={(e) => {
                              const staff = staffList.find((s) => s.id === e.target.value);
                              if (staff) {
                                dispatch({
                                  type: 'cart/setItemStaff',
                                  payload: { id: item.id, staffId: staff.id, staffName: staff.name },
                                });
                              }
                            }}
                            className="mt-1 w-full px-2 py-1 text-[11px] bg-slate-50 border border-gray-200 rounded-lg text-gray-500 appearance-none focus:outline-none focus:border-brand-400 cursor-pointer"
                          >
                            <option value="">{t('pos.salon.noStaff') || 'No staff'}</option>
                            {staffList.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>
                        )}
                      </div>

                      <span className="text-sm font-bold text-gray-900 shrink-0">
                        {(item.total / 100).toFixed(2)}&nbsp;{currency}
                      </span>
                    </div>

                    {/* Qty controls */}
                    <div className="flex items-center gap-2 mt-2 pl-[52px]">
                      <button
                        onClick={() => {
                          if (item.quantity <= 1) {
                            dispatch({ type: 'cart/removeItem', payload: { id: item.id } });
                          } else {
                            dispatch({ type: 'cart/updateQuantity', payload: { id: item.id, quantity: item.quantity - 1 } });
                          }
                        }}
                        aria-label="Decrease quantity"
                        className="w-9 h-9 rounded-full bg-gray-100 hover:bg-red-50 hover:text-red-500 text-gray-600 flex items-center justify-center font-bold text-base leading-none transition-colors touch-manipulation cursor-pointer select-none"
                      >
                        −
                      </button>
                      <span className="w-6 text-center text-sm font-semibold text-gray-700">
                        {item.quantity}
                      </span>
                      <button
                        onClick={() =>
                          dispatch({ type: 'cart/updateQuantity', payload: { id: item.id, quantity: item.quantity + 1 } })
                        }
                        aria-label="Increase quantity"
                        className="w-9 h-9 rounded-full bg-brand-500 hover:bg-brand-600 text-white flex items-center justify-center font-bold text-base leading-none transition-colors touch-manipulation cursor-pointer select-none"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Totals */}
          <div className="border-t border-gray-100 px-4 pt-3 pb-2 space-y-1.5 shrink-0">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">{t('pos.cart.subtotal') || 'Subtotal'}</span>
              <span className="text-gray-700 font-medium">{(cart.subtotal / 100).toFixed(2)}&nbsp;{currency}</span>
            </div>
            {cart.discount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-green-600">{t('pos.cart.discount') || 'Discount'}</span>
                <span className="text-green-600 font-medium">−{(cart.discount / 100).toFixed(2)}&nbsp;{currency}</span>
              </div>
            )}
            {cart.tax > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Tax</span>
                <span className="text-gray-700 font-medium">{(cart.tax / 100).toFixed(2)}&nbsp;{currency}</span>
              </div>
            )}
            {tip > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-green-600">{t('pos.salon.tip') || 'Tip'}</span>
                <span className="text-green-600 font-medium">+{(tip / 100).toFixed(2)}&nbsp;{currency}</span>
              </div>
            )}
          </div>

          {/* Total */}
          <div className="px-4 shrink-0">
            <div className="flex justify-between items-baseline py-3 border-t border-gray-200">
              <span className="text-base font-bold text-gray-900">{t('pos.cart.total') || 'Total'}</span>
              <span className="text-2xl font-bold text-gray-900">{(grandTotal / 100).toFixed(2)}&nbsp;{currency}</span>
            </div>
          </div>

          {/* PAY button */}
          <div className="px-4 pb-4 pt-1 shrink-0">
            {!session.isOpen && (
              <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-amber-50 border border-amber-200 rounded-xl">
                <svg className="w-4 h-4 text-amber-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                <p className="text-xs text-amber-700 font-medium">{t('pos.shift.openRequired') || 'Open a shift to accept payments'}</p>
              </div>
            )}
            <button
              onClick={() => cart.items.length > 0 && session.isOpen && setShowPayment(true)}
              disabled={cart.items.length === 0 || !session.isOpen}
              className="w-full py-4 bg-brand-500 hover:bg-brand-600 active:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl font-bold text-lg tracking-wide transition-colors shadow-sm touch-manipulation cursor-pointer"
            >
              {t('pos.pay') || 'PAY'}
            </button>
          </div>
        </div>
      </div>

      {showPayment && (
        <PaymentModal
          cart={cart}
          dispatch={dispatch}
          onClose={() => setShowPayment(false)}
          t={t}
          shiftId={session.shiftId}
          staffId={session.staffId}
          staffName={session.staffName}
          extraOrderFields={{ tip, mode: 'salon' }}
        />
      )}
    </>
  );
}
