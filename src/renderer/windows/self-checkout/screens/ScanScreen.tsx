// Scan + cart screen. Scanner is the ONLY path to add a product on the
// customer-facing kiosk — the category browser was intentionally dropped
// for chesaigon MVP so the customer terminal has a single, unambiguous
// affordance. "No-barcode" cases route through staff assistance instead
// (see [[2026-05-12-zira-auth-login-and-self-checkout-closeout]] and
// [[2026-05-15-zira-catalog-i18n-phase1-and-scan-only]]).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Hand,
  Image as ImageIcon,
  Minus,
  PackageSearch,
  Plus,
  ScanBarcode,
  ShoppingBag,
  ShoppingCart,
  Trash2,
} from 'lucide-react';
import LanguageSwitch from '../LanguageSwitch';
import { ScLanguage, getScStrings } from '../i18n';
import { MAX_BAG_QUANTITY, ScCartItem, formatPLN } from '../useScCart';
import { resolveName } from '../../../../shared/catalog-names';

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
  scanQuantity: number;
  onScanQuantityChange: (quantity: number) => void;
  onIncrement: (variantId: string) => void;
  onDecrement: (variantId: string) => void;
  onRemove: (variantId: string) => void;
  bagFeeGrosze: number;
  bagQuantity: number;
  onBagQuantityChange: (quantity: number) => void;
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
  scanQuantity,
  onScanQuantityChange,
  onIncrement,
  onDecrement,
  onRemove,
  bagFeeGrosze,
  bagQuantity,
  onBagQuantityChange,
  onCheckout,
  onCallStaff,
  onAbandon,
  onLangChange,
  toast,
}: ScanScreenProps) {
  const t = getScStrings(lang);
  const scannerInputRef = useRef<HTMLInputElement>(null);
  const scannerBuffer = useRef<string>('');
  const scannerLastKey = useRef<number>(0);
  const lastScanRef = useRef<{ code: string; at: number } | null>(null);

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

  const handleScannedCode = useCallback(
    (rawCode: string) => {
      const code = rawCode.trim();
      if (code.length < 4) return;
      const now = Date.now();
      if (lastScanRef.current?.code === code && now - lastScanRef.current.at < 600) return;
      lastScanRef.current = { code, at: now };
      void onScan(code);
    },
    [onScan],
  );

  const focusScannerInput = useCallback(() => {
    scannerInputRef.current?.focus();
  }, []);

  const handleScannerInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const code = e.currentTarget.value;
      e.currentTarget.value = '';
      handleScannedCode(code);
    },
    [handleScannedCode],
  );

  useEffect(() => {
    focusScannerInput();
    const handler = () => setTimeout(focusScannerInput, 50);
    document.addEventListener('pointerdown', handler);
    const interval = setInterval(focusScannerInput, 1000);
    return () => {
      document.removeEventListener('pointerdown', handler);
      clearInterval(interval);
    };
  }, [focusScannerInput]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.dataset?.scannerCapture === 'true') return;
      const now = Date.now();
      if (now - scannerLastKey.current > 150) {
        scannerBuffer.current = '';
      }
      scannerLastKey.current = now;
      if (e.key === 'Enter') {
        const code = scannerBuffer.current.trim();
        scannerBuffer.current = '';
        handleScannedCode(code);
        return;
      }
      if (e.key.length === 1 && /[0-9A-Za-z\-_]/.test(e.key)) {
        scannerBuffer.current += e.key;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleScannedCode]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onBarcodeScanned?.((barcode: string) => {
      handleScannedCode(barcode);
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [handleScannedCode]);

  const productCount = cartItems.reduce((sum, item) => sum + (item.isBagFee ? 0 : item.quantity), 0);

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
        aria-label="Barcode scanner"
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
              Self-checkout
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
          <div className="sc-surface sc-scan-panel flex min-h-[280px] flex-1 flex-col justify-center p-5 xl:p-6">
            <div className="flex flex-col gap-6 xl:flex-row xl:items-center xl:gap-8">
              <div className="sc-scan-icon flex h-24 w-24 shrink-0 items-center justify-center rounded-[24px] bg-[var(--sc-primary-soft)] text-[var(--sc-primary-deep)] xl:h-28 xl:w-28 xl:rounded-[30px]">
                <ScanBarcode className="h-16 w-16 xl:h-20 xl:w-20" />
              </div>
              <div className="min-w-0 w-full xl:w-auto">
                <h1 className="sc-scan-title text-4xl font-black text-[var(--sc-ink)] xl:text-5xl">
                  {t.scanPrompt}
                </h1>
                <p className="sc-scan-hint mt-3 text-xl font-semibold leading-8 text-[var(--sc-muted)] xl:text-2xl xl:leading-9">
                  {t.scanHint}
                </p>
                <div className="sc-scan-quantity mt-5 flex w-full max-w-[560px] flex-wrap items-center gap-3 rounded-3xl border-2 border-[var(--sc-border)] bg-white p-3 xl:mt-6 xl:inline-flex xl:w-auto xl:max-w-none xl:flex-nowrap xl:gap-3">
                  <div className="min-w-[160px] flex-1 px-3 xl:flex-none">
                    <div className="text-base font-black text-[var(--sc-ink)]">
                      {t.scanQuantity}
                    </div>
                    <div className="text-sm font-semibold text-[var(--sc-muted)]">
                      {t.scanQuantityHint}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onScanQuantityChange(scanQuantity - 1)}
                    disabled={scanQuantity <= 1}
                    className="sc-focusable flex h-14 w-14 items-center justify-center rounded-2xl border-2 border-[var(--sc-border)] bg-[var(--sc-surface-muted)] text-[var(--sc-ink)] disabled:opacity-35 xl:h-16 xl:w-16"
                    aria-label="-"
                  >
                    <Minus size={28} />
                  </button>
                  <div className="sc-tabular flex h-14 min-w-[76px] items-center justify-center rounded-2xl bg-[var(--sc-primary-soft)] px-5 text-3xl font-black text-[var(--sc-primary-deep)] xl:h-16 xl:min-w-[88px] xl:text-4xl">
                    {scanQuantity}
                  </div>
                  <button
                    type="button"
                    onClick={() => onScanQuantityChange(scanQuantity + 1)}
                    disabled={scanQuantity >= 99}
                    className="sc-focusable flex h-14 w-14 items-center justify-center rounded-2xl border-2 border-[var(--sc-border)] bg-[var(--sc-surface-muted)] text-[var(--sc-ink)] disabled:opacity-35 xl:h-16 xl:w-16"
                    aria-label="+"
                  >
                    <Plus size={28} />
                  </button>
                </div>
              </div>
            </div>

            {toast && (
              <div
                role={toast.kind === 'error' ? 'alert' : 'status'}
                className={`mt-8 rounded-2xl border px-5 py-4 text-xl font-black ${
                  toast.kind === 'ok'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-red-200 bg-red-50 text-[var(--sc-danger)]'
                }`}
              >
                {toast.text}
              </div>
            )}
          </div>
        </section>

        <aside className="sc-surface sc-cart-panel flex min-h-0 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--sc-border)] px-4 py-3">
            <div className="flex items-center gap-3">
              <ShoppingCart size={24} className="text-[var(--sc-primary-deep)]" />
              <div>
                <div className="text-xl font-black text-[var(--sc-ink)]">
                  {t.total}
                </div>
                <div className="text-sm font-semibold text-[var(--sc-muted)]">
                  {productCount} {t.items}
                </div>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {cartItems.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                <PackageSearch size={64} className="mb-5 text-[var(--sc-border)]" />
                <div className="text-2xl font-black text-[var(--sc-ink)]">
                  {t.emptyCart}
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-[var(--sc-border)]">
                {cartItems.map((item) => {
                  const isFresh = freshVariantId === item.variantId;
                  const isLastOne = item.quantity === 1;
                  return (
                    <li
                      key={item.variantId + (item.isBagFee ? '-bag' : '')}
                      className={`sc-cart-item px-4 py-3 ${isFresh ? 'sc-cart-item-fresh bg-emerald-50/60' : ''}`}
                    >
                      <div className="flex items-start gap-3">
                        {item.isBagFee ? (
                          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-[var(--sc-surface-muted)] text-[var(--sc-primary-deep)]">
                            <ShoppingBag size={26} />
                          </div>
                        ) : item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt=""
                            className="h-14 w-14 shrink-0 rounded-xl object-cover"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                          />
                        ) : (
                          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-[var(--sc-surface-muted)] text-[var(--sc-muted)]">
                            <ImageIcon size={24} />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-lg font-black leading-snug text-[var(--sc-ink)]">
                            {resolveName(item, lang)}
                          </div>
                          <div className="mt-1 text-sm font-semibold text-[var(--sc-muted)]">
                            {formatPLN(item.price)}
                            {item.sku ? ` · ${item.sku}` : ''}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => onRemove(item.variantId)}
                          className="sc-focusable flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--sc-muted)] hover:bg-red-50 hover:text-[var(--sc-danger)]"
                          aria-label={t.remove}
                        >
                          <Trash2 size={22} />
                        </button>
                      </div>
                      <div className="mt-2 flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => onDecrement(item.variantId)}
                          className={`sc-focusable flex h-11 w-11 items-center justify-center rounded-xl border-2 font-black ${
                            isLastOne
                              ? 'border-red-200 bg-red-50 text-[var(--sc-danger)] hover:bg-red-100'
                              : 'border-[var(--sc-border)] bg-white hover:bg-[var(--sc-surface-muted)]'
                          }`}
                          aria-label={isLastOne ? t.remove : '-'}
                        >
                          {/* At qty=1, the minus removes the row — show a trash icon
                              so the customer sees what the tap will do. */}
                          {isLastOne ? <Trash2 size={20} /> : <Minus size={22} />}
                        </button>
                        <span className="sc-tabular min-w-[3ch] text-center text-2xl font-black">
                          {item.quantity}
                        </span>
                        <button
                          type="button"
                          onClick={() => onIncrement(item.variantId)}
                          className="sc-focusable flex h-11 w-11 items-center justify-center rounded-xl border-2 border-[var(--sc-border)] bg-white font-black hover:bg-[var(--sc-surface-muted)]"
                          aria-label="+"
                        >
                          <Plus size={22} />
                        </button>
                        <span className="sc-tabular ml-auto text-lg font-black text-[var(--sc-ink)]">
                          {formatPLN(item.price * item.quantity)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="sc-cart-footer border-t border-[var(--sc-border)] bg-white p-4">
            <div className="sc-bag-control mb-3 grid grid-cols-[minmax(0,1fr)_178px] items-center gap-3 rounded-2xl border border-[var(--sc-border)] bg-[var(--sc-surface-muted)] p-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-[var(--sc-primary-deep)]">
                  <ShoppingBag size={26} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-base font-black leading-tight text-[var(--sc-ink)]">
                    {t.bagQuestion}
                  </div>
                  <div className="mt-1 text-sm font-bold text-[var(--sc-muted)]">
                    {formatPLN(bagFeeGrosze)} / {t.bagUnit}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
                <button
                  type="button"
                  onClick={() => onBagQuantityChange(bagQuantity - 1)}
                  disabled={bagQuantity <= 0}
                  className="sc-focusable flex h-11 w-11 items-center justify-center rounded-xl border-2 border-[var(--sc-border)] bg-white text-[var(--sc-ink)] disabled:cursor-not-allowed disabled:opacity-35"
                  aria-label="-"
                >
                  <Minus size={24} />
                </button>
                <div className="sc-tabular flex h-11 items-center justify-center rounded-xl bg-white px-3 text-2xl font-black text-[var(--sc-ink)]">
                  {bagQuantity}
                </div>
                <button
                  type="button"
                  onClick={() => onBagQuantityChange(bagQuantity + 1)}
                  disabled={bagQuantity >= MAX_BAG_QUANTITY}
                  className="sc-focusable flex h-11 w-11 items-center justify-center rounded-xl border-2 border-[var(--sc-border)] bg-white text-[var(--sc-ink)] disabled:cursor-not-allowed disabled:opacity-35"
                  aria-label="+"
                >
                  <Plus size={24} />
                </button>
              </div>
            </div>
            <div className="mb-3 flex items-end justify-between gap-4">
              <span className="text-lg font-black uppercase tracking-wide text-[var(--sc-muted)]">
                {t.total}
              </span>
              {/* TOTAL is the largest type on this screen — research from
                  Tesco/Walmart/IKEA shows customers read the running total
                  from a step back, so it should dominate. */}
              <span
                key={totalTickKey}
                className="sc-tabular sc-total-tick text-6xl font-black text-[var(--sc-ink)] xl:text-7xl"
              >
                {formatPLN(totalGrosze)}
              </span>
            </div>
            <button
              type="button"
              onClick={onCheckout}
              disabled={productCount === 0}
              className="sc-action sc-action-success sc-cart-pay sc-focusable flex w-full items-center justify-center gap-3 text-2xl"
            >
              {t.pay}
            </button>
          </div>
        </aside>
      </main>
    </div>
  );
}
