/**
 * Zira AI - Main Entry Point
 *
 * Desktop application for connecting Zira AI POS with:
 * - Posnet thermal printers (fiscal receipts)
 * - Barcode scanners (HID mode)
 *
 * Debug mode: Run with --debug flag or set DEBUG=1 environment variable
 */

import { app, dialog, clipboard, shell } from 'electron';
import { join } from 'path';
import { AgentOrchestrator } from './core/orchestrator';
import { initAutoUpdater } from './updates/auto-updater';
import logger from './logger';
import { ensureReceiptPrinterEnabledOnBoot } from './config/ensure-receipt-enabled';
import {
  registerPromoImageProtocolHandler,
  registerPromoImageProtocolScheme,
} from './pos/promo-image-protocol';
import {
  startSuppressingTouchKeyboard,
  stopSuppressingTouchKeyboard,
} from './system/touch-keyboard-suppressor';

// Module imports
import { HardwareModule } from './modules/hardware.module';
import { SyncModule } from './modules/sync.module';
import { PosModule } from './modules/pos.module';
import { WarehouseModule } from './modules/warehouse.module';
import { InvoiceModule } from './modules/invoice.module';
import { AuthModule } from './modules/auth.module';
import { RemoteModule } from './modules/remote.module';
import { BooksyModule } from './modules/booksy.module';
import { TelegramModule } from './modules/telegram.module';
import { BrowserModule } from './modules/browser.module';
import { AiModule } from './modules/ai.module';
import { SystemToolsModule } from './modules/system-tools.module';
import { SecurityModule } from './modules/security.module';
import { CheckinModule } from './modules/checkin.module';
import { BackupModule } from './modules/backup.module';
import { ForecastModule } from './modules/forecast.module';

// Check for debug mode
const isDebugMode = process.argv.includes('--debug') || process.env.DEBUG === '1';

registerPromoImageProtocolScheme();

/**
 * Get system diagnostics info
 */
