export type KitchenSelfOrderLanguage = 'pl' | 'vi' | 'en';
export type KitchenSelfOrderFulfillment = 'DINE_IN' | 'TAKEAWAY';
export type KitchenSelfOrderStatus =
  | 'SUBMITTED'
  | 'PRINTED'
  | 'PARTIAL_PRINT'
  | 'PRINT_FAILED'
  | 'CANCELLED';

export const KITCHEN_SELF_ORDER_QR_PREFIX = 'KSO1:';

export interface KitchenSelfOrderItemInput {
  variantId?: string | null;
  productId?: string | null;
  name: string;
  quantity: number;
  note?: string | null;
  options?: string[] | null;
}

export interface KitchenSelfOrderSubmitInput {
  customerLanguage: KitchenSelfOrderLanguage;
  fulfillmentType: KitchenSelfOrderFulfillment;
  sourceLabel?: string | null;
  items: KitchenSelfOrderItemInput[];
}

export interface KitchenSelfOrderQrItem {
  variantId?: string | null;
  productId?: string | null;
  name?: string | null;
  quantity: number;
  note?: string | null;
  options?: string[];
}

export interface KitchenSelfOrderQrPayload {
  type: 'KSO';
  version: 1;
  orderNumber: string;
  orderId?: string;
  createdAt?: string;
  fulfillmentType?: KitchenSelfOrderFulfillment;
  customerLanguage?: KitchenSelfOrderLanguage;
  sourceLabel?: string | null;
  items: KitchenSelfOrderQrItem[];
}

export function normalizeKitchenSelfOrderLanguage(value: unknown): KitchenSelfOrderLanguage {
  return value === 'vi' || value === 'en' ? value : 'pl';
}

export function normalizeKitchenSelfOrderFulfillment(value: unknown): KitchenSelfOrderFulfillment {
  return value === 'TAKEAWAY' ? 'TAKEAWAY' : 'DINE_IN';
}

export function formatKitchenSelfOrderNumber(sequenceNumber: number): string {
  const safe = Math.max(1, Math.floor(Number(sequenceNumber) || 1));
  return `K-${String(safe).padStart(3, '0')}`;
}

export function businessDateFromIso(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

export function normalizeKitchenSelfOrderQuantity(value: unknown): number {
  return Math.min(99, Math.max(1, Math.floor(Number(value) || 1)));
}

export function sanitizeKitchenSelfOrderNote(value: unknown): string | null {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, 180);
}

export function sanitizeKitchenSelfOrderOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = sanitizeKitchenSelfOrderNote(item);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= 8) break;
  }
  return out;
}
