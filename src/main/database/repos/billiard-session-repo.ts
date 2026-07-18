import { database } from '../database';
import {
  canonicalBilliardBillingMode,
  canonicalBilliardSessionStatus,
} from '../../../shared/billiard-contract';

const PAID_TOMBSTONE_RETENTION_MS = 10_000;

export interface BilliardSessionRow {
  id: string;
  resource_id: string | null;
  status: string;
  billing_mode: string;
  guest_count: number;
  started_at: string | null;
  paused_at: string | null;
  ended_at: string | null;
  total_minutes: number;
  total_charges: number;
  combo_id: string | null;
  notes: string | null;
  payload_json: string | null;
  updated_at: string | null;
}

export interface BilliardSessionItemRow {
  id: string;
  session_id: string;
  variant_id: string | null;
  name: string;
  quantity: number;
  unit_price: number;
}

export const billiardSessionRepo = {
  getActive(): (BilliardSessionRow & { items: BilliardSessionItemRow[] })[] {
    const sessions = database.all<BilliardSessionRow>(
      "SELECT * FROM billiard_sessions WHERE UPPER(status) IN ('ACTIVE', 'PAUSED') ORDER BY started_at",
    );
    return sessions.map((s) => ({
      ...s,
      items: database.all<BilliardSessionItemRow>(
        'SELECT * FROM billiard_session_items WHERE session_id = ?',
        [s.id],
      ),
    }));
  },

  getById(id: string): (BilliardSessionRow & { items: BilliardSessionItemRow[] }) | null {
    const session = database.get<BilliardSessionRow>(
      'SELECT * FROM billiard_sessions WHERE id = ?',
      [id],
    );
    if (!session) return null;
    return {
      ...session,
      items: database.all<BilliardSessionItemRow>(
        'SELECT * FROM billiard_session_items WHERE session_id = ?',
        [id],
      ),
    };
  },

  getPendingPayments(): (BilliardSessionRow & { items: BilliardSessionItemRow[] })[] {
    const sessions = database.all<BilliardSessionRow>(
      "SELECT * FROM billiard_sessions WHERE UPPER(status) = 'COMPLETED' ORDER BY ended_at DESC",
    );
    return sessions
      .filter((session) => {
        try {
          const payload = session.payload_json ? JSON.parse(session.payload_json) : {};
          return String(payload.paymentStatus || 'UNPAID').toUpperCase() !== 'PAID';
        } catch {
          return true;
        }
      })
      .map((session) => ({
        ...session,
        items: database.all<BilliardSessionItemRow>(
          'SELECT * FROM billiard_session_items WHERE session_id = ?',
          [session.id],
        ),
      }));
  },

  upsertMany(sessions: any[]): void {
    for (const s of sessions) {
      this.upsertOne(s);
    }
  },

  upsertOne(s: any): void {
    const status = canonicalBilliardSessionStatus(s.status);
    const billingMode = canonicalBilliardBillingMode(s.billingMode || s.billing_mode);
    database.run(
      `INSERT OR REPLACE INTO billiard_sessions
        (id, resource_id, status, billing_mode, guest_count, started_at, paused_at, ended_at,
         total_minutes, total_charges, combo_id, notes, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        s.id,
        s.resourceId || s.resource_id || null,
        status,
        billingMode,
        s.guestCount ?? s.guest_count ?? 1,
        s.startedAt || s.started_at || null,
        s.pausedAt || s.paused_at || null,
        s.endedAt || s.ended_at || null,
        s.totalMinutes ?? s.total_minutes ?? s.durationMinutes ?? s.duration_minutes ?? 0,
        s.totalCharges ?? s.total_charges ?? s.totalCharge ?? s.total_charge ?? 0,
        s.comboId || s.combo_id || null,
        s.notes || null,
        JSON.stringify(s),
        s.updatedAt || s.updated_at || new Date().toISOString(),
      ],
    );

    // Upsert items
    const items = s.items || s.sessionItems || [];
    database.run('DELETE FROM billiard_session_items WHERE session_id = ?', [s.id]);
    for (const item of items) {
      database.run(
        `INSERT INTO billiard_session_items
          (id, session_id, variant_id, name, quantity, unit_price)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          item.id || `${s.id}_${Math.random().toString(36).slice(2)}`,
          s.id,
          item.variantId || item.variant_id || null,
          item.name || '',
          item.quantity ?? 1,
          item.unitPrice ?? item.unit_price ?? 0,
        ],
      );
    }
  },

  deleteById(id: string): void {
    database.run('DELETE FROM billiard_session_items WHERE session_id = ?', [id]);
    database.run('DELETE FROM billiard_sessions WHERE id = ?', [id]);
  },

  replaceActive(sessions: any[]): void {
    // A completed local row is a payment journal/tombstone. A dashboard
    // response may be a few seconds stale, so never let an older ACTIVE copy
    // overwrite a session that this POS already ended or settled.
    const completedIds = new Set(
      database.all<{ id: string }>(
        "SELECT id FROM billiard_sessions WHERE UPPER(status) = 'COMPLETED'",
      ).map((row) => row.id),
    );
    const activeRows = database.all<{ id: string }>(
      "SELECT id FROM billiard_sessions WHERE UPPER(status) IN ('ACTIVE', 'PAUSED')",
    );
    for (const row of activeRows) {
      database.run('DELETE FROM billiard_session_items WHERE session_id = ?', [row.id]);
    }
    database.run("DELETE FROM billiard_sessions WHERE UPPER(status) IN ('ACTIVE', 'PAUSED')");
    this.upsertMany(sessions.filter((session) => !completedIds.has(session?.id)));
  },

  /** Remove only expired PAID tombstones; unpaid/malformed journals stay recoverable. */
  pruneExpiredPaidTombstones(now = Date.now()): number {
    const completed = database.all<{
      id: string;
      payload_json: string | null;
      updated_at: string | null;
    }>(
      "SELECT id, payload_json, updated_at FROM billiard_sessions WHERE UPPER(status) = 'COMPLETED'",
    );
    let pruned = 0;
    for (const local of completed) {
      try {
        const payload = local.payload_json ? JSON.parse(local.payload_json) : {};
        const updatedAt = Date.parse(local.updated_at || '');
        const isExpiredPaidTombstone = String(payload.paymentStatus || '').toUpperCase() === 'PAID'
          && Number.isFinite(updatedAt)
          && now - updatedAt >= PAID_TOMBSTONE_RETENTION_MS;
        if (isExpiredPaidTombstone) {
          this.deleteById(local.id);
          pruned++;
        }
      } catch {
        // Malformed rows may still be the only cashier recovery journal.
      }
    }
    return pruned;
  },

  reconcilePendingSnapshot(sessions: any[], now = Date.now()): void {
    // This dedicated server endpoint is the complete salon-scoped pending
    // snapshot and is available to cashiers. Remove local unpaid rows the
    // server no longer considers pending. Keep fresh PAID tombstones briefly
    // so the dashboard's 3-second cache cannot resurrect an ACTIVE session.
    const remoteIds = new Set(sessions.map((session) => session?.id).filter(Boolean));
    const localCompleted = database.all<{
      id: string;
      payload_json: string | null;
      updated_at: string | null;
    }>(
      "SELECT id, payload_json, updated_at FROM billiard_sessions WHERE UPPER(status) = 'COMPLETED'",
    );
    for (const local of localCompleted) {
      if (remoteIds.has(local.id)) continue;
      let isPaid = false;
      try {
        const payload = local.payload_json ? JSON.parse(local.payload_json) : {};
        isPaid = String(payload.paymentStatus || '').toUpperCase() === 'PAID';
      } catch { /* malformed rows are safer to replace from the server */ }
      const updatedAt = Date.parse(local.updated_at || '');
      const isFreshPaidTombstone = isPaid
        && Number.isFinite(updatedAt)
        && now - updatedAt < PAID_TOMBSTONE_RETENTION_MS;
      if (!isFreshPaidTombstone) {
        this.deleteById(local.id);
      }
    }

    for (const session of sessions) {
      if (!session?.id) continue;
      this.upsertOne(session);
    }
  },

  clearCompleted(): void {
    const completed = database.all<{ id: string }>(
      "SELECT id FROM billiard_sessions WHERE UPPER(status) NOT IN ('ACTIVE', 'PAUSED')",
    );
    for (const s of completed) {
      database.run('DELETE FROM billiard_session_items WHERE session_id = ?', [s.id]);
    }
    database.run("DELETE FROM billiard_sessions WHERE UPPER(status) NOT IN ('ACTIVE', 'PAUSED')");
  },
};
