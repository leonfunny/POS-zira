import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { Product, Category } from '../../../../hooks/usePosDb';
import type { PosState, PosAction, CartItem } from '../../../../hooks/usePosStore';
import rlog from '../../../../utils/logger';
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
  const [heldCarts, setHeldCarts] = useState<Array<{
    id: string;
    items: CartItem[];
    total: number;
    createdAt: string;
  }>>([]);

  const cart = state.cart;
  const [allProducts, setAllProducts] = useState<Product[]>([]);

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
                      ? { backgroundColor: cat.color || 'var(--color-brand-500)', borderColor: cat.color || 'var(--color-brand-500)' }
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
