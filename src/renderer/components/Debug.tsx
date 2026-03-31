import React, { useEffect, useState } from 'react';

interface DiagnosticsData {
  appVersion: string;
  electron: string;
  node: string;
  platform: string;
  userData: string;
  debugMode: boolean;
  connected: boolean;
  printerConnected: boolean;
  scannerActive: boolean;
}

export default function Debug() {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const loadDiagnostics = async () => {
    try {
      console.log('[Debug] Loading diagnostics...');
      const data = await window.electronAPI.debug.getDiagnostics();
      console.log('[Debug] Diagnostics loaded:', data);
      setDiagnostics(data);
    } catch (error) {
      console.error('[Debug] Failed to load diagnostics:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDiagnostics();
  }, []);

  const handleOpenDevTools = async () => {
    console.log('[Debug] Opening DevTools...');
    await window.electronAPI.debug.openDevTools();
  };

  const handleOpenLogs = async () => {
    console.log('[Debug] Opening logs folder...');
    await window.electronAPI.debug.openLogs();
  };

  const handleCopyDiagnostics = () => {
    if (!diagnostics) return;

    const text = `Zira AI Diagnostics
=============================
Time: ${new Date().toISOString()}

App Version: ${diagnostics.appVersion}
Electron: ${diagnostics.electron}
Node: ${diagnostics.node}
Platform: ${diagnostics.platform}
User Data: ${diagnostics.userData}

Debug Mode: ${diagnostics.debugMode}
Server Connected: ${diagnostics.connected}
Printer Connected: ${diagnostics.printerConnected}
Scanner Active: ${diagnostics.scannerActive}`;

    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleRefresh = () => {
    setLoading(true);
    loadDiagnostics();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-12">
      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-800 mb-3">
          Debug tools
        </h2>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={handleOpenDevTools}
            className="flex items-center justify-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm transition-colors"
          >
            DevTools (F12)
          </button>
          <button
            onClick={handleOpenLogs}
            className="flex items-center justify-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm transition-colors"
          >
            Logs folder
          </button>
          <button
            onClick={handleCopyDiagnostics}
            className="flex items-center justify-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm transition-colors"
          >
            {copied ? 'Copied!' : 'Copy diagnostics'}
          </button>
          <button
            onClick={handleRefresh}
            className="flex items-center justify-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-800 mb-3">
          System information
        </h2>
        <div className="space-y-2">
          <InfoRow label="App version" value={diagnostics?.appVersion || '-'} />
          <InfoRow label="Electron" value={diagnostics?.electron || '-'} />
          <InfoRow label="Node.js" value={diagnostics?.node || '-'} />
          <InfoRow label="Platform" value={diagnostics?.platform || '-'} />
        </div>
      </div>

      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-800 mb-3">
          Connection status
        </h2>
        <div className="space-y-2">
          <StatusRow
            label="Server"
            status={diagnostics?.connected || false}
            trueText="Connected"
            falseText="Disconnected"
          />
          <StatusRow
            label="Printer"
            status={diagnostics?.printerConnected || false}
            trueText="Connected"
            falseText="Not connected"
          />
          <StatusRow
            label="Scanner"
            status={diagnostics?.scannerActive || false}
            trueText="Active"
            falseText="Inactive"
          />
          <StatusRow
            label="Debug mode"
            status={diagnostics?.debugMode || false}
            trueText="Enabled"
            falseText="Disabled"
          />
        </div>
      </div>

      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-800 mb-3">
          Paths
        </h2>
        <div className="space-y-2">
          <div>
            <div className="text-xs text-slate-500 mb-0.5">User data folder:</div>
            <div className="text-xs font-mono text-slate-700 bg-slate-50 p-1.5 rounded break-all">
              {diagnostics?.userData || '-'}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-amber-800 mb-2">
          Debugging tips
        </h2>
        <ul className="text-xs text-amber-700 space-y-1 list-disc list-inside">
          <li><strong>F12</strong> opens DevTools</li>
          <li><strong>Ctrl+Shift+I</strong> is an alternative DevTools shortcut</li>
          <li><strong>Logs folder</strong> contains detailed application logs</li>
          <li><strong>Copy diagnostics</strong> copies info for bug reports</li>
          <li>To start in debug mode, add <code className="bg-amber-100 px-1 rounded">--debug</code> to launch params</li>
        </ul>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-xs font-medium text-slate-700">{value}</span>
    </div>
  );
}

function StatusRow({
  label,
  status,
  trueText,
  falseText,
}: {
  label: string;
  status: boolean;
  trueText: string;
  falseText: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span
        className={`inline-flex items-center gap-1 text-xs font-medium ${
          status ? 'text-green-600' : 'text-slate-400'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${status ? 'bg-green-500' : 'bg-slate-300'}`}></span>
        {status ? trueText : falseText}
      </span>
    </div>
  );
}
