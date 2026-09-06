import { database } from '../database';
import type { StoredPrintOrder } from '../../../shared/label-print-order-ipc';
import logger from '../../logger';

/**
 * This machine's copy of the salon's print sheets.
 *
 * The server holds the sheets; this table is what the workshop actually reads
 * from, so a factory with no internet still opens and prints yesterday's
 * order. `dirty` marks a row written here that the server has not confirmed —
 * the sync pushes those before it pulls anything.
 *
 * A deleted sheet stays as a row with `deleted_at` until the server has been
 * told, because the deletion has to reach the other machines too. Only then is
 * the row dropped.
 */
export interface LabelPrintOrderRow {
  id: string;
  name: string;
  payload: string;
  updated_at: string;
  deleted_at: string | null;
  dirty: number;
}

function toStored(row: LabelPrintOrderRow): StoredPrintOrder | null {
  try {
    const order = JSON.parse(row.payload) as Record<string, unknown>;
    if (!order || typeof order !== 'object' || Array.isArray(order)) return null;
    return { id: row.id, name: row.name, savedAt: row.updated_at, order };
  } catch {
    // A row written by a broken build must not take the whole list down; the
    // sheet is on the server too, and the next pull replaces it.
    logger.warn(`[LabelPrintOrder] Unreadable payload for ${row.id}; skipping`);
    return null;
  }
}

export const labelPrintOrderRepo = {
  /** Live sheets, newest first — the order the saved list shows them in. */
  list(): StoredPrintOrder[] {
    const rows = database.all<LabelPrintOrderRow>(
      `SELECT * FROM label_print_orders
       WHERE deleted_at IS NULL
       ORDER BY updated_at DESC`,
    );
    return rows.map(toStored).filter((entry): entry is StoredPrintOrder => entry !== null);
  },

  /** Rows this machine wrote that the server has not acknowledged, oldest first. */
  listDirty(): LabelPrintOrderRow[] {
    return database.all<LabelPrintOrderRow>(
      `SELECT * FROM label_print_orders WHERE dirty = 1 ORDER BY updated_at ASC`,
    );
  },

  /**
   * Write a sheet from this machine. Always dirty: it has changed, and
   * whatever the server last saw is now stale.
   */
  save(order: StoredPrintOrder): void {
    database.run(
      `INSERT INTO label_print_orders (id, name, payload, updated_at, deleted_at, dirty)
       VALUES (?, ?, ?, ?, NULL, 1)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         payload = excluded.payload,
         updated_at = excluded.updated_at,
         deleted_at = NULL,
         dirty = 1`,
      [order.id, order.name, JSON.stringify(order.order), order.savedAt],
    );
  },

  /** Mark deleted here and keep the row until the server has been told. */
  remove(id: string, at: string): void {
    database.run(
      `UPDATE label_print_orders SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ?`,
      [at, at, id],
    );
  },

  /**
   * A sheet as the server has it. Skipped when this machine holds an unpushed
   * edit of the same sheet: that edit is on its way up and would be silently
   * thrown away here, before anyone could see it lost.
   */
  applyFromServer(row: {
    id: string;
    name: string;
    payload: Record<string, unknown>;
    updatedAt: string;
    deletedAt: string | null;
  }): void {
    const local = database.get<LabelPrintOrderRow>(
      'SELECT * FROM label_print_orders WHERE id = ?',
      [row.id],
    );
    if (local && local.dirty === 1) return;
    if (row.deletedAt) {
      // Deleted on the server and nothing pending here: the tombstone has done
      // its job on this machine and does not need keeping.
      database.run('DELETE FROM label_print_orders WHERE id = ?', [row.id]);
      return;
    }
    database.run(
      `INSERT INTO label_print_orders (id, name, payload, updated_at, deleted_at, dirty)
       VALUES (?, ?, ?, ?, NULL, 0)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         payload = excluded.payload,
         updated_at = excluded.updated_at,
         deleted_at = NULL,
         dirty = 0`,
      [row.id, row.name, JSON.stringify(row.payload), row.updatedAt],
    );
  },

  /**
   * The server has the row. A pushed deletion leaves nothing worth keeping; a
   * pushed edit keeps the server's stamp, so the next cursor lines up with it.
   *
   * `pushedAt` is the stamp the row carried when it was sent. Both statements
   * check it, because the operator can save the same sheet again while the
   * request is in flight: clearing `dirty` on that newer row would strand the
   * newer edit on this machine for good.
   */
  markSynced(
    id: string,
    pushedAt: string,
    serverUpdatedAt: string,
    wasDeleted: boolean,
  ): void {
    if (wasDeleted) {
      database.run(
        `DELETE FROM label_print_orders
         WHERE id = ? AND updated_at = ? AND deleted_at IS NOT NULL`,
        [id, pushedAt],
      );
      return;
    }
    database.run(
      `UPDATE label_print_orders SET dirty = 0, updated_at = ?
       WHERE id = ? AND updated_at = ? AND dirty = 1`,
      [serverUpdatedAt, id, pushedAt],
    );
  },
};
