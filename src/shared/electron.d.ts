/**
 * Global type declaration for window.electronAPI
 *
 * This is a superset of all preload variants (main, POS, customer-display).
 * Each BrowserWindow only exposes a subset via contextBridge, but we declare
 * the full shape so renderer code can use any property without type errors.
 */

// Asset module declarations
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}

import type {
  AgentConfig,
  RemoteControlState,
  TelegramBotStatus,
  ZiraAIStatus,
  ZiraAIChatResponse,
  AuthUser,
  TelegramLoginTokenResponse,
  TelegramLoginTokenStatus,
  DeviceStatus,
  ConnectionStatus,
  BooksySyncStatus,
  BooksySyncConfig,
  BooksySyncReport,
  BooksyBookingSummary,
  BooksyCustomer,
  BooksyCustomerSyncReport,
  BooksyStaff,
  BooksyStaffSyncReport,
  BooksyEquipment,
  BooksyResourceSyncReport,
  BooksySyncAllReport,
  BooksyServiceCategory,
  BooksyServiceSyncReport,
  BooksyAddon,
  BooksyAddonSyncReport,
  FeatureKey,
  SalonEntitlements,
  DeleteConfirmConfig,
  SshTunnelStatus,
  UpdateStatus,
  InvoiceRow,
  InvoiceItemRow,
  InvoiceCreateDTO,
  InvoiceListFilter,
  InvoiceType,
  InvoiceCustomerRow,
  InvoiceCustomerCreateDTO,
  AccountingProductCreateDTO,
  SellerSettingsUpdateDTO,
  SecurityConfig,
  SecurityStatus,
  SecurityAlert,
  SecurityAnalytics,
  CheckinRecord,
  CheckinStats,
  CheckinStatus,
  SalonCustomer,
  ServiceRecommendation,
  CustomerServiceHistory,
} from './types';

// ── POS DB row types (mirrors repos) ──

interface PosProduct {
  id: string;
  template_id: string | null;
  name: string;
  sku: string | null;
  barcode: string | null;
  retail_price: number;
  category_id: string | null;
  image_url: string | null;
  in_stock: number;
  available_qty: number;
  vat_rate: number;
  is_active: number;
  is_on_sale: number;
  thumbnail_url: string | null;
  sale_unit: string | null;
  updated_at: string | null;
}

interface PosCategory {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sort_order: number;
  updated_at: string | null;
}

interface PosDailyStats {
  order_count: number;
  total_sales: number;
  cash_total: number;
  card_total: number;
}

interface PosOrderRow {
  id: string;
  order_number: string | null;
  status: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  payment_method: string | null;
  payment_amount: number;
  change_amount: number;
  staff_id: string | null;
  staff_name: string | null;
  shift_id: string | null;
  created_at: string;
  mode: string | null;
}

interface PosOrderItemRow {
  id: string;
  order_id: string;
  name: string;
  sku: string | null;
  price: number;
  quantity: number;
  total: number;
  vat_rate: number;
}

interface PosTable {
  id: string;
  name: string;
  zone: string | null;
  capacity: number;
  sort_order: number;
  is_active: number;
  status: string;
  current_order_id: string | null;
  covers: number;
  opened_at: string | null;
}

interface PosCustomer {
  id: string;
  name: string;
  nip: string | null;
  email: string | null;
  phone: string | null;
  credit_limit: number;
  current_debt: number;
  payment_terms: number;
}

interface PosStaff {
  id: string;
  name: string;
  commission_rate: number;
  is_active: number;
}

// ── ElectronAPI interface ──

interface ElectronAPI {
  // Config
  getConfig: () => Promise<AgentConfig>;
  setConfig: (config: Partial<AgentConfig>) => Promise<AgentConfig>;

  // Connection
  connect: () => Promise<{ success: boolean }>;
  connectWithApiKey: (apiKey: string) => Promise<{ success: boolean; data?: any; error?: string }>;
  disconnect: () => Promise<{ success: boolean }>;
  changeSalon: () => Promise<{ success: boolean; error?: string }>;
  getStatus: () => Promise<{ connected: boolean; deviceStatus: DeviceStatus | null }>;

