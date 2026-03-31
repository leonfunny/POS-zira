/**
 * Auto-Updater Module
 *
 * Uses electron-updater with generic provider pointing to Cloudflare R2.
 * Checks for updates on startup and every 30 minutes.
 *
 * Flow:
 *   App starts → fetch latest.yml from R2 → compare versions
 *   → download .exe if newer → notify renderer → user clicks "Install & Restart"
 */

import { autoUpdater } from 'electron-updater';
import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types';
import logger from '../logger';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): () => void {
  // Configure
  autoUpdater.logger = logger;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Helper: send status to renderer
  function sendStatus(data: Record<string, unknown>): void {
    try {
      getMainWindow()?.webContents.send(IPC_CHANNELS.UPDATE_STATUS, data);
    } catch {
      // Window may be destroyed
    }
  }

  // Events → renderer
  autoUpdater.on('checking-for-update', () => {
    logger.info('[AutoUpdater] Checking for updates...');
    sendStatus({ status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    logger.info(`[AutoUpdater] Update available: v${info.version}`);
    sendStatus({ status: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    logger.info('[AutoUpdater] App is up to date');
    sendStatus({ status: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendStatus({
      status: 'downloading',
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    logger.info(`[AutoUpdater] Update downloaded: v${info.version}`);
    sendStatus({ status: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    logger.error('[AutoUpdater] Error:', err.message);
    sendStatus({ status: 'error', error: err.message });
  });

  // IPC handlers
  ipcMain.handle(IPC_CHANNELS.CHECK_FOR_UPDATES, async () => {
    try {
      return await autoUpdater.checkForUpdates();
    } catch (err: any) {
      logger.error('[AutoUpdater] Manual check failed:', err.message);
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.INSTALL_UPDATE, () => {
    logger.info('[AutoUpdater] Installing update and restarting...');
    autoUpdater.quitAndInstall(false, true);
  });

  // Initial check after 10 seconds (let app finish loading)
  const initialTimeout = setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      logger.warn('[AutoUpdater] Initial check failed:', err.message);
    });
  }, 10_000);

  // Periodic check
  const periodicInterval = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      logger.warn('[AutoUpdater] Periodic check failed:', err.message);
    });
  }, CHECK_INTERVAL_MS);

  logger.info('[AutoUpdater] Initialized (check interval: 30 min)');

  // Return cleanup function for graceful shutdown
  return () => {
    clearTimeout(initialTimeout);
    clearInterval(periodicInterval);
    autoUpdater.removeAllListeners();
    logger.info('[AutoUpdater] Cleaned up');
  };
}
