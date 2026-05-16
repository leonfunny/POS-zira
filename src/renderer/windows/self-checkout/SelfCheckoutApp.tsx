// Self-checkout terminal entry point. This owns the kiosk state machine:
// unavailable -> welcome -> shopping -> receipt -> thank-you.
// Payment selection is an overlay on shopping; the customer should not leave
// the cart screen just to pick card/BLIK.
// Production checkout reuses the existing POS order, card terminal, receipt,
// and order-sync IPC paths.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScLanguage, getScStrings } from './i18n';
import { resolveName } from '../../../shared/catalog-names';
import {
  SelfCheckoutMode,
  resolveSelfCheckoutRuntime,
} from './self-checkout-model';
import { useScreenState } from './screen-state';
import { type ScCartItem, useScCart } from './useScCart';
import WelcomeScreen from './screens/WelcomeScreen';
import ScanScreen from './screens/ScanScreen';
import PaymentScreen, { PaymentMethod } from './screens/PaymentScreen';
import ThankYouScreen from './screens/ThankYouScreen';
import HelpLockedOverlay from './screens/HelpLockedOverlay';
import ReceiptScreen from './screens/ReceiptScreen';
import UnavailableScreen from './screens/UnavailableScreen';

interface ProductLookupResult {
  id: string;
  template_id?: string | null;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  category_id?: string | null;
  retail_price?: number;
  price?: number;
  price_gross?: number;
  vat_rate?: number;
  image_url?: string | null;
  thumbnail_url?: string | null;
  in_stock?: number;
  available_qty?: number;
  /** JSON-encoded `{lang: name}` from the SQLite mirror. Display only;
   *  receipt/fiscal payloads always use canonical `name`. */
  name_translations?: string | null;
}

declare global {
  interface Window {
    electronAPI: any;
  }
}

type ToastState = { kind: 'ok' | 'error'; text: string } | null;

const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

function getProductPriceGrosze(product: ProductLookupResult): number {
  const value = product.retail_price ?? product.price ?? product.price_gross;
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
}

