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
export type PrinterProtocol = 'THERMAL' | 'POSNET' | 'ELZAB_STX' | 'ZEBRA' | 'WINDOWS';

// Printer types - used for routing jobs to correct printer
// Using const object instead of enum for better Vite/browser compatibility
export const PrinterType = {
  RECEIPT: 'RECEIPT',   // Thermal ESC/POS receipt printers (Xprinter, Epson, Star...)
  FISCAL: 'FISCAL',     // Fiscal printers (Posnet/ELZAB) — legally required fiscal receipts
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
  FISCAL:  ['POSNET', 'ELZAB_STX'],
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
  INFO_LABEL = 'INFO_LABEL', // Quick Add 4-line PL-legal info label
  TEST = 'TEST',
  DAILY_REPORT = 'DAILY_REPORT',  // Raport dobowy
  X_REPORT = 'X_REPORT',          // Raport X (niefiskalny)
  Z_REPORT = 'Z_REPORT',          // Raport Z (fiskalny)
  KITCHEN_TICKET = 'KITCHEN_TICKET', // Phieu bep — items only, no prices
}

// Printer status returned by driver.getStatus()
export interface PrinterStatusInfo {
  connected: boolean;
  type: 'POSNET' | 'ELZAB' | 'ZEBRA' | 'THERMAL';
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
  unconditionally?: 0 | 1;  // ELZAB daily report flag: print even without sales.
}

export interface FiscalDailyReportResult {
  target?: string;
  reportKind?: 'DAILY' | 'Z' | string;
  commandUsed?: string;
  beforeReportNumber?: number;
  afterReportNumber?: number;
  reportNumberIncreased?: boolean;
  unconditionally?: 0 | 1;
  errorNumber?: number;
  beforeReportNumberReadCode?: number;
  afterReportNumberReadCode?: number;
  commandSent?: boolean;
  confirmationUnknown?: boolean;
}

export interface FiscalDailyReportPrintResponse {
  success: boolean;
  error?: string;
  code?: string;
  detail?: string;
  data?: FiscalDailyReportResult;
}

// Barcode types for label printing
export type BarcodeType = 'CODE128' | 'QR' | 'EAN13' | 'AUTO';

// Label data interface for Zebra printing
export interface LabelData {
  barcode: string;
  barcodeType: BarcodeType;
  text1?: string;
  text2?: string;
  text3?: string;
  quantity: number;
}

export interface LabelPrintOptions {
  priceText?: string;
  sku?: string;
  text2?: string;
  text3?: string;
  quantity?: number;
  copies?: number;
}

// Manufacturer/distributor role on Polish food labels (per art. 11 ustawa o
// bezpieczeństwie żywności i żywienia). Renders as "Producent: ..." /
// "Importer: ..." etc. on the info label.
export enum ManufacturerRole {
  PRODUCER = 'PRODUCER',
  IMPORTER = 'IMPORTER',
  DISTRIBUTOR = 'DISTRIBUTOR',
  SUPPLIER = 'SUPPLIER',
}

// 4-line PL-legal info label payload (Quick Add).
// productName + ingredients (Składniki) + bestBefore (Najlepiej spożyć
// przed) + manufacturer (Producent/Importer). Renderer adapts to paper
// size; on small paper, ingredients/manufacturer get truncated.
export interface InfoLabelData {
  productName: string;
  ingredients: string;
  bestBefore: string; // ISO YYYY-MM-DD
  manufacturerInfo: string;
  manufacturerRole: ManufacturerRole;
  countryOfOrigin: string | null;
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
  TIMEOUT = 'TIMEOUT',
  CANCELLED = 'CANCELLED',
}

