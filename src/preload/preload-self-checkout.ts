import { contextBridge, ipcRenderer } from 'electron';

// Narrow bridge for the public customer self-checkout kiosk. Do not reuse the
// broader customer-display preload here: the kiosk is a public surface and
// should only receive sale, catalog, scanner, payment-status, and help APIs.
contextBridge.exposeInMainWorld('electronAPI', {
  pos: {
    products: {
      getAll: () => ipcRenderer.invoke('pos:products:getAll'),
      getByBarcode: (barcode: string) =>
        ipcRenderer.invoke('pos:products:getByBarcode', barcode),
      getByCategory: (catId: string) =>
        ipcRenderer.invoke('pos:products:getByCategory', catId),
      search: (query: string) =>
        ipcRenderer.invoke('pos:products:search', query),
      searchByCode: (query: string) =>
        ipcRenderer.invoke('pos:products:searchByCode', query),
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
      onProductsSynced: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on('pos:products-synced', listener);
        return () => ipcRenderer.removeListener('pos:products-synced', listener);
      },
    },
  },

  onBarcodeScanned: (callback: (barcode: string) => void) => {
    const listener = (_event: any, barcode: string) => callback(barcode);
    ipcRenderer.on('barcode-scanned', listener);
    return () => ipcRenderer.removeListener('barcode-scanned', listener);
  },

  getConfig: () => ipcRenderer.invoke('get-config'),

  selfCheckout: {
    finalizePrint: (payload: { orderId: string; method: 'CASH' | 'CARD' | 'BLIK' }) =>
      ipcRenderer.invoke('self-checkout:finalize-print', payload),
    helpRequest: (payload: { reason: string; cartTotalGrosze: number }) =>
      ipcRenderer.invoke('self-checkout:help-request', payload),
    checkStatus: (id: string) =>
      ipcRenderer.invoke('self-checkout:help-status', id),
    close: () => ipcRenderer.invoke('self-checkout:close'),
  },
});
