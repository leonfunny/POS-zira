import { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } from 'electron';
import * as path from 'path';
import { join } from 'path';
import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { execSync } from 'child_process';
import logger from './logger';
import { getIconPath } from './paths';
import TrayManager, { TrayManagerHost } from './tray';
import SocketClient from './network/socket-client';
import { ApiClient } from './network/api-client';
import { PosnetDriver } from './hardware/posnet/posnet-driver';
import { ZebraDriver } from './hardware/zebra/zebra-driver';
import { ThermalDriver } from './hardware/thermal/thermal-driver';
import { HidScanner } from './hardware/scanner/hid-scanner';
import { RemoteSessionManager } from './remote/remote-session-manager';
import { SshTunnelManager } from './remote/ssh-tunnel';
import { getConfig, setConfig, getConfigValue, setConfigValue, setSecureAuthToken, getSecureAuthToken, setSecureApiKey, getSecureApiKey, setSecureAiApiKey, getSecureAiApiKey, clearSecureTokens } from './config/store';
import {
  IPC_CHANNELS,
  AgentConfig,
  DeviceStatus,
  PrintJobType,
  PrinterType,
  LabelData,
  ReceiptData,
  DailyReportData,
  ConnectResponse,
  PrinterConfig,
  PrintersConfig,
  RemoteSessionRequest,
  RemoteControlState,
  RTCSessionDescriptionInit,
  RTCIceCandidateInit,
  TelegramBotStatus,
  SshTunnelRequest,
  SshTunnelStatus,
} from '../shared/types';
import { createTelegramBot, getTelegramBot, destroyTelegramBot, getBotUsername, Bot } from './telegram/bot';
import { registerCommands } from './telegram/commands';
import { registerNativeCommands } from './telegram/native-commands';
import { startPolling, stopPolling, isPollingRunning, getLastError } from './telegram/polling';
import { BrowserController } from './browser/browser-controller';
// ZiraAI with tool calling support (API key stays local on user's machine)
import { ZiraAI, setBooksySyncProvider, ZIRA_TOOLS, executeTool, filterIdentity, handleProfileSelection } from './ai/zira-ai';
import { ZiraAIStatus, ZiraAIChatResponse, AuthUser } from '../shared/types';
import { PosStore } from './pos/pos-store';
import { WindowManager } from './windows/window-manager';
import { database } from './database/database';
import { productRepo } from './database/repos/product-repo';
import { orderRepo } from './database/repos/order-repo';
import { tableRepo } from './database/repos/table-repo';
import { customerRepo } from './database/repos/customer-repo';
import { staffRepo } from './database/repos/staff-repo';
import { holdOrderRepo } from './database/repos/hold-repo';
import { quickKeyLayoutRepo } from './database/repos/quickkey-layout-repo';
import { seedIfEmpty } from './database/seed';
import { BooksySync } from './booksy/booksy-sync';
import { ProductSync } from './sync/product-sync';
import { OrderSync } from './sync/order-sync';
import { PaymentController } from './pos/payment-controller';
import { ShiftController } from './pos/shift-controller';
import { WebSocketServer, WebSocket } from 'ws';
import { registerInvoiceHandlers } from './invoice/invoice-controller';
import { registerEntitlementsHandlers } from './entitlements/entitlements-controller';

// Union type for printer drivers
type PrinterDriver = PosnetDriver | ZebraDriver | ThermalDriver;

// Dictionary of printer drivers by PrinterType
type PrinterDriversMap = {
  [key in PrinterType]?: PrinterDriver;
};

// Check for debug mode
const isDebugMode = process.argv.includes('--debug') || process.env.DEBUG === '1';

/**
 * SECURITY: Simple rate limiter for IPC handlers to prevent brute force attacks
 */
class RateLimiter {
  private attempts: Map<string, number[]> = new Map();

  /**
   * Check if an action is allowed based on rate limits
   * @param key - Unique key for the action (e.g., 'login', 'connect')
   * @param maxAttempts - Maximum number of attempts allowed in the window
   * @param windowMs - Time window in milliseconds
   * @returns true if allowed, false if rate limited
   */
  check(key: string, maxAttempts: number, windowMs: number): boolean {
    const now = Date.now();
    const attempts = this.attempts.get(key) || [];

    // Filter out old attempts outside the window
    const recentAttempts = attempts.filter(time => now - time < windowMs);

    if (recentAttempts.length >= maxAttempts) {
      logger.warn(`[RateLimiter] Rate limit exceeded for "${key}": ${recentAttempts.length}/${maxAttempts} attempts in ${windowMs}ms`);
      return false;
    }

    // Record this attempt
    recentAttempts.push(now);
    this.attempts.set(key, recentAttempts);
    return true;
  }

  /**
   * Clear all rate limit data (e.g., on successful login)
   */
  clear(key: string): void {
    this.attempts.delete(key);
  }
}

// Global rate limiter instance
const rateLimiter = new RateLimiter();

/**
 * SECURITY: Input validation utilities for IPC handlers
 * Prevents injection attacks and malformed data
 */
const InputValidator = {
  // Validate email format
  isValidEmail(email: unknown): email is string {
    if (typeof email !== 'string') return false;
    if (email.length > 254) return false; // RFC 5321
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  },

  // Validate non-empty string with max length
  isValidString(value: unknown, maxLength = 1000): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
  },

  // Validate API key format (alphanumeric with dashes, reasonable length)
  isValidApiKey(key: unknown): key is string {
    if (typeof key !== 'string') return false;
    if (key.length < 10 || key.length > 500) return false;
    // Allow alphanumeric, dashes, underscores
    return /^[a-zA-Z0-9_-]+$/.test(key);
  },

  // Validate token format (base64 or JWT-like)
  isValidToken(token: unknown): token is string {
    if (typeof token !== 'string') return false;
    if (token.length < 10 || token.length > 5000) return false;
    // Allow alphanumeric, dots, dashes, underscores (JWT format)
    return /^[a-zA-Z0-9._-]+$/.test(token);
  },

  // Validate URL format
  isValidUrl(url: unknown): url is string {
    if (typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },

  // Sanitize string (remove potential injection characters)
  sanitize(str: string, maxLength = 1000): string {
    return str
      .slice(0, maxLength)
      .replace(/[<>]/g, '') // Remove HTML tags
      .trim();
  },
};

/**
 * Generate a unique machine ID without native modules
 * Uses Windows-specific commands when available
 */
function generateMachineId(): string {
  try {
    if (process.platform === 'win32') {
      // Try to get Windows MachineGuid from registry
      const result = execSync(
        'REG QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf8', timeout: 5000 }
      );
      const match = result.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match && match[1]) {
        return createHash('sha256').update(match[1]).digest('hex');
      }
    } else if (process.platform === 'darwin') {
      // macOS: Use IOPlatformUUID
      const result = execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID', {
        encoding: 'utf8',
        timeout: 5000
      });
      const match = result.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match && match[1]) {
        return createHash('sha256').update(match[1]).digest('hex');
      }
    } else {
      // Linux: Try /etc/machine-id
      const result = execSync('cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null', {
        encoding: 'utf8',
        timeout: 5000
      });
      if (result.trim()) {
        return createHash('sha256').update(result.trim()).digest('hex');
      }
    }
  } catch (error) {
    logger.warn('[MachineId] Failed to get platform machine ID, generating random:', error);
  }

  // Fallback: Generate a random UUID and hash it
  return createHash('sha256').update(randomUUID()).digest('hex');
}

/**
 * Main application class
 */
export class PrintAgentApp implements TrayManagerHost {
  private mainWindow: BrowserWindow | null = null;
  private tray: TrayManager | null = null;
  private socket: SocketClient | null = null;
  // Multi-printer support - dictionary by PrinterType
  private printers: PrinterDriversMap = {};
  // Legacy multi-printer support (for backward compatibility)
  private receiptPrinter: PrinterDriver | null = null;
  private labelPrinter: PrinterDriver | null = null;
  // Legacy single printer (for backward compatibility)
  private printerDriver: PrinterDriver | null = null;
  private scanner: HidScanner | null = null;
  // Remote control session manager
  private remoteSessionManager: RemoteSessionManager | null = null;
  // SSH tunnel manager for remote support
  private sshTunnelManager: SshTunnelManager | null = null;
  // Telegram bot instance
  private telegramBot: Bot | null = null;
  // Browser controller (Playwright)
  private browserController: BrowserController | null = null;
  // AI chat - local mode with tools when user provides own API key
  private ziraAI: ZiraAI | null = null;
  // AI chat history (for both local and proxy mode)
  private proxyHistory: Map<string, { role: string; content: string }[]> = new Map();
  // POS
  private posStore: PosStore | null = null;
  private windowManager: WindowManager | null = null;
  // Sync services
  private productSync: ProductSync | null = null;
  private orderSync: OrderSync | null = null;
  // Payment & shift controllers
  private paymentController: PaymentController | null = null;
  private shiftController: ShiftController | null = null;
  // Booksy sync
  private booksySync: BooksySync | null = null;
  // Extension Socket
  private wss: WebSocketServer | null = null;
  private extensionSocket: WebSocket | null = null;
  
  private initStep = 0;

  /**
   * Log initialization step
   */
  private logStep(message: string): void {
    this.initStep++;
    const logMsg = `[Init Step ${this.initStep}] ${message}`;
    logger.info(logMsg);
    console.log(logMsg);
  }

