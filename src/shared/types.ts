/**
 * Shared types between main and renderer processes
 */

// Agent status
export enum AgentStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

// Printer protocol types
export type PrinterProtocol = 'THERMAL' | 'POSNET' | 'ZEBRA' | 'WINDOWS';

// Printer types - used for routing jobs to correct printer
// Using const object instead of enum for better Vite/browser compatibility
export const PrinterType = {
  RECEIPT: 'RECEIPT',   // Thermal ESC/POS receipt printers (Xprinter, Epson, Star...)
  FISCAL: 'FISCAL',     // Fiscal printers (Posnet) — legally required fiscal receipts
  LABEL: 'LABEL',       // Máy in nhãn/barcode (Zebra, TSC...)
  A4: 'A4',             // Máy in A4 thường (HP, Canon...)
  TICKET: 'TICKET',     // Máy in vé
  KITCHEN: 'KITCHEN',   // Máy in bếp
} as const;
export type PrinterType = typeof PrinterType[keyof typeof PrinterType];

/**
 * Allowed protocols per printer type — single source of truth.
 *
 * Used by:
 *  - Renderer (Settings.tsx) to filter the protocol dropdown
 *  - Main (HardwareModule) to validate test/save requests
 *
 * Keep this map in sync between both processes — do not duplicate it.
 */
export const ALLOWED_PROTOCOLS_BY_TYPE: Record<PrinterType, PrinterProtocol[]> = {
  RECEIPT: ['THERMAL', 'WINDOWS'],
  FISCAL:  ['POSNET'],
  LABEL:   ['ZEBRA', 'WINDOWS'],
  A4:      ['WINDOWS'],
  TICKET:  ['POSNET', 'THERMAL', 'WINDOWS'],
  KITCHEN: ['POSNET', 'THERMAL', 'WINDOWS'],
};

// Print job types
export enum PrintJobType {
  RECEIPT = 'RECEIPT',
  INVOICE = 'INVOICE',
  REPORT = 'REPORT',
  LABEL = 'LABEL',
  BARCODE = 'BARCODE',
  TEST = 'TEST',
  DAILY_REPORT = 'DAILY_REPORT',  // Raport dobowy
  X_REPORT = 'X_REPORT',          // Raport X (niefiskalny)
  Z_REPORT = 'Z_REPORT',          // Raport Z (fiskalny)
}

// Printer status returned by driver.getStatus()
export interface PrinterStatusInfo {
  connected: boolean;
  type: 'POSNET' | 'ZEBRA' | 'THERMAL';
  port?: string;
  printerName?: string;
  protocol?: string;
  connectionType?: string;
  paperWidth?: number;
  mock?: boolean;
  connectionState?: 'disconnected' | 'physical_present' | 'protocol_ready';
  diagnostic?: { code: string; detail?: string };
  detectedPid?: number;
}

/**
 * Structured result of `PosnetDriver.diagnosePort()` — a read-only probe that
 * tells the UI exactly where the POSNET communication chain breaks without
 * mutating driver state or auto-saving config.
 */
export interface PosnetDiagnoseResult {
  port: string;
  portPresent: boolean;
  portOpenable: boolean;
  vidMatch: boolean;
  pid?: number;
  pidHex?: string;
  modelName?: string;
  posnetResponse: boolean;
  baudRate: number;
  diagnostic: { code: string; detail?: string };
  guidance: string[];
  /** True when resolution requires a hardware-menu change on the printer. */
  requiresManualSetup: boolean;
}

// Daily report data for thermal printers
export interface DailyReportData {
  date: string;
  reportNumber?: string;
  transactionCount: number;
  grossSales: number;      // In grosze/cents
  discounts: number;       // In grosze/cents
  refunds?: number;        // In grosze/cents
  netSales: number;        // In grosze/cents
  vatSummary?: Array<{
    rate: number;          // VAT rate (23, 8, 5, 0)
    amount: number;        // In grosze/cents
  }>;
  paymentSummary?: Array<{
    method: string;        // CASH, CARD, etc.
    amount: number;        // In grosze/cents
  }>;
  cashierName?: string;
}

// Barcode types for label printing
export type BarcodeType = 'CODE128' | 'QR' | 'EAN13';

// Label data interface for Zebra printing
export interface LabelData {
  barcode: string;
  barcodeType: BarcodeType;
  text1?: string;
  text2?: string;
  text3?: string;
  quantity: number;
}

export interface CheckinConfirmationService {
  name: string;
  price: number;  // grosze (e.g. 5000 = 50.00 zł)
}

export interface CheckinConfirmationData {
  bookingNumber?: string;  // e.g. "001/0204"
  customerName: string;
  customerPhone?: string;
  customerNotes?: string;
  services: CheckinConfirmationService[];
  staffName?: string;
  checkinTime: string;  // ISO string
}

// Print job status
export enum PrintJobStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  PRINTING = 'PRINTING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

// Printer configuration for a single printer
export interface PrinterConfig {
  enabled: boolean;
  protocol: PrinterProtocol;
  // For THERMAL/POSNET (COM port)
  port?: string;
  baudRate?: number;
  // For ZEBRA/WINDOWS (Windows printer)
  windowsPrinter?: string;
  labelWidth?: number;   // mm
  labelHeight?: number;  // mm
  // Additional settings
  paperWidth?: number;   // mm (default: 80 for thermal)
  charsPerLine?: number; // Characters per line (default: 48)
  supportsCut?: boolean; // Auto paper cut
  supportsCashDrawer?: boolean; // Cash drawer support
  // Character encoding for ESC/POS text. Default 'utf8'. Test-print auto-falls back to cp1250 → ascii on verify failure.
  charset?: 'utf8' | 'cp1250' | 'ascii';
  // Paper cut behavior. Default 'partial'. Test-print falls back 'partial' → 'full' → 'none'.
  cutMode?: 'partial' | 'full' | 'none';
}

/**
 * Chars-per-line derived from paper width (mm). Single source of truth — used by
 * config defaults, ESC/POS formatter, and Settings UI so they can never diverge.
 */
export function charsPerLineFor(paperWidth: number): number {
  if (paperWidth <= 58) return 32;
  if (paperWidth <= 76) return 42;
  return 48; // 80mm standard
}

// One diagnostic step in the Test Print flow.
export type TestPrintStepName =
  | 'config'        // Validate config shape
  | 'connect'       // Open port / verify printer exists
  | 'identify'      // Read model + firmware
  | 'build'         // Build the test page bytes
  | 'send'          // Send bytes to printer
  | 'verify';       // Confirm job actually printed / no stuck jobs

export interface TestPrintStep {
  step: TestPrintStepName;
  ok: boolean;
  detail?: string;       // Human-readable explanation for UI
  data?: unknown;        // Raw data (model info, echoed bytes, etc.) — logged, not shown to user
  error?: string;        // Error message if ok=false
  durationMs?: number;
}

export interface TestPrintResult {
  success: boolean;
  steps: TestPrintStep[];
  modelName?: string;      // Discovered model (identify step)
  firmwareVersion?: string;
  charsetUsed?: 'utf8' | 'cp1250' | 'ascii';
  cutModeUsed?: 'partial' | 'full' | 'none';
  logFilePath?: string;    // Absolute path to log file for "Open log folder"
}

// Dictionary of printers by type
export type PrintersConfig = {
  [key in PrinterType]?: PrinterConfig;
};

export type LiveCustomerDisplayProfile =
  | 'retail_assisted'
  | 'salon_checkin'
  | 'promo_only';

export type ReservedCustomerDisplayProfile =
  | 'retail_self_checkout'
  | 'restaurant_table_display';

export type CustomerDisplayProfile =
  | LiveCustomerDisplayProfile
  | ReservedCustomerDisplayProfile;

// Agent configuration stored locally
export interface AgentConfig {
  agentId?: string;
  salonId?: string;
  salonName?: string;
  machineId?: string;
  // Per-device register code used as a prefix in booking numbers (e.g. "A001/0410")
  // to prevent collisions when multiple print-agents run for the same salon.
  // Auto-derived from machineId on first check-in if unset. User can override in settings.
  registerCode?: string;
  name: string;

  // UI Language
  language?: 'en' | 'vi' | 'tr' | 'zh' | 'uk' | 'ru' | 'pl';

  // API Key authentication (pa_xxx format)
  apiKey?: string;

  // Multi-printer settings - dictionary by PrinterType
  printers?: PrintersConfig;
  multiPrinterMode?: boolean;

  // Legacy multi-printer settings (for backward compatibility)
  receiptPrinter?: PrinterConfig;   // For RECEIPT, INVOICE
  labelPrinter?: PrinterConfig;     // For LABEL, BARCODE