// Printer configuration for a single printer
export interface PrinterConfig {
  enabled: boolean;
  protocol: PrinterProtocol;
  // Server-side mapping metadata from /print-agent/connect printers[]
  serverPrinterId?: string;
  displayName?: string;
  // For THERMAL/POSNET (COM port)
  port?: string;
  baudRate?: number;
  // For network-capable fiscal printers (e.g. ELZAB RNDIS/IP)
  address?: string;
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

export type ScaleProtocol = 'DIBAL_GDPOS';
export type ScaleConnectionMode = 'none' | 'local' | 'remote';

export interface ScaleShareConfig {
  enabled?: boolean;
  port?: number;
  token?: string;
}

export interface ScaleRemoteConfig {
  host?: string;
  port?: number;
  token?: string;
  timeoutMs?: number;
}

export interface ScaleConfig {
  enabled: boolean;
  connection?: ScaleConnectionMode;
  protocol: ScaleProtocol;
  port: string;
  baudRate?: number;
  share?: ScaleShareConfig;
  remote?: ScaleRemoteConfig;
}

export type ScaleReadResult =
  | {
      success: true;
      protocol: ScaleProtocol;
      port: string;
      weightKg: number;
      stable: boolean;
      status: string;
      source?: 'local' | 'remote';
      remoteHost?: string;
      rawAscii?: string;
      rawHex?: string;
    }
  | {
      success: false;
      protocol: ScaleProtocol;
      port?: string;
      error: string;
      code: string;
      source?: 'local' | 'remote';
      remoteHost?: string;
      rawAscii?: string;
      rawHex?: string;
      status?: string;
    };

export interface ServerPrinterMapping {
  id: string;
  agentId?: string | null;
  displayName?: string | null;
  name?: string | null;
  printerType?: string | null;
  protocol?: string;
  windowsPrinterName?: string | null;
  address?: string | null;
  baudRate?: number;
  paperWidth?: number | null;
  paperHeight?: number | null;
  charsPerLine?: number;
  supportsImages?: boolean;
  supportsCut?: boolean;
  supportsCashDrawer?: boolean;
  isPredefined?: boolean;
  isEnabled?: boolean;
  isOnline?: boolean;
  lastError?: string | null;
  lastCheckedAt?: string | null;
  lastUsedAt?: string | null;
  sortOrder?: number;
  createdAt?: string;
}

export interface SalonPrinterMapping extends ServerPrinterMapping {
  agentId: string;
  agentName?: string | null;
  machineId?: string | null;
  agentStatus?: string | null;
  agentIsOnline?: boolean;
  agentLastSeenAt?: string | null;
}

export type SalonPrinterRole =
  | 'SELF_CHECKOUT_RECEIPT'
  | 'POS_RECEIPT'
  | 'FISCAL_RECEIPT'
  | 'KITCHEN'
  | 'LABEL'
  | 'A4';

export interface SalonPrinterAssignment {
  id: string;
  salonId: string;
  role: SalonPrinterRole | string;
  printerId: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface LocalPrinterMirrorRow {
  id: string;
  agent_id: string | null;
  printer_type: string | null;
  display_name: string | null;
  name: string | null;
  protocol: PrinterProtocol;
  windows_printer_name: string | null;
  address: string | null;
  port: string | null;
  baud_rate: number;
  paper_width: number;
  paper_height: number | null;
  chars_per_line: number;
  supports_cut: number;
  supports_cash_drawer: number;
  is_enabled: number;
  is_online: number;
  last_seen_at: string | null;
  last_used_at: string | null;
  updated_at: string | null;
}

export interface AgentPrintersResponse {
  printers: ServerPrinterMapping[];
}

export interface SalonPrintersResponse {
  printers: SalonPrinterMapping[];
}

export interface SalonPrintersListOptions {
  shareableOnly?: boolean;
  role?: SalonPrinterRole;
}

export interface SalonPrinterAssignmentsResponse {
  assignments: SalonPrinterAssignment[];
}

export interface SalonPrinterAssignmentResponse {
  assignment: SalonPrinterAssignment;
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

export type CustomerDisplayCatalogSection =
  | 'retail'
  | 'food';

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
  scale?: ScaleConfig;

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
    allowOversell?: boolean;             // Allow retail/self-checkout sale when tracked stock is <= 0. Default false.
    labelModuleProductIds?: string[];    // Product IDs shown in the quick label-printing module
    labelModuleCategoryIds?: string[];    // Category IDs shown in the quick label-printing module
    googleCustomSearchApiKey?: string;    // Optional fallback for EAN lookup when public product databases miss.
    googleCustomSearchCx?: string;        // Google Programmable Search engine id for EAN lookup.
    // Receipt seller info (Polish paragon compliance)
  receiptSellerName?: string;    // Legal entity name (e.g., "P.T.H. BAKS Sławomir Chądzyński")
  receiptSellerAddress?: string; // Full address (e.g., "ul. Łączności 35, 32-020 Wieliczka")
  receiptSellerNip?: string;     // Tax ID (e.g., "522-005-23-49")
  allowRealFiscalPrint?: boolean; // Live fiscal receipts enabled on this POS after service-approved go-live.
  fiscalDailyReport?: {
    enabled?: boolean;            // Enable automatic fiscal daily report on this device.
    master?: boolean;             // Must be true on exactly one POS: the fiscal-printer master.
    hour?: number;                // Warsaw local hour, default 23.
    minute?: number;              // Warsaw local minute, default 58.
    timezone?: string;            // IANA timezone, default Europe/Warsaw.
    retryMinutes?: number;        // Retry interval after a failed attempt, default 5.
    maxAttempts?: number;         // Attempts per scheduled run, default 3.
    unconditionally?: boolean;    // Pass ELZAB "print even without sale" flag. Default false.
  };
  showNonFiscalOrders?: boolean; // Show orders without a successful fiscal receipt in history/stats. Default true.
  posLanguage?: 'en' | 'vi' | 'tr' | 'zh' | 'uk' | 'ru' | 'pl' | '';  // POS UI language (defaults to main language)
  customerDisplayLanguage?: 'en' | 'vi' | 'tr' | 'zh' | 'uk' | 'ru' | 'pl' | ''; // Display On UI language (falls back to POS, then main language)
  customerDisplayEnabled?: boolean;    // Enable customer-facing display
  customerDisplayProfile?: CustomerDisplayProfile; // Live: retail_assisted, salon_checkin, promo_only. Reserved values are not selectable.
  customerDisplayMonitor?: number;     // Monitor index for customer display (0 = primary)
  customerDisplayForceKiosk?: boolean; // Force kiosk/fullscreen even on single monitor (default true). Esc + 3-finger swipe-down still exit.
  customerDisplayRetailCatalogEnabled?: boolean; // Show sellable grocery/retail product categories on customer display.
  customerDisplayFoodMenuEnabled?: boolean; // Show food/drink menu categories on customer display.
  customerDisplayPromoFolder?: string; // Local folder path for promo images
  customerDisplayPromoInterval?: number; // Carousel interval in ms (default 5000)
  customerDisplayIdleTimeout?: number;   // Idle timeout before promo in ms (default 120000)

  // Self-checkout terminal — kiosk for customer-driven sales. Disabled
  // by default; opening the window takes over the screen and is meant
  // for unattended-kiosk hardware on the shop counter.
  selfCheckoutEnabled?: boolean;
  selfCheckoutMonitor?: number;
  selfCheckoutTerminalId?: string;       // Stable ID generated on first launch
  selfCheckoutKioskUserId?: string;      // Dedicated staff user for kiosk sales
  selfCheckoutMode?: 'demo' | 'production'; // Demo allows mocked terminal/fiscal flow; production must pass readiness gates.
  selfCheckoutProfile?: 'retail_scan' | 'menu_kitchen'; // Retail scan-only for shops; menu/kitchen browse profile is reserved for restaurants.
  selfCheckoutFakePaymentEnabled?: boolean; // Reserved legacy flag; production checkout ignores it until readiness gates are implemented.
  selfCheckoutLanguage?: 'pl' | 'en' | 'vi';
  selfCheckoutIdleTimeoutMs?: number;    // Auto-reset to welcome after N ms idle
  kitchenSelfOrderEnabled?: boolean;      // Separate customer-facing food-order kiosk.
  kitchenSelfOrderMonitor?: number;
  kitchenSelfOrderLanguage?: 'pl' | 'en' | 'vi';
  kitchenSelfOrderDefaultFulfillment?: 'DINE_IN' | 'TAKEAWAY';
  kitchenSelfOrderFulfillmentOptions?: Array<'DINE_IN' | 'TAKEAWAY'>;
  kitchenSelfOrderSlipPrinterType?: 'RECEIPT' | 'LABEL';
  kitchenSelfOrderSlipPrinterId?: string;
  kitchenSelfOrderSourceLabel?: string;
  kitchenSelfOrderBrandName?: string;
  kitchenSelfOrderLogoUrl?: string;
  kitchenSelfOrderAccentColor?: string;
  kitchenSelfOrderCheckoutMode?: 'PAY_AT_COUNTER' | 'KIOSK_TERMINAL' | 'ORDER_ONLY';
  kitchenSelfOrderReleasePolicy?: 'ON_SUBMIT' | 'ON_PAYMENT_CONFIRMED';

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

