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
  },
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: Record<string, unknown>) => ipcRenderer.invoke('set-config', config),
  display: {
    touch: () => ipcRenderer.invoke('display:touch'),
    requestService: (serviceId: string) => ipcRenderer.invoke('display:request-service', serviceId),
    getBookings: () => ipcRenderer.invoke('display:get-bookings'),
    checkIn: (data: { bookingId?: number; customerName: string; serviceName?: string; staffName?: string; bookingTime?: string; isWalkIn: boolean }) =>
      ipcRenderer.invoke('display:check-in', data),
    browseServices: () => ipcRenderer.invoke('display:browse-services'),
    backToCheckin: () => ipcRenderer.invoke('display:back-to-checkin'),
    backToIdle: () => ipcRenderer.invoke('display:back-to-idle'),
    ping: () => ipcRenderer.invoke('display:interaction-ping'),
    searchByPhone: (phone: string) => ipcRenderer.invoke('display:search-by-phone', phone),
    close: () => ipcRenderer.invoke('display:close'),
  },
});
