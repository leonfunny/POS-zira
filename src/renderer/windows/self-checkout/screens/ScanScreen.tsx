// Scan + cart screen for the hybrid customer kiosk. Barcode scan remains the
// fastest path, while the category/menu browser is the fallback for kitchen
// items and products without a practical barcode.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hand } from 'lucide-react';
import LanguageSwitch from '../LanguageSwitch';
import { ScLanguage, getScStrings } from '../i18n';
import { ScCartItem } from '../useScCart';
import type {
  CatalogCategory,
  CatalogDepartment,
  SearchProduct,
} from '../types';
import {
  buildVisibleCategories,
  buildVisibleProducts,
} from '../catalog-model';
import CartPanel from '../components/CartPanel';
import KioskMenuPanel from '../components/KioskMenuPanel';
import ScanPrompt from '../components/ScanPrompt';
import SearchDialog from '../components/SearchDialog';
import { useScannerCapture } from '../useScannerCapture';

// Short WebAudio confirmation beep on scan success (~80ms square wave @ 1kHz).
// Distinct from the scanner-hardware beep — gives reassurance for HID readers
// that don't beep themselves and for kiosk operators muting the hardware tone.
let cachedAudioCtx: AudioContext | null = null;
function playScanBeep(kind: 'ok' | 'fail'): void {
  if (typeof window === 'undefined') return;
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    if (!cachedAudioCtx) cachedAudioCtx = new Ctx();
    const ctx = cachedAudioCtx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = kind === 'ok' ? 1320 : 220;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.13);
  } catch {
    /* ignore — autoplay block, missing AudioContext, etc. */
  }
}