  // Local database backup status
  backupLastStatus?: 'success' | 'failed';
  backupLastRunAt?: string;
  backupLastSuccessAt?: string;
  backupLastPath?: string;
  backupLastError?: string;
  backupPendingRestorePath?: string;
  backupPendingRestoreSourcePath?: string;
  backupPendingRestoreRequestedAt?: string;
  backupRestoreLastStatus?: 'pending' | 'success' | 'failed';
  backupRestoreLastError?: string;
  backupRestoreLastSourcePath?: string;
  backupRestoreLastSafetyBackupPath?: string;
  backupRestoreLastAppliedAt?: string;

  // User-hidden tabs (locally controlled, independent of entitlements)
  // @deprecated superseded by moduleOverrides; kept for backward-compat + migration
  hiddenTabs?: Tab[];

  // Per-module visibility overrides (locally controlled, this device only).
  // Key present => explicit user choice wins over entitlements (can force-show
  // a module the plan does not entitle, or hide an entitled one).
  // Key absent => fall back to entitlement default. `settings` is always shown.
  moduleOverrides?: Partial<Record<Tab, boolean>>;

  // Check-in tab display toggles
  checkinShowStatsBar?: boolean;  // Show total/waiting/in-service/completed bar (default: true)
  checkinShowQueue?: boolean;     // Show active queue panel on the right (default: true)

  // TV Ads (signage) — điều khiển màn hình quảng cáo Google TV qua LAN
  tvAdEnabled?: boolean;
  tvAdPort?: number;
  tvAdPlaybackMode?: 'sequential' | 'repeat-one';
  tvAdRepeatVideoId?: string | null;
  tvAdMuted?: boolean;
  tvAdVolume?: number;
  tvAdPlaylist?: Array<{ id: string; filename: string; order: number; enabled: boolean }>;
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
  /** Stable POS order id used for fiscal idempotency. */
  orderId?: string;
  /** Optional stable payment attempt id used for split/terminal fiscal idempotency. */
  paymentId?: string;
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
export interface KitchenTicketItem {
  name: string;
  quantity: number;
  /** kg for weighted items; null/'szt' renders as a plain count. */
  unit?: string | null;
  /** Readable modifier labels (e.g. "Duong: 50%"). Rendered one per line. */
  modifiers?: string[];
  /** Free-text customer note only (modifiers live in `modifiers`). */
  notes?: string | null;
  /** Customer payment slip only. Kitchen tickets must not render prices. */
  unitPriceGrosze?: number | null;
  lineTotalGrosze?: number | null;
}

/** Kitchen ticket payload — what the cooks see. Deliberately NO prices. */
export interface KitchenTicketData {
  orderId: string;
  orderNumber: string;
  /** ISO timestamp of the sale. */
  createdAt: string;
  /** Order source: POS | SELF_CHECKOUT | SERVER | ... */
  source: string;
  /** Optional first-class kitchen/self-order fulfillment choice. */
  fulfillmentType?: 'DINE_IN' | 'TAKEAWAY' | string | null;
  /** Kitchen ticket language. Customer kitchen self-orders default to VI. */
  kitchenLanguage?: 'pl' | 'vi' | 'en' | string | null;
  /** Customer slip language. Existing pickup slips default to PL. */
  customerLanguage?: 'pl' | 'vi' | 'en' | string | null;
  isReprint?: boolean;
  /** Daily pickup number ('0001'...) shared between the kitchen ticket and
   *  the customer pickup slip — the kitchen matches them at hand-over. */
  pickupNumber?: string | null;
  /** TICKET (default) = kitchen ticket; PICKUP_SLIP = the small customer
   *  slip with the big pickup number, printed next to the paragon.
   *  PAYMENT_SLIP = customer takes this unpaid kitchen self-order to cashier. */
  kind?: 'TICKET' | 'PICKUP_SLIP' | 'PAYMENT_SLIP';
  /** Self-order kitchen tickets can be printed before cashier payment. */
  paymentStatus?: 'UNPAID' | 'PAID' | string | null;
  /** Optional customer-slip QR payload used by cashier POS to recall the cart. */
  qrPayload?: string | null;
  /** Compact (no-notes) QR for the LABEL printer only; smaller so it always
   *  fits/scan on a 50x30 label. Local-only - never sent over the shared route. */
  labelQrPayload?: string | null;
  /** Customer-facing brand shown on pickup slips. */
  brandName?: string | null;
  /** Customer payment slip only. Existing kitchen tickets can omit it. */
  totalGrosze?: number | null;
  items: KitchenTicketItem[];
}

export interface PrintJobEvent {
  jobId: string;
  jobType: PrintJobType;
  printerType?: PrinterType;  // NEW: Explicit printer routing from server
  printerId?: string | null;  // Server printer mapping id
  payload: ReceiptData | LabelData | InfoLabelData | DocumentData | DailyReportData | KitchenTicketData;
  referenceType: string | null;
  referenceId: string | null;
  openDrawer?: boolean;
  createdAt: string;
}

export interface CreatePrintJobRequest {
  jobType?: PrintJobType;
  printerType?: PrinterType;
  printerId?: string | null;
  payload: PrintJobEvent['payload'];
  referenceType?: string | null;
  referenceId?: string | null;
  openDrawer?: boolean;
  waitForCompletion?: boolean;
  timeoutMs?: number;
}

export interface CreatePrintJobResponse {
  jobId?: string;
  id?: string;
  sent?: boolean;
  status?: string;
  message?: string;
  errorMessage?: string;
  printerId?: string | null;
  [key: string]: unknown;
}

// Device status
export interface DeviceStatus {
  printerConnected: boolean;
  printerPort: string | null;
  scannerActive: boolean;
  appVersion: string;
  printerStatuses?: Array<{
    printerId: string;
    isOnline: boolean;
    lastError?: string | null;
  }>;
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
    protocol?: string;
    baudRate?: number;
  };
  printers?: ServerPrinterMapping[];
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
  refresh_token?: string;
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
  SCALE_READ_WEIGHT: 'scale:read-weight',
  SCALE_GET_NETWORK_INFO: 'scale:get-network-info',
  TEST_PRINT: 'test-print',
  PRINT_LABEL: 'print-label',
  TEST_PRINTER_BY_TYPE: 'test-printer-by-type',
  TEST_PRINTER_BY_CONFIG: 'test-printer-by-config',
  PRINT_FISCAL_DAILY_REPORT_NOW: 'print-fiscal-daily-report-now',
  TEST_PRINT_PROGRESS: 'test-print-progress',  // Main → Renderer: per-step progress stream
  VALIDATE_PRINTER_PORT: 'validate-printer-port',
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
  PRINT_AGENT_PRINTERS_LIST: 'print-agent-printers-list',
  PRINT_AGENT_PRINTERS_LOCAL_LIST: 'print-agent-printers-local-list',
  PRINT_AGENT_PRINTERS_CREATE: 'print-agent-printers-create',
  PRINT_AGENT_PRINTERS_UPDATE: 'print-agent-printers-update',
  PRINT_AGENT_PRINTERS_DELETE: 'print-agent-printers-delete',
  PRINT_AGENT_SALON_PRINTERS_LIST: 'print-agent-salon-printers-list',
  PRINT_AGENT_PRINTER_ASSIGNMENTS_LIST: 'print-agent-printer-assignments-list',
  PRINT_AGENT_PRINTER_ASSIGNMENTS_UPSERT: 'print-agent-printer-assignments-upsert',
  PRINT_AGENT_PRINTER_ASSIGNMENTS_DELETE: 'print-agent-printer-assignments-delete',
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
  BOOKSY_JWT_EXPIRED: 'booksy:jwt-expired',