  // Legacy single printer settings (for backward compatibility)
  printerPort?: string;
  printerProtocol: PrinterProtocol;
  printerBaudRate: number;
  zebraPrinter?: string;
  labelWidth?: number;
  labelHeight?: number;

  // Server settings
  serverUrl: string;

  // Status
  isPaired: boolean;
  autoStart: boolean;

  // Encrypted auth token (base64) - legacy, use apiKey instead
  encryptedToken?: string;

  // Telegram Remote Control settings (Moltbot-style)
  telegram?: TelegramConfig;

  // Legacy Telegram settings (for backward compatibility)
  telegramEnabled?: boolean;
  telegramToken?: string;
  encryptedTelegramToken?: string;
  telegramAllowedIds?: number[];
  telegramEnableInput?: boolean;
  telegramEnableBrowser?: boolean;

  // Zira AI settings
  aiEnabled?: boolean;
  aiLocalMode?: boolean;              // Enable local AI with tools (requires API key)
  aiProxyMode?: boolean;              // Use backend proxy (key stays on server)
  aiApiKey?: string;
  encryptedAiApiKey?: string;
  aiModel?: string;                   // Default: 'x-ai/grok-4.1-fast'
  aiMaxTokens?: number;               // Default: 1024
  aiTemperature?: number;             // Default: 0.7
  aiProvider?: AIProvider;            // Default: 'openrouter'
  aiSystemPrompt?: string;            // Custom system prompt

  // Chrome Browser settings (for browser automation)
  chromeProfileDirectory?: string;    // e.g., 'Default', 'Profile 1' - saved after user selection

  // POS settings
  posEnabled?: boolean;                // Enable POS window
  posMode?: 'retail' | 'salon' | 'b2b' | 'restaurant';  // POS mode (default: 'retail')
  // Receipt seller info (Polish paragon compliance)
  receiptSellerName?: string;    // Legal entity name (e.g., "P.T.H. BAKS Sławomir Chądzyński")
  receiptSellerAddress?: string; // Full address (e.g., "ul. Łączności 35, 32-020 Wieliczka")
  receiptSellerNip?: string;     // Tax ID (e.g., "522-005-23-49")
  posLanguage?: 'en' | 'vi' | 'tr' | 'zh' | 'uk' | 'ru' | 'pl' | '';  // POS UI language (defaults to main language)
  customerDisplayLanguage?: 'en' | 'vi' | 'tr' | 'zh' | 'uk' | 'ru' | 'pl' | ''; // Display On UI language (falls back to POS, then main language)
  customerDisplayEnabled?: boolean;    // Enable customer-facing display
  customerDisplayProfile?: CustomerDisplayProfile; // Live: retail_assisted, salon_checkin, promo_only. Reserved values are not selectable.
  customerDisplayMonitor?: number;     // Monitor index for customer display (0 = primary)
  customerDisplayForceKiosk?: boolean; // Force kiosk/fullscreen even on single monitor (default true). Esc + 3-finger swipe-down still exit.
  customerDisplayPromoFolder?: string; // Local folder path for promo images
  customerDisplayPromoInterval?: number; // Carousel interval in ms (default 5000)
  customerDisplayIdleTimeout?: number;   // Idle timeout before promo in ms (default 120000)

  // Salon slug (for warehouse public API) + 4-digit support code (display / UX only)
  salonSlug?: string;
  salonCode?: string;

  // Booksy Sync settings
  booksy?: BooksySyncConfig;

  // Auth (Telegram Login)
  authToken?: string;                  // JWT access token
  authUser?: AuthUser;                 // Cached user info

  // Security Camera AI settings
  security?: SecurityConfig;

  // Feature Entitlements (SuperAdmin controlled)
  entitlements?: SalonEntitlements;    // Cached entitlements from backend
  deleteConfirm?: DeleteConfirmConfig; // Delete confirmation settings

  // SSH Remote Support (auto-enable at login)
  sshTunnelEnabled?: boolean;          // Allow remote SSH support (auto-start tunnel on connect)

  // Unattended Remote Access (Chrome RDP-style PIN)
  remoteAccessEnabled?: boolean;       // Allow remote access without dialog
  remoteAccessPin?: string;            // PIN code (default = salon code) — legacy plain text
  encryptedRemotePin?: string;         // Encrypted PIN via safeStorage

  // UI sidebar state
  sidebarCollapsed?: boolean;

  // User-hidden tabs (locally controlled, independent of entitlements)
  hiddenTabs?: Tab[];

  // Check-in tab display toggles
  checkinShowStatsBar?: boolean;  // Show total/waiting/in-service/completed bar (default: true)
  checkinShowQueue?: boolean;     // Show active queue panel on the right (default: true)
}

// Agent credentials (stored securely)
export interface AgentCredentials {
  machineId: string;
  token: string;
}

// Receipt item
export interface ReceiptItem {
  name: string;
  quantity: number;
  unitPrice: number; // In grosze
  totalPrice: number;
  vatRate: number; // 23, 8, 5, 0
  sku?: string;
  unit?: string; // szt., kg, paczka, usługa
}

// Receipt payment
export interface ReceiptPayment {
  method: string;
  amount: number; // In grosze
}

// Receipt data
export interface ReceiptData {
  orderNumber?: string;
  salonName?: string;
  sellerName?: string;      // Legal entity name (paragon header)
  sellerAddress?: string;   // Business address (paragon header)
  sellerNip?: string;       // Seller NIP (paragon header)
  items: ReceiptItem[];
  payment: ReceiptPayment;
  subtotal: number;
  discount?: number;
  total: number;
  cashierName?: string;
  customerName?: string;
  customerNip?: string;
  isReprint?: boolean;       // Mark as copy/reprint
  originalDate?: string;     // Original transaction date (ISO string)
  isRefund?: boolean;        // Mark as refund receipt
  refundReason?: string;     // Reason for refund
  originalOrderNumber?: string; // Original order number being refunded
  tenders?: ReceiptPayment[]; // Split payment: multiple tenders
}

// Document data for A4 printing
export interface DocumentData {
  title?: string;
  content: string;  // HTML or text content
  templateId?: string;
  copies?: number;
  orientation?: 'portrait' | 'landscape';
}

