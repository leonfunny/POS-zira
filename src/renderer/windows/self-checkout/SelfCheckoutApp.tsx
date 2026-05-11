// Self-checkout terminal entry point. This owns the kiosk state machine:
// unavailable -> welcome -> shopping -> summary -> payment -> receipt -> thank-you.
// Production payment/order/fiscal paths intentionally fail closed until real
// terminal and fiscal-printer integrations are wired.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScLanguage, getScStrings } from './i18n';
import {
  SelfCheckoutMode,
  resolveSelfCheckoutRuntime,
} from './self-checkout-model';
import { useScreenState } from './screen-state';
import { useScCart } from './useScCart';
import WelcomeScreen from './screens/WelcomeScreen';
import ScanScreen from './screens/ScanScreen';
import PaymentScreen, { PaymentMethod } from './screens/PaymentScreen';
import ThankYouScreen from './screens/ThankYouScreen';
import HelpLockedOverlay from './screens/HelpLockedOverlay';
import SummaryScreen from './screens/SummaryScreen';
import ReceiptScreen from './screens/ReceiptScreen';
import UnavailableScreen from './screens/UnavailableScreen';

interface ProductLookupResult {
  id: string;
  template_id?: string | null;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  retail_price?: number;
  price?: number;
  price_gross?: number;
  vat_rate?: number;
  image_url?: string | null;
  thumbnail_url?: string | null;
  in_stock?: number;
  available_qty?: number;
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

export default function SelfCheckoutApp() {
  const { screen, goTo, reset } = useScreenState('welcome');
  const [lang, setLang] = useState<ScLanguage>('pl');
  const [mode, setMode] = useState<SelfCheckoutMode>('demo');
  const [unavailableReasons, setUnavailableReasons] = useState<string[]>([]);
  const [bagFeeGrosze, setBagFeeGrosze] = useState<number>(20);
  const [idleTimeoutMs, setIdleTimeoutMs] = useState<number>(DEFAULT_IDLE_TIMEOUT_MS);
  const [lastPaymentMethod, setLastPaymentMethod] = useState<PaymentMethod | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [activityAt, setActivityAt] = useState(Date.now());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [help, setHelp] = useState<
    | { id: string; reason: string; acknowledged: boolean }
    | null
  >(null);
  const helpPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const cart = useScCart();
  const hasBagFee = cart.cart.items.some((item) => item.isBagFee);

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
      } catch {
        /* keep safe defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [goTo]);

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
    if (screen === 'welcome' || screen === 'thankyou' || screen === 'unavailable' || help) return;
    const timer = setTimeout(resetSession, idleTimeoutMs);
    return () => clearTimeout(timer);
  }, [activityAt, help, idleTimeoutMs, resetSession, screen]);

  const handleScan = useCallback(
    async (ean: string): Promise<boolean> => {
      try {
        const product = (await window.electronAPI?.pos?.products?.getByBarcode?.(
          ean,
        )) as ProductLookupResult | null | undefined;
        if (!product) {
          showToast('error', `Nie znaleziono: ${ean}`);
          return false;
        }

        const stock = getProductStock(product);
        if (typeof stock === 'number' && stock <= 0) {
          showToast('error', `${product.name} - brak na stanie`);
          return false;
        }

        const price = getProductPriceGrosze(product);
        if (price <= 0) {
          showToast('error', `${product.name} - brak ceny`);
          return false;
        }

        cart.add({
          variantId: product.id,
          productId: product.template_id || product.id,
          name: product.name,
          sku: product.sku || '',
          ean: product.barcode || ean,
          price,
          vatRate: product.vat_rate,
          imageUrl: product.thumbnail_url || product.image_url || undefined,
        });
        showToast('ok', `+ ${product.name}`);
        return true;
      } catch (err: any) {
        showToast('error', err?.message || 'Scan failed');
        return false;
      }
    },
    [cart, showToast],
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
    (method: PaymentMethod) => {
      setLastPaymentMethod(method);
      goTo('receipt');
    },
    [goTo],
  );

  if (help) {
    return (
      <HelpLockedOverlay
        lang={lang}
        acknowledged={help.acknowledged}
        reason={help.reason}
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
          onIncrement={(id) => {
            const item = cart.cart.items.find((i) => i.variantId === id);
            if (item && !item.isBagFee) cart.setQuantity(id, item.quantity + 1);
          }}
          onDecrement={(id) => {
            const item = cart.cart.items.find((i) => i.variantId === id);
            if (item) cart.setQuantity(id, item.quantity - 1);
          }}
          onRemove={(id) => cart.remove(id)}
          onCheckout={() => goTo('summary')}
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
      </>
    );
  }

  if (screen === 'summary') {
    return (
      <>
        <SummaryScreen
          lang={lang}
          cartItems={cart.cart.items}
          totalGrosze={cart.cart.totalGrosze}
          customerNip={cart.cart.customerNip}
          bagFeeGrosze={bagFeeGrosze}
          hasBagFee={hasBagFee}
          onSetBagFee={(enabled) => cart.setBagFee(enabled, bagFeeGrosze)}
          onSetNip={(nip) => cart.setNip(nip)}
          onBack={() => goTo('shopping')}
          onPay={() => goTo('payment')}
          onCallStaff={() => callStaff('OTHER')}
          onAbandon={() => setAbandonOpen(true)}
        />
        {abandonOpen && (
          <AbandonConfirm
            lang={lang}
            onCancel={() => setAbandonOpen(false)}
            onConfirm={handleAbandonConfirm}
          />
        )}
      </>
    );
  }

  if (screen === 'payment') {
    return (
      <PaymentScreen
        lang={lang}
        mode={mode}
        totalGrosze={cart.cart.totalGrosze}
        onSuccess={handlePaymentSuccess}
        onCancel={() => goTo('summary')}
      />
    );
  }

  if (screen === 'receipt' && lastPaymentMethod) {
    return (
      <ReceiptScreen
        lang={lang}
        mode={mode}
        method={lastPaymentMethod}
        totalGrosze={cart.cart.totalGrosze}
        onComplete={() => goTo('thankyou')}
      />
    );
  }

  if (screen === 'thankyou') {
    return (
      <ThankYouScreen
        lang={lang}
        totalGrosze={cart.cart.totalGrosze}
        onReset={resetSession}
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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50">
      <div className="w-[480px] rounded-3xl bg-white p-8 text-center shadow-2xl">
        <h3 className="mb-2 text-3xl font-extrabold">{t.abandonConfirmTitle}</h3>
        <p className="mb-8 text-lg text-slate-500">
          {t.abandonConfirmBody}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border-2 border-slate-300 bg-white py-4 text-lg font-semibold text-slate-700 hover:bg-slate-50"
          >
            {t.back}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-xl bg-red-600 py-4 text-lg font-bold text-white hover:bg-red-700"
          >
            {t.abandonConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
