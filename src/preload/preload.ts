import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  AgentConfig,
  RemoteControlState,
  TelegramBotStatus,
  ZiraAIStatus,
  ZiraAIChatResponse,
  AuthUser,
  TelegramLoginTokenResponse,
  TelegramLoginTokenStatus,
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
  InvoiceRow,
  InvoiceItemRow,
  InvoiceCustomerRow,
  AccountingProductRow,
  SellerSettingsRow,
  VatRateRow,
  InvoiceType,
  InvoiceCreateDTO,
  InvoiceListFilter,
  InvoiceCustomerCreateDTO,
  AccountingProductCreateDTO,
  SellerSettingsUpdateDTO,
  VatSummaryEntry,
  CompanyLookupResult,
  FeatureKey,
  SalonEntitlements,
  DeleteConfirmConfig,
  SshTunnelStatus,
  SecurityConfig,
  SecurityStatus,
  SecurityAlert,
  SecurityAnalytics,
} from '../shared/types';

// Log preload initialization
console.log('[Preload] Initializing...');

// Expose API to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Config
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_CONFIG),
  setConfig: (config: Partial<AgentConfig>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_CONFIG, config),
  saveConfig: (config: Partial<AgentConfig>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_CONFIG, config), // Alias for setConfig

  // Billiard Local Sync (cache-first reads + queue-aware writes)
  billiard: {
    getFloorOverview: () => ipcRenderer.invoke(IPC_CHANNELS.BILLIARD_GET_OVERVIEW),
    getSession: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.BILLIARD_GET_SESSION, id),
    getCombos: (activeOnly?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.BILLIARD_GET_COMBOS, activeOnly),
    getFloorPlans: () => ipcRenderer.invoke(IPC_CHANNELS.BILLIARD_GET_FLOOR_PLANS),
    getFnbProducts: (search?: string, categoryId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.BILLIARD_GET_FNB_PRODUCTS, search, categoryId),
    getFnbCategories: () => ipcRenderer.invoke(IPC_CHANNELS.BILLIARD_GET_FNB_CATEGORIES),
    getResourceType: (code: string) => ipcRenderer.invoke(IPC_CHANNELS.BILLIARD_GET_RESOURCE_TYPE, code),
    getRestaurantCombos: () => ipcRenderer.invoke(IPC_CHANNELS.BILLIARD_GET_RESTAURANT_COMBOS),
    mutate: (op: string, method: string, path: string, body?: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.BILLIARD_MUTATE, op, method, path, body),
    getSyncStatus: () => ipcRenderer.invoke(IPC_CHANNELS.BILLIARD_SYNC_STATUS),
    onDataUpdated: (cb: (data: { type: string }) => void) => {
      const listener = (_event: any, data: { type: string }) => cb(data);
      ipcRenderer.on(IPC_CHANNELS.BILLIARD_DATA_UPDATED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BILLIARD_DATA_UPDATED, listener);
    },
    printReceipt: (sessionId: string, payment: { method: string; amount: number }) =>
      ipcRenderer.invoke(IPC_CHANNELS.BILLIARD_PRINT_RECEIPT, sessionId, payment),
    openCashDrawer: () =>
      ipcRenderer.invoke(IPC_CHANNELS.BILLIARD_PRINT_OPEN_DRAWER),
  },

  // Generic REST API proxy (for billiard, etc.)
  apiCall: (method: string, path: string, body?: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.API_CALL, method, path, body),

  // Connection
  connect: () => ipcRenderer.invoke(IPC_CHANNELS.CONNECT),
  connectWithApiKey: (apiKey: string) => ipcRenderer.invoke(IPC_CHANNELS.CONNECT_WITH_API_KEY, apiKey),
  disconnect: () => ipcRenderer.invoke(IPC_CHANNELS.DISCONNECT),
  changeSalon: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_CHANGE_SALON),
  getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GET_STATUS),

  // Secure key setters
  setAiApiKey: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.AUTH_SET_AI_API_KEY, key),
  setRemotePin: (pin: string) => ipcRenderer.invoke(IPC_CHANNELS.AUTH_SET_REMOTE_PIN, pin),
  getRemotePin: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_GET_REMOTE_PIN),

  // Printer
  listPorts: () => ipcRenderer.invoke(IPC_CHANNELS.LIST_PORTS),
  listWindowsPrinters: () => ipcRenderer.invoke(IPC_CHANNELS.LIST_WINDOWS_PRINTERS),
  testPrint: () => ipcRenderer.invoke(IPC_CHANNELS.TEST_PRINT),
  testPrinterByType: (printerType: string) => ipcRenderer.invoke(IPC_CHANNELS.TEST_PRINTER_BY_TYPE, printerType),
  testPrinterByConfig: (config: any, printerType?: string) => ipcRenderer.invoke(IPC_CHANNELS.TEST_PRINTER_BY_CONFIG, config, printerType),
  calibratePrinter: (config: any) => ipcRenderer.invoke(IPC_CHANNELS.CALIBRATE_PRINTER, config),
  getPosnetDriverStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GET_POSNET_DRIVER_STATUS),
  installPosnetDriver: () => ipcRenderer.invoke(IPC_CHANNELS.INSTALL_POSNET_DRIVER),
  scanForDriver: () => ipcRenderer.invoke(IPC_CHANNELS.SCAN_FOR_DRIVER),
  autoSetupPrinter: (printerType: string, device?: any) => ipcRenderer.invoke(IPC_CHANNELS.AUTO_SETUP_PRINTER, printerType, device),
  posnetScanDevices: () => ipcRenderer.invoke(IPC_CHANNELS.POSNET_SCAN_DEVICES),
  posnetListDevices: () => ipcRenderer.invoke(IPC_CHANNELS.POSNET_LIST_DEVICES),
  posnetSelectDevice: (serial: string) => ipcRenderer.invoke(IPC_CHANNELS.POSNET_SELECT_DEVICE, serial),
  posnetRescanKnown: () => ipcRenderer.invoke(IPC_CHANNELS.POSNET_RESCAN_KNOWN),
  // Universal printer detection (all brands)
  universalScanDevices: () => ipcRenderer.invoke(IPC_CHANNELS.UNIVERSAL_SCAN_DEVICES),
  universalListDevices: () => ipcRenderer.invoke(IPC_CHANNELS.UNIVERSAL_LIST_DEVICES),
  universalRescanKnown: () => ipcRenderer.invoke(IPC_CHANNELS.UNIVERSAL_RESCAN_KNOWN),
  universalRecoverDevice: (deviceId: string) => ipcRenderer.invoke(IPC_CHANNELS.UNIVERSAL_RECOVER_DEVICE, deviceId),

  // Event listeners
  onConnectionStatus: (callback: (status: any) => void) => {
    const listener = (_event: any, status: any) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.CONNECTION_STATUS, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CONNECTION_STATUS, listener);
  },

  onDeviceStatus: (callback: (status: any) => void) => {
    const listener = (_event: any, status: any) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.DEVICE_STATUS, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DEVICE_STATUS, listener);
  },

  onPrintJob: (callback: (job: any) => void) => {
    const listener = (_event: any, job: any) => callback(job);
    ipcRenderer.on(IPC_CHANNELS.PRINT_JOB, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PRINT_JOB, listener);
  },

  onBarcodeScanned: (callback: (barcode: string) => void) => {
    const listener = (_event: any, barcode: string) => callback(barcode);
    ipcRenderer.on(IPC_CHANNELS.BARCODE_SCANNED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BARCODE_SCANNED, listener);
  },

  // Send keyboard input for scanner detection
  sendKeyboardInput: (char: string) => {
    ipcRenderer.send(IPC_CHANNELS.KEYBOARD_INPUT, char);
  },

  // Debug functions
  debug: {
    openDevTools: () => ipcRenderer.invoke(IPC_CHANNELS.DEBUG_OPEN_DEVTOOLS),
    openLogs: () => ipcRenderer.invoke(IPC_CHANNELS.DEBUG_OPEN_LOGS),
    getDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.DEBUG_GET_DIAGNOSTICS),
  },

  // Auto-start functions
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.APP_SET_AUTO_START, enabled),
  getAutoStart: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_AUTO_START),

  // Remote control functions
  remote: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.REMOTE_GET_STATE),
    acceptSession: () => ipcRenderer.invoke(IPC_CHANNELS.REMOTE_ACCEPT_SESSION),
    rejectSession: (reason?: string) => ipcRenderer.invoke(IPC_CHANNELS.REMOTE_REJECT_SESSION, reason),
    endSession: (reason?: string) => ipcRenderer.invoke(IPC_CHANNELS.REMOTE_END_SESSION, reason),
    onStateChanged: (callback: (state: RemoteControlState) => void) => {
      const listener = (_event: any, state: RemoteControlState) => callback(state);
      ipcRenderer.on(IPC_CHANNELS.REMOTE_STATE_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.REMOTE_STATE_CHANGED, listener);
    },
  },

  // Telegram remote control functions
  telegram: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_GET_STATUS),
    restart: () => ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_RESTART),
  },

  // Zira AI functions
  ai: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.AI_GET_STATUS),
    chat: (message: string, userId?: string, attachments?: { type: 'image' | 'video'; name: string; data: string; path?: string }[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_CHAT, message, userId, attachments),
    clearHistory: (userId?: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_CLEAR_HISTORY, userId),
  },

  // Booksy Sync functions
  booksy: {
    getStatus: (): Promise<BooksySyncStatus> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_GET_STATUS),
    getConfig: (): Promise<BooksySyncConfig> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_GET_CONFIG),
    setConfig: (config: Partial<BooksySyncConfig>): Promise<BooksySyncConfig> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_SET_CONFIG, config),
    syncNow: (): Promise<BooksySyncReport | null> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_SYNC_NOW),
    start: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_START),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_STOP),
    getBookings: (): Promise<BooksyBookingSummary[]> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_GET_BOOKINGS),
    syncCustomers: (): Promise<BooksyCustomerSyncReport | null> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_SYNC_CUSTOMERS),
    getCustomers: (): Promise<BooksyCustomer[]> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_GET_CUSTOMERS),
    syncStaff: (): Promise<BooksyStaffSyncReport | null> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_SYNC_STAFF),
    getStaff: (): Promise<BooksyStaff[]> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_GET_STAFF),
    syncResources: (): Promise<BooksyResourceSyncReport | null> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_SYNC_RESOURCES),
    getResources: (): Promise<BooksyEquipment[]> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_GET_RESOURCES),
    syncServices: (): Promise<BooksyServiceSyncReport | null> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_SYNC_SERVICES),
    getServices: (): Promise<BooksyServiceCategory[]> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_GET_SERVICES),
    syncAddons: (): Promise<BooksyAddonSyncReport | null> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_SYNC_ADDONS),
    getAddons: (): Promise<BooksyAddon[]> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_GET_ADDONS),
    syncAll: (): Promise<BooksySyncAllReport | null> => ipcRenderer.invoke(IPC_CHANNELS.BOOKSY_SYNC_ALL),
    onStatusChanged: (callback: (status: BooksySyncStatus) => void) => {
      const listener = (_event: any, status: BooksySyncStatus) => callback(status);
      ipcRenderer.on(IPC_CHANNELS.BOOKSY_STATUS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BOOKSY_STATUS_CHANGED, listener);
    },
  },

  // Auth functions (Telegram Login)
  auth: {
    generateLoginToken: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_TELEGRAM_LOGIN_TOKEN),
    checkToken: (token: string) => ipcRenderer.invoke(IPC_CHANNELS.AUTH_CHECK_TOKEN, token),
    generateRegisterToken: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_REGISTER_TOKEN),
    getUser: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_GET_USER),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGOUT),
    loginWithEmail: (email: string, password: string) => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGIN_EMAIL, email, password),
  },

  // Window management
  window: {
    open: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_OPEN, id),
    close: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE, id),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_LIST),
    setFullScreen: (value: boolean) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_FULLSCREEN, value),
    setKiosk: (value: boolean) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_KIOSK, value),
  },

  // Display info
  display: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.DISPLAY_LIST),
  },

  // Dialog
  selectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDER),

  // Shell/URL operations
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url),
    launchChromeDebug: (port?: number) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_LAUNCH_CHROME_DEBUG, port),
  },

  // Chrome checker (for browser automation)
  chrome: {
    isRunning: () => ipcRenderer.invoke(IPC_CHANNELS.CHROME_IS_RUNNING),
    checkAndPrompt: () => ipcRenderer.invoke(IPC_CHANNELS.CHROME_CHECK_AND_PROMPT),
    forceClose: () => ipcRenderer.invoke(IPC_CHANNELS.CHROME_FORCE_CLOSE),
  },

  // Invoicing API
  invoice: {
    // Invoice CRUD
    list: (filter?: InvoiceListFilter) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_LIST, filter),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_GET, id),
    create: (data: InvoiceCreateDTO) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_CREATE, data),
    update: (id: string, data: Partial<InvoiceCreateDTO>) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_UPDATE, id, data),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_DELETE, id),
    issue: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_ISSUE, id),
    cancel: (id: string, reason: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_CANCEL, id, reason),
    duplicate: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_DUPLICATE, id),
    print: (id: string, options?: any) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_PRINT, id, options),
    printA4: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_PRINT_A4, id),
    markPaid: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_MARK_PAID, id),
    addPayment: (invoiceId: string, amount: number, method?: string, reference?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.INVOICE_ADD_PAYMENT, invoiceId, amount, method, reference),
    getNextNumber: (type: InvoiceType) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_GET_NEXT_NUMBER, type),
    createCorrection: (originalId: string, reason: string, newItems: any[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.INVOICE_CREATE_CORRECTION, originalId, reason, newItems),
    convertProforma: (proformaId: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_CONVERT_PROFORMA, proformaId),

    // Customers
    customer: {
      list: () => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_CUSTOMER_LIST),
      search: (query: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_CUSTOMER_SEARCH, query),
      get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_CUSTOMER_GET, id),
      create: (data: InvoiceCustomerCreateDTO) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_CUSTOMER_CREATE, data),
      update: (id: string, data: Partial<InvoiceCustomerCreateDTO>) =>
        ipcRenderer.invoke(IPC_CHANNELS.INVOICE_CUSTOMER_UPDATE, id, data),
      delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_CUSTOMER_DELETE, id),
    },

    // Products
    product: {
      list: () => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_PRODUCT_LIST),
      search: (query: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_PRODUCT_SEARCH, query),
      get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_PRODUCT_GET, id),
      create: (data: AccountingProductCreateDTO) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_PRODUCT_CREATE, data),
      update: (id: string, data: Partial<AccountingProductCreateDTO>) =>
        ipcRenderer.invoke(IPC_CHANNELS.INVOICE_PRODUCT_UPDATE, id, data),
      delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_PRODUCT_DELETE, id),
    },

    // Settings
    seller: {
      get: () => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_SELLER_GET),
      update: (data: SellerSettingsUpdateDTO) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_SELLER_UPDATE, data),
    },

    vatRates: {
      get: () => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_VAT_RATES_GET),
    },

    // NIP/VAT Lookup
    lookup: {
      nip: (nip: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_LOOKUP_NIP, nip),
      euVat: (vatId: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_LOOKUP_EU_VAT, vatId),
      auto: (identifier: string) => ipcRenderer.invoke(IPC_CHANNELS.INVOICE_LOOKUP_AUTO, identifier),
    },

    // KSeF
    ksef: {
      send: (invoiceId: string) => ipcRenderer.invoke(IPC_CHANNELS.KSEF_SEND, invoiceId),
      sendBatch: (invoiceIds: string[]) => ipcRenderer.invoke(IPC_CHANNELS.KSEF_SEND_BATCH, invoiceIds),
      getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.KSEF_GET_STATUS),
      retry: (invoiceId: string) => ipcRenderer.invoke(IPC_CHANNELS.KSEF_RETRY, invoiceId),
    },
  },

  // Checkin
  checkin: {
    getToday: () => ipcRenderer.invoke(IPC_CHANNELS.CHECKIN_GET_TODAY),
    getByDate: (date: string) => ipcRenderer.invoke(IPC_CHANNELS.CHECKIN_GET_BY_DATE, date),
    create: (data: any) => ipcRenderer.invoke(IPC_CHANNELS.CHECKIN_CREATE, data),
    createWithCustomer: (data: any) => ipcRenderer.invoke(IPC_CHANNELS.CHECKIN_CREATE_WITH_CUSTOMER, data),
    updateStatus: (id: string, status: string) => ipcRenderer.invoke(IPC_CHANNELS.CHECKIN_UPDATE_STATUS, id, status),
    startService: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CHECKIN_START_SERVICE, id),
    complete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CHECKIN_COMPLETE, id),
    markNoShow: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CHECKIN_MARK_NO_SHOW, id),
    searchPhone: (phone: string) => ipcRenderer.invoke(IPC_CHANNELS.CHECKIN_SEARCH_PHONE, phone),
    addUpsells: (id: string, upsells: string[]) => ipcRenderer.invoke(IPC_CHANNELS.CHECKIN_ADD_UPSELLS, id, upsells),
    updateNotes: (id: string, notes: string) => ipcRenderer.invoke(IPC_CHANNELS.CHECKIN_UPDATE_NOTES, id, notes),
    getStats: (date?: string) => ipcRenderer.invoke(IPC_CHANNELS.CHECKIN_GET_STATS, date),
    printConfirmation: (data: any) => ipcRenderer.invoke(IPC_CHANNELS.CHECKIN_PRINT_CONFIRMATION, data),
  },

  // Salon Customers (check-in wizard)
  salonCustomer: {
    search: (query: string) => ipcRenderer.invoke(IPC_CHANNELS.SALON_CUSTOMER_SEARCH, query),
    getByPhone: (phone: string) => ipcRenderer.invoke(IPC_CHANNELS.SALON_CUSTOMER_GET_BY_PHONE, phone),
    create: (data: any) => ipcRenderer.invoke(IPC_CHANNELS.SALON_CUSTOMER_CREATE, data),
    update: (id: string, data: any) => ipcRenderer.invoke(IPC_CHANNELS.SALON_CUSTOMER_UPDATE, id, data),
    getHistory: (customerId: string) => ipcRenderer.invoke(IPC_CHANNELS.SALON_CUSTOMER_GET_HISTORY, customerId),
    getRecommendations: (customerId: string) => ipcRenderer.invoke(IPC_CHANNELS.SALON_CUSTOMER_GET_RECOMMENDATIONS, customerId),
  },

  // Service Popularity
  servicePopularity: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.SERVICE_POPULARITY_GET),
    refresh: () => ipcRenderer.invoke(IPC_CHANNELS.SERVICE_POPULARITY_REFRESH),
  },

  // Feature Entitlements (SuperAdmin controlled)
  entitlements: {
    fetch: (): Promise<SalonEntitlements | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.ENTITLEMENTS_FETCH),
    get: (): Promise<SalonEntitlements | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.ENTITLEMENTS_GET),
    isEnabled: (feature: FeatureKey): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.ENTITLEMENTS_IS_ENABLED, feature),
    onChanged: (callback: (entitlements: SalonEntitlements) => void) => {
      const listener = (_event: any, entitlements: SalonEntitlements) => callback(entitlements);
      ipcRenderer.on(IPC_CHANNELS.ENTITLEMENTS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.ENTITLEMENTS_CHANGED, listener);
    },
  },

  // Delete Confirmation
  deleteConfirm: {
    getConfig: (): Promise<DeleteConfirmConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.DELETE_CONFIRM_GET_CONFIG),
    verify: (code: string): Promise<{ valid: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.DELETE_CONFIRM_VERIFY, code),
  },

  // Auto-Update
  update: {
    check: () => ipcRenderer.invoke(IPC_CHANNELS.CHECK_FOR_UPDATES),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.INSTALL_UPDATE),
    onStatus: (callback: (data: any) => void) => {
      const listener = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_STATUS, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_STATUS, listener);
    },
  },

  // SSH Tunnel
  sshTunnel: {
    getStatus: (): Promise<SshTunnelStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_GET_STATUS),
    disconnect: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_DISCONNECT),
    generateKey: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_GENERATE_KEY),
    start: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_START),
    onStatusChanged: (callback: (status: SshTunnelStatus) => void) => {
      const listener = (_event: any, status: SshTunnelStatus) => callback(status);
      ipcRenderer.on(IPC_CHANNELS.SSH_TUNNEL_STATUS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SSH_TUNNEL_STATUS_CHANGED, listener);
    },
  },

  // Security Camera AI
  security: {
    getStatus: (): Promise<SecurityStatus> => ipcRenderer.invoke(IPC_CHANNELS.SECURITY_GET_STATUS),
    getConfig: (): Promise<SecurityConfig | null> => ipcRenderer.invoke(IPC_CHANNELS.SECURITY_GET_CONFIG),
    setConfig: (config: SecurityConfig): Promise<{ success: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.SECURITY_SET_CONFIG, config),
    start: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke(IPC_CHANNELS.SECURITY_START),
    stop: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke(IPC_CHANNELS.SECURITY_STOP),
    restartCamera: (id: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke(IPC_CHANNELS.SECURITY_RESTART_CAMERA, id),
    getAlerts: (limit?: number, cameraId?: string): Promise<SecurityAlert[]> => ipcRenderer.invoke(IPC_CHANNELS.SECURITY_GET_ALERTS, limit, cameraId),
    clearAlerts: (): Promise<{ success: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.SECURITY_CLEAR_ALERTS),
    getAnalytics: (cameraId: string, date: string): Promise<SecurityAnalytics | null> => ipcRenderer.invoke(IPC_CHANNELS.SECURITY_GET_ANALYTICS, cameraId, date),
    onStatusChanged: (callback: (status: SecurityStatus) => void) => {
      const listener = (_event: any, status: SecurityStatus) => callback(status);
      ipcRenderer.on(IPC_CHANNELS.SECURITY_STATUS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SECURITY_STATUS_CHANGED, listener);
    },
    onAlert: (callback: (alert: SecurityAlert) => void) => {
      const listener = (_event: any, alert: SecurityAlert) => callback(alert);
      ipcRenderer.on(IPC_CHANNELS.SECURITY_ALERT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SECURITY_ALERT, listener);
    },
  },

  // POS (embedded tab in main window)
  pos: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.POS_GET_STATE),
    dispatch: (action: any) => ipcRenderer.invoke(IPC_CHANNELS.POS_DISPATCH, action),
    seedDemo: () => ipcRenderer.invoke('pos:seed-demo'),
    onStateChanged: (callback: (state: any) => void) => {
      const listener = (_e: any, state: any) => callback(state);
      ipcRenderer.on(IPC_CHANNELS.POS_STATE_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.POS_STATE_CHANGED, listener);
    },
    products: {
      getAll: () => ipcRenderer.invoke(IPC_CHANNELS.POS_PRODUCTS_GET_ALL),
      getByCategory: (catId: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_PRODUCTS_GET_BY_CATEGORY, catId),
      search: (query: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_PRODUCTS_SEARCH, query),
      getByBarcode: (barcode: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_PRODUCTS_GET_BY_BARCODE, barcode),
    },
    categories: {
      getAll: () => ipcRenderer.invoke(IPC_CHANNELS.POS_CATEGORIES_GET_ALL),
    },
    orders: {
      create: (order: any, items: any[]) => ipcRenderer.invoke(IPC_CHANNELS.POS_ORDERS_CREATE, order, items),
      getDailyStats: (date: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_ORDERS_GET_DAILY_STATS, date),
      getHistory: (filters: { from: string; to: string; paymentMethod?: string; staffName?: string }) => ipcRenderer.invoke('pos:orders:getHistory', filters),
      getDetail: (orderId: string) => ipcRenderer.invoke('pos:orders:getDetail', orderId),
      refund: (orderId: string, data: { type: string; amount?: number; reason?: string }) =>
        ipcRenderer.invoke('pos:orders:refund', orderId, data),
    },
    payment: {
      printReceipt: (orderId: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_PRINT_RECEIPT, orderId),
      reprintReceipt: (orderId: string) => ipcRenderer.invoke('pos:reprint-receipt', orderId),
      openCashDrawer: () => ipcRenderer.invoke(IPC_CHANNELS.POS_OPEN_CASH_DRAWER),
      cardPayment: (data: { amount: number; orderId: string }) => ipcRenderer.invoke(IPC_CHANNELS.POS_PAYMENT_CARD, data),
      onElavonStatus: (callback: (data: any) => void) => {
        const listener = (_e: any, data: any) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.POS_ELAVON_STATUS, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.POS_ELAVON_STATUS, listener);
      },
    },
    shift: {
      open: (data: { staffId: string; staffName: string; openingCash: number }) => ipcRenderer.invoke(IPC_CHANNELS.POS_SHIFT_OPEN, data),
      close: (data: { shiftId: string; closingCash: number }) => ipcRenderer.invoke(IPC_CHANNELS.POS_SHIFT_CLOSE, data),
    },
    sync: {
      products: () => ipcRenderer.invoke(IPC_CHANNELS.POS_SYNC_PRODUCTS),
      orders: () => ipcRenderer.invoke(IPC_CHANNELS.POS_SYNC_ORDERS),
      onProductsSynced: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on(IPC_CHANNELS.POS_PRODUCTS_SYNCED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.POS_PRODUCTS_SYNCED, listener);
      },
      onCatalogUpdated: (callback: (data: any) => void) => {
        const listener = (_e: any, data: any) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.POS_CATALOG_UPDATED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.POS_CATALOG_UPDATED, listener);
      },
      onStockUpdated: (callback: (data: any) => void) => {
        const listener = (_e: any, data: any) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.POS_STOCK_UPDATED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.POS_STOCK_UPDATED, listener);
      },
      // Path B: Sync log conflicts
      getConflicts: () => ipcRenderer.invoke('pos:sync:conflicts'),
      resolveConflict: (conflictId: number, resolution: string, adjustments?: any) =>
        ipcRenderer.invoke('pos:sync:resolve-conflict', conflictId, resolution, adjustments),
      getSyncMode: () => ipcRenderer.invoke('pos:sync:mode'),
      onSyncEntry: (callback: (data: any) => void) => {
        const listener = (_e: any, data: any) => callback(data);
        ipcRenderer.on('pos:sync-entry', listener);
        return () => ipcRenderer.removeListener('pos:sync-entry', listener);
      },
    },
    tables: {
      getAll: () => ipcRenderer.invoke(IPC_CHANNELS.POS_TABLES_GET_ALL),
      getActive: () => ipcRenderer.invoke(IPC_CHANNELS.POS_TABLES_GET_ACTIVE),
      updateStatus: (id: string, status: string, orderId?: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_TABLES_UPDATE_STATUS, id, status, orderId),
      clearTable: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_TABLES_CLEAR, id),
      setCovers: (id: string, covers: number) => ipcRenderer.invoke(IPC_CHANNELS.POS_TABLES_SET_COVERS, id, covers),
    },
    customers: {
      getAll: () => ipcRenderer.invoke(IPC_CHANNELS.POS_CUSTOMERS_GET_ALL),
      search: (query: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_CUSTOMERS_SEARCH, query),
      getById: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_CUSTOMERS_GET_BY_ID, id),
      increaseDebt: (id: string, amount: number) => ipcRenderer.invoke(IPC_CHANNELS.POS_CUSTOMERS_INCREASE_DEBT, id, amount),
    },
    staff: {
      getAll: () => ipcRenderer.invoke(IPC_CHANNELS.POS_STAFF_GET_ALL),
    },
    hold: {
      create: (id: string, title: string, payload: any) => ipcRenderer.invoke(IPC_CHANNELS.POS_HOLD_CREATE, id, title, payload),
      list: () => ipcRenderer.invoke(IPC_CHANNELS.POS_HOLD_LIST),
      get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_HOLD_GET, id),
      remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_HOLD_REMOVE, id),
    },
    quickKeys: {
      list: (mode?: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_QUICKKEYS_LIST, mode),
      get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_QUICKKEYS_GET, id),
      create: (id: string, data: any) => ipcRenderer.invoke(IPC_CHANNELS.POS_QUICKKEYS_CREATE, id, data),
      update: (id: string, data: any) => ipcRenderer.invoke(IPC_CHANNELS.POS_QUICKKEYS_UPDATE, id, data),
      remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_QUICKKEYS_REMOVE, id),
      assign: (registerId: string, mode: string, layoutId: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_QUICKKEYS_ASSIGN, registerId, mode, layoutId),
      getAssigned: (registerId: string, mode: string) => ipcRenderer.invoke(IPC_CHANNELS.POS_QUICKKEYS_GET_ASSIGNED, registerId, mode),
    },
    onCustomerDisplayStatus: (callback: (data: { responsive: boolean }) => void) => {
      const listener = (_e: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.POS_CUSTOMER_DISPLAY_STATUS, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.POS_CUSTOMER_DISPLAY_STATUS, listener);
    },
    onCustomerRequest: (callback: (data: { id: string; serviceName: string }) => void) => {
      const listener = (_e: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.POS_CUSTOMER_REQUEST, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.POS_CUSTOMER_REQUEST, listener);
    },
    onCustomerCheckIn: (callback: (data: any) => void) => {
      const listener = (_e: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.POS_CUSTOMER_CHECKIN, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.POS_CUSTOMER_CHECKIN, listener);
    },
    onDbSaveError: (callback: (data: { consecutiveFailures: number; dbPath: string }) => void) => {
      const listener = (_e: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.POS_DB_SAVE_ERROR, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.POS_DB_SAVE_ERROR, listener);
    },
  },
});

console.log('[Preload] API exposed successfully');
