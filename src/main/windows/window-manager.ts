import { BrowserWindow, screen, ipcMain, shell } from 'electron';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../logger';
import { PosStore } from '../pos/pos-store';
import { getConfigValue } from '../config/store';

const execFileAsync = promisify(execFile);

// SECURITY: Debug mode detection for conditional DevTools
const isDebugMode = process.argv.includes('--debug') || process.env.DEBUG === '1';

interface WindowConfig {
  id: string;
  htmlFile: string;
  preload: string;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  alwaysOnTop?: boolean;
  fullscreen?: boolean;
  targetDisplay?: 'primary' | 'secondary';
}

const WINDOW_CONFIGS: Record<string, WindowConfig> = {
  pos: {
    id: 'pos',
    htmlFile: 'windows/pos/index.html',
    preload: 'preload-pos.js',
    width: 1024,
    height: 768,
    minWidth: 800,
    minHeight: 600,
    targetDisplay: 'primary',
  },
  customer: {
    id: 'customer',
    htmlFile: 'windows/customer/index.html',
    preload: 'preload-display.js',
    width: 1024,
    height: 768,
    fullscreen: true,
    alwaysOnTop: false,
    targetDisplay: 'secondary',
  },
};

export class WindowManager {
  private windows = new Map<string, BrowserWindow>();
  private posStore: PosStore;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private customerResponsive = true;
  // Flag set when staff intentionally closes the customer display — suppresses the kiosk-restore handler
  private customerExitRequested = false;
  // Store listener refs for cleanup
  private pongListener: (() => void) | null = null;
  private displayAddedListener: (() => void) | null = null;
  private displayRemovedListener: (() => void) | null = null;

  constructor(posStore: PosStore) {
    this.posStore = posStore;
    this.setupIpcHandlers();
    this.setupDisplayListeners();
    this.setupHeartbeat();
    logger.info('[WindowManager] Initialized');
  }

