import React, { useEffect, useState } from 'react';
import rlog from '../utils/logger';

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

interface BackupStatus {
  backupDir: string;
  lastStatus?: 'success' | 'failed';
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastPath?: string;
  lastError?: string;
  pendingRestorePath?: string;
  pendingRestoreSourcePath?: string;
  pendingRestoreRequestedAt?: string;
  restoreLastStatus?: 'pending' | 'success' | 'failed';
  restoreLastError?: string;
  restoreLastSourcePath?: string;
  restoreLastSafetyBackupPath?: string;
  restoreLastAppliedAt?: string;
}

interface BackupListItem {
  name: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  isLatest: boolean;
}

export default function Debug() {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsData | null>(null);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [backups, setBackups] = useState<BackupListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [backupRunning, setBackupRunning] = useState(false);
  const [restorePath, setRestorePath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadDiagnostics = async () => {
    try {
      rlog.info('[Debug] Loading diagnostics...');
      const [data, backup, backupList] = await Promise.all([
        window.electronAPI.debug.getDiagnostics(),
        window.electronAPI.backup.getStatus(),
        window.electronAPI.backup.list(),
      ]);
      rlog.info('[Debug] Diagnostics loaded:', data);
      setDiagnostics(data);
      setBackupStatus(backup);
      setBackups(backupList.slice(0, 10));
    } catch (error) {
      rlog.error('[Debug] Failed to load diagnostics:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDiagnostics();
  }, []);

  const handleOpenDevTools = async () => {
    rlog.info('[Debug] Opening DevTools...');
    await window.electronAPI.debug.openDevTools();
  };

  const handleOpenLogs = async () => {
    rlog.info('[Debug] Opening logs folder...');
    await window.electronAPI.debug.openLogs();
  };

  const handleBackupNow = async () => {
    setBackupRunning(true);
    try {
      await window.electronAPI.backup.runNow();
      const [backup, backupList] = await Promise.all([
        window.electronAPI.backup.getStatus(),
        window.electronAPI.backup.list(),
      ]);
      setBackupStatus(backup);
      setBackups(backupList.slice(0, 10));
    } catch (error) {
      rlog.error('[Debug] Backup now failed:', error);
    } finally {
      setBackupRunning(false);
    }
  };

  const handleOpenBackupFolder = async () => {
    await window.electronAPI.backup.openFolder();
  };

  const handleOpenDataFolder = async () => {
    await window.electronAPI.backup.openDataFolder();
  };

  const handlePrepareRestore = async (backup: BackupListItem) => {
    const confirmed = window.confirm(
      `Restore ${backup.name} on next restart?\n\nThe current database will be safety-backed-up before restore is applied.`,
    );
    if (!confirmed) return;

    setRestorePath(backup.path);
    try {
      const result = await window.electronAPI.backup.prepareRestore(backup.path);
      if (!result.success) {
        window.alert(result.error || 'Restore could not be prepared');
        return;
      }
      const status = await window.electronAPI.backup.getStatus();
      setBackupStatus(status);
    } catch (error) {
      rlog.error('[Debug] Prepare restore failed:', error);
    } finally {
      setRestorePath(null);
    }
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
Scanner Active: ${diagnostics.scannerActive}

Backup Status: ${backupStatus?.lastStatus || 'never'}
Last Backup Run: ${backupStatus?.lastRunAt || '-'}
Last Successful Backup: ${backupStatus?.lastSuccessAt || '-'}
Backup Folder: ${backupStatus?.backupDir || '-'}
Restore Status: ${backupStatus?.restoreLastStatus || '-'}
Pending Restore: ${backupStatus?.pendingRestoreSourcePath || '-'}`;

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
          Database backup
        </h2>
        <div className="space-y-2 mb-3">
          <InfoRow label="Last status" value={formatStatus(backupStatus?.lastStatus)} />
          <InfoRow label="Last run" value={formatDateTime(backupStatus?.lastRunAt)} />
          <InfoRow label="Last successful" value={formatDateTime(backupStatus?.lastSuccessAt)} />
          {backupStatus?.lastError && (
            <div>
              <div className="text-xs text-slate-500 mb-0.5">Last error:</div>
              <div className="text-xs font-mono text-red-700 bg-red-50 p-1.5 rounded break-all">
                {backupStatus.lastError}
              </div>
            </div>
          )}
          {backupStatus?.pendingRestoreSourcePath && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
              Restore pending from {backupStatus.pendingRestoreSourcePath}. Restart the app to apply it.
            </div>
          )}
          {backupStatus?.restoreLastStatus === 'failed' && backupStatus.restoreLastError && (
            <div>
              <div className="text-xs text-slate-500 mb-0.5">Last restore error:</div>
              <div className="text-xs font-mono text-red-700 bg-red-50 p-1.5 rounded break-all">
                {backupStatus.restoreLastError}
              </div>
            </div>
          )}
          <div>
            <div className="text-xs text-slate-500 mb-0.5">Backup folder:</div>
            <div className="text-xs font-mono text-slate-700 bg-slate-50 p-1.5 rounded break-all">
              {backupStatus?.backupDir || '-'}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={handleBackupNow}
            disabled={backupRunning}
            className="flex items-center justify-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-60 text-slate-700 rounded-lg text-sm transition-colors"
          >
            {backupRunning ? 'Backing up...' : 'Backup now'}
          </button>
          <button
            onClick={handleOpenBackupFolder}
            className="flex items-center justify-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm transition-colors"
          >
            Backup folder
          </button>
          <button
            onClick={handleOpenDataFolder}
            className="flex items-center justify-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm transition-colors"
          >
            Data folder
          </button>
        </div>
        <div className="mt-4">
          <h3 className="text-xs font-semibold text-slate-700 mb-2">Recent backups</h3>
          {backups.length === 0 ? (
            <div className="text-xs text-slate-400 bg-slate-50 rounded p-2">No backups found</div>
          ) : (
            <div className="space-y-2">
              {backups.map((backup) => (
                <div
                  key={backup.path}
                  className="flex items-center justify-between gap-3 border border-slate-100 rounded-lg p-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-slate-700 truncate">
                      {backup.name}{backup.isLatest ? ' (latest)' : ''}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {formatDateTime(backup.createdAt)} - {formatBytes(backup.sizeBytes)}
                    </div>
                  </div>
                  <button
                    onClick={() => handlePrepareRestore(backup)}
                    disabled={restorePath === backup.path}
                    className="shrink-0 px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 disabled:opacity-60 text-slate-700 rounded-lg text-xs transition-colors"
                  >
                    {restorePath === backup.path ? 'Staging...' : 'Restore'}
                  </button>
                </div>
              ))}
            </div>
          )}
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

function formatDateTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatStatus(value?: string): string {
  if (value === 'success') return 'Success';
  if (value === 'failed') return 'Failed';
  if (value === 'pending') return 'Pending';
  return 'Never';
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
