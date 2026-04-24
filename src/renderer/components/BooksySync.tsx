import React, { useEffect, useState, useCallback } from 'react';
import { BooksySyncStatus, BooksySyncConfig, BooksyBookingSummary } from '../../shared/types';
import rlog from '../utils/logger';
import { useTranslation } from '../i18n/useTranslation';
import { useConfig } from '../hooks/useConfig';

export default function BooksySync() {
  const { config: appConfig } = useConfig();
  const language = appConfig?.language || 'en';
  const { t } = useTranslation(language);
  const [status, setStatus] = useState<BooksySyncStatus | null>(null);
  const [config, setConfig] = useState<BooksySyncConfig | null>(null);
  const [bookings, setBookings] = useState<BooksyBookingSummary[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncingCustomers, setSyncingCustomers] = useState(false);
  const [syncingStaff, setSyncingStaff] = useState(false);
  const [syncingResources, setSyncingResources] = useState(false);
  const [syncingServices, setSyncingServices] = useState(false);
  const [syncingAddons, setSyncingAddons] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [jwtExpiredVisible, setJwtExpiredVisible] = useState(false);

  useEffect(() => {
    const off = window.electronAPI.booksy.onBooksyJwtExpired(() => setJwtExpiredVisible(true));
    return off;
  }, []);

  useEffect(() => {
    Promise.all([
      window.electronAPI.booksy.getStatus(),
      window.electronAPI.booksy.getConfig(),
      window.electronAPI.booksy.getBookings(),
    ]).then(([s, c, b]) => {
      setStatus(s);
      setConfig(c);
      setBookings(b);
    }).catch((err) => {
      rlog.error('[BooksySync] Failed to load initial data:', err);
    });
  }, []);

  useEffect(() => {
    const unsub = window.electronAPI.booksy.onStatusChanged((s) => {
      setStatus(s);
      window.electronAPI.booksy.getBookings().then(setBookings);
    });
    return unsub;
  }, []);

  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await window.electronAPI.booksy.syncNow();
      const [s, b] = await Promise.all([
        window.electronAPI.booksy.getStatus(),
        window.electronAPI.booksy.getBookings(),
      ]);
      setStatus(s);
      setBookings(b);
    } finally {
      setSyncing(false);
    }
  }, []);

  const handleSyncCustomers = useCallback(async () => {
    setSyncingCustomers(true);
    try {
      await window.electronAPI.booksy.syncCustomers();
      const s = await window.electronAPI.booksy.getStatus();
      setStatus(s);
    } finally {
      setSyncingCustomers(false);
    }
  }, []);

  const handleSyncStaff = useCallback(async () => {
    setSyncingStaff(true);
    try {
      await window.electronAPI.booksy.syncStaff();
      const s = await window.electronAPI.booksy.getStatus();
      setStatus(s);
    } finally {
      setSyncingStaff(false);
    }
  }, []);

  const handleSyncResources = useCallback(async () => {
    setSyncingResources(true);
    try {
      await window.electronAPI.booksy.syncResources();
      const s = await window.electronAPI.booksy.getStatus();
      setStatus(s);
    } finally {
      setSyncingResources(false);
    }
  }, []);

  const handleSyncServices = useCallback(async () => {
    setSyncingServices(true);
    try {
      await window.electronAPI.booksy.syncServices();
      const s = await window.electronAPI.booksy.getStatus();
      setStatus(s);
    } finally {
      setSyncingServices(false);
    }
  }, []);

  const handleSyncAddons = useCallback(async () => {
    setSyncingAddons(true);
    try {
      await window.electronAPI.booksy.syncAddons();
      const s = await window.electronAPI.booksy.getStatus();
      setStatus(s);
    } finally {
      setSyncingAddons(false);
    }
  }, []);

  const handleSyncAll = useCallback(async () => {
    setSyncingAll(true);
    try {
      await window.electronAPI.booksy.syncAll();
      const s = await window.electronAPI.booksy.getStatus();
      setStatus(s);
    } finally {
      setSyncingAll(false);
    }
  }, []);

  const handleToggle = useCallback(async () => {
    if (status?.running || status?.enabled) {
      await window.electronAPI.booksy.stop();
    } else {
      // If no token and Chrome not connected, launch Chrome first
      if (!status?.hasToken && !status?.chromeConnected) {
        setShowSetupWizard(true);
        return;
      }
      await window.electronAPI.booksy.start();
    }
    const s = await window.electronAPI.booksy.getStatus();
    setStatus(s);
  }, [status]);

  const handleLaunchChrome = useCallback(async () => {
    try {
      const result = await window.electronAPI.shell.launchChromeDebug(config?.cdpPort || 9222);
      if (!result.success) {
        alert(t('booksy.chromeOpenError') + result.error);
      }
    } catch (err: any) {
      rlog.error('[BooksySync] Failed to launch Chrome:', err);
      alert(t('booksy.error') + err.message);
    }
  }, [config]);

  const handleOpenBooksy = useCallback(async () => {
    try {
      await window.electronAPI.shell.openExternal('https://pro.booksy.com');
    } catch (err: any) {
      rlog.error('[BooksySync] Failed to open Booksy:', err);
    }
  }, []);

  const handleSaveConfig = useCallback(async () => {
    if (!config) return;
    const updated = await window.electronAPI.booksy.setConfig(config);
    setConfig(updated);
    setShowSettings(false);
  }, [config]);

  const formatTime = (iso: string) => {
    if (!iso) return '-';
    try {
      return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  };

  const formatRelative = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return t('booksy.time.justNow');
    if (diff < 3600000) return t('booksy.time.minutesAgo').replace('{n}', String(Math.floor(diff / 60000)));
    if (diff < 86400000) return t('booksy.time.hoursAgo').replace('{n}', String(Math.floor(diff / 3600000)));
    return new Date(iso).toLocaleDateString(language, { day: '2-digit', month: '2-digit' });
  };

  const formatDateTime = (iso: string | null) => {
    if (!iso) return t('booksy.time.never');
    try {
      return new Date(iso).toLocaleString(language, {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const pushReasonLabel = (reason?: string) => {
    if (!reason) return null;
    const key = `booksy.pushReason.${reason.replace(/-/g, '_')}`;
    const label = t(key);
    return label !== key ? label : reason;
  };

  if (showSettings) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">Booksy Settings</h2>
          <button
            onClick={() => setShowSettings(false)}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            Back
          </button>
        </div>

        <div className="panel p-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Business ID</label>
            <input
              type="text"
              value={config?.businessId || ''}
              onChange={(e) => setConfig({ ...config!, businessId: e.target.value })}
              className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400"
              placeholder={t('booksy.businessIdHint')}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Chrome CDP Port</label>
            <input
              type="number"
              value={config?.cdpPort || 9222}
              onChange={(e) => setConfig({ ...config!, cdpPort: parseInt(e.target.value) || 9222 })}
              className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">eNail API URL</label>
            <input
              type="text"
              value={config?.enailApiUrl || ''}
              onChange={(e) => setConfig({ ...config!, enailApiUrl: e.target.value })}
              className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400"
              placeholder="https://api.enail.pro/api/v1"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">eNail JWT Token</label>
            <input
              type="password"
              value={config?.enailJwt || ''}
              onChange={(e) => setConfig({ ...config!, enailJwt: e.target.value })}
              className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400"
              placeholder="Bearer token"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Sync interval (min)</label>
              <input
                type="number"
                value={config?.syncIntervalMin || 30}
                onChange={(e) => setConfig({ ...config!, syncIntervalMin: parseInt(e.target.value) || 30 })}
                className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Working days</label>
              <input
                type="text"
                value={(config?.workDays || [1,2,3,4,5,6]).join(',')}
                onChange={(e) => setConfig({ ...config!, workDays: e.target.value.split(',').map(Number).filter(n => n >= 0 && n <= 6) })}
                className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400"
                placeholder="1,2,3,4,5,6"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Working hours from</label>
              <input
                type="text"
                value={`${config?.workStartHour || 7}:${String(config?.workStartMin || 30).padStart(2, '0')}`}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(':').map(Number);
                  setConfig({ ...config!, workStartHour: h || 7, workStartMin: m || 0 });
                }}
                className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400"
                placeholder="7:30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Working hours to</label>
              <input
                type="text"
                value={`${config?.workEndHour || 18}:${String(config?.workEndMin || 30).padStart(2, '0')}`}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(':').map(Number);
                  setConfig({ ...config!, workEndHour: h || 18, workEndMin: m || 0 });
                }}
                className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400"
                placeholder="18:30"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Telegram Bot Token (alerts)</label>
            <input
              type="text"
              value={config?.telegramBotToken || ''}
              onChange={(e) => setConfig({ ...config!, telegramBotToken: e.target.value })}
              className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400"
              placeholder="Optional"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Telegram Chat ID</label>
            <input
              type="text"
              value={config?.telegramChatId || ''}
              onChange={(e) => setConfig({ ...config!, telegramChatId: e.target.value })}
              className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400"
              placeholder="Optional"
            />
          </div>

          <button
            onClick={handleSaveConfig}
            className="w-full px-4 py-2 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700 transition-colors"
          >
            Save settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-800">Booksy Sync</h2>
        <button
          onClick={() => setShowSettings(true)}
          className="text-sm text-slate-500 hover:text-slate-700"
        >
          Settings
        </button>
      </div>

      {jwtExpiredVisible && (
        <div className="bg-amber-50 border-l-4 border-amber-400 p-3 flex items-start gap-2">
          <span aria-hidden>&#9888;&#65039;</span>
          <div className="flex-1 text-sm text-amber-900">
            {t('booksy.jwtExpiredBanner')}
            {' '}
            <button
              onClick={() => { setShowSettings(true); setJwtExpiredVisible(false); }}
              className="underline text-amber-900 hover:text-amber-700 font-medium"
            >
              {t('booksy.openSettings')}
            </button>
          </div>
          <button onClick={() => setJwtExpiredVisible(false)} className="text-amber-700 hover:text-amber-900 text-lg leading-none">&times;</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="panel p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2.5 h-2.5 rounded-full ${
              status?.running ? 'bg-brand-500 animate-pulse' :
              status?.enabled ? 'bg-green-500' :
              'bg-slate-300'
            }`} />
            <span className="text-xs font-medium text-slate-600">Status</span>
          </div>
          <p className="text-sm font-semibold text-slate-800">
            {status?.running ? 'Syncing...' :
             status?.enabled ? 'Active' :
             'Inactive'}
          </p>
        </div>

        <div className="panel p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2.5 h-2.5 rounded-full ${
              status?.sessionExpired ? 'bg-red-500' :
              status?.hasToken ? 'bg-green-500' :
              'bg-yellow-500'
            }`} />
            <span className="text-xs font-medium text-slate-600">Session</span>
          </div>
          <p className="text-sm font-semibold text-slate-800">
            {status?.sessionExpired ? 'Expired!' :
             status?.hasToken ? 'Active' :
             'No token'}
          </p>
        </div>

        <div className="panel p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2.5 h-2.5 rounded-full ${
              status?.chromeConnected ? 'bg-green-500' : 'bg-slate-300'
            }`} />
            <span className="text-xs font-medium text-slate-600">Chrome CDP</span>
          </div>
          <p className="text-sm font-semibold text-slate-800">
            {status?.chromeConnected ? 'Connected' : 'Disconnected'}
          </p>
        </div>

        <div className="panel p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2.5 h-2.5 rounded-full ${
              status?.isBusinessHours ? 'bg-green-500' : 'bg-slate-300'
            }`} />
            <span className="text-xs font-medium text-slate-600">Business hours</span>
          </div>
          <p className="text-sm font-semibold text-slate-800">
            {status?.isBusinessHours ? 'Yes' : 'No'}
          </p>
        </div>
      </div>

      {status?.sessionExpired && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm font-medium text-red-800">Booksy session expired!</p>
          <p className="text-xs text-red-600 mt-1">
            Log in to booksy.com in Chrome; sync will resume automatically.
          </p>
        </div>
      )}

      {status?.lastSyncReport && (
        <div className="panel p-3">
          <h3 className="text-xs font-medium text-slate-500 mb-2">Last sync</h3>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-800">
                {status.lastSyncReport.bookings} bookings
              </p>
              <p className="text-xs text-slate-500">
                {formatDateTime(status.lastSyncReport.time)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {status.lastSyncReport.pushed && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                  Sent
                </span>
              )}
              {status.lastSyncReport.error && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                  {status.lastSyncReport.error}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleToggle}
          className={`flex-1 px-4 py-2 text-sm rounded-lg transition-colors ${
            status?.enabled
              ? 'bg-red-100 text-red-700 hover:bg-red-200'
              : 'bg-brand-600 text-white hover:bg-brand-700'
          }`}
        >
          {status?.enabled ? 'Stop' : 'Start'}
        </button>
        <button
          onClick={handleSyncNow}
          disabled={syncing}
          className="flex-1 px-4 py-2 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
        >
          {syncing ? 'Syncing...' : 'Sync now'}
        </button>
      </div>

      <button
        onClick={handleSyncAll}
        disabled={syncingAll}
        className="w-full px-4 py-2 bg-brand-700 text-white text-sm rounded-lg hover:bg-brand-800 transition-colors disabled:opacity-50"
      >
        {syncingAll ? 'Syncing everything...' : 'Sync everything (staff + customers + resources + services + addons)'}
      </button>

      {status && (
        <div className="panel p-4">
          <h3 className="text-sm font-semibold mb-2">Push Status</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500">
                <th className="text-left pb-1">Entity</th>
                <th className="text-left pb-1">Last Push</th>
                <th className="text-left pb-1">Status</th>
                <th className="text-left pb-1">Reason</th>
              </tr>
            </thead>
            <tbody className="text-slate-700">
              {[
                { name: 'Calendar', report: status.lastSyncReport },
                { name: 'Customers', report: status.lastCustomerSyncReport },
                { name: 'Staff', report: status.lastStaffSyncReport },
                { name: 'Resources', report: status.lastResourceSyncReport },
                { name: 'Services', report: status.lastServiceSyncReport },
                { name: 'Addons', report: status.lastAddonSyncReport },
              ].map(({ name, report }) => (
                <tr key={name} className="border-t border-slate-100">
                  <td className="py-1.5">{name}</td>
                  <td className="py-1.5">{report?.time ? formatRelative(report.time) : '—'}</td>
                  <td className="py-1.5">{report ? (report.pushed ? '✅' : '❌') : '—'}</td>
                  <td className="py-1.5 text-xs">
                    {!report
                      ? '—'
                      : report.pushed && (report.pushErrors ?? 0) > 0
                        ? `+${report.pushErrors} rows failed`
                        : !report.pushed
                          ? (pushReasonLabel(report.pushReason) || report.error || '—')
                          : '—'
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel p-3">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-xs font-medium text-slate-500">Booksy customers</h3>
            <p className="text-sm font-semibold text-slate-800">
              {status?.customerCount || 0} customers
            </p>
          </div>
          <button
            onClick={handleSyncCustomers}
            disabled={syncingCustomers}
            className="px-3 py-1.5 bg-brand-100 text-brand-700 text-xs rounded-lg hover:bg-brand-200 transition-colors disabled:opacity-50"
          >
            {syncingCustomers ? 'Fetching...' : 'Sync customers'}
          </button>
        </div>
        {status?.lastCustomerSyncReport && (
          <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
            <span>Last sync: {formatDateTime(status.lastCustomerSyncReport.time)}</span>
            <span>|</span>
            <span>{status.lastCustomerSyncReport.totalFetched} fetched, {status.lastCustomerSyncReport.newCustomers} new</span>
            {status.lastCustomerSyncReport.pushed && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                Sent
              </span>
            )}
            {status.lastCustomerSyncReport.error && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                {status.lastCustomerSyncReport.error}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="panel p-3">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-xs font-medium text-slate-500">Booksy staff</h3>
            <p className="text-sm font-semibold text-slate-800">
              {status?.staffCount || 0} staff
            </p>
          </div>
          <button
            onClick={handleSyncStaff}
            disabled={syncingStaff}
            className="px-3 py-1.5 bg-brand-100 text-brand-700 text-xs rounded-lg hover:bg-brand-200 transition-colors disabled:opacity-50"
          >
            {syncingStaff ? 'Fetching...' : 'Sync staff'}
          </button>
        </div>
        {status?.lastStaffSyncReport && (
          <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
            <span>Last sync: {formatDateTime(status.lastStaffSyncReport.time)}</span>
            <span>|</span>
            <span>{status.lastStaffSyncReport.totalFetched} fetched</span>
            {status.lastStaffSyncReport.pushed && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                Sent
              </span>
            )}
            {status.lastStaffSyncReport.error && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                {status.lastStaffSyncReport.error}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="panel p-3">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-xs font-medium text-slate-500">Booksy resources</h3>
            <p className="text-sm font-semibold text-slate-800">
              {status?.resourceCount || 0} resources
            </p>
          </div>
          <button
            onClick={handleSyncResources}
            disabled={syncingResources}
            className="px-3 py-1.5 bg-brand-100 text-brand-700 text-xs rounded-lg hover:bg-brand-200 transition-colors disabled:opacity-50"
          >
            {syncingResources ? 'Fetching...' : 'Sync resources'}
          </button>
        </div>
        {status?.lastResourceSyncReport && (
          <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
            <span>Last sync: {formatDateTime(status.lastResourceSyncReport.time)}</span>
            <span>|</span>
            <span>{status.lastResourceSyncReport.totalFetched} fetched</span>
            {status.lastResourceSyncReport.pushed && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                Sent
              </span>
            )}
            {status.lastResourceSyncReport.error && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                {status.lastResourceSyncReport.error}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="panel p-3">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-xs font-medium text-slate-500">Booksy services</h3>
            <p className="text-sm font-semibold text-slate-800">
              {status?.serviceCount || 0} services
            </p>
          </div>
          <button
            onClick={handleSyncServices}
            disabled={syncingServices}
            className="px-3 py-1.5 bg-brand-100 text-brand-700 text-xs rounded-lg hover:bg-brand-200 transition-colors disabled:opacity-50"
          >
            {syncingServices ? 'Fetching...' : 'Sync services'}
          </button>
        </div>
        {status?.lastServiceSyncReport && (
          <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
            <span>Last sync: {formatDateTime(status.lastServiceSyncReport.time)}</span>
            <span>|</span>
            <span>{status.lastServiceSyncReport.categoriesFetched} categories, {status.lastServiceSyncReport.servicesFetched} services</span>
            {status.lastServiceSyncReport.pushed && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                Sent
              </span>
            )}
            {status.lastServiceSyncReport.error && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                {status.lastServiceSyncReport.error}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="panel p-3">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-xs font-medium text-slate-500">Booksy addons</h3>
            <p className="text-sm font-semibold text-slate-800">
              {status?.addonCount || 0} addons
            </p>
          </div>
          <button
            onClick={handleSyncAddons}
            disabled={syncingAddons}
            className="px-3 py-1.5 bg-brand-100 text-brand-700 text-xs rounded-lg hover:bg-brand-200 transition-colors disabled:opacity-50"
          >
            {syncingAddons ? 'Fetching...' : 'Sync addons'}
          </button>
        </div>
        {status?.lastAddonSyncReport && (
          <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
            <span>Last sync: {formatDateTime(status.lastAddonSyncReport.time)}</span>
            <span>|</span>
            <span>{status.lastAddonSyncReport.totalFetched} fetched</span>
            {status.lastAddonSyncReport.pushed && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                Sent
              </span>
            )}
            {status.lastAddonSyncReport.error && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                {status.lastAddonSyncReport.error}
              </span>
            )}
          </div>
        )}
      </div>

      {bookings.length > 0 && (
        <div className="panel">
          <div className="px-3 py-2 border-b border-slate-100">
            <h3 className="text-xs font-medium text-slate-500">
              Today's bookings ({bookings.length})
            </h3>
          </div>
          <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
            {bookings.map((b) => (
              <div key={b.id} className="px-3 py-2">
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800 truncate">
                      {b.customerName}
                    </p>
                    <p className="text-xs text-slate-500 truncate">
                      {b.serviceName} - {b.staffName}
                    </p>
                  </div>
                  <div className="text-right ml-2 flex-shrink-0">
                    <p className="text-sm font-medium text-slate-700">
                      {formatTime(b.from)}
                    </p>
                    <p className="text-xs text-slate-400">
                      {formatTime(b.till)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Setup Wizard Modal */}
      {showSetupWizard && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-800">{t('booksy.setup.title')}</h2>
              <button
                onClick={() => setShowSetupWizard(false)}
                className="text-slate-400 hover:text-slate-600 text-xl"
              >
                ×
              </button>
            </div>

            <div className="space-y-4">
              <div className="flex items-start gap-3 p-3 bg-blue-50 rounded-lg">
                <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold flex-shrink-0">1</div>
                <div>
                  <p className="text-sm font-medium text-slate-800">{t('booksy.setup.step1Title')}</p>
                  <p className="text-xs text-slate-500 mt-1">{t('booksy.setup.step1Desc')}</p>
                </div>
              </div>

              <button
                onClick={handleLaunchChrome}
                className="w-full px-4 py-3 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-3.952 6.848c.404.037.813.055 1.229.055 6.627 0 12-5.373 12-12 0-1.003-.124-1.979-.357-2.912zm-3.317 3.148a3.818 3.818 0 1 0 0 7.636 3.818 3.818 0 0 0 0-7.636z"/>
                </svg>
                {t('booksy.setup.openChrome')}
              </button>

              <div className="flex items-start gap-3 p-3 bg-green-50 rounded-lg">
                <div className="w-8 h-8 rounded-full bg-green-500 text-white flex items-center justify-center font-bold flex-shrink-0">2</div>
                <div>
                  <p className="text-sm font-medium text-slate-800">{t('booksy.setup.step2Title')}</p>
                  <p className="text-xs text-slate-500 mt-1">{t('booksy.setup.step2Desc')}</p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 bg-orange-50 rounded-lg">
                <div className="w-8 h-8 rounded-full bg-orange-500 text-white flex items-center justify-center font-bold flex-shrink-0">3</div>
                <div>
                  <p className="text-sm font-medium text-slate-800">{t('booksy.setup.step3Title')}</p>
                  <p className="text-xs text-slate-500 mt-1">{t('booksy.setup.step3Desc')}</p>
                </div>
              </div>

              <button
                onClick={async () => {
                  setShowSetupWizard(false);
                  await window.electronAPI.booksy.start();
                  const s = await window.electronAPI.booksy.getStatus();
                  setStatus(s);
                }}
                className="w-full px-4 py-3 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700 transition-colors"
              >
                {t('booksy.setup.startSync')}
              </button>
            </div>

            <p className="text-xs text-center text-slate-400">
              {t('booksy.setup.oneTimeNote')}
            </p>
          </div>
        </div>
      )}

      {/* Quick setup panel when not connected */}
      {!status?.chromeConnected && !status?.hasToken && !showSetupWizard && (
        <div className="panel p-4 bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-200">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-800">{t('booksy.setup.quickTitle')}</h3>
              <p className="text-xs text-slate-500">{t('booksy.setup.quickDesc')}</p>
            </div>
          </div>
          <button
            onClick={() => setShowSetupWizard(true)}
            className="w-full px-4 py-2.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            {t('booksy.setup.quickButton')}
          </button>
        </div>
      )}
    </div>
  );
}
