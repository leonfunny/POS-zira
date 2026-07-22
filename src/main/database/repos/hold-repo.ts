import { database } from '../database';
import type { PosHoldPayload } from '../../../shared/billiard-pos-handoff';

interface HoldOrderRow {
  id: string;
  title: string;
  payload: string;
  items_count: number;
  total: number;
  staff_name?: string | null;
  created_at: string;
}

export interface HoldOrderListRow {
  id: string;
  title: string;
  createdAt: string;
  items: number;
  total: number;
  staffName?: string | null;
  holdReason?: PosHoldPayload['holdReason'];
  protected?: boolean;
}

export interface HoldOrderDetail {
  id: string;
  title: string;
  payload: PosHoldPayload;
  createdAt: string;
}

function parsePayload(value: string): any | null {
  try { return JSON.parse(value); } catch { return null; }
}

class HoldOrderRepo {
  create(id: string, title: string, payload: any): void {
    const cart = payload?.cart;
    const itemsCount = Array.isArray(cart?.items) ? cart.items.length : 0;
    const total = Number(cart?.total || 0);
    const staffName = payload?.staffName ?? null;
    database.run(
      `INSERT INTO pos_hold_orders (id, title, payload, items_count, total, staff_name) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, title, JSON.stringify(payload ?? {}), itemsCount, total, staffName],
    );
  }

  upsert(id: string, title: string, payload: any): void {
    const existing = database.get<Pick<HoldOrderRow, 'payload'>>(
      'SELECT payload FROM pos_hold_orders WHERE id = ?',
      [id],
    );
    if (existing) {
      const existingPayload = parsePayload(existing.payload);
      if (existingPayload?.protected === true && existing.payload !== JSON.stringify(payload ?? {})) {
        throw new Error('Protected held cart already exists with a different snapshot');
      }
    }
    const cart = payload?.snapshot?.state?.cart ?? payload?.cart;
    const itemsCount = Array.isArray(cart?.items) ? cart.items.length : 0;
    const total = Number(cart?.total || 0);
    const staffName = payload?.snapshot?.state?.session?.staffName ?? payload?.staffName ?? null;
    database.run(
      `INSERT INTO pos_hold_orders (id, title, payload, items_count, total, staff_name)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         payload = excluded.payload,
         items_count = excluded.items_count,
         total = excluded.total,
         staff_name = excluded.staff_name`,
      [id, title, JSON.stringify(payload ?? {}), itemsCount, total, staffName],
    );
  }

  /** Explicit lifecycle/snapshot update for a protected interruption Hold. */
  replaceProtected(id: string, title: string, payload: PosHoldPayload): void {
    const existing = this.get(id);
    const existingCheckout = existing?.payload?.restoredCheckout;
    const nextCheckout = payload.restoredCheckout;
    if (
      !existing
      || existing.payload?.protected !== true
      || existing.payload?.holdReason !== 'BILLIARD_INTERRUPTION'
      || payload.protected !== true
      || payload.holdReason !== 'BILLIARD_INTERRUPTION'
      || existing.payload?.autoRestoreForCheckoutId !== payload.autoRestoreForCheckoutId
      || existing.payload?.sourceBilliardSessionId !== payload.sourceBilliardSessionId
      || (existingCheckout && (
        !nextCheckout
        || existingCheckout.orderId !== nextCheckout.orderId
        || existingCheckout.clientAttemptId !== nextCheckout.clientAttemptId
      ))
    ) {
      throw new Error('Protected held cart lifecycle identity does not match');
    }
    const cart = payload.snapshot?.state?.cart;
    const itemsCount = Array.isArray(cart?.items) ? cart.items.length : 0;
    const total = Number(cart?.total || 0);
    const staffName = payload.snapshot?.state?.session?.staffName ?? null;
    database.run(
      `UPDATE pos_hold_orders
       SET title = ?, payload = ?, items_count = ?, total = ?, staff_name = ?
       WHERE id = ?`,
      [title, JSON.stringify(payload), itemsCount, total, staffName, id],
    );
  }

  list(): HoldOrderListRow[] {
    const rows = database.all<HoldOrderRow>(
      `SELECT id, title, payload, items_count, total, staff_name, created_at FROM pos_hold_orders ORDER BY created_at DESC`,
    );
    return rows.flatMap((r) => {
      const payload = parsePayload(r.payload) as PosHoldPayload | null;
      if (payload?.restoreState === 'PAID_TOMBSTONE') return [];
      return [{
        id: r.id,
        title: r.title,
        createdAt: r.created_at,
        items: r.items_count,
        total: r.total,
        staffName: r.staff_name ?? null,
        holdReason: payload?.holdReason,
        protected: payload?.protected === true,
      }];
    });
  }

  get(id: string): { id: string; title: string; payload: any; createdAt: string } | null {
    const row = database.get<HoldOrderRow>(
      `SELECT id, title, payload, created_at FROM pos_hold_orders WHERE id = ?`,
      [id],
    );
    if (!row) return null;
    const payload = parsePayload(row.payload);
    return payload == null ? null : { id: row.id, title: row.title, payload, createdAt: row.created_at };
  }

  listDetailed(): HoldOrderDetail[] {
    const rows = database.all<HoldOrderRow>(
      `SELECT id, title, payload, created_at FROM pos_hold_orders ORDER BY created_at DESC, id DESC`,
    );
    return rows.flatMap((row) => {
      const payload = parsePayload(row.payload) as PosHoldPayload | null;
      return payload ? [{ id: row.id, title: row.title, payload, createdAt: row.created_at }] : [];
    });
  }

  remove(id: string, allowProtected = false): void {
    const row = database.get<Pick<HoldOrderRow, 'payload'>>(
      'SELECT payload FROM pos_hold_orders WHERE id = ?',
      [id],
    );
    const payload = row ? parsePayload(row.payload) : null;
    if (row && (!payload || (payload.protected === true && !allowProtected))) {
      throw new Error('Protected held cart cannot be deleted');
    }
    database.run(`DELETE FROM pos_hold_orders WHERE id = ?`, [id]);
  }

  prune(limit = 20): void {
    // Automatic Billiard interruption holds are safety ledgers and are never
    // silently pruned. Only trim unprotected/manual rows.
    const rows = database.all<Pick<HoldOrderRow, 'id' | 'payload'>>(
      'SELECT id, payload FROM pos_hold_orders ORDER BY created_at DESC',
    );
    const removable = rows.filter((row) => {
      const payload = parsePayload(row.payload);
      return payload != null && payload.protected !== true;
    });
    for (const row of removable.slice(Math.max(0, limit))) {
      database.run('DELETE FROM pos_hold_orders WHERE id = ?', [row.id]);
    }
  }
}

export const holdOrderRepo = new HoldOrderRepo();