  // POS - Core
  POS_GET_STATE: 'pos:get-state',
  POS_DISPATCH: 'pos:dispatch',
  POS_STATE_CHANGED: 'pos:state-changed',

  // POS - Products
  POS_PRODUCTS_GET_ALL: 'pos:products:getAll',
  POS_PRODUCTS_GET_BY_CATEGORY: 'pos:products:getByCategory',
  POS_PRODUCTS_SEARCH: 'pos:products:search',
  POS_PRODUCTS_SEARCH_BY_CODE: 'pos:products:searchByCode',
  POS_PRODUCTS_GET_BY_BARCODE: 'pos:products:getByBarcode',
  POS_PRODUCT_ADMIN_CAPABILITIES: 'pos:product-admin:capabilities',
  POS_PRODUCT_ADMIN_CREATE_PRODUCT: 'pos:product-admin:create-product',
  POS_PRODUCT_ADMIN_UPDATE_VARIANT: 'pos:product-admin:update-variant',
  POS_PRODUCT_ADMIN_DEACTIVATE_VARIANT: 'pos:product-admin:deactivate-variant',
  POS_PRODUCT_ADMIN_ADJUST_STOCK: 'pos:product-admin:adjust-stock',
  POS_PRODUCT_ADMIN_CATEGORIES_LIST: 'pos:product-admin:categories:list',
  POS_PRODUCT_ADMIN_CATEGORIES_CREATE: 'pos:product-admin:categories:create',
  POS_PRODUCT_ADMIN_CATEGORIES_UPDATE: 'pos:product-admin:categories:update',

  // POS - Categories
  POS_CATEGORIES_GET_ALL: 'pos:categories:getAll',

  // POS - Orders
  POS_ORDERS_CREATE: 'pos:orders:create',
  POS_ORDERS_GET_DAILY_STATS: 'pos:orders:getDailyStats',
  POS_ORDERS_MIRROR_FROM_SERVER: 'pos:orders:mirrorFromServer',

  // POS - Nail Turns
  POS_NAIL_TURNS_GET_TODAY: 'pos:nail-turns:getToday',
  POS_NAIL_TURNS_UPDATED: 'pos:nail-turns-updated',
  POS_SCHEDULE_GET_TODAY: 'pos:schedule:getToday',
  POS_SCHEDULE_GET_WEEK: 'pos:schedule:getWeek',
  POS_SCHEDULE_SET_STAFF_STATUS: 'pos:schedule:setStaffStatus',
  POS_SCHEDULE_ASSIGN_NEXT: 'pos:schedule:assignNext',
  POS_SCHEDULE_REQUEST_STAFF: 'pos:schedule:requestStaff',
  POS_LOYALTY_LOOKUP_CUSTOMER: 'pos:loyalty:lookupCustomer',

  // POS - Payment
  POS_PRINT_RECEIPT: 'pos:print-receipt',
  POS_PRINT_RECEIPT_AND_OPEN_DRAWER: 'pos:print-receipt-and-open-drawer',
  POS_PRINT_FISCAL_RECEIPT: 'pos:print-fiscal-receipt',
  POS_HAS_FISCAL_PRINTER: 'pos:has-fiscal-printer',
  POS_OPEN_CASH_DRAWER: 'pos:open-cash-drawer',
  POS_PAYMENT_CARD: 'pos:payment:card',
  POS_ELAVON_STATUS: 'pos:elavon-status',

  // POS - Shift
  POS_SHIFT_OPEN: 'pos:shift:open',
  POS_SHIFT_CLOSE: 'pos:shift:close',

  // POS - Sync
  POS_SYNC_PRODUCTS: 'pos:sync:products',
  POS_SYNC_ORDERS: 'pos:sync:orders',
  POS_SYNC_STAFF: 'pos:sync:staff',
  POS_PRODUCTS_SYNCED: 'pos:products-synced',
  POS_STAFF_UPDATED: 'pos:staff-updated',
  POS_CATALOG_UPDATED: 'pos:catalog-updated',
  POS_STOCK_UPDATED: 'pos:stock-updated',
  POS_ORDER_SYNCED: 'pos:order-synced',

  // Warehouse / Magazyn
  WAREHOUSE_CAPABILITIES: 'warehouse:capabilities',
  WAREHOUSE_WAREHOUSES_LIST: 'warehouse:warehouses:list',
  WAREHOUSE_DOCUMENTS_LIST: 'warehouse:documents:list',
  WAREHOUSE_DOCUMENTS_GET: 'warehouse:documents:get',
  WAREHOUSE_DOCUMENTS_CREATE: 'warehouse:documents:create',
  WAREHOUSE_DOCUMENTS_UPDATE: 'warehouse:documents:update',
  WAREHOUSE_DOCUMENTS_SET_LINES: 'warehouse:documents:set-lines',
  WAREHOUSE_DOCUMENTS_POST: 'warehouse:documents:post',
  WAREHOUSE_DOCUMENTS_CANCEL: 'warehouse:documents:cancel',
  WAREHOUSE_DOCUMENTS_PRINT: 'warehouse:documents:print',
  WAREHOUSE_INVENTORY_CREATE: 'warehouse:inventory:create',
  WAREHOUSE_INVENTORY_SET_LINES: 'warehouse:inventory:set-lines',
  WAREHOUSE_INVENTORY_RECONCILE: 'warehouse:inventory:reconcile',
  WAREHOUSE_INVENTORY_POST: 'warehouse:inventory:post',
  WAREHOUSE_INVENTORY_PRINT: 'warehouse:inventory:print',

