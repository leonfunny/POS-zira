import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Coins,
  Languages,
  Maximize,
  Monitor,
  Power,
  ScanBarcode,
  Settings,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { useConfig } from '../hooks/useConfig';
import {
  SelfCheckoutMode,
  resolveSelfCheckoutRuntime,
} from '../windows/self-checkout/self-checkout-model';
import rlog from '../utils/logger';

type ScLang = 'pl' | 'en' | 'vi';

interface DisplayInfo {
  index: number;
  width: number;
  height: number;
  isPrimary: boolean;
  label?: string;
}

export default function SelfCheckoutTab() {
  const { config, saveConfig } = useConfig();

  const [language, setLanguage] = useState<ScLang>('pl');
  const [mode, setMode] = useState<SelfCheckoutMode>('demo');
  const [bagFee, setBagFee] = useState<number>(0.20);
  const [monitor, setMonitor] = useState<number>(0);
  const [idleTimeoutMs, setIdleTimeoutMs] = useState<number>(90000);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
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

  const justSaved = Boolean(savedAt && Date.now() - savedAt < 2000);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex items-start justify-between gap-6">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-[var(--sand-200)] bg-white px-3 py-1 text-xs font-bold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
            <ScanBarcode size={14} className="text-[var(--primary-deep)]" />
            POS kiosk control
          </div>
          <h1 className="text-3xl font-black tracking-tight text-[var(--ink)]">
            Self-Checkout Kiosk
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--ink-muted)]">
            Operator control for the customer-facing kiosk. Demo can be opened;
            production intentionally fails closed until payment, fiscal, and order paths are real.
          </p>
        </div>
        {justSaved && (
          <div className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
            Saved
          </div>
        )}
      </header>

      <section
        className={`rounded-2xl border p-5 ${
          isProductionBlocked
            ? 'border-amber-200 bg-amber-50'
            : 'border-emerald-200 bg-emerald-50'
        }`}
      >
        <div className="flex items-start gap-4">
          <div
            className={`flex h-12 w-12 items-center justify-center rounded-2xl ${
              isProductionBlocked
                ? 'bg-amber-100 text-amber-700'
                : 'bg-emerald-100 text-emerald-700'
            }`}
          >
            {isProductionBlocked ? <AlertTriangle size={24} /> : <CheckCircle2 size={24} />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-black text-[var(--ink)]">
              {mode === 'demo' ? 'Demo kiosk is available' : 'Production kiosk opens closed'}
            </h2>
            <p className="mt-1 text-sm leading-6 text-[var(--ink-muted)]">
              {mode === 'demo'
                ? 'Use this for UI flow, scanning, summary, payment simulation, and receipt state testing. It does not create a real sale.'
                : 'This is the correct behavior until the missing integrations are wired. Do not make production look sellable before it is real.'}
            </p>
          </div>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="panel p-5">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-black text-[var(--ink)]">
                <Power size={20} className="text-[var(--primary-deep)]" />
                Launch
              </h2>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">
                Opens the kiosk on the selected customer display.
              </p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.1em] ${
              mode === 'demo'
                ? 'bg-amber-100 text-amber-800'
                : 'bg-slate-100 text-slate-700'
            }`}>
              {mode}
            </span>
          </div>

          <button
            type="button"
            onClick={openKiosk}
            disabled={opening}
            className="flex min-h-[76px] w-full items-center justify-center gap-3 rounded-2xl bg-[var(--primary)] px-6 text-xl font-black text-white shadow-[0_16px_38px_rgba(169,83,58,0.22)] transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Maximize size={24} />
            {opening
              ? 'Opening kiosk...'
              : mode === 'demo'
                ? 'Open demo self-checkout'
                : 'Open closed production kiosk'}
          </button>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <RuntimePill
              label="Payment"
              state={mode === 'demo' ? 'Demo only' : 'Blocked'}
              blocked={mode === 'production'}
            />
            <RuntimePill
              label="Fiscal print"
              state={mode === 'demo' ? 'Skipped' : 'Blocked'}
              blocked={mode === 'production'}
            />
            <RuntimePill
              label="Order create"
              state={mode === 'demo' ? 'Skipped' : 'Blocked'}
              blocked={mode === 'production'}
            />
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="flex items-center gap-2 text-lg font-black text-[var(--ink)]">
            <ShieldAlert size={20} className={isProductionBlocked ? 'text-amber-600' : 'text-emerald-600'} />
            Production readiness
          </h2>
          <div className="mt-4 space-y-2">
            {isProductionBlocked ? (
              runtime.unavailableReasons.map((reason) => (
                <div key={reason} className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-3 text-sm font-semibold text-amber-900">
                  <XCircle size={17} className="mt-0.5 shrink-0" />
                  <span>{reason}</span>
                </div>
              ))
            ) : (
              <div className="flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-3 text-sm font-semibold text-emerald-800">
                <CheckCircle2 size={17} className="mt-0.5 shrink-0" />
                <span>Demo flow is available for UI and state testing.</span>
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="panel p-5">
        <div className="mb-5 flex items-center gap-2">
          <Settings size={20} className="text-[var(--primary-deep)]" />
          <div>
            <h2 className="text-lg font-black text-[var(--ink)]">Kiosk settings</h2>
            <p className="text-sm text-[var(--ink-muted)]">
              These settings save immediately and apply on next kiosk launch.
            </p>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <SettingField
            icon={<AlertTriangle size={17} />}
            label="Runtime mode"
            help="Production stays closed until real integrations are done."
          >
            <select
              value={mode}
              onChange={(e) => {
                const v = e.target.value === 'production' ? 'production' : 'demo';
                setMode(v);
                persist({ selfCheckoutMode: v });
              }}
              className="h-11 w-full rounded-lg border border-[var(--sand-300)] bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
            >
              <option value="demo">Demo only - mocked payment, no real order</option>
              <option value="production">Production - fail closed until integrations are ready</option>
            </select>
          </SettingField>

          <SettingField
            icon={<Languages size={17} />}
            label="Default language"
            help="Customer changes are session-only."
          >
            <select
              value={language}
              onChange={(e) => {
                const v = e.target.value as ScLang;
                setLanguage(v);
                persist({ selfCheckoutLanguage: v });
              }}
              className="h-11 w-full rounded-lg border border-[var(--sand-300)] bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
            >
              <option value="pl">Polski (PL)</option>
              <option value="en">English (EN)</option>
              <option value="vi">Tiếng Việt (VI)</option>
            </select>
          </SettingField>

          <SettingField
            icon={<Coins size={17} />}
            label="Bag fee (PLN)"
            help="Added only when the customer chooses a bag in summary."
          >
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
              className="h-11 w-full rounded-lg border border-[var(--sand-300)] bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
            />
          </SettingField>

          <SettingField
            icon={<Monitor size={17} />}
            label="Display monitor"
            help="Use a customer-facing display if available."
          >
            <select
              value={monitor}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                setMonitor(v);
                persist({ selfCheckoutMonitor: v });
              }}
              className="h-11 w-full rounded-lg border border-[var(--sand-300)] bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
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
          </SettingField>

          <SettingField
            icon={<Clock size={17} />}
            label="Idle timeout"
            help="Cart resets after no touch, keyboard, or scanner input."
          >
            <select
              value={idleTimeoutMs}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                setIdleTimeoutMs(v);
                persist({ selfCheckoutIdleTimeoutMs: v });
              }}
              className="h-11 w-full rounded-lg border border-[var(--sand-300)] bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
            >
              <option value={60000}>1 min</option>
              <option value={90000}>1.5 min</option>
              <option value={120000}>2 min</option>
              <option value={300000}>5 min</option>
            </select>
          </SettingField>
        </div>
      </section>
    </div>
  );
}

function RuntimePill({
  label,
  state,
  blocked,
}: {
  label: string;
  state: string;
  blocked: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--sand-200)] bg-white px-3 py-3">
      <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
        {label}
      </div>
      <div className={`mt-1 text-sm font-black ${blocked ? 'text-amber-700' : 'text-emerald-700'}`}>
        {state}
      </div>
    </div>
  );
}

function SettingField({
  icon,
  label,
  help,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block rounded-xl border border-[var(--sand-200)] bg-white p-4">
      <span className="mb-2 flex items-center gap-2 text-sm font-black text-[var(--ink)]">
        <span className="text-[var(--ink-muted)]">{icon}</span>
        {label}
      </span>
      {children}
      <span className="mt-2 block text-xs leading-5 text-[var(--ink-muted)]">
        {help}
      </span>
    </label>
  );
}
