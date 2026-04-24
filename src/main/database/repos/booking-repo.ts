/**
 * BookingRepo — local cache of dashboard-created bookings.
 *
 * Phase 1 is read-only. All mutations originate on the dashboard and arrive
 * via sync_log → entity-applicators → upsert(). POS UI only reads from this
 * table. Prices are stored in grosze (INT) to match orders; server payloads
 * are in PLN float and converted at the applicator boundary.
 */
import { database } from '../database';

export interface BookingRow {
  id: string;
  owner_id: string | null;
  owner_full_name: string | null;
  owner_phone: string | null;
  staff_user_id: string | null;
  staff_full_name: string | null;
  service_id: string | null;
  service_name: string | null;
  rule_id: string | null;
  resource_id: string | null;
  resource_name: string | null;
  status: string;
  starts_at: string;
  ends_at: string;
  duration_minutes: number | null;
  processing_start: string | null;
  processing_end: string | null;
  base_price_pln: number;
  extras_price_pln: number;
  total_price_pln: number;
  deposit_paid: number;
  customer_notes: string | null;
  internal_notes: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string | null;
  server_updated_at: string | null;
}

export interface BookingUpsertInput {
  id: string;
  owner_id?: string | null;
  owner_full_name?: string | null;
  owner_phone?: string | null;
  staff_user_id?: string | null;
  staff_full_name?: string | null;
  service_id?: string | null;
  service_name?: string | null;
  rule_id?: string | null;
  resource_id?: string | null;
  resource_name?: string | null;
  status: string;
  starts_at: string;
  ends_at: string;
  duration_minutes?: number | null;
  processing_start?: string | null;
  processing_end?: string | null;
  base_price_pln?: number;
  extras_price_pln?: number;
  total_price_pln?: number;
  deposit_paid?: number;
  customer_notes?: string | null;
  internal_notes?: string | null;
  confirmed_at?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  updated_at?: string | null;
  server_updated_at?: string | null;
}

