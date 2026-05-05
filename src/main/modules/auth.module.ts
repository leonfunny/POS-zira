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
import { authEvents, AUTH_EXPIRED, forwardAuthExpiredToRenderer } from '../network/auth-refresh';
import { resolveCurrentUser } from '../network/auth-get-user';
import {
  getConfig, setConfig, getConfigValue, setConfigValue,
  setSecureAuthToken, getSecureAuthToken, setSecureApiKey, getSecureApiKey,
  setSecureRefreshToken,
  setSecureAiApiKey, setSecureRemotePin, getSecureRemotePin,
  clearSecureTokens, clearSecureAuthTokens,
} from '../config/store';
import { database } from '../database/database';
import { listWindowsPrintersDetailed } from '../hardware/port-utils';
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
    // Subscribe to auth-expired emitted by the refresh helper. When
    // refreshAccessToken returns refresh-rejected, the user-session
    // is unrecoverable and we forward the signal to the renderer so
    // useAuth can drop straight to AuthScreen without waiting for the
    // next IPC poll cycle. Forwarder logic is in auth-refresh.ts so
    // its destroyed-window guard + channel-name spelling are pinned
    // by auth-expired-wiring.test.ts behaviour tests.
    authEvents.on(
      AUTH_EXPIRED,
      forwardAuthExpiredToRenderer(() =>
        this.container.getOptional<Electron.BrowserWindow>(SERVICE_TOKENS.MAIN_WINDOW),
      ),
    );

    logger.info('[AuthModule] Initialized');
    this.setState(ModuleState.READY);
  }

  registerIpcHandlers(): void {
    // ─── Config ─────────────────────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.GET_CONFIG, () => getConfig());

    ipcMain.handle(IPC_CHANNELS.SET_CONFIG, async (_, config: Partial<AgentConfig>) => {
      // SECURITY: Block sensitive fields that should not be settable from the renderer
      const blockedFields = new Set([
        'serverUrl',        // Could redirect auth to malicious server
        'apiKey',           // Credential — set through proper auth flow only
        'encryptedToken',   // Credential — managed internally
        'agentId',          // Server-assigned
        'salonId',          // Server-assigned
        'machineId',        // Server-assigned
        'entitlements',     // SuperAdmin-controlled, server-assigned
        'authToken',        // Auth credential — set through login flow
        'encryptedRefreshToken', // Managed internally by safeStorage (refresh-on-401 flow)
        'authUser',         // Set through login flow
        'aiApiKey',              // Credential — set through AUTH_SET_AI_API_KEY only
        'encryptedAiApiKey',     // Managed internally by safeStorage
        'encryptedTelegramToken', // Managed internally by safeStorage
        'remoteAccessPin',       // Credential — set through AUTH_SET_REMOTE_PIN only
        'encryptedRemotePin',    // Managed internally by safeStorage
      ]);

      const sanitized: Partial<AgentConfig> = {};
      for (const [key, value] of Object.entries(config)) {
        if (blockedFields.has(key)) {
          logger.warn(`[AuthModule] SET_CONFIG: blocked attempt to set restricted field "${key}"`);
          continue;
        }
        (sanitized as any)[key] = value;
      }

      if (Object.keys(sanitized).length === 0) {
        return getConfig(); // Nothing to set after filtering
      }

      const result = setConfig(sanitized);
      // Notify modules (hardware reinit, telegram restart, AI key change, etc.)
      if (this.eventBus) {
        this.eventBus.emit('config:changed', { changedKeys: Object.keys(sanitized) });
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

    // ─── Salon Switch ─────────────────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.AUTH_CHANGE_SALON, async () => {
      try {
        const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
        socket?.disconnect();
        setSecureApiKey('');
        setConfig({
          apiKey: '', agentId: '', salonId: '', salonName: '', salonSlug: '',
          isPaired: false,
        });
        logger.info('[AuthModule] Salon changed — credentials cleared, socket disconnected');
        return { success: true };
      } catch (e: any) {
        logger.error('[AuthModule] Change salon failed:', e);
        return { success: false, error: e.message };
      }
    });

    // ─── Secure Key Setters ────────────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.AUTH_SET_AI_API_KEY, async (_, key: string) => {
      if (typeof key !== 'string') return { success: false, error: 'Invalid key' };
      const ok = setSecureAiApiKey(key);
      if (ok && this.eventBus) {
        this.eventBus.emit('config:changed', { changedKeys: ['aiApiKey'] });
      }
      return { success: ok, error: ok ? undefined : 'Encryption not available' };
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_SET_REMOTE_PIN, async (_, pin: string) => {
      if (typeof pin !== 'string') return { success: false, error: 'Invalid PIN' };
      const sanitized = pin.replace(/[^0-9]/g, '').slice(0, 6);
      const ok = setSecureRemotePin(sanitized);
      return { success: ok, error: ok ? undefined : 'Encryption not available' };
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_GET_REMOTE_PIN, async () => {
      return { success: true, pin: getSecureRemotePin() || '' };
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
          // Backend's auth response carries a refresh_token alongside the
          // access token (auth.service.ts:571-572). Persist it now so the
          // 401-retry flow can rotate without forcing a relogin every
          // time JWT_EXPIRES_IN ticks over.
          if (result.refresh_token) setSecureRefreshToken(result.refresh_token);
          const user: any = result.user || {};
          const newSalonId = user.salonId || '';
          const currentSalonId = config.salonId || '';

          // Multi-tenant isolation: clear if switching salons
          if (currentSalonId && newSalonId && currentSalonId !== newSalonId) {
            try { database.clearSalonData(); } catch (err: any) { logger.debug('[AuthModule] clear salon data on telegram login failed:', err?.message); }
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
            const existingKey = getSecureApiKey();
            if (existingKey?.startsWith('pa_')) {
              await this.connectWithApiKey(existingKey);
            } else {
              const keyResult = await client.getMyPrintAgentKey(result.access_token);
              if (keyResult?.apiKey) await this.connectWithApiKey(keyResult.apiKey);
            }
          } catch (err: any) { logger.debug('[AuthModule] auto-connect after telegram login failed:', err?.message); }

          // Trigger post-login sync (clearSalonData may have wiped products while socket was already connected)
          if (this.eventBus) this.eventBus.emit('user:logged-in', { userId: user.id || '', salonId: newSalonId, salonName: result.salon?.name });

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
      const config = getConfig();
      const client = new ApiClient(config.serverUrl || 'https://api.enail.pro');
      // Branching logic lives in the pure helper resolveCurrentUser
      // (network/auth-get-user.ts) — see auth-get-user-startup.test.ts
      // for the per-branch behaviour spec. The handler here is only
      // wiring: pass real dependencies in, run the helper, return its
      // result verbatim.
      return resolveCurrentUser({
        getAuthToken: getSecureAuthToken,
        getMe: (token) => client.getMe(token),
        getCachedAuthUser: () => config.authUser as AuthUser | undefined,
        defaultSalonName: config.salonName,
        onAuthRejected: () => {
          clearSecureAuthTokens();
          setConfig({ authUser: { id: '', email: '', firstName: '', lastName: '', role: '', salonId: '' } });
        },
        onUserResolved: (authUser) => setConfig({ authUser }),
      });
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async () => {
      try { database.clearSalonData(); } catch (err: any) { logger.debug('[AuthModule] clear salon data on logout failed:', err?.message); }
      const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
      socket?.disconnect();
      clearSecureTokens();
      setConfig({
        authUser: { id: '', email: '', firstName: '', lastName: '', role: '', salonId: '' },
        salonName: '', salonSlug: '', salonCode: '', aiEnabled: false,
        isPaired: false, agentId: '', salonId: '',
      });
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
            try { database.clearSalonData(); } catch (err: any) { logger.debug('[AuthModule] clear salon data on email login failed:', err?.message); }
          }

          const authUser: AuthUser = {
            id: user.id || user.sub, email: user.email, firstName: user.firstName || '',
            lastName: user.lastName || '', role: user.role, salonId: newSalonId,
            salonName: user.salon?.name || '',
          };

          if (!setSecureAuthToken(result.access_token)) {
            return { success: false, error: 'Failed to store auth token securely' };
          }
          // Persist refresh_token alongside access_token so the
          // refresh-on-401 flow can rotate the session without
          // forcing the cashier back to AuthScreen every JWT TTL.
          // Backend response shape: auth.service.ts:758-762.
          if (result.refresh_token) setSecureRefreshToken(result.refresh_token);

          setConfig({ authUser, salonId: authUser.salonId || '', salonName: authUser.salonName || '', salonSlug: user.salon?.slug || '', posEnabled: true, customerDisplayEnabled: true });

          // Auto-connect
          try {
            const existingKey = getSecureApiKey();
            if (existingKey?.startsWith('pa_')) {
              await this.connectWithApiKey(existingKey);
            } else {
              const keyResult = await client.getMyPrintAgentKey(result.access_token);
              if (keyResult?.apiKey) await this.connectWithApiKey(keyResult.apiKey);
            }
          } catch (err: any) { logger.debug('[AuthModule] auto-connect after email login failed:', err?.message); }

          // Trigger post-login sync (clearSalonData may have wiped products while socket was already connected)
          if (this.eventBus) this.eventBus.emit('user:logged-in', { userId: authUser.id, salonId: authUser.salonId || '', salonName: authUser.salonName });

          return { success: true, data: { user: authUser } };
        }
        return { success: false, error: 'No access token received' };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    // ─── Generic REST API proxy ────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.API_CALL, async (_, method: string, path: string, body?: any) => {
      const token = getSecureAuthToken();
      if (!token) throw new Error('Not authenticated');

      // SECURITY: Validate HTTP method
      const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
      if (!allowedMethods.includes(method.toUpperCase())) {
        throw new Error(`Invalid HTTP method: ${method}`);
      }

      // SECURITY: Only allow print-agent API paths to prevent privilege escalation
      const allowedPrefixes = ['/api/v1/print-agent/', '/api/v1/salons/'];
      if (!allowedPrefixes.some(prefix => path.startsWith(prefix))) {
        throw new Error(`API path not allowed: ${path}. Only print-agent and salon APIs are accessible.`);
      }

      // SECURITY: Block path traversal
      if (path.includes('..') || path.includes('//')) {
        throw new Error('Invalid API path');
      }

      const config = getConfig();
      const client = new ApiClient(config.serverUrl || 'https://api.enail.pro');
      return client.request(method.toUpperCase(), path, token, body);
    });

    logger.info('[AuthModule] IPC handlers registered');
  }

  // ─── Connection helpers ───────────────────────────────────────

  async connect(): Promise<void> {
    const config = getConfig();
    const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
    if (!socket) throw new Error('Socket not initialized');

    const apiKey = getSecureApiKey();
    if (apiKey?.startsWith('pa_')) {
      await this.connectWithApiKey(apiKey);
    } else {
      const machineId = config.machineId || '';
      await socket.connect(config.serverUrl, machineId, apiKey || '');
    }
  }

  async connectWithApiKey(apiKey: string): Promise<void> {
    const config = getConfig();
    const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
    if (!socket) throw new Error('Socket not initialized');

    setSecureApiKey(apiKey);

    // Call REST /print-agent/connect to populate salonName, salonId, agentId, salonSlug
    try {
      const client = new ApiClient(config.serverUrl || 'https://api.enail.pro');
      const response = await client.connectWithApiKey(apiKey);
      if (this.eventBus) {
        const changedKeys = ['apiKey', 'agentId', 'salonId', 'salonName', 'salonSlug', 'salonCode', 'serverUrl', 'isPaired'];
        if (response.printers?.length) changedKeys.push('printers', 'multiPrinterMode');
        this.eventBus.emit('config:changed', { changedKeys });
      }
      await this.syncWindowsPrintersWithBackend(apiKey);
    } catch (err: any) {
      logger.warn('[AuthModule] REST connect failed, proceeding with socket only:', err?.message);
      setConfig({ isPaired: true });
    }

    const latestConfig = getConfig();
    await socket.connectWithApiKey(latestConfig.serverUrl || 'https://api.enail.pro', apiKey);
  }

  private async syncWindowsPrintersWithBackend(apiKey?: string): Promise<void> {
    if (process.platform !== 'win32') {
      logger.debug('[AuthModule] Skipping Windows printer sync on non-Windows platform');
      return;
    }

    const key = apiKey || getSecureApiKey();
    if (!key?.startsWith('pa_')) return;

    try {
      const config = getConfig();
      const printers = await listWindowsPrintersDetailed();
      const client = new ApiClient(config.serverUrl || 'https://api.enail.pro');
      const result = await client.syncWindowsPrinters(
        key,
        printers.map((printer) => ({ name: printer.name, isDefault: !!printer.isDefault })),
      );
      logger.info(`[AuthModule] Synced ${result.count} Windows printer(s) to backend`);
    } catch (err: any) {
      logger.warn('[AuthModule] Windows printer sync failed:', err?.message);
    }
  }

  getToolDefinitions(): ToolDefinition[] { return []; }

  registerEventHandlers(bus: EventBus): void {
    this.eventBus = bus;
    bus.on('socket:connected', () => {
      void this.syncWindowsPrintersWithBackend().catch((err: any) => {
        logger.debug('[AuthModule] Windows printer sync on socket connect failed:', err?.message);
      });
    });
  }

  async start(): Promise<void> {
    // Auto-connect if paired — but only if credentials actually exist
    const isPaired = getConfigValue('isPaired');
    if (isPaired) {
      const config = getConfig();
      const secureKey = getSecureApiKey();
      const hasApiKey = secureKey?.startsWith('pa_');
      const hasMachineId = !!config.machineId;

      if (hasApiKey || (secureKey && hasMachineId)) {
        try { await this.connect(); } catch (e) { logger.warn('[AuthModule] Auto-connect failed:', e); }
      } else {
        logger.error('[AuthModule] isPaired=true but no valid credentials found (apiKey=%s, machineId=%s). Resetting isPaired.',
          hasApiKey, hasMachineId);
        setConfig({ isPaired: false });
      }
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
