/**
 * AuthModule
 *
 * Owns authentication flow: Telegram QR login, email login, token management,
 * auto-connect, salon switching, config get/set, and connection management.
 */

import { ipcMain, dialog, shell, safeStorage } from 'electron';
import { join } from 'path';
import { app } from 'electron';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
import {
  IPC_CHANNELS,
  AgentConfig,
  AuthUser,
} from '../../shared/types';
import SocketClient from '../network/socket-client';
import { ApiClient } from '../network/api-client';
import {
  getConfig, setConfig, getConfigValue, setConfigValue,
  setSecureAuthToken, getSecureAuthToken, setSecureApiKey, getSecureApiKey,
  clearSecureTokens,
} from '../config/store';
import { database } from '../database/database';
import logger from '../logger';

/** Simple in-memory rate limiter */
class RateLimiter {
  private attempts: number[] = [];
  constructor(private maxAttempts: number, private windowMs: number) {}
  check(): boolean {
    const now = Date.now();
    this.attempts = this.attempts.filter(t => now - t < this.windowMs);
    if (this.attempts.length >= this.maxAttempts) return false;
    this.attempts.push(now);
    return true;
  }
}

/** Validate URLs for shell:openExternal */
function isValidExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export class AuthModule extends BaseModule {
  readonly name = 'auth';

  private eventBus: EventBus | null = null;
  private loginLimiter = new RateLimiter(5, 60_000); // 5 attempts per minute
  private connectLimiter = new RateLimiter(10, 60_000); // 10 attempts per minute

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[AuthModule] Initialized');
    this.setState(ModuleState.READY);
  }

  registerIpcHandlers(): void {
    // ─── Config ─────────────────────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.GET_CONFIG, () => getConfig());

    ipcMain.handle(IPC_CHANNELS.SET_CONFIG, async (_, config: Partial<AgentConfig>) => {
      const result = setConfig(config);
      // Notify modules (hardware reinit, telegram restart, AI key change, etc.)
      if (this.eventBus) {
        this.eventBus.emit('config:changed', { changedKeys: Object.keys(config) });
      }
      return result;
    });

    // ─── Connection ─────────────────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.CONNECT, async () => {
      if (!this.connectLimiter.check()) return { success: false, error: 'Too many connection attempts. Try again later.' };
      try { await this.connect(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle(IPC_CHANNELS.CONNECT_WITH_API_KEY, async (_, apiKey: string) => {
      if (!this.connectLimiter.check()) return { success: false, error: 'Too many connection attempts. Try again later.' };
      if (!apiKey || typeof apiKey !== 'string') return { success: false, error: 'Invalid API key' };
      try { await this.connectWithApiKey(apiKey); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle(IPC_CHANNELS.DISCONNECT, async () => {
      const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
      socket?.disconnect();
      return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.GET_STATUS, () => {
      const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);

      // Get real hardware status from HardwareModule via container
      let deviceStatus: any = { printerConnected: false, scannerActive: false, appVersion: app.getVersion() };
      const hwModule = this.container.getOptional<any>(SERVICE_TOKENS.HARDWARE_MODULE);
      if (hwModule && typeof hwModule.getDeviceStatus === 'function') {
        deviceStatus = hwModule.getDeviceStatus();
      }

      return {
        connected: socket?.isConnected() || false,
        agentId: getConfigValue('agentId'),
        salonName: getConfigValue('salonName'),
        deviceStatus,
      };
    });

    // ─── Dialog/Debug ───────────────────────────────────────────
    ipcMain.handle('dialog:selectFolder', async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('debug:open-devtools', () => {
      const mainWindow = this.container.getOptional<Electron.BrowserWindow>(SERVICE_TOKENS.MAIN_WINDOW);
      mainWindow?.webContents.openDevTools();
    });

    ipcMain.handle('debug:open-logs', () => {
      shell.openPath(join(app.getPath('userData'), 'logs'));
    });

    ipcMain.handle('debug:get-diagnostics', () => {
      return {
        appVersion: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: `${process.platform} ${process.arch}`,
        memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      };
    });

    // ─── Auto-start ─────────────────────────────────────────────
    ipcMain.handle('app:set-auto-start', (_, enabled: boolean) => {
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
      setConfigValue('autoStart', enabled);
      return { success: true };
    });

    ipcMain.handle('app:get-auto-start', () => {
      return app.getLoginItemSettings().openAtLogin;
    });

    // ─── Shell ──────────────────────────────────────────────────
    ipcMain.handle('shell:openExternal', (_, url: string) => {
      if (!url || !isValidExternalUrl(url)) {
        logger.warn(`[AuthModule] Blocked invalid URL for shell:openExternal: ${url}`);
        return { success: false, error: 'Invalid URL' };
      }
      shell.openExternal(url);
      return { success: true };
    });

    // ─── Auth: Telegram Login ───────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.AUTH_TELEGRAM_LOGIN_TOKEN, async () => {
      try {
        const config = getConfig();
        const serverUrl = config.serverUrl || 'https://api.enail.pro';
        const client = new ApiClient(serverUrl);
        const result = await client.generateTelegramLoginToken();
        return { success: true, data: result };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_CHECK_TOKEN, async (_, loginToken: string) => {
      try {
        const config = getConfig();
        const serverUrl = config.serverUrl || 'https://api.enail.pro';
        const client = new ApiClient(serverUrl);
        const result = await client.checkTelegramLoginToken(loginToken);

        if (result?.access_token && result.status === 'VERIFIED') {
          setSecureAuthToken(result.access_token);
          const user: any = result.user || {};
          const newSalonId = user.salonId || '';
          const currentSalonId = config.salonId || '';

          // Multi-tenant isolation: clear if switching salons
          if (currentSalonId && newSalonId && currentSalonId !== newSalonId) {
            try { database.clearSalonData(); } catch {}
          }

          setConfig({
            authUser: { id: user.id || '', email: user.email || '', firstName: user.firstName || '', lastName: user.lastName || '', role: user.role || '', salonId: newSalonId },
            salonId: newSalonId,
            salonName: result.salon?.name || user.salon?.name || '',
            salonSlug: result.salon?.slug || user.salon?.slug || '',
            posEnabled: true,
            customerDisplayEnabled: true,
          });

          // Auto-connect Socket.IO (same as email login)
          try {
            const existingKey = getConfigValue('apiKey') as string | undefined;
            if (existingKey?.startsWith('pa_')) {
              await this.connectWithApiKey(existingKey);
            } else {
              const keyResult = await client.getMyPrintAgentKey(result.access_token);
              if (keyResult?.apiKey) await this.connectWithApiKey(keyResult.apiKey);
            }
          } catch {}

          return { success: true, data: { status: 'VERIFIED', user: result.user, salon: result.salon } };
        }

        // Return pending or expired status as-is
        return { success: true, data: { status: result?.status || 'PENDING' } };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_REGISTER_TOKEN, async () => {
      try {
        const config = getConfig();
        const client = new ApiClient(config.serverUrl || 'https://api.enail.pro');
        const result = await client.generateRegisterToken();
        return { success: true, data: result };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_GET_USER, async () => {
      try {
        const authToken = getSecureAuthToken();
        if (!authToken) return { success: true, data: { isAuthenticated: false } };
        const config = getConfig();
        const client = new ApiClient(config.serverUrl || 'https://api.enail.pro');
        const user = await client.getMe(authToken);
        const authUser: AuthUser = {
          id: user.id || user.sub || '', email: user.email || '', firstName: user.firstName || '',
          lastName: user.lastName || '', role: user.role || '', salonId: user.salonId || '',
          salonName: user.salon?.name || config.salonName || '',
        };
        setConfig({ authUser });
        return { success: true, data: { isAuthenticated: true, user: authUser } };
      } catch (e: any) {
        clearSecureTokens();
        setConfig({ authUser: { id: '', email: '', firstName: '', lastName: '', role: '', salonId: '' } });
        return { success: true, data: { isAuthenticated: false } };
      }
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async () => {
      try { database.clearSalonData(); } catch {}
      clearSecureTokens();
      // Preserve last salonId so next login can compare correctly
      setConfig({ authUser: { id: '', email: '', firstName: '', lastName: '', role: '', salonId: '' }, salonName: '', salonSlug: '', aiEnabled: false });
      // Notify other modules (AI clears history, telegram stops, etc.)
      this.eventBus?.emit('user:logged-out', { reason: 'user-logout' });
      return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN_EMAIL, async (_, email: string, password: string) => {
      if (!this.loginLimiter.check()) return { success: false, error: 'Too many login attempts. Try again in 1 minute.' };
      if (!email || !password) return { success: false, error: 'Email and password are required' };
      try {
        const config = getConfig();
        const client = new ApiClient(config.serverUrl || 'https://api.enail.pro');
        const result = await client.loginWithEmail(email, password);

        if (result.access_token) {
          const user = result.user;
          const newSalonId = user.salonId || '';
          const currentSalonId = config.salonId || '';

          // Multi-tenant isolation: only clear if switching to a genuinely different salon
          if (currentSalonId && newSalonId && currentSalonId !== newSalonId) {
            try { database.clearSalonData(); } catch {}
          }

          const authUser: AuthUser = {
            id: user.id || user.sub, email: user.email, firstName: user.firstName || '',
            lastName: user.lastName || '', role: user.role, salonId: newSalonId,
            salonName: user.salon?.name || '',
          };

          if (!setSecureAuthToken(result.access_token)) {
            return { success: false, error: 'Failed to store auth token securely' };
          }

          setConfig({ authUser, salonId: authUser.salonId || '', salonName: authUser.salonName || '', salonSlug: user.salon?.slug || '', posEnabled: true, customerDisplayEnabled: true });

          // Auto-connect
          try {
            const existingKey = getConfigValue('apiKey') as string | undefined;
            if (existingKey?.startsWith('pa_')) {
              await this.connectWithApiKey(existingKey);
            } else {
              const keyResult = await client.getMyPrintAgentKey(result.access_token);
              if (keyResult?.apiKey) await this.connectWithApiKey(keyResult.apiKey);
            }
          } catch {}

          return { success: true, data: { user: authUser } };
        }
        return { success: false, error: 'No access token received' };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    // ─── Generic REST API proxy ────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.API_CALL, async (_, method: string, path: string, body?: any) => {
      const token = getSecureAuthToken();
      if (!token) throw new Error('Not authenticated');
      const config = getConfig();
      const client = new ApiClient(config.serverUrl || 'https://api.enail.pro');
      return client.request(method, path, token, body);
    });

    logger.info('[AuthModule] IPC handlers registered');
  }

  // ─── Connection helpers ───────────────────────────────────────

  async connect(): Promise<void> {
    const config = getConfig();
    const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
    if (!socket) throw new Error('Socket not initialized');

    if (config.apiKey?.startsWith('pa_')) {
      await socket.connectWithApiKey(config.serverUrl, config.apiKey);
    } else {
      const token = getSecureApiKey() || '';
      const machineId = config.machineId || '';
      await socket.connect(config.serverUrl, machineId, token);
    }
  }

  async connectWithApiKey(apiKey: string): Promise<void> {
    const config = getConfig();
    const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
    if (!socket) throw new Error('Socket not initialized');

    setSecureApiKey(apiKey);
    setConfig({ apiKey, isPaired: true });
    await socket.connectWithApiKey(config.serverUrl, apiKey);
  }

  getToolDefinitions(): ToolDefinition[] { return []; }

  registerEventHandlers(bus: EventBus): void {
    this.eventBus = bus;
  }

  async start(): Promise<void> {
    // Auto-connect if paired
    const isPaired = getConfigValue('isPaired');
    if (isPaired) {
      try { await this.connect(); } catch (e) { logger.warn('[AuthModule] Auto-connect failed:', e); }
    }
    this.setState(ModuleState.RUNNING);
  }

  async stop(): Promise<void> {
    const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
    socket?.disconnect();
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> { this.setState(ModuleState.STOPPED); }
}
