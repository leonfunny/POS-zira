import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Coins,
  Languages,
  Maximize,
  Monitor,
  ScanBarcode,
  XCircle,
} from 'lucide-react';
import { useConfig } from '../hooks/useConfig';
import {
  SelfCheckoutMode,
  resolveSelfCheckoutRuntime,
} from '../windows/self-checkout/self-checkout-model';
import rlog from '../utils/logger';

type ScLang = 'pl' | 'en' | 'vi';

export default function SelfCheckoutTab() {
  const { config, saveConfig } = useConfig();

  const [language, setLanguage] = useState<ScLang>('pl');
  const [mode, setMode] = useState<SelfCheckoutMode>('demo');
  const [bagFee, setBagFee] = useState<number>(0.20);
  const [monitor, setMonitor] = useState<number>(0);
  const [idleTimeoutMs, setIdleTimeoutMs] = useState<number>(90000);
  const [displays, setDisplays] = useState<Array<{ index: number; width: number; height: number; isPrimary: boolean; label?: string }>>([]);
  const [opening, setOpening] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!config) return;
    const c = config as any;
    setLanguage((c.selfCheckoutLanguage as ScLang) ?? 'pl');
    setMode(c.selfCheckoutMode === 'production' ? 'production' : 'demo');
    setBagFee(typeof c.selfCheckoutBagFeeAmount === 'number' ? c.selfCheckoutBagFeeAmount : 0.20);
    setMonitor(typeof c.selfCheckoutMonitor === 'number' ? c.selfCheckoutMonitor : 0);
    setIdleTimeoutMs(typeof c.selfCheckoutIdleTimeoutMs === 'number' ? c.selfCheckoutIdleTimeoutMs : 90000);
  }, [config]);

  useEffect(() => {
    (async () => {
      try {
        const api = window.electronAPI as any;
        const list = await (api.display?.list?.() ?? api.getDisplays?.());
        if (Array.isArray(list)) setDisplays(list);
      } catch {
        /* display listing may not exist in older builds */
      }
    })();
  }, []);

  const runtime = useMemo(
    () => resolveSelfCheckoutRuntime({ selfCheckoutMode: mode }),
    [mode],
  );
  const isProductionBlocked = runtime.unavailableReasons.length > 0;

  const persist = async (patch: Record<string, any>) => {
    try {
      await saveConfig(patch);
      setSavedAt(Date.now());
    } catch (err) {
      rlog.error('[SelfCheckoutTab] saveConfig failed:', err);
    }
  };

  const openKiosk = async () => {
    setOpening(true);
    try {
      await persist({
        selfCheckoutEnabled: true,
        selfCheckoutMode: mode,
        selfCheckoutLanguage: language,
        selfCheckoutBagFeeAmount: bagFee,
        selfCheckoutMonitor: monitor,
        selfCheckoutIdleTimeoutMs: idleTimeoutMs,
      });
      const result = await window.electronAPI.window.open('selfCheckout');
      if (!result?.success) {
        rlog.error('[SelfCheckoutTab] Failed to open kiosk:', result?.error);
        alert(`Could not open kiosk: ${result?.error || 'unknown error'}`);
      }
    } catch (err: any) {
      rlog.error('[SelfCheckoutTab] openKiosk failed:', err);
      alert(`Could not open kiosk: ${err?.message || err}`);
    } finally {
      setOpening(false);
    }
  };

  const justSaved = savedAt && Date.now() - savedAt < 2000;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <ScanBarcode size={24} className="text-brand-600" />
            Self-Checkout Kiosk
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Customer-operated kiosk. Demo is usable; production is blocked until payment, order, and fiscal paths are real.
          </p>
        </div>
      </div>

      <div className="panel p-5">
        <div className="flex items-start gap-3">
          {isProductionBlocked ? (
            <AlertTriangle size={22} className="mt-0.5 text-amber-600" />
          ) : (
            <CheckCircle2 size={22} className="mt-0.5 text-emerald-600" />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-slate-800">
              {mode === 'demo' ? 'Demo mode is available' : 'Production mode is blocked'}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {mode === 'demo'
                ? 'Demo can scan products and walk through summary/payment/receipt states, but it does not create a real sale.'
                : 'The kiosk will open only into a closed/unavailable state until these blockers are removed.'}
            </p>
            {isProductionBlocked && (
              <div className="mt-4 grid gap-2">
                {runtime.unavailableReasons.map((reason) => (
                  <div key={reason} className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    <XCircle size={16} />
                    {reason}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="panel p-6 space-y-6">
        <button
          type="button"
          onClick={openKiosk}
          disabled={opening}
          className="w-full px-6 py-4 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 disabled:cursor-not-allowed text-white rounded-xl text-base font-semibold transition-colors flex items-center justify-center gap-3 shadow-sm"
        >
          <Maximize size={20} />
          {opening
            ? 'Opening kiosk...'
            : mode === 'demo'
              ? 'Open demo self-checkout'
              : 'Open closed production kiosk'}
        </button>
        <p className="text-xs text-slate-500 text-center -mt-3">
          Settings below auto-save and apply on next launch.
        </p>

        <div className="border-t border-slate-200" />

        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
            <AlertTriangle size={16} className="text-slate-500" />
            Runtime mode
          </label>
          <select
            value={mode}
            onChange={(e) => {
              const v = e.target.value === 'production' ? 'production' : 'demo';
              setMode(v);
              persist({ selfCheckoutMode: v });
            }}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
          >
            <option value="demo">Demo only - mocked payment, no real order</option>
            <option value="production">Production - fail closed until integrations are ready</option>
          </select>
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
            <Languages size={16} className="text-slate-500" />
            Default language
          </label>
          <select
            value={language}
            onChange={(e) => {
              const v = e.target.value as ScLang;
              setLanguage(v);
              persist({ selfCheckoutLanguage: v });
            }}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
          >
            <option value="pl">Polski (PL)</option>
            <option value="en">English (EN)</option>
            <option value="vi">Tiếng Việt (VI)</option>
          </select>
          <p className="text-xs text-slate-500 mt-1">
            Customer language changes are session-only; this value is only the launch default.
          </p>
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
            <Coins size={16} className="text-slate-500" />
            Bag fee (PLN)
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={bagFee}
            onChange={(e) => {
              const v = parseFloat(e.target.value) || 0;
              setBagFee(v);
              persist({ selfCheckoutBagFeeAmount: v });
            }}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
          />
          <p className="text-xs text-slate-500 mt-1">
            This is added as a separate cart line only when the customer chooses a bag in summary.
          </p>
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
            <Monitor size={16} className="text-slate-500" />
            Display monitor
          </label>
          <select
            value={monitor}
            onChange={(e) => {
              const v = parseInt(e.target.value);
              setMonitor(v);
              persist({ selfCheckoutMonitor: v });
            }}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
          >
            {displays.length > 0 ? (
              displays.map((d) => (
                <option key={d.index} value={d.index}>
                  {d.isPrimary ? 'Primary' : `Secondary ${d.index}`}
                  {' - '}{d.width}x{d.height}
                  {d.label && d.label !== `Display ${d.index + 1}` ? ` (${d.label})` : ''}
                </option>
              ))
            ) : (
              <>
                <option value={0}>Primary</option>
                <option value={1}>Secondary (1)</option>
                <option value={2}>Secondary (2)</option>
              </>
            )}
          </select>
          <p className="text-xs text-slate-500 mt-1">
            Pick the screen the kiosk fullscreens on. Use a customer-facing display if available.
          </p>
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
            <Clock size={16} className="text-slate-500" />
            Idle timeout
          </label>
          <select
            value={idleTimeoutMs}
            onChange={(e) => {
              const v = parseInt(e.target.value);
              setIdleTimeoutMs(v);
              persist({ selfCheckoutIdleTimeoutMs: v });
            }}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
          >
            <option value={60000}>1 min</option>
            <option value={90000}>1.5 min</option>
            <option value={120000}>2 min</option>
            <option value={300000}>5 min</option>
          </select>
          <p className="text-xs text-slate-500 mt-1">
            Cart auto-resets after this delay with no touch, keyboard, or scanner input.
          </p>
        </div>

        {justSaved && (
          <div className="text-xs text-emerald-600 text-center">Saved</div>
        )}
      </div>
    </div>
  );
}
