import { useCallback, useEffect, useState } from 'react';
import type { AgentConfig } from '../../shared/types';
import type { Language } from '../i18n/translations';
import { ANDROID_POS_LANGUAGES, normalizeAndroidPosLanguage } from './shim/config-store';

type AndroidPosMode = 'salon' | 'retail';

const SETTINGS_LANGUAGE_LABELS: Record<Language, string> = {
  en: 'English',
  vi: 'Tiếng Việt',
  tr: 'Türkçe',
  zh: '中文',
  uk: 'Українська',
  ru: 'Русский',
  pl: 'Polski',
};

function normalizePosMode(value: unknown): AndroidPosMode {
  return value === 'retail' ? 'retail' : 'salon';
}

function resolveOnlineLabel(online: boolean): string {
  return online ? 'Đang trực tuyến' : 'Ngoại tuyến';
}

async function readAppVersion(): Promise<string> {
  const plugin = (globalThis as any)?.Capacitor?.Plugins?.AppUpdater;
  if (!plugin?.getInfo) return 'Không xác định';
  try {
    const info = await plugin.getInfo();
    const version = String(info?.versionName || info?.version || '').trim();
    return version || 'Không xác định';
  } catch {
    return 'Không xác định';
  }
}

export default function SettingsScreen() {
  const [loading, setLoading] = useState(true);
  const [onlineState, setOnlineState] = useState(false);
  const [appVersion, setAppVersion] = useState('Không xác định');
  const [posMode, setPosMode] = useState<AndroidPosMode>('salon');
  const [posLanguage, setPosLanguage] = useState<Language>('pl');
  const [allowOversell, setAllowOversell] = useState(false);
  const [showNonFiscalOrders, setShowNonFiscalOrders] = useState(true);
  const [machineId, setMachineId] = useState('Không xác định');
  const [agentId, setAgentId] = useState('Không xác định');
  const [salonName, setSalonName] = useState('Không xác định');
  const [salonCode, setSalonCode] = useState('Không xác định');

  const applyConfig = useCallback((config: AgentConfig | null | undefined) => {
    if (!config) return;
    setPosMode(normalizePosMode(config.posMode));
    setPosLanguage(normalizeAndroidPosLanguage(config.posLanguage));
    setAllowOversell(config.allowOversell === true);
    setShowNonFiscalOrders(config.showNonFiscalOrders !== false);
    setMachineId(String(config.machineId || '').trim() || 'Không xác định');
    setAgentId(String(config.agentId || '').trim() || 'Không xác định');
    setSalonName(String(config.salonName || '').trim() || 'Không xác định');
    setSalonCode(String((config as any).salonCode || '').trim() || 'Không xác định');
  }, []);

  const syncConfig = useCallback(async (patch: Partial<AgentConfig>) => {
    const updated = await (window as any).electronAPI.setConfig(patch);
    applyConfig(updated);
  }, [applyConfig]);

  useEffect(() => {
    let cancelled = false;
    setOnlineState(window.navigator.onLine);

    const onOnline = () => setOnlineState(true);
    const onOffline = () => setOnlineState(false);

    const refresh = async () => {
      const api = (window as any).electronAPI;
      const config = await api.getConfig();
      if (cancelled) return;
      applyConfig(config);
      setLoading(false);
      const version = await readAppVersion();
      if (!cancelled) setAppVersion(version);
    };

    void refresh();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    }
  }, [applyConfig]);

  return (
    <div className="h-full min-h-0 p-3 bg-slate-100 overflow-hidden">
      <div className="h-full overflow-y-auto grid gap-3">
        <section className="bg-white rounded-lg border border-slate-200 p-3">
          <h2 className="text-sm font-bold text-slate-700">Chế độ bán</h2>
          <div className="mt-2 grid gap-2">
            <label className="inline-flex items-center">
              <input
                data-testid="settings-pos-mode-salon"
                type="radio"
                name="zira-pos-mode"
                checked={posMode === 'salon'}
                onChange={() => { void syncConfig({ posMode: 'salon' }); }}
              />
              <span className="ml-2 text-sm">Salon</span>
            </label>
            <label className="inline-flex items-center">
              <input
                data-testid="settings-pos-mode-retail"
                type="radio"
                name="zira-pos-mode"
                checked={posMode === 'retail'}
                onChange={() => { void syncConfig({ posMode: 'retail' }); }}
              />
              <span className="ml-2 text-sm">Retail</span>
            </label>
          </div>
        </section>

        <section className="bg-white rounded-lg border border-slate-200 p-3">
          <h2 className="text-sm font-bold text-slate-700">Ngôn ngữ</h2>
          <label className="mt-2 block">
            <span className="text-sm text-slate-600">POS language</span>
            <select
              data-testid="settings-pos-language"
              className="mt-2 w-full rounded border border-slate-300 px-2 py-1.5"
              value={posLanguage}
              onChange={(event) => { void syncConfig({ posLanguage: event.target.value as Language }); }}
              disabled={loading}
            >
              {ANDROID_POS_LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {SETTINGS_LANGUAGE_LABELS[language]}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="bg-white rounded-lg border border-slate-200 p-3">
          <h2 className="text-sm font-bold text-slate-700">Bán hàng</h2>
          <div className="mt-2 grid gap-2">
            <label className="inline-flex items-center">
              <input
                data-testid="settings-allow-oversell"
                type="checkbox"
                checked={allowOversell}
                onChange={(event) => { void syncConfig({ allowOversell: event.target.checked }); }}
              />
              <span className="ml-2 text-sm">Cho phép bán quá tồn kho (Oversell)</span>
            </label>
            <label className="inline-flex items-center">
              <input
                data-testid="settings-show-non-fiscal-orders"
                type="checkbox"
                checked={showNonFiscalOrders}
                onChange={(event) => { void syncConfig({ showNonFiscalOrders: event.target.checked }); }}
              />
              <span className="ml-2 text-sm">Hiển thị đơn không hóa đơn tài chính</span>
            </label>
          </div>
        </section>

        <section className="bg-white rounded-lg border border-slate-200 p-3">
          <h2 className="text-sm font-bold text-slate-700">Thông tin máy</h2>
          <div className="mt-2 grid gap-1.5 text-sm">
            <p><span className="font-semibold">Phiên bản app:</span> {appVersion}</p>
            <p><span className="font-semibold">Mã máy:</span> {machineId}</p>
            <p><span className="font-semibold">ID thiết bị:</span> {agentId}</p>
            <p><span className="font-semibold">Tên salon:</span> {salonName}</p>
            <p><span className="font-semibold">Mã salon:</span> {salonCode}</p>
            <p><span className="font-semibold">Trạng thái mạng:</span> {resolveOnlineLabel(onlineState)}</p>
          </div>
        </section>
      </div>
    </div>
  );
}
