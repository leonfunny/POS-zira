import { contextBridge, ipcRenderer } from 'electron';

// Heartbeat: auto-reply pong when main process pings
ipcRenderer.on('display:ping', () => {
  ipcRenderer.send('display:pong');
});

contextBridge.exposeInMainWorld('electronAPI', {
  pos: {
    getState: () => ipcRenderer.invoke('pos:get-state'),
    onStateChanged: (callback: (state: any) => void) => {
      const listener = (_e: any, state: any) => callback(state);
      ipcRenderer.on('pos:state-changed', listener);
      return () => ipcRenderer.removeListener('pos:state-changed', listener);
    },
    products: {
      getByBarcode: (barcode: string) =>
        ipcRenderer.invoke('pos:products:getByBarcode', barcode),
      getByCategory: (catId: string) =>
        ipcRenderer.invoke('pos:products:getByCategory', catId),
    },
    categories: {
      getAll: () => ipcRenderer.invoke('pos:categories:getAll'),
    },
    orders: {
      create: (order: any, items: any[]) =>
        ipcRenderer.invoke('pos:orders:create', order, items),
    },
    payment: {
      printReceipt: (orderId: string) =>
        ipcRenderer.invoke('pos:print-receipt', orderId),
      cardPayment: (data: { amount: number; orderId: string }) =>
        ipcRenderer.invoke('pos:payment:card', data),
      onElavonStatus: (callback: (data: any) => void) => {
        const listener = (_e: any, data: any) => callback(data);
        ipcRenderer.on('pos:elavon-status', listener);
        return () => ipcRenderer.removeListener('pos:elavon-status', listener);
      },
    },
    sync: {
      orders: () => ipcRenderer.invoke('pos:sync:orders'),
    },
  },
  onBarcodeScanned: (callback: (barcode: string) => void) => {
    const listener = (_event: any, barcode: string) => callback(barcode);
    ipcRenderer.on('barcode-scanned', listener);
    return () => ipcRenderer.removeListener('barcode-scanned', listener);
  },
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: Record<string, unknown>) => ipcRenderer.invoke('set-config', config),
  display: {
    onRefreshConfig: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('customer-display:refresh-config', listener);
      return () => ipcRenderer.removeListener('customer-display:refresh-config', listener);
    },
    touch: () => ipcRenderer.invoke('display:touch'),
    requestService: (serviceId: string) => ipcRenderer.invoke('display:request-service', serviceId),
    getBookings: () => ipcRenderer.invoke('display:get-bookings'),
    checkIn: (data: { bookingId?: number; customerName: string; serviceName?: string; services?: Array<{ id: string; name: string; price?: number; duration?: number }>; staffName?: string; bookingTime?: string; isWalkIn: boolean }) =>
      ipcRenderer.invoke('display:check-in', data),
    browseServices: (categoryId?: string) => ipcRenderer.invoke('display:browse-services', categoryId),
    backToCheckin: () => ipcRenderer.invoke('display:back-to-checkin'),
    backToIdle: () => ipcRenderer.invoke('display:back-to-idle'),
    ping: () => ipcRenderer.invoke('display:interaction-ping'),
    searchByPhone: (phone: string) => ipcRenderer.invoke('display:search-by-phone', phone),
    close: () => ipcRenderer.invoke('display:close'),
  },
  selfCheckout: {
    /**
     * Customer pressed "Wezwij obsługę". Body carries the reason
     * (one of MISTAKE / CANT_PAY / ITEM_ISSUE / PRICE_DISPUTE / OTHER)
     * and a snapshot of the cart total.
     */
    helpRequest: (payload: { reason: string; cartTotalGrosze: number }) =>
      ipcRenderer.invoke('self-checkout:help-request', payload),
    /**
     * Poll the backend for help-request progress (acknowledged /
     * resolved). Cheaper than wiring a socket listener for the kiosk
     * window when staff usually responds within 10-30 s.
     */
    checkStatus: (id: string) =>
      ipcRenderer.invoke('self-checkout:help-status', id),
    /**
     * Staff intentional exit for the self-checkout kiosk. Used by the
     * three-finger swipe-down gesture from the top edge.
     */
    close: () => ipcRenderer.invoke('self-checkout:close'),
  },
});
