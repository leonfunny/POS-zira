import React, { useEffect, useState, useCallback } from 'react';
import type { SecurityAlert } from '../../../shared/types';
import rlog from '../../utils/logger';

interface AlertsListProps {
  limit?: number;
  cameraId?: string;
  t?: (key: string) => string;
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 border-red-200',
  high: 'bg-orange-100 text-orange-800 border-orange-200',
  medium: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  low: 'bg-blue-100 text-blue-800 border-blue-200',
};

const SEVERITY_ICON: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

export default function AlertsList({ limit = 50, cameraId, t }: AlertsListProps) {
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAlerts = useCallback(async () => {
    try {
      const data = await window.electronAPI.security.getAlerts(limit, cameraId);
      setAlerts(data);
    } catch (err) {
      rlog.error('[AlertsList] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [limit, cameraId]);

  useEffect(() => {
    loadAlerts();
    const unsub = window.electronAPI.security.onAlert((alert: any) => {
      setAlerts(prev => [alert, ...prev].slice(0, limit));
    });
    return () => unsub();
  }, [loadAlerts, limit]);

  const handleClear = async () => {
    await window.electronAPI.security.clearAlerts();
    setAlerts([]);
  };

  if (loading) {
    return <div className="text-sm text-slate-500 p-4">{t?.('security.loadingAlerts') ?? 'Loading alerts...'}</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">
          {t?.('security.recentAlerts') ?? 'Recent Alerts'} ({alerts.length})
        </h3>
        {alerts.length > 0 && (
          <button
            onClick={handleClear}
            className="text-xs text-slate-500 hover:text-red-600 transition-colors"
          >
            {t?.('security.clearAll') ?? 'Clear all'}
          </button>
        )}
      </div>

      {alerts.length === 0 ? (
        <div className="text-sm text-slate-400 p-4 text-center bg-slate-50 rounded-lg">
          {t?.('security.noAlerts') ?? 'No alerts yet'}
        </div>
      ) : (
        <div className="space-y-1 max-h-[400px] overflow-y-auto">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className={`flex items-start gap-2 p-2 rounded-lg border text-xs ${SEVERITY_STYLES[alert.severity] || SEVERITY_STYLES.low}`}
            >
              <span className="text-sm mt-0.5" aria-hidden="true">{SEVERITY_ICON[alert.severity] || '🟢'}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{alert.algorithm}</span>
                  <span className="text-[10px] opacity-70">
                    {new Date(alert.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <p className="text-xs opacity-80 truncate">{alert.message}</p>
                <p className="text-[10px] opacity-60">{alert.cameraName}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