  // Secure key setters
  setAiApiKey: (key: string) => Promise<{ success: boolean; error?: string }>;
  setRemotePin: (pin: string) => Promise<{ success: boolean; error?: string }>;
  getRemotePin: () => Promise<{ success: boolean; pin: string }>;

  // Printer
  listPorts: () => Promise<string[]>;
  listWindowsPrinters: () => Promise<Array<{name: string; port: string}>>;
  testPrint: () => Promise<{ success: boolean; error?: string; results?: Record<string, boolean> }>;
  testPrinterByType: (printerType: string) => Promise<{ success: boolean; error?: string }>;
  testPrinterByConfig: (config: import('./types').PrinterConfig, printerType?: string) => Promise<import('./types').TestPrintResult>;
  onTestPrintProgress: (callback: (step: import('./types').TestPrintStep) => void) => () => void;
  openLogFolder: () => Promise<{ success: boolean; path?: string; error?: string }>;
  calibratePrinter: (config: import('./types').PrinterConfig) => Promise<{ success: boolean; error?: string; paperSize?: { widthMm: number; heightMm: number } }>;
  getPosnetDriverStatus: () => Promise<{ devices: Array<{ vid: string; brand: string; model: string; windowsPrinterName: string | null; comPort: string | null; portName: string | null; connectionType: 'USB' | 'SERIAL' | 'NETWORK' | 'VIRTUAL'; driverInstalled: boolean; targetType?: string; recommendedProtocol?: string }>; posnetPresent: boolean; posnetComPort: string | null; posnetDriverInstalled: boolean }>;
  installPosnetDriver: () => Promise<{ success: boolean; message: string; rebootRequired?: boolean }>;
  scanForDriver: () => Promise<{ success: boolean; message: string }>;
  autoSetupPrinter: (printerType: string, device?: { vid: string; brand: string; model: string; windowsPrinterName: string | null; comPort: string | null; portName: string | null; connectionType: 'USB' | 'SERIAL' | 'NETWORK' | 'VIRTUAL'; driverInstalled: boolean; targetType?: string; recommendedProtocol?: string }) => Promise<{ success: boolean; port?: string; windowsPrinter?: string; message: string; action?: string }>;
  posnetScanDevices: () => Promise<{ success: boolean; devices: Array<{ serial: string; model: string; port: string; protocol: string; library: string; baudRate: number; status: string; lastSeen: string; capabilities: { fiscal: boolean; customerDisplay: boolean; cashDrawer: boolean; nip: boolean }; autoSelected: boolean }>; selectedDevice: any | null; requiresUserSelection: boolean; scannedPorts: string[]; warnings: string[] }>;
  posnetListDevices: () => Promise<{ version: number; lastScan: string; devices: Record<string, any>; selectedSerial: string | null }>;
  posnetSelectDevice: (serial: string) => Promise<{ success: boolean; device?: any; error?: string }>;
  posnetRescanKnown: () => Promise<{ success: boolean; devices: any[]; warnings: string[] }>;
  posnetDiagnosePort: (port: string, baudRate?: number) => Promise<import('./types').PosnetDiagnoseResult>;
  // Universal printer detection (all brands)
  universalScanDevices: () => Promise<{ success: boolean; devices: Array<{ id: string; brand: string; model: string; protocol: string; printerType: string; connectionType: string; windowsPrinterName?: string; port?: string; status: string; lastSeen: string; autoSelected: boolean }>; configured: any[]; warnings: string[] }>;
  universalListDevices: () => Promise<{ version: number; lastScan: string; devices: Record<string, any> }>;
  universalRescanKnown: () => Promise<{ success: boolean; devices: any[]; configured: any[]; warnings: string[] }>;
  universalRecoverDevice: (deviceId: string) => Promise<{ recovered: boolean; newIdentifier?: string; oldIdentifier: string; message: string }>;

