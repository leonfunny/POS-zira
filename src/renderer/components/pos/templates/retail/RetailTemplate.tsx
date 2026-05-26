import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { Product, Category } from '../../../../hooks/usePosDb';
import type { PosState, PosAction, CartItem } from '../../../../hooks/usePosStore';
import rlog from '../../../../utils/logger';
import { useConfig } from '../../../../hooks/useConfig';
import { resolveName } from '../../../../../shared/catalog-names';
import SearchBar from '../../SearchBar';
import ProductGrid from '../../ProductGrid';
import Cart from '../../Cart';
import PaymentModal from '../../PaymentModal';
import OrderHistoryModal from '../../OrderHistoryModal';
import QuickActions from './QuickActions';

// Category cards render an icon glyph in the colored avatar. Prefer the
// server-provided `icon` field when it's a short pictogram/emoji (≤ 2
// code points), otherwise fall back to initials derived from the display
// name so every card always has something legible.
function categoryGlyph(cat: Category, displayName: string): string {
  const icon = (cat.icon || '').trim();
  if (icon && [...icon].length <= 2) return icon;
  const trimmed = (displayName || cat.name || '?').trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

interface RetailTemplateProps {
  state: PosState;
  dispatch: (action: PosAction) => void;
  t: (key: string) => string;
  session: PosState['session'];
  onUnknownBarcodeScanned?: (ean: string) => void | Promise<void>;
  onQuickAddCamera?: () => void;
}

export default function RetailTemplate({ state, dispatch, t, session, onUnknownBarcodeScanned, onQuickAddCamera }: RetailTemplateProps) {
  const [showHistory, setShowHistory] = useState(false);
  const { config } = useConfig();
  const lang = (config?.posLanguage as string | undefined) || (config?.language as string | undefined) || 'pl';
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPayment, setShowPayment] = useState(false);
  const [paymentPrefillCashGrosze, setPaymentPrefillCashGrosze] = useState<number | undefined>(undefined);
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
      // Retail till searches by name, SKU, and barcode — cashier may either
      // scan/key a code or type a partial product name (grocery items where
      // EAN is missing). Backed by productRepo.search() which normalises
      // Polish + Vietnamese diacritics.
      const variantsRaw = await window.electronAPI.pos.products.search(searchQuery);
      const variants: Product[] = activeCategoryId
        ? variantsRaw.filter((p: any) => p.category_id === activeCategoryId)
        : variantsRaw;

      // Also surface master-catalog drafts that match the same code so an
      // unimported item can be added to the cart in one tap. Clicking a
      // draft routes through the scan-import flow (creates the variant on
      // the server, then adds to cart). Drafts are appended after real
      // variants so the cashier sees stocked items first.
      const drafts: any[] = await window.electronAPI.pos.draftProducts
        .searchByCode(searchQuery)
        .catch(() => []);
      const variantBarcodes = new Set(
        variants.map((v) => v.barcode).filter((b): b is string => !!b),
      );
      const draftItems: Product[] = drafts
        .filter((d) => !d.barcode || !variantBarcodes.has(d.barcode))
        .map((d) => ({
          id: `draft:${d.id}`,
          template_id: null,
          name: d.name,
          sku: d.sku ?? null,
          barcode: d.barcode ?? null,
          retail_price: Number(d.retail_price) || 0,
          category_id: d.category_id ?? null,
          image_url: d.image_url ?? null,
          in_stock: Number(d.in_stock) || 0,
          vat_rate: Number(d.vat_rate) || 23,
          is_active: 1,
          updated_at: d.updated_at ?? null,
          available_qty: Number(d.in_stock) || 0,
          _isDraft: true,
        }));

      return [...variants, ...draftItems];
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
  const missingShiftStaff = session.isOpen && !session.staffName?.trim();
  const shiftPaymentOpen = session.isOpen && !missingShiftStaff;
  const shiftBlockedMessage = missingShiftStaff
    ? tOr('pos.shift.staffMissing', 'Shift is open but missing staff. Close and reopen the shift before payment.')
    : undefined;

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

  // After every cart mutation (add, remove, qty change) return focus to the
  // search bar so the cashier can immediately scan/key the next item without
  // tapping back. SearchBar itself listens for `pos:focus-search`.
  useEffect(() => {
    document.dispatchEvent(new CustomEvent('pos:focus-search'));
  }, [cart.items]);

  const handleAddProduct = useCallback((product: Product) => {
    // Drafts haven't been imported into product_variants yet — route through
    // the scan-import modal so the server materializes a real variant before
    // we add anything to the cart. The modal's confirm path adds to cart on
    // success.
    if (product._isDraft) {
      if (product.barcode && onUnknownBarcodeScanned) {
        void onUnknownBarcodeScanned(product.barcode);
      }
      return;
    }
    if ((Number(product.retail_price) || 0) <= 0) return;
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
        name_translations: product.name_translations ?? null,
      },
    });
  }, [dispatch, onUnknownBarcodeScanned]);

  const handleBarcodeScanned = useCallback(async (barcode: string) => {
    const product = await window.electronAPI.pos.products.getByBarcode(barcode);
    if (product) {
      handleAddProduct(product);
      return;
    }
    if (onUnknownBarcodeScanned) {
      await onUnknownBarcodeScanned(barcode);
    }
  }, [handleAddProduct, onUnknownBarcodeScanned]);

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
      if (result?.success) {
        setIsCustomerDisplayOpen(true);
        dispatch({
          type: 'display/setMode',
          payload: { mode: cart.items.length > 0 ? 'cart' : 'idle' },
        });
      }
    });
  };

  const handleCloseCustomerDisplay = () => {
    window.electronAPI.window.close('customer').then((result: any) => {
      if (result?.success) setIsCustomerDisplayOpen(false);
    });
  };

  const handleOpenPayment = useCallback((prefillCashGrosze?: number) => {
    setPaymentPrefillCashGrosze(prefillCashGrosze);
    setShowPayment(true);
  }, []);

  const handleClosePayment = useCallback(() => {
    setShowPayment(false);
    setPaymentPrefillCashGrosze(undefined);
  }, []);

  // Category strip is a touch carousel: native horizontal scroll + chevron
  // affordances. Chevrons only appear when there's overflow that direction so
  // they don't crowd the toolbar on small catalogs.
  const categoryScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateCategoryScrollHints = useCallback(() => {
    const el = categoryScrollRef.current;
    if (!el) return;
    // 1px buffer absorbs sub-pixel rounding so chevrons don't flicker at the edge.
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    updateCategoryScrollHints();
    const el = categoryScrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateCategoryScrollHints, { passive: true });
    const ro = new ResizeObserver(updateCategoryScrollHints);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateCategoryScrollHints);
      ro.disconnect();
    };
  }, [updateCategoryScrollHints, categories.length]);

  const scrollCategories = useCallback((direction: 'left' | 'right') => {
    const el = categoryScrollRef.current;
    if (!el) return;
    const delta = el.clientWidth * 0.8;
    el.scrollBy({ left: direction === 'left' ? -delta : delta, behavior: 'smooth' });
  }, []);

  // Default landing view is the category gallery — clicking "All" or
  // returning from a category resets to it. Search and a picked category
  // still drive the regular ProductGrid so the cashier can browse by
  // either entry point.
  const showCategoryGallery = !searchQuery && activeCategoryId === null;

  const productCountByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const product of allProducts) {
      if (!product.category_id) continue;
      map.set(product.category_id, (map.get(product.category_id) ?? 0) + 1);
    }
    return map;
  }, [allProducts]);

  return (
    <>
      {/* Main content */}
      <div className="flex-1 flex overflow-hidden bg-slate-100">
        {/* Left: Products */}
        <div className="flex-1 min-w-0 flex flex-col p-3 gap-3 overflow-hidden">
          {/* Toolbar: search + category pills.
              Borderless / no surface — elements float directly on the page bg
              so the eye sees content first, not chrome. */}
          <div className="shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-[min(380px,44%)] min-w-[310px] shrink-0">
              <SearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                onBarcodeScanned={handleBarcodeScanned}
                placeholder={tOr('pos.searchByCode', 'Search by EAN / SKU...')}
              />
              </div>

              <div className="flex-1 min-w-0 relative">
                <button
                  type="button"
                  onClick={() => scrollCategories('left')}
                  aria-label={tOr('pos.scrollCategoriesLeft', 'Scroll categories left')}
                  tabIndex={canScrollLeft ? 0 : -1}
                  className={`absolute left-0 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full bg-white/95 backdrop-blur-sm shadow-sm flex items-center justify-center text-slate-700 hover:bg-brand-50 hover:text-brand-700 transition-opacity duration-150 cursor-pointer touch-manipulation focus:outline-none focus:ring-2 focus:ring-brand-200 ${
                    canScrollLeft ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
                  }`}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <div
                  ref={categoryScrollRef}
                  className="flex items-center gap-2 overflow-x-auto scrollbar-hide scroll-smooth"
                >
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
                    className={`shrink-0 min-h-11 px-4 rounded-lg text-sm font-bold whitespace-nowrap transition-colors duration-150 cursor-pointer touch-manipulation border focus:outline-none focus:ring-2 focus:ring-brand-200 ${
                      activeCategoryId === null
                        ? 'bg-brand-600 text-white border-brand-600 shadow-sm'
                        : 'bg-white text-slate-700 border-slate-300 hover:border-brand-400 hover:text-brand-700 hover:bg-brand-50'
                    }`}
                  >
                    {t('pos.allCategories') || 'All'}
                  </button>
                  {categories.map((cat) => {
                    const isActive = activeCategoryId === cat.id;
                    return (
                      <button
                        key={cat.id}
                        onClick={() => setActiveCategoryId(isActive ? null : cat.id)}
                        className={`shrink-0 min-h-11 px-4 rounded-lg text-sm font-bold whitespace-nowrap transition-colors duration-150 cursor-pointer touch-manipulation border flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-brand-200 ${
                          isActive
                            ? 'bg-brand-600 text-white border-brand-600 shadow-sm'
                            : 'bg-white text-slate-700 border-slate-300 hover:border-brand-400 hover:text-brand-700 hover:bg-brand-50'
                        }`}
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: isActive ? '#ffffff' : (cat.color || '#da7756') }}
                          aria-hidden="true"
                        />
                        {resolveName(cat, lang)}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => scrollCategories('right')}
                  aria-label={tOr('pos.scrollCategoriesRight', 'Scroll categories right')}
                  tabIndex={canScrollRight ? 0 : -1}
                  className={`absolute right-0 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full bg-white/95 backdrop-blur-sm shadow-sm flex items-center justify-center text-slate-700 hover:bg-brand-50 hover:text-brand-700 transition-opacity duration-150 cursor-pointer touch-manipulation focus:outline-none focus:ring-2 focus:ring-brand-200 ${
                    canScrollRight ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
                  }`}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
          {showCategoryGallery ? (
            <div className="flex-1 min-h-0 overflow-y-auto bg-white rounded-lg">
              <div className="flex items-baseline justify-between gap-3 px-4 py-3 border-b border-slate-100 sticky top-0 bg-white z-[1]">
                <h2 className="text-base font-extrabold text-slate-950">
                  {tOr('pos.categories.title', 'Categories')}
                </h2>
                <span className="text-xs font-bold text-slate-500 tabular-nums">
                  {categories.length} {tOr('pos.categories.count', 'categories')}
                </span>
              </div>
              {categories.length === 0 ? (
                <div className="flex items-center justify-center text-slate-500 py-16">
                  <div className="text-center px-6">
                    <svg className="w-12 h-12 mx-auto mb-3 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
                    </svg>
                    <p className="text-sm font-medium text-slate-500">
                      {tOr('pos.categories.title', 'Categories')}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 2xl:grid-cols-4 gap-3 p-4">
                  {categories.map((cat) => {
                    const displayName = resolveName(cat, lang);
                    const count = productCountByCategory.get(cat.id) ?? 0;
                    const bg = cat.color || '#da7756';
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => setActiveCategoryId(cat.id)}
                        className="group flex items-center gap-4 p-4 rounded-2xl bg-white border-2 border-slate-100 hover:border-brand-500 hover:bg-brand-50/40 active:scale-[0.98] transition-all duration-150 cursor-pointer touch-manipulation text-left focus:outline-none focus:ring-2 focus:ring-brand-300 min-h-[96px]"
                      >
                        <div
                          className="shrink-0 w-14 h-14 rounded-xl flex items-center justify-center text-xl font-extrabold"
                          style={{ backgroundColor: `${bg}2E`, color: bg }}
                          aria-hidden="true"
                        >
                          {categoryGlyph(cat, displayName)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-base font-bold text-slate-900 line-clamp-1 leading-tight">
                            {displayName}
                          </p>
                          <p className="text-xs font-medium text-slate-500 mt-1 tabular-nums">
                            {count} {tOr('pos.categories.productCount', 'products')}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <ProductGrid
              products={products}
              onAddProduct={handleAddProduct}
              t={t}
              resetScrollKey={activeCategoryId ?? 'all'}
              lang={lang}
            />
          )}
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
              onQuickAddCamera={onQuickAddCamera}
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
            onPay={handleOpenPayment}
            t={t}
            shiftOpen={shiftPaymentOpen}
            shiftBlockReason={shiftBlockedMessage}
            lang={lang}
            heldCartsCount={heldCarts.length}
            onHold={cart.items.length > 0 ? handleHoldCart : undefined}
          />
        </div>
      </div>

      {/* Payment modal */}
      {showPayment && (
        <PaymentModal
          cart={cart}
          dispatch={dispatch}
          onClose={handleClosePayment}
          onComplete={() => {
            handleClosePayment();
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
          initialCashAmountGrosze={paymentPrefillCashGrosze}
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
