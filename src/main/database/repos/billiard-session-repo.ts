import { database } from '../database';

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
      "SELECT * FROM billiard_sessions WHERE status IN ('active', 'paused') ORDER BY started_at",
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

  upsertMany(sessions: any[]): void {
    for (const s of sessions) {
      this.upsertOne(s);
    }
  },

  upsertOne(s: any): void {
    database.run(
      `INSERT OR REPLACE INTO billiard_sessions
        (id, resource_id, status, billing_mode, guest_count, started_at, paused_at, ended_at,
         total_minutes, total_charges, combo_id, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        s.id,
        s.resourceId || s.resource_id || null,
        s.status || 'active',
        s.billingMode || s.billing_mode || 'per_minute',
        s.guestCount ?? s.guest_count ?? 1,
        s.startedAt || s.started_at || null,
        s.pausedAt || s.paused_at || null,
        s.endedAt || s.ended_at || null,
        s.totalMinutes ?? s.total_minutes ?? 0,
        s.totalCharges ?? s.total_charges ?? 0,
        s.comboId || s.combo_id || null,
        s.notes || null,
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

  clearCompleted(): void {
    const completed = database.all<{ id: string }>(
      "SELECT id FROM billiard_sessions WHERE status NOT IN ('active', 'paused')",
    );
    for (const s of completed) {
      database.run('DELETE FROM billiard_session_items WHERE session_id = ?', [s.id]);
    }
    database.run("DELETE FROM billiard_sessions WHERE status NOT IN ('active', 'paused')");
  },
};