  // Event listeners
  onConnectionStatus: (callback: (status: ConnectionStatus) => void) => () => void;
  onDeviceStatus: (callback: (status: DeviceStatus) => void) => () => void;
  onPrintJob: (callback: (job: any) => void) => () => void;
  onBarcodeScanned: (callback: (barcode: string) => void) => () => void;
  sendKeyboardInput: (char: string) => void;

  // Debug
  debug: {
    openDevTools: () => Promise<{ success: boolean }>;
    openLogs: () => Promise<{ success: boolean }>;
    getDiagnostics: () => Promise<{
      appVersion: string;
      electron: string;
      node: string;
      platform: string;
      userData: string;
      debugMode: boolean;
      connected: boolean;
      printerConnected: boolean;
      printerProtocol: string;
      scannerActive: boolean;
    }>;
  };

  // Auto-start
  setAutoStart: (enabled: boolean) => Promise<{ success: boolean }>;
  getAutoStart: () => Promise<{ openAtLogin: boolean }>;

  // Remote control
  remote: {
    getState: () => Promise<RemoteControlState>;
    acceptSession: () => Promise<{ success: boolean; error?: string }>;
    rejectSession: (reason?: string) => Promise<{ success: boolean }>;
    endSession: (reason?: string) => Promise<{ success: boolean }>;
    onStateChanged: (callback: (state: RemoteControlState) => void) => () => void;
  };

  // Telegram
  telegram: {
    getStatus: () => Promise<TelegramBotStatus>;
    restart: () => Promise<{ success: boolean; error?: string }>;
  };

  // Zira AI
  ai: {
    getStatus: () => Promise<ZiraAIStatus>;
    chat: (message: string, userId?: string, attachments?: { type: 'image' | 'video'; name: string; data: string; path?: string }[]) => Promise<{ success: boolean; data?: ZiraAIChatResponse; error?: string }>;
    clearHistory: (userId?: string) => Promise<{ success: boolean }>;
  };

  // Booksy Sync
  booksy: {
    getStatus: () => Promise<BooksySyncStatus>;
    getConfig: () => Promise<BooksySyncConfig>;
    setConfig: (config: Partial<BooksySyncConfig>) => Promise<BooksySyncConfig>;
    syncNow: () => Promise<BooksySyncReport | null>;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    getBookings: () => Promise<BooksyBookingSummary[]>;
    syncCustomers: () => Promise<BooksyCustomerSyncReport | null>;
    getCustomers: () => Promise<BooksyCustomer[]>;
    syncStaff: () => Promise<BooksyStaffSyncReport | null>;
    getStaff: () => Promise<BooksyStaff[]>;
    syncResources: () => Promise<BooksyResourceSyncReport | null>;
    getResources: () => Promise<BooksyEquipment[]>;
    syncServices: () => Promise<BooksyServiceSyncReport | null>;
    getServices: () => Promise<BooksyServiceCategory[]>;
    syncAddons: () => Promise<BooksyAddonSyncReport | null>;
    getAddons: () => Promise<BooksyAddon[]>;
    syncAll: () => Promise<BooksySyncAllReport | null>;
    onStatusChanged: (callback: (status: BooksySyncStatus) => void) => () => void;
    onBooksyJwtExpired: (callback: () => void) => () => void;
  };

  // Auth
  auth: {
    generateLoginToken: () => Promise<{ success: boolean; data?: TelegramLoginTokenResponse; error?: string }>;
    checkToken: (token: string) => Promise<{ success: boolean; data?: TelegramLoginTokenStatus; error?: string }>;
    generateRegisterToken: () => Promise<{ success: boolean; data?: TelegramLoginTokenResponse; error?: string }>;
    getUser: () => Promise<{ success: boolean; data?: { isAuthenticated: boolean; user?: AuthUser }; error?: string }>;
    logout: () => Promise<{ success: boolean }>;
    loginWithEmail: (email: string, password: string) => Promise<{ success: boolean; data?: { user: AuthUser }; error?: string }>;
  };

