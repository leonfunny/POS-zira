import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { Product, Category } from '../../../../hooks/usePosDb';
import type { PosState, PosAction } from '../../../../hooks/usePosStore';
import PaymentModal from '../../PaymentModal';

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
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const productGridRef = useRef<HTMLDivElement>(null);

  const cart = state.cart;
  const tip = state.tip ?? 0;
  const currency = t('pos.currency');
  const activeCategory = categories.find((c) => c.id === activeCategoryId);
  const quickPicks = allProducts.slice(0, 6);

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

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

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

  const grandTotal = cart.total + tip;

  return (
    <>
      <div className="flex-1 flex overflow-hidden bg-slate-50">

        {/* ── Left panel ── */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">

          {/* Top bar: category dropdown + search */}
          <div className="flex items-center gap-2 px-4 pt-4 pb-2 shrink-0">

            {/* Category dropdown */}
            <div className="relative shrink-0" ref={dropdownRef}>
              <button
                onClick={() => setDropdownOpen((o) => !o)}
                className="flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm font-semibold text-gray-800 hover:border-brand-300 hover:text-brand-600 transition-colors cursor-pointer shadow-sm min-w-[130px]"
                aria-haspopup="listbox"
                aria-expanded={dropdownOpen}
              >
                <span className="truncate max-w-[110px]">
                  {activeCategory?.name ?? (t('pos.allCategories') || 'All Services')}
                </span>
                <svg
                  className={`w-4 h-4 shrink-0 text-gray-400 transition-transform duration-200 ${dropdownOpen ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {dropdownOpen && (
                <div
                  className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-xl z-30 min-w-[180px] py-1 overflow-hidden"
                  role="listbox"
                >
                  <button
                    role="option"
                    aria-selected={activeCategoryId === null}
                    onClick={() => { setActiveCategoryId(null); setDropdownOpen(false); }}
                    className={`w-full text-left px-4 py-2.5 text-sm transition-colors cursor-pointer ${
                      activeCategoryId === null
                        ? 'bg-brand-50 text-brand-600 font-semibold'
                        : 'text-gray-700 hover:bg-slate-50'
                    }`}
                  >
                    {t('pos.allCategories') || 'All Services'}
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat.id}
                      role="option"
                      aria-selected={activeCategoryId === cat.id}
                      onClick={() => { setActiveCategoryId(cat.id); setDropdownOpen(false); }}
                      className={`w-full text-left px-4 py-2.5 text-sm transition-colors cursor-pointer ${
                        activeCategoryId === cat.id
                          ? 'bg-brand-50 text-brand-600 font-semibold'
                          : 'text-gray-700 hover:bg-slate-50'
                      }`}
                    >
                      {cat.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Search */}
            <div className="relative flex-1">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('pos.search') || 'Search services...'}
                className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-100 text-gray-700 placeholder-gray-400 shadow-sm"
              />
            </div>
          </div>

          {/* Quick Picks */}
          {quickPicks.length > 0 && (
            <div className="px-4 pb-2 shrink-0">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                {t('pos.quickPick')}
              </p>
              <div className="grid grid-cols-4 gap-1.5">
                {quickPicks.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => handleAddProduct(p)}
                    className="flex flex-col items-start px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-700 hover:border-brand-300 hover:text-brand-600 hover:bg-brand-50 active:scale-95 transition-all cursor-pointer shadow-sm touch-manipulation overflow-hidden"
                  >
                    <span className="font-medium truncate w-full">{p.name}</span>
                    <span className="text-brand-500 font-semibold mt-0.5">{(p.retail_price / 100).toFixed(2)}&nbsp;{currency}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Service grid */}
          <div ref={productGridRef} className="flex-1 overflow-y-auto px-4 pb-4">
            {products.length === 0 ? (
              <div className="h-full flex items-center justify-center text-gray-400 text-sm">
                {t('pos.noProducts') || 'No services found'}
              </div>
            ) : (
              <div className="grid grid-cols-3 xl:grid-cols-4 gap-3">
                {products.map((product) => {
                  const colorClass = placeholderColor(product.name);
                  return (
                    <div
                      key={product.id}
                      className="bg-white border border-gray-100 rounded-2xl overflow-hidden shadow-sm hover:shadow-md hover:border-brand-200 transition-all duration-200 group"
                    >
                      {/* Image / placeholder */}
                      <div className="relative aspect-square w-full overflow-hidden bg-slate-50">
                        {product.image_url ? (
                          <img
                            src={product.image_url}
                            alt={product.name}
                            loading="lazy"
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                        ) : (
                          <div className={`w-full h-full flex items-center justify-center text-3xl font-bold ${colorClass}`}>
                            {product.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        {/* Circular add button */}
                        <button
                          onClick={() => handleAddProduct(product)}
                          aria-label={`Add ${product.name}`}
                          className="absolute bottom-2 right-2 w-9 h-9 bg-brand-500 hover:bg-brand-600 active:bg-brand-700 text-white rounded-full flex items-center justify-center shadow-md active:scale-95 transition-all cursor-pointer touch-manipulation"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                          </svg>
                        </button>
                      </div>

                      {/* Name + price */}
                      <div className="px-3 py-2.5">
                        <div className="text-sm font-medium text-gray-800 leading-snug truncate">
                          {product.name}
                        </div>
                        <div className="text-sm font-bold text-brand-500 mt-0.5">
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
