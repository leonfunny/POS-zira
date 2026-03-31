import { Tray, Menu, nativeImage, app, dialog, shell, clipboard } from 'electron';
import { join } from 'path';
import { getIconPath } from './paths';
import logger from './logger';

type TrayStatus = 'connected' | 'disconnected' | 'error';

/**
 * Interface for the host application that TrayManager delegates to.
 * AgentOrchestrator implements this.
 */
export interface TrayManagerHost {
  showWindow(): void;
  testPrint(): Promise<{ success: boolean; error?: string; results?: Record<string, boolean> }>;
  toggleDevTools(): void;
  openLogsFolder(): void;
  quit(): Promise<void>;
}

// Check for debug mode
const isDebugMode = process.argv.includes('--debug') || process.env.DEBUG === '1';

/**
 * System tray manager
 */
export default class TrayManager {
  private tray: Tray;
  private app: TrayManagerHost;
  private currentStatus: TrayStatus = 'disconnected';

  constructor(host: TrayManagerHost) {
    this.app = host;

    logger.info('[Tray] Creating tray icon...');

    // Create tray icon
    const iconPath = getIconPath('tray-gray.png');
    const icon = nativeImage.createFromPath(iconPath);

    // For Windows, use 16x16 icon
    const resizedIcon = icon.resize({ width: 16, height: 16 });

    this.tray = new Tray(resizedIcon);
    this.tray.setToolTip('Zira AI - Rozłączony');

    // Create context menu
    this.updateContextMenu();

    // Double click to open window
    this.tray.on('double-click', () => {
      logger.info('[Tray] Double-click, showing window');
      this.app.showWindow();
    });

    logger.info('[Tray] Tray created successfully');
  }

  /**
   * Update tray icon based on status
   */
  setStatus(status: TrayStatus): void {
    logger.info(`[Tray] Status changed: ${this.currentStatus} -> ${status}`);
    this.currentStatus = status;

    const icons: Record<TrayStatus, string> = {
      connected: 'tray-green.png',
      disconnected: 'tray-gray.png',
      error: 'tray-red.png',
    };

    const tooltips: Record<TrayStatus, string> = {
      connected: 'Zira AI - Połączony',
      disconnected: 'Zira AI - Rozłączony',
      error: 'Zira AI - Błąd',
    };

    const iconPath = getIconPath(icons[status]);
    try {
      const icon = nativeImage.createFromPath(iconPath);
      const resizedIcon = icon.resize({ width: 16, height: 16 });
      this.tray.setImage(resizedIcon);
    } catch (error) {
      logger.warn(`[Tray] Failed to load icon: ${iconPath}`);
    }

    this.tray.setToolTip(tooltips[status]);
    this.updateContextMenu();
  }

  /**
   * Get system diagnostics for copying
   */
  private getDiagnostics(): string {
    const info = [
      `Zira AI Diagnostics`,
      `=============================`,
      `Time: ${new Date().toISOString()}`,
      ``,
      `App Version: ${app.getVersion()}`,
      `Electron: ${process.versions.electron}`,
      `Chrome: ${process.versions.chrome}`,
      `Node: ${process.versions.node}`,
      `V8: ${process.versions.v8}`,
      `Platform: ${process.platform} ${process.arch}`,
      ``,
      `Locale: ${app.getLocale()}`,
      `User Data: ${app.getPath('userData')}`,
      `Exe Path: ${app.getPath('exe')}`,
      ``,
      `Debug Mode: ${isDebugMode}`,
      `Status: ${this.currentStatus}`,
      `Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
    ];
    return info.join('\n');
  }

  /**
   * Update context menu
   */
  private updateContextMenu(): void {
    const statusLabels: Record<TrayStatus, string> = {
      connected: '● Połączony',
      disconnected: '○ Rozłączony',
      error: '✗ Błąd',
    };

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
      {
        label: `Status: ${statusLabels[this.currentStatus]}`,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Otwórz ustawienia',
        click: () => {
          logger.info('[Tray] Opening settings window');
          this.app.showWindow();
        },
      },
      {
        label: 'Test druku',
        click: async () => {
          logger.info('[Tray] Starting test print...');
          const result = await this.app.testPrint();
          if (!result.success) {
            logger.error(`[Tray] Test print failed: ${result.error}`);
            dialog.showErrorBox('Błąd druku', result.error || 'Nieznany błąd');
          } else {
            logger.info('[Tray] Test print successful');
          }
        },
      },
      { type: 'separator' },
    ];

    // Debug menu (always available now for troubleshooting)
    menuTemplate.push({
      label: '🔧 Debug',
      submenu: [
        {
          label: 'Otwórz DevTools (F12)',
          click: () => {
            logger.info('[Tray] Opening DevTools...');
            this.app.toggleDevTools();
          },
        },
        {
          label: 'Otwórz folder logów',
          click: () => {
            logger.info('[Tray] Opening logs folder...');
            this.app.openLogsFolder();
          },
        },
        {
          label: 'Kopiuj diagnostykę',
          click: () => {
            const diagnostics = this.getDiagnostics();
            clipboard.writeText(diagnostics);
            logger.info('[Tray] Diagnostics copied to clipboard');
            dialog.showMessageBox({
              type: 'info',
              title: 'Diagnostyka skopiowana',
              message: 'Dane diagnostyczne zostały skopiowane do schowka.',
              detail: 'Możesz je teraz wkleić i wysłać do supportu.',
            });
          },
        },
        { type: 'separator' },
        {
          label: 'Otwórz folder userData',
          click: () => {
            const userDataPath = app.getPath('userData');
            logger.info(`[Tray] Opening userData folder: ${userDataPath}`);
            shell.openPath(userDataPath);
          },
        },
        {
          label: `Debug mode: ${isDebugMode ? 'ON' : 'OFF'}`,
          enabled: false,
        },
      ],
    });

    menuTemplate.push({ type: 'separator' });
    menuTemplate.push({
      label: 'Uruchom z Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        logger.info(`[Tray] Auto-start changed: ${menuItem.checked}`);
        app.setLoginItemSettings({
          openAtLogin: menuItem.checked,
          path: app.getPath('exe'),
        });
      },
    });
    menuTemplate.push({ type: 'separator' });
    menuTemplate.push({
      label: 'Zamknij',
      click: async () => {
        logger.info('[Tray] Quit requested');
        await this.app.quit();
      },
    });

    const menu = Menu.buildFromTemplate(menuTemplate);
    this.tray.setContextMenu(menu);
  }
}
