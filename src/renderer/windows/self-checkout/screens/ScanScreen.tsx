// Scan + cart screen. Customer scans products into the cart. Left pane
// is the active scan target / category prompt; right pane is the live
// cart with +/- buttons and remove. Bottom bar shows total and
// "Przejdź do płatności" / "Pay". Top toolbar carries help/abandon/
// language. HID-style barcode scanner is captured globally via a
// keypress listener (each scan ends with Enter).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScLanguage, getScStrings } from '../i18n';
import { ScCartItem, formatPLN } from '../useScCart';

interface ScanScreenProps {
  lang: ScLanguage;
  cartItems: ScCartItem[];
  totalGrosze: number;
  onScan: (ean: string) => Promise<unknown> | unknown;
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
  onIncrement,
  onDecrement,
  onRemove,
  onCheckout,
  onCallStaff,
  onAbandon,
  toast,
}: ScanScreenProps) {
  const t = getScStrings(lang);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualValue, setManualValue] = useState('');
  const scannerBuffer = useRef<string>('');
  const scannerLastKey = useRef<number>(0);

  // Global HID scanner capture: characters arriving < 50ms apart with
  // a trailing Enter look like a barcode scan.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (manualOpen) return; // don't steal keys while typing the numpad
      const now = Date.now();
      if (now - scannerLastKey.current > 80) {
        scannerBuffer.current = '';
      }
      scannerLastKey.current = now;
      if (e.key === 'Enter') {
        const code = scannerBuffer.current.trim();
        scannerBuffer.current = '';
        if (code.length >= 4) void onScan(code);
        return;
      }
      if (e.key.length === 1 && /[0-9A-Za-z\-_]/.test(e.key)) {
        scannerBuffer.current += e.key;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [manualOpen, onScan]);

  const submitManual = useCallback(async () => {
    const v = manualValue.trim();
    if (v.length < 4) return;
    setManualOpen(false);
    setManualValue('');
    await onScan(v);
  }, [manualValue, onScan]);

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-50 text-slate-900 select-none">
      {/* Top toolbar */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
        <button
          type="button"
          onClick={onAbandon}
          className="rounded-xl border-2 border-slate-300 bg-white px-5 py-3 text-base font-semibold text-slate-700 hover:bg-slate-100"
        >
          ✗ {t.abandon}
        </button>
        <button
          type="button"
          onClick={onCallStaff}
          className="rounded-xl border-2 border-amber-300 bg-amber-50 px-5 py-3 text-base font-semibold text-amber-800 hover:bg-amber-100"
        >
          🆘 {t.callStaff}
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0 gap-4 p-4">
        {/* Left: scan prompt */}
        <div className="flex w-3/5 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-white p-8">
          <div className="text-7xl mb-4">📦</div>
          <h2 className="mb-2 text-4xl font-bold">{t.scanPrompt}</h2>
          <p className="mb-8 text-xl text-slate-500">{t.scanHint}</p>
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            className="rounded-xl bg-slate-900 px-8 py-4 text-xl font-semibold text-white hover:bg-slate-800"
          >
            ⌨️ {t.manualEntry}
          </button>
          {toast && (
            <div
              className={`mt-6 rounded-xl px-4 py-3 text-lg font-semibold ${
                toast.kind === 'ok'
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'bg-red-50 text-red-800 border border-red-200'
              }`}
            >
              {toast.text}
            </div>
          )}
        </div>

        {/* Right: cart */}
        <div className="flex w-2/5 min-w-0 flex-col rounded-2xl bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold uppercase tracking-wider text-slate-500">
            {t.total} ({cartItems.length})
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {cartItems.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-lg text-slate-400">
                {t.emptyCart}
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {cartItems.map((item) => (
                  <li
                    key={item.variantId + (item.isBagFee ? '-bag' : '')}
                    className="px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-base font-semibold">
                          {item.name}
                        </div>
                        <div className="text-sm text-slate-500">
                          {formatPLN(item.price)}
                          {item.sku ? ` · ${item.sku}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onRemove(item.variantId)}
                        className="text-2xl leading-none text-slate-400 hover:text-red-600"
                        aria-label={t.remove}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onDecrement(item.variantId)}
                        className="h-10 w-10 rounded-lg border-2 border-slate-200 text-xl font-bold hover:bg-slate-100"
                      >
                        −
                      </button>
                      <span className="min-w-[3ch] text-center text-xl font-semibold tabular-nums">
                        {item.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => onIncrement(item.variantId)}
                        disabled={item.isBagFee}
                        className="h-10 w-10 rounded-lg border-2 border-slate-200 text-xl font-bold hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-white"
                      >
                        +
                      </button>
                      <span className="ml-auto text-base font-bold tabular-nums">
                        {formatPLN(item.price * item.quantity)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Bottom bar */}
          <div className="border-t border-slate-200 px-4 py-3">
            <div className="mb-3 flex items-baseline justify-between">
              <span className="text-lg font-semibold text-slate-600">
                {t.total}
              </span>
              <span className="text-3xl font-extrabold tabular-nums">
                {formatPLN(totalGrosze)}
              </span>
            </div>
            <button
              type="button"
              onClick={onCheckout}
              disabled={cartItems.length === 0}
              className="w-full rounded-xl bg-emerald-600 py-5 text-2xl font-bold text-white shadow-lg shadow-emerald-600/30 transition-colors hover:bg-emerald-700 disabled:bg-slate-300 disabled:shadow-none"
            >
              {t.pay} {formatPLN(totalGrosze)} →
            </button>
          </div>
        </div>
      </div>

      {/* Manual entry modal */}
      {manualOpen && (
        <ManualNumpad
          title={t.manualEntry}
          value={manualValue}
          onChange={setManualValue}
          onCancel={() => {
            setManualOpen(false);
            setManualValue('');
          }}
          onSubmit={submitManual}
          okLabel={t.scanPrompt}
          cancelLabel={t.cancel}
          maxLength={14}
        />
      )}
    </div>
  );
}

interface ManualNumpadProps {
  title: string;
  value: string;
  onChange: (next: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  okLabel: string;
  cancelLabel: string;
  maxLength?: number;
}

export function ManualNumpad({
  title,
  value,
  onChange,
  onCancel,
  onSubmit,
  okLabel,
  cancelLabel,
  maxLength = 14,
}: ManualNumpadProps) {
  const press = (k: string) => {
    if (k === '<') onChange(value.slice(0, -1));
    else if (value.length < maxLength) onChange(value + k);
  };
  const keys = ['1','2','3','4','5','6','7','8','9','<','0','OK'];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
      <div className="w-[420px] rounded-3xl bg-white p-6 shadow-2xl">
        <h3 className="mb-3 text-2xl font-bold text-center">{title}</h3>
        <div className="mb-4 h-16 rounded-xl border-2 border-slate-200 bg-slate-50 px-4 text-center text-3xl font-mono tabular-nums leading-[64px] tracking-widest">
          {value || <span className="text-slate-300">—</span>}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {keys.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => (k === 'OK' ? onSubmit() : press(k))}
              className={`h-16 rounded-xl text-2xl font-bold transition-colors ${
                k === 'OK'
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : k === '<'
                    ? 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    : 'bg-slate-100 hover:bg-slate-200'
              }`}
              aria-label={k}
            >
              {k === '<' ? '⌫' : k === 'OK' ? okLabel : k}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 w-full rounded-xl border-2 border-slate-200 py-3 text-base font-semibold text-slate-600 hover:bg-slate-50"
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
