import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Home, Languages, Maximize2, MoreVertical, ReceiptText, ShoppingCart } from 'lucide-react';
import { usePosStore } from '../../hooks/usePosStore';
import type { CartItem } from '../../hooks/usePosStore';
import type { Product } from '../../hooks/usePosDb';
import { useConfig } from '../../hooks/useConfig';
import { useBarcodeForwarder } from '../../hooks/useBarcodeForwarder';
import { getTranslation, Language, languageNames } from '../../i18n/translations';
import { resolveName } from '../../../shared/catalog-names';
import { isValidManualWeightQuantity, normalizeSellBy } from '../../../shared/pos-sale';
import { classifyProductSale, type ProductSaleClassification } from '../../../shared/product-sale-classifier';
import { isSaleBlockedByStock } from '../../../shared/product-stock-tracking';
import {
  decodeKitchenSelfOrderQr,
  decodeKitchenSelfOrderRefQr,
  resolveKitchenSelfOrderCheckoutUnitPrice,
  type KitchenSelfOrderQrPayload,
} from '../../../shared/kitchen-self-order';
import { findLinePriceAnomaly, formatPriceAnomalyMessage } from '../../../shared/pos-price-guard';
import {
  mergePickupEvent,
  seedPickupOrders,
  removePickupOrder,
  type PickupOrderKitchenPrintStatus,
  type PickupOrderRow,
} from './pickup-queue-merge';
import rlog from '../../utils/logger';
import { formatProductLabelPriceText } from '../../utils/product-label';
import ShiftModal from './ShiftModal';
import ShiftReportModal from './ShiftReport';
import RetailTemplate from './templates/retail/RetailTemplate';
import SalonTemplate from './templates/salon/SalonTemplate';
import B2BTemplate from './templates/b2b/B2BTemplate';
import RestaurantTemplate from './templates/restaurant/RestaurantTemplate';
import PaymentModal from './PaymentModal';
import SyncConflictBanner from './SyncConflictBanner';
import ScanImportModal, { type ScanImportCategoryOption, type ScanImportDraftPreview } from './ScanImportModal';
import QuickAddCameraModal, {
  QuickAddCapturedImage,
  QuickAddFinalizeInput,
  QuickAddPreparedResult,
} from './QuickAddCameraModal';
import AddProductWebviewPanel from './AddProductWebviewPanel';
import DebtWebviewPanel from './DebtWebviewPanel';
import ProductModule from '../products/ProductModule';
import { useProductAdminCapabilities } from '../../hooks/useProductAdminCapabilities';
import { productAdminVariantToCartLine } from '../products/product-admin-variant-adapter';
import { buildRetailCartItem, formatRetailSaleError, resolveRetailCartItem } from './retail-sale-flow';
import {
  createReceiptPrintStatusHandler,
  type ReceiptPrintStatusInfo,
} from './receipt-print-status-tracker';
import type {
  BilliardPaymentIntent,
  RestoredCartReconciliation,
  UncertainTenderResolutionTarget,
} from '../../../shared/billiard-pos-handoff';
import { normalizeVatRate } from '../../../shared/pos/vat-rate';
import {
  PosCapabilityProvider,
  usePosCapabilities,
  type PosCapabilityHost,
} from './capabilities/PosCapabilityProvider';
import type { CashierCapabilityKey } from '../../../shared/pos/cashier-capabilities';

type PosMode = 'retail' | 'salon' | 'b2b' | 'restaurant';

const POS_LANGS: Language[] = ['en', 'pl', 'vi', 'uk', 'ru', 'zh', 'tr'];
const PRINT_LAST_CART_LABEL_COMMAND = '00000000';

// Android's Chromium 83 does not guarantee crypto.randomUUID. This mirrors the
// old external-WebView path's need for a local-only cart identity without
// making a committed server create depend on a newer browser primitive.
function createExternalCartLineId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid || `native-product-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const SAFE_LAYOUT_DEGRADED_CAPABILITIES: Partial<Record<CashierCapabilityKey, string>> = {
  nativeProductCreate: 'REMOTE_ONLY',
  debtLedgerExternal: 'EXTERNAL_ONLY',
};

function isLayoutCapabilityUsable(
  capabilities: ReturnType<typeof usePosCapabilities>,
  key: CashierCapabilityKey,
): boolean {
  if (capabilities.status !== 'ready') return false;
  const outcome = capabilities.manifest.outcomes[key];
  if (
    outcome.state !== 'supported'
    && !(
      outcome.state === 'degraded'
      && SAFE_LAYOUT_DEGRADED_CAPABILITIES[key] === outcome.reasonCode
    )
  ) return false;
  const salon = capabilities.policyInputs.salonConfig[key];
  const entitlement = capabilities.policyInputs.entitlements[key];
  const role = capabilities.policyInputs.roleAccess[key];
  return (salon === 'enabled' || salon === 'not-required')
    && (entitlement === 'granted' || entitlement === 'not-required')
    && (role === 'allowed' || role === 'not-required');
}

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
    retail_price: 0,
    stock_qty: 0,
    vat_rate: normalizeVatRate(draft.vat_rate),
    image_url: draft.image_url,
    status: draft.status,
    source: 'draft',
    suggestedCategoryId: draft.suggestedCategoryId ?? draft.suggested_category_id ?? null,
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
    vat_rate: normalizeVatRate(source.taxRate ?? source.vat_rate ?? source.vatRate),
    image_url: image ?? null,
    status: response?.mode ?? source.status,
    source: previewSource,
    suggestedCategoryId: source.suggestedCategoryId ?? source.suggested_category_id ?? response?.suggestedCategoryId ?? response?.suggested_category_id ?? null,
  };
}

function scanImportCategoryOptions(rows: any[]): ScanImportCategoryOption[] {
  return Array.isArray(rows)
    ? rows
      .filter((row) => row?.id && row?.name)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        icon: row.icon ?? null,
        color: row.color ?? null,
        sort_order: Number(row.sort_order) || 0,
        updated_at: row.updated_at ?? null,
        name_translations: row.name_translations ?? null,
      }))
    : [];
}

function isExternalScanImportSource(source: string | undefined): boolean {
  return source === 'open_food_facts' || source === 'google_custom_search';
}

function canSellImportedVariant(variant: any, allowOversell = false): string | null {
  const price = Number(variant?.retail_price) || 0;
  const stock = Number(variant?.available_qty ?? variant?.in_stock) || 0;
  if (price <= 0) return 'Product has no selling price. Fix the product before selling.';
  if (isSaleBlockedByStock(variant, stock, allowOversell)) return 'Product has no stock. Fix the product before selling.';
  return null;
}

function normalizeKioskQuantity(value: unknown): number {
  return Math.min(99, Math.max(1, Math.floor(Number(value) || 1)));
}

function joinKioskLineNotes(parts: Array<string | null | undefined>): string | undefined {
  const text = parts.map((part) => String(part || '').trim()).filter(Boolean).join(' | ');
  return text || undefined;
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
    if (!isValidManualWeightQuantity(weightKg)) {
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
            className="w-11 h-11 rounded-md text-slate-500 hover:bg-slate-100 flex items-center justify-center shrink-0"
            aria-label={tOr('common.close', 'Close')}
          >
            &times;
          </button>
        </div>

        <label className="block mt-4">
          <span className="text-xs font-bold uppercase text-slate-600">{unit}</span>
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
  capabilityHost?: PosCapabilityHost;
  onFullscreen?: () => void;
  onEditProduct?: (variantId: string) => void;
  billiardPaymentIntent?: BilliardPaymentIntent | null;
  restoredCartReconciliation?: RestoredCartReconciliation | null;
  onBilliardPaymentIntentConsumed?: (nonce: string) => void;
  canResolveUncertainTender?: boolean;
  onBilliardTenderResolved?: (intent: BilliardPaymentIntent) => void;
  onRestoredTenderResolved?: () => void;
  onRestoredCartTenderOutcomeUncertain?: (reconciliation: RestoredCartReconciliation) => void;
  /**
   * The layout fills its PARENT instead of the viewport.
   *
   * On the desktop POSLayout is the whole window, so 100vh is exactly right.
   * The Android shell owns chrome above it (the storage banner and the POS/Bi-a
   * tabs), so a 100vh child overflows its container by precisely that much and
   * pushes the pay button and the Hold/Recall toolbar below the fold — on a
   * till, where the pay button must never need a scroll.
   *
   * Opt-in, so the desktop keeps 100vh: `#root` has no height rule of its own,
   * and switching the shared default to h-full would collapse the window.
   */
  embedded?: boolean;
}

type ScanToastType = 'ok' | 'warn' | 'err';