  // Window management
  window: {
    open: (id: string) => Promise<{ success: boolean; error?: string }>;
    close: (id: string) => Promise<{ success: boolean }>;
    list: () => Promise<string[]>;
    setFullScreen: (value: boolean) => Promise<{ success: boolean }>;
    setKiosk: (value: boolean) => Promise<{ success: boolean }>;
  };

  // Display info (list from main preload, touch from customer-display preload)
  display: {
    list: () => Promise<Array<{
      index: number;
      id: number;
      label: string;
      width: number;
      height: number;
      x: number;
      y: number;
      isPrimary: boolean;
    }>>;
    onRefreshConfig: (callback: () => void) => () => void;
    touch: () => Promise<{ success: boolean }>;
    requestService: (serviceId: string) => Promise<{ success: boolean }>;
    getBookings: () => Promise<BooksyBookingSummary[]>;
    checkIn: (data: { bookingId?: number; customerName: string; serviceName?: string; services?: Array<{ id: string; name: string; price?: number; duration?: number }>; staffName?: string; bookingTime?: string; isWalkIn: boolean }) =>
      Promise<{ success: boolean }>;
    browseServices: (categoryId?: string) => Promise<{ success: boolean }>;
    backToCheckin: () => Promise<{ success: boolean }>;
    backToIdle: () => Promise<{ success: boolean }>;
    ping: () => Promise<{ success: boolean }>;
    searchByPhone: (phone: string) => Promise<{ customers: any[]; bookings: any[] }>;
    /** Staff intentional exit — bypasses kiosk lock */
    close: () => Promise<{ success: boolean }>;
  };

  // Checkin
  checkin: {
    getToday: () => Promise<CheckinRecord[]>;
    getByDate: (date: string) => Promise<CheckinRecord[]>;
    create: (data: any) => Promise<{ success: boolean }>;
    createWithCustomer: (data: any) => Promise<{ success: boolean; bookingNumber?: string }>;
    updateStatus: (id: string, status: CheckinStatus) => Promise<{ success: boolean }>;
    startService: (id: string) => Promise<{ success: boolean }>;
    complete: (id: string) => Promise<{ success: boolean }>;
    markNoShow: (id: string) => Promise<{ success: boolean }>;
    searchPhone: (phone: string) => Promise<CheckinRecord[]>;
    addUpsells: (id: string, upsells: string[]) => Promise<{ success: boolean }>;
    updateNotes: (id: string, notes: string) => Promise<{ success: boolean }>;
    getStats: (date?: string) => Promise<CheckinStats>;
    printConfirmation: (data: { bookingNumber?: string; customerName: string; customerPhone?: string; customerNotes?: string; services: { name: string; price: number }[]; staffName?: string; checkinTime: string }) => Promise<{ success: boolean; error?: string }>;
  };

  // Salon Customers (check-in wizard)
  salonCustomer: {
    search: (query: string) => Promise<any[]>;
    getByPhone: (phone: string) => Promise<any | null>;
    create: (data: any) => Promise<{ success: boolean; data?: any }>;
    update: (id: string, data: any) => Promise<{ success: boolean }>;
    getHistory: (customerId: string) => Promise<any[]>;
    getRecommendations: (customerId: string) => Promise<any[]>;
  };

  // Service Popularity
  servicePopularity: {
    get: () => Promise<any[]>;
    refresh: () => Promise<{ success: boolean }>;
  };

  // Dialog
  selectFolder: () => Promise<string | null>;

  // Shell/URL operations
  shell: {
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
    launchChromeDebug: (port?: number) => Promise<{ success: boolean; chromePath?: string; error?: string }>;
  };

