import { contextBridge, ipcRenderer } from 'electron';

console.log('[Preload-Display] Initializing...');

// Heartbeat: auto-reply pong when main process pings
ipcRenderer.on('display:ping', () => {
  ipcRenderer.send('display:pong');
});

contextBridge.exposeInMainWorld('electronAPI', {
  // Read-only POS state
  pos: {
    getState: () => ipcRenderer.invoke('pos:get-state'),
    onStateChanged: (callback: (state: any) => void) => {
      const listener = (_e: any, state: any) => callback(state);
      ipcRenderer.on('pos:state-changed', listener);
      return () => ipcRenderer.removeListener('pos:state-changed', listener);
    },
  },
  // Config (for language)
  getConfig: () => ipcRenderer.invoke('get-config'),
  // Customer display interactions
  display: {
    touch: () => ipcRenderer.invoke('display:touch'),
    requestService: (serviceId: string) => ipcRenderer.invoke('display:request-service', serviceId),
    getBookings: () => ipcRenderer.invoke('display:get-bookings'),
    checkIn: (data: { bookingId?: number; customerName: string; serviceName?: string; staffName?: string; bookingTime?: string; isWalkIn: boolean }) =>
      ipcRenderer.invoke('display:check-in', data),
    browseServices: () => ipcRenderer.invoke('display:browse-services'),
    backToIdle: () => ipcRenderer.invoke('display:back-to-idle'),
    ping: () => ipcRenderer.invoke('display:interaction-ping'),
    searchByPhone: (phone: string) => ipcRenderer.invoke('display:search-by-phone', phone),
    // Staff intentional exit — bypasses kiosk lock
    close: () => ipcRenderer.invoke('display:close'),
  },
});

console.log('[Preload-Display] API exposed successfully');
