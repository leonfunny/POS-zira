import React, { useState, useEffect } from 'react';
import { AgentConfig, DeviceStatus, ConnectionStatus } from '../../shared/types';

interface PosEventSyncStatus {
  pending: number;
  deadLetter: number;
  oldestPendingAt: string | null;
  lastUploadAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
}

function formatAgo(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(then)) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

interface StatusProps {
  config: AgentConfig | null;
  connectionStatus: ConnectionStatus;
  deviceStatus: DeviceStatus | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onConfigChange: (config: Partial<AgentConfig>) => void;
}

export default function Status({
  config,
  connectionStatus,
  deviceStatus,
  onConnect,
  onDisconnect,
  onConfigChange,
}: StatusProps) {
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventSync, setEventSync] = useState<PosEventSyncStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await window.electronAPI.sync.eventStatus();
        if (alive && res?.success && res.status) setEventSync(res.status);
      } catch {
        /* ignore — status is best-effort */
      }
    };
    void poll();
    const id = setInterval(poll, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const handleFlushEvents = async () => {
    try {
      const res = await window.electronAPI.sync.flushEvents();
      if (res?.success && res.status) setEventSync(res.status as PosEventSyncStatus);
    } catch {
      /* ignore */
    }
  };

  const handleTestPrint = async () => {
    const result = await window.electronAPI.testPrint();
    if (result.success) {
      alert('Test print sent successfully!');
    } else {
      alert(`Error: ${result.error}`);
    }
  };

  const handleConnectWithApiKey = async () => {
    if (!apiKey.trim()) {
      setError('Enter an API key');
      return;
    }

    if (!apiKey.startsWith('pa_')) {
      setError('API key must start with "pa_"');
      return;
    }

    setConnecting(true);
    setError(null);

    try {
      const result = await window.electronAPI.connectWithApiKey(apiKey);
      if (result.success) {
        const newConfig = await window.electronAPI.getConfig();
        onConfigChange(newConfig);
        setApiKey('');
      } else {
        setError(result.error || 'Failed to connect');
      }
    } catch (err: any) {
      setError(err.message || 'Connection error');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">
          Server connection
        </h2>

        {!config?.isPaired ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-3 bg-amber-50 rounded-lg">
              <svg className="w-5 h-5 text-amber-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm text-amber-800">
                Paste the API key from eNail Dashboard → Settings → Print Agent
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                API Key
              </label>
              <input
                type="text"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="pa_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                disabled={connecting}
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-50 rounded-lg">
                <svg className="w-4 h-4 text-red-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <button
              onClick={handleConnectWithApiKey}
              disabled={connecting || !apiKey.trim()}
              className="w-full px-4 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {connecting ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                  Connecting...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                  Connect
                </>
              )}
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center ${
                  connectionStatus.connected
                    ? 'bg-emerald-100'
                    : 'bg-slate-100'
                }`}
              >
                {connectionStatus.connected ? (
                  <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-slate-800">
                  {connectionStatus.connected ? 'Connected' : 'Disconnected'}
                </p>
                <p className="text-xs text-slate-500">
                  {config?.salonName || config?.serverUrl || 'Not configured'}
                </p>
              </div>
            </div>

            <button
              onClick={connectionStatus.connected ? onDisconnect : onConnect}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                connectionStatus.connected
                  ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  : 'bg-brand-600 text-white hover:bg-brand-700'
              }`}
            >
              {connectionStatus.connected ? 'Disconnect' : 'Connect'}
            </button>
          </div>
        )}
      </div>

      {eventSync && (
        <div className="panel p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center ${
                  eventSync.deadLetter > 0
                    ? 'bg-red-100'
                    : eventSync.pending > 0
                      ? 'bg-amber-100'
                      : 'bg-emerald-100'
                }`}
              >
                <svg
                  className={`w-5 h-5 ${
                    eventSync.deadLetter > 0
                      ? 'text-red-600'
                      : eventSync.pending > 0
                        ? 'text-amber-600'
                        : 'text-emerald-600'
                  }`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-slate-800">
                  Cashflow events
                  {eventSync.pending > 0
                    ? ` · ${eventSync.pending} pending`
                    : ' · all synced'}
                  {eventSync.deadLetter > 0 ? ` · ${eventSync.deadLetter} stuck` : ''}
                </p>
                <p className="text-xs text-slate-500">
                  Last upload {formatAgo(eventSync.lastUploadAt)}
                  {eventSync.lastError ? ` · last error: ${eventSync.lastError}` : ''}
                </p>
              </div>
            </div>
            {eventSync.pending > 0 && (
              <button
                onClick={handleFlushEvents}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
              >
                Sync now
              </button>
            )}
          </div>
        </div>
      )}

      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">
          Fiscal printer
        </h2>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-full flex items-center justify-center ${
                deviceStatus?.printerConnected
                  ? 'bg-emerald-100'
                  : 'bg-slate-100'
              }`}
            >
              <svg className={`w-5 h-5 ${deviceStatus?.printerConnected ? 'text-emerald-600' : 'text-slate-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-slate-800">
                {deviceStatus?.printerConnected ? 'Connected' : 'Not connected'}
              </p>
              <p className="text-xs text-slate-500">
                {deviceStatus?.printerPort || 'No port'} - {config?.printerProtocol || 'THERMAL'}
              </p>
            </div>
          </div>

          <button
            onClick={handleTestPrint}
            disabled={!deviceStatus?.printerConnected}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Test print
          </button>
        </div>
      </div>

      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">
          Barcode scanner
        </h2>

        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center ${
              deviceStatus?.scannerActive
                ? 'bg-emerald-100'
                : 'bg-slate-100'
            }`}
          >
            <svg className={`w-5 h-5 ${deviceStatus?.scannerActive ? 'text-emerald-600' : 'text-slate-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-slate-800">
              {deviceStatus?.scannerActive ? 'Active' : 'Inactive'}
            </p>
            <p className="text-xs text-slate-500">
              HID (keyboard) mode
            </p>
          </div>
        </div>
      </div>

      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">
          Info
        </h2>

        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-500">App version</span>
            <span className="text-slate-800 font-medium">{deviceStatus?.appVersion || '1.0.0'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Salon</span>
            <span className="text-slate-800 font-medium">{config?.salonName || 'Not paired'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Machine ID</span>
            <span className="text-slate-800 font-mono text-xs">{config?.machineId?.substring(0, 16)}...</span>
          </div>
          {config?.apiKey && (
            <div className="flex justify-between">
              <span className="text-slate-500">API key</span>
              <span className="text-slate-800 font-mono text-xs">{config.apiKey.substring(0, 10)}...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
