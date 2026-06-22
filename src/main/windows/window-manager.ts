import { BrowserWindow, screen, ipcMain, shell, type Display, type Rectangle } from 'electron';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../logger';
import { PosStore } from '../pos/pos-store';
import { getConfigValue } from '../config/store';
import { handleZoomShortcut, resetWindowZoom } from './zoom-controls';
import { getRendererDevServerUrl, shouldUseRendererDevServer } from './renderer-dev-server';

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

interface CustomerDisplayBehavior {
  forceKiosk: boolean;
  hasMultipleDisplays: boolean;
  monitorIndex: number;
  targetDisplay: Display;
  useKiosk: boolean;
}

type KioskInput = {
  key?: string;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

function isSelfCheckoutStaffExit(input: KioskInput): boolean {
  return !!input.control && !!input.shift && (input.key === 'Q' || input.key === 'q');
}

function isBlockedKioskShortcut(input: KioskInput): boolean {
  const key = (input.key || '').toLowerCase();
  if (!key) return false;
  if (key === 'escape' || key === 'f5' || key === 'f11' || key === 'f12') return true;
  if (/^f\d{1,2}$/.test(key)) return true;
  if (input.alt || input.meta) return true;
  if (input.control && input.shift) return true;
  if (input.control && ['0', '+', '-', '=', 'i', 'j', 'n', 'o', 'p', 'q', 'r', 's', 'u', 'w'].includes(key)) return true;
  return false;
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
  selfCheckout: {
    id: 'selfCheckout',
    htmlFile: 'windows/self-checkout/index.html',
    // Public kiosk surface: keep the preload narrow and do not expose the
    // broader customer-display/config/check-in bridge.
    preload: 'preload-self-checkout.js',
    width: 1280,
    height: 800,
    fullscreen: true,
    alwaysOnTop: true,
    targetDisplay: 'primary',
  },
  kitchenSelfOrder: {
    id: 'kitchenSelfOrder',
    htmlFile: 'windows/kitchen-self-order/index.html',
    preload: 'preload-kitchen-self-order.js',
    width: 1280,
    height: 800,
    fullscreen: true,
    alwaysOnTop: true,
    targetDisplay: 'primary',
  },
};

export class WindowManager {
  private windows = new Map<string, BrowserWindow>();
  private posStore: PosStore;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private customerResponsive = true;
  // Flag set when staff intentionally closes the customer display; suppresses the kiosk-restore handler
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
   * Also disables the minimize affordance that appears on touch drag from top edge.
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

  private resolveCustomerDisplayBehavior(
    displays = screen.getAllDisplays(),
    primaryDisplay = screen.getPrimaryDisplay(),
    logSelection: boolean = false,
  ): CustomerDisplayBehavior {
    const monitorIndex = getConfigValue('customerDisplayMonitor') ?? 0;
    let targetDisplay = primaryDisplay;

    if (monitorIndex > 0 && monitorIndex < displays.length) {
      targetDisplay = displays[monitorIndex];
      if (logSelection) {
        logger.info(`[WindowManager] Customer display -> monitor ${monitorIndex} (${targetDisplay.bounds.width}x${targetDisplay.bounds.height})`);
      }
    } else if (monitorIndex > 0) {
      if (logSelection) {
        logger.warn(`[WindowManager] Configured monitor index ${monitorIndex} unavailable (${displays.length} displays). Falling back to primary.`);
      }
    } else if (logSelection) {
      logger.info('[WindowManager] Customer display -> primary monitor');
    }

    const hasMultipleDisplays = displays.length > 1;
    const forceKiosk = getConfigValue('customerDisplayForceKiosk') ?? true;

    return {
      forceKiosk,
      hasMultipleDisplays,
      monitorIndex,
      targetDisplay,
      useKiosk: forceKiosk,
    };
  }

  private getCustomerDisplayBounds(behavior: CustomerDisplayBehavior): Rectangle {
    if (behavior.useKiosk) {
      return {
        x: behavior.targetDisplay.bounds.x,
        y: behavior.targetDisplay.bounds.y,
        width: behavior.targetDisplay.bounds.width,
        height: behavior.targetDisplay.bounds.height,
      };
    }

    const workArea = behavior.targetDisplay.workArea;
    const config = WINDOW_CONFIGS.customer;

    return {
      x: workArea.x + Math.max(0, Math.floor((workArea.width - config.width) / 2)),
      y: workArea.y + Math.max(0, Math.floor((workArea.height - config.height) / 2)),
      width: config.width,
      height: config.height,
    };
  }

  private applyCustomerDisplayPresentation(
    win: BrowserWindow,
    behavior: CustomerDisplayBehavior,
  ): void {
    if (win.isDestroyed()) return;

    const bounds = this.getCustomerDisplayBounds(behavior);

    if (behavior.useKiosk) {
      this.applyKioskPresentation(win, bounds);
      return;
    }

    if (win.isKiosk()) {
      win.setKiosk(false);
    }
    win.setFullScreen(false);
    win.setAlwaysOnTop(false);
    win.setBounds(bounds);
  }

  private applyKioskPresentation(win: BrowserWindow, bounds: Rectangle): void {
    if (win.isDestroyed()) return;
    win.setBounds(bounds);
    win.setMenuBarVisibility(false);
    win.setAutoHideMenuBar(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setKiosk(true);
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
    if (id === 'selfCheckout' && !getConfigValue('selfCheckoutEnabled')) {
      logger.warn('[WindowManager] Self-checkout disabled in settings');
      return null;
    }
    if (id === 'kitchenSelfOrder' && !getConfigValue('kitchenSelfOrderEnabled')) {
      logger.warn('[WindowManager] Kitchen self-order disabled in settings');
      return null;
    }

    const existing = this.getWindow(id);
    if (existing) {
      if (id === 'customer') {
        existing.showInactive();
      } else {
        existing.show();
        existing.focus();
      }
      if (id === 'customer') {
        existing.webContents.send('customer-display:refresh-config');
      }
      return existing;
    }

    const config = WINDOW_CONFIGS[id];
    if (!config) throw new Error(`Unknown window config: ${id}`);

    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();
    const isCustomer = id === 'customer';
    const isSelfCheckout = id === 'selfCheckout';
    const isKitchenSelfOrder = id === 'kitchenSelfOrder';
    const isCustomerKiosk = isSelfCheckout || isKitchenSelfOrder;
    const customerBehavior = isCustomer
      ? this.resolveCustomerDisplayBehavior(displays, primaryDisplay, true)
      : null;
    const customerBounds = customerBehavior ? this.getCustomerDisplayBounds(customerBehavior) : null;

    let targetDisplay = primaryDisplay;
    if (customerBehavior) {
      targetDisplay = customerBehavior.targetDisplay;
    } else if (isCustomerKiosk) {
      const requestedDisplay = Number(getConfigValue(isKitchenSelfOrder ? 'kitchenSelfOrderMonitor' : 'selfCheckoutMonitor') ?? 0);
      targetDisplay = displays[requestedDisplay] || primaryDisplay;
    } else if (config.targetDisplay === 'secondary' && displays.length > 1) {
      targetDisplay = displays.find((d) => d.id !== primaryDisplay.id) || primaryDisplay;
    }

    const selfCheckoutBounds: Rectangle | null = isCustomerKiosk
      ? {
        x: targetDisplay.bounds.x,
        y: targetDisplay.bounds.y,
        width: targetDisplay.bounds.width,
        height: targetDisplay.bounds.height,
      }
      : null;
    const lockedKioskBounds = customerBounds ?? selfCheckoutBounds;
    const hasMultipleDisplays = customerBehavior?.hasMultipleDisplays ?? displays.length > 1;
    // Force kiosk flag (default true): when set, customer display goes true-fullscreen kiosk
    // even on single-monitor machines. Toggle it off in Settings on dev machines that need
    // the old windowed fallback. Esc and 3-finger swipe-down (CustomerApp.tsx) still exit.
    const forceKiosk = customerBehavior?.forceKiosk ?? false;
    const useKiosk = customerBehavior?.useKiosk ?? isCustomerKiosk;
    const useAlwaysOnTop = useKiosk || !!config.alwaysOnTop;
    const isLockedKioskSurface = (isCustomer || isCustomerKiosk) && useKiosk;

    if (isCustomer && !hasMultipleDisplays) {
      if (forceKiosk) {
        logger.warn('[WindowManager] Single monitor + force kiosk ON - customer display will cover this screen. Press Esc or 3-finger swipe-down from the top to exit.');
      } else {
        logger.warn('[WindowManager] Single monitor + force kiosk OFF - customer display opens windowed (legacy fallback)');
      }
    }

    // For customer-facing kiosk surfaces: disable Windows edge-swipe gestures before opening
    if (isLockedKioskSurface) {
      this.disableEdgeSwipeGestures().catch((e) => { logger.debug('[WindowManager] edge-swipe disable failed:', e?.message); });
    }

    const win = new BrowserWindow({
      width: lockedKioskBounds?.width ?? (config.fullscreen ? targetDisplay.bounds.width : config.width),
      height: lockedKioskBounds?.height ?? (config.fullscreen ? targetDisplay.bounds.height : config.height),
      x: lockedKioskBounds?.x ?? targetDisplay.bounds.x,
      y: lockedKioskBounds?.y ?? targetDisplay.bounds.y,
      minWidth: config.minWidth,
      minHeight: config.minHeight,
      fullscreen: isCustomer ? useKiosk : (isLockedKioskSurface ? true : (config.fullscreen || false)),
      alwaysOnTop: useAlwaysOnTop,
      kiosk: useKiosk,
      frame: isCustomer ? false : !isLockedKioskSurface,
      closable: isLockedKioskSurface ? false : true,
      minimizable: !isCustomer && !isLockedKioskSurface,
      maximizable: !isCustomer && !isLockedKioskSurface,
      movable: isLockedKioskSurface ? false : (isCustomer ? !useKiosk : true),
      resizable: isLockedKioskSurface ? false : (isCustomer ? !useKiosk : true),
      skipTaskbar: isLockedKioskSurface,
      webPreferences: {
        preload: join(__dirname, `../../preload/${config.preload}`),
        webviewTag: true, // allow embedding the web /add page in a <webview>
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true, // SECURITY: Enable sandbox to isolate renderer
        devTools: isDebugMode, // SECURITY: Only enable DevTools in debug mode
        // Real-time surfaces (POS / customer display / self-checkout) must keep
        // painting even when occluded or unfocused. The customer display lives on
        // a never-focused secondary monitor, and the <webview> "Tạo sản phẩm" panel
        // covers the POS host — both trigger Chromium occlusion throttling, which
        // defers React paint commits so cart/state updates only appear after a
        // focus/fullscreen toggle forces a repaint.
        backgroundThrottling: false,
      },
      show: false,
      autoHideMenuBar: true,
      title:
        id === 'pos'
          ? 'Zira AI POS'
          : id === 'selfCheckout'
            ? 'Self Checkout'
            : id === 'kitchenSelfOrder'
              ? 'Kitchen Self-Order'
              : 'Customer Display',
    });

    if (customerBehavior) {
      this.applyCustomerDisplayPresentation(win, customerBehavior);
    } else if (isCustomerKiosk && selfCheckoutBounds) {
      this.applyKioskPresentation(win, selfCheckoutBounds);
    }

    // Load HTML
    const isDev = shouldUseRendererDevServer();
    if (isDev) {
      const devServerUrl = getRendererDevServerUrl();
      const devUrls: Record<string, string> = {
        pos: `${devServerUrl}/windows/pos/`,
        customer: `${devServerUrl}/windows/customer/`,
        selfCheckout: `${devServerUrl}/windows/self-checkout/`,
        kitchenSelfOrder: `${devServerUrl}/windows/kitchen-self-order/`,
      };
      win.loadURL(devUrls[id] || `${devServerUrl}/windows/${id}/`);
    } else {
      win.loadFile(join(__dirname, `../../renderer/${config.htmlFile}`));
    }

    // SECURITY: Navigation guards - prevent redirects to malicious pages
    win.webContents.on('will-navigate', (event, navigationUrl) => {
      const allowed = isDev ? [getRendererDevServerUrl()] : ['file://'];
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

    win.webContents.on('did-finish-load', () => {
      resetWindowZoom(win, id);
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
          logger.info('[WindowManager] Escape pressed on customer display - closing');
          win.destroy();
          return;
        }
        // Block all other keyboard shortcuts on customer display
        event.preventDefault();
        return;
      }

      if (isCustomerKiosk && isLockedKioskSurface) {
        if (isSelfCheckoutStaffExit(input)) {
          logger.info(`[WindowManager] Ctrl+Shift+Q on ${id} - closing`);
          event.preventDefault();
          win.destroy();
          return;
        }

        // Allow F12 in dev mode only
        if (input.key === 'F12' && isDev) {
          win.webContents.toggleDevTools();
          return;
        }

        if (isBlockedKioskShortcut(input)) {
          event.preventDefault();
          return;
        }

        return;
      }

      if (handleZoomShortcut(win, event, input)) return;

      if (input.key === 'F11') {
        event.preventDefault();
        win.setFullScreen(!win.isFullScreen());
        return;
      }

      // F12 for DevTools on other windows
      if (input.key === 'F12') {
        win.webContents.toggleDevTools();
      }
    });

    win.once('ready-to-show', () => {
      if (isCustomer) {
        win.showInactive();
      } else {
        win.show();
      }
    });

    // Kiosk lock: if a customer-facing kiosk exits fullscreen unexpectedly (OS touch gesture,
    // Win+D, etc.) re-enter kiosk/fullscreen immediately so customers can't escape.
    // Only skipped when staff intentionally closes via the display:close IPC channel.
    if (isLockedKioskSurface && lockedKioskBounds) {
      win.on('leave-full-screen', () => {
        if (isCustomer && this.customerExitRequested) return;
        logger.info(`[WindowManager] ${id} left fullscreen unexpectedly - restoring`);
        const restoreTimer = setTimeout(() => {
          if (win.isDestroyed() || (isCustomer && this.customerExitRequested)) return;
          if (isCustomer) {
            this.applyCustomerDisplayPresentation(win, this.resolveCustomerDisplayBehavior());
          } else {
            this.applyKioskPresentation(win, lockedKioskBounds);
          }
          logger.info(`[WindowManager] ${id} kiosk/fullscreen restored`);
        }, 50);
        win.once('closed', () => clearTimeout(restoreTimer));
      });

      if (isCustomerKiosk) {
        // Prevent OS from stealing focus via swipe gestures - immediately reclaim
        win.on('blur', () => {
          if (win.isDestroyed()) return;
          setTimeout(() => {
            if (!win.isDestroyed()) {
              win.focus();
            }
          }, 100);
        });
      }

      logger.info(`[WindowManager] ${id} kiosk=true, frameless=true, blur-refocus=${isCustomerKiosk ? 'on' : 'off'}`);
    } else if (isCustomer) {
      logger.info(`[WindowManager] Customer display kiosk=false, frameless=true, windowed mode`);
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
    // Staff intentional close - bypasses the kiosk-restore lock
    ipcMain.handle('display:close', (event) => {
      const senderWin = BrowserWindow.fromWebContents(event.sender);
      const customerWin = this.getWindow('customer');
      if (!senderWin || !customerWin || senderWin !== customerWin) {
        logger.warn('[WindowManager] Rejected display:close from non-customer window');
        return { success: false, error: 'invalid_display_sender' };
      }

      if (customerWin && !customerWin.isDestroyed()) {
        this.customerExitRequested = true;
        customerWin.destroy();
        // Reset flag after the window's closed event has fully propagated
        setTimeout(() => { this.customerExitRequested = false; }, 500);
      }
      return { success: true };
    });

    // Staff intentional close for the self-checkout kiosk gesture.
    ipcMain.handle('self-checkout:close', (event) => {
      const senderWin = BrowserWindow.fromWebContents(event.sender);
      const selfCheckoutWin = this.getWindow('selfCheckout');
      if (senderWin && selfCheckoutWin && senderWin === selfCheckoutWin && !senderWin.isDestroyed()) {
        senderWin.destroy();
        return { success: true };
      }
      return { success: false, error: 'not_self_checkout_window' };
    });

    ipcMain.handle('kitchen-self-order:close', (event) => {
      const senderWin = BrowserWindow.fromWebContents(event.sender);
      const kitchenSelfOrderWin = this.getWindow('kitchenSelfOrder');
      if (senderWin && kitchenSelfOrderWin && senderWin === kitchenSelfOrderWin && !senderWin.isDestroyed()) {
        senderWin.destroy();
        return { success: true };
      }
      return { success: false, error: 'not_kitchen_self_order_window' };
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
        const primaryDisplay = screen.getPrimaryDisplay();
        const behavior = this.resolveCustomerDisplayBehavior(displays, primaryDisplay, true);
        if (behavior.monitorIndex > 0 && behavior.monitorIndex < displays.length) {
          logger.info(`[WindowManager] Moving customer display to monitor ${behavior.monitorIndex}`);
        }
        this.applyCustomerDisplayPresentation(customerWin, behavior);
      }
    };

    this.displayRemovedListener = () => {
      logger.info('[WindowManager] Display removed');
      const customerWin = this.getWindow('customer');
      if (customerWin) {
        const displays = screen.getAllDisplays();
        const primaryDisplay = screen.getPrimaryDisplay();
        this.applyCustomerDisplayPresentation(
          customerWin,
          this.resolveCustomerDisplayBehavior(displays, primaryDisplay, true),
        );
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
      if (!customerWin) return;

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
    try { ipcMain.removeHandler('display:close'); } catch (err: any) { logger.debug('[WindowManager] removeHandler display:close failed:', err?.message); }
    try { ipcMain.removeHandler('self-checkout:close'); } catch (err: any) { logger.debug('[WindowManager] removeHandler self-checkout:close failed:', err?.message); }
    try { ipcMain.removeHandler('kitchen-self-order:close'); } catch (err: any) { logger.debug('[WindowManager] removeHandler kitchen-self-order:close failed:', err?.message); }
    // Destroy windows
    for (const [_id, win] of this.windows) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.windows.clear();
    logger.info('[WindowManager] Destroyed and all listeners cleaned up');
  }
}
