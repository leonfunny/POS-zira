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
}

export interface RefundBreakdownLine {
  variantId?: string | null;
  variant_id?: string | null;
  sku?: string | null;
  name: string;
  quantity: number;
  refundAmount: number;
  unitPrice?: number;
  vatRate?: number;
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
        variantId: line.variantId ?? line.variant_id ?? null,
        variant_id: line.variant_id ?? null,
        sku: line.sku ?? null,
        name: String(line.name ?? ''),
        quantity: parseQuantity(line.quantity),
        refundAmount: Math.round(toNumber(line.refundAmount)),
        unitPrice: line.unitPrice == null ? undefined : Math.round(toNumber(line.unitPrice)),
        vatRate: line.vatRate == null ? undefined : toNumber(line.vatRate),
      }))
      .filter((line) => line.name.length > 0 && line.quantity > 0 && line.refundAmount > 0);
  } catch {
    return [];
  }
}

function lineMatchesItem(line: RefundBreakdownLine, item: RefundBreakdownItem): boolean {
  const lineVariantId = line.variantId ?? line.variant_id;
  if (lineVariantId && item.variant_id) return lineVariantId === item.variant_id;
  if (line.sku && item.sku) return line.sku === item.sku;
  return line.name === item.name;
}

export function getRefundBreakdownLines(order: RefundBreakdownOrder): RefundBreakdownLine[] {
  return parseRefundBreakdownLines(order.refund_lines);
}

export function getItemRefundBreakdowns<T extends RefundBreakdownItem>(
  order: RefundBreakdownOrder,
  items: T[],
): Array<ItemRefundBreakdown<T>> {
  const lines = getRefundBreakdownLines(order);
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