function getDiagnostics(): string {
  const info = [
    `App Version: ${app.getVersion()}`,
    `Electron: ${process.versions.electron}`,
    `Chrome: ${process.versions.chrome}`,
    `Node: ${process.versions.node}`,
    `V8: ${process.versions.v8}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Locale: ${app.getLocale()}`,
    `User Data: ${app.getPath('userData')}`,
    `Exe Path: ${app.getPath('exe')}`,
    `Debug Mode: ${isDebugMode}`,
    `Args: ${process.argv.join(' ')}`,
    `CWD: ${process.cwd()}`,
    `PID: ${process.pid}`,
    `Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
  ];
  return info.join('\n');
}

/**
 * Show error dialog with copy button and option to open logs
 */
function showErrorDialog(title: string, error: Error | string): void {
  const errorMessage = error instanceof Error
    ? `${error.message}\n\nStack trace:\n${error.stack}`
    : String(error);

  const diagnostics = getDiagnostics();
  const timestamp = new Date().toISOString();

  const fullMessage = `Time: ${timestamp}\n\n${errorMessage}\n\n--- System Info ---\n${diagnostics}`;

  logger.error(`[ErrorDialog] ${title}: ${errorMessage}`);

  dialog.showMessageBox({
    type: 'error',
    title: `Zira AI - ${title}`,
    message: title,
    detail: fullMessage,
    buttons: ['Copy Error', 'Open Logs Folder', 'Close'],
    defaultId: 2,
    cancelId: 2,
  }).then((result) => {
    if (result.response === 0) {
      clipboard.writeText(`Zira AI Error Report\n\n${title}\n\n${fullMessage}`);
      dialog.showMessageBox({
        type: 'info',
        title: 'Copied',
        message: 'Error details copied to clipboard',
        buttons: ['OK'],
      });
    } else if (result.response === 1) {
      const logsPath = join(app.getPath('userData'), 'logs');
      shell.openPath(logsPath).catch(err => {
        logger.error('Failed to open logs folder:', err);
      });
    }
  });
}

/**
 * Show startup diagnostics dialog (debug mode only)
 */
function showStartupDiagnostics(): void {
  const diagnostics = getDiagnostics();

  dialog.showMessageBox({
    type: 'info',
    title: 'Zira AI - Debug Mode',
    message: 'Startup Diagnostics',
    detail: diagnostics,
    buttons: ['Continue', 'Copy & Continue'],
    defaultId: 0,
  }).then((result) => {
    if (result.response === 1) {
      clipboard.writeText(diagnostics);
    }
  });
}

// CRITICAL: Flag to prevent infinite loop in exception handlers
// When EPIPE error occurs (broken pipe), console.error() will fail and trigger another exception
let isHandlingException = false;

// Safe console wrappers that won't throw on EPIPE
// EPIPE occurs when app starts without a console (e.g., Windows auto-start)
function safeConsoleLog(...args: unknown[]): void {
  try {
    console.log(...args);
  } catch {
    // Ignore - pipe is broken, can't write to console
  }
}

function safeConsoleWarn(...args: unknown[]): void {
  try {
    console.warn(...args);
  } catch {
    // Ignore - pipe is broken, can't write to console
  }
}

function safeConsoleError(...args: unknown[]): void {
  try {
    console.error(...args);
  } catch {
    // Ignore - pipe is broken, can't write to console
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  const isEpipe = error && (error as NodeJS.ErrnoException).code === 'EPIPE';

  if (isHandlingException) {
    process.exit(1);
  }
  isHandlingException = true;

  if (isEpipe) {
    try {
      logger.error('EPIPE error - stdout/stderr broken, exiting gracefully');
    } catch {
      // Logger may also fail, ignore
    }
    process.exit(0);
  }

  safeConsoleError('[FATAL] Uncaught exception:', error);
  try {
    logger.error('Uncaught exception:', error);
  } catch {
    // Logger failed, continue anyway
  }

  if (app.isReady()) {
    showErrorDialog('Uncaught Exception', error);
  } else {
    safeConsoleError('FATAL ERROR (app not ready):', error);
    safeConsoleError('Stack:', error.stack);

    app.whenReady().then(() => {
      showErrorDialog('Startup Error', error);
    }).catch(() => {
      process.exit(1);
    });
  }

  isHandlingException = false;
});

process.on('unhandledRejection', (reason, promise) => {
  if (isHandlingException) {
    return;
  }
  isHandlingException = true;

  safeConsoleError('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
  try {
    logger.error('Unhandled rejection:', reason);
  } catch {
    // Ignore logger errors
  }

  if (app.isReady()) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    showErrorDialog('Unhandled Promise Rejection', error);
  }

  isHandlingException = false;
});

// Log startup info
safeConsoleLog('='.repeat(60));
safeConsoleLog('Zira AI starting...');
safeConsoleLog('Debug mode:', isDebugMode);
safeConsoleLog('='.repeat(60));

logger.info('='.repeat(60));
logger.info('Zira AI starting...');
logger.info(`Debug Mode: ${isDebugMode}`);
logger.info(getDiagnostics());
logger.info('='.repeat(60));

// CRITICAL: Request single instance lock BEFORE anything else
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  safeConsoleWarn('Another instance is already running, quitting immediately.');
  logger.warn('Another instance is already running, quitting immediately.');
  app.quit();
  process.exit(0);
}

// Orchestrator instance
let orchestrator: AgentOrchestrator | null = null;

// When a second instance tries to launch, focus the existing window
app.on('second-instance', () => {
  logger.info('Second instance detected, focusing existing window');
  orchestrator?.showWindow();
});

// Show diagnostics in debug mode
if (isDebugMode) {
  app.whenReady().then(() => {
    showStartupDiagnostics();
  });
}

// Start the application
async function startApp() {
  try {
    logger.info('[Startup] Step 1: Waiting for app ready...');
    safeConsoleLog('[Startup] Step 1: Waiting for app ready...');

    await app.whenReady();

    logger.info('[Startup] Step 2: App is ready, initializing...');
    safeConsoleLog('[Startup] Step 2: App is ready, initializing...');

    registerPromoImageProtocolHandler();

    // The app ships its own on-screen keyboards (POS, customer display,
    // self-checkout) so the Windows touch keyboard (TabTip / TextInputHost)
    // only gets in the way — it floats on top of our UI. Suppress it for
    // the lifetime of the app; the OS keyboard returns to normal once Zira
    // AI exits.
    await startSuppressingTouchKeyboard();

    // Force receipt printer toggle ON for this session before any module
    // reads config — a forgotten "off" from a previous shift must not
    // silently stop receipts at the till.
    ensureReceiptPrinterEnabledOnBoot();

    orchestrator = new AgentOrchestrator();
    const container = orchestrator.getContainer();

    orchestrator
      .use(new HardwareModule(container))
      .use(new SyncModule(container))
      .use(new PosModule(container))
      .use(new WarehouseModule(container))
      .use(new InvoiceModule(container))
      .use(new AuthModule(container))
      .use(new RemoteModule(container))
      .use(new BooksyModule(container))
      .use(new TelegramModule(container))
      .use(new BrowserModule(container))
      .use(new BackupModule(container))
      .use(new ForecastModule())
      .use(new SystemToolsModule(container))
      .use(new AiModule(container))
      .use(new SecurityModule(container))
      .use(new CheckinModule(container));

    await orchestrator.initialize();

    // Initialize auto-updater (checks R2 for new versions)
    const { SERVICE_TOKENS } = await import('./core/tokens');
    const cleanupUpdater = initAutoUpdater(() => {
      return orchestrator!.getContainer().getOptional<Electron.BrowserWindow>(SERVICE_TOKENS.MAIN_WINDOW) ?? null;
    });

    // Graceful shutdown: save database, stop modules, disconnect socket
    app.on('before-quit', async (e) => {
      if (orchestrator) {
        e.preventDefault();
        logger.info('[Shutdown] before-quit triggered, running graceful shutdown...');
        await stopSuppressingTouchKeyboard();
        cleanupUpdater();
        const orch = orchestrator;
        orchestrator = null; // prevent re-entry
        await orch.quit();
      }
    });

    logger.info('[Startup] Step 3: Initialization complete!');
    safeConsoleLog('[Startup] Step 3: Initialization complete!');

  } catch (error: any) {
    logger.error('[Startup] Failed:', error);
    safeConsoleError('[Startup] Failed:', error);

    if (app.isReady()) {
      showErrorDialog('Initialization Failed', error);
    } else {
      app.whenReady().then(() => {
        showErrorDialog('Initialization Failed', error);
      });
    }
  }
}

startApp();

// Export for testing
export { isDebugMode, getDiagnostics, showErrorDialog };
