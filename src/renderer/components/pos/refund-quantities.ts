export interface RefundQuantityOrder {
  total: number;
  refund_amount?: number | null;
  refund_lines?: string | null;
}

export interface RefundQuantityItem {
  id: string;
  variant_id?: string | null;
  sku?: string | null;
  name: string;
  price: number;
  quantity: number;
  billiard_json?: string | null;
}

export interface RefundLineLike {
  billiardLineKey?: string | null;
  variantId?: string | null;
  variant_id?: string | null;
  sku?: string | null;
  name?: string | null;
  quantity?: number | string | null;
}

export type RemainingRefundableItem<T extends RefundQuantityItem> = T & { maxQty: number };

function parseRefundLines(raw: string | null | undefined): RefundLineLike[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function lineMatchesItem(line: RefundLineLike, item: RefundQuantityItem): boolean {
  if (line.billiardLineKey && item.billiard_json) {
    try {
      if (JSON.parse(item.billiard_json)?.lineKey === line.billiardLineKey) return true;
    } catch { /* fall through to legacy identities */ }
  }
  const lineVariantId = line.variantId ?? line.variant_id;
  if (lineVariantId && item.variant_id) return lineVariantId === item.variant_id;
  if (line.sku && item.sku) return line.sku === item.sku;
  return Boolean(line.name && line.name === item.name);
}

export function getSafeRemainingTotal(order: RefundQuantityOrder): number {
  return Math.max(0, order.total - (order.refund_amount ?? 0));
}

export function hasRefundOverage(order: RefundQuantityOrder): boolean {
  return (order.refund_amount ?? 0) > order.total;
}

export function getRemainingRefundableItems<T extends RefundQuantityItem>(
  order: RefundQuantityOrder,
  items: T[],
): { items: Array<RemainingRefundableItem<T>>; unsafeMissingRefundLines: boolean } {
  const alreadyRefunded = order.refund_amount ?? 0;
  const refundLines = parseRefundLines(order.refund_lines);
  if (alreadyRefunded > 0 && (!refundLines || refundLines.length === 0)) {
    return { items: [], unsafeMissingRefundLines: true };
  }

  const remainingItems = items.map((item) => {
    const refundedQty = (refundLines ?? []).reduce((sum, line) => {
      if (!lineMatchesItem(line, item)) return sum;
      const qty = typeof line.quantity === 'number'
        ? line.quantity
        : parseFloat(String(line.quantity ?? '')) || 0;
      return sum + qty;
    }, 0);
    return {
      ...item,
      maxQty: Math.max(0, item.quantity - refundedQty),
    };
  });

  return { items: remainingItems, unsafeMissingRefundLines: false };
}
