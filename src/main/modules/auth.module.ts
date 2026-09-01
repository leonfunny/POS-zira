/**
 * AuthModule
 *
 * Owns authentication flow: Telegram QR login, email login, token management,
 * auto-connect, salon switching, config get/set, and connection management.
 */

import { ipcMain, dialog, shell, safeStorage, BrowserWindow } from 'electron';
import { join } from 'path';
import { app } from 'electron';
import { randomUUID } from 'crypto';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
import {
  IPC_CHANNELS,
  AgentConfig,
  AuthUser,
  ConnectResponse,
  AgentPrintersResponse,
  KitchenTicketData,
  LanFirstKitchenPairingCodeRequest,
  LanFirstKitchenTestRouteRequest,
  LanFirstKitchenTestRouteResponse,
  LanFirstPrintPayloadHashInput,
  ReserveLanFirstPrintJobRequest,
  SalonPrinterRole,
  SalonPrintersListOptions,
  ServerPrinterMapping,
} from '../../shared/types';
import SocketClient from '../network/socket-client';
import {
  ApiClient,
  normalizeServerPrinterRows,
  pruneRecoveredWindowsPrinterOverrides,
} from '../network/api-client';
import { authEvents, AUTH_EXPIRED, forwardAuthExpiredToRenderer } from '../network/auth-refresh';
import { resolveCurrentUser } from '../network/auth-get-user';
import { resolveStartupConnectPlan } from '../network/startup-connect-plan';
import {
  getConfig, setConfig, getConfigValue, setConfigValue,
  setSecureAuthToken, getSecureAuthToken, setSecureApiKey, getSecureApiKey,
  setSecureRefreshToken,
  setSecureAiApiKey, setSecureRemotePin, getSecureRemotePin,
  clearSecureTokens, clearSecureAuthTokens,
} from '../config/store';
import { ensureReceiptPrinterEnabledOnBoot } from '../config/ensure-receipt-enabled';
import { fetchEntitlementsFromBackend } from '../entitlements/entitlements-controller';
import { database } from '../database/database';
import type { BackupRunReason, LocalBackupService } from '../database/backup-service';
import { localPrinterRepo } from '../database/repos/local-printer-repo';
import { listWindowsPrintersDetailed } from '../hardware/port-utils';
import logger from '../logger';
import { buildLanFirstAuthHeaders } from '../printing/lan-first-auth';
import { hashLanFirstPrintPayload } from '../printing/lan-first-payload-hash';

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

function getRendererConfig(): AgentConfig {
  const config = getConfig();
  let sanitized: AgentConfig = {
    ...config,
    apiKey: '',
    authToken: '',
    aiApiKey: '',
    telegramToken: '',
    remoteAccessPin: '',
    booksy: config.booksy ? {
      ...config.booksy,
      enailJwt: '',
      encryptedEnailJwt: '',
      telegramBotToken: '',
      hasJwt: !!(config.booksy.enailJwt || config.booksy.encryptedEnailJwt),
    } : config.booksy,
  };

  const hidden = sanitized as AgentConfig & Record<string, unknown>;
  hidden.encryptedToken = '';
  hidden.encryptedAuthToken = '';
  hidden.encryptedRefreshToken = '';
  hidden.encryptedApiKey = '';
  hidden.encryptedAiApiKey = '';
  hidden.encryptedTelegramToken = '';
  hidden.encryptedRemotePin = '';
  sanitized = sanitizeLanFirstSecretsForRenderer(sanitized);
  return sanitized;
}

function sanitizeLanFirstSecretsForRenderer(config: AgentConfig): AgentConfig {
  return {
    ...config,
    lanFirstReceiver: config.lanFirstReceiver ? {
      ...config.lanFirstReceiver,
      auth: config.lanFirstReceiver.auth ? {
        ...config.lanFirstReceiver.auth,
        sharedSecret: '',
      } : config.lanFirstReceiver.auth,
    } : config.lanFirstReceiver,
    lanFirstKitchenSender: config.lanFirstKitchenSender ? {
      ...config.lanFirstKitchenSender,
      auth: config.lanFirstKitchenSender.auth ? {
        ...config.lanFirstKitchenSender.auth,
        sharedSecret: '',
      } : config.lanFirstKitchenSender.auth,
    } : config.lanFirstKitchenSender,
  };
}

function sanitizeLanFirstSecretsFromRendererUpdate(config: Partial<AgentConfig>): Partial<AgentConfig> {
  if (!config.lanFirstReceiver && !config.lanFirstKitchenSender) return config;

  const current = getConfig();
  const sanitized: Partial<AgentConfig> = { ...config };

  if (config.lanFirstReceiver) {
    const currentAuth = current.lanFirstReceiver?.auth || {};
    const incomingAuth = config.lanFirstReceiver.auth || {};
    sanitized.lanFirstReceiver = {
      ...config.lanFirstReceiver,
      auth: {
        ...currentAuth,
        ...incomingAuth,
        sharedSecret: currentAuth.sharedSecret || '',
      },
    };
  }

  if (config.lanFirstKitchenSender) {
    const currentAuth = current.lanFirstKitchenSender?.auth || {};
    const incomingAuth = config.lanFirstKitchenSender.auth || {};
    sanitized.lanFirstKitchenSender = {
      ...config.lanFirstKitchenSender,
      auth: {
        ...currentAuth,
        ...incomingAuth,
        sharedSecret: currentAuth.sharedSecret || '',
      },
    };
  }

  return sanitized;
}

