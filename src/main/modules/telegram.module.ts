/**
 * TelegramModule
 *
 * Owns Telegram bot creation, polling, and command registration.
 */

import { ipcMain, safeStorage } from 'electron';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
import { createTelegramBot, destroyTelegramBot, getBotUsername, Bot } from '../telegram/bot';
import { registerCommands } from '../telegram/commands';
import { registerNativeCommands } from '../telegram/native-commands';
import { startPolling, stopPolling, isPollingRunning, getLastError } from '../telegram/polling';
import { IPC_CHANNELS, TelegramBotStatus, PrinterType } from '../../shared/types';
import { getConfigValue } from '../config/store';
import { RemoteSessionManager } from '../remote/remote-session-manager';
import { BrowserController } from '../browser/browser-controller';
import logger from '../logger';

export class TelegramModule extends BaseModule {
  readonly name = 'telegram';

  private telegramBot: Bot | null = null;

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[TelegramModule] Initializing...');
    await this.initializeTelegram();
    this.container.set(SERVICE_TOKENS.TELEGRAM_BOT, this.telegramBot);
    this.setState(ModuleState.READY);
  }

  private async initializeTelegram(): Promise<void> {
    const enabled = getConfigValue('telegramEnabled');
    if (!enabled) return;

    let token: string | null = null;
    const encrypted = getConfigValue('encryptedTelegramToken') as string | undefined;
    if (encrypted && safeStorage.isEncryptionAvailable()) {
      try { token = safeStorage.decryptString(Buffer.from(encrypted, 'base64')); } catch {}
    }
    if (!token) token = (getConfigValue('telegramToken') as string) || null;
    if (!token) return;

    try {
      this.telegramBot = createTelegramBot(token);
      registerNativeCommands(this.telegramBot);

      const rsm = this.container.getOptional<RemoteSessionManager>(SERVICE_TOKENS.REMOTE_SESSION_MANAGER);
      const bc = this.container.getOptional<BrowserController>(SERVICE_TOKENS.BROWSER_CONTROLLER);

      // Build printer functions by delegating to HardwareModule via container
      const hwModule = this.container.getOptional<any>(SERVICE_TOKENS.HARDWARE_MODULE);
      const printerFunctions = {
        getPrintersStatus: () => hwModule?.getPrintersStatus?.() || [],
        testPrint: async () => hwModule?.testPrint?.() || { success: false, error: 'Hardware module not available' },
        testPrinterByType: async (type: string) => hwModule?.testPrinterByType?.(type) || { success: false, error: 'Hardware module not available' },
        openCashDrawer: async (type?: string) => hwModule?.openCashDrawer?.(type) || { success: false, error: 'Hardware module not available' },
        printLabel: async (barcode: string, text?: string) => hwModule?.printLabel?.(barcode, text) || { success: false, error: 'Hardware module not available' },
      };

      if (rsm) {
        registerCommands(this.telegramBot, {
          screenCapturer: (rsm as any).screenCapturer,
          inputExecutor: (rsm as any).inputExecutor,
          browserController: bc || undefined,
          ziraAI: undefined,
          printerFunctions,
        });
      }

      await startPolling(this.telegramBot);
      logger.info('[TelegramModule] Bot started');
    } catch (e: any) {
      logger.error('[TelegramModule] Failed:', e);
    }
  }

  registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.TELEGRAM_GET_STATUS, (): TelegramBotStatus => ({
      enabled: getConfigValue('telegramEnabled') || false,
      running: isPollingRunning(),
      botUsername: getBotUsername() || undefined,
      lastError: getLastError() || undefined,
      hasToken: !!(getConfigValue('encryptedTelegramToken') || getConfigValue('telegramToken')),
    }));

    ipcMain.handle(IPC_CHANNELS.TELEGRAM_RESTART, async () => {
      try {
        if (this.telegramBot) { await stopPolling(this.telegramBot); destroyTelegramBot(); this.telegramBot = null; }
        await this.initializeTelegram();
        return { success: true };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    logger.info('[TelegramModule] IPC handlers registered');
  }

  getToolDefinitions(): ToolDefinition[] { return []; }

  registerEventHandlers(bus: EventBus): void {
    bus.on('config:changed', async (payload) => {
      const telegramKeys = ['telegramEnabled', 'telegramToken', 'encryptedTelegramToken'];
      if (payload.changedKeys.some(k => telegramKeys.includes(k))) {
        logger.info('[TelegramModule] Config changed, restarting bot...');
        if (this.telegramBot) { await stopPolling(this.telegramBot); destroyTelegramBot(); this.telegramBot = null; }
        await this.initializeTelegram();
        this.container.set(SERVICE_TOKENS.TELEGRAM_BOT, this.telegramBot);
      }
    });

    bus.on('user:logged-out', async () => {
      logger.info('[TelegramModule] User logged out, stopping bot');
      if (this.telegramBot) { await stopPolling(this.telegramBot); destroyTelegramBot(); this.telegramBot = null; }
      this.container.set(SERVICE_TOKENS.TELEGRAM_BOT, null);
    });
  }

  async start(): Promise<void> { this.setState(ModuleState.RUNNING); }

  async stop(): Promise<void> {
    if (this.telegramBot) { await stopPolling(this.telegramBot); destroyTelegramBot(); this.telegramBot = null; }
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> { this.setState(ModuleState.STOPPED); }
}
