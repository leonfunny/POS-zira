// Self-checkout terminal entry point. Drives the full kiosk state
// machine: welcome → scan → (optional NIP) → bag → payment →
// thank-you. Wezwij obsługę locks the terminal until staff resolves;
// abandon clears the cart back to welcome. Cart is persisted to
// localStorage so a crash mid-shop doesn't lose the active sale.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScLanguage, SC_LANGUAGES } from './i18n';
import { useScreenState } from './screen-state';
import { useScCart } from './useScCart';
import WelcomeScreen from './screens/WelcomeScreen';
import ScanScreen from './screens/ScanScreen';
import NipScreen from './screens/NipScreen';
import BagScreen from './screens/BagScreen';
import PaymentScreen, { PaymentMethod } from './screens/PaymentScreen';
import ThankYouScreen from './screens/ThankYouScreen';
import HelpLockedOverlay from './screens/HelpLockedOverlay';

interface ProductLookupResult {
  id: string;
  variant_id?: string;
  name: string;
  sku: string;
  price: number; // grosze
  vat_rate?: number;
  ean?: string;
  image_url?: string;
  stock?: number;
}

declare global {
  interface Window {
    electronAPI: any;
  }
}

type ToastState = { kind: 'ok' | 'error'; text: string } | null;

export default function SelfCheckoutApp() {
  const { screen, goTo, reset } = useScreenState('welcome');
  const [lang, setLang] = useState<ScLanguage>('pl');
  const [bagFeeGrosze, setBagFeeGrosze] = useState<number>(20);
  const [bagFeeAdded, setBagFeeAdded] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [help, setHelp] = useState<
    | { id: string; reason: string; acknowledged: boolean }
    | null
  >(null);
  const helpPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const cart = useScCart();

  // Boot: load language + bag fee from config.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await window.electronAPI.getConfig();
        if (cancelled) return;
        const savedLang = config?.selfCheckoutLanguage as ScLanguage | undefined;
        if (savedLang === 'pl' || savedLang === 'en' || savedLang === 'vi') {
          setLang(savedLang);
        }
        const fee = Number(config?.selfCheckoutBagFeeAmount);
        if (Number.isFinite(fee) && fee >= 0) {
          setBagFeeGrosze(Math.round(fee * 100));
        }
      } catch {
        /* ignore — defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLangChange = useCallback(async (next: ScLanguage) => {
    setLang(next);
    try {
      await window.electronAPI.saveConfig({ selfCheckoutLanguage: next });
    } catch {
      /* persistence is best-effort */
    }
  }, []);

  const showToast = useCallback((kind: 'ok' | 'error', text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ kind, text });
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  // Lookup + add by barcode.
  const handleScan = useCallback(
    async (ean: string) => {
      try {
        const product = (await window.electronAPI?.pos?.products?.getByBarcode?.(
          ean,
        )) as ProductLookupResult | null | undefined;
        if (!product) {
          showToast('error', `Nie znaleziono: ${ean}`);
          return;
        }
        if (typeof product.stock === 'number' && product.stock <= 0) {
          showToast('error', `${product.name} — brak na stanie`);
          return;
        }
        cart.add({
          variantId: product.variant_id || product.id,
          productId: product.id,
          name: product.name,
          sku: product.sku,
          ean,
          price: product.price,
          vatRate: product.vat_rate,
          imageUrl: product.image_url,
        });
        showToast('ok', `+ ${product.name}`);
      } catch (err: any) {
        showToast('error', err?.message || 'Scan failed');
      }
    },
    [cart, showToast],
  );

  // Abandon: confirm + reset.
  const [abandonOpen, setAbandonOpen] = useState(false);
  const handleAbandonConfirm = useCallback(() => {
    cart.clear();
    setAbandonOpen(false);
    setBagFeeAdded(false);
    reset();
  }, [cart, reset]);

  // Wezwij obsługę: open backend request + poll for resolved.
  const callStaff = useCallback(
    async (reason: string) => {
      try {
        const res = await window.electronAPI?.selfCheckout?.helpRequest?.({
          reason,
          cartTotalGrosze: cart.cart.totalGrosze,
        });
        if (res?.id) {
          setHelp({ id: res.id, reason, acknowledged: !!res.acknowledgedAt });
        }
      } catch {
        showToast('error', 'Connection error — staff not notified');
      }
    },
    [cart.cart.totalGrosze, showToast],
  );

  // Poll help-request status until resolved.
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

  // Idle timeout — only on screens that aren't the welcome itself
  // and only when not in the help-locked overlay. After 90s of zero
  // mutations / interactions, auto-reset back to welcome.
  useEffect(() => {
    if (screen === 'welcome' || screen === 'thankyou' || help) return;
    const timer = setTimeout(() => {
      cart.clear();
      setBagFeeAdded(false);
      reset();
    }, 90_000);
    return () => clearTimeout(timer);
  }, [screen, cart, help, reset]);

  // Bag-fee management: add a sentinel cart line when accepted.
  const addBagFee = useCallback(() => {
    if (bagFeeAdded || bagFeeGrosze <= 0) return;
    cart.add({
      variantId: '__bag-fee__',
      name: 'Torba foliowa',
      sku: 'BAG',
      price: bagFeeGrosze,
      isBagFee: true,
    });
    setBagFeeAdded(true);
  }, [bagFeeAdded, bagFeeGrosze, cart]);

  // Order creation on payment success — MOCK for now (no main IPC
  // hooked up; real order create lands once kiosk staffId / shift
  // wiring is sorted with the user). Logs the payload so the operator
  // can verify the contract is right.
  const onPaymentSuccess = useCallback(
    (method: PaymentMethod) => {
      // eslint-disable-next-line no-console
      console.info('[SelfCheckout] mock order create', {
        method,
        items: cart.cart.items,
        totalGrosze: cart.cart.totalGrosze,
        nip: cart.cart.customerNip,
      });
      goTo('thankyou');
    },
    [cart.cart, goTo],
  );

  const onTerminalReset = useCallback(() => {
    cart.clear();
    setBagFeeAdded(false);
    reset();
  }, [cart, reset]);

  // Render.
  if (help) {
    return (
      <HelpLockedOverlay
        lang={lang}
        acknowledged={help.acknowledged}
        reason={help.reason}
        onCancel={() => setHelp(null)}
      />
    );
  }

  if (screen === 'welcome') {
    return (
      <WelcomeScreen
        lang={lang}
        onLangChange={handleLangChange}
        onStart={() => goTo('scan')}
      />
    );
  }

  if (screen === 'scan') {
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
          onRemove={(id) => {
            cart.remove(id);
            if (id === '__bag-fee__') setBagFeeAdded(false);
          }}
          onCheckout={() => goTo('nip')}
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

  if (screen === 'nip') {
    return (
      <NipScreen
        lang={lang}
        initialNip={cart.cart.customerNip}
        onSkip={() => goTo('bag')}
        onBack={() => goTo('scan')}
        onConfirm={(nip) => {
          cart.setNip(nip);
          goTo('bag');
        }}
      />
    );
  }

  if (screen === 'bag') {
    return (
      <BagScreen
        lang={lang}
        bagFeeGrosze={bagFeeGrosze}
        onYes={() => {
          addBagFee();
          goTo('payment');
        }}
        onNo={() => goTo('payment')}
        onBack={() => goTo('nip')}
      />
    );
  }

  if (screen === 'payment') {
    return (
      <PaymentScreen
        lang={lang}
        totalGrosze={cart.cart.totalGrosze}
        onSuccess={onPaymentSuccess}
        onCancel={() => goTo('bag')}
      />
    );
  }

  if (screen === 'thankyou') {
    return (
      <ThankYouScreen
        lang={lang}
        totalGrosze={cart.cart.totalGrosze}
        onReset={onTerminalReset}
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
  const langInfo = SC_LANGUAGES.find((l) => l.code === lang);
  void langInfo;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50">
      <div className="w-[480px] rounded-3xl bg-white p-8 text-center shadow-2xl">
        <h3 className="mb-2 text-3xl font-extrabold">Porzucić zakupy?</h3>
        <p className="mb-8 text-lg text-slate-500">
          Cały koszyk zostanie usunięty.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border-2 border-slate-300 bg-white py-4 text-lg font-semibold text-slate-700 hover:bg-slate-50"
          >
            Wstecz
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-xl bg-red-600 py-4 text-lg font-bold text-white hover:bg-red-700"
          >
            Tak, porzuć
          </button>
        </div>
      </div>
    </div>
  );
}
