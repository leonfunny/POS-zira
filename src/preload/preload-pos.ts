import { contextBridge, ipcRenderer } from 'electron';

console.log('[Preload-POS] Initializing...');

contextBridge.exposeInMainWorld('electronAPI', {
  // === POS State ===
  pos: {
    getState: () => ipcRenderer.invoke('pos:get-state'),
    dispatch: (action: any) => ipcRenderer.invoke('pos:dispatch', action),
    onStateChanged: (callback: (state: any) => void) => {
      const listener = (_e: any, state: any) => callback(state);
      ipcRenderer.on('pos:state-changed', listener);
      return () => ipcRenderer.removeListener('pos:state-changed', listener);
    },
    onFiscalUnknown: (callback: (info: { orderId?: string; orderNumber?: string; code: string; detail?: string }) => void) => {
      const listener = (_e: any, info: any) => callback(info);
      ipcRenderer.on('pos:fiscal-unknown', listener);
      return () => ipcRenderer.removeListener('pos:fiscal-unknown', listener);
    },
    // Database queries
    products: {
      getAll: () => ipcRenderer.invoke('pos:products:getAll'),
      getByCategory: (catId: string) => ipcRenderer.invoke('pos:products:getByCategory', catId),
      search: (query: string) => ipcRenderer.invoke('pos:products:search', query),
      searchByCode: (query: string) => ipcRenderer.invoke('pos:products:searchByCode', query),
      getByBarcode: (barcode: string) => ipcRenderer.invoke('pos:products:getByBarcode', barcode),
      getById: (id: string) => ipcRenderer.invoke('pos:products:getById', id),
    },
    categories: {
      getAll: () => ipcRenderer.invoke('pos:categories:getAll'),
    },
    productAdmin: {
      getCapabilities: () => ipcRenderer.invoke('pos:product-admin:capabilities'),
      createProduct: (payload: any) => ipcRenderer.invoke('pos:product-admin:create-product', payload),
      updateVariant: (variantId: string, payload: any) =>
        ipcRenderer.invoke('pos:product-admin:update-variant', variantId, payload),
      deactivateVariant: (variantId: string, payload: any) =>
        ipcRenderer.invoke('pos:product-admin:deactivate-variant', variantId, payload),
      adjustStock: (variantId: string, payload: any) =>
        ipcRenderer.invoke('pos:product-admin:adjust-stock', variantId, payload),
      listCategories: () => ipcRenderer.invoke('pos:product-admin:categories:list'),
      createCategory: (payload: any) => ipcRenderer.invoke('pos:product-admin:categories:create', payload),
      updateCategory: (categoryId: string, payload: any) =>
        ipcRenderer.invoke('pos:product-admin:categories:update', categoryId, payload),
    },
    orders: {
      create: (order: any, items: any[]) => ipcRenderer.invoke('pos:orders:create', order, items),
      getDailyStats: (date: string) => ipcRenderer.invoke('pos:orders:getDailyStats', date),
      getHistory: (filters: any) => ipcRenderer.invoke('pos:orders:getHistory', filters),
      getDetail: (orderId: string) => ipcRenderer.invoke('pos:orders:getDetail', orderId),
      deleteLocal: (orderId: string) => ipcRenderer.invoke('pos:orders:deleteLocal', orderId),
      mutate: (orderId: string, data: any) => ipcRenderer.invoke('pos:orders:mutate', orderId, data),
      refund: (orderId: string, data: any) => ipcRenderer.invoke('pos:orders:refund', orderId, data),
      downloadPdf: (orderId: string, kind: 'receipt' | 'invoice', invoiceType?: 'VAT' | 'PROFORMA') =>
        ipcRenderer.invoke('pos:orders:downloadPdf', orderId, kind, invoiceType),
      addInvoice: (orderId: string, data: { customerNip: string; invoiceType?: 'VAT' | 'PROFORMA' }) =>
        ipcRenderer.invoke('pos:orders:addInvoice', orderId, data),
      generateProforma: (orderId: string) => ipcRenderer.invoke('pos:orders:generateProforma', orderId),
      getServerHistory: (orderId: string) => ipcRenderer.invoke('pos:orders:getServerHistory', orderId),
      cancel: (orderId: string) => ipcRenderer.invoke('pos:orders:cancel', orderId),
      retrySync: (orderId: string) => ipcRenderer.invoke('pos:orders:retrySync', orderId),
      repairStockFailures: () => ipcRenderer.invoke('pos:orders:repairStockFailures'),
      getServerList: (params: any) => ipcRenderer.invoke('pos:orders:getServerList', params),
      getTodayServer: () => ipcRenderer.invoke('pos:orders:getTodayServer'),
    },
    nailTurns: {
      getToday: () => ipcRenderer.invoke('pos:nail-turns:getToday'),
      onUpdated: (callback: (data: { orderId?: string; checkedOut?: number }) => void) => {
        const listener = (_e: any, data: any) => callback(data);
        ipcRenderer.on('pos:nail-turns-updated', listener);
        return () => ipcRenderer.removeListener('pos:nail-turns-updated', listener);
      },
    },
    schedule: {
      getToday: (date?: string) => ipcRenderer.invoke('pos:schedule:getToday', date),
      getWeek: (from?: string, days?: number) => ipcRenderer.invoke('pos:schedule:getWeek', from, days),
      setStaffStatus: (payload: any) => ipcRenderer.invoke('pos:schedule:setStaffStatus', payload),
      assignNext: (payload: any) => ipcRenderer.invoke('pos:schedule:assignNext', payload),
      requestStaff: (payload: any) => ipcRenderer.invoke('pos:schedule:requestStaff', payload),
    },
    payment: {
      printReceipt: (orderId: string) => ipcRenderer.invoke('pos:print-receipt', orderId),
      printReceiptAndOpenDrawer: (orderId: string) => ipcRenderer.invoke('pos:print-receipt-and-open-drawer', orderId),
      printFiscalReceipt: (orderId: string) => ipcRenderer.invoke('pos:print-fiscal-receipt', orderId),
      hasFiscalPrinter: () => ipcRenderer.invoke('pos:has-fiscal-printer'),
      getReconcilableFiscalAttempt: (orderId: string) => ipcRenderer.invoke('pos:fiscal:get-reconcilable', orderId),
      reconcileFiscalAttempt: (orderId: string, didPrint: boolean) => ipcRenderer.invoke('pos:fiscal:reconcile', orderId, didPrint),
      openCashDrawer: () => ipcRenderer.invoke('pos:open-cash-drawer'),
      cardPayment: (data: { amount: number; orderId: string }) => ipcRenderer.invoke('pos:payment:card', data),
      onElavonStatus: (callback: (data: any) => void) => {
        const listener = (_e: any, data: any) => callback(data);
        ipcRenderer.on('pos:elavon-status', listener);
        return () => ipcRenderer.removeListener('pos:elavon-status', listener);
      },
    },
    scale: {
      readWeight: (options?: { port?: string }) => ipcRenderer.invoke('scale:read-weight', options),
      getNetworkInfo: () => ipcRenderer.invoke('scale:get-network-info'),
    },
    shift: {
      open: (data: { staffId: string; staffName: string; openingCash: number }) => ipcRenderer.invoke('pos:shift:open', data),
      close: (data: { shiftId: string; closingCash: number }) => ipcRenderer.invoke('pos:shift:close', data),
      getActive: () => ipcRenderer.invoke('pos:shift:getActive'),
    },
    sync: {
      products: () => ipcRenderer.invoke('pos:sync:products'),
      orders: () => ipcRenderer.invoke('pos:sync:orders'),
      onProductsSynced: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on('pos:products-synced', listener);
        return () => ipcRenderer.removeListener('pos:products-synced', listener);
      },
      onCatalogUpdated: (callback: (data: any) => void) => {
        const listener = (_e: any, data: any) => callback(data);
        ipcRenderer.on('pos:catalog-updated', listener);
        return () => ipcRenderer.removeListener('pos:catalog-updated', listener);
      },
      onStockUpdated: (callback: (data: any) => void) => {
        const listener = (_e: any, data: any) => callback(data);
        ipcRenderer.on('pos:stock-updated', listener);
        return () => ipcRenderer.removeListener('pos:stock-updated', listener);
      },
      onOrderSynced: (callback: (data: { orderId: string; backendId: string }) => void) => {
        const listener = (_e: any, data: any) => callback(data);
        ipcRenderer.on('pos:order-synced', listener);
        return () => ipcRenderer.removeListener('pos:order-synced', listener);
      },
      onOrderSyncFailed: (callback: (data: { orderId: string; orderNumber: string | null; error: string; code?: string }) => void) => {
        const listener = (_e: any, data: any) => callback(data);
        ipcRenderer.on('pos:order-sync-failed', listener);
        return () => ipcRenderer.removeListener('pos:order-sync-failed', listener);
      },
      onDraftProductsSynced: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on('pos:draft-products-synced', listener);
        return () => ipcRenderer.removeListener('pos:draft-products-synced', listener);
      },
    },
    draftProducts: {
      getAll: (limit?: number) => ipcRenderer.invoke('pos:draft-products:getAll', limit),
      getByStatus: (status: string) => ipcRenderer.invoke('pos:draft-products:getByStatus', status),
      getByBarcode: (barcode: string) => ipcRenderer.invoke('pos:draft-products:getByBarcode', barcode),
      getById: (id: string) => ipcRenderer.invoke('pos:draft-products:getById', id),
      searchByCode: (query: string) => ipcRenderer.invoke('pos:draft-products:searchByCode', query),
    },
    masterCatalog: {
      lookupByEan: (ean: string) => ipcRenderer.invoke('pos:master-catalog:lookup-by-ean', ean),
      scanCreate: (payload: { ean: string; purchasePrice?: number; retailPrice?: number; stockQty?: number; taxRate?: number; warehouseId?: string; idempotencyKey?: string }) =>
        ipcRenderer.invoke('pos:master-catalog:scan-create', payload),
      importDraft: (payload: { ean: string; retailPriceGrosze?: number }) =>
        ipcRenderer.invoke('pos:master-catalog:import-draft', payload),
    },
    quickAdd: {
      prepare: (payload: { images: Array<{ dataUrl: string; mimeType?: string }>; language?: string; idempotencyKey?: string }) =>
        ipcRenderer.invoke('pos:quick-add:prepare', payload),
      finalize: (payload: { productId: string; variantId: string; name?: string; retailPrice: number; quantity: number; idempotencyKey?: string }) =>
        ipcRenderer.invoke('pos:quick-add:finalize', payload),
    },
    recognition: {
      analyze: (payload: { images: Array<{ dataUrl?: string; url?: string; mimeType?: string }>; language?: string }) =>
        ipcRenderer.invoke('pos:recognition:analyze', payload),
      scanMatch: (payload: { images: Array<{ dataUrl?: string; url?: string; mimeType?: string }>; language?: string; limit?: number }) =>
        ipcRenderer.invoke('pos:recognition:scan-match', payload),
    },
    // Absolute file:// path to the webview bridge preload (for the embedded /add panel).
    getAddbridgePreloadPath: (): Promise<string> => ipcRenderer.invoke('app:addbridge-preload-path'),
    // Mode-specific: Tables (Restaurant)
    tables: {
      getAll: () => ipcRenderer.invoke('pos:tables:getAll'),
      getActive: () => ipcRenderer.invoke('pos:tables:getActive'),
      updateStatus: (id: string, status: string, orderId?: string) => ipcRenderer.invoke('pos:tables:updateStatus', id, status, orderId),
      clearTable: (id: string) => ipcRenderer.invoke('pos:tables:clearTable', id),
      setCovers: (id: string, covers: number) => ipcRenderer.invoke('pos:tables:setCovers', id, covers),
    },
    // Mode-specific: Customers (B2B)
    customers: {
      getAll: () => ipcRenderer.invoke('pos:customers:getAll'),
      search: (query: string) => ipcRenderer.invoke('pos:customers:search', query),
      getById: (id: string) => ipcRenderer.invoke('pos:customers:getById', id),
      increaseDebt: (id: string, amount: number) => ipcRenderer.invoke('pos:customers:increaseDebt', id, amount),
      lookupNip: (nip: string) => ipcRenderer.invoke('pos:customers:lookupNip', nip),
    },
    loyalty: {
      lookupCustomer: (phone: string) => ipcRenderer.invoke('pos:loyalty:lookupCustomer', phone),
    },
    // Mode-specific: Staff (Salon)
    staff: {
      getAll: () => ipcRenderer.invoke('pos:staff:getAll'),
      getAllForSettings: () => ipcRenderer.invoke('pos:staff:getAllForSettings'),
      create: (input: { name: string; commissionRate?: number; role?: string | null; isActive?: boolean }) =>
        ipcRenderer.invoke('pos:staff:create', input),
      update: (id: string, input: { name: string; commissionRate?: number; role?: string | null; isActive?: boolean }) =>
        ipcRenderer.invoke('pos:staff:update', id, input),
      setActive: (id: string, active: boolean) => ipcRenderer.invoke('pos:staff:setActive', id, active),
    },
    // Hold Orders (park/recall)
    hold: {
      create: (id: string, title: string, payload: any) => ipcRenderer.invoke('pos:hold:create', id, title, payload),
      list: () => ipcRenderer.invoke('pos:hold:list'),
      get: (id: string) => ipcRenderer.invoke('pos:hold:get', id),
      remove: (id: string) => ipcRenderer.invoke('pos:hold:remove', id),
    },
    // Quick Key Layouts
    quickKeys: {
      list: (mode?: string) => ipcRenderer.invoke('pos:quickkeys:list', mode),
      get: (id: string) => ipcRenderer.invoke('pos:quickkeys:get', id),
      create: (id: string, data: any) => ipcRenderer.invoke('pos:quickkeys:create', id, data),
      update: (id: string, data: any) => ipcRenderer.invoke('pos:quickkeys:update', id, data),
      remove: (id: string) => ipcRenderer.invoke('pos:quickkeys:remove', id),
      assign: (registerId: string, mode: string, layoutId: string) => ipcRenderer.invoke('pos:quickkeys:assign', registerId, mode, layoutId),
      getAssigned: (registerId: string, mode: string) => ipcRenderer.invoke('pos:quickkeys:getAssigned', registerId, mode),
    },
    // Customer display status events
    onCustomerDisplayStatus: (callback: (data: { responsive: boolean }) => void) => {
      const listener = (_e: any, data: any) => callback(data);
      ipcRenderer.on('customer-display:status', listener);
      return () => ipcRenderer.removeListener('customer-display:status', listener);
    },
    // Customer service request from display
    onCustomerRequest: (callback: (data: { id: string; serviceName: string }) => void) => {
      const listener = (_e: any, data: any) => callback(data);
      ipcRenderer.on('pos:customer-request', listener);
      return () => ipcRenderer.removeListener('pos:customer-request', listener);
    },
    // Customer check-in from display
    onCustomerCheckIn: (callback: (data: any) => void) => {
      const listener = (_e: any, data: any) => callback(data);
      ipcRenderer.on('pos:customer-checkin', listener);
      return () => ipcRenderer.removeListener('pos:customer-checkin', listener);
    },
    // Database save error events
    onDbSaveError: (callback: (data: { consecutiveFailures: number; dbPath: string }) => void) => {
      const listener = (_e: any, data: any) => callback(data);
      ipcRenderer.on('db:save-error', listener);
      return () => ipcRenderer.removeListener('db:save-error', listener);
    },
  },

  // Booksy (for Salon POS)
  booksy: {
    getBookings: () => ipcRenderer.invoke('booksy:get-bookings'),
  },

  // === Config ===
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (config: any) => ipcRenderer.invoke('set-config', config),
  saveConfig: (config: any) => ipcRenderer.invoke('set-config', config),
  printLabel: (barcode: string, text?: string, options?: { priceText?: string; sku?: string; text2?: string; text3?: string; quantity?: number; copies?: number }) =>
    ipcRenderer.invoke('print-label', barcode, text, options),

  // === Connection status ===
  getStatus: () => ipcRenderer.invoke('get-status'),
  onConnectionStatus: (callback: (status: any) => void) => {
    const listener = (_e: any, status: any) => callback(status);
    ipcRenderer.on('connection-status', listener);
    return () => ipcRenderer.removeListener('connection-status', listener);
  },

  // === Barcode scanner ===
  onBarcodeScanned: (callback: (barcode: string) => void) => {
    const listener = (_e: any, barcode: string) => callback(barcode);
    ipcRenderer.on('barcode-scanned', listener);
    return () => ipcRenderer.removeListener('barcode-scanned', listener);
  },
  sendKeyboardInput: (char: string) => {
    ipcRenderer.send('keyboard-input', char);
  },

  // === Auth ===
  auth: {
    getUser: () => ipcRenderer.invoke('auth-get-user'),
  },

  // === Window management ===
  window: {
    open: (id: string) => ipcRenderer.invoke('window:open', id),
    close: (id: string) => ipcRenderer.invoke('window:close', id),
    list: () => ipcRenderer.invoke('window:list'),
  },

  // === Dialog ===
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),

  // === Shell/URL operations ===
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // === Debug ===
  debug: {
    openDevTools: () => ipcRenderer.invoke('debug:open-devtools'),
  },
});

console.log('[Preload-POS] API exposed successfully');
