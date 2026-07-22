import type { OrderItemRow } from '../database/repos/order-repo';
import {
  parseLocalRefundLines,
  type RefundIpcLine,
  type RefundIpcPayload,
} from './refund-backend-payload';
import {
  isValidSaleQuantity,
  normalizeSaleUnit,
  normalizeSellBy,
  roundSaleQuantity,
} from '../../shared/pos-sale';

interface StoredBilliardRefundLine {
  item: OrderItemRow;
  lineKey: string;
  refundPolicy: string;
  inventoryPolicy: string;
  originalQuantity: number;
  payableGrosze: number;
}

export interface SanitizedBilliardRefundRequest {
  amountGrosze: number;
  lines: RefundIpcLine[];
}

function requiredIntegerGrosze(value: unknown, field: string): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`Stored Billiard ${field} is invalid.`);
  }
  return amount;
}

function parseStoredLine(item: OrderItemRow): StoredBilliardRefundLine {
  if (!item.billiard_json) {
    throw new Error('Stored Billiard order contains a line without frozen refund metadata.');
  }
  let metadata: Record<string, any>;
  try {
    metadata = JSON.parse(item.billiard_json);
  } catch {
    throw new Error('Stored Billiard refund metadata is invalid.');
  }
  const lineKey = String(metadata.lineKey || '').trim();
  if (!lineKey) throw new Error('Stored Billiard refund identity is missing.');

  const sellBy = normalizeSellBy(item.sell_by ?? metadata.sellBy);
  const originalQuantity = roundSaleQuantity(
    Number(item.sale_quantity ?? item.quantity),
    sellBy,
  );
  if (originalQuantity <= 0 || !isValidSaleQuantity(originalQuantity, sellBy)) {
    throw new Error(`Stored Billiard quantity is invalid for line ${lineKey}.`);
  }

  const metadataPayable = requiredIntegerGrosze(metadata.payableGrosze, `payable amount for line ${lineKey}`);
  const persistedPayable = requiredIntegerGrosze(
    item.payable_total,
    `payable amount for line ${lineKey}`,
  );
  if (metadataPayable !== persistedPayable) {
    throw new Error(`Stored Billiard payable allocation differs for line ${lineKey}.`);
  }

  const refundPolicy = String(metadata.refundPolicy || item.refund_policy || '');
  const inventoryPolicy = String(metadata.inventoryPolicy || item.inventory_policy || '');
  if (
    refundPolicy !== String(item.refund_policy || '')
    || inventoryPolicy !== String(item.inventory_policy || '')
  ) {
    throw new Error(`Stored Billiard policy differs for line ${lineKey}.`);
  }

  return {
    item,
    lineKey,
    refundPolicy,
    inventoryPolicy,
    originalQuantity,
    payableGrosze: persistedPayable,
  };
}

/**
 * Rebuild a Billiard refund from immutable local order allocations. Renderer
 * money, restock flags, and generic amount-only refunds are never trusted.
 */