// Print job from server
export interface PrintJobEvent {
  jobId: string;
  jobType: PrintJobType;
  printerType?: PrinterType;  // NEW: Explicit printer routing from server
  payload: ReceiptData | LabelData | DocumentData | DailyReportData;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

// Device status
export interface DeviceStatus {
  printerConnected: boolean;
  printerPort: string | null;
  scannerActive: boolean;
  appVersion: string;
}

// Connection status
export interface ConnectionStatus {
  connected: boolean;
  lastConnectedAt?: Date;
  error?: string;
}

// Connection response from REST API
export interface ConnectResponse {
  agentId: string;
  salonId: string;
  salonName: string;
  salonSlug?: string;
  salonCode?: string;
  serverUrl: string;
  printerConfig?: {
    port?: string;
    protocol?: PrinterProtocol;
    baudRate?: number;
  };
}

// ==========================================
// Remote Control Types (Chrome Remote Desktop Style)
// ==========================================

// Remote session status
export enum RemoteSessionStatus {
  IDLE = 'IDLE',
  PENDING = 'PENDING',       // Waiting for agent to accept
  CONNECTING = 'CONNECTING', // WebRTC connecting
  CONNECTED = 'CONNECTED',   // Active session
  DISCONNECTED = 'DISCONNECTED',
  FAILED = 'FAILED',
}

// Quality presets for screen capture
export const RemoteQuality = {
  LOW: 'LOW',       // 1280x720 @ 15fps
  MEDIUM: 'MEDIUM', // 1920x1080 @ 24fps
  HIGH: 'HIGH',     // 1920x1080 @ 30fps
} as const;
export type RemoteQuality = typeof RemoteQuality[keyof typeof RemoteQuality];

// Quality settings
export interface QualitySettings {
  width: number;
  height: number;
  frameRate: number;
}

export const QUALITY_PRESETS: Record<RemoteQuality, QualitySettings> = {
  LOW: { width: 1280, height: 720, frameRate: 15 },
  MEDIUM: { width: 1920, height: 1080, frameRate: 24 },
  HIGH: { width: 1920, height: 1080, frameRate: 30 },
};

// Remote session info
export interface RemoteSession {
  sessionId: string;
  userId: string;
  userName?: string;
  salonId: string;
  quality: RemoteQuality;
  status: RemoteSessionStatus;
  startedAt?: Date;
  endedAt?: Date;
}

// Remote session request from dashboard
export interface RemoteSessionRequest {
  sessionId: string;
  userId: string;
  userName?: string;
  salonId: string;
  quality: RemoteQuality;
  passcode?: string;  // PIN for unattended access
}

// Remote session response from agent
export interface RemoteSessionResponse {
  sessionId: string;
  accepted: boolean;
  reason?: string;
}

// Mouse event types
export type RemoteMouseButton = 'left' | 'middle' | 'right';
export type RemoteMouseAction = 'move' | 'down' | 'up' | 'click' | 'dblclick' | 'scroll';

// Remote input event - Mouse
export interface RemoteMouseEvent {
  type: 'mouse';
  action: RemoteMouseAction;
  x: number;          // Normalized 0-1 relative to screen
  y: number;          // Normalized 0-1 relative to screen
  button?: RemoteMouseButton;
  deltaX?: number;    // For scroll
  deltaY?: number;    // For scroll
  timestamp: number;
}

// Remote input event - Keyboard
export interface RemoteKeyboardEvent {
  type: 'keyboard';
  action: 'down' | 'up';
  key: string;        // Key code (e.g., 'a', 'Enter', 'Shift')
  code: string;       // Physical key code (e.g., 'KeyA', 'Enter', 'ShiftLeft')
  modifiers: {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
  };
  timestamp: number;
}

// Union type for all input events
export type RemoteInputEvent = RemoteMouseEvent | RemoteKeyboardEvent;

// WebRTC signaling types
export interface RTCSessionDescriptionInit {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface RTCIceCandidateInit {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}

// ICE server configuration
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// Remote control state for UI
export interface RemoteControlState {
  isBeingControlled: boolean;
  session: RemoteSession | null;
  connectionQuality?: 'poor' | 'fair' | 'good' | 'excellent';
}

// ==========================================
// SSH Tunnel Types (Reverse SSH for remote support)
// ==========================================

export type SshTunnelState = 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting';

export interface SshTunnelRequest {
  requestId: string;
  userId: string;
  userName: string;
  salonId: string;
  reason?: string;
}

export interface SshTunnelResponse {
  requestId: string;
  accepted: boolean;
  reason?: string;
  port?: number;
  publicKey?: string;
}

export interface SshTunnelStatus {
  state: SshTunnelState;
  sshAvailable: boolean;
  sshServerAvailable: boolean;
  keyGenerated: boolean;
  publicKey?: string;
  assignedPort?: number;
  lastError?: string;
  retryCount?: number;
  connectedSince?: string;
  requestedBy?: string;
  username?: string;          // Windows username for SSH login
}

// ==========================================
// Auth Types
// ==========================================

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  salonId: string;
  salonName?: string;
}

export interface TelegramLoginTokenResponse {
  token: string;
  expiresAt: string;
  deepLink: string;
}

export interface TelegramLoginTokenStatus {
  status: 'PENDING' | 'VERIFIED' | 'EXPIRED';
  access_token?: string;
  user?: AuthUser;
  salon?: { id: string; name: string; slug: string };
}

// IPC channels
export const IPC_CHANNELS = {
  // Config
  GET_CONFIG: 'get-config',
  SET_CONFIG: 'set-config',

  // Connection
  CONNECT: 'connect',
  CONNECT_WITH_API_KEY: 'connect-with-api-key',
  DISCONNECT: 'disconnect',
  GET_STATUS: 'get-status',

  // Printer
  LIST_PORTS: 'list-ports',
  LIST_WINDOWS_PRINTERS: 'list-windows-printers',
  TEST_PRINT: 'test-print',
  TEST_PRINTER_BY_TYPE: 'test-printer-by-type',
  TEST_PRINTER_BY_CONFIG: 'test-printer-by-config',
  TEST_PRINT_PROGRESS: 'test-print-progress',  // Main → Renderer: per-step progress stream
  OPEN_LOG_FOLDER: 'open-log-folder',
  CALIBRATE_PRINTER: 'calibrate-printer',
  GET_POSNET_DRIVER_STATUS: 'get-posnet-driver-status',
  INSTALL_POSNET_DRIVER: 'install-posnet-driver',
  SCAN_FOR_DRIVER: 'scan-for-driver',
  AUTO_SETUP_PRINTER: 'auto-setup-printer',
  POSNET_SCAN_DEVICES: 'posnet-scan-devices',
  POSNET_LIST_DEVICES: 'posnet-list-devices',
  POSNET_SELECT_DEVICE: 'posnet-select-device',
  POSNET_RESCAN_KNOWN: 'posnet-rescan-known',
  POSNET_DIAGNOSE_PORT: 'posnet-diagnose-port',
  // Universal printer detection (all brands)
  UNIVERSAL_SCAN_DEVICES: 'universal-scan-devices',
  UNIVERSAL_LIST_DEVICES: 'universal-list-devices',
  UNIVERSAL_RESCAN_KNOWN: 'universal-rescan-known',
  UNIVERSAL_RECOVER_DEVICE: 'universal-recover-device',

  // Events from main to renderer
  CONNECTION_STATUS: 'connection-status',
  DEVICE_STATUS: 'device-status',
  PRINT_JOB: 'print-job',
  BARCODE_SCANNED: 'barcode-scanned',

  // Remote Control
  REMOTE_SESSION_REQUEST: 'remote-session-request',  // Backend → Agent: New session request
  REMOTE_SESSION_RESPONSE: 'remote-session-response', // Agent → Backend: Accept/reject
  REMOTE_SESSION_END: 'remote-session-end',          // Either party: End session
  REMOTE_STATE_CHANGED: 'remote-state-changed',      // Agent → Renderer: State update
  REMOTE_ACCEPT_SESSION: 'remote-accept-session',    // Renderer → Agent: User accepts
  REMOTE_REJECT_SESSION: 'remote-reject-session',    // Renderer → Agent: User rejects
  REMOTE_END_SESSION: 'remote-end-session',          // Renderer → Agent: User ends
  REMOTE_GET_STATE: 'remote-get-state',              // Renderer → Agent: Get current state

  // Telegram Remote Control
  TELEGRAM_GET_STATUS: 'telegram-get-status',        // Renderer → Agent: Get Telegram bot status
  TELEGRAM_RESTART: 'telegram-restart',              // Renderer → Agent: Restart Telegram bot

  // Zira AI
  AI_GET_STATUS: 'ai-get-status',                    // Renderer → Agent: Get AI status
  AI_CHAT: 'ai-chat',                                // Renderer → Agent: Send chat message
  AI_CLEAR_HISTORY: 'ai-clear-history',              // Renderer → Agent: Clear conversation history

  // Auth (Telegram Login)
  AUTH_TELEGRAM_LOGIN_TOKEN: 'auth-telegram-login-token',   // Generate Telegram login QR token
  AUTH_CHECK_TOKEN: 'auth-check-token',                      // Poll token status
  AUTH_REGISTER_TOKEN: 'auth-telegram-register-token',       // Generate register token
  AUTH_GET_USER: 'auth-get-user',                            // Get current user (verify token)
  AUTH_LOGOUT: 'auth-logout',                                // Logout (clear token)
  AUTH_LOGIN_EMAIL: 'auth-login-email',                      // Login with email/password
  AUTH_CHANGE_SALON: 'auth-change-salon',                    // Disconnect + clear credentials for salon switch
  AUTH_SET_AI_API_KEY: 'auth-set-ai-api-key',                // Store AI API key via safeStorage
  AUTH_SET_REMOTE_PIN: 'auth-set-remote-pin',                // Store remote access PIN via safeStorage
  AUTH_GET_REMOTE_PIN: 'auth-get-remote-pin',                // Retrieve decrypted remote access PIN

  // Booksy Sync
  BOOKSY_GET_STATUS: 'booksy:get-status',
  BOOKSY_GET_CONFIG: 'booksy:get-config',
  BOOKSY_SET_CONFIG: 'booksy:set-config',
  BOOKSY_SYNC_NOW: 'booksy:sync-now',
  BOOKSY_START: 'booksy:start',
  BOOKSY_STOP: 'booksy:stop',
  BOOKSY_GET_BOOKINGS: 'booksy:get-bookings',
  BOOKSY_SYNC_CUSTOMERS: 'booksy:sync-customers',
  BOOKSY_GET_CUSTOMERS: 'booksy:get-customers',
  BOOKSY_SYNC_STAFF: 'booksy:sync-staff',
  BOOKSY_GET_STAFF: 'booksy:get-staff',
  BOOKSY_SYNC_RESOURCES: 'booksy:sync-resources',
  BOOKSY_GET_RESOURCES: 'booksy:get-resources',
  BOOKSY_SYNC_ALL: 'booksy:sync-all',
  BOOKSY_SYNC_SERVICES: 'booksy:sync-services',
  BOOKSY_GET_SERVICES: 'booksy:get-services',
  BOOKSY_SYNC_ADDONS: 'booksy:sync-addons',
  BOOKSY_GET_ADDONS: 'booksy:get-addons',
  BOOKSY_STATUS_CHANGED: 'booksy:status-changed',

  // POS - Core
  POS_GET_STATE: 'pos:get-state',
  POS_DISPATCH: 'pos:dispatch',
  POS_STATE_CHANGED: 'pos:state-changed',

  // POS - Products
  POS_PRODUCTS_GET_ALL: 'pos:products:getAll',
  POS_PRODUCTS_GET_BY_CATEGORY: 'pos:products:getByCategory',
  POS_PRODUCTS_SEARCH: 'pos:products:search',
  POS_PRODUCTS_GET_BY_BARCODE: 'pos:products:getByBarcode',

  // POS - Categories
  POS_CATEGORIES_GET_ALL: 'pos:categories:getAll',

  // POS - Orders
  POS_ORDERS_CREATE: 'pos:orders:create',
  POS_ORDERS_GET_DAILY_STATS: 'pos:orders:getDailyStats',

  // POS - Payment
  POS_PRINT_RECEIPT: 'pos:print-receipt',
  POS_OPEN_CASH_DRAWER: 'pos:open-cash-drawer',
  POS_PAYMENT_CARD: 'pos:payment:card',
  POS_ELAVON_STATUS: 'pos:elavon-status',

  // POS - Shift
  POS_SHIFT_OPEN: 'pos:shift:open',
  POS_SHIFT_CLOSE: 'pos:shift:close',

  // POS - Sync
  POS_SYNC_PRODUCTS: 'pos:sync:products',
  POS_SYNC_ORDERS: 'pos:sync:orders',
  POS_PRODUCTS_SYNCED: 'pos:products-synced',
  POS_CATALOG_UPDATED: 'pos:catalog-updated',
  POS_STOCK_UPDATED: 'pos:stock-updated',
  POS_ORDER_SYNCED: 'pos:order-synced',

  // POS - Tables
  POS_TABLES_GET_ALL: 'pos:tables:getAll',
  POS_TABLES_GET_ACTIVE: 'pos:tables:getActive',
  POS_TABLES_UPDATE_STATUS: 'pos:tables:updateStatus',
  POS_TABLES_CLEAR: 'pos:tables:clearTable',
  POS_TABLES_SET_COVERS: 'pos:tables:setCovers',

  // POS - Customers
  POS_CUSTOMERS_GET_ALL: 'pos:customers:getAll',
  POS_CUSTOMERS_SEARCH: 'pos:customers:search',
  POS_CUSTOMERS_GET_BY_ID: 'pos:customers:getById',
  POS_CUSTOMERS_INCREASE_DEBT: 'pos:customers:increaseDebt',

  // POS - Staff
  POS_STAFF_GET_ALL: 'pos:staff:getAll',

  // POS - Hold Orders
  POS_HOLD_CREATE: 'pos:hold:create',
  POS_HOLD_LIST: 'pos:hold:list',
  POS_HOLD_GET: 'pos:hold:get',
  POS_HOLD_REMOVE: 'pos:hold:remove',

  // POS - Quick Keys
  POS_QUICKKEYS_LIST: 'pos:quickkeys:list',
  POS_QUICKKEYS_GET: 'pos:quickkeys:get',
  POS_QUICKKEYS_CREATE: 'pos:quickkeys:create',
  POS_QUICKKEYS_UPDATE: 'pos:quickkeys:update',
  POS_QUICKKEYS_REMOVE: 'pos:quickkeys:remove',
  POS_QUICKKEYS_ASSIGN: 'pos:quickkeys:assign',
  POS_QUICKKEYS_GET_ASSIGNED: 'pos:quickkeys:getAssigned',

  // POS - Events
  POS_CUSTOMER_DISPLAY_STATUS: 'customer-display:status',
  POS_CUSTOMER_REQUEST: 'pos:customer-request',
  POS_CUSTOMER_CHECKIN: 'pos:customer-checkin',
  POS_DB_SAVE_ERROR: 'db:save-error',

  // Window management
  WINDOW_OPEN: 'window:open',
  WINDOW_CLOSE: 'window:close',
  WINDOW_LIST: 'window:list',
  WINDOW_SET_FULLSCREEN: 'window:setFullScreen',
  WINDOW_SET_KIOSK: 'window:setKiosk',

  // Display (Customer Display)
  DISPLAY_LIST: 'display:list',
  DISPLAY_TOUCH: 'display:touch',
  DISPLAY_REQUEST_SERVICE: 'display:request-service',
  DISPLAY_GET_BOOKINGS: 'display:get-bookings',
  DISPLAY_CHECK_IN: 'display:check-in',
  DISPLAY_BROWSE_SERVICES: 'display:browse-services',
  DISPLAY_BACK_TO_CHECKIN: 'display:back-to-checkin',
  DISPLAY_BACK_TO_IDLE: 'display:back-to-idle',
  DISPLAY_INTERACTION_PING: 'display:interaction-ping',
  DISPLAY_PING: 'display:ping',
  DISPLAY_PONG: 'display:pong',

  // Debug
  DEBUG_OPEN_DEVTOOLS: 'debug:open-devtools',
  DEBUG_OPEN_LOGS: 'debug:open-logs',
  DEBUG_GET_DIAGNOSTICS: 'debug:get-diagnostics',

  // App
  APP_SET_AUTO_START: 'app:set-auto-start',
  APP_GET_AUTO_START: 'app:get-auto-start',

  // Keyboard Input (Scanner)
  KEYBOARD_INPUT: 'keyboard-input',

  // Dialog
  DIALOG_SELECT_FOLDER: 'dialog:selectFolder',

  // Shell
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',
  SHELL_LAUNCH_CHROME_DEBUG: 'shell:launchChromeDebug',

  // Chrome Checker
  CHROME_IS_RUNNING: 'chrome:isRunning',
  CHROME_CHECK_AND_PROMPT: 'chrome:checkAndPrompt',
  CHROME_FORCE_CLOSE: 'chrome:forceClose',

  // Invoicing
  INVOICE_LIST: 'invoice:list',
  INVOICE_GET: 'invoice:get',
  INVOICE_CREATE: 'invoice:create',
  INVOICE_UPDATE: 'invoice:update',
  INVOICE_DELETE: 'invoice:delete',
  INVOICE_ISSUE: 'invoice:issue',
  INVOICE_CANCEL: 'invoice:cancel',
  INVOICE_DUPLICATE: 'invoice:duplicate',
  INVOICE_PRINT: 'invoice:print',
  INVOICE_PRINT_A4: 'invoice:print-a4',
  INVOICE_MARK_PAID: 'invoice:mark-paid',
  INVOICE_ADD_PAYMENT: 'invoice:add-payment',
  INVOICE_GET_NEXT_NUMBER: 'invoice:get-next-number',
  INVOICE_CREATE_CORRECTION: 'invoice:create-correction',
  INVOICE_CONVERT_PROFORMA: 'invoice:convert-proforma',

  // Invoice Customers
  INVOICE_CUSTOMER_LIST: 'invoice:customer:list',
  INVOICE_CUSTOMER_SEARCH: 'invoice:customer:search',
  INVOICE_CUSTOMER_GET: 'invoice:customer:get',
  INVOICE_CUSTOMER_CREATE: 'invoice:customer:create',
  INVOICE_CUSTOMER_UPDATE: 'invoice:customer:update',
  INVOICE_CUSTOMER_DELETE: 'invoice:customer:delete',

  // Invoice Products (Accounting Products)
  INVOICE_PRODUCT_LIST: 'invoice:product:list',
  INVOICE_PRODUCT_SEARCH: 'invoice:product:search',
  INVOICE_PRODUCT_GET: 'invoice:product:get',
  INVOICE_PRODUCT_CREATE: 'invoice:product:create',
  INVOICE_PRODUCT_UPDATE: 'invoice:product:update',
  INVOICE_PRODUCT_DELETE: 'invoice:product:delete',

  // Invoice Settings
  INVOICE_SELLER_GET: 'invoice:seller:get',
  INVOICE_SELLER_UPDATE: 'invoice:seller:update',
  INVOICE_VAT_RATES_GET: 'invoice:vat-rates:get',

  // NIP/VAT Lookup
  INVOICE_LOOKUP_NIP: 'invoice:lookup:nip',
  INVOICE_LOOKUP_EU_VAT: 'invoice:lookup:eu-vat',
  INVOICE_LOOKUP_AUTO: 'invoice:lookup:auto',

  // KSeF
  KSEF_SEND: 'ksef:send',
  KSEF_SEND_BATCH: 'ksef:send-batch',
  KSEF_GET_STATUS: 'ksef:get-status',
  KSEF_RETRY: 'ksef:retry',

  // Feature Entitlements
  ENTITLEMENTS_FETCH: 'entitlements:fetch',
  ENTITLEMENTS_GET: 'entitlements:get',
  ENTITLEMENTS_IS_ENABLED: 'entitlements:is-enabled',
  ENTITLEMENTS_CHANGED: 'entitlements:changed',

  // Delete Confirmation
  DELETE_CONFIRM_GET_CONFIG: 'delete-confirm:get-config',
  DELETE_CONFIRM_VERIFY: 'delete-confirm:verify',

  // SSH Tunnel
  SSH_TUNNEL_GET_STATUS: 'ssh-tunnel:get-status',
  SSH_TUNNEL_DISCONNECT: 'ssh-tunnel:disconnect',
  SSH_TUNNEL_GENERATE_KEY: 'ssh-tunnel:generate-key',
  SSH_TUNNEL_START: 'ssh-tunnel:start',
  SSH_TUNNEL_STATUS_CHANGED: 'ssh-tunnel:status-changed',

  // Security Camera
  SECURITY_GET_STATUS: 'security:get-status',
  SECURITY_GET_CONFIG: 'security:get-config',
  SECURITY_SET_CONFIG: 'security:set-config',
  SECURITY_START: 'security:start',
  SECURITY_STOP: 'security:stop',
  SECURITY_RESTART_CAMERA: 'security:restart-camera',
  SECURITY_GET_ALERTS: 'security:get-alerts',
  SECURITY_CLEAR_ALERTS: 'security:clear-alerts',
  SECURITY_GET_ANALYTICS: 'security:get-analytics',
  SECURITY_STATUS_CHANGED: 'security:status-changed',
  SECURITY_ALERT: 'security:alert',

  // Auto-Update
  CHECK_FOR_UPDATES: 'update:check',
  INSTALL_UPDATE: 'update:install',
  UPDATE_STATUS: 'update:status',

  // Checkin
  CHECKIN_GET_TODAY: 'checkin:getToday',
  CHECKIN_GET_BY_DATE: 'checkin:getByDate',
  CHECKIN_CREATE: 'checkin:create',
  CHECKIN_UPDATE_STATUS: 'checkin:updateStatus',
  CHECKIN_START_SERVICE: 'checkin:startService',
  CHECKIN_COMPLETE: 'checkin:complete',
  CHECKIN_MARK_NO_SHOW: 'checkin:markNoShow',
  CHECKIN_SEARCH_PHONE: 'checkin:searchPhone',
  CHECKIN_ADD_UPSELLS: 'checkin:addUpsells',
  CHECKIN_UPDATE_NOTES: 'checkin:updateNotes',
  CHECKIN_GET_STATS: 'checkin:getStats',
  CHECKIN_CREATE_WITH_CUSTOMER: 'checkin:createWithCustomer',
  CHECKIN_PRINT_CONFIRMATION: 'checkin:printConfirmation',

  // Salon Customers (check-in wizard)
  SALON_CUSTOMER_SEARCH: 'salonCustomer:search',
  SALON_CUSTOMER_GET_BY_PHONE: 'salonCustomer:getByPhone',
  SALON_CUSTOMER_CREATE: 'salonCustomer:create',
  SALON_CUSTOMER_UPDATE: 'salonCustomer:update',
  SALON_CUSTOMER_GET_HISTORY: 'salonCustomer:getHistory',
  SALON_CUSTOMER_GET_RECOMMENDATIONS: 'salonCustomer:getRecommendations',

  // Service Popularity
  SERVICE_POPULARITY_GET: 'servicePopularity:get',
  SERVICE_POPULARITY_REFRESH: 'servicePopularity:refresh',
  DISPLAY_SEARCH_BY_PHONE: 'display:search-by-phone',

  // Billiard Local Sync
  BILLIARD_GET_OVERVIEW: 'billiard:get:overview',
  BILLIARD_GET_SESSION: 'billiard:get:session',
  BILLIARD_GET_COMBOS: 'billiard:get:combos',
  BILLIARD_GET_FLOOR_PLANS: 'billiard:get:floor-plans',
  BILLIARD_GET_FNB_PRODUCTS: 'billiard:get:fnb-products',
  BILLIARD_GET_FNB_CATEGORIES: 'billiard:get:fnb-categories',
  BILLIARD_GET_RESOURCE_TYPE: 'billiard:get:resource-type',
  BILLIARD_GET_RESTAURANT_COMBOS: 'billiard:get:restaurant-combos',
  BILLIARD_MUTATE: 'billiard:mutate',
  BILLIARD_SYNC_STATUS: 'billiard:sync:status',
  BILLIARD_DATA_UPDATED: 'billiard:data-updated',
  BILLIARD_PRINT_RECEIPT: 'billiard:print:receipt',
  BILLIARD_PRINT_OPEN_DRAWER: 'billiard:print:open-drawer',

  // Generic API proxy
  API_CALL: 'api:call',
} as const;

// ==========================================
// Telegram Types (Moltbot-style)
// ==========================================

// DM access policy (like moltbot)
export type TelegramDMPolicy = 'pairing' | 'allowlist' | 'open' | 'disabled';

// Group access policy
export type TelegramGroupPolicy = 'open' | 'allowlist' | 'disabled';

// Stream mode for responses
export type TelegramStreamMode = 'off' | 'partial' | 'block';

// Reply-to mode
export type TelegramReplyToMode = 'off' | 'first' | 'all';

// Reaction notification level
export type TelegramReactionNotifications = 'off' | 'own' | 'all';
export type TelegramReactionLevel = 'off' | 'ack' | 'minimal' | 'extensive';

// Per-group configuration
export interface TelegramGroupConfig {
  requireMention?: boolean;       // Require @botname mention
  historyLimit?: number;          // Override history limit for this group
  systemPrompt?: string;          // Custom system prompt for group
  allowedUserIds?: number[];      // Override allowed users for group
  aiEnabled?: boolean;            // Enable/disable AI for group
  topics?: Record<string, TelegramTopicConfig>;  // Forum topic configs
}

// Per-topic configuration (for forum groups)
export interface TelegramTopicConfig {
  requireMention?: boolean;
  historyLimit?: number;
  systemPrompt?: string;
  aiEnabled?: boolean;
}

// Per-DM configuration
export interface TelegramDMConfig {
  historyLimit?: number;
  systemPrompt?: string;
  aiEnabled?: boolean;
}

// Draft chunk settings for streaming
export interface TelegramDraftChunk {
  minChars?: number;           // Min chars before emit (default: 200)
  maxChars?: number;           // Max chars per chunk (default: 800)
  breakPreference?: 'paragraph' | 'sentence' | 'word';
}

// Full Telegram configuration (moltbot-style)
export interface TelegramConfig {
  enabled: boolean;
  botToken?: string;                    // Plain text (UI input)
  encryptedBotToken?: string;           // Encrypted with safeStorage