interface ScanScreenProps {
  lang: ScLanguage;
  cartItems: ScCartItem[];
  totalGrosze: number;
  onScan: (ean: string) => Promise<unknown> | unknown;
  onSearchProducts: (query: string) => Promise<SearchProduct[]>;
  onAddSearchProduct: (product: SearchProduct) => Promise<unknown> | unknown;
  categories: CatalogCategory[];
  products: SearchProduct[];
  catalogLoading?: boolean;
  onAddCatalogProduct: (product: SearchProduct) => Promise<unknown> | unknown;
  initialDepartment?: CatalogDepartment;
  scanQuantity: number;
  onScanQuantityChange: (quantity: number) => void;
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
  onScan,
  onSearchProducts,
  onAddSearchProduct,
  categories,
  products,
  catalogLoading = false,
  onAddCatalogProduct,
  initialDepartment = 'grocery',
  scanQuantity,
  onScanQuantityChange,
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
  const searchOpenRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRequestSeq = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchTouched, setSearchTouched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activeDepartment, setActiveDepartment] = useState<CatalogDepartment>(initialDepartment);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);

  // ── visual feedback state ─────────────────────────────────────────────
  // Drives the full-screen green flash + last-item highlight after the
  // cart total changes upward. Research: scan feedback must arrive <150ms
  // and use multiple modalities (flash + animation + optional beep).
  const [scanFlashKey, setScanFlashKey] = useState(0);
  const [freshVariantId, setFreshVariantId] = useState<string | null>(null);
  const [totalTickKey, setTotalTickKey] = useState(0);
  const prevTotalRef = useRef(totalGrosze);
  const prevCartLenRef = useRef(cartItems.length);
  const prevQtyByVariantRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const prevTotal = prevTotalRef.current;
    const prevLen = prevCartLenRef.current;
    const prevQty = prevQtyByVariantRef.current;
    if (totalGrosze > prevTotal) {
      setScanFlashKey((k) => k + 1);
      setTotalTickKey((k) => k + 1);
      // Find the cart line whose quantity grew (or that just appeared).
      let fresh: string | null = null;
      for (const item of cartItems) {
        const before = prevQty[item.variantId] ?? 0;
        if (item.quantity > before) { fresh = item.variantId; break; }
      }
      if (!fresh && cartItems.length > prevLen) {
        fresh = cartItems[cartItems.length - 1]?.variantId ?? null;
      }
      setFreshVariantId(fresh);
      const id = window.setTimeout(() => setFreshVariantId(null), 320);
      // No cleanup needed — short-lived timeout, will fire before unmount.
      void id;
      // Best-effort WebAudio beep on scan success — distinct from the
      // scanner-hardware beep, gives reassurance even with USB-HID readers
      // that don't beep themselves.
      playScanBeep('ok');
    }
    prevTotalRef.current = totalGrosze;
    prevCartLenRef.current = cartItems.length;
    const nextQty: Record<string, number> = {};
    for (const item of cartItems) nextQty[item.variantId] = item.quantity;
    prevQtyByVariantRef.current = nextQty;
  }, [cartItems, totalGrosze]);

  const isScannerCaptureSuspended = useCallback(() => searchOpenRef.current, []);
  const { scannerInputRef, handleScannerInputKeyDown } = useScannerCapture({
    onScan,
    suspendCapture: isScannerCaptureSuspended,
  });

  const openSearch = useCallback(() => {
    searchOpenRef.current = true;
    setSearchOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    searchOpenRef.current = false;
    setSearchOpen(false);
  }, []);

  useEffect(() => {
    searchOpenRef.current = searchOpen;
    if (!searchOpen) {
      setSearchQuery('');
      setSearchResults([]);
      setSearchTouched(false);
      setSearchError(null);
      return;
    }
    const id = window.setTimeout(() => searchInputRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [searchOpen]);

  const runSearch = useCallback(
    async (query = searchQuery) => {
      const trimmed = query.trim();
      const requestId = ++searchRequestSeq.current;
      setSearchTouched(true);
      setSearchError(null);
      if (!trimmed) {
        setSearchResults([]);
        return;
      }
      setSearching(true);
      try {
        const results = await onSearchProducts(trimmed);
        if (searchRequestSeq.current === requestId) {
          setSearchResults(results);
        }
      } catch {
        if (searchRequestSeq.current === requestId) {
          setSearchResults([]);
          setSearchError(t.searchError);
        }
      } finally {
        if (searchRequestSeq.current === requestId) {
          setSearching(false);
        }
      }
    },
    [onSearchProducts, searchQuery, t.searchError],
  );

  useEffect(() => {
    if (!searchOpen) return;
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      searchRequestSeq.current += 1;
      setSearchTouched(false);
      setSearchResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    const id = window.setTimeout(() => void runSearch(trimmed), 250);
    return () => window.clearTimeout(id);
  }, [runSearch, searchOpen, searchQuery]);

  const handleAddSearchProduct = useCallback(
    async (product: SearchProduct) => {
      const added = await onAddSearchProduct(product);
      if (added !== false) closeSearch();
    },
    [closeSearch, onAddSearchProduct],
  );

  const visibleCategories = useMemo(() => {
    return buildVisibleCategories(categories, products, activeDepartment);
  }, [activeDepartment, categories, products]);

  const visibleProducts = useMemo(() => {
    return buildVisibleProducts(categories, products, activeDepartment, activeCategoryId);
  }, [activeCategoryId, activeDepartment, categories, products]);

  useEffect(() => {
    if (!activeCategoryId) return;
    if (!visibleCategories.some((category) => category.id === activeCategoryId)) {
      setActiveCategoryId(null);
    }
  }, [activeCategoryId, visibleCategories]);

  const handleDepartmentChange = useCallback((department: CatalogDepartment) => {
    setActiveDepartment(department);
    setActiveCategoryId(null);
  }, []);

  useEffect(() => {
    setActiveDepartment(initialDepartment);
    setActiveCategoryId(null);
  }, [initialDepartment]);

  const handleAddCatalogProduct = useCallback(
    async (product: SearchProduct) => {
      await onAddCatalogProduct(product);
    },
    [onAddCatalogProduct],
  );

  return (
    <div className="sc-shell flex h-screen w-screen flex-col overflow-hidden select-none">
      {scanFlashKey > 0 && (
        <div key={scanFlashKey} className="sc-scan-flash" aria-hidden="true" />
      )}
      <input
        ref={scannerInputRef}
        onKeyDown={handleScannerInputKeyDown}
        inputMode="none"
        data-scanner-capture="true"
        aria-label={t.barcodeScannerLabel}
        tabIndex={-1}
        className="pointer-events-none fixed h-px w-px opacity-0"
      />
      <header className="sc-shopping-header flex items-center justify-between border-b border-[var(--sc-border)] bg-white/95 px-6 py-3">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--sc-primary)] text-xl font-black text-white">
            Z
          </div>
          <div>
            <div className="text-sm font-black uppercase tracking-[0.16em] text-[var(--sc-primary-deep)]">
              Zira AI
            </div>
            <div className="text-sm font-semibold text-[var(--sc-muted)]">
              {t.kioskName}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <LanguageSwitch lang={lang} onLangChange={onLangChange} compact />
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

      <main className="sc-shopping-main grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(380px,430px)] gap-4 p-4">
        <section className="flex min-h-0 flex-col gap-4">
          <ScanPrompt
            lang={lang}
            scanQuantity={scanQuantity}
            onScanQuantityChange={onScanQuantityChange}
            onOpenSearch={openSearch}
            toast={toast}
            compact={cartItems.length > 0}
          />

          <KioskMenuPanel
            lang={lang}
            activeDepartment={activeDepartment}
            activeCategoryId={activeCategoryId}
            categories={visibleCategories}
            products={visibleProducts}
            catalogLoading={catalogLoading}
            onDepartmentChange={handleDepartmentChange}
            onCategorySelect={setActiveCategoryId}
            onAddProduct={(product) => void handleAddCatalogProduct(product)}
            onOpenSearch={openSearch}
            onCallStaff={onCallStaff}
          />
        </section>

        <CartPanel
          lang={lang}
          items={cartItems}
          totalGrosze={totalGrosze}
          freshVariantId={freshVariantId}
          totalTickKey={totalTickKey}
          onIncrement={onIncrement}
          onDecrement={onDecrement}
          onRemove={onRemove}
          onCheckout={onCheckout}
        />
      </main>
      {searchOpen && (
        <SearchDialog
          lang={lang}
          inputRef={searchInputRef}
          query={searchQuery}
          searching={searching}
          touched={searchTouched}
          error={searchError}
          results={searchResults}
          onQueryChange={setSearchQuery}
          onSubmit={() => void runSearch()}
          onClose={closeSearch}
          onAddProduct={(product) => void handleAddSearchProduct(product)}
          onCallStaff={onCallStaff}
        />
      )}
    </div>
  );
}
