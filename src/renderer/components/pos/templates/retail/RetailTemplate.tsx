import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { Product, Category } from '../../../../hooks/usePosDb';
import type { PosState, PosAction, CartItem } from '../../../../hooks/usePosStore';
import rlog from '../../../../utils/logger';
import SearchBar from '../../SearchBar';
import ProductGrid from '../../ProductGrid';
import Cart from '../../Cart';
import PaymentModal from '../../PaymentModal';
import OrderHistoryModal from '../../OrderHistoryModal';
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
  const [showHistory, setShowHistory] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [heldCarts, setHeldCarts] = useState<Array<{
    id: string;
    items: CartItem[];
    total: number;
    createdAt: string;
  }>>([]);

  const cart = state.cart;
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [restoredCart, setRestoredCart] = useState(false);
  const [cartStorageKey, setCartStorageKey] = useState<string | null>(null);

  // Resolve per-user localStorage key for cart persistence
  useEffect(() => {
    window.electronAPI.getConfig().then((cfg: any) => {
      const userId = cfg?.authUser?.id || cfg?.salonId || 'default';
      // Skip offline/anonymous users — don't persist their cart
      if (userId === 'offline' || !userId) {
        setCartStorageKey(null);
      } else {
        setCartStorageKey(`pos.activeCart.${userId}`);
      }
    });
  }, []);

  // Restore active cart from localStorage on mount (crash recovery, per-user)
  useEffect(() => {
    if (cartStorageKey === null) return;
    try {
      const raw = window.localStorage.getItem(cartStorageKey);
      if (raw) {
        const items = JSON.parse(raw);
        if (Array.isArray(items) && items.length > 0 && cart.items.length === 0) {
          items.forEach((item: CartItem) => {
            dispatch({ type: 'cart/addItem', payload: { ...item, id: crypto.randomUUID(), total: item.price * item.quantity } });
          });
          setRestoredCart(true);
          setTimeout(() => setRestoredCart(false), 4000);
        }
      }
    } catch (err) {
      rlog.warn('[RetailTemplate] Failed to restore active cart:', err);
    }
  }, [cartStorageKey]);

  // Persist active cart to localStorage on every change (per-user, crash protection).
  // Only saves when cart has items — never deletes on empty, because system-triggered
  // cart/clear (e.g. logout) would wipe the saved cart before the user logs back in.
  // The entry is cleared explicitly after successful payment via clearSavedCart().
  useEffect(() => {
    if (cartStorageKey === null || cart.items.length === 0) return;
    try {
      window.localStorage.setItem(cartStorageKey, JSON.stringify(cart.items));
    } catch (err) {
      rlog.warn('[RetailTemplate] Failed to persist active cart:', err);
    }
  }, [cart.items, cartStorageKey]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('pos.heldCarts');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setHeldCarts(parsed);
      }
    } catch (err) {
      rlog.warn('[RetailTemplate] Failed to load held carts:', err);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('pos.heldCarts', JSON.stringify(heldCarts));
    } catch (err) {
      rlog.warn('[RetailTemplate] Failed to save held carts:', err);
    }
  }, [heldCarts]);

  // Load categories + products on mount. If initial load returns empty
  // (sync not finished yet after login), retry once after a short delay.
  useEffect(() => {
    const load = async () => {
      const [cats, prods] = await Promise.all([
        window.electronAPI.pos.categories.getAll(),
        window.electronAPI.pos.products.getAll(),
      ]);
      setCategories(cats);
      setAllProducts(prods);
      if (prods.length === 0) {
        // Sync may still be in progress — retry after 2s
        setTimeout(async () => {
          const [retryCats, retryProds] = await Promise.all([
            window.electronAPI.pos.categories.getAll(),
            window.electronAPI.pos.products.getAll(),
          ]);
          if (retryProds.length > 0) {
            setCategories(retryCats);
            setAllProducts(retryProds);
            setProducts(retryProds);
          }
        }, 2000);
      }
    };
    load();
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
          {/* Toolbar: search + category pills */}
          <div className="flex items-center gap-2.5 shrink-0">
            {/* Search */}
            <div className="w-56 shrink-0">
              <SearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                onBarcodeScanned={handleBarcodeScanned}
                placeholder={t('pos.search')}
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
                      ? { backgroundColor: cat.color || '#da7756', borderColor: cat.color || '#da7756' }
                      : undefined
                  }
                >
                  {cat.name}
                </button>
              ))}
            </div>
          </div>
          <ProductGrid
            products={products}
            onAddProduct={handleAddProduct}
            t={t}
            resetScrollKey={activeCategoryId ?? 'all'}
          />
          <div className="-mx-3 -mb-3 shrink-0">
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
              onHistory={() => setShowHistory(true)}
            />
          </div>
        </div>

        {/* Right: Cart sidebar */}
        <div className="w-80 xl:w-96 border-l border-gray-200 flex flex-col bg-white shrink-0">
          {restoredCart && (
            <div className="bg-amber-50 border-b border-amber-200 px-3 py-2 text-xs text-amber-700 flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20 10 10 0 000-20z" /></svg>
              Cart restored from previous session
            </div>
          )}
          <Cart
            cart={cart}
            dispatch={dispatch}
            onPay={() => setShowPayment(true)}
            t={t}
            shiftOpen={session.isOpen}
          />
        </div>
      </div>

      {/* Payment modal */}
      {showPayment && (
        <PaymentModal
          cart={cart}
          dispatch={dispatch}
          onClose={() => setShowPayment(false)}
          onComplete={() => {
            setShowPayment(false);
            // Clear saved cart after successful payment
            if (cartStorageKey) {
              try { window.localStorage.removeItem(cartStorageKey); } catch {}
            }
          }}
          t={t}
          shiftId={session.shiftId}
          staffId={session.staffId}
          staffName={session.staffName}
        />
      )}

      {/* Order history modal */}
      {showHistory && (
        <OrderHistoryModal
          onClose={() => setShowHistory(false)}
          t={t}
        />
      )}
    </>
  );
}