  // Access control
  dmPolicy: TelegramDMPolicy;           // Default: 'allowlist'
  groupPolicy: TelegramGroupPolicy;     // Default: 'disabled'
  allowFrom: (number | string)[];       // User IDs or @usernames for DMs
  groupAllowFrom: (number | string)[];  // User IDs for groups

  // Per-group/DM configs
  groups: Record<string, TelegramGroupConfig>;  // chatId → config
  dms: Record<string, TelegramDMConfig>;        // userId → config

  // Reply behavior
  replyToMode: TelegramReplyToMode;     // Default: 'first'

  // Streaming
  streamMode: TelegramStreamMode;       // Default: 'off'
  draftChunk?: TelegramDraftChunk;

  // Limits
  mediaMaxMb: number;                   // Default: 5
  historyLimit: number;                 // Default: 50
  dmHistoryLimit?: number;              // Override for DMs

  // Reactions
  reactionNotifications: TelegramReactionNotifications;
  reactionLevel: TelegramReactionLevel;

  // Input/Browser control
  enableInput: boolean;                 // Default: false
  enableBrowser: boolean;               // Default: false

  // Debouncing
  debounceMs?: number;                  // Default: 500

  // Custom commands
  customCommands?: Array<{ command: string; description: string }>;
}

// History entry (per message)
export interface TelegramHistoryEntry {
  sender: string;           // Username or 'bot' or 'system'
  body: string;             // Message text
  timestamp: number;        // Unix ms
  messageId?: string;       // Telegram message ID
  replyToId?: string;       // If replying to another message
  mediaType?: string;       // 'photo', 'video', 'voice', 'document', 'sticker'
  mediaPath?: string;       // Local path to downloaded media
}

// Message context for AI
export interface TelegramMessageContext {
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  chatTitle?: string;
  threadId?: number;        // Forum topic ID
  senderId: number;
  senderUsername?: string;
  senderFirstName?: string;
  senderLastName?: string;
  messageId: number;
  messageText: string;
  replyToMessage?: {
    messageId: number;
    text: string;
    senderId: number;
    senderUsername?: string;
  };
  isMention: boolean;       // @bot mentioned in group
  isForwarded: boolean;
  mediaType?: string;
  mediaPath?: string;
  timestamp: number;
}

// Sticker cache entry
export interface TelegramStickerCache {
  fileId: string;
  fileUniqueId: string;
  emoji?: string;
  setName?: string;
  description?: string;     // Vision-generated description
  cachedAt: string;         // ISO date
}

// Pairing request (for dmPolicy: 'pairing')
export interface TelegramPairingRequest {
  code: string;             // 6-digit code
  userId: number;
  username?: string;
  firstName?: string;
  requestedAt: number;      // Unix ms
  expiresAt: number;        // Unix ms
}

// Telegram bot status for UI
export interface TelegramBotStatus {
  enabled: boolean;
  running: boolean;
  botUsername?: string;
  lastError?: string;
  hasToken?: boolean;
  // Extended status
  dmPolicy?: TelegramDMPolicy;
  groupPolicy?: TelegramGroupPolicy;
  connectedGroups?: number;
  activeSessions?: number;
  pendingPairings?: number;
}

// ==========================================
// System Prompt Types
// ==========================================

// Prompt mode (like moltbot)
export type PromptMode = 'full' | 'minimal' | 'none';

// System prompt section
export interface SystemPromptSection {
  name: string;
  content: string;
  priority: number;         // Lower = higher priority
  enabled: boolean;
}

// System prompt options
export interface SystemPromptOptions {
  mode: PromptMode;
  agentName?: string;
  userName?: string;
  timezone?: string;
  locale?: string;
  customInstructions?: string;
  skills?: string[];
  workspaceNotes?: string;
  includeDatetime?: boolean;
  includeMemory?: boolean;
  includeMessaging?: boolean;
}

// ==========================================
// AI Provider Types
// ==========================================

// Supported AI providers
export type AIProvider = 'openrouter' | 'openai' | 'anthropic' | 'google' | 'local';

// AI model info
export interface AIModelInfo {
  id: string;
  name: string;
  provider: AIProvider;
  supportsVision: boolean;
  supportsStreaming: boolean;
  contextWindow: number;
  maxOutput?: number;
}

// AI chat message (enhanced)
export interface AIChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  name?: string;            // For multi-user context
  timestamp?: number;
  mediaUrl?: string;        // For vision
  mediaType?: string;
}

