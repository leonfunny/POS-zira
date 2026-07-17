import { ipcRenderer } from 'electron';

export const sendOrder = (orderId: string): void => {
  ipcRenderer.send('order:send', orderId);
};
