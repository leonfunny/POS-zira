import React, { useEffect, useState, useCallback } from 'react';
import CameraGrid from './CameraGrid';
import AlertsList from './AlertsList';
import CameraSettings from './CameraSettings';
import AnalyticsDashboard from './AnalyticsDashboard';
import type { AgentConfig, SecurityConfig, SecurityStatus, CameraConfig } from '../../../shared/types';

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
  const [subView, setSubView] = useState<SubView>('cameras');
  const [securityConfig, setSecurityConfig] = useState<SecurityConfig>(defaultSecurityConfig);
  const [status, setStatus] = useState<SecurityStatus>({
    running: false,
    cameras: [],
    totalInferenceFps: 0,
    uptime: 0,
  });
  const [loading, setLoading] = useState(true);

  // Load config + status
  useEffect(() => {
    const load = async () => {
      try {
        const [cfg, sts] = await Promise.all([
          window.electronAPI.security.getConfig(),
          window.electronAPI.security.getStatus(),
        ]);
        if (cfg) setSecurityConfig(cfg);
        if (sts) setStatus(sts);
      } catch (err) {
        console.error('[SecurityTab] Load error:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Subscribe to status changes
  useEffect(() => {
    const unsub = window.electronAPI.security.onStatusChanged((s) => {
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

  const handleStart = useCallback(async () => {
    const result = await window.electronAPI.security.start();
    if (result.success) {
      const s = await window.electronAPI.security.getStatus();
      if (s) setStatus(s);
    }
  }, []);

  const handleStop = useCallback(async () => {
    await window.electronAPI.security.stop();
    setStatus(prev => ({ ...prev, running: false }));
  }, []);

  const handleSaveCameras = useCallback(async (cameras: CameraConfig[]) => {
    const updated = { ...securityConfig, cameras };
    setSecurityConfig(updated);
    await window.electronAPI.security.setConfig(updated);
  }, [securityConfig]);

  const handleSaveGlobalConfig = useCallback(async (updates: Partial<SecurityConfig>) => {
    const updated = { ...securityConfig, ...updates };
    setSecurityConfig(updated);
    await window.electronAPI.security.setConfig(updated);
  }, [securityConfig]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-600" />
      </div>
    );
  }

  const onlineCameras = status.cameras.filter(c => c.connected).length;
  const totalCameras = securityConfig.cameras.length;

  const SUB_VIEWS: { key: SubView; label: string }[] = [
    { key: 'cameras', label: 'Cameras' },
    { key: 'alerts', label: 'Alerts' },
    { key: 'analytics', label: 'Analytics' },
    { key: 'settings', label: 'Settings' },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Security Monitoring</h2>
          <p className="text-xs text-slate-500">
            {totalCameras} camera{totalCameras !== 1 ? 's' : ''}
            {status.running && (
              <> &middot; {onlineCameras} online &middot; {status.totalInferenceFps} FPS total</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status.running ? (
            <button
              onClick={handleStop}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
            >
              <span>&#x23F9;</span> Stop
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={totalCameras === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span>&#x25B6;</span> Start
            </button>
          )}
          <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium ${
            status.running ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${status.running ? 'bg-green-500' : 'bg-slate-400'}`} />
            {status.running ? 'Running' : 'Stopped'}
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
            {sv.label}
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
          />
          <AlertsList limit={5} />
        </div>
      )}

      {subView === 'alerts' && (
        <AlertsList limit={100} />
      )}

      {subView === 'analytics' && (
        <AnalyticsDashboard cameras={securityConfig.cameras} />
      )}

      {subView === 'settings' && (
        <div className="space-y-4">
          <CameraSettings
            cameras={securityConfig.cameras}
            onSave={handleSaveCameras}
          />

          {/* Global settings */}
          <div className="border border-slate-200 rounded-lg p-3 space-y-3">
            <h3 className="text-sm font-medium text-slate-700">Global Settings</h3>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 block mb-1">YOLO Model</label>
                <select
                  value={securityConfig.modelSize}
                  onChange={(e) => handleSaveGlobalConfig({ modelSize: e.target.value })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                >
                  <option value="yolov8n">YOLOv8 Nano (fastest)</option>
                  <option value="yolov8s">YOLOv8 Small (balanced)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1">Cooldown (s)</label>
                <input
                  type="number"
                  value={securityConfig.cooldownSeconds}
                  onChange={(e) => handleSaveGlobalConfig({ cooldownSeconds: Number(e.target.value) })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                  min={30} max={3600}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 block mb-1">MJPEG Port</label>
                <input
                  type="number"
                  value={securityConfig.mjpegPort}
                  onChange={(e) => handleSaveGlobalConfig({ mjpegPort: Number(e.target.value) })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                  min={8000} max={65535}
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1">Evidence Retention (days)</label>
                <input
                  type="number"
                  value={securityConfig.evidenceRetentionDays}
                  onChange={(e) => handleSaveGlobalConfig({ evidenceRetentionDays: Number(e.target.value) })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                  min={1} max={365}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 block mb-1">Business Hours Start</label>
                <input
                  type="time"
                  value={securityConfig.businessHoursStart}
                  onChange={(e) => handleSaveGlobalConfig({ businessHoursStart: e.target.value })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1">Business Hours End</label>
                <input
                  type="time"
                  value={securityConfig.businessHoursEnd}
                  onChange={(e) => handleSaveGlobalConfig({ businessHoursEnd: e.target.value })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={securityConfig.snapshotOnAlert}
                  onChange={(e) => handleSaveGlobalConfig({ snapshotOnAlert: e.target.checked })}
                />
                Snapshot on Alert
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={securityConfig.clipOnAlert}
                  onChange={(e) => handleSaveGlobalConfig({ clipOnAlert: e.target.checked })}
                />
                Clip on Alert
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={securityConfig.telegramAlertEnabled}
                  onChange={(e) => handleSaveGlobalConfig({ telegramAlertEnabled: e.target.checked })}
                />
                Telegram Alerts
              </label>
            </div>

            {securityConfig.telegramAlertEnabled && (
              <div>
                <label className="text-xs text-slate-500 block mb-1">Telegram Chat ID</label>
                <input
                  type="text"
                  value={securityConfig.telegramChatId}
                  onChange={(e) => handleSaveGlobalConfig({ telegramChatId: e.target.value })}
                  className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                  placeholder="e.g. -1001234567890"
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