// ==========================================
// Booksy Sync Types
// ==========================================

export type BooksyPushResult = {
  ok: boolean;
  status?: number;
  reason?: 'not-configured' | 'network-error' | 'timeout' | 'non-2xx' | 'jwt-expired';
  body?: any;
  errors?: Array<{ external_id: string | number; reason?: string; error?: string }>;
  error?: string;
};

export interface BooksySyncConfig {
  enabled: boolean;
  businessId: string;
  cdpPort: number;                    // Chrome DevTools Protocol port (default: 9222)
  enailApiUrl: string;                // eNail production API URL
  enailJwt: string;                   // JWT token for eNail API
  encryptedEnailJwt?: string;         // Encrypted JWT
  telegramBotToken?: string;          // For session-expired alerts
  telegramChatId?: string;            // Chat ID for alerts
  syncIntervalMin: number;            // Sync interval in minutes (default: 30)
  workStartHour: number;              // Business hours start (default: 7)
  workStartMin: number;               // Business hours start minutes (default: 30)
  workEndHour: number;                // Business hours end (default: 18)
  workEndMin: number;                 // Business hours end minutes (default: 30)
  workDays: number[];                 // Days of week (1=Mon, 6=Sat) default: [1,2,3,4,5,6]
  knownCustomerIds?: number[];
}