  // Chrome checker (for browser automation)
  chrome: {
    isRunning: () => Promise<{ success: boolean; isRunning: boolean; processCount: number; error?: string }>;
    checkAndPrompt: () => Promise<{
      success: boolean;
      isRunning: boolean;
      processCount?: number;
      userClosed?: boolean;
      forceClosed?: boolean;
      error?: string;
    }>;
    forceClose: () => Promise<{
      success: boolean;
      killed?: boolean;
      stillRunning?: boolean;
      cancelled?: boolean;
      error?: string;
    }>;
  };

  // Billiard Local Sync (cache-first reads + queue-aware writes)
  billiard: {
    getFloorOverview: () => Promise<any>;
    getSession: (id: string) => Promise<any>;
    getCombos: (activeOnly?: boolean) => Promise<any[]>;
    getFloorPlans: () => Promise<any[]>;
    getFnbProducts: (search?: string, categoryId?: string) => Promise<any[]>;
    getFnbCategories: () => Promise<any[]>;
    getResourceType: (code: string) => Promise<any>;
    getRestaurantCombos: () => Promise<any[]>;
    mutate: (op: string, method: string, path: string, body?: any) => Promise<any>;
    getSyncStatus: () => Promise<{ pending: number; lastSync: string | null; online: boolean }>;
    onDataUpdated: (callback: (data: { type: string }) => void) => () => void;
    printReceipt: (sessionId: string, payment: { method: string; amount: number }) => Promise<{ success: boolean; receiptPrinted: boolean }>;
    openCashDrawer: () => Promise<{ success: boolean }>;
  };

  // Generic REST API proxy (for billiard, etc.)
  apiCall: (method: string, path: string, body?: any) => Promise<any>;

  // Config save (used by App.tsx for language)
  saveConfig: (config: Partial<AgentConfig>) => Promise<AgentConfig>;

