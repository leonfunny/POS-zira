/** Read only proven order-level context. The v1 snapshot's lineIndex is NOT a
 * server item identity: never join preparation notes to response array order. */
export interface RestaurantHistoryHeader {
  tableId: string | null;
  covers: number;
  orderType: 'dine_in' | 'takeout' | 'delivery';
}

export function readRestaurantHistoryHeader(order: any): RestaurantHistoryHeader | null {
  if (!order || (order.posMode ?? order.mode) !== 'restaurant') return null;
  const externalMeta = order.externalMetadata?.meta ?? order.external_metadata?.meta;
  if (order.billiardOrigin || order.billiard_origin || externalMeta?.billiardOrigin) return null;
  const header = externalMeta?.restaurant;
  if (!header || typeof header !== 'object' || Array.isArray(header) || header.schemaVersion !== 1) return null;
  const orderType = order.posOrderType;
  if (!['dine_in', 'takeout', 'delivery'].includes(orderType)) return null;
  if (!Number.isInteger(header.covers) || header.covers < 0 || header.covers > 10000) return null;
  const tableId = header.tableId ?? null;
  if (tableId !== null && (typeof tableId !== 'string' || !tableId.trim() || tableId.length > 128 || orderType !== 'dine_in')) return null;
  return { tableId, covers: header.covers, orderType };
}

export interface RestaurantHistoryLine {
  orderItemId: string;
  localLineId: string;
  productId: string;
  notes: string | null;
  course: number;
}

const LINE_KEYS = new Set(['orderItemId', 'localLineId', 'productId', 'lineIndex', 'notes', 'course']);
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** All-or-none validation of the server's explicit immutable identity links.
 * lineIndex is validated as data only; it is NEVER used to associate items. */
export function readRestaurantHistoryLines(order: any): Map<string, RestaurantHistoryLine> | null {
  if (!readRestaurantHistoryHeader(order) || !identity(order.id)) return null;
  const lines = (order.externalMetadata?.meta ?? order.external_metadata?.meta)?.restaurant?.lines;
  if (!Array.isArray(lines) || !lines.length || !Array.isArray(order.items) || lines.length !== order.items.length) return null;
  const serverItems = new Map<string, string>();
  for (const item of order.items) {
    if (!record(item) || !identity(item.id) || serverItems.has(item.id)) return null;
    if (item.orderId != null && item.orderId !== order.id) return null;
    const productId = item.variantId || item.productId;
    if (!identity(productId)) return null;
    serverItems.set(item.id, productId);
  }
  const output = new Map<string, RestaurantHistoryLine>();
  const localIds = new Set<string>();
  const indexes = new Set<number>();
  for (const line of lines) {
    if (!record(line) || Object.keys(line).some(key => !LINE_KEYS.has(key))) return null;
    if (!identity(line.orderItemId) || !identity(line.localLineId) || !identity(line.productId)) return null;
    if (output.has(line.orderItemId) || localIds.has(line.localLineId)) return null;
    if (serverItems.get(line.orderItemId) !== line.productId) return null;
    if (!Number.isInteger(line.lineIndex) || line.lineIndex < 0 || line.lineIndex >= lines.length || indexes.has(line.lineIndex)) return null;
    if (!Number.isInteger(line.course) || line.course < 1 || line.course > 99) return null;
    if (line.notes != null && (typeof line.notes !== 'string' || line.notes.length > 4000)) return null;
    output.set(line.orderItemId, { orderItemId: line.orderItemId, localLineId: line.localLineId,
      productId: line.productId, notes: line.notes ?? null, course: line.course });
    localIds.add(line.localLineId); indexes.add(line.lineIndex);
  }
  return output;
}