export interface BooksySyncStatus {
  enabled: boolean;
  running: boolean;
  hasToken: boolean;
  sessionExpired: boolean;
  lastSyncTime: string | null;
  lastSyncReport: BooksySyncReport | null;
  isBusinessHours: boolean;
  nextSyncIn: number | null;          // minutes until next sync
  chromeConnected: boolean;
  customerCount: number;
  lastCustomerSyncReport: BooksyCustomerSyncReport | null;
  staffCount: number;
  lastStaffSyncReport: BooksyStaffSyncReport | null;
  resourceCount: number;
  lastResourceSyncReport: BooksyResourceSyncReport | null;
  serviceCount: number;
  lastServiceSyncReport: BooksyServiceSyncReport | null;
  addonCount: number;
  lastAddonSyncReport: BooksyAddonSyncReport | null;
}

export interface BooksySyncReport {
  date: string;
  bookings: number;
  pushed: boolean;
  time: string;
  error?: string;
}

export interface BooksyBookingSummary {
  id: number;
  customerName: string;
  serviceName: string;
  staffName: string;
  from: string;
  till: string;
  status: string;
}

export interface BooksyCustomer {
  id: number;
  first_name: string;
  last_name: string;
  full_name: string;
  cell_phone: string;
  email: string;
  photo_url: string | null;
  blacklisted: boolean;
  visit_frequency: number;
  no_shows: number;
  discount: number;
  birthday: string | null;
  city: string | null;
  marketing_agreement: boolean;
  created: string;
}

export interface BooksyStaff {
  id: number;
  name: string;
  type: 'S' | 'R';
  description: string;
  photo_url: string | null;
  is_current_user: boolean;
  visible_on_calendar: boolean;
  working_hours: Record<string, { hour_from: string; hour_till: string }[]>;
}

export interface BooksyStaffSyncReport {
  time: string;
  totalFetched: number;
  pushed: boolean;
  error?: string;
}

export interface BooksyEquipment {
  id: number;
  name: string;
  type: 'R';
  description: string;
}

export interface BooksyResourceSyncReport {
  time: string;
  totalFetched: number;
  pushed: boolean;
  error?: string;
}

export interface BooksyServiceCategory {
  id: number;
  name: string;
  services: BooksyServiceItem[];
}

export interface BooksyServiceItem {
  id: number;
  name: string;
  description?: string;
  price?: number | null;
  price_text?: string;
  photo_url?: string | null;
  variants?: BooksyServiceVariant[];
}

export interface BooksyServiceVariant {
  duration?: number;
  price?: number | null;
  price_text?: string;
  label?: string;
}

export interface BooksyAddon {
  id: number;
  name: string;
  description?: string;
  price?: number | null;
  price_text?: string;
  duration?: number;
}

export interface BooksyServiceSyncReport {
  time: string;
  categoriesFetched: number;
  servicesFetched: number;
  pushed: boolean;
  error?: string;
}

export interface BooksyAddonSyncReport {
  time: string;
  totalFetched: number;
  pushed: boolean;
  error?: string;
}

export interface BooksySyncAllReport {
  staff: BooksyStaffSyncReport;
  customers: BooksyCustomerSyncReport;
  resources: BooksyResourceSyncReport;
  services: BooksyServiceSyncReport;
  addons: BooksyAddonSyncReport;
}

export interface BooksyCustomerSyncReport {
  time: string;
  totalFetched: number;
  newCustomers: number;
  pushed: boolean;
  error?: string;
}

// ==========================================
// Zira AI Types (Enhanced)
// ==========================================

// Zira AI status for UI
export interface ZiraAIStatus {
  enabled: boolean;
  ready: boolean;
  model?: string;
  provider?: AIProvider;
  hasApiKey?: boolean;
  lastError?: string;
  conversationCount?: number;
  totalTokensUsed?: number;
  localMode?: boolean;     // Local AI with tools enabled
  toolsEnabled?: boolean;  // Tools (Booksy, mouse, keyboard) available
  keySource?: 'server' | 'local' | 'proxy' | 'hybrid'; // Where the API key comes from
}

// Zira AI chat response
export interface ZiraAIChatResponse {
  content: string;
  model?: string;
  provider?: AIProvider;
  toolExecuted?: boolean;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'error';
}

// ==========================================
// Invoicing Types
// ==========================================

// Invoice type enum
export const InvoiceType = {
  RECEIPT: 'RECEIPT',           // Paragon
  VAT: 'VAT',                   // Faktura VAT
  PROFORMA: 'PROFORMA',         // Proforma
  CORRECTION: 'CORRECTION',     // Faktura korygująca
  ADVANCE: 'ADVANCE',           // Faktura zaliczkowa
} as const;
export type InvoiceType = typeof InvoiceType[keyof typeof InvoiceType];

// Invoice status enum
export const InvoiceStatus = {
  DRAFT: 'DRAFT',
  ISSUED: 'ISSUED',
  SENT: 'SENT',
  PAID: 'PAID',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  OVERDUE: 'OVERDUE',
  CANCELLED: 'CANCELLED',
} as const;
export type InvoiceStatus = typeof InvoiceStatus[keyof typeof InvoiceStatus];

