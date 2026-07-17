import { persistOrder } from './leaf';

export const runCheckout = (orderId: string): void => persistOrder(orderId);
