import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Loader2, Mic, ScanSearch } from 'lucide-react';
import type { Product, Category } from '../../../../hooks/usePosDb';
import type { PosState, PosAction, CartItem } from '../../../../hooks/usePosStore';
import rlog from '../../../../utils/logger';
import { useConfig } from '../../../../hooks/useConfig';
import { formatProductLabelPriceText } from '../../../../utils/product-label';
import { resolveName } from '../../../../../shared/catalog-names';
import { classifyProductSale, type ProductSaleClassification } from '../../../../../shared/product-sale-classifier';
import { normalizeSellBy } from '../../../../../shared/pos-sale';
import { formatRetailSaleError, resolveRetailCartItem } from '../../retail-sale-flow';
import SearchBar from '../../SearchBar';
import ProductGrid from '../../ProductGrid';
import Cart from '../../Cart';
import { usePosVoiceSearch, type PosVoiceStatus } from '../../usePosVoiceSearch';
import AutoCameraSearch, {
  type AutoCameraCapturedImage,
  type AutoCameraSearchStatus,
} from '../../AutoCameraSearch';
import PaymentModal from '../../PaymentModal';
import OrderHistoryModal from '../../OrderHistoryModal';
import QuickActions from './QuickActions';
import {
  RETAIL_UNIT_FILTERS,
  type RetailUnitFilter,
  countForRetailUnitFilter,
  countRetailProductsByCategory,
  filterRetailBrowseProducts,
  getVisibleRetailCategories,
  sortCategoriesByRank,
  countNoBarcodeByCategory,
  categoryImageUrl,
} from './retailBrowseFilters';

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

const RECOGNITION_TEXT_KEYS = [
  'ean',
  'barcode',
  'detectedEan',
  'detected_ean',
  'name',
  'productName',
  'product_name',
  'productType',
  'product_type',
  'namePreferred',
  'name_preferred',
  'label',
  'title',
];

const RECOGNITION_BARCODE_KEYS = ['ean', 'barcode', 'detectedEan', 'detected_ean'];
const AUTO_CAMERA_SCALE_TIMEOUT_MS = 1500;
const PRINT_LAST_CART_LABEL_COMMAND = '00000000';
const PAY_CARD_SCAN_COMMAND = '11111111';
const PAY_CASH_SCAN_COMMAND = '22222222';
const VOICE_SEARCH_SCAN_COMMAND = '55555555';
const RETAIL_SCAN_COMMANDS = [
  PRINT_LAST_CART_LABEL_COMMAND,
  PAY_CARD_SCAN_COMMAND,
  PAY_CASH_SCAN_COMMAND,
  VOICE_SEARCH_SCAN_COMMAND,
];

type AddProductSource = 'manual' | 'auto';
type PaymentInitialMethod = 'CASH' | 'CARD';

function firstRecognitionString(source: any, keys: string[]): string | null {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function recognitionCandidates(input: any[]): any[] {
  return input.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const nested = Array.isArray(item.products) ? item.products : [];
    return [item, ...nested];
  });
}

