import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Home } from 'lucide-react';
import { usePosStore } from '../../hooks/usePosStore';
import type { CartItem } from '../../hooks/usePosStore';
import type { Product } from '../../hooks/usePosDb';
import { useConfig } from '../../hooks/useConfig';
import { useBarcodeForwarder } from '../../hooks/useBarcodeForwarder';
import { getTranslation, Language, languageNames } from '../../i18n/translations';
import { resolveName } from '../../../shared/catalog-names';
import { normalizeSellBy } from '../../../shared/pos-sale';
import type { ProductSaleClassification } from '../../../shared/product-sale-classifier';
import { findLinePriceAnomaly, formatPriceAnomalyMessage } from '../../../shared/pos-price-guard';
import rlog from '../../utils/logger';
import { formatProductLabelPriceText } from '../../utils/product-label';
import ShiftModal from './ShiftModal';
import ShiftReportModal from './ShiftReport';
import RetailTemplate from './templates/retail/RetailTemplate';
import SalonTemplate from './templates/salon/SalonTemplate';
import B2BTemplate from './templates/b2b/B2BTemplate';
import RestaurantTemplate from './templates/restaurant/RestaurantTemplate';
import SyncConflictBanner from './SyncConflictBanner';
import ScanImportModal, { ScanImportDraftPreview } from './ScanImportModal';
import QuickAddCameraModal, {
  QuickAddCapturedImage,
  QuickAddFinalizeInput,
  QuickAddPreparedResult,
} from './QuickAddCameraModal';
import AddProductWebviewPanel from './AddProductWebviewPanel';
import DebtWebviewPanel from './DebtWebviewPanel';
import { buildRetailCartItem, formatRetailSaleError, resolveRetailCartItem } from './retail-sale-flow';

type PosMode = 'retail' | 'salon' | 'b2b' | 'restaurant';

const POS_LANGS: Language[] = ['en', 'pl', 'vi', 'uk', 'ru', 'zh', 'tr'];
const PRINT_LAST_CART_LABEL_COMMAND = '00000000';

function useLiveClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const MODE_LABELS: Record<PosMode, string> = {
  retail: 'pos.mode.retail',
  salon: 'pos.mode.salon',
  b2b: 'pos.mode.b2b',
  restaurant: 'pos.mode.restaurant',
};

function moneyToGrosze(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number.isInteger(n) && Math.abs(n) >= 100 ? n : Math.round(n * 100);
}

function draftPreviewFromLocal(draft: any): ScanImportDraftPreview {
  return {
    id: draft.id,
    name: draft.name,
    barcode: draft.barcode,
    retail_price: Number(draft.retail_price) || 0,
    stock_qty: Number(draft.in_stock) || 0,
    vat_rate: Number(draft.vat_rate) || 23,
    image_url: draft.image_url,
    status: draft.status,
    source: 'draft',
  };
}

function draftPreviewFromLookup(response: any, fallbackEan: string): ScanImportDraftPreview | null {
  const draft = response?.draft ?? response?.product ?? response?.result ?? null;
  const existing = response?.existingProduct ?? response?.existing_product ?? null;
  const source = draft ?? existing;
  if (!source) return null;
  const image = Array.isArray(source.images) ? source.images[0] : source.imageUrl ?? source.image_url;
  const previewSource = response?.source ?? source.source;
  return {
    id: source.draftId ?? source.draft_id ?? source.id ?? source.variantId ?? source.variant_id,
    name: source.namePreferred ?? source.name ?? source.productName ?? source.product_name ?? source.title ?? fallbackEan,
    barcode: source.ean ?? source.barcode ?? fallbackEan,
    retail_price: moneyToGrosze(source.suggestedRetailPrice ?? source.retailPrice ?? source.retail_price ?? source.retailPriceGrosze),
    purchase_price: moneyToGrosze(source.suggestedPurchasePrice ?? source.purchasePrice ?? source.purchase_price),
    stock_qty: Number(source.stockQty ?? source.stock_qty ?? source.currentStock ?? 0) || 0,
    vat_rate: Number(source.taxRate ?? source.vat_rate ?? source.vatRate ?? 23) || 23,
    image_url: image ?? null,
    status: response?.mode ?? source.status,
    source: previewSource,
  };
}

function isExternalScanImportSource(source: string | undefined): boolean {
  return source === 'open_food_facts' || source === 'google_custom_search';
}

function canSellImportedVariant(variant: any, allowOversell = false): string | null {
  const price = Number(variant?.retail_price) || 0;
  const stock = Number(variant?.available_qty ?? variant?.in_stock) || 0;
  if (price <= 0) return 'Product has no selling price. Fix the product before selling.';
  if (!allowOversell && variant?.category_id !== 'cat-5' && stock <= 0) return 'Product has no stock. Fix the product before selling.';
  return null;
}

function labelCopiesForCartItem(item: CartItem): number {
  if (normalizeSellBy(item.sellBy) === 'WEIGHT') return 1;
  return Math.max(1, Math.min(999, Math.round(Number(item.quantity) || 1)));
}

