import React, { useEffect, useState, useCallback, useRef } from 'react';
import CameraGrid from './CameraGrid';
import AlertsList from './AlertsList';
import CameraSettings from './CameraSettings';
import AnalyticsDashboard from './AnalyticsDashboard';
import type { AgentConfig, SecurityConfig, SecurityStatus, CameraConfig } from '../../../shared/types';
import { useTranslation } from '../../i18n/useTranslation';
import type { Language } from '../../i18n/translations';
import rlog from '../../utils/logger';

type SubView = 'cameras' | 'alerts' | 'analytics' | 'settings';

interface SecurityTabProps {
  config: AgentConfig | null;
}

const defaultSecurityConfig: SecurityConfig = {
  enabled: false,
  cameras: [],
  modelSize: 'yolov8n',
  cooldownSeconds: 300,
  snapshotOnAlert: true,
  clipOnAlert: true,
  clipDurationSeconds: 20,
  evidenceRetentionDays: 30,
  telegramAlertEnabled: false,
  telegramChatId: '',
  mjpegPort: 9090,
  analyticsEnabled: false,
  analyticsReportHour: 23,
  businessHoursStart: '09:00',
  businessHoursEnd: '21:00',
  businessDays: [1, 2, 3, 4, 5, 6],
};

export default function SecurityTab({ config }: SecurityTabProps) {
  const { t } = useTranslation((config?.language as Language) || 'en');
  const [subView, setSubView] = useState<SubView>('cameras');
  const [securityConfig, setSecurityConfig] = useState<SecurityConfig>(defaultSecurityConfig);
  const [globalDraft, setGlobalDraft] = useState<SecurityConfig>(defaultSecurityConfig);
  const [globalDirty, setGlobalDirty] = useState(false);
  const [operationPending, setOperationPending] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const operationLock = useRef(false);
  const [status, setStatus] = useState<SecurityStatus>({
    running: false,
    cameras: [],
    totalInferenceFps: 0,
    uptime: 0,
  });
  const [loading, setLoading] = useState(true);

  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Load config + status
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    const load = async () => {
      try {
        const [cfg, sts] = await Promise.all([
          window.electronAPI.security.getConfig(),
          window.electronAPI.security.getStatus(),
        ]);
        if (cancelled) return;
        if (!cfg || !sts) throw new Error('Security status unavailable');
        setSecurityConfig(cfg);
        setGlobalDraft(cfg);
        setGlobalDirty(false);
        setStatus(sts);
      } catch (err) {
        if (!cancelled) setLoadFailed(true);
        rlog.error('[SecurityTab] Load error:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [loadAttempt]);

  // Subscribe to status changes
  useEffect(() => {
    const unsub = window.electronAPI.security.onStatusChanged((s: any) => {
      setStatus(s);
    });
    return () => unsub();
  }, []);

  // Poll status every 5s while running
  useEffect(() => {
    if (!status.running) return;
    const interval = setInterval(async () => {
      try {
        const s = await window.electronAPI.security.getStatus();
        if (s) setStatus(s);
      } catch {}
    }, 5000);
    return () => clearInterval(interval);
  }, [status.running]);

  const runOperation = useCallback(async (operation: () => Promise<void>, failureKey: string) => {
    if (operationLock.current) return;
    operationLock.current = true;
    setOperationPending(true);
    setOperationError(null);
    try {
      await operation();
    } catch (error) {
      setOperationError(`${t(failureKey)}${error instanceof Error && error.message ? ` ${error.message}` : ''}`);
    } finally {
      operationLock.current = false;
      setOperationPending(false);
    }
  }, [t]);

  const handleStart = () => runOperation(async () => {
    const result = await window.electronAPI.security.start();
    if (!result?.success) throw new Error(result?.error || '');
    const next = await window.electronAPI.security.getStatus();
    if (!next?.running) throw new Error('');
    setStatus(next);
  }, 'security.startFailed');

  const handleStop = () => runOperation(async () => {
    const result = await window.electronAPI.security.stop();
    if (!result?.success) throw new Error(result?.error || '');
    setStatus(previous => ({ ...previous, running: false }));
  }, 'security.stopFailed');

  const handleSaveCameras = (cameras: CameraConfig[]) => runOperation(async () => {
    const updated = { ...securityConfig, cameras };
    const result = await window.electronAPI.security.setConfig(updated);
    if (!result?.success) throw new Error(result?.error || '');
    setSecurityConfig(updated);
  }, 'security.saveFailed');

  const updateGlobalDraft = (updates: Partial<SecurityConfig>) => {
    setGlobalDraft(previous => ({ ...previous, ...updates }));
    setGlobalDirty(true);
  };

  const handleSaveGlobalConfig = () => runOperation(async () => {
    // Camera edits have their own Save All action; never overwrite them with an older draft.
    const updated = { ...globalDraft, cameras: securityConfig.cameras };
    const result = await window.electronAPI.security.setConfig(updated);
    if (!result?.success) throw new Error(result?.error || '');
    setSecurityConfig(updated);
    setGlobalDraft(updated);
    setGlobalDirty(false);
  }, 'security.saveFailed');

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-600" />
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div role="alert" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <p>{t('security.loadFailed')}</p>
        <button type="button" className="min-h-11 rounded-lg border border-amber-700 px-4 font-semibold" onClick={() => setLoadAttempt(value => value + 1)}>
          {t('common.retry')}
        </button>
      </div>
    );
  }

  const onlineCameras = status.cameras.filter(c => c.connected).length;
  const totalCameras = securityConfig.cameras.length;

  const SUB_VIEWS: { key: SubView; labelKey: string }[] = [
    { key: 'cameras', labelKey: 'security.cameras' },
    { key: 'alerts', labelKey: 'security.alerts' },
    { key: 'analytics', labelKey: 'security.analytics' },
    { key: 'settings', labelKey: 'security.settings' },
  ];

  return (
    <div className="space-y-4">
      {operationError && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">{operationError}</p>}
      {operationPending && <p role="status" className="text-sm text-slate-600">{t('security.working')}</p>}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">{t('security.title')}</h2>
          <p className="text-xs text-slate-500">
            {totalCameras} {totalCameras !== 1 ? t('security.camerasCount') : t('security.cameraCount')}
            {status.running && (
              <> &middot; {onlineCameras} {t('security.online')} &middot; {status.totalInferenceFps} {t('security.fpsTotal')}</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status.running ? (
            <button
              disabled={operationPending}
              onClick={handleStop}
              aria-label={t('security.stop')}
              className="flex items-center gap-1.5 px-3 py-2 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors touch-manipulation"
            >
              <span>&#x23F9;</span> {t('security.stop')}
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={operationPending || totalCameras === 0}
              aria-label={t('security.start')}
              className="flex items-center gap-1.5 px-3 py-2 text-xs bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation"
            >
              <span>&#x25B6;</span> {t('security.start')}
            </button>
          )}
          <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${
            status.running ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${status.running ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            {status.running ? t('security.running') : t('security.stopped')}
          </span>
        </div>
      </div>

      {/* Sub-navigation */}
      <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
        {SUB_VIEWS.map(sv => (
          <button
            key={sv.key}
            onClick={() => setSubView(sv.key)}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              subView === sv.key
                ? 'bg-white text-slate-800 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {t(sv.labelKey)}
          </button>
        ))}
      </div>

      {/* Content */}
      {subView === 'cameras' && (
        <div className="space-y-4">
          <CameraGrid
            status={status}
            mjpegPort={securityConfig.mjpegPort || 9090}
            cameras={securityConfig.cameras.map(c => ({
              id: c.id,
              name: c.name,
              zone: c.zone,
            }))}
            t={t}
          />
          <AlertsList limit={5} t={t} />
        </div>
      )}

      {subView === 'alerts' && (
        <AlertsList limit={100} t={t} />
      )}

      {subView === 'analytics' && (
        <AnalyticsDashboard cameras={securityConfig.cameras} t={t} />
      )}

      {subView === 'settings' && (
        <fieldset disabled={operationPending} className="min-w-0 space-y-4">
          <CameraSettings
            cameras={securityConfig.cameras}
            onSave={handleSaveCameras}
            t={t}
          />

          {/* Global settings */}
          <form onSubmit={event => { event.preventDefault(); void handleSaveGlobalConfig(); }} className="border border-slate-200 rounded-lg p-3 space-y-3">
            <h3 className="text-sm font-medium text-slate-700">{t('security.globalSettings')}</h3>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 block mb-1">{t('security.yoloModel')}</label>
                <select
                  value={globalDraft.modelSize}
                  onChange={(e) => updateGlobalDraft({ modelSize: e.target.value })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                >
                  <option value="yolov8n">{t('security.yoloNano')}</option>
                  <option value="yolov8s">{t('security.yoloSmall')}</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1">{t('security.cooldown')}</label>
                <input
                  type="number"
                  value={globalDraft.cooldownSeconds}
                  onChange={(e) => updateGlobalDraft({ cooldownSeconds: Number(e.target.value) })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                  min={30} max={3600}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 block mb-1">{t('security.mjpegPort')}</label>
                <input
                  type="number"
                  value={globalDraft.mjpegPort}
                  onChange={(e) => updateGlobalDraft({ mjpegPort: Number(e.target.value) })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                  min={8000} max={65535}
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1">{t('security.evidenceRetention')}</label>
                <input
                  type="number"
                  value={globalDraft.evidenceRetentionDays}
                  onChange={(e) => updateGlobalDraft({ evidenceRetentionDays: Number(e.target.value) })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                  min={1} max={365}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 block mb-1">{t('security.businessHoursStart')}</label>
                <input
                  type="time"
                  value={globalDraft.businessHoursStart}
                  onChange={(e) => updateGlobalDraft({ businessHoursStart: e.target.value })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1">{t('security.businessHoursEnd')}</label>
                <input
                  type="time"
                  value={globalDraft.businessHoursEnd}
                  onChange={(e) => updateGlobalDraft({ businessHoursEnd: e.target.value })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={globalDraft.snapshotOnAlert}
                  onChange={(e) => updateGlobalDraft({ snapshotOnAlert: e.target.checked })}
                />
                {t('security.snapshotOnAlert')}
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={globalDraft.clipOnAlert}
                  onChange={(e) => updateGlobalDraft({ clipOnAlert: e.target.checked })}
                />
                {t('security.clipOnAlert')}
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={globalDraft.telegramAlertEnabled}
                  onChange={(e) => updateGlobalDraft({ telegramAlertEnabled: e.target.checked })}
                />
                {t('security.telegramAlerts')}
              </label>
            </div>

            {globalDraft.telegramAlertEnabled && (
              <div>
                <label className="text-xs text-slate-500 block mb-1">{t('security.telegramChatId')}</label>
                <input
                  type="text"
                  value={globalDraft.telegramChatId}
                  onChange={(e) => updateGlobalDraft({ telegramChatId: e.target.value })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                  placeholder={t('security.telegramChatIdPlaceholder')}
                />
              </div>
            )}
            <div className="flex items-center gap-3">
              <button type="submit" disabled={!globalDirty || operationPending} className="min-h-11 rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50">
                {t('common.save')}
              </button>
              <span role="status" className="text-sm text-slate-600">{t(globalDirty ? 'security.unsaved' : 'security.saved')}</span>
            </div>
          </form>
        </fieldset>
      )}
    </div>
  );
}
