// Self-checkout terminal entry point. This owns the kiosk state machine:
// unavailable -> welcome -> shopping -> receipt -> thank-you.
// Payment selection is an overlay on shopping; the customer should not leave
// the cart screen just to pick card/cash.
// Payment is currently an assisted profile: the kiosk speaks a Polish
// announcement so staff knows the amount + method, staff collects payment
// physically, then taps "Money received" to save the order, sync, and print.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScLanguage, getScStrings } from './i18n';
import { resolveName } from '../../../shared/catalog-names';
import {
  SelfCheckoutPaymentProfile,
  SelfCheckoutMode,
  SelfCheckoutProfile,
  resolveIdleTimeoutMs,
  resolveSelfCheckoutProfile,
  resolveSelfCheckoutRuntime,
} from './self-checkout-model';
import { isWeightedProduct } from './catalog-model';
import { useScreenState } from './screen-state';
import { type ScCartItem, useScCart } from './useScCart';
import { buildSelfCheckoutSale } from './build-sale';
import WelcomeScreen from './screens/WelcomeScreen';
import ScanScreen from './screens/ScanScreen';
import PaymentScreen, { PaymentMethod } from './screens/PaymentScreen';
import ThankYouScreen from './screens/ThankYouScreen';
import HelpLockedOverlay from './screens/HelpLockedOverlay';
import ReceiptScreen from './screens/ReceiptScreen';
import UnavailableScreen from './screens/UnavailableScreen';
import type {
  CatalogCategory as CategoryLookupResult,
  CatalogDepartment,
  SearchProduct as ProductLookupResult,
} from './types';

declare global {
  interface Window {
    electronAPI: any;
  }
}

type ToastState = { kind: 'ok' | 'error'; text: string } | null;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
// Show a 15s "are you still there?" warning before hard reset, per kiosk
// research (Kiosk Marketplace, Walmart UX research). Warn at total-15s.
const IDLE_WARN_MS = 15_000;

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

