import { writeFileSync } from 'node:fs';

export const persistOrder = (orderId: string): void => {
  writeFileSync('order.txt', orderId);
};