  // Forecast / Daily Ordering
  FORECAST_GET_RECOMMENDATIONS: 'forecast:get-recommendations',
  FORECAST_RECOMPUTE: 'forecast:recompute',
  FORECAST_GET_POLICIES: 'forecast:get-policies',
  FORECAST_SAVE_POLICY: 'forecast:save-policy',
  FORECAST_EXPORT_CSV: 'forecast:export-csv',
  FORECAST_GET_TODAY_SALES: 'forecast:get-today-sales',
  FORECAST_CREATE_ORDER_DRAFT: 'forecast:create-order-draft',
  FORECAST_LIST_ORDER_DRAFTS: 'forecast:list-order-drafts',
  FORECAST_GET_ORDER_DRAFT: 'forecast:get-order-draft',

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
  POS_STAFF_GET_ALL_FOR_SETTINGS: 'pos:staff:getAllForSettings',
  POS_STAFF_CREATE: 'pos:staff:create',
  POS_STAFF_UPDATE: 'pos:staff:update',
  POS_STAFF_SET_ACTIVE: 'pos:staff:setActive',

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

  // Local database backup
  BACKUP_GET_STATUS: 'backup:get-status',
  BACKUP_RUN_NOW: 'backup:run-now',
  BACKUP_LIST: 'backup:list',
  BACKUP_PREPARE_RESTORE: 'backup:prepare-restore',
  BACKUP_OPEN_FOLDER: 'backup:open-folder',
  BACKUP_OPEN_DATA_FOLDER: 'backup:open-data-folder',

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

  // Bookings (dashboard-synced appointments — distinct from Booksy bookings)
  BOOKINGS_GET_TODAY: 'bookings:get-today',
  BOOKINGS_GET_BY_DATE: 'bookings:get-by-date',
  BOOKINGS_GET_BY_DATE_RANGE: 'bookings:get-by-date-range',
  BOOKINGS_GET_BY_ID: 'bookings:get-by-id',
  BOOKINGS_CREATE: 'bookings:create',
  BOOKINGS_STATUS_CHANGE: 'bookings:status-change',
  BOOKINGS_CANCEL: 'bookings:cancel',
  BOOKINGS_UPDATE: 'bookings:update',

  // Services (master data synced from dashboard — for walk-in pickers)
  SERVICES_GET_ALL_ACTIVE: 'services:get-all-active',
  SERVICES_GET_BY_ID: 'services:get-by-id',
  SERVICE_RULES_GET_BY_SERVICE: 'service-rules:get-by-service',

  // Generic API proxy
  API_CALL: 'api:call',

