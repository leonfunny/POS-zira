/**
 * Service Container tokens
 *
 * String constants used as keys in the ServiceContainer.
 * Using plain strings (not Symbols) so they serialise in logs.
 */

export const SERVICE_TOKENS = {
  // Infrastructure
  DATABASE: 'database',
  EVENT_BUS: 'eventBus',
  TOOL_REGISTRY: 'toolRegistry',

  // Networking
  SOCKET: 'socket',
  API_CLIENT: 'apiClient',

  // Windows
  MAIN_WINDOW: 'mainWindow',
  WINDOW_MANAGER: 'windowManager',

  // Hardware
  HARDWARE_MODULE: 'hardwareModule',
  PRINTERS: 'printers',
  SCANNER: 'scanner',

  // POS
  POS_STORE: 'posStore',
  PAYMENT_CONTROLLER: 'paymentController',
  SHIFT_CONTROLLER: 'shiftController',

  // Sync
  PRODUCT_SYNC: 'productSync',
  ORDER_SYNC: 'orderSync',
  BILLIARD_SYNC: 'billiardSync',
  CHECKIN_SYNC: 'checkinSync',

  // AI
  ZIRA_AI: 'ziraAI',

  // Browser
  BROWSER_CONTROLLER: 'browserController',

  // Remote
  REMOTE_SESSION_MANAGER: 'remoteSessionManager',
  SSH_TUNNEL_MANAGER: 'sshTunnelManager',

  // Telegram
  TELEGRAM_BOT: 'telegramBot',

  // Booksy
  BOOKSY_SYNC: 'booksySync',

  // Tray
  TRAY_MANAGER: 'trayManager',

  // Security
  SECURITY_MODULE: 'securityModule',

  // Extension WebSocket Server
  EXTENSION_WSS: 'extensionWss',
} as const;

export type ServiceToken = typeof SERVICE_TOKENS[keyof typeof SERVICE_TOKENS];