export default function SelfCheckoutApp() {
  const { screen, goTo, reset } = useScreenState('welcome');
  const [lang, setLang] = useState<ScLanguage>('pl');
  const [mode, setMode] = useState<SelfCheckoutMode>('demo');
  const [profile, setProfile] = useState<SelfCheckoutProfile>('retail_scan');
  const [paymentProfile, setPaymentProfile] = useState<SelfCheckoutPaymentProfile>('assistedDemo');
  const [allowOversell, setAllowOversell] = useState(false);
  const [unavailableReasons, setUnavailableReasons] = useState<string[]>([]);
  const [idleTimeoutMs, setIdleTimeoutMs] = useState<number>(DEFAULT_IDLE_TIMEOUT_MS);
  const [lastPaymentMethod, setLastPaymentMethod] = useState<PaymentMethod | null>(null);
  const [lastReceiptPrinted, setLastReceiptPrinted] = useState(true);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [kioskUserId, setKioskUserId] = useState<string | null>(null);
  const [scanQuantity, setScanQuantity] = useState(1);
  const [initialDepartment, setInitialDepartment] = useState<CatalogDepartment>('grocery');
  const [catalogCategories, setCatalogCategories] = useState<CategoryLookupResult[]>([]);
  const [catalogProducts, setCatalogProducts] = useState<ProductLookupResult[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [toast, setToast] = useState<ToastState>(null);
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [activityAt, setActivityAt] = useState(Date.now());
  const [idleWarnOpen, setIdleWarnOpen] = useState(false);
  const [receiptPrinting, setReceiptPrinting] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staffGestureStartY = useRef<number[]>([]);

  const [help, setHelp] = useState<
    | { id: string; reason: string; acknowledged: boolean }
    | null
  >(null);
  const helpPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const cart = useScCart();
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

  const refreshCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const [categories, products] = await Promise.all([
        window.electronAPI?.pos?.categories?.getAll?.().catch(() => []),
        window.electronAPI?.pos?.products?.getAll?.().catch(() => []),
      ]);
      setCatalogCategories((categories || []) as CategoryLookupResult[]);
      setCatalogProducts((products || []) as ProductLookupResult[]);
    } finally {
      setCatalogLoading(false);
    }
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
    setIdleWarnOpen(false);
    setReceiptPrinting(false);
    reset();
  }, [cart, reset]);

  useEffect(() => {
    void refreshCatalog();
    const unsubscribe = window.electronAPI?.pos?.sync?.onProductsSynced?.(() => {
      void refreshCatalog();
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [refreshCatalog]);

  // Boot: load session defaults + runtime readiness.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await window.electronAPI.getConfig();
        if (cancelled) return;

        const runtime = resolveSelfCheckoutRuntime(config);
        setMode(runtime.mode);
        setProfile(resolveSelfCheckoutProfile(config?.selfCheckoutProfile));
        setPaymentProfile(runtime.paymentProfile);
        setAllowOversell(config?.allowOversell === true);
        setUnavailableReasons(runtime.unavailableReasons);
        if (runtime.unavailableReasons.length > 0) {
          goTo('unavailable');
        }

        const savedLang = config?.selfCheckoutLanguage as ScLanguage | undefined;
        if (savedLang === 'pl' || savedLang === 'en' || savedLang === 'vi') {
          setLang(savedLang);
        }

        const timeout = Number(config?.selfCheckoutIdleTimeoutMs);
        if (Number.isFinite(timeout) && timeout >= 30_000) {
          setIdleTimeoutMs(timeout);
        }

        const configuredKioskUserId = String(config?.selfCheckoutKioskUserId || '').trim();
        setKioskUserId(configuredKioskUserId || null);
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

  // Idle handling: two-phase — warn 15s before reset so a customer who
  // looked away can confirm they're still there. Skips screens that
  // already auto-advance or that are passive (welcome/thankyou/unavailable).
  // While the payment overlay is open the window is extended (see
  // resolveIdleTimeoutMs): the customer may be paying on their own phone or
  // waiting for staff with money already handed over — a hard reset here
  // would drop a sale that was effectively paid.
  useEffect(() => {
    if (
      screen === 'welcome'
      || screen === 'thankyou'
      || screen === 'unavailable'
      || screen === 'receipt'
      || help
      || idleWarnOpen
    ) return;
    const effectiveTimeoutMs = resolveIdleTimeoutMs(idleTimeoutMs, paymentOpen);
    const warnDelay = Math.max(0, effectiveTimeoutMs - IDLE_WARN_MS);
    const warn = setTimeout(() => setIdleWarnOpen(true), warnDelay);
    return () => clearTimeout(warn);
  }, [activityAt, help, idleTimeoutMs, idleWarnOpen, paymentOpen, screen]);

  useEffect(() => {
    if (!idleWarnOpen) return;
    const hardReset = setTimeout(resetSession, IDLE_WARN_MS);
    return () => clearTimeout(hardReset);
  }, [idleWarnOpen, resetSession]);

  const addProductToCart = useCallback(
    (product: ProductLookupResult, fallbackEan = '', requestedQuantity = scanQuantity): boolean => {
      const quantity = normalizeScanQuantity(requestedQuantity);
      // Toasts and out-of-stock messages use the customer-facing display name;
      // cart row stores canonical `name` + raw translations so orders stay
      // canonical and live language switches re-render the cart correctly.
      const displayName = resolveName(product, lang);
      // Weighted products need a scale — the kiosk has none and the order
      // path would charge exactly 1 kg regardless of actual weight.
      if (isWeightedProduct(product)) {
        showToast('error', formatScMessage(t.productWeighted, { name: displayName }));
        return false;
      }
      const stock = getProductStock(product);
      const existing = cart.cart.items.find(
        (i) => i.variantId === product.id,
      );
      const alreadyInCart = existing?.quantity ?? 0;
      if (!allowOversell && typeof stock === 'number' && stock <= 0) {
        showToast('error', formatScMessage(t.productOutOfStock, { name: displayName }));
        return false;
      }
      if (!allowOversell && typeof stock === 'number' && alreadyInCart + quantity > stock) {
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
        stockAtAdd: stock,
        name_translations: product.name_translations ?? null,
      }, quantity);
      showToast('ok', quantity > 1 ? `+ ${quantity} x ${displayName}` : `+ ${displayName}`);
      if (quantity > 1) setScanQuantity(1);
      return true;
    },
    [allowOversell, cart, lang, scanQuantity, showToast, t],
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

  const handleSearchProducts = useCallback(
    async (rawQuery: string): Promise<ProductLookupResult[]> => {
      const query = rawQuery.trim();
      if (!query) return [];

      const byId = new Map<string, ProductLookupResult>();
      const addResult = (product: ProductLookupResult | null | undefined) => {
        if (product?.id && !byId.has(product.id)) byId.set(product.id, product);
      };
      const addResults = (products: ProductLookupResult[] | null | undefined) => {
        for (const product of products || []) addResult(product);
      };

      try {
        if (query.length >= 4) {
          addResult(await window.electronAPI?.pos?.products?.getByBarcode?.(query));
        }

        const [codeResults, smartResults] = await Promise.allSettled([
          window.electronAPI?.pos?.products?.searchByCode?.(query),
          window.electronAPI?.pos?.products?.search?.(query),
        ]);

        if (codeResults.status === 'fulfilled') {
          addResults(codeResults.value as ProductLookupResult[]);
        }
        if (smartResults.status === 'fulfilled') {
          addResults(smartResults.value as ProductLookupResult[]);
        }

        return Array.from(byId.values()).slice(0, 12);
      } catch {
        return [];
      }
    },
    [],
  );

  const handleWelcomeScan = useCallback(
    async (ean: string) => {
      setInitialDepartment(profile === 'menu_kitchen' ? 'kitchen' : 'grocery');
      goTo('shopping');
      await handleScan(ean);
    },
    [goTo, handleScan, profile],
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
        showToast('error', t.staffRequestFailed);
      } catch {
        showToast('error', t.staffConnectionError);
      }
    },
    [cart.cart.totalGrosze, showToast, t],
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
          showToast('ok', t.staffUnlocked);
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
  }, [help, showToast, t]);

  const handlePaymentSuccess = useCallback(
    async (method: PaymentMethod, customerNip: string | null) => {
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

      if (cart.cart.items.length === 0 || cart.cart.totalGrosze <= 0) {
        fail(t.emptyCart);
      }

      const orderId = crypto.randomUUID();

      const sale = buildSelfCheckoutSale({
        items: cart.cart.items,
        orderId,
        method,
        kioskUserId,
        customerNip,
      });
      const orderResult = await window.electronAPI?.pos?.orders?.create?.(sale.order, sale.items);
      if (!orderResult?.success) {
        fail(orderResult?.error || 'Failed to save order');
      }

      window.electronAPI?.pos?.sync?.orders?.().catch(() => undefined);

      // Keep the customer on the receipt screen while the backend routes the
      // print job. ALL methods print a fiscal paragon (Polish law requires
      // one for cash/BLIK too); CASH additionally pulses the cash drawer.
      setLastPaymentMethod(method);
      setPaymentOpen(false);
      setReceiptPrinting(true);
      setLastReceiptPrinted(true);
      goTo('receipt');

      const printResult = await window.electronAPI?.selfCheckout?.finalizePrint?.({ orderId, method }).catch(
        () => ({ success: false, printed: false, receiptPrinted: false }),
      );
      const receiptPrinted = !!(printResult?.printed ?? printResult?.receiptPrinted ?? printResult?.fiscalPrinted);
      if (!receiptPrinted) {
        showToast('error', printResult?.error || t.receiptPrintFailed);
        // Paid-but-no-paragon is a fiscal/legal incident, not just a UX
        // hiccup: alert staff proactively (fire-and-forget, no UI lock) so
        // it gets handled even if the customer walks away.
        window.electronAPI?.selfCheckout?.helpRequest?.({
          reason: 'PRINT_FAILED',
          cartTotalGrosze: cart.cart.totalGrosze,
        }).catch(() => undefined);
      }
      setLastReceiptPrinted(receiptPrinted);
      setReceiptPrinting(false);
    },
    [cart.cart.items, cart.cart.totalGrosze, goTo, kioskUserId, mode, showToast, t],
  );

  const callStaffOther = useCallback(() => callStaff('OTHER'), [callStaff]);
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
        onCallStaff={callStaffOther}
      />
    );
  }

  if (screen === 'welcome') {
    return (
      <WelcomeScreen
        lang={lang}
        profile={profile}
        onLangChange={handleLangChange}
        onStart={(department = 'grocery') => {
          setInitialDepartment(profile === 'menu_kitchen' ? 'kitchen' : department);
          goTo('shopping');
        }}
        onScanStart={handleWelcomeScan}
        onCallStaff={callStaffOther}
      />
    );
  }

  if (screen === 'shopping') {
    return (
      <>
        <ScanScreen
          lang={lang}
          profile={profile}
          cartItems={cart.cart.items}
          totalGrosze={cart.cart.totalGrosze}
          onScan={handleScan}
          onSearchProducts={handleSearchProducts}
          onAddSearchProduct={(product) => addProductToCart(product, product.barcode || product.sku || '')}
          categories={catalogCategories}
          products={catalogProducts}
          catalogLoading={catalogLoading}
          allowOversell={allowOversell}
          onAddCatalogProduct={(product) => addProductToCart(product, product.barcode || product.sku || '')}
          initialDepartment={initialDepartment}
          scanQuantity={scanQuantity}
          onScanQuantityChange={(quantity) => setScanQuantity(normalizeScanQuantity(quantity))}
          onIncrement={(id) => {
            const item = cart.cart.items.find((i) => i.variantId === id);
            if (!item) return;
            if (!allowOversell && typeof item.stockAtAdd === 'number' && item.quantity + 1 > item.stockAtAdd) {
              showToast(
                'error',
                formatScMessage(t.productInsufficientStock, {
                  name: resolveName(item, lang),
                  stock: item.stockAtAdd,
                }),
              );
              return;
            }
            cart.setQuantity(id, item.quantity + 1);
          }}
          onDecrement={(id) => {
            const item = cart.cart.items.find((i) => i.variantId === id);
            if (item) cart.setQuantity(id, item.quantity - 1);
          }}
          onRemove={(id) => cart.remove(id)}
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
        {idleWarnOpen && (
          <IdleWarning
            lang={lang}
            onStay={() => {
              setIdleWarnOpen(false);
              setActivityAt(Date.now());
            }}
          />
        )}
        {paymentOpen && (
          <PaymentScreen
            lang={lang}
            profile={paymentProfile}
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
        receiptPrinting={receiptPrinting}
        onComplete={() => goTo('thankyou')}
        onLangChange={handleLangChange}
        onCallStaff={callStaffOther}
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
        onCallStaff={callStaffOther}
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

interface IdleWarningProps {
  lang: ScLanguage;
  onStay: () => void;
}

function IdleWarning({ lang, onStay }: IdleWarningProps) {
  const t = getScStrings(lang);
  return (
    <div
      role="alertdialog"
      aria-labelledby="sc-idle-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/55 p-6"
    >
      <div className="sc-surface w-[560px] p-9 text-center">
        <h3 id="sc-idle-title" className="text-5xl font-black text-[var(--sc-ink)]">
          {t.idleWarningTitle}
        </h3>
        <p className="mt-4 text-xl leading-8 text-[var(--sc-muted)]">
          {t.idleWarningBody}
        </p>
        <button
          type="button"
          onClick={onStay}
          autoFocus
          className="sc-action sc-action-success sc-focusable mt-8 w-full text-2xl"
        >
          {t.idleWarningStay}
        </button>
      </div>
    </div>
  );
}
