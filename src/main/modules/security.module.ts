/**
 * SecurityModule
 *
 * Manages the Python AI security engine lifecycle:
 * - Spawns/stops the multi-process Python engine
 * - Handles alerts (save evidence, Telegram)
 * - Serves IPC to renderer (status, config, alerts, analytics)
 */

import { ipcMain, BrowserWindow } from 'electron';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import { SERVICE_TOKENS } from '../core/tokens';
import { PythonBridge } from '../security/python-bridge';
import { AlertHandler } from '../security/alert-handler';
import { EvidenceStore } from '../security/evidence-store';
import { getConfigValue, setConfigValue } from '../config/store';
import { IPC_CHANNELS } from '../../shared/types';
import type { SecurityConfig, SecurityStatus, SecurityAlert, SecurityAnalytics } from '../../shared/types';
import logger from '../logger';

export class SecurityModule extends BaseModule {
  readonly name = 'security';

  private bridge: PythonBridge | null = null;
  private alertHandler: AlertHandler | null = null;
  private evidenceStore: EvidenceStore | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[SecurityModule] Initializing...');
    this.evidenceStore = new EvidenceStore();
    this.bridge = new PythonBridge();
    this.container.set(SERVICE_TOKENS.SECURITY_MODULE, this);
    this.setState(ModuleState.READY);
  }

  async start(): Promise<void> {
    const config = getConfigValue('security') as SecurityConfig | undefined;
    if (config?.enabled && config?.cameras?.length > 0) {
      await this.startEngine(config);
    }
    this.setState(ModuleState.RUNNING);
    logger.info('[SecurityModule] Started');
  }

  private async startEngine(config: SecurityConfig): Promise<void> {
    if (!this.bridge || !this.evidenceStore) return;

    // Guard against double-start: stop first if already running
    if (this.bridge.isRunning) {
      await this.bridge.stop();
    }

    // Remove old listeners before adding new ones (prevent accumulation)
    this.bridge.removeAllListeners();

    this.alertHandler = new AlertHandler(this.evidenceStore, this.container, config);

    this.bridge.on('alert', (alert: SecurityAlert) => {
      // Generate alert ID if missing (Python engine may not set it)
      if (!alert.id) {
        alert.id = `alert-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      }
      this.alertHandler?.handleAlert(alert);
      this.emitToRenderer(IPC_CHANNELS.SECURITY_ALERT, alert);
    });

    this.bridge.on('status', (status: SecurityStatus) => {
      this.emitToRenderer(IPC_CHANNELS.SECURITY_STATUS_CHANGED, status);
    });

    this.bridge.on('analytics', (data: SecurityAnalytics) => {
      this.evidenceStore?.saveAnalytics(data);
    });

    this.bridge.on('error', (err: any) => {
      logger.error('[SecurityModule] Engine error:', err);
    });

    this.bridge.on('exit', (code: number) => {
      logger.warn(`[SecurityModule] Engine exited with code ${code}`);
    });

    try {
      await this.bridge.start(config);
      logger.info('[SecurityModule] Engine started');
    } catch (err) {
      logger.error('[SecurityModule] Failed to start engine:', err);
    }

    // Clear old cleanup timer before setting new one
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    // Daily evidence cleanup
    this.cleanupTimer = setInterval(() => {
      this.evidenceStore?.cleanup(config.evidenceRetentionDays || 30);
    }, 24 * 60 * 60 * 1000);
  }

  private emitToRenderer(channel: string, data: any): void {
    const mainWindow = this.container.getOptional<BrowserWindow>(SERVICE_TOKENS.MAIN_WINDOW);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  }

  registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.SECURITY_GET_STATUS, async (): Promise<SecurityStatus> => {
      if (!this.bridge?.isRunning) {
        return { running: false, cameras: [], totalInferenceFps: 0, uptime: 0 };
      }
      try {
        return await this.bridge.getStatus();
      } catch {
        return { running: false, cameras: [], totalInferenceFps: 0, uptime: 0 };
      }
    });

    ipcMain.handle(IPC_CHANNELS.SECURITY_GET_CONFIG, (): SecurityConfig | null => {
      return (getConfigValue('security') as SecurityConfig) || null;
    });

    ipcMain.handle(IPC_CHANNELS.SECURITY_SET_CONFIG, async (_event, config: SecurityConfig) => {
      // Basic validation
      if (!config || typeof config !== 'object') {
        return { success: false, error: 'Invalid config' };
      }
      if (config.cameras && !Array.isArray(config.cameras)) {
        return { success: false, error: 'cameras must be an array' };
      }
      // Sanitize camera RTSP URLs (strip control characters)
      if (config.cameras) {
        for (const cam of config.cameras) {
          if (cam.rtspSubstream) {
            cam.rtspSubstream = cam.rtspSubstream.replace(/[\x00-\x1f]/g, '');
          }
          if (cam.rtspMainstream) {
            cam.rtspMainstream = cam.rtspMainstream.replace(/[\x00-\x1f]/g, '');
          }
        }
      }
      setConfigValue('security', config);
      return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.SECURITY_START, async () => {
      const config = getConfigValue('security') as SecurityConfig | undefined;
      if (!config) return { success: false, error: 'No security config' };
      try {
        await this.startEngine(config);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.SECURITY_STOP, async () => {
      try {
        await this.bridge?.stop();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.SECURITY_RESTART_CAMERA, async (_event, cameraId: string) => {
      // Hot restart a single camera (remove + re-add)
      const config = getConfigValue('security') as SecurityConfig | undefined;
      if (!config || !this.bridge?.isRunning) return { success: false, error: 'Not running' };

      const cam = config.cameras.find(c => c.id === cameraId);
      if (!cam) return { success: false, error: 'Camera not found' };

      try {
        await this.bridge.removeCamera(cameraId);
        await this.bridge.addCamera(cam);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.SECURITY_GET_ALERTS, async (_event, limit?: number, cameraId?: string) => {
      return this.evidenceStore?.getAlerts(limit || 50, cameraId) || [];
    });

    ipcMain.handle(IPC_CHANNELS.SECURITY_CLEAR_ALERTS, async () => {
      this.evidenceStore?.clearAlerts();
      return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.SECURITY_GET_ANALYTICS, async (_event, cameraId: string, date: string) => {
      return this.evidenceStore?.getAnalytics(cameraId, date) || null;
    });

    logger.info('[SecurityModule] IPC handlers registered');
  }

  registerEventHandlers(bus: EventBus): void {
    bus.on('config:changed', async (payload) => {
      if (payload.changedKeys.some((k: string) => k.startsWith('security'))) {
        logger.info('[SecurityModule] Config changed');
        const config = getConfigValue('security') as SecurityConfig | undefined;
        if (this.alertHandler && config) {
          this.alertHandler.updateConfig(config);
        }
      }
    });

    bus.on('user:logged-out', async () => {
      logger.info('[SecurityModule] User logged out, stopping engine');
      await this.bridge?.stop();
    });
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.bridge?.stop();
    this.setState(ModuleState.STOPPED);
    logger.info('[SecurityModule] Stopped');
  }

  async destroy(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.bridge?.removeAllListeners();
    this.bridge = null;
    this.alertHandler = null;
    this.evidenceStore = null;
    this.setState(ModuleState.DESTROYED);
  }
}
