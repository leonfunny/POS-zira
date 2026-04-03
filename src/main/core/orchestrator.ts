/**
 * AgentOrchestrator
 *
 * Manages the lifecycle of all application modules.
 * Replaces the monolithic PrintAgentApp class.
 *
 * Lifecycle:
 *   1. Create ServiceContainer, EventBus, ToolRegistry
 *   2. Register core services (database, config, socket)
 *   3. For each module: init() → registerIpcHandlers() → registerEventHandlers()
 *   4. Collect tools from all modules into ToolRegistry
 *   5. Create main window, tray
 *   6. For each module: start()
 *   7. Graceful shutdown in reverse order
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { execSync } from 'child_process';

import { ServiceContainer } from './container';
import { EventBus } from './event-bus';
import { ToolRegistry } from './tool-registry';
import { SERVICE_TOKENS } from './tokens';
import type { AppModule } from './module';

import SocketClient from '../network/socket-client';
import { database } from '../database/database';
import { seedIfEmpty } from '../database/seed';
import {
  getConfig,
  getConfigValue,
  setConfigValue,
} from '../config/store';
import { getIconPath } from '../paths';
import { IPC_CHANNELS } from '../../shared/types';
import TrayManager, { TrayManagerHost } from '../tray';
import logger from '../logger';

// Check for debug mode
const isDebugMode = process.argv.includes('--debug') || process.env.DEBUG === '1';

/**
 * Generate a unique machine ID without native modules
 */
function generateMachineId(): string {
  try {
    if (process.platform === 'win32') {
      const result = execSync(
        'REG QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf8', timeout: 5000 }
      );
      const match = result.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match && match[1]) {
        return createHash('sha256').update(match[1]).digest('hex');
      }
    } else if (process.platform === 'darwin') {
      const result = execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID', {
        encoding: 'utf8',
        timeout: 5000,
      });
      const match = result.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match && match[1]) {
        return createHash('sha256').update(match[1]).digest('hex');
      }
    } else {
      const result = execSync('cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null', {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (result.trim()) {
        return createHash('sha256').update(result.trim()).digest('hex');
      }
    }
  } catch {
    logger.warn('[MachineId] Failed to get platform machine ID, generating random');
  }
  return createHash('sha256').update(randomUUID()).digest('hex');
}

export class AgentOrchestrator implements TrayManagerHost {
  private container: ServiceContainer;
  private eventBus: EventBus;
  private toolRegistry: ToolRegistry;
  private modules: AppModule[] = [];

  private mainWindow: BrowserWindow | null = null;
  private tray: TrayManager | null = null;
  private socket: SocketClient | null = null;
  private isQuitting = false;

  private initStep = 0;

  constructor() {
    this.container = new ServiceContainer();
    this.eventBus = new EventBus();
    this.toolRegistry = new ToolRegistry();
  }

  /**
   * Register a module. Call before initialize().
   */
  use(module: AppModule): this {
    this.modules.push(module);
    return this;
  }

  /**
   * Get the service container (for modules that need to interact).
   */
  getContainer(): ServiceContainer {
    return this.container;
  }