export function sanitizeBilliardRefundRequest(args: {
  data: RefundIpcPayload;
  orderItems: OrderItemRow[];
  refundLinesJson?: string | null;
  alreadyRefundedGrosze?: number | null;
}): SanitizedBilliardRefundRequest {
  const storedByKey = new Map<string, StoredBilliardRefundLine>();
  for (const item of args.orderItems) {
    const stored = parseStoredLine(item);
    if (storedByKey.has(stored.lineKey)) {
      throw new Error('Stored Billiard refund identity is duplicated.');
    }
    storedByKey.set(stored.lineKey, stored);
  }
  if (storedByKey.size === 0) {
    throw new Error('Stored Billiard refund lines are unavailable.');
  }

  if (args.data.type === 'FULL' && Array.from(storedByKey.values()).some(
    (line) => line.refundPolicy === 'FORBIDDEN',
  )) {
    throw new Error('Playing time and Billiard adjustments are non-refundable. Select refundable items only.');
  }

  const requestedLines = args.data.lines ?? [];
  if (requestedLines.length === 0) {
    throw new Error('Billiard refunds require at least one explicitly selected refundable line.');
  }
  if (Number(args.data.manualAdjustmentAmount || 0) !== 0) {
    throw new Error('Manual amount adjustments are not allowed for Billiard refunds.');
  }

  const previous = parseLocalRefundLines(args.refundLinesJson);
  if (Number(args.alreadyRefundedGrosze || 0) > 0 && previous.length === 0) {
    throw new Error('Previous Billiard refund line details are missing. Refresh the order before refunding again.');
  }

  const previousByKey = new Map<string, { quantity: number; amount: number }>();
  for (const line of previous) {
    const lineKey = String(line.billiardLineKey || line.lineKey || '').trim();
    if (!lineKey) continue;
    const stored = storedByKey.get(lineKey);
    if (!stored) throw new Error(`Previous Billiard refund refers to unknown line ${lineKey}.`);
    const sellBy = normalizeSellBy(stored.item.sell_by);
    const quantity = roundSaleQuantity(Number(line.quantity), sellBy);
    const amount = Number(line.refundAmount);
    if (
      quantity <= 0
      || !isValidSaleQuantity(quantity, sellBy)
      || !Number.isSafeInteger(amount)
      || amount <= 0
    ) {
      throw new Error(`Previous Billiard refund details are invalid for line ${lineKey}.`);
    }
    const current = previousByKey.get(lineKey) ?? { quantity: 0, amount: 0 };
    current.quantity = roundSaleQuantity(current.quantity + quantity, sellBy);
    current.amount += amount;
    if (current.quantity > stored.originalQuantity || current.amount > stored.payableGrosze) {
      throw new Error(`Previous Billiard refunds exceed frozen allocation for line ${lineKey}.`);
    }
    previousByKey.set(lineKey, current);
  }

  const requestedKeys = new Set<string>();
  const lines = requestedLines.map((requested): RefundIpcLine => {
    const lineKey = String(requested.billiardLineKey || '').trim();
    if (!lineKey) throw new Error('Billiard refund requires a valid stable line key.');
    if (requestedKeys.has(lineKey)) {
      throw new Error(`Billiard refund line ${lineKey} was selected more than once.`);
    }
    requestedKeys.add(lineKey);

    const stored = storedByKey.get(lineKey);
    if (!stored) throw new Error(`Billiard refund line ${lineKey} is not part of this order.`);
    if (stored.refundPolicy === 'FORBIDDEN') {
      throw new Error('Playing time and Billiard adjustments are non-refundable.');
    }
    if (stored.refundPolicy !== 'ALLOWED_NO_RESTOCK') {
      throw new Error(`Unsupported Billiard refund policy for line ${lineKey}.`);
    }

    const sellBy = normalizeSellBy(stored.item.sell_by);
    const previousRefund = previousByKey.get(lineKey) ?? { quantity: 0, amount: 0 };
    const remainingQuantity = roundSaleQuantity(
      stored.originalQuantity - previousRefund.quantity,
      sellBy,
    );
    const remainingAmount = stored.payableGrosze - previousRefund.amount;
    const selectedQuantity = roundSaleQuantity(Number(requested.quantity), sellBy);
    if (
      selectedQuantity <= 0
      || !isValidSaleQuantity(selectedQuantity, sellBy)
      || selectedQuantity > remainingQuantity
      || remainingAmount <= 0
    ) {
      throw new Error(`Billiard refund quantity exceeds the remaining allocation for line ${lineKey}.`);
    }

    const refundAmount = selectedQuantity >= remainingQuantity
      ? remainingAmount
      : Math.min(remainingAmount, Math.round(remainingAmount * selectedQuantity / remainingQuantity));
    if (refundAmount <= 0) {
      throw new Error(`No refundable amount remains for Billiard line ${lineKey}.`);
    }
    if (Number(requested.refundAmount) !== refundAmount) {
      throw new Error(`Billiard refund amount is stale or invalid for line ${lineKey}. Refresh the order and try again.`);
    }

    return {
      billiardLineKey: lineKey,
      variantId: stored.item.variant_id ?? undefined,
      sku: stored.item.sku ?? undefined,
      name: stored.item.name,
      quantity: selectedQuantity,
      unit: normalizeSaleUnit({ sale_unit: stored.item.sale_unit, sellBy }),
      unitPrice: remainingQuantity > 0 ? Math.round(remainingAmount / remainingQuantity) : 0,
      refundAmount,
      restock: false,
      vatRate: stored.item.vat_rate,
    };
  });

  const amountGrosze = lines.reduce((sum, line) => sum + line.refundAmount, 0);
  if (amountGrosze <= 0) throw new Error('No refundable amount remains for this Billiard order.');
  if (args.data.amount != null && Number(args.data.amount) !== amountGrosze) {
    throw new Error('Billiard refund total does not match its authoritative selected lines.');
  }

  return { amountGrosze, lines };
}
