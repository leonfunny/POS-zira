import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),

  pos: {
    products: {
      getAll: () => ipcRenderer.invoke('pos:products:getAll'),
    },
    categories: {
      getAll: () => ipcRenderer.invoke('pos:categories:getAll'),
    },
    sync: {
      onProductsSynced: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on('pos:products-synced', listener);
        return () => ipcRenderer.removeListener('pos:products-synced', listener);
      },
    },
  },

  kitchenSelfOrder: {
    submit: (payload: any) => ipcRenderer.invoke('kitchen-self-order:submit', payload),
    close: () => ipcRenderer.invoke('kitchen-self-order:close'),
  },
});