function sanitizeKitchenPairingCode(value: unknown): string {
  return String(value || '').replace(/[^0-9]/g, '').slice(0, 6);
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function resolveAuthSalonId(payload: any): string {
  const user = payload?.user ?? payload ?? {};
  return user.salonId || user.salon_id || user.salon?.id || payload?.salon?.id || '';
}

function resolveAuthSalonName(payload: any): string {
  const user = payload?.user ?? payload ?? {};
  return payload?.salon?.name || user.salon?.name || user.salonName || '';
}

function resolveAuthSalonSlug(payload: any): string {
  const user = payload?.user ?? payload ?? {};
  return payload?.salon?.slug || user.salon?.slug || user.salonSlug || '';
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

  private notifyConfigChanged(changedKeys: string[]): void {
    if (this.eventBus) {
      this.eventBus.emit('config:changed', { changedKeys });
    }
    // Ping only, no payload: each window re-fetches via get-config so
    // sanitized config remains the only renderer-visible config shape.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try { win.webContents.send('config-updated'); } catch { /* window closing */ }
      }
    }
  }

  registerIpcHandlers(): void {
    // ─── Config ─────────────────────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.GET_CONFIG, () => getRendererConfig());

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

      const safeConfig = sanitizeLanFirstSecretsFromRendererUpdate(sanitized);

      if (Object.keys(safeConfig).length === 0) {
        return getRendererConfig(); // Nothing to set after filtering
      }

      setConfig(safeConfig);
      // Notify modules (hardware reinit, telegram restart, AI key change, etc.)
      if (this.eventBus) {
        this.eventBus.emit('config:changed', { changedKeys: Object.keys(safeConfig) });
      }
      // Notify ALL renderer windows. Settings lives in the main window while
      // the POS window caches config at mount — without this ping a toggle
      // (e.g. showNonFiscalOrders) silently did nothing until app restart.
      // Ping only, no payload: each window re-fetches via get-config so the
      // public kiosk surface never receives config contents it didn't ask for.
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          try { win.webContents.send('config-updated'); } catch { /* window closing */ }
        }
      }
      return getRendererConfig();
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
      setConfigValue('autoStart', enabled);

      if (!app.isPackaged) {
        logger.info('[AutoStart] Skipping OS auto-start configuration in development');
        return { success: true };
      }

      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true,
        path: process.execPath,
        args: ['--hidden'],
      });
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
        // Archive the leaving salon before clearing — abort if it can't be saved.
        const cleared = await this.archiveSalonThenClear(getConfig().salonId || '', 'change salon');
        if (!cleared.ok) {
          return { success: false, error: cleared.error || 'Không lưu được dữ liệu salon hiện tại — huỷ đổi salon' };
        }
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
    ipcMain.handle(IPC_CHANNELS.LAN_FIRST_KITCHEN_GET_PAIRING_STATUS, async () => {
      const config = getConfig();
      return {
        receiverHasPairingCode: !!String(config.lanFirstReceiver?.auth?.sharedSecret || '').trim(),
        senderHasPairingCode: !!String(config.lanFirstKitchenSender?.auth?.sharedSecret || '').trim(),
      };
    });

    ipcMain.handle(IPC_CHANNELS.LAN_FIRST_KITCHEN_SET_PAIRING_CODE, async (_event, request: LanFirstKitchenPairingCodeRequest) => {
      const code = sanitizeKitchenPairingCode(request?.pairingCode);
      if (code.length !== 6) {
        return { success: false, error: 'Pairing code must be 6 digits' };
      }

      const config = getConfig();
      if (request?.scope === 'receiver') {
        setConfig({
          lanFirstReceiver: {
            ...(config.lanFirstReceiver || {}),
            auth: {
              ...(config.lanFirstReceiver?.auth || {}),
              sharedSecret: code,
            },
          },
        });
        this.notifyConfigChanged(['lanFirstReceiver']);
        return { success: true };
      }

      if (request?.scope === 'sender') {
        setConfig({
          lanFirstKitchenSender: {
            ...(config.lanFirstKitchenSender || {}),
            auth: {
              ...(config.lanFirstKitchenSender?.auth || {}),
              sharedSecret: code,
            },
          },
        });
        this.notifyConfigChanged(['lanFirstKitchenSender']);
        return { success: true };
      }

      return { success: false, error: 'Invalid LAN kitchen pairing scope' };
    });

    ipcMain.handle(IPC_CHANNELS.LAN_FIRST_KITCHEN_TEST_ROUTE, async (_event, request: LanFirstKitchenTestRouteRequest): Promise<LanFirstKitchenTestRouteResponse> => {
      const host = String(request?.host || '').trim();
      const port = Number(request?.port);
      if (!host) return { success: false, error: 'Kitchen POS host is required' };
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return { success: false, error: 'Kitchen POS port is invalid' };
      }

      const config = getConfig();
      const typedCode = sanitizeKitchenPairingCode(request?.pairingCode);
      const sharedSecret = typedCode || String(config.lanFirstKitchenSender?.auth?.sharedSecret || '').trim();
      if (!sharedSecret) {
        return { success: false, error: 'Sender pairing code is required' };
      }

      const sourceMachineId = String(config.machineId || '').trim() || 'settings-test';
      const timeoutMs = Number.isInteger(Number(request?.timeoutMs)) ? Math.max(500, Number(request.timeoutMs)) : 2000;
      const testPrint = request?.testPrint === true;
      let endpointPath = '/auth-test';
      let bodyJson = JSON.stringify({ probe: 'LAN_FIRST_KITCHEN_AUTH_TEST' });
      let successStatus = 'AUTH_OK';
      let successMessage = 'Wi-Fi route authenticated';

      if (testPrint) {
        const printerId = String(request?.printerId || '').trim();
        const targetMachineId = String(request?.targetMachineId || '').trim();
        if (!printerId) {
          return { success: false, error: 'Kitchen printer is required for Wi-Fi test print' };
        }
        if (!targetMachineId) {
          return { success: false, error: 'Target kitchen POS machine ID is required for Wi-Fi test print' };
        }

        const referenceId = `settings-test-${randomUUID()}`;
        const ticket: KitchenTicketData = {
          orderId: referenceId,
          orderNumber: 'TEST-WIFI',
          createdAt: new Date().toISOString(),
          source: 'SETTINGS',
          kitchenLanguage: 'en',
          kind: 'TICKET',
          paymentStatus: 'UNPAID',
          items: [
            {
              name: 'TEST WIFI ROUTE',
              quantity: 1,
              unit: null,
              modifiers: [],
              notes: null,
            },
          ],
        };
        const hashInput: LanFirstPrintPayloadHashInput = {
          jobType: 'KITCHEN_TICKET',
          printerType: 'KITCHEN',
          printerId,
          referenceType: 'KITCHEN_TICKET',
          referenceId,
          payload: ticket,
        };
        const printRequest: ReserveLanFirstPrintJobRequest = {
          ...hashInput,
          jobId: randomUUID(),
          idempotencyKey: `settings-test-print:${sourceMachineId}:${printerId}:${randomUUID()}`,
          payloadHash: hashLanFirstPrintPayload(hashInput),
          dispatchMode: 'LAN_FIRST',
          sourceMachineId,
          targetMachineId,
        };
        endpointPath = '/print/kitchen-ticket';
        bodyJson = JSON.stringify(printRequest);
        successStatus = 'COMPLETED';
        successMessage = 'Wi-Fi test print sent';
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`http://${hostForUrl(host)}:${port}${endpointPath}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...buildLanFirstAuthHeaders({
              sourceMachineId,
              sharedSecret,
              bodyJson,
            }),
          },
          body: bodyJson,
          signal: controller.signal,
        });
        const json = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (response.ok && json.success === true) {
          return {
            success: true,
            status: String(json.status || successStatus),
            httpStatus: response.status,
            message: successMessage,
          };
        }
        return {
          success: false,
          status: String(json.status || ''),
          httpStatus: response.status,
          error: String(json.error || json.message || `Receiver returned HTTP ${response.status}`),
        };
      } catch (err: any) {
        return {
          success: false,
          error: err?.name === 'AbortError'
            ? `Wi-Fi ${testPrint ? 'test print' : 'route test'} timed out after ${timeoutMs} ms`
            : err?.message || `Wi-Fi ${testPrint ? 'test print' : 'route test'} failed`,
        };
      } finally {
        clearTimeout(timer);
      }
    });

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
          const user: any = result.user || {};
          const newSalonId = resolveAuthSalonId(result);
          const currentSalonId = config.salonId || '';
          if (!newSalonId) {
            return { success: false, error: 'Login response missing salon id' };
          }

          // Multi-tenant: archive the leaving salon (abort if it can't be saved),
          // then restore the target or start fresh. See email login for rationale.
          const isSalonSwitchTg = !!(currentSalonId && newSalonId && currentSalonId !== newSalonId);
          let willRestartForSalonTg = false;
          if (isSalonSwitchTg) {
            const sw = await this.switchSalonForLogin(currentSalonId, newSalonId, 'telegram login salon switch');
            if (!sw.ok) {
              return { success: false, error: sw.error || 'Không lưu được dữ liệu salon hiện tại — huỷ đổi salon' };
            }
            willRestartForSalonTg = sw.willRestart;
          }

          if (!setSecureAuthToken(result.access_token)) {
            return { success: false, error: 'Failed to store auth token securely' };
          }
          // Backend's auth response carries a refresh_token alongside the
          // access token (auth.service.ts:571-572). Persist it now so the
          // 401-retry flow can rotate without forcing a relogin every
          // time JWT_EXPIRES_IN ticks over.
          if (result.refresh_token && !setSecureRefreshToken(result.refresh_token)) {
            clearSecureAuthTokens();
            return { success: false, error: 'Failed to store refresh token securely' };
          }

          setConfig({
            authUser: { id: user.id || '', email: user.email || '', firstName: user.firstName || '', lastName: user.lastName || '', role: user.role || '', salonId: newSalonId },
            salonId: newSalonId,
            salonName: resolveAuthSalonName(result),
            salonSlug: resolveAuthSalonSlug(result),
            posEnabled: true,
            customerDisplayEnabled: true,
          });

          // New tenant ⇒ new POS template (must persist before any relaunch)
          if (isSalonSwitchTg) {
            await this.reconcilePosModeAfterSalonSwitch(newSalonId);
          }

          if (willRestartForSalonTg) {
            this.eventBus?.emit('salon:switching', { salonName: resolveAuthSalonName(result) });
            this.scheduleSalonRestartRestore();
            return { success: true, data: { status: 'VERIFIED', restarting: true } };
          }

          // Auto-connect Socket.IO in the background. Auth state is already
          // persisted; socket readiness is handled separately.
          void this.connectWithAvailablePrintAgentKey(
            client,
            result.access_token,
            'telegram login',
            newSalonId,
          ).catch((err: any) => logger.debug('[AuthModule] background auto-connect after telegram login failed:', err?.message));

          // Trigger post-login sync (clearSalonData may have wiped products while socket was already connected)
          if (this.eventBus) this.eventBus.emit('user:logged-in', { userId: user.id || '', salonId: newSalonId, salonName: resolveAuthSalonName(result), salonSwitched: isSalonSwitchTg });

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
      // for the per-branch behaviour spec. Identity persistence is delayed
      // until the tenant archive/clear guard below succeeds.
      const result = await resolveCurrentUser({
        getAuthToken: getSecureAuthToken,
        getMe: (token) => client.getMe(token),
        getCachedAuthUser: () => config.authUser as AuthUser | undefined,
        defaultSalonName: config.salonName,
        onAuthRejected: () => {
          clearSecureAuthTokens();
          setConfig({ authUser: { id: '', email: '', firstName: '', lastName: '', role: '', salonId: '' } });
        },
        // Commit the resolved identity only after any tenant archive/clear
        // below succeeds. Persisting it here could mix a new tenant identity
        // with the old tenant's blocked receipt evidence.
        onUserResolved: () => undefined,
      });

      const resolvedUser = result.data?.isAuthenticated ? result.data.user : undefined;
      const newSalonId = resolveAuthSalonId(resolvedUser);
      const currentSalonId = config.salonId || '';
      if (currentSalonId && newSalonId && currentSalonId !== newSalonId) {
        // At startup we can't relaunch-restore (would loop), so archive + clear
        // fresh. Archive failure skips the clear to preserve data (logged).
        const cleared = await this.archiveSalonThenClear(currentSalonId, 'startup auth salon switch');
        if (!cleared.ok) {
          logger.error(`[AuthModule] startup salon switch: could not archive ${currentSalonId} (${cleared.error}); kept existing data, skipped clear`);
          return {
            success: false,
            data: { isAuthenticated: false },
            error: cleared.error || 'Không thể đổi salon khi tác vụ in chưa được xử lý',
          };
        }
      }
      if (newSalonId) {
        setConfig({
          authUser: resolvedUser,
          salonId: newSalonId,
          salonName: resolvedUser?.salonName || config.salonName || '',
        });
      }

      return result;
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async () => {
      try {
        database.prepareReceiptPrintOutboxForTenantExit(
          getConfig().salonId || '',
          'Initial receipt cancelled before user logout',
          { allowNeedsReview: true },
        );
      } catch (e: any) {
        logger.warn(`[AuthModule] Logout blocked by receipt lifecycle guard: ${e?.message || e}`);
        return { success: false, error: e?.message || 'Không thể đăng xuất khi tác vụ in chưa được xử lý' };
      }
      const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
      socket?.disconnect();
      clearSecureTokens();
      // Keep the local salon mirror on ordinary logout so a relogin to the
      // same salon still has a healthy local-first baseline and sync guard.
      // Explicit salon switching/offline reset clears it through AUTH_CHANGE_SALON.
      setConfig({
        authUser: { id: '', email: '', firstName: '', lastName: '', role: '', salonId: '' },
        salonName: '', salonSlug: '', salonCode: '', aiEnabled: false,
        isPaired: false, agentId: '',
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
          const newSalonId = resolveAuthSalonId(result);
          const currentSalonId = config.salonId || '';
          if (!newSalonId) {
            return { success: false, error: 'Login response missing salon id' };
          }

          // Multi-tenant: never wipe the leaving salon — archive it, then either
          // restore the target salon's saved data (via restart) or start fresh.
          // Abort the whole switch if the current salon cannot be saved.
          const isSalonSwitch = !!(currentSalonId && newSalonId && currentSalonId !== newSalonId);
          let willRestartForSalon = false;
          if (isSalonSwitch) {
            const sw = await this.switchSalonForLogin(currentSalonId, newSalonId, 'email login salon switch');
            if (!sw.ok) {
              return { success: false, error: sw.error || 'Không lưu được dữ liệu salon hiện tại — huỷ đổi salon' };
            }
            willRestartForSalon = sw.willRestart;
          }

          const authUser: AuthUser = {
            id: user.id || user.sub, email: user.email, firstName: user.firstName || '',
            lastName: user.lastName || '', role: user.role, salonId: newSalonId,
            salonName: resolveAuthSalonName(result),
          };

          if (!setSecureAuthToken(result.access_token)) {
            return { success: false, error: 'Failed to store auth token securely' };
          }
          // Persist refresh_token alongside access_token so the
          // refresh-on-401 flow can rotate the session without
          // forcing the cashier back to AuthScreen every JWT TTL.
          // Backend response shape: auth.service.ts:758-762.
          if (result.refresh_token && !setSecureRefreshToken(result.refresh_token)) {
            clearSecureAuthTokens();
            return { success: false, error: 'Failed to store refresh token securely' };
          }

          setConfig({ authUser, salonId: authUser.salonId || '', salonName: authUser.salonName || '', salonSlug: resolveAuthSalonSlug(result), posEnabled: true, customerDisplayEnabled: true });

          // New tenant ⇒ new POS template (must persist before any relaunch)
          if (isSalonSwitch) {
            await this.reconcilePosModeAfterSalonSwitch(newSalonId);
          }

          // Restoring a previously-archived salon needs a clean reload — the
          // pending restore was staged above; relaunch so it is applied at boot.
          if (willRestartForSalon) {
            this.eventBus?.emit('salon:switching', { salonName: authUser.salonName || '' });
            this.scheduleSalonRestartRestore();
            return { success: true, data: { user: authUser }, restarting: true };
          }

          // Auto-connect in the background. Never block login on the socket/key
          // handshake. Under backend load the WS handshake can stall up to the 30s
          // connect timeout, which made login hang on every terminal.
          void this.connectWithAvailablePrintAgentKey(
            client,
            result.access_token,
            'email login',
            newSalonId,
          ).catch((err: any) => logger.debug('[AuthModule] background auto-connect after email login failed:', err?.message));

          // Trigger post-login sync (clearSalonData may have wiped products while socket was already connected)
          if (this.eventBus) this.eventBus.emit('user:logged-in', { userId: authUser.id, salonId: authUser.salonId || '', salonName: authUser.salonName, salonSwitched: isSalonSwitch });

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

    ipcMain.handle(IPC_CHANNELS.PRINT_AGENT_PRINTERS_LIST, async () => {
      return this.refreshAgentPrinters();
    });

    ipcMain.handle(IPC_CHANNELS.PRINT_AGENT_PRINTERS_LOCAL_LIST, async () => {
      return localPrinterRepo.getAll();
    });

    ipcMain.handle(IPC_CHANNELS.PRINT_AGENT_PRINTERS_CREATE, async (_, body: Partial<ServerPrinterMapping>) => {
      const { client, token, agentId } = this.getPrinterApiContext();
      await client.createAgentPrinter(token, agentId, body);
      return this.refreshAgentPrinters();
    });

    ipcMain.handle(IPC_CHANNELS.PRINT_AGENT_PRINTERS_UPDATE, async (_, printerId: string, body: Partial<ServerPrinterMapping>) => {
      if (!printerId) throw new Error('Missing printer id');
      const { client, token, agentId } = this.getPrinterApiContext();
      await client.updateAgentPrinter(token, agentId, printerId, body);
      return this.refreshAgentPrinters();
    });

    ipcMain.handle(IPC_CHANNELS.PRINT_AGENT_PRINTERS_DELETE, async (_, printerId: string) => {
      if (!printerId) throw new Error('Missing printer id');
      const { client, token, agentId } = this.getPrinterApiContext();
      await client.deleteAgentPrinter(token, agentId, printerId);
      return this.refreshAgentPrinters();
    });

    ipcMain.handle(IPC_CHANNELS.PRINT_AGENT_SALON_PRINTERS_LIST, async (_, options?: SalonPrintersListOptions) => {
      const { client, token } = this.getAuthenticatedApiContext();
      return client.listSalonPrinters(token, options);
    });

    ipcMain.handle(IPC_CHANNELS.PRINT_AGENT_PRINTER_ASSIGNMENTS_LIST, async () => {
      const { client, token } = this.getAuthenticatedApiContext();
      return client.listPrinterAssignments(token);
    });

    ipcMain.handle(IPC_CHANNELS.PRINT_AGENT_PRINTER_ASSIGNMENTS_UPSERT, async (_, role: SalonPrinterRole, printerId: string) => {
      if (!role) throw new Error('Missing printer assignment role');
      if (!printerId) throw new Error('Missing printer id');
      const { client, token } = this.getAuthenticatedApiContext();
      return client.upsertPrinterAssignment(token, role, printerId);
    });

    ipcMain.handle(IPC_CHANNELS.PRINT_AGENT_PRINTER_ASSIGNMENTS_DELETE, async (_, role: SalonPrinterRole) => {
      if (!role) throw new Error('Missing printer assignment role');
      const { client, token } = this.getAuthenticatedApiContext();
      await client.deletePrinterAssignment(token, role);
      return client.listPrinterAssignments(token);
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

  async connectWithApiKey(
    apiKey: string,
    options: { expectedSalonId?: string } = {},
  ): Promise<ConnectResponse | null> {
    const config = getConfig();
    const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
    if (!socket) throw new Error('Socket not initialized');

    // Snapshot identity BEFORE we mutate any state. We compare to the
    // /print-agent/connect response below: if salon/agent/apiKey changed
    // since the last pairing, the local SQLite mirror is stale (categories
    // and products belong to a different tenant) and must be wiped so the
    // next deltaSync falls back to fullSync.
    const prevApiKey = getSecureApiKey();
    const prevAgentId = config.agentId;
    const prevSalonId = config.salonId;

    let response: ConnectResponse | null = null;
    const client = new ApiClient(config.serverUrl || 'https://api.enail.pro');
    // Call REST /print-agent/connect to populate salonName, salonId, agentId, salonSlug.
    // Probe only: ApiClient must not publish the target config/printer mirror
    // while old-tenant receipt rows can still dispatch with dynamic auth.
    try {
      response = await client.connectWithApiKey(apiKey, { persist: false });
    } catch (err: any) {
      logger.warn('[AuthModule] REST connect failed, proceeding with socket only:', err?.message);
    }

    if (options.expectedSalonId) {
      // A transient REST outage must not prevent the already-paired device
      // from opening its Socket.IO connection. The socket keeps reconnecting
      // after this method's timeout, so it can recover when Windows networking
      // becomes ready. Only trust the local identity on this offline path when
      // both the stored key and stored salon exactly match the expected salon.
      const canUseStoredIdentityWhileOffline = Boolean(
        !response
        && prevApiKey === apiKey
        && prevSalonId
        && prevSalonId === options.expectedSalonId
      );

      if (
        (response && response.salonId !== options.expectedSalonId)
        || (!response && !canUseStoredIdentityWhileOffline)
      ) {
        throw new Error(
          `Print-agent key belongs to salon ${response?.salonId || 'unknown'}, `
          + `expected ${options.expectedSalonId}`,
        );
      }

      if (canUseStoredIdentityWhileOffline) {
        logger.warn(
          '[AuthModule] REST identity unavailable; continuing with the unchanged key and stored salon identity',
        );
      }
    }

    const apiKeyChanged = Boolean(prevApiKey && prevApiKey !== apiKey);
    const identityChanged = Boolean(
      apiKeyChanged
      || (
        response
        && (
          (prevAgentId && response.agentId && prevAgentId !== response.agentId)
          || (prevSalonId && response.salonId && prevSalonId !== response.salonId)
        )
      )
    );

    // A different credential whose REST identity cannot be resolved must not
    // replace a paired tenant key. We cannot prove which salon would receive
    // an old receipt payload, so fail closed and keep all old identity state.
    if (
      !response
      && apiKey !== prevApiKey
      && Boolean(prevSalonId || prevAgentId)
    ) {
      throw new Error(
        'Cannot verify the new print-agent key while the current salon is paired. '
        + 'The existing credentials and local data were kept.',
      );
    }

    if (response) {
      if (identityChanged) {
        const cleared = await this.archiveSalonThenClear(prevSalonId || '', 'apiKey/agent change');
        if (!cleared.ok) {
          // Fail closed: never proceed with a half-cleared tenant if we could
          // not first save the leaving salon's data. The probe has not committed
          // either key or config, so the old identity remains untouched.
          throw new Error(`Không lưu được dữ liệu salon hiện tại — huỷ kết nối: ${cleared.error || ''}`);
        }
        logger.info(
          `[AuthModule] Cleared salon data on apiKey/agent change: oldAgentId=${prevAgentId ?? 'none'} newAgentId=${response.agentId ?? 'none'} oldSalonId=${prevSalonId ?? 'none'} newSalonId=${response.salonId ?? 'none'}`,
        );
      }
    }

    // Commit credentials and target identity only after the old tenant's
    // receipt lifecycle/archive guard has completed. There is no await between
    // these synchronous writes, so runtime consumers cannot observe a mixed
    // key/config pair on the successful path.
    if (!setSecureApiKey(apiKey)) {
      throw new Error('Failed to store API key securely');
    }
    try {
      if (response) {
        client.applyConnectResponse(response);
      } else {
        setConfig({ isPaired: true });
      }
    } catch (error) {
      if (!setSecureApiKey(prevApiKey || '')) {
        logger.error('[AuthModule] Failed to restore previous API key after connection-state commit failed');
      }
      throw error;
    }

    if (response) {
      // Server-pushed printers carry their own isEnabled flag (typically false
      // until the dashboard admin flips it). Without this re-apply, a cashier
      // who relied on the boot-time auto-on would see Receipts toggle OFF
      // every login. Same "forgotten off must not stop sales" intent as the
      // boot call in index.ts — re-run after every printer-config sync.
      if (response.printers?.length) {
        ensureReceiptPrinterEnabledOnBoot();
      }
      if (this.eventBus) {
        const changedKeys = ['apiKey', 'agentId', 'salonId', 'salonName', 'salonSlug', 'salonCode', 'serverUrl', 'isPaired'];
        if (response.printers?.length) changedKeys.push('printers', 'multiPrinterMode');
        this.eventBus.emit('config:changed', { changedKeys });
      }
      await this.syncWindowsPrintersWithBackend(apiKey);
    }

    const latestConfig = getConfig();
    if (socket.isConnected() && identityChanged) {
      socket.disconnect();
    }
    await socket.connectWithApiKey(latestConfig.serverUrl || 'https://api.enail.pro', apiKey, latestConfig.machineId);
    return response;
  }

  private async connectWithAvailablePrintAgentKey(
    client: ApiClient,
    accessToken: string,
    context: string,
    expectedSalonId = '',
  ): Promise<void> {
    const existingKey = getSecureApiKey();
    if (existingKey?.startsWith('pa_')) {
      try {
        await this.connectWithApiKey(existingKey, {
          ...(expectedSalonId && { expectedSalonId }),
        });
        return;
      } catch (err: any) {
        logger.warn(`[AuthModule] Stored print-agent key failed after ${context}; fetching current key: ${err?.message || err}`);
      }
    }

    const keyResult = await client.getMyPrintAgentKey(accessToken);
    if (!keyResult?.apiKey) {
      throw new Error('No print-agent API key available');
    }

    await this.connectWithApiKey(keyResult.apiKey, {
      ...(expectedSalonId && { expectedSalonId }),
    });
  }

  private getAuthenticatedApiContext(): { client: ApiClient; token: string } {
    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    const config = getConfig();
    return {
      client: new ApiClient(config.serverUrl || 'https://api.enail.pro'),
      token,
    };
  }

  private getPrinterApiContext(): { client: ApiClient; token: string; agentId: string } {
    const { client, token } = this.getAuthenticatedApiContext();
    const config = getConfig();
    const agentId = config.agentId;
    if (!agentId) throw new Error('Print Agent is not paired');

    return {
      client,
      token,
      agentId,
    };
  }

  private async refreshAgentPrinters(): Promise<AgentPrintersResponse> {
    const { client, token, agentId } = this.getPrinterApiContext();
    const response = await client.listAgentPrinters(token, agentId);
    const config = getConfig();
    const recoveryOverrides = pruneRecoveredWindowsPrinterOverrides(
      response.printers,
      config.recoveredWindowsPrinters,
      config.printers,
    );
    const localPrinters = normalizeServerPrinterRows(
      response.printers,
      config.printers,
      recoveryOverrides,
    );

    if (localPrinters.length > 0) {
      localPrinterRepo.upsertMany(agentId, localPrinters);
      setConfig({
        multiPrinterMode: true,
        recoveredWindowsPrinters: recoveryOverrides,
      });
      this.eventBus?.emit('config:changed', { changedKeys: ['printers', 'multiPrinterMode'] });
      logger.info(`[AuthModule] Refreshed ${localPrinters.length} backend printer row(s) into local mirror`);
    }

    return response;
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
        config.machineId,
      );
      logger.info(`[AuthModule] Synced ${result.count} Windows printer(s) to backend`);
    } catch (err: any) {
      logger.warn('[AuthModule] Windows printer sync failed:', err?.message);
    }
  }

  /**
   * After logging into a DIFFERENT salon, fetch its entitlements and apply
   * the server-suggested POS template (salon.niche → retail/salon/restaurant).
   * Without this, posMode silently carried over between tenants — a grocery
   * store inherited the previous tenant's nail-salon template and vice versa.
   * Re-logins into the SAME salon never reach this path, so a user's explicit
   * Settings choice for their own salon is never overridden. Must run BEFORE
   * the restore-relaunch so the persisted config survives the restart.
   */
  private async reconcilePosModeAfterSalonSwitch(newSalonId: string): Promise<void> {
    try {
      const entitlements = await fetchEntitlementsFromBackend(newSalonId);
      if (!entitlements) return;
      setConfig({ entitlements });
      const suggested = entitlements.suggestedPosMode;
      if (suggested && getConfigValue('posMode') !== suggested) {
        logger.info(`[AuthModule] Salon switch: posMode → ${suggested} (niche suggestion for new salon)`);
        setConfig({ posMode: suggested });
      }
    } catch (e: any) {
      logger.warn('[AuthModule] posMode reconcile after salon switch failed:', e?.message);
    }
  }

  /**
   * Login-path salon switch. Archives the leaving salon's full DB (MUST succeed
   * — otherwise the switch is aborted so nothing is lost), then either stages
   * the target salon's previously-archived DB for a restart-restore, or starts
   * fresh (first time for that salon). The caller persists the new session only
   * when this returns { ok: true }, and relaunches when { willRestart: true }.
   */
  private async switchSalonForLogin(
    oldSalonId: string,
    newSalonId: string,
    context: string,
  ): Promise<{ ok: boolean; willRestart: boolean; error?: string }> {
    try {
      database.assertNoActiveReceiptPrintOutcomes(oldSalonId);
    } catch (e: any) {
      logger.warn(`[AuthModule] ${context}: blocked by receipt lifecycle guard: ${e?.message || e}`);
      return { ok: false, willRestart: false, error: e?.message || 'Tác vụ in chưa được xử lý' };
    }
    const backup = this.container.getOptional<LocalBackupService>(SERVICE_TOKENS.BACKUP_SERVICE);
    if (!backup) {
      logger.error(`[AuthModule] ${context}: backup service unavailable — aborting switch to protect salon ${oldSalonId}`);
      return { ok: false, willRestart: false, error: 'Backup service unavailable — không thể lưu dữ liệu salon hiện tại' };
    }
    const archived = await backup.archiveSalon(oldSalonId);
    if (!archived.success) {
      logger.error(`[AuthModule] ${context}: archive of leaving salon ${oldSalonId} failed: ${archived.error}`);
      return { ok: false, willRestart: false, error: `Không lưu được dữ liệu salon hiện tại: ${archived.error}` };
    }
    // The first archive is a read-only safety point. Only after it succeeds
    // may pre-dispatch rows be cancelled. Refresh the archive afterwards for
    // BOTH fresh and restored targets, so returning to this salon can never
    // replay a stale receipt/drawer intent.
    try {
      database.prepareReceiptPrintOutboxForTenantExit(
        oldSalonId,
        `Initial receipt cancelled before ${context}`,
        { allowNeedsReview: true },
      );
    } catch (e: any) {
      return { ok: false, willRestart: false, error: e?.message || 'Tác vụ in chưa được xử lý' };
    }
    const cancellationArchived = await backup.archiveSalon(oldSalonId);
    if (!cancellationArchived.success) {
      logger.error(`[AuthModule] ${context}: failed to archive cancelled receipt intents: ${cancellationArchived.error}`);
      return {
        ok: false,
        willRestart: false,
        error:
          `Tác vụ in tự động đã được hủy an toàn nhưng không cập nhật được bản lưu salon `
          + `(${cancellationArchived.error || 'archive failed'}). Đổi salon đã dừng; nếu cần hãy in lại thủ công.`,
      };
    }
    if (backup.hasSalonArchive(newSalonId)) {
      const staged = await backup.stageSalonRestore(newSalonId);
      if (staged.success) {
        logger.info(`[AuthModule] ${context}: archived ${oldSalonId}, staged restore of ${newSalonId} — relaunching`);
        return { ok: true, willRestart: true };
      }
      logger.error(`[AuthModule] ${context}: stage restore for ${newSalonId} failed (${staged.error}); aborting switch to avoid wiping archived salon data`);
      return {
        ok: false,
        willRestart: false,
        error:
          `Không thể khôi phục dữ liệu salon đích: ${staged.error}. `
          + 'Tác vụ in tự động đang chờ đã được hủy an toàn; nếu cần hãy in lại thủ công.',
      };
    }
    try {
      database.clearSalonData(oldSalonId, { archivedReviewEvidence: true });
    } catch (e: any) {
      logger.error(`[AuthModule] ${context}: guarded salon clear was not durable: ${e?.message || e}`);
      return {
        ok: false,
        willRestart: false,
        error: e?.message || 'Không thể lưu trạng thái xóa dữ liệu salon',
      };
    }
    // Snapshot the freshly-cleared DB as the new salon's baseline and relaunch
    // through the existing pending-restore path. The relaunch kills every
    // in-flight sync started under the old tenant, and the boot-time restore
    // discards anything such a sync managed to flush between clear and exit
    // (2026-08-08 baohan/chesaigon incident). Snapshot failure falls back to
    // the old fresh + full sync behavior — it must never block the login.
    const baseline = await backup.archiveSalon(newSalonId);
    if (baseline.success) {
      const staged = await backup.stageSalonRestore(newSalonId);
      if (staged.success) {
        logger.info(`[AuthModule] ${context}: archived ${oldSalonId}, staged clean baseline for ${newSalonId} — relaunching`);
        return { ok: true, willRestart: true };
      }
      logger.warn(`[AuthModule] ${context}: staging clean baseline for ${newSalonId} failed (${staged.error}); falling back to fresh + full sync`);
    } else {
      logger.warn(`[AuthModule] ${context}: baseline snapshot for ${newSalonId} failed (${baseline.error}); falling back to fresh + full sync`);
    }
    logger.info(`[AuthModule] ${context}: archived ${oldSalonId}, no usable archive for ${newSalonId} — fresh + full sync`);
    return { ok: true, willRestart: false };
  }

  /**
   * Non-restoring salon clear (explicit change-salon, startup mismatch). Archives
   * the leaving salon first and ONLY clears if that succeeded — never wipes
   * without a saved copy.
   */
  private async archiveSalonThenClear(oldSalonId: string, context: string): Promise<{ ok: boolean; error?: string }> {
    if (!oldSalonId) {
      database.clearSalonData();
      return { ok: true };
    }
    try {
      database.assertNoActiveReceiptPrintOutcomes(oldSalonId);
    } catch (e: any) {
      logger.warn(`[AuthModule] ${context}: blocked by receipt lifecycle guard: ${e?.message || e}`);
      return { ok: false, error: e?.message || 'Tác vụ in chưa được xử lý' };
    }
    const backup = this.container.getOptional<LocalBackupService>(SERVICE_TOKENS.BACKUP_SERVICE);
    if (!backup) {
      logger.error(`[AuthModule] ${context}: backup service unavailable; skipping clear to avoid data loss`);
      return { ok: false, error: 'Backup service unavailable' };
    }
    const archived = await backup.archiveSalon(oldSalonId);
    if (!archived.success) {
      logger.error(`[AuthModule] ${context}: salon archive failed (${archived.error}); skipping clear to avoid data loss`);
      return { ok: false, error: archived.error };
    }
    try {
      database.prepareReceiptPrintOutboxForTenantExit(
        oldSalonId,
        `Initial receipt cancelled before ${context}`,
        { allowNeedsReview: true },
      );
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Tác vụ in chưa được xử lý' };
    }
    const cancellationArchived = await backup.archiveSalon(oldSalonId);
    if (!cancellationArchived.success) {
      logger.error(`[AuthModule] ${context}: failed to archive cancelled receipt intents: ${cancellationArchived.error}`);
      return {
        ok: false,
        error:
          `Tác vụ in tự động đã được hủy an toàn nhưng không cập nhật được bản lưu salon `
          + `(${cancellationArchived.error || 'archive failed'}). Xóa dữ liệu đã dừng; nếu cần hãy in lại thủ công.`,
      };
    }
    try {
      database.clearSalonData(oldSalonId, { archivedReviewEvidence: true });
    } catch (e: any) {
      logger.error(`[AuthModule] ${context}: guarded salon clear was not durable: ${e?.message || e}`);
      return { ok: false, error: e?.message || 'Không thể lưu trạng thái xóa dữ liệu salon' };
    }
    return { ok: true };
  }

  private scheduleSalonRestartRestore(delayMs = 1200): void {
    logger.info('[AuthModule] Relaunching app to load restored salon database...');
    setTimeout(() => {
      try { app.relaunch(); } catch (e) { logger.error('[AuthModule] app.relaunch failed:', e); }
      app.exit(0);
    }, delayMs);
  }

  private async createRestorePoint(reason: BackupRunReason, context: string): Promise<void> {
    const backup = this.container.getOptional<LocalBackupService>(SERVICE_TOKENS.BACKUP_SERVICE);
    if (!backup) {
      logger.debug(`[AuthModule] ${reason} skipped during ${context}: backup service not ready`);
      return;
    }
    try {
      const result = await backup.runBackupNow(reason);
      if (!result.success) {
        logger.warn(`[AuthModule] ${reason} failed during ${context}: ${result.error}`);
      }
    } catch (err: any) {
      logger.warn(`[AuthModule] ${reason} crashed during ${context}:`, err?.message || err);
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
    // Decide how to (re)establish the /print-agent socket that drives the
    // app's ONLINE state. The decision is a pure helper so its branches are
    // unit-tested without booting the module (startup-connect-plan.ts +
    // tests/startup-connect-plan.test.ts). Crucially it does NOT gate the
    // reconnect solely on isPaired: an authenticated terminal must self-heal
    // to ONLINE after a logout → login-different-salon relaunch, which used
    // to leave it silently offline until a manual logout/login.
    const config = getConfig();
    const secureKey = getSecureApiKey();
    const token = getSecureAuthToken();
    const salonId = config.salonId || config.authUser?.salonId || '';
    const serverUrl = config.serverUrl || 'https://api.enail.pro';

    const plan = resolveStartupConnectPlan({
      isPaired: !!getConfigValue('isPaired'),
      hasToken: !!token,
      hasSalonId: !!salonId,
      hasApiKey: !!secureKey?.startsWith('pa_'),
      hasSecureKey: !!secureKey,
      hasMachineId: !!config.machineId,
    });

    switch (plan.action) {
      case 'connect-with-key': {
        // Connect in the background so app startup / session restore isn't
        // blocked by a slow backend WS handshake (was delaying launch up to
        // 30s per boot). connectWithAvailablePrintAgentKey reuses a valid
        // stored key first and only fetches my-key when it's missing/mismatched.
        void (async () => {
          try {
            await this.connectWithAvailablePrintAgentKey(
              new ApiClient(serverUrl), token!, 'startup', salonId,
            );
          } catch (e: any) {
            logger.warn('[AuthModule] Startup auto-connect failed:', e?.message || e);
            try {
              await this.connectWithAvailablePrintAgentKey(
                new ApiClient(serverUrl), token!, 'startup', salonId,
              );
            } catch (retryErr: any) {
              logger.warn('[AuthModule] Startup auto-connect retry failed:', retryErr?.message || retryErr);
            }
          }
        })();
        break;
      }
      case 'legacy-connect':
        // Paired terminal with device credentials but no user session — my-key
        // needs a user token, so connect with the stored key/machineId instead.
        void this.connect().catch((e: any) =>
          logger.warn('[AuthModule] Startup device-credential connect failed:', e?.message || e));
        break;
      case 'reset-paired':
        logger.error('[AuthModule] isPaired=true but no valid credentials found. Resetting isPaired.');
        setConfig({ isPaired: false });
        break;
      case 'noop':
        break;
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