function normalizePickupKitchenPrintStatus(value: unknown): PickupOrderKitchenPrintStatus {
  return value === 'PRINTED' || value === 'UNCERTAIN' || value === 'FAILED' ? value : 'PENDING';
}

function getPickupKitchenPrintWarning(row: { kitchenPrintStatus?: unknown } | null | undefined): string | null {
  const status = normalizePickupKitchenPrintStatus(row?.kitchenPrintStatus);
  if (status === 'PRINTED') return null;
  if (status === 'FAILED') return 'Phiếu bếp chưa in';
  if (status === 'UNCERTAIN') return 'Bếp chưa xác nhận in';
  return 'Đang chờ phiếu bếp';
}

function getPickupKitchenPrintBadge(statusValue: unknown): { text: string; className: string } {
  const status = normalizePickupKitchenPrintStatus(statusValue);
  if (status === 'PRINTED') {
    return { text: 'Bếp OK', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  }
  if (status === 'FAILED') {
    return { text: 'Bếp lỗi', className: 'bg-red-50 text-red-700 border-red-200' };
  }
  if (status === 'UNCERTAIN') {
    return { text: 'Bếp ?', className: 'bg-amber-50 text-amber-700 border-amber-200' };
  }
  return { text: 'Chờ bếp', className: 'bg-slate-50 text-slate-600 border-slate-200' };
}

export default function POSLayout(props: POSLayoutProps = {}) {
  return (
    <PosCapabilityProvider host={props.capabilityHost}>
      <POSLayoutContent {...props} />
    </PosCapabilityProvider>
  );
}

function POSLayoutContent({
  onFullscreen,
  onEditProduct,
  billiardPaymentIntent,
  restoredCartReconciliation,
  onBilliardPaymentIntentConsumed,
  canResolveUncertainTender = false,
  onBilliardTenderResolved,
  onRestoredTenderResolved,
  onRestoredCartTenderOutcomeUncertain,
  embedded = false,
}: POSLayoutProps) {
  useBarcodeForwarder();
  const { state, dispatch, dispatchError, clearDispatchError } = usePosStore();
  const { config, saveConfig } = useConfig();
  const capabilities = usePosCapabilities();
  const canUseNativeProductCreate = isLayoutCapabilityUsable(capabilities, 'nativeProductCreate');
  const nativeProductOutcome = capabilities.manifest.outcomes.nativeProductCreate;
  const hasAndroidNativeProductPath = capabilities.status === 'ready'
    && nativeProductOutcome.state === 'degraded'
    && nativeProductOutcome.reasonCode === 'RUNTIME_DEGRADED';
  const productAdminScope = hasAndroidNativeProductPath
    ? `${capabilities.manifest.identity.salonId}:${capabilities.manifest.identity.userId}:${capabilities.manifest.identity.registerId}:${capabilities.manifest.identity.authEpoch}`
    : undefined;
  const { capabilities: productAdminCapabilities, invalidate: invalidateProductAdminCapabilities } = useProductAdminCapabilities(
    hasAndroidNativeProductPath,
    productAdminScope,
  );
  // RUNTIME_DEGRADED only exposes a possible renderer path. Server-issued,
  // auth-scoped capability flags are the actual permission to show an action.
  const canUseAndroidNativeProductCreate = hasAndroidNativeProductPath
    && productAdminCapabilities?.canCreateProduct === true;
  const canUseAndroidNativeProductEdit = hasAndroidNativeProductPath
    && (productAdminCapabilities?.canUpdateProduct === true || productAdminCapabilities?.canAdjustStock === true);
  const canUseDebtLedgerExternal = isLayoutCapabilityUsable(capabilities, 'debtLedgerExternal');
  const canUseQuickAddRecognition = isLayoutCapabilityUsable(capabilities, 'quickAddRecognition');
  const canUsePickupOrders = isLayoutCapabilityUsable(capabilities, 'pickupOrders');
  const canUseLabelPrint = isLayoutCapabilityUsable(capabilities, 'labelPrint');
  const canUseScale = isLayoutCapabilityUsable(capabilities, 'scale');
  const allowOversell = config?.allowOversell === true;
  const [language, setLanguage] = useState<Language>((config?.posLanguage as Language) || (config?.language as Language) || 'pl');
  const [posMode, setPosMode] = useState<PosMode>((config?.posMode as PosMode) || 'salon');
  const [isOnline, setIsOnline] = useState(false);
  const [showShiftModal, setShowShiftModal] = useState<'open' | 'close' | null>(null);
  const [shiftReport, setShiftReport] = useState<any>(null);
  const [langOpen, setLangOpen] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [scanToast, setScanToast] = useState<{ text: string; type: ScanToastType } | null>(null);
  const [manualWeightPrompt, setManualWeightPrompt] = useState<ManualWeightPrompt | null>(null);
  const [scanImport, setScanImport] = useState<{
    open: boolean;
    ean: string;
    preview: ScanImportDraftPreview | null;
    loading: boolean;
    error: string | null;
  }>({ open: false, ean: '', preview: null, loading: false, error: null });
  const [scanImportCategories, setScanImportCategories] = useState<ScanImportCategoryOption[]>([]);
  const [showQuickAddCamera, setShowQuickAddCamera] = useState(false);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [nativeProductCreateOpen, setNativeProductCreateOpen] = useState(false);
  const [nativeProductEditId, setNativeProductEditId] = useState<string | null>(null);
  const [showDebt, setShowDebt] = useState(false);
  const [homeResetKey, setHomeResetKey] = useState(0);
  // P6: a fiscal receipt that ended in an ambiguous (UNKNOWN) state — the cashier
  // must reconcile it in order history before that order can print again.
  const [fiscalAlert, setFiscalAlert] = useState<{ orderNumber?: string } | null>(null);
  const [activeBilliardIntent, setActiveBilliardIntent] = useState<BilliardPaymentIntent | null>(null);
  const [billiardPaymentOpen, setBilliardPaymentOpen] = useState(false);
  const [billiardPaymentError, setBilliardPaymentError] = useState<string | null>(null);
  const [billiardPaymentSnapshot, setBilliardPaymentSnapshot] = useState<{
    cart: NonNullable<typeof state>['cart'];
    checkoutDraft: NonNullable<typeof state>['checkoutDraft'];
    paymentPreflightToken: string;
  } | null>(null);
  const handledBilliardNonceRef = useRef<string | null>(null);
  const [tenderResolutionTarget, setTenderResolutionTarget] = useState<UncertainTenderResolutionTarget | null>(null);
  const [tenderResolutionReason, setTenderResolutionReason] = useState('');
  const [tenderResolutionConfirmed, setTenderResolutionConfirmed] = useState(false);
  const [tenderResolutionSaving, setTenderResolutionSaving] = useState(false);
  const [tenderResolutionError, setTenderResolutionError] = useState<string | null>(null);
  // Cashier pickup queue: kitchen self-orders waiting to be paid at the counter.
  const [pickupOrders, setPickupOrders] = useState<PickupOrderRow[]>([]);
  const [pickupPanelOpen, setPickupPanelOpen] = useState(false);
  const [ownMachineId, setOwnMachineId] = useState<string | null>(null);
  // The pickup order currently loaded into the cart (claimed by this station).
  // Kept in state so the "Trả lại" banner survives the cart being emptied
  // (which resets checkoutDraft.kitchenSelfOrder).
  const [activePickup, setActivePickup] = useState<{
    id: string;
    orderNumber: string;
    kitchenPrintStatus?: PickupOrderKitchenPrintStatus | null;
  } | null>(null);
  const clock = useLiveClock();

  useEffect(() => {
    if (!canUseQuickAddRecognition) setShowQuickAddCamera(false);
    if (!canUseNativeProductCreate) setShowAddProduct(false);
    if (!canUseAndroidNativeProductCreate) setNativeProductCreateOpen(false);
    if (!canUseAndroidNativeProductEdit) setNativeProductEditId(null);
    if (!canUseDebtLedgerExternal) setShowDebt(false);
    if (!canUsePickupOrders) setPickupPanelOpen(false);
  }, [
    canUseDebtLedgerExternal,
    canUseAndroidNativeProductCreate,
    canUseAndroidNativeProductEdit,
    canUseNativeProductCreate,
    canUsePickupOrders,
    canUseQuickAddRecognition,
  ]);

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

  const showScanToast = useCallback((text: string, type: ScanToastType) => {
    setScanToast({ text, type });
    setTimeout(() => setScanToast(null), type === 'warn' ? 3200 : 2000);
  }, []);

  // Resolve translator above the barcode callback so it can localize the
  // "Sold out" toast string for scanned items.
  const t = getTranslation(language);
  const tOr = useCallback((key: string, fallback: string) => {
    const translated = t(key);
    return translated && translated !== key ? translated : fallback;
  }, [t]);
  const session = state?.session ?? { shiftId: null, staffId: null, staffName: null, isOpen: false, openedAt: null };

  const openBilliardPayment = useCallback(async (intent: BilliardPaymentIntent) => {
    if (!state) return;
    if (intent.tenderOutcomeUncertain) {
      setBilliardPaymentError('Payment outcome is uncertain. Do not charge again; reconcile cash/card and Order History with the owner.');
      return;
    }
    const context = state.checkoutDraft.billiard;
    if (
      !context
      || context.origin.checkoutId !== intent.checkoutId
      || context.orderId !== intent.orderId
      || context.clientAttemptId !== intent.clientAttemptId
    ) {
      setBilliardPaymentError('The active POS cart does not match this Billiard checkout. Recover or hold the other cart first.');
      return;
    }
    if (context.orderCommitted) {
      setBilliardPaymentError('Payment is already recorded locally. Do not charge again; POS recovery will retry disk/sync verification.');
      return;
    }
    if (!session.isOpen) {
      setBilliardPaymentError('Open a POS shift to continue this Billiard payment. The frozen cart remains safe.');
      return;
    }
    const opened = await window.electronAPI.pos.billiardCheckout.markPaymentOpened(intent.checkoutId);
    if (!opened?.success) {
      setBilliardPaymentError(opened?.error || 'Could not safely open Billiard payment.');
      return;
    }
    setBilliardPaymentError(null);
    // Pin immutable props because main may restore the interrupted cart as
    // soon as the local paid order crosses its disk barrier.
    const paymentPreflightToken = String(opened.token || '').trim();
    if (!paymentPreflightToken) {
      setBilliardPaymentError('POS payment safety token is missing. Reopen payment before collecting money.');
      return;
    }
    setBilliardPaymentSnapshot({
      cart: state.cart,
      checkoutDraft: state.checkoutDraft,
      paymentPreflightToken,
    });
    setBilliardPaymentOpen(true);
    handledBilliardNonceRef.current = intent.nonce;
    onBilliardPaymentIntentConsumed?.(intent.nonce);
  }, [onBilliardPaymentIntentConsumed, session.isOpen, state]);

  const activateBilliardIntent = useCallback((intent: BilliardPaymentIntent) => {
    if (!intent || handledBilliardNonceRef.current === intent.nonce) return;
    setActiveBilliardIntent(intent);
    setBilliardPaymentError(null);
    if (intent.shouldAutoOpen) {
      void openBilliardPayment(intent);
      return;
    }
    handledBilliardNonceRef.current = intent.nonce;
    onBilliardPaymentIntentConsumed?.(intent.nonce);
  }, [onBilliardPaymentIntentConsumed, openBilliardPayment]);

  const openTenderResolution = useCallback((target: UncertainTenderResolutionTarget) => {
    if (!canResolveUncertainTender) return;
    setTenderResolutionTarget(target);
    setTenderResolutionReason('');
    setTenderResolutionConfirmed(false);
    setTenderResolutionError(null);
  }, [canResolveUncertainTender]);

  const submitTenderResolution = useCallback(async () => {
    if (
      !tenderResolutionTarget
      || tenderResolutionSaving
      || tenderResolutionReason.trim().length < 3
      || !tenderResolutionConfirmed
    ) return;
    setTenderResolutionSaving(true);
    setTenderResolutionError(null);
    try {
      const result = await window.electronAPI.pos.billiardCheckout.resolveUncertainTender({
        target: tenderResolutionTarget,
        reason: tenderResolutionReason.trim(),
        confirmedNoPaymentRemains: true,
      });
      if (!result?.success) {
        setTenderResolutionError(result?.error || 'Could not save the owner payment resolution.');
        return;
      }
      if (tenderResolutionTarget.type === 'BILLIARD' && result.intent) {
        setActiveBilliardIntent(result.intent);
        setBilliardPaymentError(null);
        onBilliardTenderResolved?.(result.intent);
      } else if (tenderResolutionTarget.type === 'RESTORED_CART') {
        onRestoredTenderResolved?.();
      }
      setTenderResolutionTarget(null);
      setTenderResolutionReason('');
      setTenderResolutionConfirmed(false);
    } catch (error: any) {
      setTenderResolutionError(error?.message || 'Could not save the owner payment resolution.');
    } finally {
      setTenderResolutionSaving(false);
    }
  }, [
    onBilliardTenderResolved,
    onRestoredTenderResolved,
    tenderResolutionConfirmed,
    tenderResolutionReason,
    tenderResolutionSaving,
    tenderResolutionTarget,
  ]);

  useEffect(() => {
    const intent = billiardPaymentIntent;
    if (intent) activateBilliardIntent(intent);
  }, [activateBilliardIntent, billiardPaymentIntent]);

  useEffect(() => {
    if (!headerMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHeaderMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [headerMenuOpen]);

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
    if (!canUseLabelPrint) return;
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
  }, [canUseLabelPrint, language, showScanToast, tOr]);

  const handlePrintLastCartLabelCommand = useCallback(async () => {
    if (!canUseLabelPrint) return;
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
  }, [canUseLabelPrint, printCartItemLabel, showScanToast, state?.cart.items, tOr]);

  const handleRetailAddProductFeedback = useCallback((displayName: string) => {
    showScanToast(`+ ${displayName}`, 'ok');
  }, [showScanToast]);

  /**
   * Open the scan-import modal for an EAN that's not in the local catalog.
   * Tries the local draft mirror first (fast, offline-safe), falls back to
   * the network lookup-by-ean only if nothing local matches.
   */
  const openScanImport = useCallback(async (ean: string) => {
    const code = ean.trim();
    if (!code) return;
    setScanImportCategories([]);
    setScanImport({ open: true, ean: code, preview: null, loading: true, error: null });
    try {
      const categoryRowsPromise = window.electronAPI.pos.categories.getAllIncludingEmpty()
        .catch((err: any) => {
          rlog.warn('[POSLayout] scan-import category load failed', err?.message);
          return [];
        });
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

      const categoryRows = await categoryRowsPromise;
      setScanImportCategories(scanImportCategoryOptions(categoryRows));
      setScanImport({ open: true, ean: code, preview, loading: false, error: null });
      if (local && !preview.suggestedCategoryId) {
        void window.electronAPI.pos.masterCatalog.lookupByEan(code)
          .then((remote: any) => {
            if (!remote?.ok) return;
            const remotePreview = draftPreviewFromLookup(remote.draft, code);
            if (!remotePreview?.suggestedCategoryId) return;
            setScanImport((current) => (
              current.open && current.ean === code && current.preview
                ? {
                  ...current,
                  preview: {
                    ...current.preview,
                    suggestedCategoryId: remotePreview.suggestedCategoryId,
                  },
                }
                : current
            ));
          })
          .catch((err: any) => {
            rlog.debug('[POSLayout] scan-import suggested category lookup skipped', err?.message);
          });
      }
    } catch (err: any) {
      rlog.warn('[POSLayout] scan-import lookup failed', err?.message);
      setScanImportCategories([]);
      setScanImport({ open: false, ean: code, preview: null, loading: false, error: null });
      showScanToast(`Barcode not found: ${code}`, 'err');
    }
  }, [showScanToast]);

  const closeScanImport = useCallback(() => {
    setScanImport({ open: false, ean: '', preview: null, loading: false, error: null });
    setScanImportCategories([]);
    // Return focus to the search bar so the cashier can scan the next item
    // immediately. Without this, focus stays on the modal backdrop and the
    // next scanner wedge input gets eaten by document.body.
    document.dispatchEvent(new CustomEvent('pos:focus-search'));
  }, []);

  const prepareQuickAdd = useCallback(async (
    images: QuickAddCapturedImage[],
    idempotencyKey: string,
  ): Promise<QuickAddPreparedResult> => {
    if (!canUseQuickAddRecognition) throw new Error('Quick-add recognition is unavailable');
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
  }, [canUseQuickAddRecognition]);

  // Pure recognition preview — returns structured products[] for the cashier
  // to eyeball before creating. Does not touch stock; the create flow is
  // unchanged. Returns [] on any failure so the modal degrades gracefully.
  const recognizeQuickAdd = useCallback(async (
    images: QuickAddCapturedImage[],
  ): Promise<any[]> => {
    if (!canUseQuickAddRecognition) return [];
    const result = await window.electronAPI.pos.recognition.analyze({ images, language: 'vi' });
    if (!result?.ok) throw new Error(result?.error || 'Recognition failed');
    return Array.isArray(result.products) ? result.products : [];
  }, [canUseQuickAddRecognition]);

  const finalizeQuickAdd = useCallback(async (input: QuickAddFinalizeInput) => {
    if (!canUseQuickAddRecognition) throw new Error('Quick-add recognition is unavailable');
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
  }, [canUseQuickAddRecognition, dispatch, language, rememberLastLabelVariant, showScanToast, validateCartLinePrice]);

  const confirmScanImport = useCallback(async (
    retailPriceGrosze: number,
    categoryId: string | undefined,
    stockQty: number,
  ) => {
    const ean = scanImport.ean;
    if (!ean) return;
    setScanImport((s) => ({ ...s, loading: true, error: null }));
    try {
      const isExternal = isExternalScanImportSource(scanImport.preview?.source);
      const draftPayload = categoryId
        ? { ean, retailPriceGrosze, categoryId, stockQty }
        : { ean, retailPriceGrosze, stockQty };
      // Drafts keep their existing local-first path. External EAN hits go
      // through backend quick-add so the new product exists online too.
      const result = isExternal
        ? await window.electronAPI.pos.masterCatalog.importExternal({ ean, retailPriceGrosze, quantity: 1 })
        : await window.electronAPI.pos.masterCatalog.importDraft(draftPayload);
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
        const saleResult = await resolveRetailCartItem(variant, {
          scaleEnabled: canUseScale && config?.scale?.enabled === true,
          scalePort: config?.scale?.port,
          readWeight: canUseScale
            ? window.electronAPI.pos?.scale?.readWeight || window.electronAPI.scale?.readWeight
            : undefined,
        });
        if (!saleResult.ok) {
          const message = formatRetailSaleError(saleResult.error, tOr);
          if (saleResult.saleClass.requiresScale) {
            closeScanImport();
            openManualWeightPrompt(variant, saleResult.saleClass, message);
          } else {
            setScanImport((s) => ({ ...s, loading: false, error: message }));
          }
          return;
        }
        if (!validateCartLinePrice(variant, saleResult.item)) {
          setScanImport((s) => ({ ...s, loading: false }));
          return;
        }
        dispatch({
          type: 'cart/addItem',
          payload: saleResult.item,
        });
        rememberLastLabelVariant(saleResult.item.variantId);
        showScanToast(`+ ${displayName}`, 'ok');
      } else {
        showScanToast(`Imported: ${ean}`, 'ok');
      }
      closeScanImport();
    } catch (err: any) {
      rlog.error('[POSLayout] scan-import confirm failed', err?.message);
      setScanImport((s) => ({ ...s, loading: false, error: err?.message ?? 'Import failed' }));
    }
  }, [allowOversell, canUseScale, closeScanImport, config?.scale?.enabled, config?.scale?.port, dispatch, language, openManualWeightPrompt, rememberLastLabelVariant, scanImport.ean, scanImport.preview?.source, showScanToast, tOr, validateCartLinePrice]);

  const handleAddProductPanelBarcode = useCallback(async (ean: string): Promise<boolean> => {
    if (!canUseNativeProductCreate) return false;
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
        scaleEnabled: canUseScale && config?.scale?.enabled === true,
        scalePort: config?.scale?.port,
        readWeight: canUseScale
          ? window.electronAPI.pos?.scale?.readWeight || window.electronAPI.scale?.readWeight
          : undefined,
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
  }, [allowOversell, canUseNativeProductCreate, canUseScale, config?.scale?.enabled, config?.scale?.port, dispatch, language, openManualWeightPrompt, rememberLastLabelVariant, showScanToast, tOr, validateCartLinePrice]);

  const loadKitchenSelfOrderQr = useCallback(async (
    payload: KitchenSelfOrderQrPayload,
    opts?: { pickupOrderId?: string | null; showSuccessToast?: boolean },
  ): Promise<boolean> => {
    if (!dispatch) return false;
    const currentState = await window.electronAPI.pos.getState().catch(() => state);
    if ((currentState?.cart.items.length ?? state?.cart.items.length ?? 0) > 0) {
      showScanToast('Clear cart before scanning a kiosk order', 'err');
      return false;
    }
    if (!payload.items.length) {
      showScanToast('Kiosk order is empty', 'err');
      return false;
    }

    try {
      const cartItems: CartItem[] = [];
      for (const line of payload.items) {
        const variantId = String(line.variantId || '').trim();
        if (!variantId) {
          throw new Error(`Missing product for ${line.name || payload.orderNumber}`);
        }

        const product = await window.electronAPI.pos.products.getById(variantId);
        if (!product || product.is_active === 0) {
          throw new Error(`Product not available: ${line.name || variantId}`);
        }

        const saleClass = classifyProductSale(product);
        if (saleClass.requiresScale) {
          throw new Error(`Weighted product must be added manually: ${resolveName(product, language)}`);
        }
        const quantity = normalizeKioskQuantity(line.quantity);
        const options = Array.isArray(line.options) ? line.options.join(', ') : '';
        const priceResolution = resolveKitchenSelfOrderCheckoutUnitPrice(
          product.retail_price,
          line.unitPriceGrosze,
        );
        if (priceResolution.unitPriceGrosze <= 0) {
          throw new Error(`Product has no selling price: ${resolveName(product, language)}`);
        }

        let item = buildRetailCartItem(product, saleClass, quantity, crypto.randomUUID());
        if (priceResolution.source === 'QR_SNAPSHOT') {
          item = {
            ...item,
            price: priceResolution.unitPriceGrosze,
            total: priceResolution.unitPriceGrosze * quantity,
          };
        } else {
          const anomaly = findLinePriceAnomaly(item.price, product.retail_price);
          if (anomaly) {
            throw new Error(formatPriceAnomalyMessage(resolveName(product, language) || product.name, anomaly));
          }
        }
        cartItems.push({
          ...item,
          notes: joinKioskLineNotes([options, line.note || null]),
        });
      }

      for (const item of cartItems) {
        await window.electronAPI.pos.dispatch({ type: 'cart/addItem', payload: item });
        rememberLastLabelVariant(item.variantId);
      }
      await window.electronAPI.pos.dispatch({
        type: 'checkoutDraft/update',
        payload: {
          kitchenSelfOrder: {
            orderNumber: payload.orderNumber,
            orderId: payload.orderId,
            sourceLabel: payload.sourceLabel ?? null,
            fulfillmentType: payload.fulfillmentType ?? null,
            kitchenAlreadyReleased: payload.kitchenAlreadyReleased !== false,
            pickupOrderId: opts?.pickupOrderId ?? null,
          },
        },
      });

      document.dispatchEvent(new CustomEvent('pos:manual-cart-action'));
      if (opts?.showSuccessToast !== false) {
        showScanToast(`Loaded kiosk order ${payload.orderNumber}`, 'ok');
      }
      return true;
    } catch (err: any) {
      rlog.error('[POSLayout] Kiosk order QR load failed:', err?.message ?? err);
      await window.electronAPI.pos.dispatch({ type: 'cart/clear' });
      showScanToast(err?.message || 'Kiosk order scan failed', 'err');
      return false;
    }
  }, [dispatch, language, rememberLastLabelVariant, showScanToast, state?.cart.items.length]);

  const warnIfPickupKitchenPrintNotReady = useCallback((
    row: { kitchenPrintStatus?: unknown } | null | undefined,
    orderNumber: string,
  ) => {
    const warning = getPickupKitchenPrintWarning(row);
    if (!warning) return;
    const status = normalizePickupKitchenPrintStatus(row?.kitchenPrintStatus);
    showScanToast(`${orderNumber}: ${warning}`, status === 'FAILED' ? 'err' : 'warn');
  }, [showScanToast]);

  // Load a waiting pickup order chosen from the cashier list: claim it on the
  // backend first (so it locks to this station), then build the cart from the
  // same QR payload a scan would. If the claim is lost (409/410) we block; if
  // the cart build fails after claiming we release so another station can take it.
  const openPickupOrder = useCallback(async (rowOrder: PickupOrderRow): Promise<void> => {
    if (!canUsePickupOrders) return;
    const currentState = await window.electronAPI.pos.getState().catch(() => state);
    if ((currentState?.cart.items.length ?? 0) > 0) {
      showScanToast('Clear cart before loading a kiosk order', 'err');
      return;
    }
    // Claim FIRST: the claim response carries the authoritative payload, so we
    // never depend on the in-memory list row's payload — which is absent on
    // rows that arrived via a payload-less claimed/released socket event (and
    // only repaired by a GET /open re-seed, i.e. a tab switch).
    const claim = await window.electronAPI.pos.pickupOrders.claim(rowOrder.id);
    if (!claim?.ok) {
      if (claim?.status === 409) showScanToast('Đơn đang được xử lý ở máy khác', 'err');
      else if (claim?.status === 410) showScanToast('Đơn đã thanh toán hoặc đã huỷ', 'err');
      else showScanToast(claim?.error || 'Không nhận được đơn', 'err');
      setPickupOrders((prev) => removePickupOrder(prev, rowOrder.id));
      return;
    }
    const pickupId: string = claim.data?.id ?? rowOrder.id;
    const authoritativeQr: unknown = claim.data?.payload?.qr ?? rowOrder.payload?.qr;
    const decoded = typeof authoritativeQr === 'string' ? decodeKitchenSelfOrderQr(authoritativeQr) : null;
    if (!decoded) {
      showScanToast('Kiosk order payload invalid', 'err');
      await window.electronAPI.pos.pickupOrders.release(pickupId).catch(() => {});
      return;
    }
    const warningRow = claim.data ?? rowOrder;
    const hasKitchenWarning = !!getPickupKitchenPrintWarning(warningRow);
    const loaded = await loadKitchenSelfOrderQr(decoded, {
      pickupOrderId: pickupId,
      showSuccessToast: !hasKitchenWarning,
    });
    if (!loaded) {
      await window.electronAPI.pos.pickupOrders.release(pickupId).catch(() => {});
      return;
    }
    if (loaded && hasKitchenWarning) warnIfPickupKitchenPrintNotReady(warningRow, decoded.orderNumber);
    setActivePickup({
      id: pickupId,
      orderNumber: rowOrder.orderNumber,
      kitchenPrintStatus: normalizePickupKitchenPrintStatus(claim.data?.kitchenPrintStatus ?? rowOrder.kitchenPrintStatus),
    });
    setPickupPanelOpen(false);
    setPickupOrders((prev) => removePickupOrder(prev, pickupId));
  }, [canUsePickupOrders, state, loadKitchenSelfOrderQr, showScanToast, warnIfPickupKitchenPrintNotReady]);

  // Put a loaded-but-unpaid pickup order back on the queue (release the claim).
  const releaseActivePickup = useCallback(async () => {
    if (!canUsePickupOrders) return;
    const target = activePickup;
    if (!target) return;
    setActivePickup(null);
    await window.electronAPI.pos.pickupOrders.release(target.id).catch(() => {});
    await window.electronAPI.pos.dispatch({ type: 'cart/clear' }).catch(() => {});
    showScanToast(`Đã trả lại đơn ${target.orderNumber}`, 'ok');
  }, [activePickup, canUsePickupOrders, showScanToast]);

  // Release a stale claim THIS station holds but isn't actively working (e.g.
  // after an app restart) straight from the list.
  const releasePickupFromList = useCallback(async (row: PickupOrderRow) => {
    if (!canUsePickupOrders) return;
    await window.electronAPI.pos.pickupOrders.release(row.id).catch(() => {});
    setPickupOrders((prev) => removePickupOrder(prev, row.id));
  }, [canUsePickupOrders]);

  // This station's machineId — lets the list tell our own claims apart from
  // "claimed at another station".
  useEffect(() => {
    if (!canUsePickupOrders) {
      setOwnMachineId(null);
      return;
    }
    window.electronAPI.pos.pickupOrders?.machineId?.()
      .then((id: string | null) => setOwnMachineId(id))
      .catch(() => {});
  }, [canUsePickupOrders]);

  // Live cashier pickup-order waiting list: merge pickup-order:* socket events
  // as they arrive. A settled/cancelled event for the order we're holding also
  // clears the active-order banner.
  useEffect(() => {
    if (!canUsePickupOrders) return;
    const unsub = window.electronAPI.pos.onPickupOrderEvent?.((msg: { event: string; data: any }) => {
      setPickupOrders((prev) => mergePickupEvent(prev, msg));
      if ((msg.event === 'settled' || msg.event === 'cancelled') && msg.data?.id) {
        setActivePickup((cur) => (cur && cur.id === msg.data.id ? null : cur));
      }
      if (msg.event === 'kitchen-print-updated' && msg.data?.id) {
        setActivePickup((cur) => (
          cur && cur.id === msg.data.id
            ? { ...cur, kitchenPrintStatus: normalizePickupKitchenPrintStatus(msg.data.kitchenPrintStatus) }
            : cur
        ));
      }
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [canUsePickupOrders]);

  // Once the runtime capability is usable, seed from GET /open on mount and
  // re-seed whenever isOnline changes. It is deliberately not gated on the
  // indicator itself, so initial load still happens when connection UI lags.
  useEffect(() => {
    if (!canUsePickupOrders) {
      setPickupOrders([]);
      return;
    }
    let active = true;
    window.electronAPI.pos.pickupOrders?.listOpen?.()
      .then((rows: PickupOrderRow[]) => { if (active) setPickupOrders(seedPickupOrders(rows)); })
      .catch(() => { /* best-effort; the QR scan path still works */ });
    return () => { active = false; };
  }, [canUsePickupOrders, isOnline]);

  // A legacy KSO1 scan is still just a reference to the waiting backend row:
  // claim it first, then load the cart from the authoritative backend payload.
  // No fallback load from the scanned payload, because that cannot settle.
  const handleScannedKioskOrder = useCallback(async (kioskOrder: KitchenSelfOrderQrPayload): Promise<void> => {
    if (!canUsePickupOrders) return;
    const known = pickupOrders.find(
      (r) => (kioskOrder.orderId && r.sourceOrderId === kioskOrder.orderId) || r.orderNumber === kioskOrder.orderNumber,
    );
    if (known) {
      await openPickupOrder(known);
      return;
    }
    const currentState = await window.electronAPI.pos.getState().catch(() => state);
    if ((currentState?.cart.items.length ?? 0) > 0) {
      showScanToast('Clear cart before scanning a kiosk order', 'err');
      return;
    }
    const res = await window.electronAPI.pos.pickupOrders.claimByRef({
      sourceOrderId: kioskOrder.orderId,
      orderNumber: kioskOrder.orderNumber,
    });
    if (res?.ok) {
      const pickupOrderId: string | undefined = res.data?.id;
      const authoritativeQr: unknown = res.data?.payload?.qr;
      const decoded = typeof authoritativeQr === 'string'
        ? decodeKitchenSelfOrderQr(authoritativeQr)
        : null;
      if (!decoded) {
        showScanToast('Đơn không hợp lệ', 'err');
        if (pickupOrderId) await window.electronAPI.pos.pickupOrders.release(pickupOrderId).catch(() => {});
        return;
      }
      const hasKitchenWarning = !!getPickupKitchenPrintWarning(res.data);
      const loaded = await loadKitchenSelfOrderQr(decoded, {
        pickupOrderId: pickupOrderId ?? null,
        showSuccessToast: !hasKitchenWarning,
      });
      if (!loaded && pickupOrderId) {
        await window.electronAPI.pos.pickupOrders.release(pickupOrderId).catch(() => {});
      }
      if (loaded && hasKitchenWarning) warnIfPickupKitchenPrintNotReady(res.data, decoded.orderNumber);
      if (loaded && pickupOrderId) {
        setActivePickup({
          id: pickupOrderId,
          orderNumber: decoded.orderNumber,
          kitchenPrintStatus: normalizePickupKitchenPrintStatus(res.data?.kitchenPrintStatus),
        });
      }
      if (pickupOrderId) setPickupOrders((prev) => removePickupOrder(prev, pickupOrderId));
      return;
    }
    if (res?.status === 409) { showScanToast('Đơn đang được xử lý ở máy khác', 'err'); return; }
    if (res?.status === 410) { showScanToast('Đơn đã thanh toán hoặc đã huỷ', 'err'); return; }
    showScanToast('Đơn chưa lên hệ thống — chọn từ danh sách hoặc tính tiền tay', 'err');
  }, [canUsePickupOrders, pickupOrders, openPickupOrder, state, loadKitchenSelfOrderQr, showScanToast, warnIfPickupKitchenPrintNotReady]);

  // A scanned KSOREF reference: claim the backend row, then build the cart from
  // the AUTHORITATIVE backend payload (the reference carries no items). Always
  // claims → settles on pay → leaves the queue. No silent unclaimed load.
  const handleScannedPickupRef = useCallback(async (
    ref: { sourceOrderId: string | null; orderNumber: string | null },
  ): Promise<void> => {
    if (!canUsePickupOrders) return;
    const currentState = await window.electronAPI.pos.getState().catch(() => state);
    if ((currentState?.cart.items.length ?? 0) > 0) {
      showScanToast('Clear cart before scanning a kiosk order', 'err');
      return;
    }
    const res = await window.electronAPI.pos.pickupOrders.claimByRef({
      sourceOrderId: ref.sourceOrderId ?? undefined,
      orderNumber: ref.orderNumber ?? undefined,
    });
    if (res?.ok) {
      const pickupOrderId: string | undefined = res.data?.id;
      const authoritativeQr: unknown = res.data?.payload?.qr;
      const decoded = typeof authoritativeQr === 'string'
        ? decodeKitchenSelfOrderQr(authoritativeQr)
        : null;
      if (!decoded) {
        showScanToast('Đơn không hợp lệ', 'err');
        if (pickupOrderId) await window.electronAPI.pos.pickupOrders.release(pickupOrderId).catch(() => {});
        return;
      }
      const hasKitchenWarning = !!getPickupKitchenPrintWarning(res.data);
      const loaded = await loadKitchenSelfOrderQr(decoded, {
        pickupOrderId: pickupOrderId ?? null,
        showSuccessToast: !hasKitchenWarning,
      });
      if (!loaded && pickupOrderId) {
        await window.electronAPI.pos.pickupOrders.release(pickupOrderId).catch(() => {});
      }
      if (loaded && hasKitchenWarning) warnIfPickupKitchenPrintNotReady(res.data, decoded.orderNumber);
      if (loaded && pickupOrderId) {
        setActivePickup({
          id: pickupOrderId,
          orderNumber: decoded.orderNumber,
          kitchenPrintStatus: normalizePickupKitchenPrintStatus(res.data?.kitchenPrintStatus),
        });
      }
      if (pickupOrderId) setPickupOrders((prev) => removePickupOrder(prev, pickupOrderId));
      return;
    }
    if (res?.status === 409) { showScanToast('Đơn đang được xử lý ở máy khác', 'err'); return; }
    if (res?.status === 410) { showScanToast('Đơn đã thanh toán hoặc đã huỷ', 'err'); return; }
    showScanToast('Đơn chưa lên hệ thống — chọn từ danh sách hoặc tính tiền tay', 'err');
  }, [canUsePickupOrders, state, loadKitchenSelfOrderQr, showScanToast, warnIfPickupKitchenPrintNotReady]);

  const handleBarcodeKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = barcodeBuffer.trim();
      setBarcodeBuffer('');
      const pickupRef = decodeKitchenSelfOrderRefQr(code);
      if (pickupRef) {
        document.dispatchEvent(new CustomEvent('pos:manual-cart-action'));
        await handleScannedPickupRef(pickupRef);
        return;
      }
      const kioskOrder = decodeKitchenSelfOrderQr(code);
      if (kioskOrder) {
        document.dispatchEvent(new CustomEvent('pos:manual-cart-action'));
        await handleScannedKioskOrder(kioskOrder);
        return;
      }
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
            const result = await resolveRetailCartItem(product, {
              scaleEnabled: canUseScale && config?.scale?.enabled === true,
              scalePort: config?.scale?.port,
              readWeight: canUseScale
                ? window.electronAPI.pos?.scale?.readWeight || window.electronAPI.scale?.readWeight
                : undefined,
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
  }, [allowOversell, barcodeBuffer, canUseScale, config?.scale?.enabled, config?.scale?.port, dispatch, handlePrintLastCartLabelCommand, handleScannedPickupRef, handleScannedKioskOrder, rememberLastLabelVariant, showScanToast, language, t, tOr, openManualWeightPrompt, openScanImport, validateCartLinePrice]);

  const handleUnknownBarcodeScanned = useCallback(async (code: string) => {
    const pickupRef = decodeKitchenSelfOrderRefQr(code);
    if (pickupRef) {
      document.dispatchEvent(new CustomEvent('pos:manual-cart-action'));
      await handleScannedPickupRef(pickupRef);
      return;
    }
    const kioskOrder = decodeKitchenSelfOrderQr(code);
    if (kioskOrder) {
      document.dispatchEvent(new CustomEvent('pos:manual-cart-action'));
      await handleScannedKioskOrder(kioskOrder);
      return;
    }
    await openScanImport(code);
  }, [handleScannedPickupRef, handleScannedKioskOrder, openScanImport]);

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

  // Initial order copies print in the durable main-process queue. Only surface
  // failures/ambiguous outcomes; successful jobs stay silent so the next sale
  // is never interrupted by receipt UI.
  useEffect(() => {
    const handleStatus = createReceiptPrintStatusHandler((message) => {
      showScanToast(message, 'warn');
    });

    // Subscribe before replaying durable unresolved rows so an event that
    // lands during the query cannot be lost. The local tracker deduplicates
    // overlap and prevents an old snapshot from overriding live completion.
    const unsub = window.electronAPI.pos.onReceiptPrintStatus?.(handleStatus);
    void window.electronAPI.pos.listReceiptPrintStatuses?.()
      .then((rows: ReceiptPrintStatusInfo[]) => rows.forEach(handleStatus))
      .catch(() => undefined);
    return () => unsub?.();
  }, [showScanToast]);

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
    // If a kitchen pickup order was loaded but not paid, release the claim so
    // another station can take it. Tracked in activePickup (survives the cart
    // being emptied); only fires on a deliberate Home reset — no race with the
    // async settle (which clears activePickup via the settled event).
    if (activePickup && canUsePickupOrders) {
      void window.electronAPI.pos.pickupOrders.release(activePickup.id).catch(() => {});
      setActivePickup(null);
    }
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
  }, [dispatch, activePickup, canUsePickupOrders]);

  if (!state) {
    return (
      <div className="zira-pos-layout-root min-h-screen bg-slate-50 flex items-center justify-center text-slate-600">
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

  // The order loaded in the cart is shown in the "đang xử lý" banner, not the
  // waiting list — exclude it so it isn't double-shown / mislabeled.
  const visiblePickups = pickupOrders.filter((o) => o.id !== activePickup?.id);

  return (
    <div className={`zira-pos-layout-root ${embedded ? 'h-full' : 'h-screen'} bg-slate-50 text-slate-900 flex flex-col overflow-hidden`}>
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
            : scanToast.type === 'warn'
              ? 'bg-amber-500 text-slate-950'
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
            className="ml-2 inline-flex min-h-11 items-center justify-center rounded-md bg-white/20 px-3 text-xs font-bold hover:bg-white/30"
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
        categoryOptions={scanImportCategories}
        onConfirm={confirmScanImport}
        onCancel={closeScanImport}
        loading={scanImport.loading}
        error={scanImport.error}
        t={t}
      />
      {canUseQuickAddRecognition && (
        <QuickAddCameraModal
          open={showQuickAddCamera}
          onClose={() => setShowQuickAddCamera(false)}
          onPrepare={prepareQuickAdd}
          onFinalize={finalizeQuickAdd}
          onRecognize={recognizeQuickAdd}
          t={t}
        />
      )}
      {canUseNativeProductCreate && (
        <AddProductWebviewPanel
          open={showAddProduct}
          salonCode={(config as any)?.salonCode}
          onProductCreated={(line) => {
            dispatch({ type: 'cart/addItem', payload: { ...line, id: crypto.randomUUID() } });
          }}
          onExistingProductScanned={handleAddProductPanelBarcode}
          onClose={() => setShowAddProduct(false)}
        />
      )}
      {(nativeProductCreateOpen || nativeProductEditId) && hasAndroidNativeProductPath && (
        <div className="fixed inset-0 z-[70] bg-slate-50">
          <ProductModule
            language={language}
            openCreate={nativeProductCreateOpen}
            openVariantId={nativeProductEditId}
            adminCapabilityScope={productAdminScope}
            externalBackLabel={tOr('common.back', 'Back to POS')}
            onCreatedForExternal={(variant) => {
              const outcome = productAdminVariantToCartLine(variant, createExternalCartLineId());
              if (outcome.kind === 'manual-weight') {
                openManualWeightPrompt(outcome.product, outcome.saleClass);
                return;
              }
              dispatch({ type: 'cart/addItem', payload: outcome.line });
            }}
            onAccessDeniedForExternal={() => {
              invalidateProductAdminCapabilities();
              setNativeProductCreateOpen(false);
              setNativeProductEditId(null);
            }}
            onExitExternal={() => {
              setNativeProductCreateOpen(false);
              setNativeProductEditId(null);
            }}
          />
        </div>
      )}
      {canUseDebtLedgerExternal && (
        <DebtWebviewPanel
          open={showDebt}
          salonCode={(config as any)?.salonCode}
          onClose={() => setShowDebt(false)}
        />
      )}
      {/* Sync conflict banner (Path B) */}
      <SyncConflictBanner />
      {dispatchError && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-red-300 bg-red-50 px-5 py-2 text-sm font-bold text-red-900" role="alert">
          <span>{dispatchError}</span>
          <button type="button" onClick={clearDispatchError} className="min-h-9 rounded-md border border-red-300 bg-white px-3 text-xs font-bold text-red-800 hover:bg-red-100">
            Dismiss
          </button>
        </div>
      )}
      {restoredCartReconciliation && (
        <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-5 py-2.5 text-amber-950" role="alert">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-extrabold">Restored POS cart · payment reconciliation required</div>
              <div className="mt-0.5 text-xs font-bold">{restoredCartReconciliation.message}</div>
              <div className="mt-1 text-[11px] font-semibold tabular-nums text-amber-800">Order safety ID: {restoredCartReconciliation.orderId}</div>
            </div>
            {canResolveUncertainTender && (
              <button
                type="button"
                onClick={() => openTenderResolution({ type: 'RESTORED_CART', holdId: restoredCartReconciliation.holdId })}
                className="min-h-11 rounded-md border border-amber-700 bg-white px-4 text-xs font-extrabold text-amber-900 hover:bg-amber-100"
              >
                Owner resolution
              </button>
            )}
          </div>
        </div>
      )}
      {activeBilliardIntent && (
        <div className={`shrink-0 border-b px-5 py-2.5 ${
          activeBilliardIntent.tenderOutcomeUncertain
            ? 'border-amber-300 bg-amber-50 text-amber-950'
            : 'border-blue-200 bg-blue-50 text-blue-950'
        }`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white ${
                  activeBilliardIntent.tenderOutcomeUncertain ? 'bg-amber-700' : 'bg-blue-700'
                }`}>
                  Billiard
                </span>
                <span className="text-sm font-extrabold">
                  {activeBilliardIntent.tenderOutcomeUncertain
                    ? 'Payment outcome uncertain · reconciliation required'
                    : state.checkoutDraft.billiard
                    ? (state.checkoutDraft.billiard.orderCommitted ? 'Payment recorded · recovery pending' : 'Billiard total locked · ready for payment')
                    : 'Payment recorded · sync pending'}
                </span>
              </div>
              <div className={`mt-1 text-xs font-semibold tabular-nums ${
                activeBilliardIntent.tenderOutcomeUncertain ? 'text-amber-900' : 'text-blue-800'
              }`}>
                {state.checkoutDraft.billiard?.tableName || `Session ${activeBilliardIntent.sessionId.slice(0, 8)}`}
                {state.checkoutDraft.billiard ? ` · ${(state.cart.total / 100).toFixed(2)} zł` : ''}
              </div>
              {activeBilliardIntent.tenderOutcomeUncertain && (
                <div className="mt-1 max-w-3xl text-xs font-bold text-amber-900">
                  Do not charge again. Check the cash/card terminal and POS Order History, then reconcile with the owner.
                </div>
              )}
              {billiardPaymentError && <div className="mt-1 text-xs font-bold text-red-700">{billiardPaymentError}</div>}
            </div>
            {activeBilliardIntent.tenderOutcomeUncertain && canResolveUncertainTender && (
              <button
                type="button"
                onClick={() => openTenderResolution({ type: 'BILLIARD', checkoutId: activeBilliardIntent.checkoutId })}
                className="min-h-11 rounded-md border border-amber-700 bg-white px-4 text-xs font-extrabold text-amber-900 hover:bg-amber-100"
              >
                Owner resolution
              </button>
            )}
            {!activeBilliardIntent.tenderOutcomeUncertain && state.checkoutDraft.billiard && !state.checkoutDraft.billiard.orderCommitted && !billiardPaymentOpen && (
              <button
                type="button"
                onClick={() => void openBilliardPayment(activeBilliardIntent)}
                className="min-h-11 rounded-md bg-blue-700 px-4 text-sm font-bold text-white hover:bg-blue-800 disabled:opacity-50"
                disabled={!session.isOpen}
              >
                {session.isOpen ? 'Resume payment' : 'Open shift first'}
              </button>
            )}
          </div>
        </div>
      )}
      {/* Header - shared across all modes */}
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-slate-200 bg-white shrink-0">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleHomeReset}
            className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-base font-bold tracking-wide text-brand-600 hover:bg-brand-50 active:bg-brand-100 transition-colors cursor-pointer touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
            aria-label={tOr('pos.homeReset', 'Reset POS home')}
            title={tOr('pos.homeReset', 'Reset POS home')}
          >
            <Home size={17} aria-hidden="true" />
            <span>Zira POS</span>
          </button>
          <span className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 font-medium">
            {t(MODE_LABELS[posMode])}
          </span>
          {session.staffName && (
            <span className="text-xs text-slate-600 font-medium">
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
            <span className="block text-xs font-semibold uppercase tracking-[0.15em] text-slate-600">{clock.toLocaleDateString(language === 'vi' ? 'vi-VN' : language === 'pl' ? 'pl-PL' : language === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
            <span className="block text-sm font-bold text-slate-700 tabular-nums">
              {clock.toLocaleTimeString(language === 'vi' ? 'vi-VN' : language === 'pl' ? 'pl-PL' : language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          {/* Secondary header controls */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setHeaderMenuOpen((v) => !v);
                setPickupPanelOpen(false);
                setLangOpen(false);
              }}
              aria-label={tOr('pos.cart.more', 'More')}
              title={tOr('pos.cart.more', 'More')}
              aria-haspopup="menu"
              aria-expanded={headerMenuOpen}
              className="relative inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 active:bg-slate-200 transition-colors cursor-pointer touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
            >
              <MoreVertical size={20} aria-hidden="true" />
              {visiblePickups.length > 0 && (
                <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-orange-600 px-1 text-xs font-bold text-white tabular-nums">
                  {visiblePickups.length}
                </span>
              )}
            </button>
            {headerMenuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setHeaderMenuOpen(false)} aria-hidden="true" />
                <div
                  role="menu"
                  onClick={() => setHeaderMenuOpen(false)}
                  className="absolute right-0 top-full z-40 mt-1 min-w-[230px] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
                >
                  {canUseDebtLedgerExternal && <button
                    type="button"
                    role="menuitem"
                    onClick={() => setShowDebt(true)}
                    className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm font-bold text-amber-700 hover:bg-amber-50 active:bg-amber-100 cursor-pointer touch-manipulation"
                    title={tOr('pos.header.debt', 'So no')}
                  >
                    <ReceiptText size={17} aria-hidden="true" className="shrink-0" />
                    <span>{tOr('pos.header.debt', 'So no')}</span>
                  </button>}
                  {canUsePickupOrders && <button
                    type="button"
                    role="menuitem"
                    onClick={() => setPickupPanelOpen((v) => !v)}
                    className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm font-bold text-orange-700 hover:bg-orange-50 active:bg-orange-100 cursor-pointer touch-manipulation"
                    title={tOr('pos.header.pickupQueue', 'Đơn bếp')}
                  >
                    <ShoppingCart size={17} aria-hidden="true" className="shrink-0" />
                    <span className="flex-1">{tOr('pos.header.pickupQueue', 'Đơn bếp')}</span>
                    {visiblePickups.length > 0 && (
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-orange-600 px-1 text-xs font-bold text-white tabular-nums">
                        {visiblePickups.length}
                      </span>
                    )}
                  </button>}
                  {onFullscreen && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={onFullscreen}
                      className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm font-bold text-slate-700 hover:bg-slate-50 active:bg-slate-100 cursor-pointer touch-manipulation"
                      title={tOr('pos.header.fullscreen', 'Enter fullscreen mode')}
                    >
                      <Maximize2 size={17} aria-hidden="true" className="shrink-0" />
                      <span>{tOr('pos.header.fullscreen', 'Enter fullscreen mode')}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setLangOpen(!langOpen)}
                    className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm font-bold text-slate-700 hover:bg-slate-50 active:bg-slate-100 cursor-pointer touch-manipulation"
                    title={tOr('pos.header.language', 'Change language')}
                  >
                    <Languages size={17} aria-hidden="true" className="shrink-0" />
                    <span className="flex-1">{tOr('pos.header.language', 'Change language')}</span>
                    <span className="text-xs font-bold text-slate-500">{languageNames[language]}</span>
                  </button>
                </div>
              </>
            )}
            {canUsePickupOrders && pickupPanelOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setPickupPanelOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-30 w-80 max-h-[70vh] overflow-y-auto bg-white rounded-xl border border-slate-200 shadow-lg py-2">
                  {visiblePickups.length === 0 ? (
                    <div className="px-4 py-6 text-center text-sm text-slate-600">Chưa có đơn bếp chờ thu</div>
                  ) : (
                    visiblePickups.map((o) => {
                      const mine = o.status === 'CLAIMED' && !!ownMachineId && o.claimedByMachineId === ownMachineId;
                      const claimedElsewhere = o.status === 'CLAIMED' && !mine;
                      const kitchenBadge = getPickupKitchenPrintBadge(o.kitchenPrintStatus);
                      return (
                        <div key={o.id} className="flex items-center gap-1 px-2">
                          <button
                            type="button"
                            disabled={claimedElsewhere}
                            onClick={() => openPickupOrder(o)}
                            className={`flex-1 px-2 py-3 flex items-center justify-between gap-3 text-left rounded-lg transition-colors ${
                              claimedElsewhere ? 'opacity-50 cursor-not-allowed' : 'hover:bg-orange-50 cursor-pointer'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="text-lg font-black text-slate-900 tabular-nums">{o.orderNumber}</div>
                              <div className={`mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${kitchenBadge.className}`}>
                                {kitchenBadge.text}
                              </div>
                              {claimedElsewhere && (
                                <div className="text-[11px] font-semibold text-amber-600">Đang xử lý ở máy khác</div>
                              )}
                              {mine && (
                                <div className="text-[11px] font-semibold text-orange-600">Đơn của bạn — bấm để mở lại</div>
                              )}
                            </div>
                            <div className="text-sm font-bold text-slate-700 tabular-nums shrink-0">
                              {((o.totalGrosze ?? 0) / 100).toFixed(2)}
                            </div>
                          </button>
                          {mine && (
                            <button
                              type="button"
                              onClick={() => releasePickupFromList(o)}
                              className="inline-flex min-h-11 shrink-0 items-center justify-center px-3 text-[11px] font-bold text-slate-600 bg-slate-100 rounded-md hover:bg-slate-200"
                            >
                              Trả lại
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}
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
                      <span className="text-[10px] font-bold text-slate-600 uppercase">{l}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Active pickup banner — đơn bếp đang xử lý ở máy này */}
          {canUsePickupOrders && activePickup && (
            <div className="inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold text-orange-800 bg-orange-100 border border-orange-300 rounded-lg">
              <span className="tabular-nums">🍽 Đang xử lý: {activePickup.orderNumber}</span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${getPickupKitchenPrintBadge(activePickup.kitchenPrintStatus).className}`}>
                {getPickupKitchenPrintBadge(activePickup.kitchenPrintStatus).text}
              </span>
              <button
                type="button"
                onClick={releaseActivePickup}
                className="inline-flex min-h-11 items-center justify-center px-3 text-[11px] font-bold text-orange-700 bg-white/70 rounded-md hover:bg-white"
                title="Trả đơn về danh sách"
              >
                Trả lại
              </button>
            </div>
          )}

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
            onUnknownBarcodeScanned={handleUnknownBarcodeScanned}
            onQuickAddCamera={canUseQuickAddRecognition ? () => setShowQuickAddCamera(true) : undefined}
            onCreateProduct={canUseAndroidNativeProductCreate
              ? () => setNativeProductCreateOpen(true)
              : canUseNativeProductCreate ? () => setShowAddProduct(true) : undefined}
            canCreateProduct={canUseAndroidNativeProductCreate || canUseNativeProductCreate}
            onLastLabelVariantChange={rememberLastLabelVariant}
            onPrintLastCartLabelCommand={canUseLabelPrint ? handlePrintLastCartLabelCommand : undefined}
            onManualWeightRequired={openManualWeightPrompt}
            onAddProductFeedback={handleRetailAddProductFeedback}
            onEditProduct={canUseAndroidNativeProductEdit
              ? (variantId) => setNativeProductEditId(variantId)
              : onEditProduct}
            onBilliardIntentPrepared={activateBilliardIntent}
            onRestoredTenderOutcomeUncertain={onRestoredCartTenderOutcomeUncertain}
            homeResetKey={homeResetKey}
          />
        )}
        {posMode === 'salon' && (
          <SalonTemplate
            state={state}
            dispatch={dispatch}
            t={t}
            language={language}
            session={session}
            onRestoredTenderOutcomeUncertain={onRestoredCartTenderOutcomeUncertain}
          />
        )}
        {posMode === 'b2b' && (
          <B2BTemplate
            state={state}
            dispatch={dispatch}
            t={t}
            language={language}
            session={session}
            onRestoredTenderOutcomeUncertain={onRestoredCartTenderOutcomeUncertain}
          />
        )}
        {posMode === 'restaurant' && (
          <RestaurantTemplate
            state={state}
            dispatch={dispatch}
            t={t}
            language={language}
            session={session}
            onRestoredTenderOutcomeUncertain={onRestoredCartTenderOutcomeUncertain}
          />
        )}
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
      {tenderResolutionTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4" role="dialog" aria-modal="true" aria-labelledby="tender-resolution-title">
          <div className="w-full max-w-xl rounded-xl border border-amber-300 bg-white p-5 shadow-2xl">
            <h2 id="tender-resolution-title" className="text-lg font-extrabold text-slate-950">
              Confirm no payment remains
            </h2>
            <p className="mt-2 text-sm font-bold text-amber-900">
              Owner action only. First verify cash, the card/BLIK terminal, and Order History. If a payment was ever collected, reverse or refund it externally before continuing.
            </p>
            <p className="mt-2 text-xs font-semibold text-slate-600">
              This audited action reopens the same cart for a new payment attempt. It does not create a receipt or pretend a previous tender was paid.
            </p>
            <label className="mt-4 block text-xs font-extrabold uppercase tracking-wide text-slate-700" htmlFor="tender-resolution-reason">
              Resolution reason
            </label>
            <textarea
              id="tender-resolution-reason"
              value={tenderResolutionReason}
              onChange={(event) => setTenderResolutionReason(event.target.value.slice(0, 500))}
              disabled={tenderResolutionSaving}
              rows={4}
              maxLength={500}
              placeholder="Describe checks performed and any external reversal/refund"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-950 focus:border-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-100 disabled:bg-slate-100"
            />
            <div className="mt-1 text-right text-[11px] font-semibold text-slate-500">{tenderResolutionReason.trim().length}/500</div>
            <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-bold text-amber-950">
              <input
                type="checkbox"
                checked={tenderResolutionConfirmed}
                onChange={(event) => setTenderResolutionConfirmed(event.target.checked)}
                disabled={tenderResolutionSaving}
                className="mt-0.5 h-5 w-5 rounded border-amber-400 text-amber-700"
              />
              <span>I confirm that no cash/card/BLIK payment remains for this attempt and any previously collected external payment has been reversed or refunded.</span>
            </label>
            {tenderResolutionError && (
              <div className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-bold text-red-800">{tenderResolutionError}</div>
            )}
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setTenderResolutionTarget(null)}
                disabled={tenderResolutionSaving}
                className="min-h-12 rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitTenderResolution()}
                disabled={tenderResolutionSaving || tenderResolutionReason.trim().length < 3 || !tenderResolutionConfirmed}
                className="min-h-12 rounded-lg bg-amber-700 px-4 text-sm font-extrabold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {tenderResolutionSaving ? 'Saving audit…' : 'Confirm and reopen payment'}
              </button>
            </div>
          </div>
        </div>
      )}
      {manualWeightPrompt && (
        <ManualWeightModal
          prompt={manualWeightPrompt}
          tOr={tOr}
          onClose={closeManualWeightPrompt}
          onSubmit={submitManualWeight}
        />
      )}
      {billiardPaymentOpen && billiardPaymentSnapshot && activeBilliardIntent && (
        <PaymentModal
          cart={billiardPaymentSnapshot.cart}
          checkoutDraft={billiardPaymentSnapshot.checkoutDraft}
          dispatch={dispatch}
          onClose={() => setBilliardPaymentOpen(false)}
          onTenderOutcomeUncertain={(message) => {
            setBilliardPaymentOpen(false);
            setBilliardPaymentSnapshot(null);
            setBilliardPaymentError(message);
            setActiveBilliardIntent((current) => current
              ? { ...current, shouldAutoOpen: false, tenderOutcomeUncertain: true }
              : current);
          }}
          onComplete={({ orderId }) => {
            setBilliardPaymentOpen(false);
            const checkoutId = activeBilliardIntent.checkoutId;
            void window.electronAPI.pos.billiardCheckout.complete(checkoutId, orderId).then((result: {
              success: boolean;
              restored?: boolean;
              durabilityError?: string;
              error?: string;
            }) => {
              if (!result?.success) {
                setBilliardPaymentError(result?.error || result?.durabilityError || 'Payment is recorded but handoff cleanup needs recovery.');
                return;
              }
              setActiveBilliardIntent(null);
              setBilliardPaymentSnapshot(null);
              setBilliardPaymentError(null);
            });
          }}
          t={t}
          shiftId={session.shiftId}
          staffId={session.staffId}
          staffName={session.staffName}
          initialPaymentPreflightToken={billiardPaymentSnapshot.paymentPreflightToken}
          extraOrderFields={{ mode: posMode }}
        />
      )}
    </div>
  );
}
