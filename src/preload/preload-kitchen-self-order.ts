import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),

  kitchenSelfOrder: {
    getMenu: () => ipcRenderer.invoke('kitchen-self-order:getMenu'),
    submit: (payload: any) => ipcRenderer.invoke('kitchen-self-order:submit', payload),
    close: () => ipcRenderer.invoke('kitchen-self-order:close'),
    onMenuChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('pos:products-synced', listener);
      return () => ipcRenderer.removeListener('pos:products-synced', listener);
    },
  },
});
