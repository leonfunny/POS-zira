import { createHash } from 'crypto';
import {
  calculateLineTotalGrosze,
  isValidSaleQuantity,
  normalizeSaleUnit,
  normalizeSellBy,
} from '../../shared/pos-sale';
import {
  POS_CHECKOUT_SNAPSHOT_VERSION,
  type PosHoldPayload,
} from '../../shared/billiard-pos-handoff';
import type { CartItem, PosState } from './pos-store';
import {
  capturePosCheckoutSnapshot,
  type PosSnapshotScope,
} from './billiard-pos-handoff';

export interface LegacyHeldCartRow {
  id?: unknown;
  items?: unknown;
  total?: unknown;
  createdAt?: unknown;
}

export interface LegacyHeldCartImport {
  id: string;
  title: string;
  payload: PosHoldPayload;
}

function requiredText(value: unknown, field: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`Legacy held cart is missing ${field}`);
  return text;
}

function money(value: unknown, field: string): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`Legacy held cart has invalid ${field}`);
  }
  return amount;
}

function normalizeItem(value: unknown, index: number): CartItem {
  const raw = value as Record<string, any> | null;
  if (!raw || typeof raw !== 'object') throw new Error(`Legacy held cart item ${index + 1} is invalid`);
  // Frozen Billiard lines belong exclusively to the durable handoff journal.
  if (raw.billiard || raw.locked === true) throw new Error('Legacy held cart contains a protected checkout line');
  const sellBy = normalizeSellBy(raw.sellBy);
  const quantity = Number(raw.quantity);
  if (!Number.isFinite(quantity) || !isValidSaleQuantity(quantity, sellBy)) {
    throw new Error(`Legacy held cart item ${index + 1} has invalid quantity`);
  }
  const price = money(raw.price, `item ${index + 1} price`);
  const vatRate = raw.vatRate == null ? 0 : Number(raw.vatRate);
  if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) {
    throw new Error(`Legacy held cart item ${index + 1} has invalid VAT`);
  }
  return {
    id: requiredText(raw.id ?? `legacy-line-${index + 1}`, `item ${index + 1} id`),
    variantId: requiredText(raw.variantId, `item ${index + 1} variantId`),
    name: requiredText(raw.name, `item ${index + 1} name`),
    sku: String(raw.sku ?? ''),
    price,
    quantity,
    saleUnit: normalizeSaleUnit({ saleUnit: raw.saleUnit, sellBy }),
    sellBy,
    total: calculateLineTotalGrosze(price, quantity, sellBy),
    imageUrl: raw.imageUrl ? String(raw.imageUrl) : undefined,
    staffId: raw.staffId ? String(raw.staffId) : undefined,
    staffName: raw.staffName ? String(raw.staffName) : undefined,
    duration: Number.isFinite(Number(raw.duration)) ? Number(raw.duration) : undefined,
    notes: raw.notes ? String(raw.notes) : undefined,
    course: Number.isFinite(Number(raw.course)) ? Number(raw.course) : undefined,
    vatRate,
    name_translations: raw.name_translations == null ? null : String(raw.name_translations),
  };
}

export function buildLegacyHeldCartImport(args: {
  raw: LegacyHeldCartRow;
  index: number;
  currentState: PosState;
  scope: PosSnapshotScope;
  posMode: string;
}): LegacyHeldCartImport {
  if (!Array.isArray(args.raw?.items) || args.raw.items.length === 0 || args.raw.items.length > 500) {
    throw new Error('Legacy held cart has no valid items');
  }
  const items = args.raw.items.map(normalizeItem);
  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  const rawTotal = Number(args.raw.total);
  const total = Number.isSafeInteger(rawTotal) && rawTotal >= 0 && rawTotal <= subtotal ? rawTotal : subtotal;
  const tax = items.reduce((sum, item) => {
    const rate = Number(item.vatRate) || 0;
    return rate > 0 ? sum + Math.round(item.total - item.total * 100 / (100 + rate)) : sum;
  }, 0);
  const state: PosState = {
    ...args.currentState,
    cart: {
      items,
      subtotal,
      discount: subtotal - total,
      discountType: subtotal > total ? 'fixed' : undefined,
      discountPercent: undefined,
      tax,
      total,
    },
    checkoutDraft: {},
    activeTable: null,
    activeCustomer: null,
    tip: 0,
    display: { ...args.currentState.display, mode: 'cart' },
  };
  const identity = createHash('sha256').update(JSON.stringify({
    userId: args.scope.userId,
    legacyId: args.raw.id ?? null,
    createdAt: args.raw.createdAt ?? null,
    items,
    total,
  })).digest('hex').slice(0, 32);
  const created = typeof args.raw.createdAt === 'string' && !Number.isNaN(Date.parse(args.raw.createdAt))
    ? new Date(args.raw.createdAt)
    : null;
  const time = created ? created.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : `#${args.index + 1}`;
  return {
    id: `legacy-held:${identity}`,
    title: `Imported held cart · ${time}`,
    payload: {
      schemaVersion: POS_CHECKOUT_SNAPSHOT_VERSION,
      holdReason: 'MANUAL',
      protected: false,
      snapshot: capturePosCheckoutSnapshot(state, args.scope, args.posMode),
    },
  };
}