// Payment method for invoices
export const InvoicePaymentMethod = {
  CASH: 'CASH',
  CARD: 'CARD',
  BANK_TRANSFER: 'BANK_TRANSFER',
  BLIK: 'BLIK',
  P24: 'P24',
} as const;
export type InvoicePaymentMethod = typeof InvoicePaymentMethod[keyof typeof InvoicePaymentMethod];

// Payment status
export const InvoicePaymentStatus = {
  UNPAID: 'UNPAID',
  PARTIAL: 'PARTIAL',
  PAID: 'PAID',
} as const;
export type InvoicePaymentStatus = typeof InvoicePaymentStatus[keyof typeof InvoicePaymentStatus];

// KSeF environment
export const KsefEnvironment = {
  TEST: 'TEST',
  PRODUCTION: 'PRODUCTION',
} as const;
export type KsefEnvironment = typeof KsefEnvironment[keyof typeof KsefEnvironment];

// KSeF invoice status
export const KsefStatus = {
  PENDING: 'PENDING',     // Chờ gửi
  SENDING: 'SENDING',     // Đang gửi
  SENT: 'SENT',           // Đã gửi, chờ xác nhận
  ACCEPTED: 'ACCEPTED',   // KSeF chấp nhận
  REJECTED: 'REJECTED',   // KSeF từ chối
  ERROR: 'ERROR',         // Lỗi khi gửi
} as const;
export type KsefStatus = typeof KsefStatus[keyof typeof KsefStatus];

// Seller settings for invoices
export interface SellerSettingsRow {
  id: string;
  company_name: string;
  nip: string;
  regon: string | null;
  street: string;
  city: string;
  postal_code: string;
  country: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  bank_account: string | null;
  bank_name: string | null;
  swift_code: string | null;
  is_vat_registered: number;
  logo_path: string | null;
  invoice_footer: string | null;
  default_payment_term_days: number;
  default_invoice_notes: string | null;
  updated_at: string;
  // KSeF fields
  ksef_enabled: number;
  ksef_auto_send: number;
  ksef_environment: KsefEnvironment | null;
  ksef_auth_token: string | null;
  ksef_last_sync_at: string | null;
  ksef_last_error: string | null;
}

