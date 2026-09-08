/** Layout only from GET /restaurant/tables. Server bills/occupancy must never
 * become the state of this independent register. Reject the whole snapshot on
 * malformed or cross-tenant rows; a bad response is not an empty restaurant. */
export interface RestaurantLayoutTable {
  id: string; name: string; zone: string | null; capacity: number; active: boolean; sortOrder: number;
}

export function parseRestaurantLayout(payload: unknown, salonId: string): RestaurantLayoutTable[] {
  const envelope = payload as { data?: unknown; success?: boolean } | null;
  const rows = Array.isArray(payload) ? payload : envelope?.success !== false ? envelope?.data : undefined;
  if (!salonId || !Array.isArray(rows)) throw new Error('Invalid restaurant table layout response.');
  const ids = new Set<string>();
  return rows.map((row, index) => {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)
      || row.salonId !== salonId || typeof row.tableNumber !== 'string' || !row.tableNumber.trim()
      || !Number.isSafeInteger(row.capacity) || row.capacity < 0 || typeof row.isActive !== 'boolean'
      || (row.zone != null && (typeof row.zone !== 'object' || typeof row.zone.name !== 'string'
        || (row.zone.salonId != null && row.zone.salonId !== salonId)))) {
      throw new Error('Invalid restaurant table layout or salon mismatch.');
    }
    ids.add(row.id);
    return { id: row.id, name: row.tableNumber, zone: row.zone?.name ?? null,
      capacity: row.capacity, active: row.isActive, sortOrder: index };
  });
}

/** Only transient transport failures may use the last validated layout.
 * Auth, permission, unsupported endpoint and contract errors must be visible. */
export function canUseCachedRestaurantLayout(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500;
  return error instanceof TypeError || (error instanceof Error && /^Request timeout after \d+ms:/.test(error.message));
}
