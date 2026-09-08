/** Browser-safe upload contract; contains no financial calculations. */
export const ORDER_UPLOAD_COLUMNS = `
  ALTER TABLE orders ADD COLUMN sync_payload_json TEXT;
  ALTER TABLE orders ADD COLUMN sync_metadata_eligible INTEGER NOT NULL DEFAULT 0;
`;

export interface OrderUploadScope { salonId: string; serverUrl: string }
export interface OrderUploadRow {
  id: string;
  mode?: string | null;
  order_type?: string | null;
  table_id?: string | null;
  table_name?: string | null;
  covers?: number | null;
  sync_payload_json?: string | null;
  sync_metadata_eligible?: number;
  sync_attempts?: number;
}
export interface RestaurantUploadLine { id: string; notes?: string | null; course?: number | null }

export function orderUploadScope(salonId: unknown, serverUrl: unknown): OrderUploadScope {
  if (typeof salonId !== 'string' || !salonId.trim() || typeof serverUrl !== 'string' || !serverUrl.trim()) {
    throw new Error('ORDER_SYNC_IDENTITY_REQUIRED');
  }
  return { salonId, serverUrl: serverUrl.replace(/\/+$/, '') };
}

/** Do not interpret a timeout/auth failure as absence of a server capability. */
export async function restaurantMetadataVersion(read: () => Promise<unknown>): Promise<0 | 1> {
  let value: any;
  try { value = await read(); } catch (error: any) {
    if (error?.status === 404) return 0;
    throw error;
  }
  if (value?.restaurantMetadataVersion === 1) return 1;
  if (value?.restaurantMetadataVersion === 0) return 0;
  throw new Error('ORDER_SYNC_INVALID_CAPABILITIES');
}

function optionalText(value: unknown, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > max) throw new Error('ORDER_SYNC_INVALID_RESTAURANT_TEXT');
  return value;
}

export function addRestaurantOrderMetadata(
  dto: Record<string, any>, order: OrderUploadRow, lines: RestaurantUploadLine[],
): Record<string, any> {
  if (order.mode !== 'restaurant') return dto;
  if (!['dine_in', 'takeout', 'delivery'].includes(order.order_type ?? '')) {
    throw new Error('ORDER_SYNC_INVALID_RESTAURANT_ORDER_TYPE');
  }
  const covers = order.covers ?? 0;
  if (!Number.isInteger(covers) || covers < 0 || covers > 10000) throw new Error('ORDER_SYNC_INVALID_COVERS');
  if (order.order_type !== 'dine_in' && order.table_id) throw new Error('ORDER_SYNC_INVALID_TABLE_CONTEXT');
  if (order.table_id != null && (typeof order.table_id !== 'string' || !order.table_id.trim())) throw new Error('ORDER_SYNC_INVALID_TABLE_CONTEXT');
  if (!Array.isArray(dto.items) || dto.items.length !== lines.length || lines.length === 0) {
    throw new Error('ORDER_SYNC_INVALID_RESTAURANT_LINES');
  }
  const ids = new Set<string>();
  const items = dto.items.map((item: any, index: number) => {
    const line = lines[index];
    if (typeof line.id !== 'string' || !line.id.trim() || line.id.length > 128 || ids.has(line.id)) {
      throw new Error('ORDER_SYNC_INVALID_LOCAL_LINE_ID');
    }
    ids.add(line.id);
    const course = line.course ?? 1;
    if (!Number.isInteger(course) || course < 1 || course > 99) throw new Error('ORDER_SYNC_INVALID_COURSE');
    return { ...item, restaurant: { localLineId: line.id, notes: optionalText(line.notes, 4000), course } };
  });
  return { ...dto, items, restaurant: {
    schemaVersion: 1, tableId: optionalText(order.table_id, 128),
    ...(order.table_name != null ? { tableName: optionalText(order.table_name, 255) } : {}), covers,
  } };
}

/** Await persist on EVERY attempt, even when the snapshot already exists in RAM.
 * A previous failed flush must never authorize a subsequent network request. */
export async function prepareOrderUpload(options: {
  order: OrderUploadRow;
  scope: OrderUploadScope;
  buildLegacy: () => Record<string, any>;
  lines: RestaurantUploadLine[];
  readCapabilities: () => Promise<unknown>;
  assertContext: () => void | Promise<void>;
  persist: (snapshot: string) => Promise<void>;
}): Promise<Record<string, any>> {
  const { order, scope } = options;
  await options.assertContext();
  let snapshot: string;
  let payload: Record<string, any>;
  if (order.sync_payload_json != null) {
    let parsed: any;
    try { parsed = JSON.parse(order.sync_payload_json); } catch { throw new Error('ORDER_SYNC_CORRUPT_SNAPSHOT'); }
    if (parsed?.version !== 1 || parsed?.payload?.id !== order.id || !Array.isArray(parsed.payload.items)) {
      throw new Error('ORDER_SYNC_CORRUPT_SNAPSHOT');
    }
    if (parsed.salonId !== scope.salonId || parsed.serverUrl !== scope.serverUrl) throw new Error('ORDER_SYNC_SCOPE_MISMATCH');
    snapshot = order.sync_payload_json;
    payload = parsed.payload;
  } else {
    payload = options.buildLegacy();
    // Old rows (including reset attempt counters) have no opt-in provenance.
    if (order.mode === 'restaurant' && order.sync_metadata_eligible === 1 && !(order.sync_attempts! > 0)) {
      const version = await restaurantMetadataVersion(options.readCapabilities);
      await options.assertContext();
      if (version === 1) payload = addRestaurantOrderMetadata(payload, order, options.lines);
    }
    snapshot = JSON.stringify({ version: 1, ...scope, payload });
    payload = JSON.parse(snapshot).payload;
  }
  await options.assertContext();
  await options.persist(snapshot);
  await options.assertContext();
  return payload;
}