export const bookingRepo = {
  upsert(row: BookingUpsertInput): void {
    // The UPSERT is guarded by `updated_at` so a stale payload (e.g. a
    // backfilled "created" event that raced a live "status_changed") never
    // clobbers fresher data already in the row. sync_log entries are
    // processed in seq ASC order, but the underlying booking state those
    // payloads carry can be out-of-order when backfill runs concurrently
    // with live traffic.
    database.run(
      `INSERT INTO bookings (
        id, owner_id, owner_full_name, owner_phone,
        staff_user_id, staff_full_name,
        service_id, service_name, rule_id,
        resource_id, resource_name,
        status, starts_at, ends_at, duration_minutes,
        processing_start, processing_end,
        base_price_pln, extras_price_pln, total_price_pln,
        deposit_paid, customer_notes, internal_notes,
        confirmed_at, cancelled_at, cancel_reason,
        updated_at, server_updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        owner_id           = excluded.owner_id,
        owner_full_name    = excluded.owner_full_name,
        owner_phone        = excluded.owner_phone,
        staff_user_id      = excluded.staff_user_id,
        staff_full_name    = excluded.staff_full_name,
        service_id         = excluded.service_id,
        service_name       = excluded.service_name,
        rule_id            = excluded.rule_id,
        resource_id        = excluded.resource_id,
        resource_name      = excluded.resource_name,
        status             = excluded.status,
        starts_at          = excluded.starts_at,
        ends_at            = excluded.ends_at,
        duration_minutes   = excluded.duration_minutes,
        processing_start   = excluded.processing_start,
        processing_end     = excluded.processing_end,
        base_price_pln     = excluded.base_price_pln,
        extras_price_pln   = excluded.extras_price_pln,
        total_price_pln    = excluded.total_price_pln,
        deposit_paid       = excluded.deposit_paid,
        customer_notes     = excluded.customer_notes,
        internal_notes     = excluded.internal_notes,
        confirmed_at       = excluded.confirmed_at,
        cancelled_at       = excluded.cancelled_at,
        cancel_reason      = excluded.cancel_reason,
        updated_at         = excluded.updated_at,
        server_updated_at  = excluded.server_updated_at
      WHERE excluded.updated_at IS NULL
         OR updated_at IS NULL
         OR excluded.updated_at >= updated_at`,
      [
        row.id,
        row.owner_id ?? null,
        row.owner_full_name ?? null,
        row.owner_phone ?? null,
        row.staff_user_id ?? null,
        row.staff_full_name ?? null,
        row.service_id ?? null,
        row.service_name ?? null,
        row.rule_id ?? null,
        row.resource_id ?? null,
        row.resource_name ?? null,
        row.status,
        row.starts_at,
        row.ends_at,
        row.duration_minutes ?? null,
        row.processing_start ?? null,
        row.processing_end ?? null,
        row.base_price_pln ?? 0,
        row.extras_price_pln ?? 0,
        row.total_price_pln ?? 0,
        row.deposit_paid ?? 0,
        row.customer_notes ?? null,
        row.internal_notes ?? null,
        row.confirmed_at ?? null,
        row.cancelled_at ?? null,
        row.cancel_reason ?? null,
        row.updated_at ?? null,
        row.server_updated_at ?? null,
      ],
    );
  },

  /**
   * Lightweight status-only update. Used when the inbound event is
   * `status_changed` and the payload may omit price/notes fields — we
   * do not want to overwrite richer data that an earlier `updated` carried.
   */
  updateStatus(
    id: string,
    status: string,
    updates: {
      cancelled_at?: string | null;
      cancel_reason?: string | null;
      confirmed_at?: string | null;
      updated_at?: string | null;
      server_updated_at?: string | null;
    } = {},
  ): void {
    database.run(
      `UPDATE bookings SET
        status            = ?,
        cancelled_at      = COALESCE(?, cancelled_at),
        cancel_reason     = COALESCE(?, cancel_reason),
        confirmed_at      = COALESCE(?, confirmed_at),
        updated_at        = COALESCE(?, updated_at),
        server_updated_at = COALESCE(?, server_updated_at)
       WHERE id = ?`,
      [
        status,
        updates.cancelled_at ?? null,
        updates.cancel_reason ?? null,
        updates.confirmed_at ?? null,
        updates.updated_at ?? null,
        updates.server_updated_at ?? null,
        id,
      ],
    );
  },

  getById(id: string): BookingRow | null {
    return database.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [id]) ?? null;
  },

  /**
   * Apply a POS-originated status change immediately to the local row so
   * the UI reflects it without waiting for the server round-trip. The
   * caller is responsible for enqueueing the matching sync_log entry via
   * booking-sync.writeStatusChanged so the server eventually hears about
   * it. `updated_at` is bumped to `now` so the server's later echo
   * (with a strictly later timestamp) can overwrite any fields we miss.
   */
  applyLocalStatusChange(
    id: string,
    status: string,
    updates: {
      cancel_reason?: string | null;
      confirmed_at?: string | null;
      cancelled_at?: string | null;
    } = {},
  ): void {
    const nowIso = new Date().toISOString();
    database.run(
      `UPDATE bookings SET
        status        = ?,
        cancelled_at  = COALESCE(?, cancelled_at),
        cancel_reason = COALESCE(?, cancel_reason),
        confirmed_at  = COALESCE(?, confirmed_at),
        updated_at    = ?
       WHERE id = ?`,
      [
        status,
        updates.cancelled_at ?? null,
        updates.cancel_reason ?? null,
        updates.confirmed_at ?? null,
        nowIso,
        id,
      ],
    );
  },

  /**
   * Apply a POS-originated edit (reschedule / staff / notes) locally.
   * Only non-undefined fields are written so callers can pass sparse
   * patches.
   */
  applyLocalUpdate(
    id: string,
    patch: {
      staff_user_id?: string | null;
      staff_full_name?: string | null;
      resource_id?: string | null;
      resource_name?: string | null;
      starts_at?: string;
      ends_at?: string;
      duration_minutes?: number;
      customer_notes?: string | null;
      internal_notes?: string | null;
    },
  ): void {
    // Column names are written explicitly (not interpolated from the patch
    // keys) so a future miswired caller can't inject SQL fragments via
    // object keys. The patch interface is the only source of truth for
    // mutable fields; adding a new one requires touching this method.
    const sets: string[] = [];
    const values: any[] = [];
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      values.push(val);
    };
    if (patch.staff_user_id !== undefined) push('staff_user_id', patch.staff_user_id);
    if (patch.staff_full_name !== undefined) push('staff_full_name', patch.staff_full_name);
    if (patch.resource_id !== undefined) push('resource_id', patch.resource_id);
    if (patch.resource_name !== undefined) push('resource_name', patch.resource_name);
    if (patch.starts_at !== undefined) push('starts_at', patch.starts_at);
    if (patch.ends_at !== undefined) push('ends_at', patch.ends_at);
    if (patch.duration_minutes !== undefined) push('duration_minutes', patch.duration_minutes);
    if (patch.customer_notes !== undefined) push('customer_notes', patch.customer_notes);
    if (patch.internal_notes !== undefined) push('internal_notes', patch.internal_notes);

    if (sets.length === 0) return;
    sets.push(`updated_at = ?`);
    values.push(new Date().toISOString());
    values.push(id);
    database.run(
      `UPDATE bookings SET ${sets.join(', ')} WHERE id = ?`,
      values,
    );
  },

  /**
   * Bookings whose start falls inside [fromIso, toIso). Excludes CANCELLED
   * and NO_SHOW so the calendar doesn't show them by default.
   */
  getByDateRange(fromIso: string, toIso: string): BookingRow[] {
    return database.all<BookingRow>(
      `SELECT * FROM bookings
       WHERE starts_at >= ? AND starts_at < ?
         AND status NOT IN ('CANCELLED','NO_SHOW')
       ORDER BY starts_at ASC`,
      [fromIso, toIso],
    );
  },

  getByStaffDateRange(staffUserId: string, fromIso: string, toIso: string): BookingRow[] {
    return database.all<BookingRow>(
      `SELECT * FROM bookings
       WHERE staff_user_id = ?
         AND starts_at >= ? AND starts_at < ?
         AND status NOT IN ('CANCELLED','NO_SHOW')
       ORDER BY starts_at ASC`,
      [staffUserId, fromIso, toIso],
    );
  },

  /**
   * Today's active bookings — used by the check-in screen.
   *
   * `starts_at` is stored as a UTC ISO string (server payload comes from a
   * timestamptz column), so we compare both sides in local time to avoid
   * the edge case where late-evening bookings in +02 fall on the wrong
   * UTC date.
   */
  getToday(): BookingRow[] {
    return database.all<BookingRow>(
      `SELECT * FROM bookings
       WHERE date(starts_at, 'localtime') = date('now', 'localtime')
         AND status NOT IN ('CANCELLED','NO_SHOW')
       ORDER BY starts_at ASC`,
    );
  },
};
