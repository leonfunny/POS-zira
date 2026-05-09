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
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // When cart becomes empty (clear or payment), remove the localStorage entry so
  // stale items don't reappear when switching tabs or re-mounting.
  useEffect(() => {
    if (cartStorageKey === null) return;
    try {
      if (cart.items.length > 0) {
        window.localStorage.setItem(cartStorageKey, JSON.stringify(cart.items));
      } else {
        window.localStorage.removeItem(cartStorageKey);
      }
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

  // Load the visible product grid honouring whatever category /
  // search filter the cashier currently has applied. Reused by the
  // filter-change effect AND by the pos:products-synced handler so a
  // 30s periodic ProductSync tick (or a manual refresh) does not yank
  // the cashier back to the full catalogue mid-sale.
  const loadFilteredProducts = useCallback(async (): Promise<Product[]> => {
    if (searchQuery) {
      const result = await window.electronAPI.pos.products.search(searchQuery);
      return activeCategoryId
        ? result.filter((p: any) => p.category_id === activeCategoryId)
        : result;
    }
    if (activeCategoryId) {
      return window.electronAPI.pos.products.getByCategory(activeCategoryId);
    }
    return window.electronAPI.pos.products.getAll();
  }, [searchQuery, activeCategoryId]);

  // Filter-change effect: debounced for search, immediate for category.
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const result = await loadFilteredProducts();
      if (!cancelled) setProducts(result);
    };

    if (searchQuery) {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(run, 250);
    } else {
      run();
    }

    return () => {
      cancelled = true;
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [loadFilteredProducts, searchQuery]);

  // Refresh categories + the cached full product list (used by other
  // surfaces) and then re-apply the cashier's CURRENT filter. Critical
  // here: `loadFilteredProducts` reads the latest searchQuery /
  // activeCategoryId via its useCallback closure — calling it on each
  // sync tick avoids the previous `setProducts(all)` reset that would
  // dump category/search filtering back to the full catalogue.
  useEffect(() => {
    const unsub = window.electronAPI.pos.sync.onProductsSynced(() => {
      window.electronAPI.pos.categories.getAll().then(setCategories);
      window.electronAPI.pos.products.getAll().then(setAllProducts);
      loadFilteredProducts().then(setProducts);
    });
    return unsub;
  }, [loadFilteredProducts]);

  const tOr = useCallback(
    (key: string, fallback: string) => {
      const v = t(key);
      return v !== key ? v : fallback;
    },
    [t],
  );

  // Manual catalog refresh — periodic 30s poll already runs in main, this
  // button is for "I just edited a price on web and want it now" UX.
  // pos:products-synced from main triggers the existing reload effect, so
  // success path doesn't need to re-fetch here.
  const handleManualSync = useCallback(async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncError(null);
    if (syncErrorTimerRef.current) {
      clearTimeout(syncErrorTimerRef.current);
      syncErrorTimerRef.current = null;
    }
    try {
      const result = await window.electronAPI.pos.sync.products();
      if (!result?.success) {
        const msg =
          result?.error === 'no-auth'
            ? tOr('pos.syncNotLoggedIn', 'Not logged in')
            : tOr('pos.syncFailed', 'Sync failed');
        setSyncError(msg);
        // Auto-dismiss after 4s so the toolbar stays clean.
        syncErrorTimerRef.current = setTimeout(() => setSyncError(null), 4_000);
      }
    } catch (e: any) {
      rlog.warn('[RetailTemplate] manual product sync threw', e?.message);
      setSyncError(tOr('pos.syncFailed', 'Sync failed'));
      syncErrorTimerRef.current = setTimeout(() => setSyncError(null), 4_000);
    } finally {
      setIsSyncing(false);
    }
  }, [isSyncing, tOr]);

  // Cleanup the auto-dismiss timer on unmount.
  useEffect(() => {
    return () => {
      if (syncErrorTimerRef.current) clearTimeout(syncErrorTimerRef.current);
    };
  }, []);

  const handleAddProduct = useCallback((product: Product) => {
    if (product.category_id !== 'cat-5' && (product.available_qty ?? product.in_stock) <= 0) return;
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

  return (
    <>
      {/* Main content */}
      <div className="flex-1 flex overflow-hidden bg-slate-100">
        {/* Left: Products */}
        <div className="flex-1 min-w-0 flex flex-col p-3 gap-3 overflow-hidden">
          {/* Toolbar: search + category pills */}
          <div className="shrink-0 bg-white border border-slate-200 rounded-lg shadow-sm p-2.5">
            <div className="flex items-center gap-3">
              <div className="w-[min(360px,42%)] min-w-[280px] shrink-0">
              <SearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                onBarcodeScanned={handleBarcodeScanned}
                placeholder={tOr('pos.search', 'Search or scan barcode')}
              />
              </div>

              <div className="flex-1 min-w-0 flex items-center gap-2 overflow-x-auto no-scrollbar">
              <button
                type="button"
                onClick={handleManualSync}
                disabled={isSyncing}
                title={tOr('pos.syncProducts', 'Sync products from server')}
                aria-label={tOr('pos.syncProducts', 'Sync products from server')}
                className={`shrink-0 min-h-11 w-11 rounded-lg border flex items-center justify-center transition-colors duration-150 cursor-pointer touch-manipulation focus:outline-none focus:ring-2 focus:ring-brand-200 ${
                  isSyncing
                    ? 'bg-slate-50 text-slate-400 border-slate-200 cursor-wait'
                    : syncError
                    ? 'bg-red-50 text-red-700 border-red-300 hover:bg-red-100'
                    : 'bg-white text-slate-700 border-slate-300 hover:border-brand-400 hover:text-brand-700 hover:bg-brand-50'
                }`}
              >
                <svg
                  className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h5M20 20v-5h-5M4 9a8 8 0 0114-3m2 5a8 8 0 01-14 3"
                  />
                </svg>
              </button>
              {syncError && (
                <span
                  role="status"
                  className="shrink-0 text-xs font-bold text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded-md"
                >
                  {syncError}
                </span>
              )}
              <button
                onClick={() => setActiveCategoryId(null)}
                className={`min-h-11 px-4 rounded-lg text-sm font-bold whitespace-nowrap transition-colors duration-150 cursor-pointer touch-manipulation border focus:outline-none focus:ring-2 focus:ring-brand-200 ${
                  activeCategoryId === null
                    ? 'bg-brand-600 text-white border-brand-600 shadow-sm'
                    : 'bg-white text-slate-700 border-slate-300 hover:border-brand-400 hover:text-brand-700 hover:bg-brand-50'
                }`}
              >
                {t('pos.allCategories') || 'All'}
              </button>
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategoryId(activeCategoryId === cat.id ? null : cat.id)}
                  className={`min-h-11 px-4 rounded-lg text-sm font-bold whitespace-nowrap transition-colors duration-150 cursor-pointer touch-manipulation border flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-brand-200 ${
                    activeCategoryId === cat.id
                      ? 'bg-brand-50 text-brand-800 border-brand-500 shadow-sm'
                      : 'bg-white text-slate-700 border-slate-300 hover:border-brand-400 hover:text-brand-700 hover:bg-brand-50'
                  }`}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: cat.color || '#da7756' }}
                    aria-hidden="true"
                  />
                  {cat.name}
                </button>
              ))}
              </div>
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
        <div className="w-80 xl:w-96 border-l border-slate-300 flex flex-col bg-white shrink-0">
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
            setSearchQuery('');
            setActiveCategoryId(null);
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