  // Invoicing
  invoice: {
    list: (filter?: InvoiceListFilter) => Promise<InvoiceRow[]>;
    get: (id: string) => Promise<InvoiceRow | null>;
    create: (data: InvoiceCreateDTO) => Promise<{ success: boolean; data?: InvoiceRow; error?: string }>;
    update: (id: string, data: Partial<InvoiceCreateDTO>) => Promise<{ success: boolean; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    issue: (id: string) => Promise<{ success: boolean; error?: string }>;
    cancel: (id: string, reason: string) => Promise<{ success: boolean; error?: string }>;
    duplicate: (id: string) => Promise<{ success: boolean; error?: string }>;
    print: (id: string, options?: any) => Promise<{ success: boolean; error?: string }>;
    printA4: (id: string) => Promise<{ success: boolean; error?: string }>;
    markPaid: (id: string) => Promise<{ success: boolean; error?: string }>;
    addPayment: (invoiceId: string, amount: number, method?: string, reference?: string) => Promise<{ success: boolean; error?: string }>;
    getNextNumber: (type: InvoiceType) => Promise<{ success: boolean; number?: string; error?: string }>;
    createCorrection: (originalId: string, reason: string, newItems: any[]) => Promise<{ success: boolean; data?: InvoiceRow; error?: string }>;
    convertProforma: (proformaId: string) => Promise<{ success: boolean; data?: InvoiceRow; error?: string }>;
    customer: {
      list: () => Promise<InvoiceCustomerRow[]>;
      search: (query: string) => Promise<InvoiceCustomerRow[]>;
      get: (id: string) => Promise<InvoiceCustomerRow | null>;
      create: (data: InvoiceCustomerCreateDTO) => Promise<{ success: boolean; data?: InvoiceCustomerRow; error?: string }>;
      update: (id: string, data: Partial<InvoiceCustomerCreateDTO>) => Promise<{ success: boolean; error?: string }>;
      delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    };
    product: {
      list: () => Promise<any[]>;
      search: (query: string) => Promise<any[]>;
      get: (id: string) => Promise<any>;
      create: (data: AccountingProductCreateDTO) => Promise<{ success: boolean; error?: string }>;
      update: (id: string, data: Partial<AccountingProductCreateDTO>) => Promise<{ success: boolean; error?: string }>;
      delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    };
    seller: {
      get: () => Promise<any>;
      update: (data: SellerSettingsUpdateDTO) => Promise<{ success: boolean; error?: string }>;
    };
    vatRates: {
      get: () => Promise<any>;
    };
    lookup: {
      nip: (nip: string) => Promise<any>;
      euVat: (vatId: string) => Promise<any>;
      auto: (identifier: string) => Promise<any>;
    };
    ksef: {
      send: (invoiceId: string) => Promise<{ success: boolean; error?: string }>;
      sendBatch: (invoiceIds: string[]) => Promise<{ success: boolean; error?: string }>;
      getStatus: () => Promise<any>;
      retry: (invoiceId: string) => Promise<{ success: boolean; error?: string }>;
    };
  };

  // Security Camera AI
  security: {
    getStatus: () => Promise<SecurityStatus>;
    getConfig: () => Promise<SecurityConfig | null>;
    setConfig: (config: SecurityConfig) => Promise<{ success: boolean }>;
    start: () => Promise<{ success: boolean; error?: string }>;
    stop: () => Promise<{ success: boolean; error?: string }>;
    restartCamera: (id: string) => Promise<{ success: boolean; error?: string }>;
    getAlerts: (limit?: number, cameraId?: string) => Promise<SecurityAlert[]>;
    clearAlerts: () => Promise<{ success: boolean }>;
    getAnalytics: (cameraId: string, date: string) => Promise<SecurityAnalytics | null>;
    onStatusChanged: (callback: (status: SecurityStatus) => void) => () => void;
    onAlert: (callback: (alert: SecurityAlert) => void) => () => void;
  };

  // POS
  pos: {
    getState: () => Promise<any>;
    dispatch: (action: any) => Promise<void>;
    seedDemo: () => Promise<{ success: boolean }>;
    onStateChanged: (callback: (state: any) => void) => () => void;

    products: {
      getAll: () => Promise<PosProduct[]>;
      getByCategory: (catId: string) => Promise<PosProduct[]>;
      search: (query: string) => Promise<PosProduct[]>;
      getByBarcode: (barcode: string) => Promise<PosProduct | null>;
    };
    categories: {
      getAll: () => Promise<PosCategory[]>;
    };
    orders: {
      create: (order: any, items: any[]) => Promise<{ success: boolean; id?: string; error?: string }>;
      getDailyStats: (date: string) => Promise<PosDailyStats>;
      getHistory: (filters: { from: string; to: string; paymentMethod?: string; staffName?: string; page?: number; limit?: number }) => Promise<{ orders: PosOrderRow[]; total: number; page: number; limit: number }>;
      getDetail: (orderId: string) => Promise<{ order: PosOrderRow; items: PosOrderItemRow[] } | null>;
      refund: (orderId: string, data: {
        type: 'FULL' | 'PARTIAL';
        reason?: string;
        lines?: Array<{ variantId?: string; sku?: string; name?: string; quantity: number; unitPrice: number; refundAmount: number; restock: boolean }>;
        manualAdjustmentAmount?: number;
      }) => Promise<{ success: boolean; refundAmount?: number; totalRefundedAmount?: number; status?: string; restocked?: any[]; error?: string }>;
      downloadPdf: (orderId: string, kind: 'receipt' | 'invoice', invoiceType?: 'VAT' | 'PROFORMA') => Promise<{ success: boolean; filePath?: string; error?: string }>;
      addInvoice: (orderId: string, data: { customerNip: string; invoiceType?: 'VAT' | 'PROFORMA' }) => Promise<{ success: boolean; order?: any; error?: string }>;
      generateProforma: (orderId: string) => Promise<{ success: boolean; proforma?: any; error?: string }>;
      getServerHistory: (orderId: string) => Promise<{ success: boolean; history?: any[]; error?: string }>;
      cancel: (orderId: string) => Promise<{ success: boolean; error?: string }>;
      retrySync: (orderId: string) => Promise<{ success: boolean; result?: any; summary?: any; error?: string }>;
      repairStockFailures: () => Promise<{ success: boolean; resetCount?: number; summary?: any; error?: string }>;
      getServerList: (params: { period?: string; page?: number; limit?: number }) => Promise<{ success: boolean; data?: { orders: any[]; total: number; page: number; limit: number }; error?: string }>;
      getTodayServer: () => Promise<{ success: boolean; orders?: any[]; count?: number; error?: string }>;
    };
    payment: {
      printReceipt: (orderId: string) => Promise<{ success: boolean; receiptPrinted: boolean; error?: string }>;
      reprintReceipt: (orderId: string) => Promise<{ success: boolean; receiptPrinted: boolean; error?: string }>;
      printRefundReceipt: (orderId: string) => Promise<{ success: boolean; receiptPrinted: boolean; error?: string }>;
      openCashDrawer: () => Promise<{ success: boolean }>;
      cardPayment: (data: { amount: number; orderId: string }) => Promise<{ success: boolean; error?: string }>;
      onElavonStatus: (callback: (data: any) => void) => () => void;
    };
    shift: {
      open: (data: { staffId: string; staffName: string; openingCash: number }) => Promise<{ success: boolean; shiftId?: string; error?: string }>;
      close: (data: { shiftId: string; closingCash: number }) => Promise<{ success: boolean; report?: any; error?: string }>;
      getActive: () => Promise<{ success: boolean; shift?: any; error?: string }>;
    };
    sync: {
      products: () => Promise<void>;
      orders: () => Promise<void>;
      onProductsSynced: (callback: () => void) => () => void;
      onCatalogUpdated: (callback: (data: any) => void) => () => void;
      onStockUpdated: (callback: (data: any) => void) => () => void;
      onOrderSynced: (callback: (data: { orderId: string; backendId: string }) => void) => () => void;
      onOrderSyncFailed: (callback: (data: { orderId: string; orderNumber: string | null; error: string; code?: string }) => void) => () => void;
      // Path B: Sync log conflicts
      getConflicts: () => Promise<any[]>;
      resolveConflict: (conflictId: number, resolution: string, adjustments?: any) => Promise<{ success: boolean; error?: string }>;
      getSyncMode: () => Promise<string>;
      onSyncEntry: (callback: (data: any) => void) => () => void;
    };
    tables: {
      getAll: () => Promise<PosTable[]>;
      getActive: () => Promise<PosTable[]>;
      updateStatus: (id: string, status: string, orderId?: string) => Promise<void>;
      clearTable: (id: string) => Promise<void>;
      setCovers: (id: string, covers: number) => Promise<void>;
    };
    customers: {
      getAll: () => Promise<PosCustomer[]>;
      search: (query: string) => Promise<PosCustomer[]>;
      getById: (id: string) => Promise<PosCustomer | null>;
      increaseDebt: (id: string, amount: number) => Promise<void>;
      lookupNip: (nip: string) => Promise<{ success: boolean; data?: any; error?: string }>;
    };
    staff: {
      getAll: () => Promise<PosStaff[]>;
    };
    hold: {
      create: (id: string, title: string, payload: any) => Promise<{ success: boolean }>;
      list: () => Promise<Array<{ id: string; title: string; createdAt: string; items: number; total: number; staffName?: string | null }>>;
      get: (id: string) => Promise<{ id: string; title: string; payload: any; createdAt: string } | null>;
      remove: (id: string) => Promise<{ success: boolean }>;
    };
    quickKeys: {
      list: (mode?: string) => Promise<any[]>;
      get: (id: string) => Promise<any>;
      create: (id: string, data: any) => Promise<{ success: boolean }>;
      update: (id: string, data: any) => Promise<{ success: boolean }>;
      remove: (id: string) => Promise<{ success: boolean }>;
      assign: (registerId: string, mode: string, layoutId: string) => Promise<{ success: boolean }>;
      getAssigned: (registerId: string, mode: string) => Promise<string | null>;
    };
    onCustomerDisplayStatus: (callback: (data: { responsive: boolean }) => void) => () => void;
    onCustomerRequest: (callback: (data: { id: string; serviceName: string }) => void) => () => void;
    onCustomerCheckIn: (callback: (data: { bookingId?: number; customerName: string; serviceName?: string; services?: Array<{ id: string; name: string; price?: number; duration?: number }>; staffName?: string; bookingTime?: string; isWalkIn: boolean }) => void) => () => void;
    onDbSaveError: (callback: (data: { consecutiveFailures: number; dbPath: string }) => void) => () => void;
  };

  // Feature Entitlements (SuperAdmin controlled)
  entitlements: {
    fetch: () => Promise<SalonEntitlements | null>;
    get: () => Promise<SalonEntitlements | null>;
    isEnabled: (feature: FeatureKey) => Promise<boolean>;
    onChanged: (callback: (entitlements: SalonEntitlements) => void) => () => void;
  };

  // Delete Confirmation
  deleteConfirm: {
    getConfig: () => Promise<DeleteConfirmConfig>;
    verify: (code: string) => Promise<{ valid: boolean }>;
  };

  // Auto-Update
  update: {
    check: () => Promise<any>;
    install: () => Promise<void>;
    onStatus: (callback: (data: UpdateStatus) => void) => () => void;
  };

  // SSH Tunnel
  sshTunnel: {
    getStatus: () => Promise<SshTunnelStatus>;
    disconnect: () => Promise<{ success: boolean }>;
    generateKey: () => Promise<{ success: boolean; publicKey?: string; error?: string }>;
    start: () => Promise<{ success: boolean; error?: string }>;
    onStatusChanged: (callback: (status: SshTunnelStatus) => void) => () => void;
  };

  // Daily Report (billiard)
  dailyReport: {
    get: (dateFrom: string, dateTo: string) => Promise<{ success: boolean; data?: any; error?: string }>;
  };

  // Happy Hour discount rules (billiard)
  happyHour: {
    getAll: () => Promise<{ success: boolean; data?: any[]; error?: string }>;
    upsert: (rule: {
      id: string;
      name: string;
      dayOfWeek: number;
      startTime: string;
      endTime: string;
      discountType: 'percent' | 'fixed';
      discountValue: number;
      scope: 'time' | 'fnb' | 'all';
      isActive: boolean;
    }) => Promise<any>;
    delete: (id: string) => Promise<any>;
  };

  // Kitchen Display System (billiard)
  kds: {
    getActive: () => Promise<any[]>;
    updateStatus: (orderId: string, status: string) => Promise<any>;
    onDataUpdated: (callback: (data: { type: string }) => void) => () => void;
  };

  // Reservations (billiard)
  reservation: {
    getUpcoming: () => Promise<{ success: boolean; data?: any[]; error?: string }>;
    upsert: (data: any) => Promise<any>;
    generate: (id: string) => Promise<any>;
    delete: (id: string) => Promise<any>;
  };

  // Billiard Guests
  billiardGuest: {
    search: (query: string) => Promise<{ success: boolean; data?: any[]; error?: string }>;
    upsert: (data: { id: string; name: string; phone: string; notes: string }) => Promise<any>;
  };

  // Session History (billiard)
  sessionHistory: {
    getTables: () => Promise<{ success: boolean; data?: any[] }>;
    get: (params: {
      dateFrom: string;
      dateTo: string;
      status?: string;
      resourceId?: string;
      search?: string;
      limit: number;
      offset: number;
    }) => Promise<{ success: boolean; data?: any; error?: string }>;
  };

  // Stock Management (billiard)
  stock: {
    getAll: () => Promise<{ success: boolean; data?: any[]; error?: string }>;
    update: (data: {
      variantId: string;
      variantName: string;
      quantity: number;
      lowThreshold: number;
      unit?: string;
    }) => Promise<any>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};


