export interface RefundBreakdownOrder {
  refund_lines?: string | null;
}

export interface RefundBreakdownItem {
  id: string;
  variant_id?: string | null;
  sku?: string | null;
  name: string;
  quantity: number;
  total: number;
  sale_unit?: string | null;
  sell_by?: string | null;
  billiard_json?: string | null;
}

export interface RefundBreakdownLine {
  billiardLineKey?: string | null;
  orderItemId?: string | null;
  variantId?: string | null;
  variant_id?: string | null;
  sku?: string | null;
  name: string;
  quantity: number;
  refundAmount: number;
  unitPrice?: number;
  vatRate?: number;
  unit?: string | null;
  saleUnit?: string | null;
  sellBy?: string | null;
  restock?: boolean;
  refundedAt?: string | null;
  refundRequestId?: string | null;
  reason?: string | null;
  refundMethod?: string | null;
}

export interface RefundEvent {
  key: string;
  refundedAt: string | null;
  refundRequestId: string | null;
  reason: string | null;
  refundMethod: string | null;
  lines: RefundBreakdownLine[];
  refundAmount: number;
}

export interface ItemRefundBreakdown<T extends RefundBreakdownItem> {
  item: T;
  refundedQty: number;
  remainingQty: number;
  refundedAmount: number;
  remainingAmount: number;
  lines: RefundBreakdownLine[];
}

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

function parseQuantity(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : 0;
}

export function parseRefundBreakdownLines(raw: string | null | undefined): RefundBreakdownLine[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((line: any): RefundBreakdownLine => ({
        billiardLineKey: line.billiardLineKey ?? line.billiard_line_key ?? null,
        orderItemId: line.orderItemId ?? line.order_item_id ?? null,
        variantId: line.variantId ?? line.variant_id ?? null,
        variant_id: line.variant_id ?? null,
        sku: line.sku ?? null,
        name: String(line.name ?? line.productName ?? line.product_name ?? '').trim(),
        quantity: parseQuantity(line.quantity),
        refundAmount: Math.round(toNumber(line.refundAmount)),
        unitPrice: line.unitPrice == null ? undefined : Math.round(toNumber(line.unitPrice)),
        vatRate: line.vatRate == null ? undefined : toNumber(line.vatRate),
        unit: line.unit ?? line.saleUnit ?? line.sale_unit ?? null,
        saleUnit: line.saleUnit ?? line.sale_unit ?? line.unit ?? null,
        sellBy: line.sellBy ?? line.sell_by ?? null,
        restock: typeof line.restock === 'boolean' ? line.restock : undefined,
        refundedAt: line.refundedAt ?? line.refunded_at ?? null,
        refundRequestId: line.refundRequestId ?? line.refund_request_id ?? null,
        reason: line.reason ?? line.refundReason ?? line.refund_reason ?? null,
        refundMethod: line.refundMethod ?? line.refund_method ?? null,
      }))
      // Keep a financially valid line even when a legacy backend snapshot has
      // no name. The renderer can safely resolve it against the sold item by
      // orderItemId / variantId / SKU instead of silently hiding the refund.
      .filter((line) => line.quantity > 0 && line.refundAmount > 0);
  } catch {
    return [];
  }
}

function lineMatchesStableIdentity(line: RefundBreakdownLine, item: RefundBreakdownItem): boolean {
  if (line.billiardLineKey && item.billiard_json) {
    try {
      if (JSON.parse(item.billiard_json)?.lineKey === line.billiardLineKey) return true;
    } catch { /* fall through to legacy identities */ }
  }
  const lineVariantId = line.variantId ?? line.variant_id;
  if (lineVariantId && item.variant_id && lineVariantId === item.variant_id) return true;
  if (line.sku && item.sku && line.sku === item.sku) return true;
  return Boolean(line.name && line.name === item.name);
}

function lineMatchesItem(line: RefundBreakdownLine, item: RefundBreakdownItem): boolean {
  if (line.orderItemId) return line.orderItemId === item.id;
  return lineMatchesStableIdentity(line, item);
}

function resolveLineItem(
  line: RefundBreakdownLine,
  items: RefundBreakdownItem[],
): RefundBreakdownItem | undefined {
  // Prefer an exact local row id. Only if the server id is not present in the
  // mirrored items do we fall back to product identity, so two sold rows of
  // the same variant cannot both receive the same refund line.
  if (line.orderItemId) {
    const exactItem = items.find((item) => item.id === line.orderItemId);
    if (exactItem) return exactItem;
  }
  return items.find((item) => lineMatchesStableIdentity(line, item));
}

export function getRefundBreakdownLines(
  order: RefundBreakdownOrder,
  items: RefundBreakdownItem[] = [],
): RefundBreakdownLine[] {
  return parseRefundBreakdownLines(order.refund_lines).map((line) => {
    const item = resolveLineItem(line, items);
    return {
      ...line,
      billiardLineKey: line.billiardLineKey ?? null,
      orderItemId: item?.id ?? line.orderItemId ?? null,
      variantId: line.variantId ?? line.variant_id ?? item?.variant_id ?? null,
      sku: line.sku ?? item?.sku ?? null,
      name: line.name || item?.name || line.sku || '',
      unit: line.unit ?? line.saleUnit ?? item?.sale_unit ?? null,
      saleUnit: line.saleUnit ?? line.unit ?? item?.sale_unit ?? null,
      sellBy: line.sellBy ?? item?.sell_by ?? null,
    };
  });
}

function refundEventKey(line: RefundBreakdownLine): string {
  if (line.refundRequestId) return `request:${line.refundRequestId}`;
  if (line.refundedAt) return `time:${line.refundedAt}`;
  return 'legacy';
}

export function getRefundEvents(
  order: RefundBreakdownOrder,
  items: RefundBreakdownItem[] = [],
): RefundEvent[] {
  const grouped = new Map<string, RefundEvent>();
  getRefundBreakdownLines(order, items).forEach((line) => {
    const key = refundEventKey(line);
    const current = grouped.get(key) ?? {
      key,
      refundedAt: line.refundedAt ?? null,
      refundRequestId: line.refundRequestId ?? null,
      reason: line.reason ?? null,
      refundMethod: line.refundMethod ?? null,
      lines: [],
      refundAmount: 0,
    };
    current.lines.push(line);
    current.refundAmount += line.refundAmount;
    current.refundedAt = current.refundedAt ?? line.refundedAt ?? null;
    current.reason = current.reason ?? line.reason ?? null;
    current.refundMethod = current.refundMethod ?? line.refundMethod ?? null;
    grouped.set(key, current);
  });

  return Array.from(grouped.values()).sort((a, b) => {
    const aTime = a.refundedAt ? Date.parse(a.refundedAt) : 0;
    const bTime = b.refundedAt ? Date.parse(b.refundedAt) : 0;
    return aTime - bTime;
  });
}

export function getItemRefundBreakdowns<T extends RefundBreakdownItem>(
  order: RefundBreakdownOrder,
  items: T[],
): Array<ItemRefundBreakdown<T>> {
  const lines = getRefundBreakdownLines(order, items);
  return items.map((item) => {
    const itemLines = lines.filter((line) => lineMatchesItem(line, item));
    const refundedQty = itemLines.reduce((sum, line) => sum + line.quantity, 0);
    const refundedAmount = itemLines.reduce((sum, line) => sum + line.refundAmount, 0);
    return {
      item,
      refundedQty,
      remainingQty: Math.max(0, item.quantity - refundedQty),
      refundedAmount,
      remainingAmount: Math.max(0, item.total - refundedAmount),
      lines: itemLines,
    };
  });
}
