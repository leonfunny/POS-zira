import React, { useEffect, useState } from 'react';
import type { SecurityAnalytics, CameraConfig } from '../../../shared/types';

interface AnalyticsDashboardProps {
  cameras: CameraConfig[];
}

export default function AnalyticsDashboard({ cameras }: AnalyticsDashboardProps) {
  const [selectedCamera, setSelectedCamera] = useState<string>('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [analytics, setAnalytics] = useState<SecurityAnalytics | null>(null);
  const [loading, setLoading] = useState(false);

  const analyticsCameras = cameras.filter(c =>
    c.algorithms.some(a => a.startsWith('analytics_'))
  );

  useEffect(() => {
    if (analyticsCameras.length > 0 && !selectedCamera) {
      setSelectedCamera(analyticsCameras[0].id);
    }
  }, [analyticsCameras, selectedCamera]);

  useEffect(() => {
    if (!selectedCamera || !date) return;
    let cancelled = false;
    setLoading(true);

    window.electronAPI.security.getAnalytics(selectedCamera, date)
      .then(data => {
        if (!cancelled) setAnalytics(data);
      })
      .catch(err => {
        if (!cancelled) console.error('[Analytics] Failed to load:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [selectedCamera, date]);

  if (analyticsCameras.length === 0) {
    return (
      <div className="text-sm text-slate-400 p-6 text-center bg-slate-50 rounded-lg">
        No cameras with analytics algorithms configured.
      </div>
    );
  }

  const maxCount = analytics?.hourlyCustomerCount
    ? Math.max(...analytics.hourlyCustomerCount, 1)
    : 1;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-3">
        <select
          value={selectedCamera}
          onChange={(e) => setSelectedCamera(e.target.value)}
          className="text-sm border border-slate-200 rounded px-2 py-1.5"
        >
          {analyticsCameras.map(cam => (
            <option key={cam.id} value={cam.id}>{cam.name}</option>
          ))}
        </select>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="text-sm border border-slate-200 rounded px-2 py-1.5"
        />
      </div>

      {loading ? (
        <div className="text-sm text-slate-500 p-4">Loading analytics...</div>
      ) : !analytics ? (
        <div className="text-sm text-slate-400 p-4 text-center bg-slate-50 rounded-lg">
          No analytics data for this date.
        </div>
      ) : (
        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white border border-slate-200 rounded-lg p-3">
              <div className="text-[10px] text-slate-400 uppercase">Total Visitors</div>
              <div className="text-2xl font-semibold text-slate-800">
                {analytics.hourlyCustomerCount.reduce((a, b) => a + b, 0)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-3">
              <div className="text-[10px] text-slate-400 uppercase">Peak Hour</div>
              <div className="text-2xl font-semibold text-slate-800">
                {analytics.peakHour}:00
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-3">
              <div className="text-[10px] text-slate-400 uppercase">Avg Wait</div>
              <div className="text-2xl font-semibold text-slate-800">
                {Math.round(analytics.avgWaitTimeSeconds / 60)}m
              </div>
            </div>
          </div>

          {/* Hourly chart */}
          <div className="bg-white border border-slate-200 rounded-lg p-3">
            <div className="text-xs text-slate-500 mb-2">Hourly Customer Count</div>
            <div className="flex items-end gap-px h-24">
              {analytics.hourlyCustomerCount.map((count, hour) => (
                <div key={hour} className="flex-1 flex flex-col items-center gap-0.5">
                  <div
                    className="w-full bg-brand-500 rounded-t"
                    style={{ height: `${(count / maxCount) * 100}%`, minHeight: count > 0 ? 2 : 0 }}
                    title={`${hour}:00 - ${count} visitors`}
                  />
                  {hour % 3 === 0 && (
                    <span className="text-[8px] text-slate-400">{hour}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Staff metrics */}
          {analytics.staffMetrics && analytics.staffMetrics.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-lg p-3">
              <div className="text-xs text-slate-500 mb-2">Staff Zone Activity</div>
              <div className="space-y-2">
                {analytics.staffMetrics.map((metric) => (
                  <div key={metric.zoneId} className="flex items-center justify-between text-xs">
                    <span className="text-slate-700 font-medium">{metric.zoneName}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-green-600">{metric.activeMinutes}m active</span>
                      <span className="text-slate-400">{metric.idleMinutes}m idle</span>
                      <span className="text-brand-600">{metric.estimatedCustomersServed} served</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