  /**
   * Disable Windows 10/11 edge-swipe gestures that can pull the customer display
   * out of fullscreen/kiosk mode. Sets registry keys under HKCU (no admin needed).
   * Also disables the "−" (minimize) affordance that appears on touch drag from top edge.
   */
  private async disableEdgeSwipeGestures(): Promise<void> {
    const regKeys = [
      // Disable edge UI (swipe from edges)
      { path: 'HKCU:\\SOFTWARE\\Policies\\Microsoft\\Windows\\EdgeUI', name: 'AllowEdgeSwipe', value: 0 },
      // Disable tablet-mode swipe gestures
      { path: 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ImmersiveShell\\EdgeUI', name: 'DisableTLCorner', value: 1 },
      { path: 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ImmersiveShell\\EdgeUI', name: 'DisableTRCorner', value: 1 },
    ];

    for (const key of regKeys) {
      try {
        const psCommand =
          `$null = New-Item -Path '${key.path}' -Force; ` +
          `Set-ItemProperty -Path '${key.path}' -Name '${key.name}' -Value ${key.value} -Type DWord -Force`;
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { encoding: 'utf8', timeout: 5000 });
        logger.info(`[WindowManager] Registry set: ${key.path}\\${key.name} = ${key.value}`);
      } catch (err: any) {
        logger.warn(`[WindowManager] Failed to set registry key ${key.name}: ${err.message}`);
      }
    }
  }

  getWindow(id: string): BrowserWindow | null {
    const win = this.windows.get(id);
    if (win && !win.isDestroyed()) return win;
    this.windows.delete(id);
    return null;
  }

  createWindow(id: string): BrowserWindow | null {
    // Check config gates
    if (id === 'pos' && !getConfigValue('posEnabled')) {
      logger.warn('[WindowManager] POS window disabled in settings');
      return null;
    }
    if (id === 'customer' && !getConfigValue('customerDisplayEnabled')) {
      logger.warn('[WindowManager] Customer display disabled in settings');
      return null;
    }

    const existing = this.getWindow(id);
    if (existing) {
      existing.show();
      existing.focus();
      return existing;
    }

    const config = WINDOW_CONFIGS[id];
    if (!config) throw new Error(`Unknown window config: ${id}`);

    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();

    let targetDisplay = primaryDisplay;
    if (id === 'customer') {
      // Use configured monitor index for customer display
      // index 0 = primary, index N = exact display index
      const monitorIndex = getConfigValue('customerDisplayMonitor') ?? 0;
      if (monitorIndex > 0 && monitorIndex < displays.length) {
        targetDisplay = displays[monitorIndex];
        logger.info(`[WindowManager] Customer display → monitor ${monitorIndex} (${targetDisplay.bounds.width}x${targetDisplay.bounds.height})`);
      } else if (monitorIndex > 0) {
        // User selected a monitor that doesn't exist — stay on primary, log warning
        logger.warn(`[WindowManager] Configured monitor index ${monitorIndex} unavailable (${displays.length} displays). Falling back to primary.`);
      } else {
        logger.info(`[WindowManager] Customer display → primary monitor`);
      }
    } else if (config.targetDisplay === 'secondary' && displays.length > 1) {
      targetDisplay = displays.find((d) => d.id !== primaryDisplay.id) || primaryDisplay;
    }

    const isCustomer = id === 'customer';
    const hasMultipleDisplays = displays.length > 1;
    // Force kiosk flag (default true): when set, customer display goes true-fullscreen kiosk
    // even on single-monitor machines. Toggle it off in Settings on dev machines that need
    // the old windowed fallback. Esc and 3-finger swipe-down (CustomerApp.tsx) still exit.
    const forceKiosk = !!getConfigValue('customerDisplayForceKiosk');
    const useKiosk = isCustomer && (hasMultipleDisplays || forceKiosk);
    const useAlwaysOnTop = useKiosk;

    if (isCustomer && !hasMultipleDisplays) {
      if (forceKiosk) {
        logger.warn('[WindowManager] Single monitor + force kiosk ON — customer display will cover this screen. Press Esc or 3-finger swipe-down from the top to exit.');
      } else {
        logger.warn('[WindowManager] Single monitor + force kiosk OFF — customer display opens windowed (legacy fallback)');
      }
    }

    // For customer display: disable Windows edge-swipe gestures before opening
    if (isCustomer && useKiosk) {
      this.disableEdgeSwipeGestures().catch((e) => { logger.debug('[WindowManager] edge-swipe disable failed:', e?.message); });
    }

    const win = new BrowserWindow({
      width: config.fullscreen ? targetDisplay.workAreaSize.width : config.width,
      height: config.fullscreen ? targetDisplay.workAreaSize.height : config.height,
      x: targetDisplay.bounds.x,
      y: targetDisplay.bounds.y,
      minWidth: config.minWidth,
      minHeight: config.minHeight,
      fullscreen: isCustomer ? useKiosk : (config.fullscreen || false),
      alwaysOnTop: useAlwaysOnTop,
      kiosk: useKiosk,
      frame: isCustomer ? false : true, // Frameless removes the "−" bar on customer display
      closable: isCustomer ? !useKiosk : true,
      minimizable: !isCustomer,
      maximizable: !isCustomer,
      movable: isCustomer ? !useKiosk : true,
      resizable: isCustomer ? !useKiosk : true,
      skipTaskbar: isCustomer,
      webPreferences: {
        preload: join(__dirname, `../../preload/${config.preload}`),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true, // SECURITY: Enable sandbox to isolate renderer
        devTools: isDebugMode, // SECURITY: Only enable DevTools in debug mode
      },
      show: false,
      autoHideMenuBar: true,
      title: id === 'pos' ? 'Zira AI POS' : 'Customer Display',
    });

    // Load HTML
    const isDev = process.env.NODE_ENV === 'development';
    if (isDev) {
      const devUrls: Record<string, string> = {
        pos: 'http://localhost:3100/windows/pos/',
        customer: 'http://localhost:3100/windows/customer/',
      };
      win.loadURL(devUrls[id] || `http://localhost:3100/windows/${id}/`);
    } else {
      win.loadFile(join(__dirname, `../../renderer/${config.htmlFile}`));
    }

    // SECURITY: Navigation guards — prevent redirects to malicious pages
    win.webContents.on('will-navigate', (event, navigationUrl) => {
      const allowed = isDev
        ? [`http://localhost:3100`]
        : ['file://'];
      if (!allowed.some(prefix => navigationUrl.startsWith(prefix))) {
        logger.warn(`[WindowManager] Blocked navigation to: ${navigationUrl}`);
        event.preventDefault();
      }
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    // Register for POS state broadcasts
    this.posStore.registerWindow(win);

    // Keyboard handling
    win.webContents.on('before-input-event', (event, input) => {
      if (isCustomer) {
        // Allow F12 in dev mode only
        if (input.key === 'F12' && isDev) {
          win.webContents.toggleDevTools();
          return;
        }
        // Escape closes customer display (safety exit on single monitor)
        if (input.key === 'Escape') {
          logger.info('[WindowManager] Escape pressed on customer display — closing');
          win.destroy();
          return;
        }
        // Block all other keyboard shortcuts on customer display
        event.preventDefault();
        return;
      }
      // F12 for DevTools on other windows
      if (input.key === 'F12') {
        win.webContents.toggleDevTools();
      }
    });

    win.once('ready-to-show', () => win.show());

    // Kiosk lock: if the customer display exits fullscreen unexpectedly (OS touch gesture,
    // Win+D, etc.) re-enter kiosk/fullscreen immediately so customers can't escape.
    // Only skipped when staff intentionally closes via the display:close IPC channel.
    if (isCustomer) {
      win.on('leave-full-screen', () => {
        if (this.customerExitRequested) return;
        logger.info('[WindowManager] Customer display left fullscreen unexpectedly — restoring');
        const restoreTimer = setTimeout(() => {
          if (win.isDestroyed() || this.customerExitRequested) return;
          if (win.isKiosk()) return; // already back
          if (useKiosk) {
            win.setKiosk(true);
          } else {
            win.setFullScreen(true);
          }
          logger.info('[WindowManager] Customer display kiosk/fullscreen restored');
        }, 50);
        win.once('closed', () => clearTimeout(restoreTimer));
      });

      // Prevent OS from stealing focus via swipe gestures — immediately reclaim
      win.on('blur', () => {
        if (this.customerExitRequested || win.isDestroyed()) return;
        setTimeout(() => {
          if (!win.isDestroyed() && !this.customerExitRequested) {
            win.focus();
          }
        }, 100);
      });

      logger.info(`[WindowManager] Customer display kiosk=${useKiosk}, frameless=true, blur-refocus=on`);
    }

    win.on('closed', () => {
      this.windows.delete(id);
      this.posStore.unregisterWindow(win);
      logger.info(`[WindowManager] Window closed: ${id}`);
    });

    this.windows.set(id, win);
    logger.info(`[WindowManager] Created window: ${id}`);
    return win;
  }

  closeWindow(id: string): void {
    const win = this.getWindow(id);
    if (win) {
      win.destroy();
      this.windows.delete(id);
    }
  }

  private setupIpcHandlers(): void {
    // Staff intentional close — bypasses the kiosk-restore lock
    ipcMain.handle('display:close', () => {
      const customerWin = this.getWindow('customer');
      if (customerWin && !customerWin.isDestroyed()) {
        this.customerExitRequested = true;
        customerWin.destroy();
        // Reset flag after the window's closed event has fully propagated
        setTimeout(() => { this.customerExitRequested = false; }, 500);
      }
      return { success: true };
    });

    ipcMain.handle('window:setFullScreen', (event, value: boolean) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) win.setFullScreen(value);
      return { success: true };
    });

    ipcMain.handle('window:setKiosk', (event, value: boolean) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        win.setKiosk(value);
        if (value) {
          win.setMenuBarVisibility(false);
          win.setAutoHideMenuBar(true);
        }
        logger.info(`[WindowManager] Main window kiosk=${value}`);
      }
      return { success: true };
    });