function parseManualWeightInput(value: string): number {
  const parsed = Number.parseFloat(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatManualWeight(value: number, unit: string): string {
  const text = value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `${text} ${unit}`;
}

type TOr = (key: string, fallback: string) => string;

interface ManualWeightPrompt {
  product: Product;
  saleClass: ProductSaleClassification;
  displayName: string;
  error?: string;
}

interface ManualWeightModalProps {
  prompt: ManualWeightPrompt;
  tOr: TOr;
  onClose: () => void;
  onSubmit: (weightKg: number) => void;
}

function ManualWeightModal({ prompt, tOr, onClose, onSubmit }: ManualWeightModalProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const unit = prompt.saleClass.saleUnit || 'kg';

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const weightKg = parseManualWeightInput(value);
    if (weightKg <= 0 || weightKg > 999) {
      setError(tOr('pos.scale.manualWeightInvalid', 'Enter a valid weight'));
      return;
    }
    onSubmit(weightKg);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/45 flex items-center justify-center p-4"
      style={{ paddingBottom: 'calc(var(--touch-keyboard-inset, 0px) + 1rem)' }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg bg-white shadow-xl border border-slate-200 p-4 overflow-y-auto"
        style={{ maxHeight: 'calc(100dvh - var(--touch-keyboard-inset, 0px) - 2rem)' }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-extrabold text-slate-900">{tOr('pos.scale.manualWeightTitle', 'Manual weight')}</h2>
            <p className="mt-1 text-sm font-semibold text-slate-700 truncate">{prompt.displayName}</p>
            {prompt.error && <p className="mt-1 text-xs text-amber-700">{prompt.error}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-md text-slate-500 hover:bg-slate-100 flex items-center justify-center shrink-0"
            aria-label={tOr('common.close', 'Close')}
          >
            &times;
          </button>
        </div>

        <label className="block mt-4">
          <span className="text-xs font-bold uppercase text-slate-500">{unit}</span>
          <input
            autoFocus
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              if (error) setError(null);
            }}
            inputMode="decimal"
            placeholder="0.000"
            className="mt-1 w-full h-12 rounded-md border border-slate-300 px-3 text-lg font-black tabular-nums outline-none focus:ring-2 focus:ring-emerald-200 focus:border-emerald-400"
          />
        </label>

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-md border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            {tOr('common.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            className="h-10 px-4 rounded-md bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700"
          >
            {tOr('pos.scale.addManualWeight', 'Add')}
          </button>
        </div>
      </form>
    </div>
  );
}

interface POSLayoutProps {
  onFullscreen?: () => void;
}

export default function POSLayout({ onFullscreen }: POSLayoutProps = {}) {
  useBarcodeForwarder();
  const { state, dispatch } = usePosStore();
  const { config, saveConfig } = useConfig();
  const allowOversell = config?.allowOversell === true;
  const [language, setLanguage] = useState<Language>((config?.posLanguage as Language) || (config?.language as Language) || 'pl');
  const [posMode, setPosMode] = useState<PosMode>((config?.posMode as PosMode) || 'salon');
  const [isOnline, setIsOnline] = useState(false);
  const [showShiftModal, setShowShiftModal] = useState<'open' | 'close' | null>(null);
  const [shiftReport, setShiftReport] = useState<any>(null);
  const [langOpen, setLangOpen] = useState(false);
  const [scanToast, setScanToast] = useState<{ text: string; type: 'ok' | 'err' } | null>(null);
  const [manualWeightPrompt, setManualWeightPrompt] = useState<ManualWeightPrompt | null>(null);
  const [scanImport, setScanImport] = useState<{
    open: boolean;
    ean: string;
    preview: ScanImportDraftPreview | null;
    loading: boolean;
    error: string | null;
  }>({ open: false, ean: '', preview: null, loading: false, error: null });
  const [showQuickAddCamera, setShowQuickAddCamera] = useState(false);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [showDebt, setShowDebt] = useState(false);
  const [homeResetKey, setHomeResetKey] = useState(0);
  // P6: a fiscal receipt that ended in an ambiguous (UNKNOWN) state — the cashier
  // must reconcile it in order history before that order can print again.
  const [fiscalAlert, setFiscalAlert] = useState<{ orderNumber?: string } | null>(null);
  const clock = useLiveClock();

  // Hidden barcode capture for USB HID keyboard-style scanners.
  // Stays focused, captures rapid keystrokes ending with Enter, looks up product.
  // inputMode="none" prevents the on-screen touch keyboard from appearing.
  const barcodeRef = useRef<HTMLInputElement>(null);
  const [barcodeBuffer, setBarcodeBuffer] = useState('');
  const lastLabelVariantIdRef = useRef<string | null>(null);
  // Tracks the most recent time a real text input received keyboard activity.
  // The auto-refocus uses this to back off so SearchBar / customer name fields
  // can be typed via the TouchKeyboard without losing focus to the hidden
  // barcode capture input.
  const lastTextInputActivityRef = useRef(0);

  const focusBarcode = useCallback(() => {
    // Back off entirely while any modal-style overlay is on screen. The
    // app's modals all share the `.fixed.inset-0.z-50` backdrop pattern
    // (Payment, History, ScanImport, Shift, QuickAdd, etc.). Keeping the
    // search input focused behind a modal would double-process scanner
    // wedge keystrokes — once through the focused input, once through the
    // IPC `barcode-scanned` listener that SearchBar still subscribes to.
    if (document.querySelector('.fixed.inset-0.z-50:not([aria-hidden="true"])')) return;

    const active = document.activeElement as HTMLElement | null;

    // Never steal focus from a real, visible text input. Covers the search
    // bar itself, modal fields, customer name, etc. Selects are excluded
    // because they don't take typed text anyway.
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      const inputEl = active as HTMLInputElement;
      if (inputEl.type !== 'hidden' && inputEl.offsetParent !== null) return;
    }

    // Prefer the visible POS search input when mounted (retail mode). No
    // back-off here: the cashier expects the next scan to flow into the
    // search/import path the moment they tap away from a button, so we
    // return focus immediately.
    const search = document.getElementById('pos-product-search') as HTMLInputElement | null;
    if (search && search.offsetParent !== null) {
      search.focus();
      return;
    }

    // Fall back to the hidden capture input (non-retail modes). Keep the
    // 5s back-off on this path so it doesn't yank focus from a visible
    // text input mid-type.
    if (Date.now() - lastTextInputActivityRef.current < 5000) return;
    const el = barcodeRef.current;
    if (el) el.focus();
  }, []);

  // Track input/keyup activity on real text inputs so focusBarcode can back off.
  useEffect(() => {
    const isTextInputTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
      if ((el as HTMLInputElement).type === 'hidden') return false;
      if ((el as HTMLElement).offsetParent === null) return false;
      if ((el as HTMLInputElement).dataset.keyboard === 'false') return false;
      return true;
    };
    const handler = (e: Event) => {
      if (isTextInputTarget(e.target)) lastTextInputActivityRef.current = Date.now();
    };
    document.addEventListener('input', handler, true);
    document.addEventListener('keydown', handler, true);
    document.addEventListener('focusin', handler, true);
    return () => {
      document.removeEventListener('input', handler, true);
      document.removeEventListener('keydown', handler, true);
      document.removeEventListener('focusin', handler, true);
    };
  }, []);

  // Re-focus after every click so the next scan always reaches the search
  // bar — even when the cashier just tapped a button, the empty grid area,
  // a product image, etc. focusBarcode handles its own back-off when the
  // click landed in a real text input or while a modal is on screen, so
  // mid-type interactions and modal flows aren't disturbed.
  useEffect(() => {
    const handler = () => setTimeout(focusBarcode, 0);
    document.addEventListener('click', handler);
    return () => { document.removeEventListener('click', handler); };
  }, [focusBarcode]);

  useEffect(() => { focusBarcode(); }, [focusBarcode]);

  const showScanToast = useCallback((text: string, type: 'ok' | 'err') => {
    setScanToast({ text, type });
    setTimeout(() => setScanToast(null), 2000);
  }, []);

  // Resolve translator above the barcode callback so it can localize the
  // "Sold out" toast string for scanned items.
  const t = getTranslation(language);
  const tOr = useCallback((key: string, fallback: string) => {
    const translated = t(key);
    return translated && translated !== key ? translated : fallback;
  }, [t]);

  const rememberLastLabelVariant = useCallback((variantId: string | null | undefined) => {
    if (variantId) lastLabelVariantIdRef.current = variantId;
  }, []);

  const validateCartLinePrice = useCallback((product: Product, item: CartItem): boolean => {
    const anomaly = findLinePriceAnomaly(item.price, product.retail_price);
    if (!anomaly) return true;
    showScanToast(formatPriceAnomalyMessage(resolveName(product, language) || product.name, anomaly), 'err');
    return false;
  }, [language, showScanToast]);

  const openManualWeightPrompt = useCallback((product: Product, saleClass: ProductSaleClassification, error?: string) => {
    setManualWeightPrompt({
      product,
      saleClass,
      displayName: resolveName(product, language) || product.name,
      error,
    });
  }, [language]);

  const closeManualWeightPrompt = useCallback(() => {
    setManualWeightPrompt(null);
    document.dispatchEvent(new CustomEvent('pos:focus-search'));
  }, []);

  const submitManualWeight = useCallback((weightKg: number) => {
    const prompt = manualWeightPrompt;
    if (!prompt || !dispatch) return;
    const item = buildRetailCartItem(prompt.product, prompt.saleClass, weightKg, crypto.randomUUID());
    if (!validateCartLinePrice(prompt.product, item)) return;
    dispatch({ type: 'cart/addItem', payload: item });
    rememberLastLabelVariant(item.variantId);
    setShowAddProduct(false);
    setManualWeightPrompt(null);
    showScanToast(`+ ${prompt.displayName} (${formatManualWeight(weightKg, prompt.saleClass.saleUnit || 'kg')})`, 'ok');
    document.dispatchEvent(new CustomEvent('pos:focus-search'));
  }, [dispatch, manualWeightPrompt, rememberLastLabelVariant, showScanToast, validateCartLinePrice]);

  const printCartItemLabel = useCallback(async (item: CartItem) => {
    try {
      const product = await window.electronAPI.pos.products.getById(item.variantId);
      if (!product) {
        showScanToast(tOr('pos.label.productNotFound', 'Không tìm thấy sản phẩm để in mã'), 'err');
        return;
      }

      const barcode = product.barcode?.trim();
      if (!barcode) {
        showScanToast(tOr('pos.label.noBarcode', 'Sản phẩm chưa có mã vạch'), 'err');
        return;
      }

      const displayName = resolveName(product, language) || product.name;
      const priceText = formatProductLabelPriceText(product, tOr('pos.currency', 'zl'));
      const result = await window.electronAPI.printLabel(barcode, displayName, {
        priceText,
        sku: product.sku?.trim() || undefined,
        quantity: labelCopiesForCartItem(item),
      });

      if (result?.success) {
        showScanToast(tOr('pos.label.printed', 'Đã in mã'), 'ok');
      } else {
        showScanToast(result?.error || tOr('pos.label.failed', 'Không in được mã'), 'err');
      }
    } catch (err: any) {
      showScanToast(err?.message || tOr('pos.label.failed', 'Không in được mã'), 'err');
    }
  }, [language, showScanToast, tOr]);

  const handlePrintLastCartLabelCommand = useCallback(async () => {
    const items = state?.cart.items ?? [];
    const variantId = lastLabelVariantIdRef.current;
    const item = variantId
      ? [...items].reverse().find((line) => line.variantId === variantId)
      : items[items.length - 1];

    if (!item) {
      showScanToast(tOr('pos.label.noRecentItem', 'Chưa có hàng vừa quét để in mã'), 'err');
      return;
    }

    await printCartItemLabel(item);
  }, [printCartItemLabel, showScanToast, state?.cart.items, tOr]);

  /**
   * Open the scan-import modal for an EAN that's not in the local catalog.
   * Tries the local draft mirror first (fast, offline-safe), falls back to
   * the network lookup-by-ean only if nothing local matches.
   */
  const openScanImport = useCallback(async (ean: string) => {
    const code = ean.trim();
    if (!code) return;
    setScanImport({ open: true, ean: code, preview: null, loading: true, error: null });
    try {
      const local = await window.electronAPI.pos.draftProducts.getByBarcode(code);
      let preview: ScanImportDraftPreview | null = local ? draftPreviewFromLocal(local) : null;

      if (!preview) {
        const remote = await window.electronAPI.pos.masterCatalog.lookupByEan(code);
        if (remote?.ok) preview = draftPreviewFromLookup(remote.draft, code);
      }

      if (!preview) {
        const external = await window.electronAPI.pos.masterCatalog.lookupExternalByEan(code);
        if (external?.ok) preview = draftPreviewFromLookup(external, code);
      }

      if (!preview) {
        setScanImport({ open: false, ean: code, preview: null, loading: false, error: null });
        showScanToast(`Barcode not found: ${code}`, 'err');
        return;
      }

      setScanImport({ open: true, ean: code, preview, loading: false, error: null });
    } catch (err: any) {
      rlog.warn('[POSLayout] scan-import lookup failed', err?.message);
      setScanImport({ open: false, ean: code, preview: null, loading: false, error: null });
      showScanToast(`Barcode not found: ${code}`, 'err');
    }
  }, [showScanToast]);

  const closeScanImport = useCallback(() => {
    setScanImport({ open: false, ean: '', preview: null, loading: false, error: null });
    // Return focus to the search bar so the cashier can scan the next item
    // immediately. Without this, focus stays on the modal backdrop and the
    // next scanner wedge input gets eaten by document.body.
    document.dispatchEvent(new CustomEvent('pos:focus-search'));
  }, []);

  const prepareQuickAdd = useCallback(async (
    images: QuickAddCapturedImage[],
    idempotencyKey: string,
  ): Promise<QuickAddPreparedResult> => {
    // Product `name` is the canonical catalog/receipt name. Keep AI analysis
    // in Polish regardless of the operator UI language; display localization
    // is a separate layer in this app.
    const result = await window.electronAPI.pos.quickAdd.prepare({ images, language: 'pl', idempotencyKey });
    if (!result?.ok) throw new Error(result?.error || 'Quick add prepare failed');
    if (!result.product?.id || !result.variant?.id) throw new Error('Quick add create returned no product ids');
    return {
      analysis: result.analysis ?? {},
      product: result.product,
      variant: result.variant,
    };
  }, []);

  // Pure recognition preview — returns structured products[] for the cashier
  // to eyeball before creating. Does not touch stock; the create flow is
  // unchanged. Returns [] on any failure so the modal degrades gracefully.
  const recognizeQuickAdd = useCallback(async (
    images: QuickAddCapturedImage[],
  ): Promise<any[]> => {
    const result = await window.electronAPI.pos.recognition.analyze({ images, language: 'vi' });
    if (!result?.ok) throw new Error(result?.error || 'Recognition failed');
    return Array.isArray(result.products) ? result.products : [];
  }, []);

  const finalizeQuickAdd = useCallback(async (input: QuickAddFinalizeInput) => {
    const result = await window.electronAPI.pos.quickAdd.finalize({
      productId: input.productId,
      variantId: input.variantId,
      name: input.name,
      retailPrice: input.retailPriceGrosze / 100,
      quantity: input.quantity,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result?.ok) throw new Error(result?.error || 'Quick add finalize failed');

    const variant =
      result.variant
      ?? await window.electronAPI.pos.products.getById(input.variantId)
      ?? (input.ean ? await window.electronAPI.pos.products.getByBarcode(input.ean) : null);
    if (!variant || !dispatch) {
      // The backend mutation already succeeded. Do not surface this as a
      // retryable failure just because the local mirror has not caught up.
      showScanToast('Product saved; catalog refresh pending', 'ok');
      setShowQuickAddCamera(false);
      return;
    }

    const displayName = resolveName(variant, language);
    const item = {
      id: crypto.randomUUID(),
      variantId: variant.id,
      name: variant.name,
      sku: variant.sku || '',
      price: variant.retail_price,
      quantity: 1,
      total: variant.retail_price,
      saleUnit: variant.sale_unit ?? null,
      sellBy: variant.sell_by ?? 'PIECE',
      imageUrl: variant.image_url || undefined,
      vatRate: variant.vat_rate,
      name_translations: variant.name_translations ?? null,
    };
    if (!validateCartLinePrice(variant, item)) return;
    dispatch({
      type: 'cart/addItem',
      payload: item,
    });
    rememberLastLabelVariant(variant.id);
    showScanToast(`+ ${displayName}`, 'ok');
    setShowQuickAddCamera(false);
  }, [dispatch, language, rememberLastLabelVariant, showScanToast, validateCartLinePrice]);

  const confirmScanImport = useCallback(async (retailPriceGrosze: number) => {
    const ean = scanImport.ean;
    if (!ean) return;
    setScanImport((s) => ({ ...s, loading: true, error: null }));
    try {
      const isExternal = isExternalScanImportSource(scanImport.preview?.source);
      // Drafts keep their existing local-first path. External EAN hits go
      // through backend quick-add so the new product exists online too.
      const result = isExternal
        ? await window.electronAPI.pos.masterCatalog.importExternal({ ean, retailPriceGrosze, quantity: 1 })
        : await window.electronAPI.pos.masterCatalog.importDraft({ ean, retailPriceGrosze });
      if (!result?.ok) {
        setScanImport((s) => ({ ...s, loading: false, error: result?.error || 'Import failed' }));
        return;
      }
      const variant = result.variant
        ?? (await window.electronAPI.pos.products.getByBarcode(ean));
      if (variant && dispatch) {
        const sellError = canSellImportedVariant(variant, allowOversell);
        if (sellError) {
          setScanImport((s) => ({ ...s, loading: false, error: sellError }));
          return;
        }
        const displayName = resolveName(variant, language);
        const item = {
          id: crypto.randomUUID(),
          variantId: variant.id,
          name: variant.name,
          sku: variant.sku || '',
          price: variant.retail_price,
          quantity: 1,
          total: variant.retail_price,
          saleUnit: variant.sale_unit ?? null,
          sellBy: variant.sell_by ?? 'PIECE',
          imageUrl: variant.image_url || undefined,
          vatRate: variant.vat_rate,
          name_translations: variant.name_translations ?? null,
        };
        if (!validateCartLinePrice(variant, item)) {
          setScanImport((s) => ({ ...s, loading: false }));
          return;
        }
        dispatch({
          type: 'cart/addItem',
          payload: item,
        });
        rememberLastLabelVariant(variant.id);
        showScanToast(`+ ${displayName}`, 'ok');
      } else {
        showScanToast(`Imported: ${ean}`, 'ok');
      }
      closeScanImport();
    } catch (err: any) {
      rlog.error('[POSLayout] scan-import confirm failed', err?.message);
      setScanImport((s) => ({ ...s, loading: false, error: err?.message ?? 'Import failed' }));
    }
  }, [allowOversell, scanImport.ean, scanImport.preview?.source, dispatch, language, rememberLastLabelVariant, showScanToast, closeScanImport, validateCartLinePrice]);

  const handleAddProductPanelBarcode = useCallback(async (ean: string): Promise<boolean> => {
    const code = ean.trim();
    if (!code || !dispatch) return false;
    try {
      const product = await window.electronAPI.pos.products.getByBarcode(code);
      if (!product) return false;

      const displayName = resolveName(product, language);
      const sellError = canSellImportedVariant(product, allowOversell);
      if (sellError) {
        showScanToast(`${displayName} - ${sellError}`, 'err');
        return true;
      }

      const result = await resolveRetailCartItem(product, {
        scaleEnabled: config?.scale?.enabled === true,
        scalePort: config?.scale?.port,
        readWeight: window.electronAPI.pos?.scale?.readWeight || window.electronAPI.scale?.readWeight,
      });
      if (!result.ok) {
        const message = formatRetailSaleError(result.error, tOr);
        if (result.saleClass.requiresScale) {
          openManualWeightPrompt(product, result.saleClass, message);
          setShowAddProduct(false);
        } else {
          showScanToast(message, 'err');
        }
        return true;
      }

      if (!validateCartLinePrice(product, result.item)) return true;
      dispatch({ type: 'cart/addItem', payload: result.item });
      rememberLastLabelVariant(result.item.variantId);
      showScanToast(`+ ${displayName}`, 'ok');
      setShowAddProduct(false);
      return true;
    } catch (err: any) {
      rlog.error('[POSLayout] add-product panel barcode lookup failed:', err?.message ?? err);
      showScanToast('Scan failed', 'err');
      return true;
    }
  }, [allowOversell, config?.scale?.enabled, config?.scale?.port, dispatch, language, openManualWeightPrompt, rememberLastLabelVariant, showScanToast, tOr, validateCartLinePrice]);

  const handleBarcodeKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = barcodeBuffer.trim();
      setBarcodeBuffer('');
      if (code === PRINT_LAST_CART_LABEL_COMMAND) {
        document.dispatchEvent(new CustomEvent('pos:manual-cart-action'));
        await handlePrintLastCartLabelCommand();
        return;
      }
      if (code.length >= 3 && dispatch) {
        document.dispatchEvent(new CustomEvent('pos:manual-cart-action'));
        try {
          const product = await window.electronAPI.pos.products.getByBarcode(code);
          if (product) {
            // Toast shows the operator-language display name; cart line stores
            // canonical `name` + raw `name_translations` so it re-resolves on
            // language change and receipts keep canonical text.
            const displayName = resolveName(product, language);
            const sellError = canSellImportedVariant(product, allowOversell);
            if (sellError) {
              showScanToast(`${displayName} - ${sellError}`, 'err');
              return;
            }
            if (!allowOversell && product.category_id !== 'cat-5' && (product.available_qty ?? product.in_stock) <= 0) {
              showScanToast(`${displayName} — ${t('pos.product.soldOut') || 'Sold out'}`, 'err');
            } else {
              const result = await resolveRetailCartItem(product, {
                scaleEnabled: config?.scale?.enabled === true,
                scalePort: config?.scale?.port,
                readWeight: window.electronAPI.pos?.scale?.readWeight || window.electronAPI.scale?.readWeight,
              });
              if (!result.ok) {
                const message = formatRetailSaleError(result.error, tOr);
                if (result.saleClass.requiresScale) {
                  openManualWeightPrompt(product, result.saleClass, message);
                } else {
                  showScanToast(message, 'err');
                }
                return;
              }
              if (!validateCartLinePrice(product, result.item)) return;
              dispatch({ type: 'cart/addItem', payload: result.item });
              rememberLastLabelVariant(result.item.variantId);
              showScanToast(`+ ${displayName}`, 'ok');
            }
          } else {
            // Unknown EAN — try the master catalog. openScanImport opens the
            // preview modal if a draft exists locally or remotely; otherwise
            // it falls back to the "Barcode not found" toast.
            await openScanImport(code);
          }
        } catch (err) {
          rlog.error('[POSLayout] Barcode lookup failed:', err);
          showScanToast('Scan failed', 'err');
        }
      }
    }
  }, [allowOversell, barcodeBuffer, config?.scale?.enabled, config?.scale?.port, dispatch, handlePrintLastCartLabelCommand, rememberLastLabelVariant, showScanToast, language, t, tOr, openManualWeightPrompt, openScanImport, validateCartLinePrice]);

  // Sync language/mode from config
  useEffect(() => {
    if (config?.posLanguage) {
      setLanguage(config.posLanguage as Language);
    } else if (config?.language) {
      setLanguage(config.language as Language);
    }
    if (config?.posMode) {
      setPosMode(config.posMode as PosMode);
    }
  }, [config?.posLanguage, config?.language, config?.posMode]);

  const handleLanguageChange = async (lang: Language) => {
    setLanguage(lang);
    setLangOpen(false);
    try {
      await saveConfig({ posLanguage: lang });
    } catch (e) {
      rlog.error('Failed to save language:', e);
    }
  };

  // Load initial connection status
  useEffect(() => {
    window.electronAPI.getStatus().then((status: any) => {
      setIsOnline(status?.connected ?? false);
    }).catch((err: any) => rlog.error('[POSLayout] Failed to load status:', err));
  }, []);

  // Listen for connection status changes
  useEffect(() => {
    const unsub = window.electronAPI.onConnectionStatus((status: any) => {
      setIsOnline(status?.connected ?? false);
    });
    return () => unsub?.();
  }, []);

  // P6: surface ambiguous fiscal results immediately so the cashier reconciles
  // the order in history instead of discovering it only on the next reprint.
  useEffect(() => {
    const unsub = window.electronAPI.pos.onFiscalUnknown?.((info: { orderNumber?: string; orderId?: string }) => {
      setFiscalAlert({ orderNumber: info?.orderNumber || info?.orderId });
    });
    return () => unsub?.();
  }, []);

  // Kitchen ticket could not print for a just-created order (no kitchen
  // printer reachable). The sale itself is fine — alert the cashier so the
  // kitchen learns about the order; Order History has a reprint button.
  useEffect(() => {
    const unsub = (window.electronAPI.pos as any).onKitchenTicketFailed?.(() => {
      showScanToast(tOr('pos.kitchenTicketFailed', 'Kitchen ticket NOT printed — check the kitchen printer'), 'err');
    });
    return () => unsub?.();
  }, [showScanToast, tOr]);

  const session = state?.session ?? { shiftId: null, staffId: null, staffName: null, isOpen: false, openedAt: null };
  const hideNonFiscalOrders = config?.showNonFiscalOrders === false;

  const handleShiftOpen = async (data: { staffId?: string; staffName?: string; openingCash?: number; closingCash?: number }) => {
    if (!data.staffId || !data.staffName?.trim()) throw new Error(tOr('pos.shift.selectStaffRequired', 'Select a staff member'));
    const result = await window.electronAPI.pos.shift.open({
      staffId: data.staffId,
      staffName: data.staffName,
      openingCash: data.openingCash ?? 0,
    });
    if (!result.success) throw new Error(result.error || 'Failed to open shift');
    setShowShiftModal(null);
  };

  const handleShiftClose = async (data: { staffId?: string; staffName?: string; openingCash?: number; closingCash?: number }) => {
    if (!session.shiftId) throw new Error('No active shift');
    const result = await window.electronAPI.pos.shift.close({
      shiftId: session.shiftId,
      closingCash: data.closingCash ?? 0,
      fiscalOnly: hideNonFiscalOrders,
    });
    if (!result.success) throw new Error(result.error || 'Failed to close shift');
    setShowShiftModal(null);
    if (result.report) setShiftReport(result.report);
  };

  const handleHomeReset = useCallback(() => {
    setLangOpen(false);
    setScanToast(null);
    setScanImport({ open: false, ean: '', preview: null, loading: false, error: null });
    setShowQuickAddCamera(false);
    setShowAddProduct(false);
    setFiscalAlert(null);
    setBarcodeBuffer('');
    dispatch({ type: 'cart/clear' });
    dispatch({ type: 'cart/clearDiscount' });
    dispatch({ type: 'customer/clear' });
    dispatch({ type: 'tip/clear' });
    dispatch({ type: 'table/setActive', payload: { tableId: null } });
    dispatch({ type: 'display/setMode', payload: { mode: 'idle' } });
    setHomeResetKey((key) => key + 1);
    setTimeout(() => document.dispatchEvent(new CustomEvent('pos:focus-search')), 0);
  }, [dispatch]);

  if (!state) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-gray-400">
        {/* Hidden barcode input must exist even during loading so scanner keystrokes are captured */}
        <input
          ref={barcodeRef}
          value={barcodeBuffer}
          onChange={(e) => setBarcodeBuffer(e.target.value)}
          onKeyDown={handleBarcodeKeyDown}
          inputMode="none"
          data-keyboard="false"
          aria-label="Barcode scanner"
          tabIndex={-1}
          className="absolute w-0 h-0 opacity-0 pointer-events-none"
        />
        {t('pos.loading')}
      </div>
    );
  }

  return (
    <div className="h-screen bg-slate-50 text-gray-900 flex flex-col overflow-hidden">
      {/* Hidden barcode capture input for USB HID scanners */}
      <input
        ref={barcodeRef}
        value={barcodeBuffer}
        onChange={(e) => setBarcodeBuffer(e.target.value)}
        onKeyDown={handleBarcodeKeyDown}
        inputMode="none"
        data-keyboard="false"
        aria-label="Barcode scanner"
        tabIndex={-1}
        className="absolute w-0 h-0 opacity-0 pointer-events-none"
      />
      {/* Barcode scan toast */}
      {scanToast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-sm font-medium animate-in fade-in slide-in-from-top-2 duration-200 ${
          scanToast.type === 'ok'
            ? 'bg-emerald-600 text-white'
            : 'bg-red-600 text-white'
        }`}>
          {scanToast.text}
        </div>
      )}
      {/* Fiscal UNKNOWN alert — persistent until dismissed; prompts reconciliation */}
      {fiscalAlert && (
        <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-3 bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-lg">
          <span>
            {tOr('pos.fiscal.unknownAlert', 'Hóa đơn fiskal')}
            {fiscalAlert.orderNumber ? ` ${fiscalAlert.orderNumber}` : ''}
            {' — '}
            {tOr('pos.fiscal.unknownAlertBody', 'chưa xác nhận đã in. Mở Lịch sử đơn để đối soát (đã in / chưa in) trước khi in lại.')}
          </span>
          <button
            onClick={() => setFiscalAlert(null)}
            className="ml-2 rounded-md bg-white/20 px-2 py-1 text-xs font-bold hover:bg-white/30"
          >
            {tOr('pos.fiscal.dismiss', 'Đã hiểu')}
          </button>
        </div>
      )}
      {/* Scan import preview modal */}
      <ScanImportModal
        open={scanImport.open}
        preview={scanImport.preview}
        ean={scanImport.ean}
        onConfirm={confirmScanImport}
        onCancel={closeScanImport}
        loading={scanImport.loading}
        error={scanImport.error}
        t={t}
      />
      <QuickAddCameraModal
        open={showQuickAddCamera}
        onClose={() => setShowQuickAddCamera(false)}
        onPrepare={prepareQuickAdd}
        onFinalize={finalizeQuickAdd}
        onRecognize={recognizeQuickAdd}
        t={t}
      />
      <AddProductWebviewPanel
        open={showAddProduct}
        salonCode={(config as any)?.salonCode}
        onProductCreated={(line) => {
          dispatch({ type: 'cart/addItem', payload: { ...line, id: crypto.randomUUID() } });
        }}
        onExistingProductScanned={handleAddProductPanelBarcode}
        onClose={() => setShowAddProduct(false)}
      />
      <DebtWebviewPanel
        open={showDebt}
        salonCode={(config as any)?.salonCode}
        onClose={() => setShowDebt(false)}
      />
      {/* Sync conflict banner (Path B) */}
      <SyncConflictBanner />
      {/* Header - shared across all modes */}
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-gray-200 bg-white shrink-0">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleHomeReset}
            className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-base font-bold tracking-wide text-brand-600 hover:bg-brand-50 active:bg-brand-100 transition-colors cursor-pointer touch-manipulation focus:outline-none focus:ring-2 focus:ring-brand-200"
            aria-label={tOr('pos.homeReset', 'Reset POS home')}
            title={tOr('pos.homeReset', 'Reset POS home')}
          >
            <Home size={17} aria-hidden="true" />
            <span>Zira POS</span>
          </button>
          <span className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-600 font-medium">
            {t(MODE_LABELS[posMode])}
          </span>
          {session.staffName && (
            <span className="text-xs text-gray-500 font-medium">
              {session.staffName}
            </span>
          )}
          {!session.isOpen && (
            <button
              onClick={() => setShowShiftModal('open')}
              className="px-4 py-2.5 text-sm bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100 font-medium transition-colors border border-emerald-200 touch-manipulation"
            >
              {t('pos.shift.open')}
            </button>
          )}
          {session.isOpen && (
            <button
              onClick={() => setShowShiftModal('close')}
              className="px-4 py-2.5 text-sm bg-red-50 text-red-600 rounded-lg hover:bg-red-100 font-medium transition-colors border border-red-200 touch-manipulation"
            >
              {t('pos.shift.close')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          {/* Current time */}
          <div className="text-right">
            <span className="block text-[9px] font-semibold uppercase tracking-[0.15em] text-slate-400">{clock.toLocaleDateString(language === 'vi' ? 'vi-VN' : language === 'pl' ? 'pl-PL' : language === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
            <span className="block text-sm font-bold text-slate-700 tabular-nums">
              {clock.toLocaleTimeString(language === 'vi' ? 'vi-VN' : language === 'pl' ? 'pl-PL' : language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          {/* Debt ledger (so no) */}
          <button
            onClick={() => setShowDebt(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors touch-manipulation"
            title="So no"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
            </svg>
            <span>So no</span>
          </button>

          {/* Fullscreen icon button */}
          {onFullscreen && (
            <button
              onClick={onFullscreen}
              className="p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors duration-150 cursor-pointer"
              title="Enter fullscreen mode"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9M20.25 20.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              </svg>
            </button>
          )}

          {/* Language — globe icon with dropdown */}
          <div className="relative">
            <button
              onClick={() => setLangOpen(!langOpen)}
              className="p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors duration-150 cursor-pointer"
              title="Change language"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 003 12c0-1.605.42-3.113 1.157-4.418" />
              </svg>
            </button>
            {langOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setLangOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-30 bg-white rounded-xl border border-slate-200 shadow-lg py-1 min-w-[120px]">
                  {POS_LANGS.map((l) => (
                    <button
                      key={l}
                      onClick={() => handleLanguageChange(l)}
                      className={`w-full px-3 py-2 text-left text-sm transition-colors duration-150 cursor-pointer flex items-center justify-between ${
                        language === l ? 'bg-brand-50 text-brand-700 font-semibold' : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <span>{languageNames[l]}</span>
                      <span className="text-[10px] font-bold text-slate-400 uppercase">{l}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Connection status */}
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
            isOnline ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-red-50 text-red-600 border-red-200'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-red-500'}`} />
            {isOnline ? t('pos.online') : t('pos.offline')}
          </span>
        </div>
      </div>

      {/* Mode-specific layout */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {posMode === 'retail' && (
          <RetailTemplate
            state={state}
            dispatch={dispatch}
            t={t}
            language={language}
            session={session}
            onUnknownBarcodeScanned={openScanImport}
            onQuickAddCamera={() => setShowQuickAddCamera(true)}
            onCreateProduct={() => setShowAddProduct(true)}
            onLastLabelVariantChange={rememberLastLabelVariant}
            onPrintLastCartLabelCommand={handlePrintLastCartLabelCommand}
            onManualWeightRequired={openManualWeightPrompt}
            homeResetKey={homeResetKey}
          />
        )}
        {posMode === 'salon' && <SalonTemplate state={state} dispatch={dispatch} t={t} language={language} session={session} />}
        {posMode === 'b2b' && <B2BTemplate state={state} dispatch={dispatch} t={t} language={language} session={session} />}
        {posMode === 'restaurant' && <RestaurantTemplate state={state} dispatch={dispatch} t={t} language={language} session={session} />}
      </div>

      {/* Shift modals - shared */}
      {showShiftModal === 'open' && (
        <ShiftModal
          mode="open"
          onSubmit={handleShiftOpen}
          onClose={() => setShowShiftModal(null)}
          t={t}
        />
      )}
      {showShiftModal === 'close' && (
        <ShiftModal
          mode="close"
          shiftId={session.shiftId}
          onSubmit={handleShiftClose}
          onClose={() => setShowShiftModal(null)}
          t={t}
        />
      )}
      {shiftReport && (
        <ShiftReportModal
          report={shiftReport}
          onClose={() => setShiftReport(null)}
          t={t}
        />
      )}
      {manualWeightPrompt && (
        <ManualWeightModal
          prompt={manualWeightPrompt}
          tOr={tOr}
          onClose={closeManualWeightPrompt}
          onSubmit={submitManualWeight}
        />
      )}
    </div>
  );
}
