import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { Product, Category } from '../../../../hooks/usePosDb';
import type { PosState, PosAction, CartItem } from '../../../../hooks/usePosStore';
import SearchBar from '../../SearchBar';
import ProductGrid from '../../ProductGrid';
import Cart from '../../Cart';
import PaymentModal from '../../PaymentModal';
import QuickActions from './QuickActions';

interface RetailTemplateProps {
  state: PosState;
  dispatch: (action: PosAction) => void;
  t: (key: string) => string;
  session: PosState['session'];
}

export default function RetailTemplate({ state, dispatch, t, session }: RetailTemplateProps) {
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPayment, setShowPayment] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [heldCarts, setHeldCarts] = useState<Array<{
    id: string;
    items: CartItem[];
    total: number;
    createdAt: string;
  }>>([]);

  const cart = state.cart;
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const quickProducts = allProducts.slice(0, 8);
  const activeCategory = categories.find((c) => c.id === activeCategoryId);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('pos.heldCarts');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setHeldCarts(parsed);
      }
    } catch (err) {
      console.warn('[RetailTemplate] Failed to load held carts:', err);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('pos.heldCarts', JSON.stringify(heldCarts));
    } catch (err) {
      console.warn('[RetailTemplate] Failed to save held carts:', err);
    }
  }, [heldCarts]);

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

  // Load categories once
  useEffect(() => {
    window.electronAPI.pos.categories.getAll().then(setCategories);
    window.electronAPI.pos.products.getAll().then(setAllProducts);
  }, []);

  // Load products when category or search changes (debounced for search)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let result: Product[];
      if (searchQuery) {
        result = await window.electronAPI.pos.products.search(searchQuery);
        if (activeCategoryId) {
          result = result.filter((p) => p.category_id === activeCategoryId);
        }
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

  // Refresh products when sync completes
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

  const handleAddProduct = useCallback((product: Product) => {
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
  }, [dispatch]);

  const handleBarcodeScanned = useCallback(async (barcode: string) => {
    const product = await window.electronAPI.pos.products.getByBarcode(barcode);
    if (product) {
      handleAddProduct(product);
    }
  }, [handleAddProduct]);

  const handleHoldCart = useCallback(() => {
    if (cart.items.length === 0) return;
    const held = {
      id: crypto.randomUUID(),
      items: cart.items,
      total: cart.total,
      createdAt: new Date().toISOString(),
    };
    setHeldCarts((prev) => [held, ...prev].slice(0, 6));
    dispatch({ type: 'cart/clear' });
    dispatch({ type: 'display/setMode', payload: { mode: 'idle' } });
  }, [cart.items, cart.total, dispatch]);

  const handleRecallCart = useCallback((heldId: string) => {
    const held = heldCarts.find((c) => c.id === heldId);
    if (!held) return;
    dispatch({ type: 'cart/clear' });
    held.items.forEach((item) => {
      dispatch({
        type: 'cart/addItem',
        payload: {
          ...item,
          id: crypto.randomUUID(),
          total: item.price * item.quantity,
        },
      });
    });
    setHeldCarts((prev) => prev.filter((c) => c.id !== heldId));
  }, [dispatch, heldCarts]);

  const handleDiscardHeld = useCallback((heldId: string) => {
    setHeldCarts((prev) => prev.filter((c) => c.id !== heldId));
  }, []);

  // Track customer display open state
  const [isCustomerDisplayOpen, setIsCustomerDisplayOpen] = useState(false);

  useEffect(() => {
    window.electronAPI.window.list().then((ids: string[]) => {
      setIsCustomerDisplayOpen(ids.includes('customer'));
    });
  }, []);

  const handleOpenCustomerDisplay = () => {
    window.electronAPI.window.open('customer').then((result: any) => {
      if (result?.success) setIsCustomerDisplayOpen(true);
    });
  };

  const handleCloseCustomerDisplay = () => {
    window.electronAPI.window.close('customer').then((result: any) => {
      if (result?.success) setIsCustomerDisplayOpen(false);
    });
  };

  const tOr = (key: string, fallback: string) => {
    const v = t(key);
    return v !== key ? v : fallback;
  };

  return (
    <>
      {/* Main content */}
      <div className="flex-1 flex overflow-hidden bg-slate-50">
        {/* Left: Products */}
        <div className="flex-1 flex flex-col p-3 gap-2 overflow-hidden">
          {/* Toolbar: category dropdown + search */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Category dropdown */}
            <div className="relative shrink-0" ref={dropdownRef}>
              <button
                onClick={() => setDropdownOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={dropdownOpen}
                className="flex items-center gap-1.5 px-3 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-semibold text-gray-700 hover:border-brand-300 hover:text-brand-600 transition-colors cursor-pointer min-w-[140px] shadow-sm"
              >
                <span className="truncate max-w-[110px]">
                  {activeCategory?.name ?? (t('pos.allCategories') || 'All')}
                </span>
                <svg
                  className={`w-4 h-4 shrink-0 text-gray-400 transition-transform duration-200 ${dropdownOpen ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {dropdownOpen && (
                <div
                  className="absolute top-full left-0 mt-1.5 bg-white border border-gray-200 rounded-2xl shadow-xl z-30 min-w-[190px] py-1.5 overflow-hidden"
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
                    {t('pos.allCategories') || 'All'}
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
            <div className="flex-1">
              <SearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                onBarcodeScanned={handleBarcodeScanned}
                placeholder={t('pos.search')}
              />
            </div>
          </div>
          {quickProducts.length > 0 && (
            <div className="shrink-0">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">{t('pos.quickPick')}</p>
              <div className="grid grid-cols-4 gap-1.5">
                {quickProducts.map((product) => (
                  <button
                    key={product.id}
                    onClick={() => handleAddProduct(product)}
                    className="flex flex-col items-start px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-700 hover:border-brand-300 hover:text-brand-600 hover:bg-brand-50 active:scale-95 transition-all cursor-pointer shadow-sm touch-manipulation overflow-hidden"
                  >
                    <span className="font-medium truncate w-full">{product.name}</span>
                    <span className="text-brand-500 font-semibold mt-0.5">{(product.retail_price / 100).toFixed(2)}&nbsp;{t('pos.currency')}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <ProductGrid
            products={products}
            onAddProduct={handleAddProduct}
            t={t}
            resetScrollKey={activeCategoryId ?? 'all'}
          />
        </div>

        {/* Right: Cart sidebar */}
        <div className="w-80 xl:w-96 border-l border-gray-200 flex flex-col bg-white shrink-0">
          <Cart
            cart={cart}
            dispatch={dispatch}
            onPay={() => setShowPayment(true)}
            t={t}
            shiftOpen={session.isOpen}
          />
        </div>
      </div>

      {/* Quick actions bar — includes Hold/Recall */}
      <QuickActions
        dispatch={dispatch}
        hasItems={cart.items.length > 0}
        onOpenCustomerDisplay={handleOpenCustomerDisplay}
        onCloseCustomerDisplay={handleCloseCustomerDisplay}
        isCustomerDisplayOpen={isCustomerDisplayOpen}
        displayMode={state.display?.mode || 'idle'}
        t={t}
        heldCarts={heldCarts}
        onHold={handleHoldCart}
        onRecall={handleRecallCart}
        onDiscardHeld={handleDiscardHeld}
      />

      {/* Payment modal */}
      {showPayment && (
        <PaymentModal
          cart={cart}
          dispatch={dispatch}
          onClose={() => setShowPayment(false)}
          t={t}
          shiftId={session.shiftId}
          staffId={session.staffId}
          staffName={session.staffName}
        />
      )}
    </>
  );
}
