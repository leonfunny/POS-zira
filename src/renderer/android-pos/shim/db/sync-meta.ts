/**
 * Android catalog sync cursor (the `sync_meta` table).
 *
 * Packet S5 (S1 §2.E). S6's catalog sync worker calls getSyncMeta/setSyncMeta to
 * persist the products pull cursor across boots (the Windows side stores the
 * same kind of cursor in `sync_metadata`, migrations.ts:104-108). This module is
 * the Android-shaped accessor over the local SQL.js mirror — small, no behavior
 * of its own beyond read/write of a single keyed row.
 */

import type { AndroidDatabase } from './db';

/** Default cursor key — the products catalog pull (Windows `sync_metadata`). */
export const PRODUCTS_SYNC_CURSOR_KEY = 'products_sync_cursor';

export interface AndroidSyncMeta {
  /** Opaque backend cursor (e.g. a timestamp / token). null = full sync needed. */
  cursor: string | null;
  /** ISO timestamp of the last successful sync write. */
  syncedAt: string | null;
}

export interface AndroidSyncMetaStore {
  getSyncMeta(key?: string): AndroidSyncMeta;
  setSyncMeta(cursor: string | null, key?: string): void;
}

export function createSyncMeta(db: AndroidDatabase): AndroidSyncMetaStore {
  return {
    getSyncMeta(key: string = PRODUCTS_SYNC_CURSOR_KEY): AndroidSyncMeta {
      const row = db.get<{ value: string | null; updated_at: string | null }>(
        'SELECT value, updated_at FROM sync_meta WHERE key = ?',
        [key],
      );
      return {
        cursor: row?.value ?? null,
        syncedAt: row?.updated_at ?? null,
      };
    },

    setSyncMeta(cursor: string | null, key: string = PRODUCTS_SYNC_CURSOR_KEY): void {
      db.run(
        'INSERT OR REPLACE INTO sync_meta (key, value, updated_at) VALUES (?, ?, ?)',
        [key, cursor, new Date().toISOString()],
      );
    },
  };
}
