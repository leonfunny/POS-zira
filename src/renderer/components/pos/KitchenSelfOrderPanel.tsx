import React, { useEffect, useRef, useState } from 'react';
import {
  ChefHat,
  Languages,
  ListFilter,
  Maximize,
  Monitor,
  Printer,
  Utensils,
  Volume2,
} from 'lucide-react';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useConfig } from '../../hooks/useConfig';
import {
  KitchenSelfOrderMenuSource,
  resolveKitchenSelfOrderMenuSource,
} from '../../../shared/kitchen-self-order';
import KitchenPrintSettings from './KitchenPrintSettings';
import rlog from '../../utils/logger';

type ScLang = 'pl' | 'en' | 'vi';
type KitchenFulfillment = 'DINE_IN' | 'TAKEAWAY';
type KitchenSlipPrinterType = 'RECEIPT' | 'LABEL';

interface DisplayInfo {
  index: number;
  width: number;
  height: number;
  isPrimary: boolean;
  label?: string;
}

interface KitchenCategoryRow {
  kitchen_print?: number | null;
}

interface KitchenSelfOrderPanelProps {
  language: Language;
  onSaved?: () => void;
}

function getKitchenSelfOrderCopy(language: Language) {
  if (language === 'vi') {
    return {
      badge: 'Kiosk don bep',
      title: 'Kitchen Self-Order',
      desc: 'Flow rieng cho kiosk bep: khach chon mon, POS1 in phieu bep, kiosk hien so don.',
      launch: 'Mo kiosk dat mon',
      opening: 'Dang mo...',
      defaultLanguage: 'Ngon ngu mac dinh',
      monitor: 'Man hinh',
      fulfillment: 'Mac dinh an tai quan/mang di',
      dineIn: 'Na miejscu',
      takeaway: 'Na wynos',
      slipPrinter: 'May in slip kiosk',
      receipt: 'Receipt',
      label: 'Label',
      isolated: 'Tach khoi self-checkout store',
      voiceLabel: 'Doc so don bang giong noi',
      menuSource: 'Nguon menu',
      menuSourceAll: 'Tat ca danh muc',
      menuSourceSelected: 'Chi danh muc in don bep',
    };
  }
  if (language === 'pl') {
    return {
      badge: 'Kiosk kuchenny',
      title: 'Kitchen Self-Order',
      desc: 'Oddzielny flow dla kiosku kuchennego: klient wybiera dania, POS1 drukuje bon kuchenny, kiosk pokazuje numer.',
      launch: 'Otworz kiosk zamowien',
      opening: 'Otwieranie...',
      defaultLanguage: 'Domyslny jezyk',
      monitor: 'Monitor',
      fulfillment: 'Domyslnie na miejscu/na wynos',
      dineIn: 'Na miejscu',
      takeaway: 'Na wynos',
      slipPrinter: 'Drukarka slip kiosku',
      receipt: 'Receipt',
      label: 'Label',
      isolated: 'Oddzielone od self-checkout sklepu',
      voiceLabel: 'Odczytaj numer zamowienia glosowo',
      menuSource: 'Zrodlo menu',
      menuSourceAll: 'Wszystkie kategorie',
      menuSourceSelected: 'Tylko kategorie z bonem kuchennym',
    };
  }
  return {
    badge: 'Kitchen kiosk',
    title: 'Kitchen Self-Order',
    desc: 'Separate kitchen-kiosk flow: customer picks food, POS1 prints the kitchen ticket, the kiosk shows the order number.',
    launch: 'Open food-order kiosk',
    opening: 'Opening...',
    defaultLanguage: 'Food kiosk language',
    monitor: 'Customer-facing screen',
    fulfillment: 'Default dine-in/takeaway',
    dineIn: 'Dine in',
    takeaway: 'Takeaway',
    slipPrinter: 'Kiosk slip printer',
    receipt: 'Receipt',
    label: 'Label',
    isolated: 'Separate from store self-checkout',
    voiceLabel: 'Speak the order number',
    menuSource: 'Menu source',
    menuSourceAll: 'All categories',
    menuSourceSelected: 'Only kitchen-print categories',
  };
}