  // TV Ad Display (signage)
  TV_AD_GET_STATUS: 'tvAd:getStatus',
  TV_AD_PICK_VIDEO: 'tvAd:pickVideo',
  TV_AD_SAVE: 'tvAd:save',
} as const;

// Shared status shape for the TV Ad Display module.
// Mirrors AdDisplayStatus from src/main/ad-display/ but lives in shared
// so the renderer can consume it without importing from src/main.
export interface AdDisplayStatusLike {
  running: boolean;
  port: number | null;
  ips: string[];
  primaryIp?: string;
  connectedClients: number;
  error?: string;
}

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
  hasJwt?: boolean;             // Derived by GET_CONFIG handler — never persisted
  clearJwt?: boolean;           // Action-only SET_CONFIG sentinel; never persisted
  appSalonId?: string | null;   // Derived by GET_CONFIG handler; never persisted
  appSalonName?: string | null; // Derived by GET_CONFIG handler; never persisted
  appAuthEmail?: string | null; // Derived by GET_CONFIG handler; never persisted
  jwtSalonId?: string | null;   // Derived by local JWT payload decode; never persisted
  jwtSalonMismatch?: boolean;   // Derived warning flag; never persisted
  jwtSalonWarning?: string;     // Derived warning text; never persisted
}

export interface BooksySyncStatus {
  enabled: boolean;
  running: boolean;
  hasToken: boolean;
  sessionExpired: boolean;
  lastSyncTime: string | null;
  lastSyncReport: BooksySyncReport | null;
  isBusinessHours: boolean;
  nextSyncIn: number | null;          // seconds until next calendar sync (null = loop stopped)
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
  pushReason?: 'not-configured' | 'network-error' | 'timeout' | 'non-2xx' | 'jwt-expired';
  pushErrors?: number;
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
  pushReason?: 'not-configured' | 'network-error' | 'timeout' | 'non-2xx' | 'jwt-expired';
  pushErrors?: number;
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
  pushReason?: 'not-configured' | 'network-error' | 'timeout' | 'non-2xx' | 'jwt-expired';
  pushErrors?: number;
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
  pushReason?: 'not-configured' | 'network-error' | 'timeout' | 'non-2xx' | 'jwt-expired';
  pushErrors?: number;
}

export interface BooksyAddonSyncReport {
  time: string;
  totalFetched: number;
  pushed: boolean;
  error?: string;
  pushReason?: 'not-configured' | 'network-error' | 'timeout' | 'non-2xx' | 'jwt-expired';
  pushErrors?: number;
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
  pushReason?: 'not-configured' | 'network-error' | 'timeout' | 'non-2xx' | 'jwt-expired';
  pushErrors?: number;
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
// Warehouse / Magazyn Types
// ==========================================

export type WarehouseDocumentType = 'PZ' | 'WZ' | 'RW' | 'PW' | 'MM' | 'INW';
export type WarehouseDocumentStatus = 'DRAFT' | 'POSTED' | 'CANCELLED';
export type WarehouseStockDocumentType = Exclude<WarehouseDocumentType, 'INW'>;

export interface WarehouseCapabilities {
  version: number;
  canListWarehouses: boolean;
  canCreateDocument: boolean;
  canUpdateDocument: boolean;
  canSetDocumentLines: boolean;
  canPostDocument: boolean;
  canCancelDocument: boolean;
  canPrintDocument: boolean;
  canCreateInventoryCount: boolean;
  canSetInventoryLines: boolean;
  canReconcileInventory: boolean;
  canPostInventory: boolean;
  canPrintInventory: boolean;
  supportedDocumentTypes: WarehouseStockDocumentType[];
  unsupportedDocumentTypes: WarehouseStockDocumentType[];
}

export interface WarehouseInfo {
  id: string;
  code: string;
  name: string;
  isDefault?: boolean;
  isActive?: boolean;
}

export interface WarehouseDocumentLineInput {
  productVariantId: string;
  sku?: string | null;
  barcode?: string | null;
  name?: string;
  unit?: string;
  quantity: number;
  countedQuantity?: number;
  unitCostGrosze?: number;
  vatRate?: number;
  bookStock?: number;
}

export interface WarehouseDocumentCreateInput {
  type: WarehouseDocumentType;
  warehouseId?: string;
  warehouseCode?: string;
  targetWarehouseId?: string;
  targetWarehouseCode?: string;
  contractorName?: string;
  sourceDocumentNo?: string;
  issueDate?: string;
  operationDate?: string;
  notes?: string;
  lines?: WarehouseDocumentLineInput[];
  idempotencyKey?: string;
}

export interface WarehouseDocumentUpdateInput {
  warehouseId?: string;
  warehouseCode?: string;
  targetWarehouseId?: string;
  targetWarehouseCode?: string;
  contractorName?: string;
  sourceDocumentNo?: string;
  issueDate?: string;
  operationDate?: string;
  notes?: string;
}

export interface WarehouseDocument {
  id: string;
  type: WarehouseDocumentType;
  status: WarehouseDocumentStatus | string;
  number?: string | null;
  warehouseId?: string | null;
  warehouseCode?: string | null;
  targetWarehouseId?: string | null;
  targetWarehouseCode?: string | null;
  contractorName?: string | null;
  sourceDocumentNo?: string | null;
  issueDate?: string | null;
  operationDate?: string | null;
  postedAt?: string | null;
  notes?: string | null;
  lines?: any[];
  [key: string]: any;
}

export interface WarehouseDocumentListFilter {
  type?: WarehouseDocumentType;
  warehouseId?: string;
  warehouseCode?: string;
  status?: WarehouseDocumentStatus | string;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface WarehousePrintPayload {
  document: WarehouseDocument;
  lines?: any[];
  [key: string]: any;
}

export interface WarehouseInventoryCountLineInput {
  productVariantId: string;
  sku?: string | null;
  barcode?: string | null;
  name?: string;
  unit?: string;
  bookStock: number;
  countedQuantity: number;
  unitCostGrosze?: number;
}

export interface WarehouseInventoryCountCreateInput {
  warehouseId?: string;
  warehouseCode?: string;
  scope?: string;
  notes?: string;
  lines?: WarehouseInventoryCountLineInput[];
  idempotencyKey?: string;
}

export interface WarehouseInventoryCount {
  id: string;
  status: string;
  number?: string | null;
  warehouseId?: string | null;
  warehouseCode?: string | null;
  notes?: string | null;
  lines?: any[];
  [key: string]: any;
}

// ==========================================
// POS Nail Turn Types
// ==========================================

export interface NailTurnStaffSummary {
  staff_profile_id: string;
  user_id?: string | null;
  name?: string | null;
  queue_position?: number;
  status?: string;
  turn_credit?: number;
  full_turns?: number;
  half_turns?: number;
  request_count?: number;
  revenue_today_pln?: number;
  tips_today_pln?: number;
}

export interface NailTurnAssignmentSummary {
  id: string;
  staff_profile_id: string;
  staff_name?: string | null;
  checkin_log_id?: string | null;
  booking_id?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  service_name?: string | null;
  source_type?: string;
  is_request?: boolean;
  status?: string;
  assigned_at?: string;
}

export interface NailTurnBoardResponse {
  day?: {
    id?: string;
    business_date?: string;
    timezone?: string;
    strategy?: string;
    half_turn_threshold_pln?: number;
    status?: string;
    queue_version?: number;
  };
  settings?: Record<string, any>;
  staff?: NailTurnStaffSummary[];
  active_assignments?: NailTurnAssignmentSummary[];
  can_undo?: boolean;
  last_action?: Record<string, any> | null;
}

export interface NailTurnBoardIpcResult {
  success: boolean;
  board?: NailTurnBoardResponse | null;
  unavailable?: boolean;
  error?: string;
}

export interface PosScheduleStaffSummary extends NailTurnStaffSummary {
  display_color?: string | null;
}

export interface PosScheduleBookingSummary {
  id: string;
  staff_profile_id?: string | null;
  owner_id?: string | null;
  customer_name?: string | null;
  customer_phone_masked?: string | null;
  service_name?: string | null;
  starts_at: string;
  ends_at: string;
  status?: string;
  is_request?: boolean;
  source?: string;
}

export interface PosScheduleCheckinSummary {
  id: string;
  booking_id?: string | null;
  customer_name?: string | null;
  service_name?: string | null;
  checked_in_at: string;
  assigned_staff_profile_id?: string | null;
}

export interface PosScheduleAssignmentSummary extends NailTurnAssignmentSummary {
  assigned_at?: string;
}

export interface PosScheduleDayResponse {
  salon?: {
    id?: string;
    slug?: string | null;
    timezone?: string;
  };
  business_date: string;
  range?: {
    from?: string;
    to?: string;
  };
  staff: PosScheduleStaffSummary[];
  bookings: PosScheduleBookingSummary[];
  unassigned_bookings?: PosScheduleBookingSummary[];
  waiting_checkins: PosScheduleCheckinSummary[];
  active_assignments: PosScheduleAssignmentSummary[];
  next_turn?: {
    staff_profile_id: string;
    name?: string | null;
  } | null;
  server_time?: string;
  version?: number;
  stale?: boolean;
  cached_at?: string;
}

export interface PosScheduleWeekResponse {
  salon?: PosScheduleDayResponse['salon'];
  from: string;
  days: number;
  schedules: PosScheduleDayResponse[];
  server_time?: string;
}

export interface PosScheduleDayIpcResult {
  success: boolean;
  schedule?: PosScheduleDayResponse | null;
  unavailable?: boolean;
  stale?: boolean;
  error?: string;
}

export interface PosScheduleWeekIpcResult {
  success: boolean;
  week?: PosScheduleWeekResponse | null;
  unavailable?: boolean;
  error?: string;
}

export type PosScheduleStaffStatus = 'AVAILABLE' | 'BUSY' | 'BREAK' | 'OFF';

export interface PosScheduleStaffStatusPayload {
  staffProfileId: string;
  status: PosScheduleStaffStatus;
  idempotencyKey?: string;
}

export interface PosScheduleAssignNextPayload {
  checkinLogId: string;
  bookingId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  serviceName?: string | null;
  idempotencyKey?: string;
}

export interface PosScheduleRequestStaffPayload extends PosScheduleAssignNextPayload {
  staffProfileId: string;
}

// ==========================================
// POS Loyalty Types
// ==========================================

export interface PosLoyaltyMemberStatus {
  memberId: string;
  currentPoints: number;
  lifetimePoints: number;
  redeemedPoints: number;
  totalSpendPln: number;
  totalBookings: number;
  tier: {
    id: string;
    code: string;
    name: string;
    color: string;
    discountPercent: number;
    pointsMultiplier: number;
  } | null;
  nextTier: {
    id: string;
    code: string;
    name: string;
    minPoints: number;
    pointsNeeded: number;
  } | null;
  referralCode: string;
  referralCount: number;
  pendingRedemptions: number;
  activeStampCards: number;
}

export interface PosLoyaltyLookupResponse {
  found: boolean;
  phone: string;
  owner?: {
    id: string;
    fullName: string;
    phone: string;
    email?: string | null;
    isBlocked: boolean;
    noShowCount: number;
    lateCount: number;
    cancelCount: number;
  };
  loyalty?: PosLoyaltyMemberStatus;
}

export interface PosLoyaltyLookupIpcResult {
  success: boolean;
  result?: PosLoyaltyLookupResponse;
  unavailable?: boolean;
  error?: string;
}

// ==========================================
// POS Product Admin Capability Types
// ==========================================

export interface ProductAdminCapabilities {
  version: number;
  canCreateProduct: boolean;
  canUpdateProduct: boolean;
  canDeactivateProduct: boolean;
  canAdjustStock: boolean;
  canCreateCategory: boolean;
  canUpdateCategory: boolean;
  supportsOptimisticConcurrency: boolean;
}

export type ProductAdminErrorCode =
  | 'DUPLICATE_BARCODE'
  | 'DUPLICATE_SKU'
  | 'STALE_PRODUCT'
  | 'PRODUCT_NOT_FOUND'
  | 'CATEGORY_NOT_FOUND'
  | 'INVALID_PRICE'
  | 'INVALID_STOCK_QUANTITY'
  | 'INSUFFICIENT_STOCK'
  | 'UNSUPPORTED_CAPABILITY'
  | 'SALON_CONTEXT_MISMATCH'
  | 'UNAUTHORIZED_PRODUCT_ADMIN'
  | 'INVALID_CATEGORY'
  | 'INVALID_VAT_RATE'
  | 'PRICE_MINOR_UNIT_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT';

export interface ProductAdminErrorEnvelope {
  ok: false;
  code: ProductAdminErrorCode | string;
  message: string;
  field?: string | null;
  details?: Record<string, unknown> | null;
  serverTime?: string;
}

export interface ProductAdminIpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: ProductAdminErrorCode | string;
  field?: string | null;
  details?: Record<string, unknown> | null;
}

export interface ProductAdminProductTemplate {
  id: string;
  name: string;
  categoryId?: string | null;
}

export interface ProductAdminVariant {
  id: string;
  templateId: string | null;
  name: string;
  nameTranslations?: Record<string, string> | null;
  sku?: string | null;
  barcode?: string | null;
  retailPrice?: number | null;
  priceGrossGrosze: number;
  vatRate: number;
  categoryId?: string | null;
  totalStockQty: number;
  availableQty: number;
  isActive: boolean;
  saleUnit?: string | null;
  sellBy?: 'PIECE' | 'WEIGHT' | string | null;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  updatedAt: string;
  version?: number;
}

export interface ProductAdminCreateProductInput {
  name: string;
  barcode?: string | null;
  sku?: string | null;
  retailPrice?: number;
  priceGrossGrosze?: number;
  vatRate: number;
  initialStockQty?: number;
  categoryId?: string | null;
  saleUnit?: string | null;
  sellBy?: 'PIECE' | 'WEIGHT' | string | null;
  imageUrl?: string | null;
  idempotencyKey?: string;
}

export interface ProductAdminUpdateVariantInput {
  name?: string;
  barcode?: string | null;
  sku?: string | null;
  retailPrice?: number;
  priceGrossGrosze?: number;
  vatRate?: number;
  categoryId?: string | null;
  saleUnit?: string | null;
  sellBy?: 'PIECE' | 'WEIGHT' | string | null;
  imageUrl?: string | null;
  isActive?: boolean;
  expectedUpdatedAt?: string;
  expectedVersion?: number;
}

export interface ProductAdminDeactivateVariantInput {
  expectedUpdatedAt?: string;
  expectedVersion?: number;
  reason: string;
}

export type ProductStockAdjustmentMode = 'receive' | 'recount' | 'damage' | 'loss' | 'return';

export interface ProductAdminStockAdjustmentInput {
  mode: ProductStockAdjustmentMode;
  quantity?: number;
  newQuantity?: number;
  reason: string;
  expectedUpdatedAt?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
}

export interface ProductAdminStockAdjustment {
  id: string;
  variantId: string;
  mode: ProductStockAdjustmentMode;
  quantityDelta?: number;
  previousQuantity: number;
  newQuantity: number;
  reason: string;
  createdAt: string;
  createdBy?: string | null;
}

export interface ProductAdminProductMutationResponse {
  product: ProductAdminProductTemplate;
  variant: ProductAdminVariant;
  serverTime: string;
}

export interface ProductAdminVariantMutationResponse {
  variant: ProductAdminVariant;
  serverTime: string;
}

export interface ProductAdminStockAdjustmentResponse {
  adjustment: ProductAdminStockAdjustment;
  variant: ProductAdminVariant;
  serverTime: string;
}

export interface ProductAdminCategory {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number | null;
  isActive: boolean;
  updatedAt: string;
  version?: number;
}

export interface ProductAdminCategoryListResponse {
  categories: ProductAdminCategory[];
  serverTime: string;
}

export interface ProductAdminCategoryMutationInput {
  name: string;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number | null;
  /** Items in this category print a kitchen ticket when sold. */
  kitchenPrint?: boolean | null;
  expectedUpdatedAt?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
}

export interface ProductAdminCategoryMutationResponse {
  category: ProductAdminCategory;
  serverTime: string;
}

// ==========================================
// Forecast / Daily Ordering Types
// ==========================================

export type ForecastRiskLevel = 'ok' | 'watch' | 'reorder' | 'stockout';

export interface ForecastRunOptions {
  asOfDate?: string;      // YYYY-MM-DD, defaults to today
  horizonDays?: number;   // days to cover in the daily order
  historyDays?: number;   // days of local sales history to inspect
  categoryId?: string;
}

export interface ForecastDailyPoint {
  date: string;
  units: number;
}

export interface ReplenishmentPolicyDTO {
  variantId: string;
  leadTimeDays: number;
  safetyStockDays: number;
  minDisplayQty: number;
  packSize: number;
  maxStock: number | null;
  supplierName: string | null;
  updatedAt: string;
}

export interface ForecastRecommendationDTO {
  id: string;
  runId: string;
  variantId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  categoryId: string | null;
  categoryName: string | null;
  stockOnHand: number;
  avgDailyDemand: number;
  velocity7d: number;
  velocity30d: number;
  forecastUnits: number;
  forecastDaily: ForecastDailyPoint[];
  leadTimeDays: number;
  safetyStockDays: number;
  minDisplayQty: number;
  maxStock: number | null;
  reorderPoint: number;
  targetStock: number;
  suggestedOrderQty: number;
  packSize: number;
  estimatedRetailValue: number;
  riskLevel: ForecastRiskLevel;
  confidence: number;
  reason: string;
  warnings: string[];
  supplierName: string | null;
  updatedAt: string;
}

export interface ForecastRunDTO {
  id: string;
  generatedAt: string;
  asOfDate: string;
  horizonDays: number;
  historyDays: number;
  itemCount: number;
  totalSuggestedQty: number;
  totalEstimatedRetailValue: number;
  warnings: string[];
}

export interface ForecastOrderingResponse {
  run: ForecastRunDTO;
  recommendations: ForecastRecommendationDTO[];
}

export interface TodaySalesItemDTO {
  variantId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  categoryId: string | null;
  categoryName: string | null;
  quantity: number;
  revenue: number;
  orderCount: number;
  avgUnitPrice: number;
  stockOnHand: number;
  velocity7d: number;
  velocity30d: number;
  lastSoldAt: string | null;
}

export interface TodaySalesReportDTO {
  date: string;
  itemCount: number;
  totalUnits: number;
  totalRevenue: number;
  totalOrders: number;
  items: TodaySalesItemDTO[];
}

export type ForecastOrderDraftStatus = 'draft' | 'ordered' | 'received' | 'cancelled';

export interface ForecastOrderDraftLineInput {
  variantId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  supplierName: string | null;
  stockOnHand: number;
  velocity7d: number;
  velocity30d: number;
  suggestedOrderQty: number;
  orderQty: number;
  unitValue: number;
  reason: string;
}

export interface ForecastOrderDraftCreateInput {
  sourceRunId?: string | null;
  asOfDate: string;
  notes?: string | null;
  lines: ForecastOrderDraftLineInput[];
}

export interface ForecastOrderDraftLineDTO extends ForecastOrderDraftLineInput {
  id: string;
  draftId: string;
  estimatedRetailValue: number;
  sortOrder: number;
}

export interface ForecastOrderDraftDTO {
  id: string;
  status: ForecastOrderDraftStatus;
  sourceRunId: string | null;
  asOfDate: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  totalQty: number;
  totalEstimatedRetailValue: number;
  lines: ForecastOrderDraftLineDTO[];
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
  | 'orders'      // Order history tab
  | 'products'    // Product/catalog management tab
  | 'warehouse'   // Warehouse documents / Magazyn tab
  | 'forecast'    // Sales forecast and daily replenishment tab
  | 'pos'         // POS window
  | 'label'       // Quick product label printing
  | 'remote'      // Remote control
  | 'telegram'    // Telegram bot
  | 'security'    // Security camera AI
  | 'checkin'     // Check-in management
  | 'bookings'    // Dashboard-synced appointments calendar
  | 'billiard'    // Billiard floor plan
  | 'selfCheckout'; // Self-checkout kiosk window

/** Tabs available in the main window sidebar */
export type Tab = 'pos' | 'label' | 'selfCheckout' | 'billiard' | 'chat' | 'status' | 'booksy' | 'checkin' | 'bookings' | 'invoicing' | 'orders' | 'products' | 'warehouse' | 'forecast' | 'security' | 'settings' | 'debug';

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
  plan: 'free' | 'basic' | 'pro' | 'business' | 'enterprise';
  /**
   * Server-suggested POS template derived from salon.niche (nail → salon,
   * grocery → retail, ...). Applied on salon SWITCH only; null = no opinion.
   */
  suggestedPosMode?: 'retail' | 'salon' | 'b2b' | 'restaurant' | null;
  features: Record<FeatureKey, FeatureEntitlement>;
  fetchedAt: string;  // ISO date
  validUntil: string; // ISO date, cache validity
}

// Default entitlements for when offline or not fetched yet.
//
// SINGLE SOURCE OF TRUTH — used by BOTH the main process
// (entitlements-controller createDefaultEntitlements/normalize fallbacks)
// and the renderer (App.tsx isFeatureEnabled fallback). They used to be two
// diverging copies: main said pos:false while the renderer said pos:true,
// so JWT-logged-in machines (fetch 404 → main defaults) hid the POS tab
// while apiKey machines (fetch null → renderer defaults) showed it.
//
// Defaults are deliberately PERMISSIVE (visible unless clearly remote-only):
// real plan enforcement is the backend entitlements endpoint's job, and the
// per-device Module Manager (config.moduleOverrides) can hide anything.
export const DEFAULT_ENTITLEMENTS: Record<FeatureKey, boolean> = {
  chat: true,
  status: true,      // Always enabled
  booksy: true,
  invoicing: true,   // Free feature
  settings: true,    // Always enabled
  debug: true,
  orders: true,      // Order history — free, tied to POS sales
  products: true,    // Product/catalog management — free, tied to POS catalog
  warehouse: true,   // Warehouse documents — UI shell until backend posting exists
  forecast: true,    // Local sales forecast and daily ordering assistance
  pos: true,         // The till itself — never hide by default
  label: true,
  selfCheckout: true,
  remote: false,
  telegram: false,
  security: true,
  checkin: true,
  bookings: true,    // Dashboard-synced appointments — free
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