    ipcMain.handle('window:open', (_e, id: string) => {
      const win = this.createWindow(id);
      if (!win) {
        return { success: false, error: `${id} window is disabled in settings` };
      }
      return { success: true };
    });

    ipcMain.handle('window:close', (_e, id: string) => {
      this.closeWindow(id);
      return { success: true };
    });

    ipcMain.handle('window:list', () => {
      return Array.from(this.windows.keys());
    });

    ipcMain.handle('display:list', () => {
      const displays = screen.getAllDisplays();
      const primary = screen.getPrimaryDisplay();
      return displays.map((d, index) => ({
        index,
        id: d.id,
        label: d.label || `Display ${index + 1}`,
        width: d.bounds.width,
        height: d.bounds.height,
        x: d.bounds.x,
        y: d.bounds.y,
        isPrimary: d.id === primary.id,
      }));
    });
  }

  private setupDisplayListeners(): void {
    this.displayAddedListener = () => {
      logger.info('[WindowManager] Display added');
      const customerWin = this.getWindow('customer');
      if (customerWin) {
        const displays = screen.getAllDisplays();
        const monitorIndex = getConfigValue('customerDisplayMonitor') ?? 0;
        if (monitorIndex > 0 && monitorIndex < displays.length) {
          const target = displays[monitorIndex];
          logger.info(`[WindowManager] Moving customer display to monitor ${monitorIndex}`);
          customerWin.setBounds({
            x: target.bounds.x,
            y: target.bounds.y,
            width: target.workAreaSize.width,
            height: target.workAreaSize.height,
          });
        } else if (monitorIndex > 0) {
          logger.warn(`[WindowManager] Configured monitor ${monitorIndex} still unavailable after display-added (${displays.length} displays)`);
        }
      }
    };

    this.displayRemovedListener = () => {
      logger.info('[WindowManager] Display removed');
      const customerWin = this.getWindow('customer');
      if (customerWin) {
        const primary = screen.getPrimaryDisplay();
        customerWin.setBounds({
          x: primary.bounds.x,
          y: primary.bounds.y,
          width: 800,
          height: 600,
        });
        customerWin.setFullScreen(false);
      }
    };

    screen.on('display-added', this.displayAddedListener);
    screen.on('display-removed', this.displayRemovedListener);
  }

  private setupHeartbeat(): void {
    // Reply handler for customer display pong
    this.pongListener = () => {
      this.missedPongs = 0;
      if (!this.customerResponsive) {
        this.customerResponsive = true;
        logger.info('[WindowManager] Customer display recovered');
        this.notifyPosWindow('customer-display:status', { responsive: true });
      }
    };
    ipcMain.on('display:pong', this.pongListener);

    // Ping customer display every 10 seconds
    this.heartbeatInterval = setInterval(() => {
      const customerWin = this.getWindow('customer');
      if (!customerWin) return; // No customer window open, skip

      try {
        customerWin.webContents.send('display:ping');
        this.missedPongs++;

        // 3 missed pongs = 30s unresponsive
        if (this.missedPongs >= 3 && this.customerResponsive) {
          this.customerResponsive = false;
          logger.warn(`[WindowManager] Customer display unresponsive (${this.missedPongs} missed pongs)`);
          this.notifyPosWindow('customer-display:status', { responsive: false });
        }
      } catch {
        // Window may be destroyed between check and send
      }
    }, 10000);
  }

  private notifyPosWindow(channel: string, data: any): void {
    const posWin = this.getWindow('pos');
    if (posWin && !posWin.isDestroyed()) {
      posWin.webContents.send(channel, data);
    }
  }

  isCustomerDisplayResponsive(): boolean {
    return this.customerResponsive;
  }

  destroy(): void {
    // Clear heartbeat timer
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    // Remove IPC listener
    if (this.pongListener) {
      ipcMain.removeListener('display:pong', this.pongListener);
      this.pongListener = null;
    }
    // Remove screen listeners
    if (this.displayAddedListener) {
      screen.removeListener('display-added', this.displayAddedListener);
      this.displayAddedListener = null;
    }
    if (this.displayRemovedListener) {
      screen.removeListener('display-removed', this.displayRemovedListener);
      this.displayRemovedListener = null;
    }
    // Remove IPC handlers
    try { ipcMain.removeHandler('window:open'); } catch (err: any) { logger.debug('[WindowManager] removeHandler window:open failed:', err?.message); }
    try { ipcMain.removeHandler('window:close'); } catch (err: any) { logger.debug('[WindowManager] removeHandler window:close failed:', err?.message); }
    try { ipcMain.removeHandler('window:list'); } catch (err: any) { logger.debug('[WindowManager] removeHandler window:list failed:', err?.message); }
    try { ipcMain.removeHandler('display:list'); } catch (err: any) { logger.debug('[WindowManager] removeHandler display:list failed:', err?.message); }
    // Destroy windows
    for (const [_id, win] of this.windows) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.windows.clear();
    logger.info('[WindowManager] Destroyed and all listeners cleaned up');
  }
}