// Invoice customer
export interface InvoiceCustomerRow {
  id: string;
  name: string;
  short_name: string | null;
  is_company: number;
  nip: string | null;
  regon: string | null;
  street: string | null;
  city: string | null;
  postal_code: string | null;
  country: string;
  email: string | null;
  phone: string | null;
  contact_person: string | null;
  payment_term_days: number;
  default_payment_method: string;
  bank_account: string | null;
  bank_name: string | null;
  gus_verified: number;
  gus_verified_at: string | null;
  notes: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

// Invoice main row
export interface InvoiceRow {
  id: string;
  invoice_number: string;
  type: InvoiceType;
  status: InvoiceStatus;
  // Dates
  issue_date: string;
  sale_date: string;
  due_date: string | null;
  paid_at: string | null;
  sent_at: string | null;
  cancelled_at: string | null;
  // Seller snapshot
  seller_name: string;
  seller_nip: string;
  seller_regon: string | null;
  seller_address: string;
  seller_bank_account: string | null;
  seller_bank_name: string | null;
  // Customer
  customer_id: string | null;
  customer_name: string;
  customer_nip: string | null;
  customer_regon: string | null;
  customer_address: string | null;
  customer_country: string;
  // Amounts (in grosze)
  total_net: number;
  total_vat: number;
  total_gross: number;
  currency: string;
  exchange_rate: number | null;
  // VAT summary (JSON)
  vat_summary: string | null;
  // Payment
  payment_method: InvoicePaymentMethod;
  payment_status: InvoicePaymentStatus;
  paid_amount: number;
  // Polish compliance
  split_payment_marker: number;
  is_reverse_charge: number;
  reverse_charge_reason: string | null;
  is_margin_scheme: number;
  margin_buying_price: number | null;
  jpk_vat_marker: string | null;
  // Correction
  corrected_invoice_id: string | null;
  correction_reason: string | null;
  correction_data: string | null;
  // Advance
  advance_invoice_id: string | null;
  final_invoice_id: string | null;
  // Proforma
  valid_until: string | null;
  converted_invoice_id: string | null;
  converted_at: string | null;
  // Source
  source_order_type: string | null;
  source_order_id: string | null;
  proforma_id: string | null;
  // Stock
  stock_deducted: number;
  // Communication
  sent_to: string | null;
  viewed_count: number;
  // Notes
  notes: string | null;
  internal_notes: string | null;
  // Print & sync
  printed: number;
  printed_at: string | null;
  pdf_path: string | null;
  synced: number;
  backend_id: string | null;
  // Audit
  cancelled_by: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string;
  // KSeF fields
  ksef_number: string | null;
  ksef_status: KsefStatus | null;
  ksef_sent_at: string | null;
  ksef_error: string | null;
  ksef_retry_count: number;
}

// Invoice item row
export interface InvoiceItemRow {
  id: string;
  invoice_id: string;
  sort_order: number;
  accounting_product_id: string | null;
  name: string;
  sku: string | null;
  unit: string;
  pkwiu_code: string | null;
  gtu_code: string | null;
  cn_code: string | null;
  quantity: number;  // x1000 for decimals
  unit_price_net: number;  // in grosze
  vat_rate: number;  // 23, 8, 5, 0, -1 (ZW)
  discount_percent: number;  // x100
  total_net: number;  // in grosze
  vat_amount: number;  // in grosze
  total_gross: number;  // in grosze
  created_at: string;
}

// Invoice payment record
export interface InvoicePaymentRow {
  id: string;
  invoice_id: string;
  amount: number;  // in grosze
  payment_method: string | null;
  paid_at: string;
  reference_number: string | null;
  notes: string | null;
  created_at: string;
}

// Invoice sequence row
export interface InvoiceSequenceRow {
  id: string;
  type: InvoiceType;
  prefix: string;
  year: number;
  month: number | null;
  last_number: number;
  format: string;
}

// VAT rate
export interface VatRateRow {
  id: string;
  rate: number;
  name: string;
  code: string;
  description: string | null;
  is_default: number;
  is_active: number;
  display_order: number;
}

// Accounting product
export interface AccountingProductRow {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  price_net: number;  // in grosze
  vat_rate: number;
  price_gross: number;  // in grosze
  purchase_price_net: number | null;
  unit: string;
  pkwiu_code: string | null;
  gtu_code: string | null;
  cn_code: string | null;
  barcode: string | null;
  type: 'PRODUCT' | 'SERVICE';
  stock_quantity: number;  // x1000 for decimals
  is_active: number;
  created_at: string;
  updated_at: string;
}

// VAT summary entry (for JSON vat_summary)
export interface VatSummaryEntry {
  rate: number;
  net: number;     // in grosze
  vat: number;     // in grosze
  gross: number;   // in grosze
}

// NIP/VAT lookup result
export interface CompanyLookupResult {
  valid: boolean;
  nip?: string;
  vatId?: string;
  name?: string;
  address?: string;
  street?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  countryCode?: string;
  regon?: string;
  krs?: string;
  statusVat?: string;
  isActiveVat?: boolean;
  error?: string;
}

// Invoice data for printing (enriched)
export interface InvoiceData {
  invoice: InvoiceRow;
  items: InvoiceItemRow[];
  vatSummary: VatSummaryEntry[];
}

// Invoice list filter options
export interface InvoiceListFilter {
  type?: InvoiceType;
  status?: InvoiceStatus;
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

// Invoice create/update DTO
export interface InvoiceCreateDTO {
  type: InvoiceType;
  customer_id?: string;
  customer_name: string;
  customer_nip?: string;
  customer_regon?: string;
  customer_address?: string;
  customer_country?: string;
  issue_date: string;
  sale_date: string;
  due_date?: string;
  payment_method: InvoicePaymentMethod;
  notes?: string;
  internal_notes?: string;
  items: InvoiceItemCreateDTO[];
  // Correction fields
  corrected_invoice_id?: string;
  correction_reason?: string;
  // Proforma fields
  valid_until?: string;
}

export interface InvoiceItemCreateDTO {
  accounting_product_id?: string;
  name: string;
  sku?: string;
  unit?: string;
  pkwiu_code?: string;
  gtu_code?: string;
  quantity: number;  // x1000
  unit_price_net: number;  // grosze
  vat_rate: number;
  discount_percent?: number;  // x100
}

// Customer create DTO
export interface InvoiceCustomerCreateDTO {
  name: string;
  short_name?: string;
  is_company?: boolean;
  nip?: string;
  regon?: string;
  street?: string;
  city?: string;
  postal_code?: string;
  country?: string;
  email?: string;
  phone?: string;
  contact_person?: string;
  payment_term_days?: number;
  default_payment_method?: string;
  bank_account?: string;
  bank_name?: string;
  notes?: string;
}

// Seller settings update DTO
export interface SellerSettingsUpdateDTO {
  company_name: string;
  nip: string;
  regon?: string;
  street: string;
  city: string;
  postal_code: string;
  country?: string;
  email?: string;
  phone?: string;
  website?: string;
  bank_account?: string;
  bank_name?: string;
  swift_code?: string;
  is_vat_registered?: boolean;
  logo_path?: string;
  invoice_footer?: string;
  default_payment_term_days?: number;
  default_invoice_notes?: string;
  // KSeF settings
  ksef_enabled?: boolean;
  ksef_auto_send?: boolean;
  ksef_environment?: KsefEnvironment;
  ksef_auth_token?: string;
}

// Accounting product create DTO
export interface AccountingProductCreateDTO {
  sku?: string;
  name: string;
  description?: string;
  price_net: number;
  vat_rate: number;
  purchase_price_net?: number;
  unit?: string;
  pkwiu_code?: string;
  gtu_code?: string;
  cn_code?: string;
  barcode?: string;
  type?: 'PRODUCT' | 'SERVICE';
}

// Invoice print options
export interface InvoicePrintOptions {
  format: 'thermal' | 'a4';
  copies?: number;
  openCashDrawer?: boolean;
}

// ==========================================
// Feature Entitlements Types (SuperAdmin Control)
// ==========================================

// Feature keys that can be controlled by SuperAdmin
export type FeatureKey =
  | 'chat'        // Zira AI Chat tab
  | 'status'      // Status tab (thường luôn bật)
  | 'booksy'      // Booksy Sync tab
  | 'invoicing'   // Invoicing tab
  | 'settings'    // Settings tab (thường luôn bật)
  | 'debug'       // Debug tab
  | 'pos'         // POS window
  | 'remote'      // Remote control
  | 'telegram'    // Telegram bot
  | 'security'    // Security camera AI
  | 'checkin'     // Check-in management
  | 'billiard';   // Billiard floor plan

/** Tabs available in the main window sidebar */
export type Tab = 'pos' | 'billiard' | 'chat' | 'status' | 'booksy' | 'checkin' | 'invoicing' | 'security' | 'settings' | 'debug';

/** Sidebar width constants (px) */
export const SIDEBAR_WIDTH = { expanded: 180, collapsed: 48 } as const;

// Feature entitlement entry
export interface FeatureEntitlement {
  featureKey: FeatureKey;
  enabled: boolean;
  expiresAt?: string;  // ISO date, null = unlimited
  trialEndsAt?: string; // ISO date for trial period
}

// Salon entitlements (fetched from backend)
export interface SalonEntitlements {
  salonId: string;
  salonCode: string;
  salonName: string;
  plan: 'free' | 'basic' | 'pro' | 'enterprise';
  features: Record<FeatureKey, FeatureEntitlement>;
  fetchedAt: string;  // ISO date
  validUntil: string; // ISO date, cache validity
}

// Default entitlements for when offline or not fetched yet
export const DEFAULT_ENTITLEMENTS: Record<FeatureKey, boolean> = {
  chat: false,
  status: true,      // Always enabled
  booksy: false,
  invoicing: true,   // Free feature
  settings: true,    // Always enabled
  debug: false,
  pos: false,
  remote: false,
  telegram: false,
  security: false,
  checkin: true,
  billiard: true,
};

// ==========================================
// Security Camera Types
// ==========================================

export type CameraZone = 'outside' | 'inside';
export type OutsideAlgorithm = 'loitering' | 'recording';
export type InsideAlgorithm = 'theft' | 'fire' | 'analytics_flow' | 'analytics_staff';
export type CameraAlgorithm = OutsideAlgorithm | InsideAlgorithm;
export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface CameraConfig {
  id: string;
  name: string;
  zone: CameraZone;
  enabled: boolean;
  rtspSubstream: string;
  rtspMainstream?: string;
  aiEnabled: boolean;
  aiFps: number;
  algorithms: CameraAlgorithm[];
  confidenceThreshold: number;
  zones: Array<{
    id: string;
    name: string;
    type: 'monitoring' | 'restricted' | 'counting_line';
    polygon: Array<{ x: number; y: number }>;
  }>;
  loiterDwellSeconds: number;
  loiterReturnWindow: number;
  loiterReturnCount: number;
  firePersistSeconds: number;
  theftDwellSeconds: number;
  scheduleEnabled: boolean;
  scheduleStart: string;
  scheduleEnd: string;
  scheduleDays: number[];
}

export interface SecurityConfig {
  enabled: boolean;
  cameras: CameraConfig[];
  modelSize: string;
  fireModelPath?: string;
  cooldownSeconds: number;
  snapshotOnAlert: boolean;
  clipOnAlert: boolean;
  clipDurationSeconds: number;
  evidenceRetentionDays: number;
  evidencePath?: string;
  telegramAlertEnabled: boolean;
  telegramChatId: string;
  mjpegPort: number;
  analyticsEnabled: boolean;
  analyticsReportHour: number;
  businessHoursStart: string;
  businessHoursEnd: string;
  businessDays: number[];
}

export interface SecurityStatus {
  running: boolean;
  cameras: Array<{
    id: string;
    name: string;
    connected: boolean;
    fps: number;
    trackCount: number;
    queueDrops: number;
    lastFrame: number;
  }>;
  gpuUtil?: number;
  totalInferenceFps: number;
  uptime: number;
}

export interface SecurityAlert {
  id: string;
  cameraId: string;
  cameraName: string;
  algorithm: CameraAlgorithm;
  severity: AlertSeverity;
  message: string;
  trackId?: number;
  dwellSeconds?: number;
  bbox?: [number, number, number, number];
  snapshotPath?: string;
  clipPath?: string;
  timestamp: number;
}

export interface SecurityAnalytics {
  cameraId: string;
  date: string;
  hourlyCustomerCount: number[];
  avgWaitTimeSeconds: number;
  peakHour: number;
  heatmapData?: number[][];
  staffMetrics?: Array<{
    zoneId: string;
    zoneName: string;
    activeMinutes: number;
    idleMinutes: number;
    estimatedCustomersServed: number;
  }>;
}

// Auto-Update status
export interface UpdateStatus {
  status: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  error?: string;
}

// Delete confirmation config
export interface DeleteConfirmConfig {
  enabled: boolean;
  code: string;      // Default: '123456'
}

// ==========================================
// Checkin Types
// ==========================================

export type CheckinStatus = 'waiting' | 'in_service' | 'completed' | 'no_show';

export interface CheckinRecord {
  id: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  serviceName?: string;
  services?: SelectedService[];
  staffName?: string;
  bookingId?: string;
  bookingSource?: 'booksy' | 'backend';
  isWalkIn: boolean;
  status: CheckinStatus;
  checkedInAt: string;
  startedAt?: string;
  completedAt?: string;
  upsellsAdded?: string[];
  notes?: string;
}

export interface CheckinStats {
  total: number;
  waiting: number;
  inService: number;
  completed: number;
  noShow: number;
  walkIns: number;
}

// Salon Customer (local DB for check-in wizard)
export interface SalonCustomer {
  id: string;
  backendCustomerId?: string;
  name: string;
  phone?: string;
  email?: string;
  birthday?: string;
  notes?: string;
  preferredStaffId?: string;
  preferredStaffName?: string;
  visitCount: number;
  lastVisitAt?: string;
  lastServiceName?: string;
}

export interface ServiceRecommendation {
  serviceName: string;
  serviceId?: string;
  count: number;
}

export interface CustomerServiceHistory {
  serviceName: string;
  serviceId?: string;
  staffName?: string;
  createdAt: string;
}

export interface SelectedService {
  id: string;
  name: string;
  price?: number;
  duration?: number;
}

// ==========================================
// Feature Entitlements IPC Channels
// ==========================================

// Add to IPC_CHANNELS
export const ENTITLEMENTS_CHANNELS = {
  // Entitlements
  ENTITLEMENTS_FETCH: 'entitlements:fetch',           // Fetch from backend
  ENTITLEMENTS_GET: 'entitlements:get',               // Get cached entitlements
  ENTITLEMENTS_IS_ENABLED: 'entitlements:is-enabled', // Check if feature is enabled
  ENTITLEMENTS_CHANGED: 'entitlements:changed',       // Event when entitlements change

  // Delete confirmation
  DELETE_CONFIRM_GET_CONFIG: 'delete-confirm:get-config',
  DELETE_CONFIRM_VERIFY: 'delete-confirm:verify',     // Verify code before delete
} as const;
