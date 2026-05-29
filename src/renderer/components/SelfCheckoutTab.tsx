import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
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
import { Language } from '../i18n/translations';
import { useTranslation } from '../i18n/useTranslation';
import {
  SelfCheckoutMode,
  SelfCheckoutProfile,
  resolveSelfCheckoutProfile,
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

const PRODUCTION_BLOCKER_KEYS = [
  'selfCheckout.blocker.paymentTerminal',
  'selfCheckout.blocker.fiscalPrinter',
  'selfCheckout.blocker.orderCreation',
];

interface SelfCheckoutTabProps {
  language: Language;
}

export default function SelfCheckoutTab({ language: uiLanguage }: SelfCheckoutTabProps) {
  const { config, saveConfig } = useConfig();
  const { t } = useTranslation(uiLanguage);

  const [kioskLanguage, setKioskLanguage] = useState<ScLang>('pl');
  const [mode, setMode] = useState<SelfCheckoutMode>('demo');
  const [profile, setProfile] = useState<SelfCheckoutProfile>('retail_scan');
  const [monitor, setMonitor] = useState<number>(0);
  const [idleTimeoutMs, setIdleTimeoutMs] = useState<number>(90000);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [opening, setOpening] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!config) return;
    const c = config as any;
    setKioskLanguage((c.selfCheckoutLanguage as ScLang) ?? 'pl');
    setMode(c.selfCheckoutMode === 'production' ? 'production' : 'demo');
    setProfile(resolveSelfCheckoutProfile(c.selfCheckoutProfile));
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
  const isProductionReady = mode === 'production' && !isProductionBlocked;
  const modeLabel = mode === 'demo'
    ? t('selfCheckout.mode.demo')
    : t('selfCheckout.mode.production');
  const paymentRuntimeState = runtime.paymentProfile === 'assistedDemo'
    ? t('selfCheckout.demoOnly')
    : runtime.paymentProfile === 'assistedProduction' || runtime.paymentProfile === 'terminalProduction'
      ? t('selfCheckout.mode.production')
      : t('selfCheckout.blocked');
  const paymentRuntimeBlocked = runtime.paymentProfile === 'unavailable';
  const productionDependencyState = mode === 'demo'
    ? t('selfCheckout.skipped')
    : isProductionBlocked
      ? t('selfCheckout.blocked')
      : t('selfCheckout.mode.production');

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
        selfCheckoutProfile: profile,
        selfCheckoutLanguage: kioskLanguage,
        selfCheckoutMonitor: monitor,
        selfCheckoutIdleTimeoutMs: idleTimeoutMs,
      });
      const result = await window.electronAPI.window.open('selfCheckout');
      if (!result?.success) {
        rlog.error('[SelfCheckoutTab] Failed to open kiosk:', result?.error);
        alert(`${t('selfCheckout.openError')}: ${result?.error || t('selfCheckout.unknownError')}`);
      }
    } catch (err: any) {
      rlog.error('[SelfCheckoutTab] openKiosk failed:', err);
      alert(`${t('selfCheckout.openError')}: ${err?.message || err}`);
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
            {t('selfCheckout.badge')}
          </div>
          <h1 className="text-3xl font-black tracking-tight text-[var(--ink)]">
            {t('selfCheckout.title')}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--ink-muted)]">
            {isProductionBlocked
              ? t('selfCheckout.productionClosedDesc')
              : mode === 'demo'
                ? t('selfCheckout.demoAvailableDesc')
                : t('selfCheckout.launchDesc')}
          </p>
        </div>
        {justSaved && (
          <div className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
            {t('selfCheckout.saved')}
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
              {isProductionBlocked
                ? t('selfCheckout.productionClosed')
                : mode === 'demo'
                  ? t('selfCheckout.demoAvailable')
                  : t('selfCheckout.mode.production')}
            </h2>
            <p className="mt-1 text-sm leading-6 text-[var(--ink-muted)]">
              {isProductionBlocked
                ? t('selfCheckout.productionClosedDesc')
                : mode === 'demo'
                  ? t('selfCheckout.demoAvailableDesc')
                  : t('selfCheckout.launchDesc')}
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
                {t('selfCheckout.launch')}
              </h2>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">
                {t('selfCheckout.launchDesc')}
              </p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.1em] ${
              mode === 'demo'
                ? 'bg-amber-100 text-amber-800'
                : 'bg-slate-100 text-slate-700'
            }`}>
              {modeLabel}
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
              ? t('selfCheckout.opening')
              : mode === 'demo'
                ? t('selfCheckout.openDemo')
                : isProductionBlocked
                  ? t('selfCheckout.openProductionClosed')
                  : t('selfCheckout.launch')}
          </button>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <RuntimePill
              label={t('selfCheckout.payment')}
              state={paymentRuntimeState}
              blocked={paymentRuntimeBlocked}
            />
            <RuntimePill
              label={t('selfCheckout.fiscalPrint')}
              state={productionDependencyState}
              blocked={isProductionBlocked}
            />
            <RuntimePill
              label={t('selfCheckout.orderCreate')}
              state={productionDependencyState}
              blocked={isProductionBlocked}
            />
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="flex items-center gap-2 text-lg font-black text-[var(--ink)]">
            <ShieldAlert size={20} className={isProductionBlocked ? 'text-amber-600' : 'text-emerald-600'} />
            {t('selfCheckout.productionReadiness')}
          </h2>
          <div className="mt-4 space-y-2">
            {isProductionBlocked ? (
              runtime.unavailableReasons.map((reason, index) => (
                <div key={reason} className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-3 text-sm font-semibold text-amber-900">
                  <XCircle size={17} className="mt-0.5 shrink-0" />
                  <span>{PRODUCTION_BLOCKER_KEYS[index] ? t(PRODUCTION_BLOCKER_KEYS[index]) : reason}</span>
                </div>
              ))
            ) : (
              <div className="flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-3 text-sm font-semibold text-emerald-800">
                <CheckCircle2 size={17} className="mt-0.5 shrink-0" />
                <span>{isProductionReady ? t('selfCheckout.launchDesc') : t('selfCheckout.demoReady')}</span>
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="panel p-5">
        <div className="mb-5 flex items-center gap-2">
          <Settings size={20} className="text-[var(--primary-deep)]" />
          <div>
            <h2 className="text-lg font-black text-[var(--ink)]">{t('selfCheckout.settings')}</h2>
            <p className="text-sm text-[var(--ink-muted)]">
              {t('selfCheckout.settingsDesc')}
            </p>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <SettingField
            icon={<ScanBarcode size={17} />}
            label={t('selfCheckout.profile')}
            help={t('selfCheckout.profileHelp')}
          >
            <select
              value={profile}
              onChange={(e) => {
                const v = resolveSelfCheckoutProfile(e.target.value);
                setProfile(v);
                persist({ selfCheckoutProfile: v });
              }}
              className="h-11 w-full rounded-lg border border-[var(--sand-300)] bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
            >
              <option value="retail_scan">{t('selfCheckout.profile.retailScan')}</option>
              <option value="menu_kitchen">{t('selfCheckout.profile.menuKitchen')}</option>
            </select>
          </SettingField>

          <SettingField
            icon={<AlertTriangle size={17} />}
            label={t('selfCheckout.runtimeMode')}
            help={isProductionReady ? t('selfCheckout.launchDesc') : t('selfCheckout.runtimeModeHelp')}
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
              <option value="demo">{t('selfCheckout.option.demo')}</option>
              <option value="production">{t('selfCheckout.mode.production')}</option>
            </select>
          </SettingField>

          <SettingField
            icon={<Languages size={17} />}
            label={t('selfCheckout.defaultLanguage')}
            help={t('selfCheckout.defaultLanguageHelp')}
          >
            <select
              value={kioskLanguage}
              onChange={(e) => {
                const v = e.target.value as ScLang;
                setKioskLanguage(v);
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
            icon={<Monitor size={17} />}
            label={t('selfCheckout.displayMonitor')}
            help={t('selfCheckout.displayMonitorHelp')}
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
                    {d.isPrimary ? t('selfCheckout.monitor.primary') : `${t('selfCheckout.monitor.secondary')} ${d.index}`}
                    {' - '}{d.width}x{d.height}
                    {d.label && d.label !== `Display ${d.index + 1}` ? ` (${d.label})` : ''}
                  </option>
                ))
              ) : (
                <>
                  <option value={0}>{t('selfCheckout.monitor.primary')}</option>
                  <option value={1}>{t('selfCheckout.monitor.secondary')} (1)</option>
                  <option value={2}>{t('selfCheckout.monitor.secondary')} (2)</option>
                </>
              )}
            </select>
          </SettingField>

          <SettingField
            icon={<Clock size={17} />}
            label={t('selfCheckout.idleTimeout')}
            help={t('selfCheckout.idleTimeoutHelp')}
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
              <option value={60000}>{t('selfCheckout.timeout.1m')}</option>
              <option value={90000}>{t('selfCheckout.timeout.1_5m')}</option>
              <option value={120000}>{t('selfCheckout.timeout.2m')}</option>
              <option value={300000}>{t('selfCheckout.timeout.5m')}</option>
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