export default function KitchenSelfOrderPanel({
  language: uiLanguage,
  onSaved,
}: KitchenSelfOrderPanelProps) {
  const { config, saveConfig } = useConfig();
  const { t } = useTranslation(uiLanguage);
  const kitchenCopy = getKitchenSelfOrderCopy(uiLanguage);
  const menuSourceTouchedRef = useRef(false);

  const [kitchenLanguage, setKitchenLanguage] = useState<ScLang>('pl');
  const [kitchenMonitor, setKitchenMonitor] = useState<number>(0);
  const [kitchenFulfillment, setKitchenFulfillment] = useState<KitchenFulfillment>('DINE_IN');
  const [kitchenSlipPrinterType, setKitchenSlipPrinterType] = useState<KitchenSlipPrinterType>('RECEIPT');
  const [kitchenVoiceEnabled, setKitchenVoiceEnabled] = useState<boolean>(true);
  const [menuSource, setMenuSource] = useState<KitchenSelfOrderMenuSource | null>(null);
  const [categories, setCategories] = useState<KitchenCategoryRow[]>([]);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  const [categoryLoadError, setCategoryLoadError] = useState<string | null>(null);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [kitchenOpening, setKitchenOpening] = useState(false);

  useEffect(() => {
    if (!config) return;
    const c = config as any;
    setKitchenLanguage((c.kitchenSelfOrderLanguage as ScLang) ?? 'pl');
    setKitchenMonitor(typeof c.kitchenSelfOrderMonitor === 'number' ? c.kitchenSelfOrderMonitor : 0);
    setKitchenFulfillment(c.kitchenSelfOrderDefaultFulfillment === 'TAKEAWAY' ? 'TAKEAWAY' : 'DINE_IN');
    setKitchenSlipPrinterType(c.kitchenSelfOrderSlipPrinterType === 'LABEL' ? 'LABEL' : 'RECEIPT');
    setKitchenVoiceEnabled(c.kitchenSelfOrderVoiceEnabled !== false);
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setCategoryLoadError(null);
      try {
        const rows = (await window.electronAPI.pos.categories.getAll()) as KitchenCategoryRow[];
        if (cancelled) return;
        setCategories(Array.isArray(rows) ? rows : []);
        setCategoriesLoaded(true);
      } catch (err: any) {
        if (cancelled) return;
        setCategoryLoadError(err?.message || 'Failed to load categories');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!config || menuSourceTouchedRef.current) return;
    const c = config as any;
    if (c.kitchenSelfOrderMenuSource === 'all' || c.kitchenSelfOrderMenuSource === 'selected') {
      setMenuSource(c.kitchenSelfOrderMenuSource);
      return;
    }
    if (categoriesLoaded) {
      setMenuSource(resolveKitchenSelfOrderMenuSource(c, categories));
    }
  }, [config, categories, categoriesLoaded]);

  const persist = async (patch: Record<string, any>) => {
    try {
      await saveConfig(patch);
      onSaved?.();
    } catch (err) {
      rlog.error('[KitchenSelfOrderPanel] saveConfig failed:', err);
    }
  };

  const openKitchenSelfOrder = async () => {
    if (!menuSource) {
      alert(categoryLoadError || 'Kitchen menu source is still resolving.');
      return;
    }

    setKitchenOpening(true);
    try {
      await persist({
        kitchenSelfOrderEnabled: true,
        kitchenSelfOrderLanguage: kitchenLanguage,
        kitchenSelfOrderMonitor: kitchenMonitor,
        kitchenSelfOrderDefaultFulfillment: kitchenFulfillment,
        kitchenSelfOrderSlipPrinterType: kitchenSlipPrinterType,
        kitchenSelfOrderVoiceEnabled: kitchenVoiceEnabled,
        kitchenSelfOrderMenuSource: menuSource,
      });
      const result = await window.electronAPI.window.open('kitchenSelfOrder');
      if (!result?.success) {
        rlog.error('[KitchenSelfOrderPanel] Failed to open kitchen self-order:', result?.error);
        alert(`${t('selfCheckout.openError')}: ${result?.error || t('selfCheckout.unknownError')}`);
      }
    } catch (err: any) {
      rlog.error('[KitchenSelfOrderPanel] openKitchenSelfOrder failed:', err);
      alert(`${t('selfCheckout.openError')}: ${err?.message || err}`);
    } finally {
      setKitchenOpening(false);
    }
  };

  const menuSourceReady = menuSource !== null;

  return (
    <>
      <section className="panel p-5">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.12em] text-emerald-700">
            <ChefHat size={14} />
            {kitchenCopy.badge}
          </div>
          <h2 className="flex items-center gap-2 text-xl font-black text-[var(--ink)]">
            <Utensils size={22} className="text-[var(--primary-deep)]" />
            {kitchenCopy.title}
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--ink-muted)]">
            {kitchenCopy.desc}
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold uppercase tracking-[0.1em] text-slate-700">
          {kitchenCopy.isolated}
        </span>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid gap-4 lg:grid-cols-2">
          <SettingField
            icon={<Languages size={17} />}
            label={kitchenCopy.defaultLanguage}
            help={t('selfCheckout.defaultLanguageHelp')}
          >
            <select
              value={kitchenLanguage}
              onChange={(e) => {
                const v = e.target.value as ScLang;
                setKitchenLanguage(v);
                persist({ kitchenSelfOrderLanguage: v });
              }}
              className="h-11 w-full rounded-lg border border-[var(--sand-300)] bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
            >
              <option value="pl">Polski (PL)</option>
              <option value="en">English (EN)</option>
              <option value="vi">Tieng Viet (VI)</option>
            </select>
          </SettingField>

          <SettingField
            icon={<Monitor size={17} />}
            label={kitchenCopy.monitor}
            help={t('selfCheckout.displayMonitorHelp')}
          >
            <select
              value={kitchenMonitor}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                setKitchenMonitor(v);
                persist({ kitchenSelfOrderMonitor: v });
              }}
              className="h-11 w-full rounded-lg border border-[var(--sand-300)] bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
            >
              {displays.length > 0 ? (
                displays.map((d) => (
                  <option key={d.index} value={d.index}>
                    {d.isPrimary ? t('selfCheckout.monitor.primary') : `${t('selfCheckout.monitor.secondary')} ${d.index}`}
                    {' - '}{d.width}x{d.height}
                  </option>
                ))
              ) : (
                <>
                  <option value={0}>{t('selfCheckout.monitor.primary')}</option>
                  <option value={1}>{t('selfCheckout.monitor.secondary')} (1)</option>
                </>
              )}
            </select>
          </SettingField>

          <SettingField
            icon={<Utensils size={17} />}
            label={kitchenCopy.fulfillment}
            help="Customer can still change before submit."
          >
            <select
              value={kitchenFulfillment}
              onChange={(e) => {
                const v = e.target.value === 'TAKEAWAY' ? 'TAKEAWAY' : 'DINE_IN';
                setKitchenFulfillment(v);
                persist({ kitchenSelfOrderDefaultFulfillment: v });
              }}
              className="h-11 w-full rounded-lg border border-[var(--sand-300)] bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
            >
              <option value="DINE_IN">{kitchenCopy.dineIn}</option>
              <option value="TAKEAWAY">{kitchenCopy.takeaway}</option>
            </select>
          </SettingField>

          <SettingField
            icon={<Printer size={17} />}
            label={kitchenCopy.slipPrinter}
            help="Best-effort local print on the kiosk."
          >
            <select
              value={kitchenSlipPrinterType}
              onChange={(e) => {
                const v = e.target.value === 'LABEL' ? 'LABEL' : 'RECEIPT';
                setKitchenSlipPrinterType(v);
                persist({ kitchenSelfOrderSlipPrinterType: v });
              }}
              className="h-11 w-full rounded-lg border border-[var(--sand-300)] bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
            >
              <option value="RECEIPT">{kitchenCopy.receipt}</option>
              <option value="LABEL">{kitchenCopy.label}</option>
            </select>
          </SettingField>

          <SettingField
            icon={<Volume2 size={17} />}
            label={kitchenCopy.voiceLabel}
            help="Polish voice reads the pickup number once on the done screen."
          >
            <select
              value={kitchenVoiceEnabled ? 'on' : 'off'}
              onChange={(e) => {
                const v = e.target.value === 'on';
                setKitchenVoiceEnabled(v);
                persist({ kitchenSelfOrderVoiceEnabled: v });
              }}
              className="h-11 w-full rounded-lg border border-[var(--sand-300)] bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
            >
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </SettingField>

          <SettingField
            icon={<ListFilter size={17} />}
            label={kitchenCopy.menuSource}
            help="all = every category (restaurant); selected = only kitchen_print categories (hybrid)."
          >
            <select
              value={menuSource ?? 'all'}
              disabled={!menuSourceReady}
              onChange={(e) => {
                const v: KitchenSelfOrderMenuSource = e.target.value === 'selected' ? 'selected' : 'all';
                menuSourceTouchedRef.current = true;
                setMenuSource(v);
                persist({ kitchenSelfOrderMenuSource: v });
              }}
              className="h-11 w-full rounded-lg border border-[var(--sand-300)] bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]/30 disabled:bg-slate-50 disabled:text-slate-400"
            >
              <option value="all">{kitchenCopy.menuSourceAll}</option>
              <option value="selected">{kitchenCopy.menuSourceSelected}</option>
            </select>
            {categoryLoadError && (
              <span className="mt-2 block text-xs font-semibold text-red-700">
                {categoryLoadError}
              </span>
            )}
          </SettingField>

        </div>

        <button
          type="button"
          onClick={openKitchenSelfOrder}
          disabled={kitchenOpening || !menuSourceReady}
          className="flex min-h-[148px] w-full items-center justify-center gap-3 rounded-2xl bg-emerald-700 px-6 text-xl font-black text-white shadow-[0_16px_38px_rgba(21,128,61,0.20)] transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Maximize size={24} />
          {kitchenOpening ? kitchenCopy.opening : kitchenCopy.launch}
        </button>
      </div>
      </section>
      <KitchenPrintSettings lang={config?.posLanguage || config?.language || undefined} />
    </>
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