function getProductStock(product: ProductLookupResult): number | undefined {
  const value = product.in_stock ?? product.available_qty;
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function normalizeScanQuantity(value: number): number {
  return Math.min(99, Math.max(1, Math.floor(Number(value) || 1)));
}

function formatScMessage(
  template: string,
  values: Record<string, string | number | undefined>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

function calculateIncludedTax(items: ScCartItem[]): number {
  return items.reduce((sum, item) => {
    const rate = item.vatRate ?? 0;
    if (rate <= 0) return sum;
    const lineGross = item.price * item.quantity;
    return sum + Math.round(lineGross - lineGross * 100 / (100 + rate));
  }, 0);
}

function buildSelfCheckoutSale(
  items: ScCartItem[],
  orderId: string,
  method: PaymentMethod,
  kioskUserId: string | null,
) {
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const staffName = 'Self-checkout';
  const order = {
    id: orderId,
    order_number: null as string | null,
    status: 'COMPLETED',
    subtotal: total,
    discount: 0,
    tax: calculateIncludedTax(items),
    total,
    payment_method: method,
    payment_amount: total,
    change_amount: 0,
    staff_id: kioskUserId,
    staff_name: staffName,
    customer_id: null,
    customer_name: null,
    customer_nip: null,
    shift_id: null,
    source: 'SELF_CHECKOUT',
    table_id: null,
    covers: null,
    order_type: 'standard',
    tip: 0,
    mode: 'retail',
    synced: 0,
    backend_id: null,
    created_at: new Date().toISOString(),
    synced_at: null,
    payment_tenders: null,
  };

  const orderItems = items.map((item) => ({
    id: crypto.randomUUID(),
    order_id: orderId,
    variant_id: item.isBagFee ? null : item.variantId,
    name: item.name,
    sku: item.sku || null,
    price: item.price,
    quantity: item.quantity,
    total: item.price * item.quantity,
    vat_rate: item.vatRate ?? 23,
    staff_id: kioskUserId,
    staff_name: staffName,
    notes: item.isBagFee ? 'SELF_CHECKOUT_BAG_FEE' : null,
    course: null,
  }));

  return { order, items: orderItems };
}

export default function SelfCheckoutApp() {
  const { screen, goTo, reset } = useScreenState('welcome');
  const [lang, setLang] = useState<ScLanguage>('pl');
  const [mode, setMode] = useState<SelfCheckoutMode>('demo');
  const [unavailableReasons, setUnavailableReasons] = useState<string[]>([]);
  const [bagFeeGrosze, setBagFeeGrosze] = useState<number>(20);
  const [idleTimeoutMs, setIdleTimeoutMs] = useState<number>(DEFAULT_IDLE_TIMEOUT_MS);
  const [lastPaymentMethod, setLastPaymentMethod] = useState<PaymentMethod | null>(null);
  const [lastReceiptPrinted, setLastReceiptPrinted] = useState(true);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [kioskUserId, setKioskUserId] = useState<string | null>(null);
  const [fakePaymentEnabled, setFakePaymentEnabled] = useState(false);
  const [scanQuantity, setScanQuantity] = useState(1);
  const [toast, setToast] = useState<ToastState>(null);
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [activityAt, setActivityAt] = useState(Date.now());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staffGestureStartY = useRef<number[]>([]);

  const [help, setHelp] = useState<
    | { id: string; reason: string; acknowledged: boolean }
    | null
  >(null);
  const helpPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const cart = useScCart();
  const bagItem = cart.cart.items.find((item) => item.isBagFee);
  const bagQuantity = bagItem?.quantity ?? 0;
  const t = getScStrings(lang);

  const handleLangChange = useCallback((next: ScLanguage) => {
    // Session-only. A customer changing language must not rewrite the
    // kiosk default stored in app config.
    setLang(next);
  }, []);

  const showToast = useCallback((kind: 'ok' | 'error', text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ kind, text });
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  const resetSession = useCallback(() => {
    cart.clear();
    setLastPaymentMethod(null);
    setLastReceiptPrinted(true);
    setPaymentOpen(false);
    setPaymentStatus(null);
    setCheckoutError(null);
    setScanQuantity(1);
    setAbandonOpen(false);
    setToast(null);
    reset();
  }, [cart, reset]);

  // Boot: load session defaults + runtime readiness.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await window.electronAPI.getConfig();
        if (cancelled) return;

        const runtime = resolveSelfCheckoutRuntime(config);
        setMode(runtime.mode);
        setUnavailableReasons(runtime.unavailableReasons);
        if (runtime.unavailableReasons.length > 0) {
          goTo('unavailable');
        }

        const savedLang = config?.selfCheckoutLanguage as ScLanguage | undefined;
        if (savedLang === 'pl' || savedLang === 'en' || savedLang === 'vi') {
          setLang(savedLang);
        }

        const fee = Number(config?.selfCheckoutBagFeeAmount);
        if (Number.isFinite(fee) && fee >= 0) {
          setBagFeeGrosze(Math.round(fee * 100));
        }

        const timeout = Number(config?.selfCheckoutIdleTimeoutMs);
        if (Number.isFinite(timeout) && timeout >= 30_000) {
          setIdleTimeoutMs(timeout);
        }

        const configuredKioskUserId = String(config?.selfCheckoutKioskUserId || '').trim();
        setKioskUserId(configuredKioskUserId || null);
        setFakePaymentEnabled(Boolean(config?.selfCheckoutFakePaymentEnabled));
      } catch {
        /* keep safe defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [goTo]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.pos?.payment?.onElavonStatus?.((data: any) => {
      if (data?.status) setPaymentStatus(String(data.status));
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  // Track real inactivity, not just screen transitions.
  useEffect(() => {
    const markActivity = () => setActivityAt(Date.now());
    document.addEventListener('pointerdown', markActivity);
    document.addEventListener('keydown', markActivity);
    return () => {
      document.removeEventListener('pointerdown', markActivity);
      document.removeEventListener('keydown', markActivity);
    };
  }, []);

  useEffect(() => {
    const EDGE_BLOCK_PX = 20;
    const STAFF_ZONE_Y = 120;
    const STAFF_SWIPE_PX = 80;

    const onTouchStart = (event: TouchEvent) => {
      const touches = event.touches;

      if (touches.length >= 3) {
        const allInZone = Array.from(touches).every((touch) => touch.clientY < STAFF_ZONE_Y);
        if (allInZone) {
          staffGestureStartY.current = Array.from(touches).map((touch) => touch.clientY);
          event.preventDefault();
          return;
        }
      }

      staffGestureStartY.current = [];

      if (touches.length === 1) {
        const touch = touches[0];
        const nearTop = touch.clientY < EDGE_BLOCK_PX;
        const nearLeft = touch.clientX < EDGE_BLOCK_PX;
        const nearRight = touch.clientX > window.innerWidth - EDGE_BLOCK_PX;
        if (nearTop || nearLeft || nearRight) {
          event.preventDefault();
        }
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length >= 3 && staffGestureStartY.current.length >= 3) {
        event.preventDefault();
        const currentY = Array.from(event.touches).map((touch) => touch.clientY);
        const allMovedDown = currentY.every(
          (y, index) => y - (staffGestureStartY.current[index] ?? 0) >= STAFF_SWIPE_PX,
        );
        if (allMovedDown) {
          staffGestureStartY.current = [];
          void window.electronAPI?.selfCheckout?.close?.();
        }
      }
    };

    const onTouchEnd = () => {
      if (staffGestureStartY.current.length > 0) {
        staffGestureStartY.current = [];
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: false });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);

    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  useEffect(() => {
    if (
      screen === 'welcome'
      || screen === 'thankyou'
      || screen === 'unavailable'
      || screen === 'receipt'
      || help
      || paymentOpen
    ) return;
    const timer = setTimeout(resetSession, idleTimeoutMs);
    return () => clearTimeout(timer);
  }, [activityAt, help, idleTimeoutMs, paymentOpen, resetSession, screen]);

  const addProductToCart = useCallback(
    (product: ProductLookupResult, fallbackEan = '', requestedQuantity = scanQuantity): boolean => {
      const quantity = normalizeScanQuantity(requestedQuantity);
      // Toasts and out-of-stock messages use the customer-facing display name;
      // cart row stores canonical `name` + raw translations so orders stay
      // canonical and live language switches re-render the cart correctly.
      const displayName = resolveName(product, lang);
      const stock = getProductStock(product);
      if (typeof stock === 'number' && stock <= 0) {
        showToast('error', formatScMessage(t.productOutOfStock, { name: displayName }));
        return false;
      }
      if (typeof stock === 'number' && stock < quantity) {
        showToast(
          'error',
          formatScMessage(t.productInsufficientStock, {
            name: displayName,
            stock,
          }),
        );
        return false;
      }

      const price = getProductPriceGrosze(product);
      if (price <= 0) {
        showToast('error', formatScMessage(t.productNoPrice, { name: displayName }));
        return false;
      }

      cart.add({
        variantId: product.id,
        productId: product.template_id || product.id,
        name: product.name,
        sku: product.sku || '',
        ean: product.barcode || fallbackEan,
        price,
        vatRate: product.vat_rate,
        imageUrl: product.thumbnail_url || product.image_url || undefined,
        name_translations: product.name_translations ?? null,
      }, quantity);
      showToast('ok', quantity > 1 ? `+ ${quantity} x ${displayName}` : `+ ${displayName}`);
      if (quantity > 1) setScanQuantity(1);
      return true;
    },
    [cart, lang, scanQuantity, showToast, t],
  );

  const handleScan = useCallback(
    async (ean: string): Promise<boolean> => {
      if (paymentOpen || screen === 'receipt' || screen === 'thankyou' || screen === 'unavailable') {
        return false;
      }
      const code = ean.trim();
      if (!code) return false;
      try {
        const product = (await window.electronAPI?.pos?.products?.getByBarcode?.(
          code,
        )) as ProductLookupResult | null | undefined;
        if (!product) {
          showToast('error', formatScMessage(t.productNotFound, { code }));
          return false;
        }

        return addProductToCart(product, code);
      } catch (err: any) {
        showToast('error', err?.message || t.scanFailed);
        return false;
      }
    },
    [addProductToCart, paymentOpen, screen, showToast, t],
  );

  const handleWelcomeScan = useCallback(
    async (ean: string) => {
      goTo('shopping');
      await handleScan(ean);
    },
    [goTo, handleScan],
  );

  const handleAbandonConfirm = useCallback(() => {
    resetSession();
  }, [resetSession]);

  const callStaff = useCallback(
    async (reason: string) => {
      try {
        const res = await window.electronAPI?.selfCheckout?.helpRequest?.({
          reason,
          cartTotalGrosze: cart.cart.totalGrosze,
        });
        if (res?.error) {
          showToast('error', res.error);
          return;
        }
        if (res?.id) {
          setHelp({ id: res.id, reason, acknowledged: !!res.acknowledgedAt });
          return;
        }
        showToast('error', 'Staff request failed');
      } catch {
        showToast('error', 'Connection error - staff not notified');
      }
    },
    [cart.cart.totalGrosze, showToast],
  );

  useEffect(() => {
    if (!help) {
      if (helpPollTimer.current) clearInterval(helpPollTimer.current);
      helpPollTimer.current = null;
      return;
    }
    helpPollTimer.current = setInterval(async () => {
      try {
        const status = await window.electronAPI?.selfCheckout?.checkStatus?.(
          help.id,
        );
        if (!status) return;
        if (status.resolvedAt) {
          setHelp(null);
          showToast('ok', 'Unlocked by staff');
          return;
        }
        if (status.acknowledgedAt && !help.acknowledged) {
          setHelp({ ...help, acknowledged: true });
        }
      } catch {
        /* ignore transient */
      }
    }, 2500);
    return () => {
      if (helpPollTimer.current) clearInterval(helpPollTimer.current);
      helpPollTimer.current = null;
    };
  }, [help, showToast]);

  const handlePaymentSuccess = useCallback(
    async (method: PaymentMethod) => {
      setCheckoutError(null);
      setPaymentStatus(null);

      if (mode === 'demo') {
        setLastReceiptPrinted(true);
        setLastPaymentMethod(method);
        setPaymentOpen(false);
        goTo('receipt');
        return;
      }

      const fail = (message: string) => {
        setCheckoutError(message);
        showToast('error', message);
        throw new Error(message);
      };

      if (method === 'BLIK') {
        fail(t.blikProductionUnsupported);
      }
      if (cart.cart.items.length === 0 || cart.cart.totalGrosze <= 0) {
        fail(t.emptyCart);
      }
      if (cart.cart.items.some((item) => item.isBagFee)) {
        fail(t.bagFeeProductionBlocked);
      }

      const orderId = crypto.randomUUID();
      if (fakePaymentEnabled) {
        setPaymentStatus(t.fakePaymentActive);
      } else {
        const paymentResult = await window.electronAPI?.pos?.payment?.cardPayment?.({
          amount: cart.cart.totalGrosze,
          orderId,
        });
        if (!paymentResult?.success) {
          fail(paymentResult?.error || 'Payment terminal failed');
        }
      }

      const sale = buildSelfCheckoutSale(cart.cart.items, orderId, method, kioskUserId);
      const orderResult = await window.electronAPI?.pos?.orders?.create?.(sale.order, sale.items);
      if (!orderResult?.success) {
        fail(orderResult?.error || 'Failed to save order');
      }

      window.electronAPI?.pos?.sync?.orders?.().catch(() => undefined);

      const printResult = await window.electronAPI?.pos?.payment?.printReceipt?.(orderId).catch(
        () => ({ success: false, receiptPrinted: false }),
      );
      const receiptPrinted = !!printResult?.receiptPrinted;
      if (!receiptPrinted) {
        showToast('error', t.receiptPrintFailed);
      }

      setLastReceiptPrinted(receiptPrinted);
      setLastPaymentMethod(method);
      setPaymentOpen(false);
      goTo('receipt');
    },
    [cart.cart.items, cart.cart.totalGrosze, fakePaymentEnabled, goTo, kioskUserId, mode, showToast, t],
  );

  if (help) {
    return (
      <HelpLockedOverlay
        lang={lang}
        acknowledged={help.acknowledged}
        reason={help.reason}
        onLangChange={handleLangChange}
      />
    );
  }

  if (screen === 'unavailable') {
    return (
      <UnavailableScreen
        lang={lang}
        reasons={unavailableReasons}
        onLangChange={handleLangChange}
      />
    );
  }

  if (screen === 'welcome') {
    return (
      <WelcomeScreen
        lang={lang}
        onLangChange={handleLangChange}
        onStart={() => goTo('shopping')}
        onScanStart={handleWelcomeScan}
      />
    );
  }

  if (screen === 'shopping') {
    return (
      <>
        <ScanScreen
          lang={lang}
          cartItems={cart.cart.items}
          totalGrosze={cart.cart.totalGrosze}
          onScan={handleScan}
          scanQuantity={scanQuantity}
          onScanQuantityChange={(quantity) => setScanQuantity(normalizeScanQuantity(quantity))}
          onIncrement={(id) => {
            const item = cart.cart.items.find((i) => i.variantId === id);
            if (item) cart.setQuantity(id, item.quantity + 1);
          }}
          onDecrement={(id) => {
            const item = cart.cart.items.find((i) => i.variantId === id);
            if (item) cart.setQuantity(id, item.quantity - 1);
          }}
          onRemove={(id) => cart.remove(id)}
          bagFeeGrosze={bagFeeGrosze}
          bagQuantity={bagQuantity}
          onBagQuantityChange={(quantity) => cart.setBagQuantity(quantity, bagFeeGrosze)}
          onCheckout={() => setPaymentOpen(true)}
          onCallStaff={() => callStaff('OTHER')}
          onAbandon={() => setAbandonOpen(true)}
          onLangChange={handleLangChange}
          toast={toast}
        />
        {abandonOpen && (
          <AbandonConfirm
            lang={lang}
            onCancel={() => setAbandonOpen(false)}
            onConfirm={handleAbandonConfirm}
          />
        )}
        {paymentOpen && (
          <PaymentScreen
            lang={lang}
            mode={mode}
            totalGrosze={cart.cart.totalGrosze}
            terminalStatus={paymentStatus}
            errorText={checkoutError}
            onSuccess={handlePaymentSuccess}
            onCancel={() => {
              setCheckoutError(null);
              setPaymentOpen(false);
            }}
            onLangChange={handleLangChange}
          />
        )}
      </>
    );
  }

  if (screen === 'receipt' && lastPaymentMethod) {
    return (
      <ReceiptScreen
        lang={lang}
        mode={mode}
        method={lastPaymentMethod}
        totalGrosze={cart.cart.totalGrosze}
        receiptPrinted={lastReceiptPrinted}
        onComplete={() => goTo('thankyou')}
        onLangChange={handleLangChange}
      />
    );
  }

  if (screen === 'thankyou') {
    return (
      <ThankYouScreen
        lang={lang}
        totalGrosze={cart.cart.totalGrosze}
        onReset={resetSession}
        onLangChange={handleLangChange}
      />
    );
  }

  return null;
}

interface AbandonConfirmProps {
  lang: ScLanguage;
  onConfirm: () => void;
  onCancel: () => void;
}

function AbandonConfirm({ lang, onConfirm, onCancel }: AbandonConfirmProps) {
  const t = getScStrings(lang);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/45 p-6">
      <div className="sc-surface w-[520px] p-8 text-center">
        <h3 className="mb-3 text-4xl font-black text-[var(--sc-ink)]">{t.abandonConfirmTitle}</h3>
        <p className="mb-8 text-xl leading-8 text-[var(--sc-muted)]">
          {t.abandonConfirmBody}
        </p>
        <div className="grid grid-cols-2 gap-4">
          <button
            type="button"
            onClick={onCancel}
            className="sc-secondary-action sc-focusable text-lg"
          >
            {t.back}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="sc-danger-action sc-focusable bg-red-50 text-lg"
          >
            {t.abandonConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
