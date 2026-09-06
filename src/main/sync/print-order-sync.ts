import { apiClient } from '../network/api-client';
import { database } from '../database/database';
import { labelPrintOrderRepo } from '../database/repos/label-print-order-repo';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';

const CURSOR_KEY = 'label_print_orders_cursor';

interface ServerOrder {
  id: string;
  name?: string;
  payload?: Record<string, unknown>;
  updatedAt?: string;
  updated_at?: string;
  deletedAt?: string | null;
  deleted_at?: string | null;
}

function readCursor(): string | null {
  const row = database.get<{ value: string }>('SELECT value FROM sync_metadata WHERE key = ?', [
    CURSOR_KEY,
  ]);
  return row?.value ?? null;
}

function writeCursor(value: string): void {
  database.run(
    "INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    [CURSOR_KEY, value],
  );
}

/**
 * Keeps this machine's print sheets and the salon's in step.
 *
 * Push first, then pull. A sheet typed here while the line was down is the one
 * thing that exists nowhere else; sending it before asking for the others
 * means a pull can never overwrite it. The pull is a delta from the last
 * cursor and carries deletions, which is the only way a sheet deleted on the
 * other machine ever disappears from this one.
 */
export class PrintOrderSync {
  private inFlight: Promise<number> | null = null;
  private timer: NodeJS.Timeout | null = null;

  /**
   * One round trip. Never throws: the workshop prints from the local copy, and
   * a failed sync means the sheets are simply as they were.
   */
  async sync(): Promise<number> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<number> {
    const token = getSecureAuthToken();
    if (!token) return 0;
    try {
      await this.push(token);
      return await this.pull(token);
    } catch (err: unknown) {
      logger.warn(`[PrintOrderSync] ${(err as Error)?.message ?? err}`);
      return 0;
    }
  }

  /**
   * Everything written here since the last acknowledgement. One request per
   * sheet: a workshop has a handful of them, and a per-sheet result means one
   * rejected sheet does not hold back the rest.
   */
  private async push(token: string): Promise<void> {
    for (const row of labelPrintOrderRepo.listDirty()) {
      const path = `/label-print-orders/${row.id}`;
      try {
        if (row.deleted_at) {
          await apiClient.request('DELETE', path, token);
          labelPrintOrderRepo.markSynced(row.id, row.updated_at, row.updated_at, true);
          continue;
        }
        const saved = (await apiClient.request('PUT', path, token, {
          name: row.name,
          payload: JSON.parse(row.payload),
        })) as ServerOrder;
        labelPrintOrderRepo.markSynced(
          row.id,
          row.updated_at,
          saved?.updatedAt ?? saved?.updated_at ?? row.updated_at,
          false,
        );
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        // 4xx is this sheet's own problem and will be its problem again in a
        // minute; the rest of the queue is unrelated, so carry on rather than
        // letting one bad row block the shop's other sheets forever.
        if (status && status >= 400 && status < 500) {
          logger.warn(`[PrintOrderSync] Server refused sheet ${row.id} (${status})`);
          continue;
        }
        throw err;
      }
    }
  }

  private async pull(token: string): Promise<number> {
    const cursor = readCursor();
    const path = cursor
      ? `/label-print-orders?since=${encodeURIComponent(cursor)}`
      : '/label-print-orders';
    const data = (await apiClient.request('GET', path, token)) as {
      items?: ServerOrder[];
      serverTime?: string;
    };
    const items = Array.isArray(data?.items) ? data.items : [];
    database.transaction(() => {
      for (const item of items) {
        if (!item?.id) continue;
        labelPrintOrderRepo.applyFromServer({
          id: String(item.id),
          name: String(item.name ?? ''),
          payload: (item.payload ?? {}) as Record<string, unknown>,
          updatedAt: item.updatedAt ?? item.updated_at ?? new Date().toISOString(),
          deletedAt: item.deletedAt ?? item.deleted_at ?? null,
        });
      }
      // The server's clock, not this machine's: a POS running a minute fast
      // would set a cursor that skips every sheet saved in that minute.
      if (data?.serverTime) writeCursor(data.serverTime);
    });
    return items.length;
  }

  startPeriodicSync(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sync();
    }, intervalMs);
    void this.sync();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const printOrderSync = new PrintOrderSync();