function uniqueRecognitionTerms(products: any[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const product of recognitionCandidates(products)) {
    const term = firstRecognitionString(product, RECOGNITION_TEXT_KEYS);
    if (!term) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms.slice(0, 5);
}

function autoCameraStatusText(
  status: AutoCameraSearchStatus,
  tOr: (key: string, fallback: string) => string,
): string {
  switch (status) {
    case 'starting':
      return tOr('pos.autoCamera.starting', 'Camera...');
    case 'motion':
      return tOr('pos.autoCamera.motion', 'Wait...');
    case 'stable':
      return tOr('pos.autoCamera.stable', 'Stable...');
    case 'analyzing':
      return tOr('pos.autoCamera.analyzing', 'AI search...');
    case 'cooldown':
      return tOr('pos.autoCamera.cooldown', 'Added');
    case 'error':
      return tOr('pos.autoCamera.error', 'Check camera');
    case 'watching':
      return tOr('pos.autoCamera.watching', 'Ready');
    case 'off':
    default:
      return tOr('pos.autoCamera.off', 'Off');
  }
}

function voiceStatusText(
  status: PosVoiceStatus,
  tOr: (key: string, fallback: string) => string,
): string {
  switch (status) {
    case 'listening':
      return tOr('pos.voice.listening', 'Listening');
    case 'transcribing':
      return tOr('pos.voice.transcribing', 'Voice search');
    case 'error':
      return tOr('pos.voice.error', 'Mic error');
    case 'ready':
      return tOr('pos.voice.ready', 'Mic ready');
    case 'idle':
    default:
      return tOr('pos.voice.idle', 'Mic');
  }
}

function labelCopiesForCartItem(item: CartItem): number {
  if (normalizeSellBy(item.sellBy) === 'WEIGHT') return 1;
  return Math.max(1, Math.min(999, Math.round(Number(item.quantity) || 1)));
}

function getVisibleSearchProducts(searchResults: Product[]): Product[] {
  const variants = searchResults.filter((product) => !product._isDraft);
  const variantBarcodes = new Set(
    variants.map((product) => product.barcode).filter((barcode): barcode is string => !!barcode),
  );
  const drafts = searchResults.filter(
    (product) => product._isDraft && (!product.barcode || !variantBarcodes.has(product.barcode)),
  );
  return [...variants, ...drafts];
}

interface RetailTemplateProps {
  state: PosState;
  dispatch: (action: PosAction) => void;
  t: (key: string) => string;
  session: PosState['session'];
  onUnknownBarcodeScanned?: (ean: string) => void | Promise<void>;
  onQuickAddCamera?: () => void;
  onCreateProduct?: () => void;
  onLastLabelVariantChange?: (variantId: string) => void;
  onPrintLastCartLabelCommand?: () => void | Promise<void>;
  onManualWeightRequired?: (product: Product, saleClass: ProductSaleClassification, error: string) => void;
  homeResetKey?: number;
}

export default function RetailTemplate({ state, dispatch, t, session, onUnknownBarcodeScanned, onQuickAddCamera, onCreateProduct, onLastLabelVariantChange, onPrintLastCartLabelCommand, onManualWeightRequired, homeResetKey }: RetailTemplateProps) {
  const [showHistory, setShowHistory] = useState(false);
  const { config } = useConfig();
  const lang = (config?.posLanguage as string | undefined) || (config?.language as string | undefined) || 'pl';
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [activeUnitFilter, setActiveUnitFilter] = useState<RetailUnitFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showPayment, setShowPayment] = useState(false);
  const [paymentPrefillCashGrosze, setPaymentPrefillCashGrosze] = useState<number | undefined>(undefined);
  const [paymentInitialMethod, setPaymentInitialMethod] = useState<PaymentInitialMethod>('CASH');
  const [categories, setCategories] = useState<Category[]>([]);
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [autoCameraEnabled, setAutoCameraEnabled] = useState(false);
  const [autoCameraStatus, setAutoCameraStatus] = useState<AutoCameraSearchStatus>('off');
  const [autoCameraResult, setAutoCameraResult] = useState<string | null>(null);
  const syncErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scaleReadInFlightRef = useRef(false);
  const autoCameraEnabledRef = useRef(false);
  const autoCameraRunIdRef = useRef(0);
  const lastLabelVariantIdRef = useRef<string | null>(null);
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
          }
        }, 2000);
      }
    };
    load();
  }, []);

  // Non-search category browsing is synchronous from the local catalogue
  // cache, so ProductGrid never paints the previous full-catalog state
  // while a category IPC query catches up. The unit filter belongs only to
  // this manual browse path; search and scanner lookup stay global.
  const visibleCategoryProducts = useMemo(() => {
    return filterRetailBrowseProducts(allProducts, activeCategoryId, activeUnitFilter);
  }, [allProducts, activeCategoryId, activeUnitFilter]);

  const visibleSearchProducts = useMemo(() => {
    return getVisibleSearchProducts(searchResults);
  }, [searchResults]);

  const visibleProducts = searchQuery ? visibleSearchProducts : visibleCategoryProducts;
  const visibleSearchProductsRef = useRef<Product[]>(visibleSearchProducts);
  const voiceChoicePendingRef = useRef(false);

  useEffect(() => {
    visibleSearchProductsRef.current = visibleSearchProducts;
  }, [visibleSearchProducts]);

  useEffect(() => {
    if (searchQuery && activeCategoryId !== null) setActiveCategoryId(null);
  }, [searchQuery, activeCategoryId]);

  const loadSearchResults = useCallback(async (query = searchQuery): Promise<Product[]> => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];
    // Retail till searches by name, SKU, and barcode — cashier may either
    // scan/key a code or type a partial product name (grocery items where
    // EAN is missing). Backed by productRepo.search() which normalises
    // Polish + Vietnamese diacritics.
    const variants: Product[] = await window.electronAPI.pos.products.search(trimmedQuery);

    // Also surface master-catalog drafts that match the same code so an
    // unimported item can be added to the cart in one tap. Clicking a
    // draft routes through the scan-import flow (creates the variant on
    // the server, then adds to cart). Drafts are appended after real
    // variants so the cashier sees stocked items first.
    const drafts: any[] = await window.electronAPI.pos.draftProducts
      .searchByCode(trimmedQuery)
      .catch(() => []);
    const draftItems: Product[] = drafts
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
  }, [searchQuery]);

  // Search fetch stays async because it also consults draft_products; the
  // displayed search rows above still react synchronously to category changes.
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!searchQuery) {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      setSearchResults([]);
      return () => {
        cancelled = true;
      };
    }

    const run = async () => {
      const result = await loadSearchResults();
      if (!cancelled) setSearchResults(result);
    };

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(run, 250);

    return () => {
      cancelled = true;
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [loadSearchResults, searchQuery]);

  // Refresh categories + the cached full product list, then preserve the
  // cashier's current view: category browsing recomputes from allProducts;
  // active search re-runs the async variant/draft search.
  useEffect(() => {
    const unsub = window.electronAPI.pos.sync.onProductsSynced(() => {
      void (async () => {
        const [cats, prods] = await Promise.all([
          window.electronAPI.pos.categories.getAll(),
          window.electronAPI.pos.products.getAll(),
        ]);
        setCategories(cats);
        setAllProducts(prods);
        if (searchQuery) {
          setSearchResults(await loadSearchResults());
        }
      })();
    });
    return unsub;
  }, [loadSearchResults, searchQuery]);

  const tOr = useCallback(
    (key: string, fallback: string) => {
      const v = t(key);
      return v !== key ? v : fallback;
    },
    [t],
  );

  useEffect(() => {
    autoCameraEnabledRef.current = autoCameraEnabled;
    if (!autoCameraEnabled) autoCameraRunIdRef.current += 1;
  }, [autoCameraEnabled]);

  const interruptAutoCamera = useCallback((message?: string) => {
    autoCameraRunIdRef.current += 1;
    if (!autoCameraEnabledRef.current) return;
    autoCameraEnabledRef.current = false;
    setAutoCameraEnabled(false);
    setAutoCameraStatus('off');
    setAutoCameraResult(message ?? tOr('pos.autoCamera.paused', 'Auto paused'));
  }, [tOr]);

  useEffect(() => {
    const handler = () => interruptAutoCamera();
    document.addEventListener('pos:manual-cart-action', handler);
    return () => document.removeEventListener('pos:manual-cart-action', handler);
  }, [interruptAutoCamera]);

  // Manual catalog refresh — periodic 30s poll already runs in main, this
  // button is for "I just edited a price on web and want it now" UX.
  // pos:products-synced from main triggers the existing reload effect, so
  // success path doesn't need to re-fetch here.
  const missingShiftStaff = session.isOpen && (!session.staffId || !session.staffName?.trim());
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

  const showToolbarError = useCallback((message: string) => {
    setSyncError(message);
    if (syncErrorTimerRef.current) clearTimeout(syncErrorTimerRef.current);
    syncErrorTimerRef.current = setTimeout(() => setSyncError(null), 4_000);
  }, []);

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

  const handleAddProduct = useCallback(async (product: Product, source: AddProductSource = 'manual') => {
    if (source === 'manual') interruptAutoCamera();
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
    const saleClass = classifyProductSale(product);
    if (saleClass.requiresScale && scaleReadInFlightRef.current) return;
    const readWeight = window.electronAPI.pos?.scale?.readWeight || window.electronAPI.scale?.readWeight;
    const effectiveReadWeight = source === 'auto' && readWeight
      ? (options?: { port?: string }) => Promise.race([
          readWeight(options),
          new Promise((resolve) => {
            window.setTimeout(() => {
              resolve({
                success: false,
                stable: false,
                weightKg: 0,
                error: tOr('pos.autoCamera.scaleTimeout', 'Auto camera scale timeout'),
              });
            }, AUTO_CAMERA_SCALE_TIMEOUT_MS);
          }),
        ]) as ReturnType<typeof readWeight>
      : readWeight;
    if (saleClass.requiresScale) scaleReadInFlightRef.current = true;
    try {
      const result = await resolveRetailCartItem(product, {
        scaleEnabled: config?.scale?.enabled === true,
        scalePort: config?.scale?.port,
        readWeight: effectiveReadWeight,
      });
      if (!result.ok) {
        const message = formatRetailSaleError(result.error, tOr);
        if (result.saleClass.requiresScale && onManualWeightRequired) {
          onManualWeightRequired(product, result.saleClass, message);
        } else {
          showToolbarError(message);
        }
        return;
      }
      dispatch({ type: 'cart/addItem', payload: result.item });
      lastLabelVariantIdRef.current = product.id;
      onLastLabelVariantChange?.(product.id);
    } catch (err: any) {
      showToolbarError(err?.message || tOr('pos.scale.failed', 'Scale did not return a weight'));
    } finally {
      if (saleClass.requiresScale) scaleReadInFlightRef.current = false;
    }
  }, [config?.scale?.enabled, config?.scale?.port, dispatch, interruptAutoCamera, onLastLabelVariantChange, onManualWeightRequired, onUnknownBarcodeScanned, showToolbarError, tOr]);

  const handlePrintProductCode = useCallback(async (product: Product, options: { quantity?: number } = {}) => {
    const barcode = product.barcode?.trim();
    if (!barcode) {
      return { success: false, error: tOr('pos.label.noBarcode', 'Sản phẩm chưa có mã vạch') };
    }

    try {
      const displayName = resolveName(product, lang) || product.name;
      const priceText = formatProductLabelPriceText(product, tOr('pos.currency', 'zl'));
      const result = await window.electronAPI.printLabel(barcode, displayName, {
        priceText,
        sku: product.sku?.trim() || undefined,
        quantity: options.quantity,
      });
      if (result?.success) {
        return { success: true, message: tOr('pos.label.printed', 'Đã in mã') };
      }
      return { success: false, error: result?.error || tOr('pos.label.failed', 'Không in được mã') };
    } catch (err: any) {
      return { success: false, error: err?.message || tOr('pos.label.failed', 'Không in được mã') };
    }
  }, [lang, tOr]);

  const handlePrintCartItemCode = useCallback(async (item: CartItem) => {
    try {
      const product = await window.electronAPI.pos.products.getById(item.variantId);
      if (!product) {
        return { success: false, error: tOr('pos.label.productNotFound', 'Không tìm thấy sản phẩm để in mã') };
      }
      return handlePrintProductCode(product, { quantity: labelCopiesForCartItem(item) });
    } catch (err: any) {
      return { success: false, error: err?.message || tOr('pos.label.failed', 'Không in được mã') };
    }
  }, [handlePrintProductCode, tOr]);

  const handlePrintLastScannedCartItemCode = useCallback(async () => {
    const variantId = lastLabelVariantIdRef.current;
    if (!variantId) {
      showToolbarError(tOr('pos.label.noRecentItem', 'Chưa có hàng vừa quét để in mã'));
      return;
    }

    const item = [...cart.items].reverse().find((line) => line.variantId === variantId);
    if (!item) {
      showToolbarError(tOr('pos.label.recentItemMissing', 'Hàng vừa quét không còn trong cart'));
      return;
    }

    const result = await handlePrintCartItemCode(item);
    if (result?.success === false) {
      showToolbarError(result.error || result.message || tOr('pos.label.failed', 'Không in được mã'));
      return;
    }

    showToolbarError(result?.message || tOr('pos.label.printed', 'Đã in mã'));
  }, [cart.items, handlePrintCartItemCode, showToolbarError, tOr]);

  const handleOpenPaymentScanCommand = useCallback((initialMethod: PaymentInitialMethod) => {
    interruptAutoCamera();
    if (cart.items.length === 0) {
      showToolbarError(tOr('pos.cart.empty', 'Cart is empty'));
      return;
    }
    if (!shiftPaymentOpen) {
      showToolbarError(shiftBlockedMessage || tOr('pos.shift.paymentBlocked', 'Payment is blocked'));
      return;
    }

    setPaymentInitialMethod(initialMethod);
    setPaymentPrefillCashGrosze(initialMethod === 'CASH' ? cart.total : undefined);
    setShowPayment(true);
  }, [cart.items.length, cart.total, interruptAutoCamera, shiftBlockedMessage, shiftPaymentOpen, showToolbarError, tOr]);

  const canRunVoiceCommand = useCallback(() => {
    if (showPayment || showHistory) return false;
    if (document.body.dataset.posAddProductOpen === 'true') return false;
    if (document.body.dataset.posPaymentOpen === 'true') return false;
    return true;
  }, [showHistory, showPayment]);

  const handleVoiceSearchText = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text) {
      showToolbarError(tOr('pos.voice.noSpeech', 'No voice detected'));
      return;
    }

    interruptAutoCamera();
    voiceChoicePendingRef.current = false;
    setSearchQuery(text);
    setActiveCategoryId(null);
    const results = await loadSearchResults(text);
    setSearchResults(results);
    const visibleMatches = getVisibleSearchProducts(results);

    if (visibleMatches.length === 1) {
      await handleAddProduct(visibleMatches[0]);
      return;
    }

    if (visibleMatches.length > 1) {
      voiceChoicePendingRef.current = true;
      showToolbarError(tOr('pos.voice.chooseFirst', 'Scan 55555555 or press Down to add first match'));
      return;
    }

    showToolbarError(tOr('pos.voice.noMatch', 'No matching product'));
  }, [handleAddProduct, interruptAutoCamera, loadSearchResults, showToolbarError, tOr]);

  const {
    status: voiceStatus,
    startCommandCapture: startVoiceCommandCapture,
  } = usePosVoiceSearch({
    enabled: !showPayment && !showHistory,
    canListen: canRunVoiceCommand,
    onCommandText: handleVoiceSearchText,
    onError: showToolbarError,
  });

  const handleVoiceSearchCommand = useCallback(async () => {
    interruptAutoCamera();
    if (!canRunVoiceCommand()) return;
    if (voiceChoicePendingRef.current) {
      const product = visibleSearchProductsRef.current[0];
      if (product) {
        voiceChoicePendingRef.current = false;
        await handleAddProduct(product);
        return;
      }
      voiceChoicePendingRef.current = false;
    }
    await startVoiceCommandCapture();
  }, [canRunVoiceCommand, handleAddProduct, interruptAutoCamera, startVoiceCommandCapture]);

  const handleBarcodeScanned = useCallback(async (barcode: string) => {
    interruptAutoCamera();
    const code = barcode.trim();
    if (code === VOICE_SEARCH_SCAN_COMMAND) {
      await handleVoiceSearchCommand();
      return;
    }
    if (code === PRINT_LAST_CART_LABEL_COMMAND) {
      if (onPrintLastCartLabelCommand) {
        await onPrintLastCartLabelCommand();
      } else {
        await handlePrintLastScannedCartItemCode();
      }
      return;
    }
    if (code === PAY_CARD_SCAN_COMMAND) {
      handleOpenPaymentScanCommand('CARD');
      return;
    }
    if (code === PAY_CASH_SCAN_COMMAND) {
      handleOpenPaymentScanCommand('CASH');
      return;
    }

    const product = await window.electronAPI.pos.products.getByBarcode(code);
    if (product) {
      await handleAddProduct(product);
      return;
    }
    if (onUnknownBarcodeScanned) {
      await onUnknownBarcodeScanned(code);
    }
  }, [handleAddProduct, handleOpenPaymentScanCommand, handlePrintLastScannedCartItemCode, handleVoiceSearchCommand, interruptAutoCamera, onPrintLastCartLabelCommand, onUnknownBarcodeScanned]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target instanceof HTMLInputElement && target.id !== 'pos-product-search') return;
      if (!canRunVoiceCommand()) return;

      event.preventDefault();
      void handleVoiceSearchCommand();
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [canRunVoiceCommand, handleVoiceSearchCommand]);

  const handleAutoCameraCapture = useCallback(async (image: AutoCameraCapturedImage) => {
    const runId = autoCameraRunIdRef.current;
    const stale = () => runId !== autoCameraRunIdRef.current || !autoCameraEnabledRef.current;
    if (stale()) return;
    setAutoCameraResult(null);
    const result = await window.electronAPI.pos.recognition.analyze({
      images: [image],
      language: lang,
    });
    if (stale()) return;
    if (!result?.ok) {
      throw new Error(result?.error || tOr('pos.autoCamera.recognitionFailed', 'Recognition failed'));
    }

    const candidates = recognitionCandidates(Array.isArray(result.products) ? result.products : []);
    if (candidates.length === 0) {
      setAutoCameraResult(tOr('pos.autoCamera.noProduct', 'No match'));
      return;
    }

    for (const candidate of candidates) {
      const code = firstRecognitionString(candidate, RECOGNITION_BARCODE_KEYS);
      if (!code) continue;
      const product = await window.electronAPI.pos.products.getByBarcode(code);
      if (stale()) return;
      if (!product) continue;
      setSearchQuery(code);
      setSearchResults([product]);
      setActiveCategoryId(null);
      await handleAddProduct(product, 'auto');
      if (stale()) return;
      setAutoCameraResult(resolveName(product, lang));
      return;
    }

    const terms = uniqueRecognitionTerms(candidates);
    for (const term of terms) {
      const matches: Product[] = await window.electronAPI.pos.products.search(term);
      if (stale()) return;
      const sellableMatches = matches.filter((match) => !match._isDraft);
      if (sellableMatches.length === 1) {
        const product = sellableMatches[0];
        setSearchQuery(term);
        setSearchResults(sellableMatches);
        setActiveCategoryId(null);
        await handleAddProduct(product, 'auto');
        if (stale()) return;
        setAutoCameraResult(resolveName(product, lang));
        return;
      }
      if (sellableMatches.length > 1) {
        setSearchQuery(term);
        setSearchResults(sellableMatches);
        setActiveCategoryId(null);
        setAutoCameraResult(tOr('pos.autoCamera.chooseMatch', 'Choose item'));
        return;
      }
    }

    const fallbackTerm = terms[0];
    if (fallbackTerm) {
      setSearchQuery(fallbackTerm);
      setActiveCategoryId(null);
    }
    setAutoCameraResult(tOr('pos.autoCamera.noLocalMatch', 'No local match'));
  }, [handleAddProduct, lang, tOr]);

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

  const categoryUnitCounts = useMemo(() => {
    return countRetailProductsByCategory(allProducts);
  }, [allProducts]);

  // "Must-tap" counts: products with no barcode (fresh produce/meat) per
  // category — surfaced as a badge so the owner sees which categories actually
  // need prominent placement, and so cashiers spot the tap-only groups.
  const noBarcodeCounts = useMemo(() => countNoBarcodeByCategory(allProducts), [allProducts]);

  // Categories are shown in owner-configured priority order (sort_order asc).
  // All tiles render at the same size; priority only affects ordering.
  const visibleCategories = useMemo(() => {
    const browseUnitFilter = searchQuery ? 'all' : activeUnitFilter;
    return sortCategoriesByRank(getVisibleRetailCategories(categories, categoryUnitCounts, browseUnitFilter));
  }, [categories, categoryUnitCounts, activeUnitFilter, searchQuery]);

  const handleUnitFilterChange = useCallback((nextFilter: RetailUnitFilter) => {
    if (searchQuery) return;
    setActiveUnitFilter(nextFilter);
    setActiveCategoryId(null);
  }, [searchQuery]);

  useEffect(() => {
    if (!activeCategoryId) return;
    const activeCount = countForRetailUnitFilter(categoryUnitCounts.get(activeCategoryId), activeUnitFilter);
    if (activeCount === 0) setActiveCategoryId(null);
  }, [activeCategoryId, activeUnitFilter, categoryUnitCounts]);

  const handleOpenPayment = useCallback((prefillCashGrosze?: number, initialMethod: PaymentInitialMethod = 'CASH') => {
    setPaymentInitialMethod(initialMethod);
    setPaymentPrefillCashGrosze(prefillCashGrosze);
    setShowPayment(true);
  }, []);

  const handleClosePayment = useCallback(() => {
    setShowPayment(false);
    setPaymentPrefillCashGrosze(undefined);
    setPaymentInitialMethod('CASH');
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
  }, [updateCategoryScrollHints, visibleCategories.length, activeUnitFilter]);

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
  const browseActiveCategoryId = searchQuery ? null : activeCategoryId;
  const browseUnitFilter = searchQuery ? 'all' : activeUnitFilter;
  const showCategoryGallery = !searchQuery && browseActiveCategoryId === null;

  useEffect(() => {
    if (!homeResetKey) return;
    setSearchQuery('');
    setSearchResults([]);
    setActiveCategoryId(null);
    setActiveUnitFilter('all');
    setShowPayment(false);
    setPaymentPrefillCashGrosze(undefined);
    setPaymentInitialMethod('CASH');
    setShowHistory(false);
    setAutoCameraEnabled(false);
    setAutoCameraStatus('off');
    setAutoCameraResult(null);
    voiceChoicePendingRef.current = false;
  }, [homeResetKey]);

  return (
    <>
      <AutoCameraSearch
        enabled={autoCameraEnabled && !showPayment && !showHistory}
        onCapture={handleAutoCameraCapture}
        onStatus={setAutoCameraStatus}
        onError={(message) => showToolbarError(message)}
      />
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
                onChange={(value) => {
                  interruptAutoCamera();
                  voiceChoicePendingRef.current = false;
                  setSearchQuery(value);
                }}
                onBarcodeScanned={handleBarcodeScanned}
                commandBarcodes={RETAIL_SCAN_COMMANDS}
                placeholder={tOr('pos.searchByCode', 'Search by EAN / SKU...')}
              />
              </div>

              <button
                type="button"
                onClick={() => {
                  setAutoCameraEnabled((enabled) => {
                    if (enabled) autoCameraRunIdRef.current += 1;
                    return !enabled;
                  });
                  setAutoCameraResult(null);
                }}
                aria-pressed={autoCameraEnabled}
                title={tOr('pos.autoCamera.toggle', 'Auto camera search')}
                className={`shrink-0 min-h-11 px-3 rounded-lg border inline-flex items-center gap-2 text-xs font-extrabold transition-colors duration-150 cursor-pointer touch-manipulation focus:outline-none focus:ring-2 focus:ring-brand-200 ${
                  autoCameraEnabled
                    ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                    : 'bg-white text-slate-700 border-slate-300 hover:border-brand-400 hover:text-brand-700 hover:bg-brand-50'
                }`}
              >
                {autoCameraStatus === 'analyzing' ? (
                  <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                ) : (
                  <ScanSearch size={16} aria-hidden="true" />
                )}
                <span>{tOr('pos.autoCamera.button', 'Auto')}</span>
              </button>

              {autoCameraEnabled && (
                <span
                  role="status"
                  className="shrink-0 max-w-28 truncate rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-bold text-emerald-700"
                  title={autoCameraResult || autoCameraStatusText(autoCameraStatus, tOr)}
                >
                  {autoCameraResult || autoCameraStatusText(autoCameraStatus, tOr)}
                </span>
              )}

              {voiceStatus !== 'idle' && (
                <span
                  role="status"
                  className={`shrink-0 max-w-32 inline-flex items-center gap-1 truncate rounded-md border px-2 py-1 text-[11px] font-bold ${
                    voiceStatus === 'error'
                      ? 'border-red-200 bg-red-50 text-red-700'
                      : 'border-sky-200 bg-sky-50 text-sky-700'
                  }`}
                  title={voiceStatusText(voiceStatus, tOr)}
                >
                  {voiceStatus === 'transcribing' ? (
                    <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Mic size={12} aria-hidden="true" />
                  )}
                  <span className="truncate">{voiceStatusText(voiceStatus, tOr)}</span>
                </span>
              )}

              <div
                className="shrink-0 inline-flex min-h-11 rounded-lg border border-slate-300 bg-white p-0.5"
                role="group"
                aria-label={tOr('pos.unitFilter.label', 'Unit filter')}
              >
                {RETAIL_UNIT_FILTERS.map((filter) => {
                  const isActive = browseUnitFilter === filter.id;
                  return (
                    <button
                      key={filter.id}
                      type="button"
                      onClick={() => handleUnitFilterChange(filter.id)}
                      aria-disabled={searchQuery ? true : undefined}
                      className={`min-w-14 px-3 rounded-md text-xs font-extrabold whitespace-nowrap transition-colors duration-150 cursor-pointer touch-manipulation focus:outline-none focus:ring-2 focus:ring-brand-200 ${
                        isActive
                          ? 'bg-brand-600 text-white shadow-sm'
                          : 'text-slate-600 hover:bg-brand-50 hover:text-brand-700'
                      }`}
                    >
                      {tOr(filter.labelKey, filter.fallback)}
                    </button>
                  );
                })}
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
                    type="button"
                    onClick={() => {
                      if (searchQuery) return;
                      setActiveCategoryId(null);
                    }}
                    className={`shrink-0 min-h-11 px-4 rounded-lg text-sm font-bold whitespace-nowrap transition-colors duration-150 cursor-pointer touch-manipulation border focus:outline-none focus:ring-2 focus:ring-brand-200 ${
                      !searchQuery && browseActiveCategoryId === null
                        ? 'bg-brand-600 text-white border-brand-600 shadow-sm'
                        : 'bg-white text-slate-700 border-slate-300 hover:border-brand-400 hover:text-brand-700 hover:bg-brand-50'
                    }`}
                  >
                    {tOr('pos.allCategories', 'All')}
                  </button>
                  {visibleCategories.map((cat) => {
                    const isActive = browseActiveCategoryId === cat.id;
                    const count = countForRetailUnitFilter(categoryUnitCounts.get(cat.id), browseUnitFilter);
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => {
                          if (searchQuery) return;
                          setActiveCategoryId(isActive ? null : cat.id);
                        }}
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
                        <span
                          className={`text-[11px] font-extrabold tabular-nums ${
                            isActive ? 'text-white/85' : 'text-slate-500'
                          }`}
                        >
                          {count}
                        </span>
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
                  {visibleCategories.length} {tOr('pos.categories.count', 'categories')}
                </span>
              </div>
              {visibleCategories.length === 0 ? (
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
                  {visibleCategories.map((cat) => {
                    const displayName = resolveName(cat, lang);
                    const bg = cat.color || '#da7756';
                    // Uniform image-first tiles: every category renders at the
                    // same size and aspect ratio so the grid stays even with no
                    // ragged gaps. Priority order is still preserved (categories
                    // are sorted by rank before this map), it just no longer
                    // changes tile size.
                    const noBarcode = noBarcodeCounts.get(cat.id)?.noBarcode ?? 0;
                    const catImg = categoryImageUrl(cat);
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => setActiveCategoryId(cat.id)}
                        className="group relative flex flex-col overflow-hidden rounded-2xl bg-white border-2 border-slate-100 hover:border-brand-500 active:scale-[0.98] transition-all duration-150 cursor-pointer touch-manipulation text-left focus:outline-none focus:ring-2 focus:ring-brand-300"
                      >
                        <div className="relative w-full overflow-hidden bg-slate-100 aspect-[4/3]">
                          {catImg ? (
                            <img
                              src={catImg}
                              alt={displayName}
                              loading="lazy"
                              className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                            />
                          ) : (
                            <div
                              className="w-full h-full flex items-center justify-center font-extrabold text-3xl"
                              style={{ backgroundColor: `${bg}2E`, color: bg }}
                              aria-hidden="true"
                            >
                              {categoryGlyph(cat, displayName)}
                            </div>
                          )}
                          {noBarcode > 0 && (
                            <span className="absolute top-2 left-2 text-[10px] font-extrabold leading-none px-2 py-1 rounded-md bg-amber-500 text-white shadow-sm tabular-nums">
                              {noBarcode} {tOr('pos.categories.mustTap', 'cần bấm')}
                            </span>
                          )}
                        </div>
                        <div className="px-2.5 py-2">
                          <p className="font-extrabold text-slate-900 line-clamp-1 leading-tight text-sm">
                            {displayName}
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
              products={visibleProducts}
              onAddProduct={handleAddProduct}
              onLongPressProduct={handlePrintProductCode}
              t={t}
              resetScrollKey={`${searchQuery ? 'search' : 'browse'}:${browseActiveCategoryId ?? 'all'}:${browseUnitFilter}`}
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
              onQuickAddCamera={onQuickAddCamera ? () => {
                interruptAutoCamera();
                onQuickAddCamera();
              } : undefined}
              onCreateProduct={onCreateProduct ? () => {
                interruptAutoCamera();
                onCreateProduct();
              } : undefined}
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
            onPrintItemLabel={handlePrintCartItemCode}
            showOrderActionChips
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
          initialMethod={paymentInitialMethod}
          scanCommands={{
            card: PAY_CARD_SCAN_COMMAND,
            cash: PAY_CASH_SCAN_COMMAND,
          }}
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