  /**
   * Initialize the application
   */
  async initialize(): Promise<void> {
    this.logStep('Starting initialization...');

    try {
      // Single instance lock + second-instance handler are in index.ts (before app.whenReady)
      this.logStep('Single instance lock already acquired in index.ts');

      // Wait for app ready
      this.logStep('Waiting for app ready...');
      await app.whenReady();
      this.logStep('App is ready');

      // Get/generate machine ID
      this.logStep('Getting machine ID...');
      let machineId = getConfigValue('machineId');
      if (!machineId) {
        this.logStep('Generating new machine ID...');
        machineId = generateMachineId();
        setConfigValue('machineId', machineId);
        this.logStep(`Generated machine ID: ${machineId.substring(0, 8)}...`);
      } else {
        this.logStep(`Using existing machine ID: ${machineId.substring(0, 8)}...`);
      }

      // Initialize components (printers, scanner, socket)
      this.logStep('Initializing components...');
      await this.initializeComponents();
      this.logStep('Components initialized');

      // Setup ALL IPC handlers BEFORE showing window
      // (renderer calls get-config, get-status etc. immediately on load)
      this.logStep('Setting up IPC handlers...');
      this.setupIpcHandlers();
      this.logStep('IPC handlers ready');

      // Initialize SQLite database
      this.logStep('Initializing SQLite database...');
      await database.initialize();
      seedIfEmpty();
      this.logStep('SQLite database ready');

      // Initialize POS store & window manager
      this.logStep('Initializing POS store...');
      this.posStore = new PosStore();
      this.windowManager = new WindowManager(this.posStore);
      this.setupPosIpcHandlers();
      this.logStep('POS store & window manager ready');

      // Initialize sync services
      this.logStep('Initializing sync services...');
      this.productSync = new ProductSync();
      this.orderSync = new OrderSync();
      this.setupSyncEventHandlers();
      this.logStep('Sync services ready');

      // Initialize payment & shift controllers
      this.paymentController = new PaymentController(
        (type: string) => this.getPrinterForType(type as any) as any,
        () => this.socket?.isConnected() || false,
        () => getConfig().salonName,
      );
      this.shiftController = new ShiftController(
        (type: string) => this.getPrinterForType(type as any) as any,
        () => this.socket?.isConnected() || false,
      );
      this.setupPaymentShiftIpc();
      this.logStep('Payment & shift controllers ready');

      // Show window AFTER all handlers are registered
      this.logStep('Showing main window...');
      this.showWindow();
      this.logStep('Window shown');

      // Create system tray
      this.logStep('Creating system tray...');
      this.tray = new TrayManager(this);
      this.logStep('System tray created');

      // Auto-connect if paired
      const isPaired = getConfigValue('isPaired');
      this.logStep(`Paired status: ${isPaired}`);

      if (isPaired) {
        this.logStep('Attempting auto-connect...');
        await this.connect();
      } else {
        this.logStep('Not paired, skipping auto-connect');
      }

      // Configure auto-start
      this.logStep('Configuring auto-start...');
      this.configureAutoStart();

      // Handle app events
      app.on('window-all-closed', () => {
        // Don't quit - keep running in tray
        logger.debug('All windows closed, continuing in tray');
      });

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          this.showWindow();
        }
      });

      // Initialize Booksy sync
      this.logStep('Initializing Booksy sync...');
      this.initializeBooksy();
      this.setupBooksyIpcHandlers();
      this.logStep('Booksy sync ready');

      // Initialize Extension Server
      this.logStep('Initializing Extension Server...');
      this.initExtensionServer();
      this.logStep('Extension Server ready (ws://localhost:19999)');

      this.logStep('Initialization complete!');
      logger.info('='.repeat(50));
      logger.info('Zira AI initialized successfully');
      logger.info('='.repeat(50));

    } catch (error: any) {
      logger.error(`Initialization failed at step ${this.initStep}:`, error);
      console.error(`Initialization failed at step ${this.initStep}:`, error);
      throw error;
    }
  }

  /**
   * Initialize WebSocket Server for Chrome Extension
   */
  private initExtensionServer(): void {
    try {
      this.wss = new WebSocketServer({ port: 19999 });
      
      this.wss.on('connection', (ws) => {
        logger.info('[Extension] Extension connected!');
        this.extensionSocket = ws;
        
        // Pass socket to ZiraAI
        if (this.ziraAI) {
            // We need to add this method to ZiraAI class first
            (this.ziraAI as any).setExtensionSocket(ws);
        }

        ws.on('message', (message) => {
          logger.info(`[Extension] Received: ${message}`);
          try {
             const msg = JSON.parse(message.toString());
             if (msg.type === 'RESULT' && this.ziraAI) {
                 (this.ziraAI as any).handleExtensionResponse(msg.id, msg.data);
             }
          } catch(e) { logger.error('[Extension] Parse error:', e); }
        });

        ws.on('close', () => {
          logger.info('[Extension] Extension disconnected');
          this.extensionSocket = null;
          if (this.ziraAI) (this.ziraAI as any).setExtensionSocket(null);
        });
      });
      
      this.wss.on('error', (err) => {
          logger.error('[Extension] Server error:', err);
      });
      
    } catch (e: any) {
      logger.error('[Extension] Failed to start server:', e);
    }
  }

  /**
   * Create printer driver from PrinterConfig
   */
  private createPrinterFromConfig(config: PrinterConfig | undefined, name: string): PrinterDriver | null {
    if (!config || !config.enabled) {
      logger.info(`[Printer] ${name} is not enabled`);
      return null;
    }

    logger.info(`[Printer] Creating ${name} driver for protocol: ${config.protocol}`);

    if (config.protocol === 'ZEBRA' || config.protocol === 'WINDOWS') {
      // ZEBRA or WINDOWS - use ZebraDriver (Windows Print Spooler)
      if (config.windowsPrinter) {
        const labelWidth = config.labelWidth || 100;
        const labelHeight = config.labelHeight || 50;
        logger.info(`[Printer] Creating ZebraDriver for "${config.windowsPrinter}" (${labelWidth}x${labelHeight}mm)`);
        return new ZebraDriver(config.windowsPrinter, labelWidth, labelHeight);
      }
      logger.warn(`[Printer] ${name}: ${config.protocol} protocol but no printer name configured`);
      return null;
    } else {
      // THERMAL or POSNET - use ThermalDriver (ESC/POS)
      const paperWidth = config.paperWidth || 80;
      const charsPerLine = config.charsPerLine || 48;
      const baudRate = config.baudRate || 9600;

      // Check if USB printer or COM port
      if (config.windowsPrinter) {
        // USB connection via Windows printer name
        logger.info(`[Printer] Creating ThermalDriver USB for "${config.windowsPrinter}" (${paperWidth}mm)`);
        return new ThermalDriver(config.windowsPrinter, baudRate, 'USB', paperWidth, charsPerLine);
      } else if (config.port) {
        // Serial port connection
        logger.info(`[Printer] Creating ThermalDriver Serial for ${config.port} at ${baudRate} baud (${paperWidth}mm)`);
        return new ThermalDriver(config.port, baudRate, 'SERIAL', paperWidth, charsPerLine);
      }

      logger.warn(`[Printer] ${name}: No printer name or COM port configured`);
      return null;
    }
  }

  /**
   * Create printer driver based on protocol (legacy single printer)
   */
  private createPrinterDriver(): PrinterDriver | null {
    const protocol = getConfigValue('printerProtocol');
    logger.info(`[Components] Creating printer driver for protocol: ${protocol}`);

    if (protocol === 'ZEBRA' || protocol === 'WINDOWS') {
      const printerName = getConfigValue('zebraPrinter');
      if (printerName) {
        const labelWidth = getConfigValue('labelWidth') || 100;
        const labelHeight = getConfigValue('labelHeight') || 50;
        logger.info(`[Components] Creating ZebraDriver for "${printerName}" (${labelWidth}x${labelHeight}mm)`);
        return new ZebraDriver(printerName, labelWidth, labelHeight);
      }
      logger.warn(`[Components] ${protocol} protocol selected but no printer name configured`);
      return null;
    } else {
      // THERMAL or POSNET - use ThermalDriver (ESC/POS)
      const printerPort = getConfigValue('printerPort');
      const zebraPrinter = getConfigValue('zebraPrinter'); // Can also use Windows printer for thermal

      if (zebraPrinter) {
        // USB connection via Windows printer name
        const baudRate = getConfigValue('printerBaudRate') || 9600;
        logger.info(`[Components] Creating ThermalDriver USB for "${zebraPrinter}" (80mm)`);
        return new ThermalDriver(zebraPrinter, baudRate, 'USB', 80, 48);
      } else if (printerPort) {
        // Serial port connection
        const baudRate = getConfigValue('printerBaudRate') || 9600;
        logger.info(`[Components] Creating ThermalDriver Serial for ${printerPort} at ${baudRate} baud`);
        return new ThermalDriver(printerPort, baudRate, 'SERIAL', 80, 48);
      }

      logger.warn('[Components] No printer name or port configured');
      return null;
    }
  }

  /**
   * Reinitialize printer driver (called when settings change)
   */
  async reinitializePrinter(): Promise<void> {
    logger.info('[Printer] Reinitializing printers...');
    const config = getConfig();

    // Disconnect all old printers from dictionary
    for (const [printerType, printer] of Object.entries(this.printers)) {
      if (printer) {
        try {
          printer.disconnect();
          logger.info(`[Printer] ${printerType} disconnected`);
        } catch (error) {
          logger.warn(`[Printer] Error disconnecting ${printerType}:`, error);
        }
      }
    }
    this.printers = {};

    // Disconnect legacy printers
    for (const [name, printer] of [
      ['receiptPrinter', this.receiptPrinter],
      ['labelPrinter', this.labelPrinter],
      ['printerDriver', this.printerDriver],
    ] as const) {
      if (printer) {
        try {
          printer.disconnect();
          logger.info(`[Printer] ${name} disconnected`);
        } catch (error) {
          logger.warn(`[Printer] Error disconnecting ${name}:`, error);
        }
      }
    }

    // Check if new printers dictionary is configured
    const hasPrintersDict = config.printers && Object.keys(config.printers).length > 0;

    if (hasPrintersDict && config.printers) {
      // NEW: Multi-printer dictionary mode
      logger.info('[Printer] Using printers dictionary mode');

      for (const [printerTypeStr, printerConfig] of Object.entries(config.printers)) {
        if (!printerConfig?.enabled) continue;

        const printerType = printerTypeStr as PrinterType;
        const driver = this.createPrinterFromConfig(printerConfig, printerType);

        if (driver) {
          try {
            await driver.connect();
            this.printers[printerType] = driver;
            logger.info(`[Printer] ${printerType} connected`);
          } catch (error) {
            logger.error(`[Printer] Failed to connect ${printerType}:`, error);
          }
        }
      }

      // Clear legacy printers
      this.receiptPrinter = null;
      this.labelPrinter = null;
      this.printerDriver = null;
    } else {
      // Check if legacy multi-printer mode is configured
      const hasLegacyMultiPrinter = config.receiptPrinter?.enabled || config.labelPrinter?.enabled;

      if (hasLegacyMultiPrinter) {
        // Legacy multi-printer mode
        logger.info('[Printer] Using legacy multi-printer mode');

        // Initialize receipt printer
        this.receiptPrinter = this.createPrinterFromConfig(config.receiptPrinter, 'Receipt Printer');
        if (this.receiptPrinter) {
          try {
            await this.receiptPrinter.connect();
            logger.info('[Printer] Receipt printer connected');
          } catch (error) {
            logger.error('[Printer] Failed to connect receipt printer:', error);
          }
        }

        // Initialize label printer
        this.labelPrinter = this.createPrinterFromConfig(config.labelPrinter, 'Label Printer');
        if (this.labelPrinter) {
          try {
            await this.labelPrinter.connect();
            logger.info('[Printer] Label printer connected');
          } catch (error) {
            logger.error('[Printer] Failed to connect label printer:', error);
          }
        }

        // Clear legacy printer
        this.printerDriver = null;
      } else {
        // Legacy single printer mode
        logger.info('[Printer] Using legacy single printer mode');
        this.receiptPrinter = null;
        this.labelPrinter = null;

        this.printerDriver = this.createPrinterDriver();
        if (this.printerDriver) {
          try {
            await this.printerDriver.connect();
            const status = await this.printerDriver.getStatus();
            logger.info('[Printer] Printer reinitialized:', JSON.stringify(status));
          } catch (error) {
            logger.error('[Printer] Failed to connect to printer:', error);
          }
        } else {
          logger.info('[Printer] No printer configured after reinit');
        }
      }
    }

    // Notify renderer about device status change
    this.mainWindow?.webContents.send(IPC_CHANNELS.DEVICE_STATUS, this.getDeviceStatus());
  }

  /**
   * Initialize hardware and network components
   */
  private async initializeComponents(): Promise<void> {
    // Initialize printers using the reinitialize method (handles both multi-printer and legacy)
    await this.reinitializePrinter();

    // Initialize barcode scanner
    logger.info('[Components] Initializing barcode scanner...');
    this.scanner = new HidScanner();
    this.scanner.start((barcode) => {
      logger.info(`[Scanner] Barcode scanned: ${barcode}`);
      if (this.socket?.isConnected()) {
        this.socket.sendBarcodeScan(barcode);
      }
      this.mainWindow?.webContents.send(IPC_CHANNELS.BARCODE_SCANNED, barcode);
      // Also notify POS window
      const posWindow = this.windowManager?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) {
        posWindow.webContents.send(IPC_CHANNELS.BARCODE_SCANNED, barcode);
      }
    });
    logger.info('[Components] Barcode scanner initialized');

    // Initialize socket client
    logger.info('[Components] Initializing socket client...');
    this.socket = new SocketClient();

    this.socket.on('job:new', async (job) => {
      logger.info(`[Socket] Received print job: ${job.jobId}`);
      await this.handlePrintJob(job);
    });

    this.socket.on('connected', () => {
      logger.info('[Socket] Connected to server');
      this.tray?.setStatus('connected');
      this.mainWindow?.webContents.send(IPC_CHANNELS.CONNECTION_STATUS, {
        connected: true,
        lastConnectedAt: new Date(),
      });

      // Auto-start SSH tunnel if enabled
      if (getConfigValue('sshTunnelEnabled')) {
        this.autoStartSshTunnel();
      }
    });

    this.socket.on('disconnected', () => {
      logger.info('[Socket] Disconnected from server');
      this.tray?.setStatus('disconnected');
      this.mainWindow?.webContents.send(IPC_CHANNELS.CONNECTION_STATUS, {
        connected: false,
      });
    });

    this.socket.on('error', (error) => {
      logger.error('[Socket] Error:', error);
    });

    logger.info('[Components] Socket client initialized');

    // Initialize remote session manager
    logger.info('[Components] Initializing remote session manager...');
    this.remoteSessionManager = new RemoteSessionManager();
    await this.remoteSessionManager.initialize();

    // Setup remote session manager event handlers
    this.setupRemoteSessionHandlers();

    logger.info('[Components] Remote session manager initialized');

    // Initialize SSH tunnel manager
    logger.info('[Components] Initializing SSH tunnel manager...');
    this.sshTunnelManager = new SshTunnelManager();
    await this.sshTunnelManager.initialize();
    this.setupSshTunnelHandlers();
    logger.info('[Components] SSH tunnel manager initialized');

    // Initialize Browser Controller
    logger.info('[Components] Initializing browser controller...');
    this.browserController = new BrowserController();
    logger.info('[Components] Browser controller initialized');

    // Initialize Zira AI if enabled
    await this.initializeZiraAI();

    // Initialize Telegram bot if enabled
    await this.initializeTelegram();
  }

  /**
   * Initialize Telegram bot if enabled and configured
   */
  private async initializeTelegram(): Promise<void> {
    const enabled = getConfigValue('telegramEnabled');

    if (!enabled) {
      logger.info('[Telegram] Telegram remote control is disabled');
      return;
    }

    // Try to get decrypted token first, fallback to plain text (legacy/migration)
    let token: string | null = null;
    const encryptedToken = getConfigValue('encryptedTelegramToken') as string | undefined;

    if (encryptedToken && safeStorage.isEncryptionAvailable()) {
      try {
        token = safeStorage.decryptString(Buffer.from(encryptedToken, 'base64'));
        logger.info('[Telegram] Token decrypted successfully');
      } catch (error) {
        logger.error('[Telegram] Failed to decrypt token:', error);
      }
    }

    // Fallback to plain text token (legacy)
    if (!token) {
      token = getConfigValue('telegramToken') as string | undefined || null;
      if (token) {
        logger.warn('[Telegram] Using plain text token (legacy). Consider re-saving to encrypt.');
      }
    }

    if (!token) {
      logger.warn('[Telegram] Telegram enabled but no bot token configured');
      return;
    }

    try {
      logger.info('[Telegram] Initializing Telegram bot...');

      // Create bot
      this.telegramBot = createTelegramBot(token);

      // Register native commands (moltbot-style: /reset, /model, /context, /memory, etc.)
      registerNativeCommands(this.telegramBot);

      // Register commands with screen capturer, input executor, browser controller, and printer functions
      // Note: ziraAI is removed - AI chat uses server proxy only
      if (this.remoteSessionManager) {
        registerCommands(this.telegramBot, {
          screenCapturer: (this.remoteSessionManager as any).screenCapturer,
          inputExecutor: (this.remoteSessionManager as any).inputExecutor,
          browserController: this.browserController || undefined,
          ziraAI: undefined, // SECURITY: Local AI disabled, use server proxy
          printerFunctions: {
            getPrintersStatus: () => this.getPrintersStatus(),
            testPrint: () => this.testPrint(),
            testPrinterByType: (type: string) => this.testPrinterByType(type as PrinterType),
            openCashDrawer: (type?: string) => this.openCashDrawer(type as PrinterType | undefined),
            printLabel: (barcode: string, text?: string) => this.printLabel(barcode, text),
          },
        });
      }

      // Start polling
      await startPolling(this.telegramBot);

      logger.info('[Telegram] Telegram bot initialized successfully');
    } catch (error: any) {
      logger.error('[Telegram] Failed to initialize Telegram bot:', error);
    }
  }

  /**
   * Initialize Zira AI chatbot
   * SECURITY: Only proxy mode is supported - API key stays on server
   * Local API key storage has been removed to prevent key leakage in public app
   */
  private async initializeZiraAI(): Promise<void> {
    const enabled = getConfigValue('aiEnabled');

    if (!enabled) {
      logger.info('[ZiraAI] Zira AI is disabled');
      return;
    }

    // Wire up Booksy provider for AI tools
    setBooksySyncProvider(() => this.booksySync);

    // Priority order for API key:
    // 0. Environment variable (for testing/development)
    // 1. Server-provided key (fetched after login) - BEST: key managed by server
    // 2. User's local key (encrypted) - OK: user provides their own OpenRouter key
    // 3. Proxy mode (no tools) - FALLBACK: server handles AI, no local tools

    let apiKey: string | null = null;
    let keySource = 'none';

    // Option 0: Environment variable (for testing)
    const envApiKey = process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY;
    if (envApiKey) {
      apiKey = envApiKey;
      keySource = 'env';
      logger.info('[ZiraAI] Using environment variable API key (dev/test mode)');
    }

    // Option 1: Try to get server-provided key (best for security)
    if (!apiKey) {
      const serverAiKey = this.serverProvidedAiKey; // Set after login
      if (serverAiKey) {
        apiKey = serverAiKey;
        keySource = 'server';
        logger.info('[ZiraAI] Using server-provided API key (secure, with tools)');
      }
    }

    // Option 2: Try user's local encrypted key
    if (!apiKey) {
      const localApiKey = getSecureAiApiKey();
      const useLocalMode = getConfigValue('aiLocalMode') as boolean;
      logger.info(`[ZiraAI] Checking local key: hasKey=${!!localApiKey}, localMode=${useLocalMode}`);
      if (localApiKey && useLocalMode) {
        apiKey = localApiKey;
        keySource = 'local';
        logger.info('[ZiraAI] Using user-provided API key (local mode with tools)');
      }
    }

    // Initialize ZiraAI with tools if we have a key
    if (apiKey) {
      try {
        this.ziraAI = new ZiraAI({
          apiKey: apiKey,
          model: (getConfigValue('aiModel') as string) || 'x-ai/grok-4.1-fast',
          provider: 'openrouter',
        });
        
        // Pass extension socket if already connected
        if (this.extensionSocket) {
            (this.ziraAI as any).setExtensionSocket(this.extensionSocket);
        }
        
        setConfigValue('aiProxyMode', false);
        logger.info(`[ZiraAI] Local AI initialized with tool support (key source: ${keySource})`);
      } catch (error: any) {
        logger.error('[ZiraAI] Failed to init local AI:', error);
        setConfigValue('aiProxyMode', true);
        this.ziraAI = null;
      }
    } else {
      // PROXY MODE: API key stays on server (secure, but no tools)
      logger.info('[ZiraAI] Running in proxy mode (API key on server - no tools)');
      setConfigValue('aiProxyMode', true);
      this.ziraAI = null;
    }
  }

  // Server-provided AI API key (in memory only, never persisted)
  private serverProvidedAiKey: string | null = null;

  /**
   * Set server-provided AI key (called after login)
   * Key stays in memory only - secure!
   */
  setServerAiKey(apiKey: string | null): void {
    this.serverProvidedAiKey = apiKey;
    if (apiKey) {
      logger.info('[ZiraAI] Server-provided AI key set (in memory only)');
      // Re-initialize with the new key
      this.initializeZiraAI();
    }
  }

  /**
   * Restart Zira AI (called when settings change)
   * SECURITY: Only proxy mode is supported - this just re-checks settings
   */
  async restartZiraAI(): Promise<void> {
    logger.info('[ZiraAI] Restarting Zira AI (proxy mode)...');
    // In proxy mode, just ensure settings are applied
    await this.initializeZiraAI();
  }

  /**
   * Auto-configure AI chatbot after login
   * BEST MODE: Server provides API key for local tools (key in memory only)
   * FALLBACK: Proxy mode (no tools, key stays on server)
   */
  private async autoConfigureAI(accessToken: string): Promise<void> {
    const serverUrl = getConfigValue('serverUrl') || 'https://api.enail.pro';
    const client = new ApiClient(serverUrl as string);
    const aiConfig = await client.getAiConfig(accessToken);

    if (aiConfig?.available) {
      setConfigValue('aiEnabled', true);
      if (aiConfig.model) setConfigValue('aiModel', aiConfig.model);

      // BEST: Server provides API key for local tools
      if (aiConfig.apiKey) {
        logger.info('[ZiraAI] Server provided API key - enabling local tools!');
        this.setServerAiKey(aiConfig.apiKey);
        // Note: key is in memory only, never written to disk!
      } else {
        // FALLBACK: Proxy mode (no tools)
        logger.info('[ZiraAI] AI available via server proxy (no tools)');
        setConfigValue('aiProxyMode', true);
        this.setServerAiKey(null);
      }
    } else {
      logger.info('[ZiraAI] AI not available for this salon');
      this.setServerAiKey(null);
    }
  }

  /**
   * Get Zira AI status for UI
   * Shows local mode with tools or proxy mode
   */
  getZiraAIStatus(): ZiraAIStatus {
    const authToken = getSecureAuthToken();
    const isAuthenticated = !!authToken;
    const isLocalMode = !!this.ziraAI;
    const hasServerKey = !!this.serverProvidedAiKey;
    const hasLocalKey = !!getSecureAiApiKey();

    // HYBRID MODE: Tools always available via local detection!
    const hybridToolsEnabled = isAuthenticated; // Tools work when logged in

    return {
      enabled: getConfigValue('aiEnabled') || false,
      ready: isLocalMode || isAuthenticated, // Ready if local AI or logged in
      model: isLocalMode ? (getConfigValue('aiModel') as string) || 'x-ai/grok-4.1-fast' : 'hybrid-mode',
      hasApiKey: hasServerKey || hasLocalKey || isAuthenticated,
      localMode: isLocalMode,
      toolsEnabled: isLocalMode || hybridToolsEnabled, // Tools work in hybrid mode too!
      keySource: hasServerKey ? 'server' : (hasLocalKey ? 'local' : 'hybrid'),
    };
  }

  /**
   * Detect tool from user message (Vietnamese + English patterns)
   * Supports multi-step browser conversation flow
   * Now supports natural language patterns (no strict ^ anchor)
   * Returns tool name and args if detected, null otherwise
   */
  private detectToolFromMessage(message: string): { name: string; args: any } | null {
    const msg = message.toLowerCase().trim();

    // === BROWSER/URL OPEN PATTERNS (flexible - no ^ anchor) ===
    // Matches: "mở facebook", "bạn mở facebook", "hãy mở facebook cho tôi", etc.
    if (/(mở|open|xem|check|lướt|browse|vào)\s*(facebook|fb)\b/i.test(msg)) {
      return { name: 'browser_setup', args: { url: 'facebook.com' } };
    }
    if (/(mở|open|xem|check|vào)\s*(gmail|email|mail)\b/i.test(msg)) {
      return { name: 'browser_setup', args: { url: 'gmail.com' } };
    }
    if (/(mở|open|xem|check|vào)\s*(youtube|yt)\b/i.test(msg)) {
      return { name: 'browser_setup', args: { url: 'youtube.com' } };
    }
    if (/(mở|open|xem|check|vào)\s*(booksy)\b/i.test(msg)) {
      return { name: 'browser_setup', args: { url: 'biz.booksy.com' } };
    }
    if (/(mở|open|vào)\s*(chrome|trình duyệt|browser)\b/i.test(msg)) {
      return { name: 'open_chrome', args: {} };
    }
    // Generic URL pattern (flexible)
    const urlMatch = msg.match(/(mở|open|xem|go to|truy cập|vào)\s+(https?:\/\/\S+|www\.\S+|\S+\.(com|net|org|io|vn|pro))/i);
    if (urlMatch) {
      return { name: 'browser_setup', args: { url: urlMatch[2] } };
    }

    // === MULTI-STEP BROWSER PATTERNS (Facebook-optimized) ===

    // LƯỚT FACEBOOK - scroll and read patterns
    // "lướt facebook", "lướt xem có gì", "lướt 20 bài", "scroll facebook"
    const scrollFbMatch = msg.match(/(lướt|scroll|xem)\s*(facebook|fb)?\s*(\d+)?\s*(bài|posts?)?/i);
    if (scrollFbMatch || /(lướt|scroll).*(và|then|rồi).*(đọc|tóm tắt|read|summarize)/i.test(msg)) {
      const count = scrollFbMatch?.[3] ? parseInt(scrollFbMatch[3], 10) : 10;
      return { name: 'browser_scroll_and_read', args: { direction: 'down', times: Math.ceil(count / 3), summarize: true } };
    }

    // ĐỌC TIN - read news/posts patterns
    // "đọc tin", "xem bài viết", "có gì mới", "news feed"
    if (/(đọc|read)\s*(tin|bài|news|posts?)/i.test(msg) ||
        /(có gì|what's).*(mới|new)/i.test(msg) ||
        /news\s*feed/i.test(msg)) {
      return { name: 'browser_scroll_and_read', args: { direction: 'down', times: 5, summarize: true } };
    }

    // Summarize patterns (flexible)
    if (/(tóm tắt|summarize|summary|tóm lược)/i.test(msg)) {
      return { name: 'browser_summarize', args: { focus: 'all' } };
    }

    // Get posts / list posts (flexible)
    if (/(xem|list|liệt kê|show|cho xem).*(bài|posts?|tin)/i.test(msg) ||
        /(bài viết|posts?).*(trên|hiện|gì)/i.test(msg)) {
      return { name: 'browser_get_posts', args: { limit: 10 } };
    }

    // Find posts by topic - "tìm bài về nhạc", "find posts about music"
    const topicMatch = msg.match(/(tìm|find|search|lọc).*(bài|posts?|tin).*(về|about|liên quan|related to)\s+(.+)/i);
    if (topicMatch) {
      return { name: 'browser_find_posts_by_topic', args: { topic: topicMatch[4].trim() } };
    }
    // Alternative: "bài về nhạc", "posts about music"
    const topicMatch2 = msg.match(/(bài|posts?).*(về|about)\s+(.+)/i);
    if (topicMatch2) {
      return { name: 'browser_find_posts_by_topic', args: { topic: topicMatch2[3].trim() } };
    }

    // TRẢ LỜI / COMMENT patterns (flexible)
    // "comment bài 0 hay quá", "bình luận bài số 2: đẹp quá", "trả lời bài 1"
    const commentMatch = msg.match(/(comment|bình luận|trả lời|reply|viết).*(bài|post)?\s*#?(\d+)\s*[:\-]?\s*(.+)?/i);
    if (commentMatch) {
      const postIndex = parseInt(commentMatch[3], 10);
      const commentText = commentMatch[4]?.trim() || '';
      if (commentText) {
        return { name: 'browser_comment_on_post', args: { post_index: postIndex, comment: commentText, submit: false } };
      }
      // If no comment text, show the post for user to see what to comment
      return { name: 'browser_get_posts', args: { limit: 10, highlight: postIndex } };
    }

    // Simple comment without post index - "comment hay quá" -> assume last viewed post
    const simpleComment = msg.match(/^(comment|bình luận|trả lời)\s+(.+)/i);
    if (simpleComment && !simpleComment[2].match(/^(bài|post)/i)) {
      return { name: 'browser_comment_on_post', args: { post_index: 0, comment: simpleComment[2].trim(), submit: false } };
    }

    // LIKE / REACT patterns
    // "like bài 2", "thích bài 0", "react bài 1"
    const likeMatch = msg.match(/(like|thích|react|yêu thích).*(bài|post)?\s*#?(\d+)/i);
    if (likeMatch) {
      const postIndex = parseInt(likeMatch[3], 10);
      return { name: 'browser_like_post', args: { post_index: postIndex } };
    }

    // Type in browser - "gõ ...", "type ..." (flexible)
    const typeMatch = msg.match(/(gõ|type|viết|nhập)\s+(.+)/i);
    if (typeMatch && !typeMatch[2].match(/^(bài|post|comment)/i)) {
      return { name: 'browser_type', args: { text: typeMatch[2].trim(), submit: false } };
    }

    // Submit / Send - "gửi", "submit", "enter", "đăng"
    if (/^(gửi|submit|enter|send|đăng|post)$/i.test(msg)) {
      return { name: 'browser_type', args: { text: '', submit: true } };
    }

    // === BOOKSY APPOINTMENT PATTERNS ===
    if (/(mai|tomorrow).*(bao nhiêu|mấy|có ai|khách|lịch|booking|appointment)/i.test(msg) ||
        /(bao nhiêu|mấy|có ai|khách|lịch).*(mai|tomorrow)/i.test(msg)) {
      return { name: 'booksy_get_bookings', args: { date: 'tomorrow' } };
    }
    if (/(hôm nay|today).*(bao nhiêu|mấy|có ai|khách|lịch|booking|appointment)/i.test(msg) ||
        /(bao nhiêu|mấy|có ai|khách|lịch).*(hôm nay|today)/i.test(msg) ||
        /^(xem lịch|check calendar|lịch hẹn)/i.test(msg)) {
      return { name: 'booksy_get_bookings', args: { date: 'today' } };
    }
    if (/(booksy|lịch hẹn|appointment|booking).*(status|trạng thái)/i.test(msg)) {
      return { name: 'booksy_get_status', args: {} };
    }

    // === APPLICATION PATTERNS (flexible) ===
    if (/(mở|open)\s*(notepad)/i.test(msg)) {
      return { name: 'open_application', args: { app_name: 'notepad' } };
    }
    if (/(mở|open)\s*(calculator|máy tính)/i.test(msg)) {
      return { name: 'open_application', args: { app_name: 'calculator' } };
    }
    if (/(mở|open)\s*(explorer|file|thư mục)/i.test(msg)) {
      return { name: 'open_application', args: { app_name: 'explorer' } };
    }
    if (/(mở|open)\s*(paint)/i.test(msg)) {
      return { name: 'open_application', args: { app_name: 'paint' } };
    }
    if (/(mở|open)\s*(cmd|command|terminal)/i.test(msg)) {
      return { name: 'open_application', args: { app_name: 'cmd' } };
    }
    if (/(mở|open)\s*(settings|cài đặt)/i.test(msg)) {
      return { name: 'open_application', args: { app_name: 'settings' } };
    }

    // Screenshot pattern
    if (/(chụp|screenshot|capture|chụp màn hình|screen)/i.test(msg)) {
      return { name: 'take_screenshot', args: {} };
    }

    // System info pattern
    if (/(thông tin|info|system|hệ thống|máy tính)/i.test(msg) && /(máy|system|computer)/i.test(msg)) {
      return { name: 'get_system_info', args: {} };
    }

    // Login confirmation patterns (for browser_check_login)
    if (/^(xong rồi|done|đã đăng nhập|đăng nhập xong|logged in|xong|ok rồi)/i.test(msg)) {
      return { name: 'browser_check_login', args: {} };
    }

    // Scroll patterns - "cuộn tiếp", "scroll more", "xem thêm", "tiếp tục" (flexible)
    if (/(cuộn|scroll|lướt|tiếp|more|xem thêm|tiếp tục|continue)/i.test(msg) &&
        !/(facebook|fb|youtube|gmail)/i.test(msg)) {
      return { name: 'browser_scroll_and_read', args: { direction: 'down', times: 3, summarize: true } };
    }
    // Scroll up
    if (/(cuộn|scroll|lướt).*(lên|up)/i.test(msg)) {
      return { name: 'browser_scroll_and_read', args: { direction: 'up', times: 3 } };
    }

    // Close browser pattern
    if (/(đóng|close|tắt|hủy|cancel).*(browser|trình duyệt|tab|chrome|lại)/i.test(msg) ||
        /^(đóng|close|tắt)$/i.test(msg)) {
      return { name: 'browser_close', args: {} };
    }

    // === CATCH-ALL FACEBOOK PATTERN ===
    // If message mentions facebook/fb with any action intent, open Facebook
    if (/(facebook|fb)/i.test(msg) &&
        /(lướt|xem|đọc|scroll|read|browse|check|mở|open|vào|tin|bài|post|news)/i.test(msg)) {
      return { name: 'browser_setup', args: { url: 'facebook.com' } };
    }

    // No tool detected - let server AI handle
    return null;
  }

  /**
   * Chat with Zira AI - DEPRECATED
   * SECURITY: Local AI mode is disabled. Use proxy mode via AI_CHAT IPC.
   */
  async chatWithZiraAI(_message: string, _userId?: string): Promise<ZiraAIChatResponse> {
    throw new Error('Local AI mode is disabled for security. Please login to use AI chat via server proxy.');
  }

  /**
   * Clear Zira AI conversation history
   */
  clearZiraAIHistory(userId?: string): void {
    // Clear proxy history
    const convId = userId || 'default';
    this.proxyHistory.delete(convId);
  }

  /**
   * Restart Telegram bot (called when settings change)
   */
  async restartTelegram(): Promise<void> {
    logger.info('[Telegram] Restarting Telegram bot...');

    // Stop existing bot
    if (this.telegramBot) {
      await stopPolling(this.telegramBot);
      destroyTelegramBot();
      this.telegramBot = null;
    }

    // Re-initialize
    await this.initializeTelegram();
  }

  /**
   * Get Telegram bot status for UI
   */
  getTelegramStatus(): TelegramBotStatus {
    // Check if token is configured (encrypted or plain)
    const hasEncryptedToken = !!(getConfigValue('encryptedTelegramToken') as string);
    const hasPlainToken = !!(getConfigValue('telegramToken') as string);

    return {
      enabled: getConfigValue('telegramEnabled') || false,
      running: isPollingRunning(),
      botUsername: getBotUsername() || undefined,
      lastError: getLastError() || undefined,
      hasToken: hasEncryptedToken || hasPlainToken,
    };
  }

  /**
   * Setup remote session event handlers
   */
  private setupRemoteSessionHandlers(): void {
    if (!this.remoteSessionManager || !this.socket) return;

    // Handle session requests from dashboard (via socket)
    this.socket.on('remote:session-request', async (request: RemoteSessionRequest) => {
      logger.info(`[Remote] Session request from: ${request.userName || request.userId}`);
      try {
        await this.remoteSessionManager?.handleSessionRequest(request);
      } catch (error) {
        logger.error('[Remote] Error handling session request:', error);
      }
    });

    // Handle WebRTC offer from dashboard
    this.socket.on('remote:offer', async (data: { sessionId: string; offer: RTCSessionDescriptionInit }) => {
      logger.info(`[Remote] WebRTC offer received for session: ${data.sessionId}`);
      try {
        const answer = await this.remoteSessionManager?.handleOffer(data.offer);
        if (answer) {
          this.socket?.sendRemoteAnswer(data.sessionId, answer);
        }
      } catch (error) {
        logger.error('[Remote] Error handling offer:', error);
      }
    });

    // Handle ICE candidates from dashboard
    this.socket.on('remote:ice-candidate', async (data: { sessionId: string; candidate: RTCIceCandidateInit }) => {
      logger.debug('[Remote] ICE candidate received');
      try {
        await this.remoteSessionManager?.handleIceCandidate(data.candidate);
      } catch (error) {
        logger.error('[Remote] Error handling ICE candidate:', error);
      }
    });

    // Handle session end from dashboard
    this.socket.on('remote:session-end', (data: { sessionId: string; reason?: string }) => {
      logger.info(`[Remote] Session end request: ${data.reason || 'no reason'}`);
      this.remoteSessionManager?.endSession(data.reason);
    });

    // Handle remote session manager events
    this.remoteSessionManager.on('sessionRequest', async (request: RemoteSessionRequest) => {
      try {
        // Show dialog to user
        const accepted = await this.remoteSessionManager?.showSessionRequestDialog(
          request,
          this.mainWindow || undefined
        );

        if (accepted) {
          await this.remoteSessionManager?.acceptSession();
        } else {
          this.remoteSessionManager?.rejectSession('User declined');
        }
      } catch (error) {
        logger.error('[Remote] Error handling session request dialog:', error);
        this.remoteSessionManager?.rejectSession('Error processing request');
      }
    });

    this.remoteSessionManager.on('sessionResponse', (response) => {
      this.socket?.sendRemoteSessionResponse(response);
    });

    this.remoteSessionManager.on('iceCandidate', (candidate: RTCIceCandidateInit) => {
      const session = this.remoteSessionManager?.getState().session;
      if (session) {
        this.socket?.sendRemoteIceCandidate(session.sessionId, candidate);
      }
    });

    this.remoteSessionManager.on('stateChanged', (state: RemoteControlState) => {
      // Notify renderer about state change
      this.mainWindow?.webContents.send(IPC_CHANNELS.REMOTE_STATE_CHANGED, state);
    });

    this.remoteSessionManager.on('sessionStarted', (session) => {
      logger.info(`[Remote] Session started: ${session.sessionId}`);
    });

    this.remoteSessionManager.on('sessionEnded', (session) => {
      logger.info(`[Remote] Session ended: ${session.sessionId}`);
      // Notify backend that session ended
      this.socket?.sendRemoteSessionEnd(session.sessionId);
    });
  }

  /**
   * Setup SSH tunnel event handlers
   */
  private setupSshTunnelHandlers(): void {
    if (!this.sshTunnelManager || !this.socket) return;

    // Handle SSH tunnel requests from backend (via socket)
    this.socket.on('ssh-tunnel:request', async (request: SshTunnelRequest) => {
      logger.info(`[SSH Tunnel] Request from: ${request.userName}`);
      try {
        const response = await this.sshTunnelManager!.handleTunnelRequest(
          request,
          this.mainWindow || undefined
        );

        // Send response back to backend
        this.socket?.sendSshTunnelResponse(response);
      } catch (error: any) {
        logger.error('[SSH Tunnel] Error handling request:', error);
        this.socket?.sendSshTunnelResponse({
          requestId: request.requestId,
          accepted: false,
          reason: `Error: ${error.message}`,
        });
      }
    });

    // Status changes → notify renderer
    this.sshTunnelManager.on('statusChanged', (status: SshTunnelStatus) => {
      this.mainWindow?.webContents.send(IPC_CHANNELS.SSH_TUNNEL_STATUS_CHANGED, status);
    });
  }

  /**
   * Auto-start SSH tunnel when sshTunnelEnabled=true
   * Called after socket connects to backend
   */
  private async autoStartSshTunnel(): Promise<void> {
    if (!this.sshTunnelManager) {
      logger.warn('[SSH Tunnel] Cannot auto-start: manager not initialized');
      return;
    }

    // Skip if already connected
    const currentStatus = this.sshTunnelManager.getStatus();
    if (currentStatus.state === 'connected' || currentStatus.state === 'connecting') {
      logger.info('[SSH Tunnel] Already connected/connecting, skipping auto-start');
      return;
    }

    // Random port 10001-10999
    const port = 10001 + Math.floor(Math.random() * 999);

    logger.info(`[SSH Tunnel] Auto-starting tunnel on port ${port}...`);

    const result = await this.sshTunnelManager.autoStart(port);

    if (result) {
      logger.info(`[SSH Tunnel] Auto-start successful: port=${result.port}, username=${result.username}`);
      // Notify backend
      this.socket?.sendSshTunnelRegistered({
        port: result.port,
        username: result.username,
        publicKey: result.publicKey,
      });
    } else {
      logger.warn('[SSH Tunnel] Auto-start failed');
    }
  }

  /**
   * Setup IPC handlers for renderer communication
   */
  private setupIpcHandlers(): void {
    // Config handlers
    ipcMain.handle(IPC_CHANNELS.GET_CONFIG, () => {
      logger.debug('[IPC] GET_CONFIG');
      return getConfig();
    });

    ipcMain.handle(IPC_CHANNELS.SET_CONFIG, async (_, config: Partial<AgentConfig>) => {
      logger.debug('[IPC] SET_CONFIG:', Object.keys(config));
      const result = setConfig(config);

      // Reinitialize printer if printer settings changed
      const printerSettingsChanged =
        'printerProtocol' in config ||
        'printerPort' in config ||
        'zebraPrinter' in config ||
        'printerBaudRate' in config ||
        'receiptPrinter' in config ||
        'labelPrinter' in config ||
        'printers' in config;  // NEW: dictionary config

      if (printerSettingsChanged) {
        logger.info('[IPC] Printer settings changed, reinitializing printer...');
        await this.reinitializePrinter();
      }

      // Handle Telegram token encryption - SECURITY: Never store plain text
      if ('telegramToken' in config && config.telegramToken) {
        const plainToken = config.telegramToken;
        // Always clear plain text immediately for security
        setConfigValue('telegramToken', '');

        if (safeStorage.isEncryptionAvailable()) {
          try {
            const encrypted = safeStorage.encryptString(plainToken).toString('base64');
            setConfigValue('encryptedTelegramToken', encrypted);
            logger.info('[IPC] Telegram token encrypted and stored securely');
          } catch (error) {
            logger.error('[IPC] Failed to encrypt Telegram token:', error);
            // SECURITY: Do NOT store unencrypted - reject the token
            logger.error('[IPC] SECURITY: Telegram token rejected - encryption required');
          }
        } else {
          // SECURITY: Encryption not available - reject token, never store plain text
          logger.error('[IPC] SECURITY: safeStorage not available - Telegram token REJECTED (plain text storage disabled)');
          // Token is already cleared above, do not store it
        }
      }

      // SECURITY: Local AI API key - encrypt using Windows DPAPI
      // User can provide their own OpenRouter key for local tools
      if ('aiApiKey' in config && config.aiApiKey) {
        const aiApiKey = config.aiApiKey as string;
        if (setSecureAiApiKey(aiApiKey)) {
          logger.info('[IPC] AI API key encrypted and stored securely');
        } else {
          logger.error('[IPC] SECURITY: safeStorage not available - AI API key REJECTED');
        }
      }

      // Reinitialize Telegram if Telegram settings changed
      const telegramSettingsChanged =
        'telegramEnabled' in config ||
        'telegramToken' in config ||
        'telegramAllowedIds' in config;

      if (telegramSettingsChanged) {
        logger.info('[IPC] Telegram settings changed, restarting bot...');
        await this.restartTelegram();
      }

      // Reinitialize Zira AI if AI settings changed
      const aiSettingsChanged =
        'aiEnabled' in config ||
        'aiModel' in config ||
        'aiMaxTokens' in config ||
        'aiTemperature' in config ||
        'aiLocalMode' in config ||  // CRITICAL: Local mode toggle
        'aiApiKey' in config;       // CRITICAL: API key for local mode

      if (aiSettingsChanged) {
        logger.info('[IPC] AI settings changed, restarting Zira AI...');
        await this.restartZiraAI();
      }

      return result;
    });

    // Connection handlers
    ipcMain.handle(IPC_CHANNELS.CONNECT, async () => {
      logger.info('[IPC] CONNECT requested');
      await this.connect();
      return { success: this.socket?.isConnected() };
    });

    ipcMain.handle(IPC_CHANNELS.CONNECT_WITH_API_KEY, async (_, apiKey: string) => {
      logger.info('[IPC] CONNECT_WITH_API_KEY requested');

      // SECURITY: Input validation
      if (!InputValidator.isValidApiKey(apiKey)) {
        logger.warn('[IPC] CONNECT_WITH_API_KEY invalid API key format');
        return { success: false, error: 'Invalid API key format' };
      }

      // SECURITY: Rate limit API key connection attempts (5 per minute)
      if (!rateLimiter.check('connect_api_key', 5, 60000)) {
        logger.warn('[IPC] CONNECT_WITH_API_KEY rate limited');
        return { success: false, error: 'Too many connection attempts. Please wait a minute.' };
      }

      try {
        const result = await this.connectWithApiKey(apiKey);
        // Clear rate limit on success
        rateLimiter.clear('connect_api_key');
        return { success: true, data: result };
      } catch (error: any) {
        logger.error('[IPC] CONNECT_WITH_API_KEY failed:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.DISCONNECT, () => {
      logger.info('[IPC] DISCONNECT requested');
      this.socket?.disconnect();
      return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.GET_STATUS, () => {
      logger.debug('[IPC] GET_STATUS');
      return {
        connected: this.socket?.isConnected() || false,
        deviceStatus: this.getDeviceStatus(),
      };
    });

    // Printer handlers
    ipcMain.handle(IPC_CHANNELS.LIST_PORTS, async () => {
      logger.info('[IPC] LIST_PORTS requested');
      const ports = await PosnetDriver.listPorts();
      logger.info(`[IPC] Found ports: ${ports.join(', ') || 'none'}`);
      return ports;
    });

    ipcMain.handle(IPC_CHANNELS.LIST_WINDOWS_PRINTERS, async () => {
      logger.info('[IPC] LIST_WINDOWS_PRINTERS requested');
      const printers = await ZebraDriver.listPrinters();
      logger.info(`[IPC] Found printers: ${printers.join(', ') || 'none'}`);
      return printers;
    });

    ipcMain.handle(IPC_CHANNELS.TEST_PRINT, async () => {
      logger.info('[IPC] TEST_PRINT requested');
      const result = await this.testPrint();
      logger.info(`[IPC] TEST_PRINT result: ${JSON.stringify(result)}`);
      return result;
    });

    ipcMain.handle(IPC_CHANNELS.TEST_PRINTER_BY_TYPE, async (_, printerType: string) => {
      logger.info(`[IPC] TEST_PRINTER_BY_TYPE requested: ${printerType}`);
      const result = await this.testPrinterByType(printerType as PrinterType);
      logger.info(`[IPC] TEST_PRINTER_BY_TYPE result: ${JSON.stringify(result)}`);
      return result;
    });

    // Dialog handlers
    ipcMain.handle('dialog:selectFolder', async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return result.filePaths[0] || null;
    });

    // Debug handlers
    ipcMain.handle('debug:open-devtools', () => {
      logger.info('[IPC] Opening DevTools...');
      this.mainWindow?.webContents.openDevTools();
      return { success: true };
    });

    ipcMain.handle('debug:open-logs', () => {
      logger.info('[IPC] Opening logs folder...');
      const logsPath = join(app.getPath('userData'), 'logs');
      shell.openPath(logsPath);
      return { success: true };
    });

    ipcMain.handle('debug:get-diagnostics', () => {
      return {
        appVersion: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        platform: `${process.platform} ${process.arch}`,
        userData: app.getPath('userData'),
        debugMode: isDebugMode,
        connected: this.socket?.isConnected() || false,
        printerConnected: this.printerDriver?.isConnected() || false,
        printerProtocol: getConfigValue('printerProtocol'),
        scannerActive: this.scanner?.isActive() || false,
      };
    });

    // Auto-start handlers
    ipcMain.handle('app:set-auto-start', (_, enabled: boolean) => {
      logger.info(`[IPC] SET_AUTO_START: ${enabled}`);
      this.setAutoStart(enabled);
      return { success: true };
    });

    ipcMain.handle('app:get-auto-start', () => {
      logger.info('[IPC] GET_AUTO_START');
      return this.getAutoStartStatus();
    });

    // Shell/URL handlers
    ipcMain.handle('shell:openExternal', async (_, url: string) => {
      logger.info(`[IPC] SHELL:OPEN_EXTERNAL: ${url}`);
      try {
        // Validate URL format
        if (!InputValidator.isValidUrl(url)) {
          throw new Error('Invalid URL format');
        }
        await shell.openExternal(url);
        return { success: true };
      } catch (error: any) {
        logger.error('[IPC] SHELL:OPEN_EXTERNAL failed:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('shell:launchChromeDebug', async (_, port: number = 9222) => {
      logger.info(`[IPC] SHELL:LAUNCH_CHROME_DEBUG port=${port}`);
      try {
        const { exec } = require('child_process');
        const chromePaths = [
          process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
          process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
          process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
        ];

        let chromePath = '';
        for (const p of chromePaths) {
          try {
            const fs = require('fs');
            if (fs.existsSync(p)) {
              chromePath = p;
              break;
            }
          } catch (err: any) { logger.debug('[AppLegacy] check chrome path failed:', err?.message); }
        }

        if (!chromePath) {
          throw new Error('Chrome not found. Please install Google Chrome.');
        }

        const userDataDir = join(app.getPath('userData'), 'booksy-chrome-profile');
        const cmd = `"${chromePath}" --remote-debugging-port=${port} --user-data-dir="${userDataDir}" https://pro.booksy.com`;

        exec(cmd, (error: any) => {
          if (error) {
            logger.error('[IPC] Chrome launch error:', error);
          }
        });

        return { success: true, chromePath };
      } catch (error: any) {
        logger.error('[IPC] SHELL:LAUNCH_CHROME_DEBUG failed:', error);
        return { success: false, error: error.message };
      }
    });

    // Chrome checker handlers
    ipcMain.handle('chrome:isRunning', async () => {
      logger.debug('[IPC] CHROME:IS_RUNNING');
      try {
        const { isChromeRunning } = await import('./browser/chrome-checker');
        const result = await isChromeRunning();
        return { success: true, ...result };
      } catch (error: any) {
        logger.error('[IPC] CHROME:IS_RUNNING failed:', error);
        return { success: false, isRunning: false, processCount: 0, error: error.message };
      }
    });

    ipcMain.handle('chrome:checkAndPrompt', async () => {
      logger.info('[IPC] CHROME:CHECK_AND_PROMPT');
      try {
        const { checkChromeAndPrompt } = await import('./browser/chrome-checker');
        const result = await checkChromeAndPrompt(this.mainWindow, {
          title: 'Chrome đang chạy',
          message: 'Vui lòng đóng tất cả cửa sổ Chrome để tiếp tục.\n\nChương trình cần Chrome không chạy để có thể mở trình duyệt tự động.',
          allowForceClose: true,
        });
        return { success: true, ...result };
      } catch (error: any) {
        logger.error('[IPC] CHROME:CHECK_AND_PROMPT failed:', error);
        return { success: false, isRunning: true, error: error.message };
      }
    });

    ipcMain.handle('chrome:forceClose', async () => {
      logger.info('[IPC] CHROME:FORCE_CLOSE');
      try {
        const { killChromeProcesses, isChromeRunning } = await import('./browser/chrome-checker');

        // First confirm with user
        const { dialog } = await import('electron');
        const result = await dialog.showMessageBox(this.mainWindow || undefined as any, {
          type: 'warning',
          title: 'Đóng Chrome',
          message: 'Bạn có chắc muốn đóng tất cả cửa sổ Chrome?',
          detail: 'Tất cả tab Chrome đang mở sẽ bị đóng.',
          buttons: ['Đóng Chrome', 'Hủy'],
          defaultId: 1,
          cancelId: 1,
        });

        if (result.response === 0) {
          const killed = await killChromeProcesses();
          await new Promise(r => setTimeout(r, 1000));
          const check = await isChromeRunning();
          return { success: killed && !check.isRunning, killed, stillRunning: check.isRunning };
        }

        return { success: false, cancelled: true };
      } catch (error: any) {
        logger.error('[IPC] CHROME:FORCE_CLOSE failed:', error);
        return { success: false, error: error.message };
      }
    });

    // Remote control handlers
    ipcMain.handle(IPC_CHANNELS.REMOTE_GET_STATE, () => {
      logger.debug('[IPC] REMOTE_GET_STATE');
      return this.remoteSessionManager?.getState() || {
        isBeingControlled: false,
        session: null,
      };
    });

    ipcMain.handle(IPC_CHANNELS.REMOTE_ACCEPT_SESSION, async () => {
      logger.info('[IPC] REMOTE_ACCEPT_SESSION');
      try {
        await this.remoteSessionManager?.acceptSession();
        return { success: true };
      } catch (error: any) {
        logger.error('[IPC] REMOTE_ACCEPT_SESSION failed:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.REMOTE_REJECT_SESSION, (_, reason?: string) => {
      logger.info('[IPC] REMOTE_REJECT_SESSION');
      this.remoteSessionManager?.rejectSession(reason || 'User declined');
      return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.REMOTE_END_SESSION, (_, reason?: string) => {
      logger.info('[IPC] REMOTE_END_SESSION');
      this.remoteSessionManager?.endSession(reason || 'User ended session');
      return { success: true };
    });

    // SSH Tunnel handlers
    ipcMain.handle(IPC_CHANNELS.SSH_TUNNEL_GET_STATUS, () => {
      logger.debug('[IPC] SSH_TUNNEL_GET_STATUS');
      return this.sshTunnelManager?.getStatus() || {
        state: 'disconnected',
        sshAvailable: false,
        sshServerAvailable: false,
        keyGenerated: false,
      };
    });

    ipcMain.handle(IPC_CHANNELS.SSH_TUNNEL_DISCONNECT, () => {
      logger.info('[IPC] SSH_TUNNEL_DISCONNECT');
      this.sshTunnelManager?.disconnect();
      if (this.sshTunnelManager) {
        const status = this.sshTunnelManager.getStatus();
        // Notify backend that tunnel was manually disconnected
        if (this.socket?.isConnected()) {
          this.socket.sendSshTunnelDisconnected('manual');
        }
      }
      return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.SSH_TUNNEL_GENERATE_KEY, async () => {
      logger.info('[IPC] SSH_TUNNEL_GENERATE_KEY');
      if (!this.sshTunnelManager) {
        return { success: false, error: 'SSH tunnel manager not initialized' };
      }
      return this.sshTunnelManager.generateKeyPair();
    });

    ipcMain.handle(IPC_CHANNELS.SSH_TUNNEL_START, async () => {
      logger.info('[IPC] SSH_TUNNEL_START');
      if (!this.socket?.isConnected()) {
        return { success: false, error: 'Not connected to server' };
      }
      await this.autoStartSshTunnel();
      return { success: true };
    });

    // Telegram handlers
    ipcMain.handle(IPC_CHANNELS.TELEGRAM_GET_STATUS, () => {
      logger.debug('[IPC] TELEGRAM_GET_STATUS');
      return this.getTelegramStatus();
    });

    ipcMain.handle(IPC_CHANNELS.TELEGRAM_RESTART, async () => {
      logger.info('[IPC] TELEGRAM_RESTART');
      try {
        await this.restartTelegram();
        return { success: true };
      } catch (error: any) {
        logger.error('[IPC] TELEGRAM_RESTART failed:', error);
        return { success: false, error: error.message };
      }
    });

    // Zira AI handlers
    ipcMain.handle(IPC_CHANNELS.AI_GET_STATUS, () => {
      logger.debug('[IPC] AI_GET_STATUS');
      return this.getZiraAIStatus();
    });

    ipcMain.handle(IPC_CHANNELS.AI_CHAT, async (_, message: string, userId?: string, attachments?: { type: 'image' | 'video'; name: string; data: string; path?: string }[]) => {
      // SECURITY: Input validation
      if (!InputValidator.isValidString(message, 10000)) {
        logger.warn('[IPC] AI_CHAT invalid message');
        return { success: false, error: 'Invalid message' };
      }
      // Sanitize message to prevent potential injection
      const sanitizedMessage = InputValidator.sanitize(message, 10000);
      logger.info(`[IPC] AI_CHAT: "${sanitizedMessage.substring(0, 50)}..." (attachments: ${attachments?.length || 0})`);

      // Process attachments - save to temp files and store paths
      let savedAttachments: { type: 'image' | 'video'; name: string; path: string }[] = [];
      if (attachments && attachments.length > 0) {
        const tempDir = path.join(app.getPath('temp'), 'zira-attachments');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        for (const att of attachments) {
          try {
            // Extract base64 data (remove data:image/png;base64, prefix)
            const base64Data = att.data.replace(/^data:[^;]+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            const ext = att.type === 'image' ? '.png' : '.mp4';
            const fileName = `${Date.now()}_${att.name.replace(/[^a-zA-Z0-9.]/g, '_')}${ext}`;
            const filePath = path.join(tempDir, fileName);
            fs.writeFileSync(filePath, buffer);
            savedAttachments.push({ type: att.type, name: att.name, path: filePath });
            logger.info(`[IPC] Saved attachment: ${filePath}`);
          } catch (e: any) {
            logger.error(`[IPC] Failed to save attachment: ${e.message}`);
          }
        }

        // Store in global for facebook tools to use
        (global as any).pendingAttachments = savedAttachments;
      }

      try {
        // LOCAL MODE: Use local ZiraAI with tools (mouse, keyboard, Booksy, etc.)
        if (this.ziraAI) {
          logger.info('[IPC] AI_CHAT using local mode with tools');
          const result = await this.ziraAI.chat(sanitizedMessage, userId);
          return {
            success: true,
            data: {
              content: result.content,
              model: result.model,
              provider: result.provider,
            },
          };
        }

        // HYBRID MODE: Detect tools locally, then use server AI
        logger.info('[IPC] AI_CHAT using HYBRID mode (local tool detection + server AI)');

        // Step 0: Check for Profile Selection (Priority High)
        // If user is selecting a Chrome profile (e.g., typing "1"), handle it locally
        const profileSelectionResult = await handleProfileSelection(sanitizedMessage);
        if (profileSelectionResult) {
          logger.info(`[IPC] Profile selection handled locally: ${sanitizedMessage}`);
          return {
            success: true,
            data: {
              content: profileSelectionResult,
              model: 'local-profile-selector',
              toolExecuted: 'select_chrome_profile',
            },
          };
        }

        // Step 1: LOCAL TOOL DETECTION - Check if message needs a tool
        const toolMatch = this.detectToolFromMessage(sanitizedMessage);
        if (toolMatch) {
          logger.info(`[IPC] Tool detected locally: ${toolMatch.name}`);
          const toolResult = await executeTool(toolMatch.name, toolMatch.args);

          // Return tool result directly (no need for server)
          return {
            success: true,
            data: {
              content: toolResult,
              model: 'local-tools',
              toolExecuted: toolMatch.name,
            },
          };
        }

        // Step 2: No tool detected - use server AI for conversation
        const authToken = getSecureAuthToken();
        if (!authToken) {
          logger.warn('[IPC] AI_CHAT requires authentication');
          return { success: false, error: 'Please login to use AI chat' };
        }

        const serverUrl = getConfigValue('serverUrl') || 'https://api.enail.pro';
        const client = new ApiClient(serverUrl as string);

        // Get conversation history for context
        const convId = userId || 'default';
        const history = this.proxyHistory.get(convId) || [];

        // Send message WITH tools to server - server decides which to call
        const result = await client.aiChat(authToken, sanitizedMessage, history, undefined, ZIRA_TOOLS);

        if (result.success && result.data) {
          let finalContent = result.data.content || '';

          // HYBRID: If server returns tool_calls, execute them locally!
          if (result.data.tool_calls && result.data.tool_calls.length > 0) {
            logger.info(`[IPC] AI_CHAT: Server requested ${result.data.tool_calls.length} tool(s) - executing locally`);

            const toolResults: string[] = [];
            for (const toolCall of result.data.tool_calls) {
              const toolName = toolCall.function.name;
              let toolArgs = {};
              try {
                toolArgs = JSON.parse(toolCall.function.arguments || '{}');
              } catch (err: any) { logger.debug('[AppLegacy] parse tool arguments failed:', err?.message); }

              logger.info(`[IPC] Executing tool locally: ${toolName}`);
              const toolResult = await executeTool(toolName, toolArgs);
              toolResults.push(toolResult);
              logger.info(`[IPC] Tool ${toolName} result: ${toolResult.substring(0, 100)}...`);
            }

            // Combine AI response with tool results
            const toolResultsText = toolResults.join('\n\n');
            if (finalContent) {
              finalContent = `${finalContent}\n\n${toolResultsText}`;
            } else {
              finalContent = toolResultsText;
            }

            // Optionally: Send tool results back to server for better response
            // const finalResult = await client.aiChatToolResult(authToken, result.data.tool_calls[0].id, toolResultsText, history);
            // if (finalResult.success && finalResult.data) {
            //   finalContent = finalResult.data.content;
            // }
          }

          // Apply identity filter to replace Grok/xAI with Zira AI/eNail.pro
          finalContent = filterIdentity(finalContent);

          // Store in local history for context continuity
          const h = this.proxyHistory.get(convId) || [];
          h.push({ role: 'user', content: sanitizedMessage });
          h.push({ role: 'assistant', content: finalContent });
          if (h.length > 20) h.splice(0, h.length - 20);
          this.proxyHistory.set(convId, h);

          return { success: true, data: { ...result.data, content: finalContent } };
        }

        return { success: false, error: result.error || 'AI service unavailable' };
      } catch (error: any) {
        logger.error('[IPC] AI_CHAT failed:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.AI_CLEAR_HISTORY, (_, userId?: string) => {
      logger.info('[IPC] AI_CLEAR_HISTORY');
      this.clearZiraAIHistory(userId);
      // Also clear proxy history
      const convId = userId || 'default';
      this.proxyHistory.delete(convId);
      return { success: true };
    });

    // Auth handlers (Telegram Login)
    ipcMain.handle(IPC_CHANNELS.AUTH_TELEGRAM_LOGIN_TOKEN, async () => {
      logger.info('[IPC] AUTH_TELEGRAM_LOGIN_TOKEN');
      try {
        const config = getConfig();
        const serverUrl = config.serverUrl || 'https://api.enail.pro';
        const client = new ApiClient(serverUrl);
        const result = await client.generateTelegramLoginToken();
        return { success: true, data: result };
      } catch (error: any) {
        logger.error('[IPC] AUTH_TELEGRAM_LOGIN_TOKEN failed:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_CHECK_TOKEN, async (_, token: string) => {
      logger.info('[IPC] AUTH_CHECK_TOKEN');

      // SECURITY: Input validation
      if (!InputValidator.isValidToken(token)) {
        logger.warn('[IPC] AUTH_CHECK_TOKEN invalid token format');
        return { success: false, error: 'Invalid token format' };
      }

      // SECURITY: Rate limit token check attempts (10 per minute - allows polling)
      if (!rateLimiter.check('check_token', 10, 60000)) {
        logger.warn('[IPC] AUTH_CHECK_TOKEN rate limited');
        return { success: false, error: 'Too many token check attempts. Please wait a minute.' };
      }

      try {
        const config = getConfig();
        const serverUrl = config.serverUrl || 'https://api.enail.pro';
        const client = new ApiClient(serverUrl);
        const result = await client.checkTelegramLoginToken(token);

        // If verified, save auth token and user info
        if (result.status === 'VERIFIED' && result.access_token) {
          const newSalonId = result.user?.salonId || result.salon?.id || '';
          const currentSalonId = config.salonId || '';

          // CRITICAL: Clear database if switching to a different salon
          // This prevents data leakage between salon accounts (Telegram login)
          if (currentSalonId && newSalonId && currentSalonId !== newSalonId) {
            logger.info(`[IPC] Salon changed from ${currentSalonId} to ${newSalonId} (Telegram), clearing local database`);
            try {
              database.clearSalonData();
              logger.info('[IPC] Local database cleared for salon switch (multi-tenant isolation, Telegram)');
            } catch (dbError) {
              logger.error('[IPC] Failed to clear database on salon switch (Telegram):', dbError);
            }
          } else if (!currentSalonId && newSalonId) {
            // First login or after logout - also clear to ensure clean state
            logger.info('[IPC] Fresh Telegram login detected, clearing local database for clean state');
            try {
              database.clearSalonData();
            } catch (dbError) {
              logger.error('[IPC] Failed to clear database on fresh Telegram login:', dbError);
            }
          }

          const authUser: AuthUser = {
            id: result.user?.id || '',
            email: result.user?.email || '',
            firstName: result.user?.firstName || '',
            lastName: result.user?.lastName || '',
            role: result.user?.role || '',
            salonId: newSalonId,
            salonName: result.salon?.name || '',
          };

          // SECURITY: Store auth token encrypted
          if (!setSecureAuthToken(result.access_token)) {
            logger.error('[IPC] Failed to securely store auth token');
            return { success: false, error: 'Failed to store authentication token securely' };
          }

          setConfig({
            authUser,
            salonId: authUser.salonId || '',
            salonName: authUser.salonName || '',
            posEnabled: true,
            customerDisplayEnabled: true,
          });

          logger.info(`[IPC] Auth verified: ${authUser.email}, salon: ${authUser.salonName}, POS+Display enabled`);

          // Auto-connect: try to get print-agent API key and connect (same as email login)
          try {
            const existingApiKey = getSecureApiKey();
            if (existingApiKey && existingApiKey.startsWith('pa_')) {
              logger.info('[IPC] Auto-connecting with existing API key (Telegram)...');
              await this.connectWithApiKey(existingApiKey);
              logger.info('[IPC] Auto-connect successful (existing key, Telegram)');
            } else {
              logger.info('[IPC] Trying to fetch print-agent API key from backend (Telegram)...');
              const keyResult = await client.getMyPrintAgentKey(result.access_token);
              if (keyResult?.apiKey) {
                logger.info('[IPC] Got API key, auto-connecting (Telegram)...');
                await this.connectWithApiKey(keyResult.apiKey);
                logger.info('[IPC] Auto-connect successful (fetched key, Telegram)');
              } else {
                logger.info('[IPC] No print-agent API key available, skipping auto-connect (Telegram)');
              }
            }
          } catch (connectErr: any) {
            logger.warn('[IPC] Auto-connect after Telegram login failed:', connectErr.message);
          }

          // Auto-configure AI chatbot
          try {
            await this.autoConfigureAI(result.access_token);
          } catch (aiErr: any) {
            logger.warn('[IPC] Auto-configure AI after Telegram login failed:', aiErr.message);
          }

          // Clear rate limit on successful verification
          rateLimiter.clear('check_token');
        }

        return { success: true, data: result };
      } catch (error: any) {
        logger.error('[IPC] AUTH_CHECK_TOKEN failed:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_REGISTER_TOKEN, async () => {
      logger.info('[IPC] AUTH_REGISTER_TOKEN');
      try {
        const config = getConfig();
        const serverUrl = config.serverUrl || 'https://api.enail.pro';
        const client = new ApiClient(serverUrl);
        const result = await client.generateRegisterToken();
        return { success: true, data: result };
      } catch (error: any) {
        logger.error('[IPC] AUTH_REGISTER_TOKEN failed:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_GET_USER, async () => {
      logger.info('[IPC] AUTH_GET_USER');
      try {
        // SECURITY: Get auth token from encrypted storage
        const authToken = getSecureAuthToken();

        if (!authToken) {
          return { success: true, data: { isAuthenticated: false } };
        }

        // Verify token with backend
        const config = getConfig();
        const serverUrl = config.serverUrl || 'https://api.enail.pro';
        const client = new ApiClient(serverUrl);
        const user = await client.getMe(authToken);

        // Update cached user info
        const authUser: AuthUser = {
          id: user.id || user.sub || '',
          email: user.email || '',
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          role: user.role || '',
          salonId: user.salonId || '',
          salonName: user.salon?.name || config.salonName || '',
        };
        setConfig({ authUser });

        return { success: true, data: { isAuthenticated: true, user: authUser } };
      } catch (error: any) {
        logger.error('[IPC] AUTH_GET_USER failed:', error);
        // Token expired or invalid - clear it securely
        clearSecureTokens();
        setConfig({ authUser: { id: '', email: '', firstName: '', lastName: '', role: '', salonId: '' } });
        return { success: true, data: { isAuthenticated: false } };
      }
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async () => {
      logger.info('[IPC] AUTH_LOGOUT');

      // CRITICAL: Clear local database to prevent data leakage between salons
      // This ensures Salon A data is not visible when logging into Salon B
      try {
        database.clearSalonData();
        logger.info('[IPC] Cleared local database on logout (multi-tenant isolation)');
      } catch (dbError) {
        logger.error('[IPC] Failed to clear database on logout:', dbError);
      }

      // SECURITY: Clear all sensitive tokens securely
      clearSecureTokens();

      // Clear other session data
      setConfig({
        authUser: { id: '', email: '', firstName: '', lastName: '', role: '', salonId: '' },
        salonId: '',
        salonName: '',
        salonSlug: '',
        aiEnabled: false,
        aiApiKey: '',
        encryptedAiApiKey: '',
      });

      // Clear AI proxy history on logout
      this.proxyHistory.clear();
      logger.info('[ZiraAI] Proxy history cleared on logout');

      return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN_EMAIL, async (_, email: string, password: string) => {
      logger.info('[IPC] AUTH_LOGIN_EMAIL');

      // SECURITY: Input validation
      if (!InputValidator.isValidEmail(email)) {
        logger.warn('[IPC] AUTH_LOGIN_EMAIL invalid email format');
        return { success: false, error: 'Invalid email format' };
      }
      if (!InputValidator.isValidString(password, 128)) {
        logger.warn('[IPC] AUTH_LOGIN_EMAIL invalid password');
        return { success: false, error: 'Invalid password' };
      }

      // SECURITY: Rate limit login attempts (5 per minute to prevent brute force)
      if (!rateLimiter.check('login_email', 5, 60000)) {
        logger.warn('[IPC] AUTH_LOGIN_EMAIL rate limited');
        return { success: false, error: 'Too many login attempts. Please wait a minute.' };
      }

      try {
        const config = getConfig();
        const serverUrl = config.serverUrl || 'https://api.enail.pro';
        const client = new ApiClient(serverUrl);
        const result = await client.loginWithEmail(email, password);

        if (result.access_token) {
          const user = result.user;
          const newSalonId = user.salonId || '';
          const currentSalonId = config.salonId || '';

          // CRITICAL: Clear database if switching to a different salon
          // This prevents data leakage between salon accounts
          if (currentSalonId && newSalonId && currentSalonId !== newSalonId) {
            logger.info(`[IPC] Salon changed from ${currentSalonId} to ${newSalonId}, clearing local database`);
            try {
              database.clearSalonData();
              logger.info('[IPC] Local database cleared for salon switch (multi-tenant isolation)');
            } catch (dbError) {
              logger.error('[IPC] Failed to clear database on salon switch:', dbError);
            }
          } else if (!currentSalonId && newSalonId) {
            // First login or after logout - also clear to ensure clean state
            logger.info('[IPC] Fresh login detected, clearing local database for clean state');
            try {
              database.clearSalonData();
            } catch (dbError) {
              logger.error('[IPC] Failed to clear database on fresh login:', dbError);
            }
          }

          const authUser: AuthUser = {
            id: user.id || user.sub,
            email: user.email,
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            role: user.role,
            salonId: newSalonId,
            salonName: user.salon?.name || '',
          };

          // SECURITY: Store auth token encrypted
          if (!setSecureAuthToken(result.access_token)) {
            logger.error('[IPC] Failed to securely store auth token');
            return { success: false, error: 'Failed to store authentication token securely' };
          }

          setConfig({
            authUser,
            salonId: authUser.salonId || '',
            salonName: authUser.salonName || '',
            salonSlug: user.salon?.slug || '',
            posEnabled: true,
            customerDisplayEnabled: true,
          });

          logger.info(`[IPC] Email login successful: ${authUser.email}, POS+Display enabled`);

          // Auto-connect: try to get print-agent API key and connect
          try {
            const existingApiKey = getConfigValue('apiKey') as string | undefined;
            if (existingApiKey && existingApiKey.startsWith('pa_')) {
              // Already have an API key, just reconnect
              logger.info('[IPC] Auto-connecting with existing API key...');
              await this.connectWithApiKey(existingApiKey);
              logger.info('[IPC] Auto-connect successful (existing key)');
            } else {
              // Try to fetch API key from backend
              logger.info('[IPC] Trying to fetch print-agent API key from backend...');
              const keyResult = await client.getMyPrintAgentKey(result.access_token);
              if (keyResult?.apiKey) {
                logger.info('[IPC] Got API key, auto-connecting...');
                await this.connectWithApiKey(keyResult.apiKey);
                logger.info('[IPC] Auto-connect successful (fetched key)');
              } else {
                logger.info('[IPC] No print-agent API key available, skipping auto-connect');
              }
            }
          } catch (connectError: any) {
            logger.warn('[IPC] Auto-connect after login failed (non-fatal):', connectError.message);
          }

          // Auto-configure AI chatbot
          try {
            await this.autoConfigureAI(result.access_token);
          } catch (aiErr: any) {
            logger.warn('[IPC] Auto-configure AI after email login failed:', aiErr.message);
          }

          // Clear rate limit on successful login
          rateLimiter.clear('login_email');
          return { success: true, data: { user: authUser } };
        }

        return { success: false, error: 'No access token received' };
      } catch (error: any) {
        logger.error('[IPC] AUTH_LOGIN_EMAIL failed:', error);
        return { success: false, error: error.message };
      }
    });

    // Register invoice handlers with access to printer drivers
    registerInvoiceHandlers(
      () => this.printers['RECEIPT'] || this.receiptPrinter || this.printerDriver,
      () => {
        const config = getConfig();
        return config.printers?.['A4']?.windowsPrinter || null;
      },
    );

    // Register entitlements handlers (feature access control)
    registerEntitlementsHandlers(this.mainWindow);

    logger.info(`[IPC] Registered ${Object.keys(IPC_CHANNELS).length + 5} handlers + invoice handlers + entitlements handlers`);
  }

  /**
   * Connect to server (auto-reconnect)
   * Uses apiKey if available, falls back to legacy token
   */
  async connect(): Promise<void> {
    logger.info('[Connect] Starting connection...');

    const config = getConfig();
    logger.info(`[Connect] Config: isPaired=${config.isPaired}, serverUrl=${config.serverUrl}, hasApiKey=${!!config.apiKey}`);

    if (!config.isPaired) {
      logger.warn('[Connect] Cannot connect: not paired');
      return;
    }

    // Try API Key method first (new)
    if (config.apiKey) {
      logger.info('[Connect] Using API Key authentication...');
      try {
        await this.socket?.connectWithApiKey(config.serverUrl, config.apiKey);
        logger.info('[Connect] Connected with API Key');
        this.tray?.setStatus('connected');
        this.mainWindow?.webContents.send(IPC_CHANNELS.CONNECTION_STATUS, {
          connected: true,
          lastConnectedAt: new Date(),
        });
        return;
      } catch (error) {
        logger.error('[Connect] API Key connection failed:', error);
      }
    }

    // Fallback to legacy token method
    const machineId = config.machineId;
    if (!machineId) {
      logger.error('[Connect] Cannot connect: no machine ID');
      return;
    }

    // Get stored token from secure storage
    logger.info('[Connect] Retrieving encrypted token (legacy)...');
    const encryptedToken = getConfigValue('encryptedToken') as string | undefined;

    if (!encryptedToken) {
      logger.error('[Connect] Cannot connect: no encrypted token found');
      setConfigValue('isPaired', false);
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      logger.error('[Connect] Cannot connect: safeStorage encryption not available');
      return;
    }

    let token: string | null = null;
    try {
      token = safeStorage.decryptString(Buffer.from(encryptedToken, 'base64'));
      logger.info('[Connect] Token decrypted successfully');
    } catch (error) {
      logger.error('[Connect] Failed to decrypt token:', error);
      setConfigValue('isPaired', false);
      return;
    }

    if (!token) {
      logger.error('[Connect] Cannot connect: decrypted token is empty');
      setConfigValue('isPaired', false);
      return;
    }

    logger.info(`[Connect] Connecting to ${config.serverUrl} (legacy)...`);
    try {
      await this.socket?.connect(config.serverUrl, machineId, token);
      logger.info('[Connect] Connection initiated');
    } catch (error) {
      logger.error('[Connect] Connection failed:', error);
    }
  }

  /**
   * Connect with API Key (new method)
   * 1. Call REST API to get connection info
   * 2. Connect WebSocket with apiKey
   */
  async connectWithApiKey(apiKey: string): Promise<ConnectResponse> {
    logger.info('[ConnectWithApiKey] Starting connection with API Key...');

    // Validate API Key format
    if (!apiKey || !apiKey.startsWith('pa_')) {
      throw new Error('Invalid API key format. Must start with "pa_"');
    }

    const config = getConfig();
    const serverUrl = config.serverUrl || 'https://api.enail.pro';

    // Step 1: Call REST API to authenticate and get connection info
    logger.info('[ConnectWithApiKey] Step 1: Calling REST API...');
    const apiClient = new ApiClient(serverUrl);
    const connectionInfo = await apiClient.connectWithApiKey(apiKey);

    // Step 2: Connect WebSocket with apiKey
    logger.info('[ConnectWithApiKey] Step 2: Connecting WebSocket...');
    try {
      await this.socket?.connectWithApiKey(connectionInfo.serverUrl || serverUrl, apiKey);
      logger.info('[ConnectWithApiKey] WebSocket connected successfully');

      // Update tray status
      this.tray?.setStatus('connected');

      // Notify renderer
      this.mainWindow?.webContents.send(IPC_CHANNELS.CONNECTION_STATUS, {
        connected: true,
        lastConnectedAt: new Date(),
      });
    } catch (error) {
      logger.error('[ConnectWithApiKey] WebSocket connection failed:', error);
      throw error;
    }

    return connectionInfo;
  }

  /**
   * Determine PrinterType from job
   * Priority: job.printerType > mapping from jobType > default
   */
  private getPrinterTypeForJob(job: any): PrinterType {
    // If server explicitly specifies printerType, use it
    if (job.printerType && Object.values(PrinterType).includes(job.printerType)) {
      return job.printerType as PrinterType;
    }

    // Map jobType to printerType
    switch (job.jobType) {
      case PrintJobType.LABEL:
      case PrintJobType.BARCODE:
        return PrinterType.LABEL;
      case PrintJobType.RECEIPT:
      case PrintJobType.INVOICE:
        return PrinterType.RECEIPT;
      case PrintJobType.REPORT:
        return PrinterType.A4;
      default:
        return PrinterType.RECEIPT;
    }
  }

  /**
   * Get printer driver for a specific PrinterType
   * Checks dictionary first, then legacy configs
   */
  private getPrinterForType(printerType: PrinterType): PrinterDriver | null {
    // Check dictionary first (new config)
    if (this.printers[printerType]) {
      return this.printers[printerType] || null;
    }

    // Fallback to legacy multi-printer config
    if (printerType === PrinterType.LABEL && this.labelPrinter) {
      return this.labelPrinter;
    }
    if ((printerType === PrinterType.RECEIPT || printerType === PrinterType.TICKET || printerType === PrinterType.KITCHEN) && this.receiptPrinter) {
      return this.receiptPrinter;
    }

    // Fallback to legacy single printer
    return this.printerDriver;
  }

  /**
   * Handle incoming print job
   * Routes to correct printer based on printerType (priority) or jobType
   */
  private async handlePrintJob(job: any): Promise<void> {
    logger.info(`[PrintJob] Processing job: ${job.jobId}`);
    logger.info(`[PrintJob] JobType: ${job.jobType}, PrinterType: ${job.printerType || 'auto'}, payload keys: ${Object.keys(job.payload || {}).join(', ')}`);

    // Determine which printer to use
    const printerType = this.getPrinterTypeForJob(job);
    const targetPrinter = this.getPrinterForType(printerType);

    logger.info(`[PrintJob] Routing to printer type: ${printerType}`);

    if (!targetPrinter?.isConnected()) {
      logger.error(`[PrintJob] Printer ${printerType} not connected`);
      this.socket?.sendJobStatus(job.jobId, 'FAILED', `Printer ${printerType} not connected`);
      return;
    }

    try {
      logger.info(`[PrintJob] Sending PRINTING status...`);
      this.socket?.sendJobStatus(job.jobId, 'PRINTING');

      // Handle different job types
      const isLabelJob = printerType === PrinterType.LABEL;
      const isReportJob = [PrintJobType.DAILY_REPORT, PrintJobType.X_REPORT, PrintJobType.Z_REPORT].includes(job.jobType);

      if (isLabelJob) {
        // Label/Barcode jobs - only supported on Zebra
        if (targetPrinter instanceof ZebraDriver) {
          logger.info(`[PrintJob] Printing label on ${printerType}...`);
          await targetPrinter.printLabel(job.payload as LabelData);
        } else {
          throw new Error('Label printing requires Zebra printer');
        }
      } else if (isReportJob) {
        // Daily/X/Z Report jobs - only supported on Thermal printers
        if (targetPrinter instanceof ThermalDriver) {
          const reportData = job.payload as DailyReportData;

          if (job.jobType === PrintJobType.DAILY_REPORT) {
            logger.info(`[PrintJob] Printing daily report (Raport Dobowy)...`);
            await targetPrinter.printDailyReport(reportData);
          } else if (job.jobType === PrintJobType.X_REPORT) {
            logger.info(`[PrintJob] Printing X report...`);
            await targetPrinter.printXReport(reportData);
          } else if (job.jobType === PrintJobType.Z_REPORT) {
            logger.info(`[PrintJob] Printing Z report (Raport fiskalny)...`);
            await targetPrinter.printZReport(reportData);
          }
        } else {
          throw new Error('Daily/X/Z reports require Thermal printer');
        }
      } else {
        // Receipt/Invoice/Report/A4/Ticket/Kitchen jobs
        logger.info(`[PrintJob] Printing receipt on ${printerType}...`);
        await targetPrinter.printReceipt(job.payload as ReceiptData);
      }

      logger.info(`[PrintJob] Sending COMPLETED status...`);
      this.socket?.sendJobStatus(job.jobId, 'COMPLETED');
      logger.info(`[PrintJob] Job ${job.jobId} completed successfully`);

    } catch (error: any) {
      logger.error(`[PrintJob] Job ${job.jobId} failed:`, error);
      this.socket?.sendJobStatus(job.jobId, 'FAILED', error.message);
    }
  }

  /**
   * Get device status
   */
  getDeviceStatus(): DeviceStatus {
    const config = getConfig();
    const hasPrintersDict = config.printers && Object.keys(config.printers).length > 0;
    const hasLegacyMultiPrinter = config.receiptPrinter?.enabled || config.labelPrinter?.enabled;

    let printerConnected = false;
    let printerPort: string | null = null;

    if (hasPrintersDict && config.printers) {
      // NEW: Dictionary mode - report all connected printers
      const connectedPrinters: string[] = [];

      for (const [printerTypeStr, printerConfig] of Object.entries(config.printers)) {
        if (!printerConfig?.enabled) continue;

        const printerType = printerTypeStr as PrinterType;
        const driver = this.printers[printerType];
        const isConnected = driver?.isConnected() || false;

        if (isConnected) {
          printerConnected = true;
          const address = printerConfig.protocol === 'ZEBRA' || printerConfig.protocol === 'WINDOWS'
            ? printerConfig.windowsPrinter
            : printerConfig.port;
          connectedPrinters.push(`${printerType}: ${address}`);
        }
      }

      printerPort = connectedPrinters.length > 0 ? connectedPrinters.join(', ') : null;
    } else if (hasLegacyMultiPrinter) {
      // Legacy multi-printer mode - report status of any connected printer
      const receiptConnected = this.receiptPrinter?.isConnected() || false;
      const labelConnected = this.labelPrinter?.isConnected() || false;
      printerConnected = receiptConnected || labelConnected;

      const ports: string[] = [];
      if (receiptConnected) {
        ports.push(`Receipt: ${config.receiptPrinter?.protocol === 'ZEBRA' ? config.receiptPrinter?.windowsPrinter : config.receiptPrinter?.port}`);
      }
      if (labelConnected) {
        ports.push(`Label: ${config.labelPrinter?.protocol === 'ZEBRA' ? config.labelPrinter?.windowsPrinter : config.labelPrinter?.port}`);
      }
      printerPort = ports.length > 0 ? ports.join(', ') : null;
    } else {
      // Legacy single printer mode
      const protocol = config.printerProtocol;
      printerPort = protocol === 'ZEBRA'
        ? config.zebraPrinter || null
        : config.printerPort || null;
      printerConnected = this.printerDriver?.isConnected() || false;
    }

    const status = {
      printerConnected,
      printerPort,
      scannerActive: this.scanner?.isActive() || false,
      appVersion: app.getVersion(),
    };
    logger.debug('[Status]', JSON.stringify(status));
    return status;
  }

  /**
   * Send test print to all connected printers
   */
  async testPrint(): Promise<{ success: boolean; error?: string; results?: Record<string, boolean> }> {
    logger.info('[TestPrint] Starting test print...');

    const results: Record<string, boolean> = {};
    let anySuccess = false;
    let lastError = '';

    // Test printers from dictionary
    for (const [printerType, driver] of Object.entries(this.printers)) {
      if (driver?.isConnected()) {
        try {
          await driver.printTest();
          results[printerType] = true;
          anySuccess = true;
          logger.info(`[TestPrint] ${printerType} test successful`);
        } catch (error: any) {
          results[printerType] = false;
          lastError = error.message;
          logger.error(`[TestPrint] ${printerType} test failed:`, error);
        }
      }
    }

    // Test legacy printers if no dictionary printers
    if (Object.keys(results).length === 0) {
      // Try legacy receipt printer
      if (this.receiptPrinter?.isConnected()) {
        try {
          await this.receiptPrinter.printTest();
          results['Receipt'] = true;
          anySuccess = true;
          logger.info('[TestPrint] Receipt printer test successful');
        } catch (error: any) {
          results['Receipt'] = false;
          lastError = error.message;
        }
      }

      // Try legacy label printer
      if (this.labelPrinter?.isConnected()) {
        try {
          await this.labelPrinter.printTest();
          results['Label'] = true;
          anySuccess = true;
          logger.info('[TestPrint] Label printer test successful');
        } catch (error: any) {
          results['Label'] = false;
          lastError = error.message;
        }
      }

      // Try legacy single printer
      if (this.printerDriver?.isConnected()) {
        try {
          await this.printerDriver.printTest();
          results['Printer'] = true;
          anySuccess = true;
          logger.info('[TestPrint] Printer test successful');
        } catch (error: any) {
          results['Printer'] = false;
          lastError = error.message;
        }
      }
    }

    if (Object.keys(results).length === 0) {
      logger.warn('[TestPrint] No printer connected');
      return { success: false, error: 'No printer connected' };
    }

    logger.info(`[TestPrint] Results: ${JSON.stringify(results)}`);
    return {
      success: anySuccess,
      error: anySuccess ? undefined : lastError,
      results,
    };
  }

  /**
   * Get detailed printers status for Telegram
   */
  getPrintersStatus(): Array<{ type: string; connected: boolean; protocol?: string; address?: string }> {
    const config = getConfig();
    const result: Array<{ type: string; connected: boolean; protocol?: string; address?: string }> = [];

    // Check dictionary printers
    if (config.printers && Object.keys(config.printers).length > 0) {
      for (const [printerTypeStr, printerConfig] of Object.entries(config.printers)) {
        if (!printerConfig?.enabled) continue;
        const printerType = printerTypeStr as PrinterType;
        const driver = this.printers[printerType];
        result.push({
          type: printerType,
          connected: driver?.isConnected() || false,
          protocol: printerConfig.protocol,
          address: printerConfig.windowsPrinter || printerConfig.port,
        });
      }
    }

    // Check legacy printers
    if (result.length === 0) {
      if (config.receiptPrinter?.enabled) {
        result.push({
          type: 'RECEIPT',
          connected: this.receiptPrinter?.isConnected() || false,
          protocol: config.receiptPrinter.protocol,
          address: config.receiptPrinter.windowsPrinter || config.receiptPrinter.port,
        });
      }
      if (config.labelPrinter?.enabled) {
        result.push({
          type: 'LABEL',
          connected: this.labelPrinter?.isConnected() || false,
          protocol: config.labelPrinter.protocol,
          address: config.labelPrinter.windowsPrinter || config.labelPrinter.port,
        });
      }
      // Legacy single printer
      if (result.length === 0 && (config.printerPort || config.zebraPrinter)) {
        result.push({
          type: 'DEFAULT',
          connected: this.printerDriver?.isConnected() || false,
          protocol: config.printerProtocol,
          address: config.zebraPrinter || config.printerPort,
        });
      }
    }

    return result;
  }

  /**
   * Open cash drawer
   */
  async openCashDrawer(printerType?: PrinterType): Promise<{ success: boolean; error?: string }> {
    logger.info(`[CashDrawer] Opening cash drawer...`);

    // Find a thermal printer to open drawer
    let driver: PrinterDriver | null = null;

    if (printerType) {
      driver = this.printers[printerType] || null;
    } else {
      // Try to find any thermal printer
      driver = this.printers[PrinterType.RECEIPT] || this.receiptPrinter || this.printerDriver || null;
    }

    if (!driver) {
      return { success: false, error: 'No printer available for cash drawer' };
    }

    if (!driver.isConnected()) {
      return { success: false, error: 'Printer not connected' };
    }

    try {
      await driver.openDrawer();
      logger.info('[CashDrawer] Cash drawer opened');
      return { success: true };
    } catch (error: any) {
      logger.error('[CashDrawer] Failed to open:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Print a label via Telegram
   */
  async printLabel(barcode: string, text?: string): Promise<{ success: boolean; error?: string }> {
    logger.info(`[PrintLabel] Printing label: ${barcode}`);

    // Find label printer (ZebraDriver supports printLabel)
    const driver = this.printers[PrinterType.LABEL] || this.labelPrinter;

    if (!driver) {
      return { success: false, error: 'No label printer configured' };
    }

    if (!driver.isConnected()) {
      return { success: false, error: 'Label printer not connected' };
    }

    // Check if driver supports printLabel (only ZebraDriver)
    if (!(driver instanceof ZebraDriver)) {
      return { success: false, error: 'Label printing requires Zebra printer' };
    }

    try {
      const labelData: LabelData = {
        barcode,
        barcodeType: barcode.length === 13 ? 'EAN13' : 'CODE128',
        text1: text || barcode,
        quantity: 1,
      };
      await driver.printLabel(labelData);
      logger.info('[PrintLabel] Label printed successfully');
      return { success: true };
    } catch (error: any) {
      logger.error('[PrintLabel] Failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Test print for a specific printer type
   */
  async testPrinterByType(printerType: PrinterType): Promise<{ success: boolean; error?: string }> {
    logger.info(`[TestPrinterByType] Testing printer: ${printerType}`);

    // Get printer from dictionary first
    let driver = this.printers[printerType];

    // Fallback to legacy printers
    if (!driver) {
      if (printerType === PrinterType.LABEL) {
        driver = this.labelPrinter || undefined;
      } else if (printerType === PrinterType.RECEIPT || printerType === PrinterType.TICKET || printerType === PrinterType.KITCHEN) {
        driver = this.receiptPrinter || undefined;
      }
    }

    // Fallback to legacy single printer
    if (!driver) {
      driver = this.printerDriver || undefined;
    }

    if (!driver) {
      logger.warn(`[TestPrinterByType] No driver found for ${printerType}`);
      return { success: false, error: `Drukarka ${printerType} nie jest skonfigurowana` };
    }

    if (!driver.isConnected()) {
      logger.warn(`[TestPrinterByType] Printer ${printerType} not connected`);
      return { success: false, error: `Drukarka ${printerType} nie jest podłączona` };
    }

    try {
      await driver.printTest();
      logger.info(`[TestPrinterByType] ${printerType} test successful`);
      return { success: true };
    } catch (error: any) {
      logger.error(`[TestPrinterByType] ${printerType} test failed:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Setup POS-specific IPC handlers
   */
  private setupPosIpcHandlers(): void {
    ipcMain.handle('pos:get-state', () => this.posStore?.getState());
    ipcMain.handle('pos:dispatch', (_e, action) => {
      this.posStore?.dispatch(action);
      return { success: true };
    });

    // Database IPC handlers
    ipcMain.handle('pos:products:getAll', () => productRepo.getAll());
    ipcMain.handle('pos:products:getByCategory', (_e, catId: string) => productRepo.getByCategory(catId));
    ipcMain.handle('pos:products:search', (_e, query: string) => productRepo.search(query));
    ipcMain.handle('pos:products:getByBarcode', (_e, barcode: string) => productRepo.getByBarcode(barcode));
    ipcMain.handle('pos:categories:getAll', () => productRepo.getCategories());
    ipcMain.handle('pos:orders:create', (_e, order, items) => {
      try {
        const id = orderRepo.create(order, items);
        return { success: true, id };
      } catch (err: any) {
        logger.error('[IPC] pos:orders:create failed:', err);
        return { success: false, error: err.message };
      }
    });
    ipcMain.handle('pos:orders:getDailyStats', (_e, date: string) => orderRepo.getDailyStats(date));

    // Sync IPC handlers
    ipcMain.handle('pos:sync:products', async () => {
      try {
        const result = await this.productSync?.fullSync();
        return { success: true, data: result };
      } catch (err: any) {
        logger.error('[IPC] pos:sync:products failed:', err);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:sync:orders', async () => {
      try {
        const synced = await this.orderSync?.syncPendingOrders();
        return { success: true, data: { synced } };
      } catch (err: any) {
        logger.error('[IPC] pos:sync:orders failed:', err);
        return { success: false, error: err.message };
      }
    });

    // === Mode-specific IPC: Tables (Restaurant) ===
    ipcMain.handle('pos:tables:getAll', () => tableRepo.getAll());
    ipcMain.handle('pos:tables:getActive', () => tableRepo.getActive());
    ipcMain.handle('pos:tables:updateStatus', (_e, id: string, status: string, orderId?: string) => {
      tableRepo.updateStatus(id, status, orderId);
      return { success: true };
    });
    ipcMain.handle('pos:tables:clearTable', (_e, id: string) => {
      tableRepo.clear(id);
      return { success: true };
    });
    ipcMain.handle('pos:tables:setCovers', (_e, id: string, covers: number) => {
      tableRepo.setCovers(id, covers);
      return { success: true };
    });

    // === Mode-specific IPC: Customers (B2B) ===
    ipcMain.handle('pos:customers:getAll', () => customerRepo.getAll());
    ipcMain.handle('pos:customers:search', (_e, query: string) => customerRepo.search(query));
    ipcMain.handle('pos:customers:getById', (_e, id: string) => customerRepo.getById(id));
    ipcMain.handle('pos:customers:increaseDebt', (_e, id: string, amount: number) => {
      customerRepo.increaseDebt(id, amount);
      return { success: true };
    });

    // === Mode-specific IPC: Staff (Salon) ===
    ipcMain.handle('pos:staff:getAll', () => staffRepo.getAll());

    // === Hold Orders ===
    ipcMain.handle('pos:hold:create', (_e, id: string, title: string, payload: any) => {
      try {
        holdOrderRepo.create(id, title, payload);
        holdOrderRepo.prune(); // Keep max 20
        database.save();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:hold:list', () => holdOrderRepo.list());

    ipcMain.handle('pos:hold:get', (_e, id: string) => holdOrderRepo.get(id));

    ipcMain.handle('pos:hold:remove', (_e, id: string) => {
      holdOrderRepo.remove(id);
      database.save();
      return { success: true };
    });

    // === Quick Key Layouts ===
    ipcMain.handle('pos:quickkeys:list', (_e, mode?: string) => quickKeyLayoutRepo.list(mode));

    ipcMain.handle('pos:quickkeys:get', (_e, id: string) => quickKeyLayoutRepo.get(id));

    ipcMain.handle('pos:quickkeys:create', (_e, id: string, data: any) => {
      try {
        quickKeyLayoutRepo.create(id, data);
        database.save();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:quickkeys:update', (_e, id: string, data: any) => {
      try {
        quickKeyLayoutRepo.update(id, data);
        database.save();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:quickkeys:remove', (_e, id: string) => {
      quickKeyLayoutRepo.remove(id);
      database.save();
      return { success: true };
    });

    ipcMain.handle('pos:quickkeys:assign', (_e, registerId: string, mode: string, layoutId: string) => {
      try {
        quickKeyLayoutRepo.assign(registerId, mode, layoutId);
        database.save();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:quickkeys:getAssigned', (_e, registerId: string, mode: string) => {
      return quickKeyLayoutRepo.getAssigned(registerId, mode);
    });
  }

  /**
   * Setup sync event handlers — trigger sync on socket connect, listen for real-time updates
   */
  private _syncInProgress = false;

  private setupSyncEventHandlers(): void {
    if (!this.socket) return;

    // On socket connect: trigger product sync + start order sync
    this.socket.on('connected', async () => {
      logger.info('[Sync] Socket connected, starting sync...');

      // Guard against concurrent syncs from rapid reconnect
      if (this._syncInProgress) {
        logger.warn('[Sync] Sync already in progress, skipping');
        return;
      }
      this._syncInProgress = true;

      try {
        // Product sync (non-blocking — don't fail the connection)
        if (this.productSync) {
          try {
            await this.productSync.deltaSync();
            // Notify POS window to refresh products
            const posWindow = this.windowManager?.getWindow('pos');
            if (posWindow && !posWindow.isDestroyed()) {
              posWindow.webContents.send('pos:products-synced');
            }
          } catch (err) {
            logger.warn(`[Sync] Product sync on connect failed: ${err}`);
          }
        }

        // Start periodic order sync
        this.orderSync?.startPeriodicSync();

        // Immediately try to sync pending orders
        if (this.orderSync) {
          try {
            await this.orderSync.syncPendingOrders();
          } catch (err) {
            logger.warn(`[Sync] Initial order sync failed: ${err}`);
          }
        }

        // Retry unsynced shifts (open/close that failed while offline)
        if (this.shiftController) {
          try {
            await this.shiftController.retryUnsyncedShifts();
          } catch (err) {
            logger.warn(`[Sync] Shift retry on reconnect failed: ${err}`);
          }
        }
      } finally {
        this._syncInProgress = false;
      }
    });

    // On disconnect: stop order sync
    this.socket.on('disconnected', () => {
      this.orderSync?.stop();
    });

    // Real-time catalog update from backend
    this.socket.on('catalog:updated', (data: { variantId: string; changes: any }) => {
      logger.info(`[Sync] Catalog update for variant ${data.variantId}`);
      if (data.changes) {
        productRepo.upsertMany([data.changes]);
      }
      // Notify POS window
      const posWindow = this.windowManager?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) {
        posWindow.webContents.send('pos:catalog-updated', data);
      }
    });

    // Real-time stock update from backend
    this.socket.on('stock:updated', (data: { variantId: string; newStock: number }) => {
      logger.info(`[Sync] Stock update: ${data.variantId} → ${data.newStock}`);
      database.run('UPDATE product_variants SET in_stock = ? WHERE id = ?', [
        data.newStock,
        data.variantId,
      ]);
      // Notify POS window
      const posWindow = this.windowManager?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) {
        posWindow.webContents.send('pos:stock-updated', data);
      }
    });
  }

  /**
   * Setup IPC handlers for payment and shift management
   */
  private setupPaymentShiftIpc(): void {
    // Print receipt for order
    ipcMain.handle('pos:print-receipt', async (_e, orderId: string) => {
      try {
        const printed = await this.paymentController?.printReceipt(orderId);
        return { success: true, receiptPrinted: printed ?? false };
      } catch (err: any) {
        return { success: false, receiptPrinted: false, error: err.message };
      }
    });

    // Open cash drawer
    ipcMain.handle('pos:open-cash-drawer', async () => {
      try {
        await this.paymentController?.openCashDrawer();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    // Request Elavon card payment
    ipcMain.handle('pos:payment:card', async (_e, data: { amount: number; orderId: string }) => {
      if (!this.socket?.isConnected()) {
        return { success: false, error: 'Not connected to server' };
      }

      return new Promise((resolve) => {
        let settled = false;

        const onResponse = (response: any) => {
          // Only handle response for this specific order
          if (response.orderId !== data.orderId) return;
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.socket?.removeListener('elavon:payment-response', onResponse);
          if (response.success) {
            resolve({ success: true, transactionId: response.transactionId });
          } else {
            resolve({ success: false, error: response.error || 'Payment declined' });
          }
        };

        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.socket?.removeListener('elavon:payment-response', onResponse);
          resolve({ success: false, error: 'Payment timeout (60s)' });
        }, 60000);

        this.socket!.on('elavon:payment-response', onResponse);
        this.socket!.requestElavonPayment(data);
      });
    });

    // Elavon status updates → forward to POS window
    this.socket?.on('elavon:payment-status-update', (data: any) => {
      const posWindow = this.windowManager?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) {
        posWindow.webContents.send('pos:elavon-status', data);
      }
    });

    // Open shift
    ipcMain.handle('pos:shift:open', (_e, data: { staffId: string; staffName: string; openingCash: number }) => {
      try {
        const shiftId = this.shiftController!.openShift(data.staffId, data.staffName, data.openingCash);
        this.posStore?.dispatch({
          type: 'session/open',
          payload: { shiftId, staffId: data.staffId, staffName: data.staffName },
        });
        return { success: true, shiftId };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    // Close shift
    ipcMain.handle('pos:shift:close', async (_e, data: { shiftId: string; closingCash: number }) => {
      try {
        const report = this.shiftController!.closeShift(data.shiftId, data.closingCash);
        this.posStore?.dispatch({ type: 'session/close' });
        // Print Z-report
        await this.shiftController!.printZReport(report);
        return { success: true, report };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });
  }

  /**
   * Show main window
   */
  showWindow(): void {
    logger.info('[Window] Showing main window...');

    if (this.mainWindow) {
      logger.info('[Window] Window exists, focusing...');
      this.mainWindow.show();
      this.mainWindow.focus();
      return;
    }

    logger.info('[Window] Creating new window...');
    this.mainWindow = new BrowserWindow({
      width: 700,
      height: 600,
      minWidth: 500,
      minHeight: 400,
      webPreferences: {
        preload: join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // Required for COM port access (thermal printers)
        devTools: isDebugMode, // Only enable DevTools in debug mode
      },
      icon: getIconPath('icon.png'),
      title: isDebugMode ? 'Zira AI [DEBUG]' : 'Zira AI',
      show: false,
      autoHideMenuBar: !isDebugMode, // Show menu in debug mode
    });

    // Load the renderer
    const isDev = process.env.NODE_ENV === 'development';
    logger.info(`[Window] Loading renderer (dev=${isDev})...`);

    if (isDev) {
      this.mainWindow.loadURL('http://localhost:3100');
      this.mainWindow.webContents.openDevTools();
    } else {
      const htmlPath = join(__dirname, '../renderer/index.html');
      logger.info(`[Window] Loading: ${htmlPath}`);
      this.mainWindow.loadFile(htmlPath);

      // Open DevTools in debug mode
      if (isDebugMode) {
        this.mainWindow.webContents.openDevTools();
      }
    }

    // Handle load errors
    this.mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      logger.error(`[Window] Failed to load: ${errorCode} - ${errorDescription}`);
      dialog.showErrorBox('Load Error', `Failed to load application: ${errorDescription}`);
    });

    // Log when page loads
    this.mainWindow.webContents.on('did-finish-load', () => {
      logger.info('[Window] Page loaded successfully');
    });

    // SECURITY: F12/Ctrl+Shift+I to toggle DevTools only in debug mode
    this.mainWindow.webContents.on('before-input-event', (event, input) => {
      if (!isDebugMode) return; // SECURITY: Block DevTools in production
      if (input.key === 'F12') {
        this.mainWindow?.webContents.toggleDevTools();
      }
      // Ctrl+Shift+I also opens DevTools
      if (input.control && input.shift && input.key === 'I') {
        this.mainWindow?.webContents.toggleDevTools();
      }
    });

    this.mainWindow.once('ready-to-show', () => {
      logger.info('[Window] Ready to show');
      this.mainWindow?.show();
    });

    this.mainWindow.on('close', (e) => {
      logger.info('[Window] Close requested, hiding to tray...');
      e.preventDefault();
      this.mainWindow?.hide();
    });

    const winRef = this.mainWindow;
    this.mainWindow.on('closed', () => {
      logger.info('[Window] Closed');
      if (this.posStore) {
        this.posStore.unregisterWindow(winRef);
      }
      this.mainWindow = null;
    });

    // Register main window for POS state broadcasts
    if (this.posStore) {
      this.posStore.registerWindow(this.mainWindow);
    }
  }

  /**
   * Toggle DevTools - SECURITY: Only works in debug mode
   */
  toggleDevTools(): void {
    if (!isDebugMode) {
      logger.warn('[Window] DevTools disabled in production mode');
      return;
    }
    this.mainWindow?.webContents.toggleDevTools();
  }

  /**
   * Open logs folder
   */
  openLogsFolder(): void {
    const logsPath = join(app.getPath('userData'), 'logs');
    shell.openPath(logsPath);
  }

  /**
   * Configure Windows auto-start based on config
   * Default is TRUE - app should start with Windows by default
   */
  configureAutoStart(): void {
    // Get autoStart value, default to TRUE if not set
    let autoStart = getConfigValue('autoStart');

    // Ensure autoStart is always enabled by default (first run or if undefined)
    if (autoStart === undefined || autoStart === null) {
      autoStart = true;
      setConfigValue('autoStart', true);
      logger.info('[AutoStart] First run - enabling auto-start by default');
    }

    logger.info(`[AutoStart] Setting auto-start: ${autoStart}`);

    try {
      app.setLoginItemSettings({
        openAtLogin: autoStart,
        openAsHidden: true, // Start minimized to tray
        path: process.execPath,
        args: ['--hidden'], // Pass flag to indicate hidden start
      });
      logger.info(`[AutoStart] Auto-start ${autoStart ? 'enabled' : 'disabled'}`);
    } catch (error) {
      logger.error('[AutoStart] Failed to configure auto-start:', error);
    }
  }

  /**
   * Toggle auto-start setting
   */
  setAutoStart(enabled: boolean): void {
    logger.info(`[AutoStart] Toggling auto-start to: ${enabled}`);
    setConfigValue('autoStart', enabled);
    this.configureAutoStart();
  }

  /**
   * Get auto-start status
   */
  getAutoStartStatus(): { openAtLogin: boolean } {
    const settings = app.getLoginItemSettings();
    return { openAtLogin: settings.openAtLogin };
  }

  /**
   * Quit the application
   */
  async quit(): Promise<void> {
    logger.info('[Quit] Quitting application...');

    // Remove all IPC handlers early to prevent them from running on destroyed resources
    ipcMain.removeAllListeners();
    for (const channel of Object.values(IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }

    this.socket?.disconnect();
    this.scanner?.stop();

    // Stop SSH tunnel
    if (this.sshTunnelManager) {
      try {
        this.sshTunnelManager.destroy();
        this.sshTunnelManager = null;
        logger.info('[Quit] SSH tunnel manager destroyed');
      } catch (error) {
        logger.warn('[Quit] Error destroying SSH tunnel manager:', error);
      }
    }

    // Stop Telegram bot
    if (this.telegramBot) {
      try {
        await stopPolling(this.telegramBot);
        destroyTelegramBot();
        this.telegramBot = null;
        logger.info('[Quit] Telegram bot stopped');
      } catch (error) {
        logger.warn('[Quit] Error stopping Telegram bot:', error);
      }
    }

    // Close browser controller
    if (this.browserController) {
      try {
        await this.browserController.destroy();
        this.browserController = null;
        logger.info('[Quit] Browser controller closed');
      } catch (error) {
        logger.warn('[Quit] Error closing browser controller:', error);
      }
    }

    // Stop sync services + controllers
    this.orderSync?.stop();
    this.orderSync = null;
    this.productSync = null;
    this.paymentController = null;
    this.shiftController = null;
    logger.info('[Quit] Sync services & controllers stopped');

    // Close database
    try {
      database.destroy();
      logger.info('[Quit] Database closed');
    } catch (error) {
      logger.warn('[Quit] Error closing database:', error);
    }

    // Destroy POS windows
    if (this.windowManager) {
      try {
        this.windowManager.destroy();
        this.windowManager = null;
        logger.info('[Quit] Window manager destroyed');
      } catch (error) {
        logger.warn('[Quit] Error destroying window manager:', error);
      }
    }
    this.posStore?.destroy();
    this.posStore = null;

    // Clear AI proxy history
    this.proxyHistory.clear();
    logger.info('[Quit] AI proxy history cleared');

    // Disconnect all printers from dictionary
    for (const [printerType, driver] of Object.entries(this.printers)) {
      try {
        driver?.disconnect();
        logger.info(`[Quit] ${printerType} disconnected`);
      } catch (error) {
        logger.warn(`[Quit] Error disconnecting ${printerType}:`, error);
      }
    }

    // Disconnect legacy printers
    this.receiptPrinter?.disconnect();
    this.labelPrinter?.disconnect();
    this.printerDriver?.disconnect();

    // Stop Booksy sync
    if (this.booksySync) {
      this.booksySync.stop();
      logger.info('[Quit] Booksy sync stopped');
    }

    logger.info('[Quit] Cleanup complete, exiting...');
    app.exit(0);
  }

  // ==========================================
  // Booksy Sync
  // ==========================================

  private decryptBooksyJwt(booksyConfig: any): any {
    if (booksyConfig?.encryptedEnailJwt && !booksyConfig.enailJwt && safeStorage.isEncryptionAvailable()) {
      try {
        booksyConfig.enailJwt = safeStorage.decryptString(Buffer.from(booksyConfig.encryptedEnailJwt, 'base64'));
        logger.info('[Booksy] JWT decrypted successfully');
      } catch (error) {
        logger.error('[Booksy] Failed to decrypt JWT:', error);
      }
    }
    return booksyConfig;
  }

  /**
   * Ensure BooksySync instance exists (lazy init helper)
   * Returns the instance or null if config is missing.
   */
  private ensureBooksySync(): BooksySync | null {
    if (this.booksySync) return this.booksySync;
    const config = getConfig();
    const booksyConfig = this.decryptBooksyJwt(config.booksy);
    if (!booksyConfig) return null;
    this.booksySync = new BooksySync(booksyConfig);
    this.booksySync.on('statusChanged', (status: any) => {
      this.mainWindow?.webContents.send(IPC_CHANNELS.BOOKSY_STATUS_CHANGED, status);
    });
    return this.booksySync;
  }

  private initializeBooksy(): void {
    const config = getConfig();
    const booksyConfig = this.decryptBooksyJwt(config.booksy);

    if (!booksyConfig?.enabled) {
      logger.info('[Booksy] Disabled in config, skipping initialization');
      return;
    }

    this.booksySync = new BooksySync(booksyConfig);

    this.booksySync.on('statusChanged', (status: any) => {
      this.mainWindow?.webContents.send(IPC_CHANNELS.BOOKSY_STATUS_CHANGED, status);
    });

    this.booksySync.start();
    logger.info('[Booksy] Sync service started');
  }

  private setupBooksyIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_STATUS, () => {
      if (!this.booksySync) {
        return {
          enabled: false, running: false, hasToken: false, sessionExpired: false,
          lastSyncTime: null, lastSyncReport: null, isBusinessHours: false,
          nextSyncIn: null, chromeConnected: false,
        };
      }
      return this.booksySync.getStatus();
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_CONFIG, () => {
      const config = getConfig();
      return config.booksy || {
        enabled: false, businessId: '304504', cdpPort: 9222,
        enailApiUrl: '', enailJwt: '', syncIntervalMin: 30,
        workStartHour: 7, workStartMin: 30, workEndHour: 18, workEndMin: 30,
        workDays: [1, 2, 3, 4, 5, 6],
      };
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SET_CONFIG, (_, booksyConfig: any) => {
      const config = getConfig();
      const merged = { ...(config.booksy || {}), ...booksyConfig };

      // Encrypt JWT token if provided
      if (booksyConfig.enailJwt && safeStorage.isEncryptionAvailable()) {
        try {
          merged.encryptedEnailJwt = safeStorage.encryptString(booksyConfig.enailJwt).toString('base64');
          logger.info('[Booksy] JWT encrypted and stored securely');
        } catch (error) {
          logger.error('[Booksy] Failed to encrypt JWT:', error);
        }
      }

      setConfig({ booksy: merged as any });

      // Update running instance
      if (this.booksySync) {
        this.booksySync.updateConfig(merged as any);
      }

      return merged;
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_NOW, async () => {
      const sync = this.ensureBooksySync();
      if (!sync) return null;
      return await sync.syncNow();
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_START, () => {
      const sync = this.ensureBooksySync();
      if (!sync) return;
      sync.start();

      // Persist enabled state
      const config = getConfig();
      if (config.booksy) {
        setConfig({ booksy: { ...config.booksy, enabled: true } as any });
      }
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_STOP, () => {
      if (this.booksySync) {
        this.booksySync.stop();
      }
      const config = getConfig();
      if (config.booksy) {
        setConfig({ booksy: { ...config.booksy, enabled: false } as any });
      }
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_BOOKINGS, () => {
      return this.booksySync?.getBookings() || [];
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_CUSTOMERS, async () => {
      const sync = this.ensureBooksySync();
      if (!sync) return null;
      return await sync.syncCustomersNow();
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_CUSTOMERS, () => {
      return this.booksySync?.getCustomers() || [];
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_STAFF, async () => {
      const sync = this.ensureBooksySync();
      if (!sync) return null;
      return await sync.syncStaffNow();
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_STAFF, () => {
      return this.booksySync?.getStaff() || [];
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_RESOURCES, async () => {
      const sync = this.ensureBooksySync();
      if (!sync) return null;
      return await sync.syncResourcesNow();
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_RESOURCES, () => {
      return this.booksySync?.getResources() || [];
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_SERVICES, async () => {
      const sync = this.ensureBooksySync();
      if (!sync) return null;
      return await sync.syncServicesNow();
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_SERVICES, () => {
      return this.booksySync?.getServices() || [];
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_ADDONS, async () => {
      const sync = this.ensureBooksySync();
      if (!sync) return null;
      return await sync.syncAddonsNow();
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_ADDONS, () => {
      return this.booksySync?.getAddons() || [];
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_ALL, async () => {
      const sync = this.ensureBooksySync();
      if (!sync) return null;
      return await sync.syncAllNow();
    });
  }
}

// Singleton instance
export const printAgentApp = new PrintAgentApp();