  /**
   * Initialize the entire application.
   */
  async initialize(): Promise<void> {
    this.logStep('Starting initialization...');

    try {
      // 1. Wait for app ready (already done in index.ts, but safe to call again)
      this.logStep('Waiting for app ready...');
      await app.whenReady();
      this.logStep('App is ready');

      // 2. Machine ID
      this.logStep('Getting machine ID...');
      let machineId = getConfigValue('machineId');
      if (!machineId) {
        machineId = generateMachineId();
        setConfigValue('machineId', machineId);
        this.logStep(`Generated machine ID: ${(machineId as string).substring(0, 8)}...`);
      } else {
        this.logStep(`Using existing machine ID: ${(machineId as string).substring(0, 8)}...`);
      }

      // 3. Register core services in container
      this.logStep('Registering core services...');
      this.container.set(SERVICE_TOKENS.DATABASE, database);
      this.container.set(SERVICE_TOKENS.EVENT_BUS, this.eventBus);
      this.container.set(SERVICE_TOKENS.TOOL_REGISTRY, this.toolRegistry);

      // Initialize database
      this.logStep('Initializing SQLite database...');
      await database.initialize();
      seedIfEmpty();
      this.logStep('SQLite database ready');

      // Initialize socket client
      this.logStep('Initializing socket client...');
      this.socket = new SocketClient();
      this.container.set(SERVICE_TOKENS.SOCKET, this.socket);
      this.setupSocketEventBridge();
      this.logStep('Socket client ready');

      // 4. Init all modules
      this.logStep(`Initializing ${this.modules.length} modules...`);
      for (const mod of this.modules) {
        this.logStep(`  init: ${mod.name}`);
        try {
          await mod.init();
        } catch (e: any) {
          logger.error(`[Orchestrator] Module "${mod.name}" init failed:`, e);
          throw e;
        }
      }

      // 5. Register IPC handlers
      this.logStep('Registering IPC handlers...');
      for (const mod of this.modules) {
        mod.registerIpcHandlers();
      }

      // 6. Register event handlers
      this.logStep('Registering event handlers...');
      for (const mod of this.modules) {
        mod.registerEventHandlers(this.eventBus);
      }

      // 6b. Wire socket handlers for modules that need direct socket events
      if (this.socket) {
        this.logStep('Wiring socket handlers...');
        for (const mod of this.modules) {
          if (typeof mod.setupSocketHandlers === 'function') {
            mod.setupSocketHandlers(this.socket);
            logger.info(`[Orchestrator] ${mod.name}: socket handlers wired`);
          }
        }
      }

      // 7. Collect tools from all modules into registry
      this.logStep('Collecting tool definitions...');
      for (const mod of this.modules) {
        const tools = mod.getToolDefinitions();
        if (tools.length > 0) {
          this.toolRegistry.registerMany(tools);
          logger.info(`[Orchestrator] ${mod.name}: ${tools.length} tools registered`);
        }
      }
      logger.info(`[Orchestrator] ToolRegistry total: ${this.toolRegistry.size} tools`);

      // 8. Show main window
      this.logStep('Showing main window...');
      this.showWindow();
      this.logStep('Window shown');

      // 9. Create system tray
      this.logStep('Creating system tray...');
      this.tray = new TrayManager(this);
      this.container.set(SERVICE_TOKENS.TRAY_MANAGER, this.tray);
      this.logStep('System tray created');

      // 10. Start all modules
      this.logStep('Starting modules...');
      for (const mod of this.modules) {
        this.logStep(`  start: ${mod.name}`);
        try {
          await mod.start();
        } catch (e: any) {
          logger.error(`[Orchestrator] Module "${mod.name}" start failed:`, e);
          // Non-fatal: continue starting other modules
        }
      }

      // 11. Configure auto-start
      this.logStep('Configuring auto-start...');
      this.configureAutoStart();

      // 12. Handle app events
      app.on('window-all-closed', () => {
        logger.debug('All windows closed, continuing in tray');
      });

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          this.showWindow();
        }
      });

      this.logStep('Initialization complete!');
      logger.info('='.repeat(50));
      logger.info('Zira AI initialized successfully');
      logger.info(`Modules: ${this.modules.map(m => m.name).join(', ')}`);
      logger.info(`Tools: ${this.toolRegistry.size}`);
      logger.info('='.repeat(50));

    } catch (error: any) {
      logger.error(`[Orchestrator] Initialization failed at step ${this.initStep}:`, error);
      throw error;
    }
  }

  // ─── Socket → EventBus bridge ─────────────────────────────

  private setupSocketEventBridge(): void {
    if (!this.socket) return;

    this.socket.on('connected', () => {
      logger.info('[Socket] Connected to server');
      this.tray?.setStatus('connected');
      this.mainWindow?.webContents.send(IPC_CHANNELS.CONNECTION_STATUS, {
        connected: true,
        lastConnectedAt: new Date(),
      });
      this.eventBus.emit('socket:connected', {
        salonId: getConfigValue('salonId') as string | undefined,
        salonName: getConfigValue('salonName') as string | undefined,
      });
    });

    this.socket.on('disconnected', () => {
      logger.info('[Socket] Disconnected from server');
      this.tray?.setStatus('disconnected');
      this.mainWindow?.webContents.send(IPC_CHANNELS.CONNECTION_STATUS, {
        connected: false,
      });
      this.eventBus.emit('socket:disconnected', {});
    });

    this.socket.on('error', (error: any) => {
      logger.error('[Socket] Error:', error);
    });

    this.socket.on('job:new', (job: any) => {
      logger.info(`[Socket] Received print job: ${job.jobId}`);
      this.eventBus.emit('print:job-received', {
        jobId: job.jobId,
        jobType: job.jobType,
        printerType: job.printerType,
        payload: job,
      });
    });
  }

  // ─── Window management ─────────────────────────────────────

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
        preload: join(__dirname, '../../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        devTools: process.env.NODE_ENV === 'development' || isDebugMode, // SECURITY: Gate DevTools behind debug mode
      },
      icon: getIconPath('icon.png'),
      title: isDebugMode ? 'Zira AI [DEBUG]' : 'Zira AI',
      show: false,
      autoHideMenuBar: !isDebugMode,
    });

    this.container.set(SERVICE_TOKENS.MAIN_WINDOW, this.mainWindow);

    const isDev = process.env.NODE_ENV === 'development';
    logger.info(`[Window] Loading renderer (dev=${isDev})...`);

    if (isDev) {
      this.mainWindow.loadURL('http://localhost:3100');
      this.mainWindow.webContents.openDevTools();
    } else {
      const htmlPath = join(__dirname, '../../renderer/index.html');
      logger.info(`[Window] Loading: ${htmlPath}`);
      this.mainWindow.loadFile(htmlPath);
      if (isDebugMode) {
        this.mainWindow.webContents.openDevTools();
      }
    }

    // SECURITY: Navigation guards — prevent redirects to malicious pages
    this.mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
      const allowed = isDev ? ['http://localhost:3100'] : ['file://'];
      if (!allowed.some(prefix => navigationUrl.startsWith(prefix))) {
        logger.warn(`[Window] Blocked navigation to: ${navigationUrl}`);
        event.preventDefault();
      }
    });

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      // Allow opening external URLs in the default browser, block new Electron windows
      if (url.startsWith('https://') || url.startsWith('http://')) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    this.mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      logger.error(`[Window] Failed to load: ${errorCode} - ${errorDescription}`);
      dialog.showErrorBox('Load Error', `Failed to load application: ${errorDescription}`);
    });

    this.mainWindow.webContents.on('did-finish-load', () => {
      logger.info('[Window] Page loaded successfully');
    });

    this.mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (!isDebugMode) return;
      if (input.key === 'F12') {
        this.mainWindow?.webContents.toggleDevTools();
      }
      if (input.control && input.shift && input.key === 'I') {
        this.mainWindow?.webContents.toggleDevTools();
      }
    });

    this.mainWindow.once('ready-to-show', () => {
      logger.info('[Window] Ready to show');
      this.mainWindow?.show();
      this.mainWindow?.maximize();
    });

    this.mainWindow.on('close', (e) => {
      if (this.isQuitting) {
        logger.info('[Window] Closing (app quitting)...');
        return; // Allow close during quit
      }
      logger.info('[Window] Close requested, hiding to tray...');
      e.preventDefault();
      this.mainWindow?.hide();
    });

    const winRef = this.mainWindow;
    this.mainWindow.on('closed', () => {
      logger.info('[Window] Closed');
      const posStore = this.container.getOptional<any>(SERVICE_TOKENS.POS_STORE);
      if (posStore) posStore.unregisterWindow(winRef);
      this.mainWindow = null;
      this.container.remove(SERVICE_TOKENS.MAIN_WINDOW);
    });

    // Register main window for POS state broadcasts
    const posStore = this.container.getOptional<any>(SERVICE_TOKENS.POS_STORE);
    if (posStore) posStore.registerWindow(this.mainWindow);
  }

  // ─── TrayManager-compatible methods ────────────────────────

  /**
   * Test print - delegates to HardwareModule via container.
   */
  async testPrint(): Promise<{ success: boolean; error?: string; results?: Record<string, boolean> }> {
    try {
      // Try to find the hardware module
      const hwModule = this.modules.find(m => m.name === 'hardware');
      if (hwModule && typeof (hwModule as any).testPrint === 'function') {
        return await (hwModule as any).testPrint();
      }
      return { success: false, error: 'Hardware module not available' };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  toggleDevTools(): void {
    if (!isDebugMode) {
      logger.warn('[Window] DevTools disabled in production mode');
      return;
    }
    this.mainWindow?.webContents.toggleDevTools();
  }

  openLogsFolder(): void {
    const logsPath = join(app.getPath('userData'), 'logs');
    shell.openPath(logsPath);
  }

  // ─── Auto-start ────────────────────────────────────────────

  private configureAutoStart(): void {
    let autoStart = getConfigValue('autoStart');
    if (autoStart === undefined || autoStart === null) {
      autoStart = true;
      setConfigValue('autoStart', true);
      logger.info('[AutoStart] First run - enabling auto-start by default');
    }

    logger.info(`[AutoStart] Setting auto-start: ${autoStart}`);
    try {
      app.setLoginItemSettings({
        openAtLogin: autoStart as boolean,
        openAsHidden: true,
        path: process.execPath,
        args: ['--hidden'],
      });
      logger.info(`[AutoStart] Auto-start ${autoStart ? 'enabled' : 'disabled'}`);
    } catch (error) {
      logger.error('[AutoStart] Failed to configure auto-start:', error);
    }
  }

  // ─── Graceful shutdown ─────────────────────────────────────

  async quit(): Promise<void> {
    logger.info('[Quit] Quitting application...');
    this.isQuitting = true;

    // Remove IPC handlers registered by modules (per-channel, not blanket)
    for (const channel of Object.values(IPC_CHANNELS)) {
      try { ipcMain.removeHandler(channel); } catch (err: any) { logger.debug(`[Orchestrator] removeHandler ${channel} failed:`, err?.message); }
    }

    // Stop modules in reverse order
    for (let i = this.modules.length - 1; i >= 0; i--) {
      const mod = this.modules[i];
      try {
        logger.info(`[Quit] Stopping module: ${mod.name}`);
        await mod.stop();
      } catch (e: any) {
        logger.warn(`[Quit] Error stopping ${mod.name}:`, e);
      }
    }

    // Destroy modules in reverse order
    for (let i = this.modules.length - 1; i >= 0; i--) {
      const mod = this.modules[i];
      try {
        await mod.destroy();
      } catch (e: any) {
        logger.warn(`[Quit] Error destroying ${mod.name}:`, e);
      }
    }

    // Remove socket listeners before disconnecting
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }

    // Close database
    try {
      database.destroy();
      logger.info('[Quit] Database closed');
    } catch (e) {
      logger.warn('[Quit] Error closing database:', e);
    }

    // Clean up event bus and tool registry
    this.eventBus.removeAllListeners();
    this.toolRegistry.clear();
    this.container.clear();

    logger.info('[Quit] Cleanup complete, exiting...');
    app.quit();
  }

  // ─── Helpers ───────────────────────────────────────────────

  private logStep(message: string): void {
    this.initStep++;
    const logMsg = `[Init Step ${this.initStep}] ${message}`;
    logger.info(logMsg);
    try { console.log(logMsg); } catch (err: any) { logger.debug('[Orchestrator] console.log failed:', err?.message); }
  }
}
