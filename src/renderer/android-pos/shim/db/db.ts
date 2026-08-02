/**
 * Android catalog DB engine — SQL.js (WebAssembly) running in the WebView,
 * persisted to IndexedDB.
 *
 * Packet S5 of the Android parity port — see
 * docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md (§5, S5). The Windows main
 * process keeps its SQL.js DB in `%APPDATA%/Zira AI/pos.db` (Node fs); Android
 * keeps the SAME SQL.js in-memory DB but persists the exported image to
 * IndexedDB (single blob record) instead of the filesystem. The repo SQL above
 * this layer is byte-identical to Windows — only the storage substrate changes.
 *
 * Parity with the Windows `Database` class (src/main/database/database.ts):
 *  - `run` / `get` / `all` / `transaction` mirror database.ts:296-350 (prepare/
 *    bind/step/free; `transaction` BEGIN/COMMIT/ROLLBACK; mutations mark dirty).
 *  - persistence mirrors the dirty-flag + save() durability model
 *    (database.ts:166-238): writes set a dirty flag and coalesce; order-
 *    relevant writes call `flush()` for an immediate persist (the Windows paid-
 *    order path calls `database.save()` directly). Windows autosaves every 5s
 *    via `setInterval`; the task asks for a ~5s DEBOUNCE after writes, so a
 *    burst of writes flushes once 5s after the last write.
 *  - corrupt-image recovery mirrors `tryLoadOrQuarantine` (database.ts:40-100):
 *    a buffer that fails the SQLite header check or `PRAGMA quick_check` is
 *    quarantined (preserved under a quarantine key — never silently discarded)
 *    and a fresh empty DB is created on top.
 *
 * This module is browser-side: it imports no Node/Electron API and no
 * `src/main/**`. `sql.js` is allowlisted for the shim graph; its WASM is loaded
 * via the Vite `?url` asset import (locateFile → bundled wasm URL).
 */

import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from 'sql.js';
// The WASM binary, resolved by Vite at build time to a bundled asset URL. In the
// WebView, sql.js cannot find its wasm without a locator, so locateFile points
// here. (In Node tests a passthrough locator lets sql.js resolve the wasm from
// its own package — see loadSqlJs.)
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

import { applyAndroidSchema } from './schema';

/** Re-export so callers can reference the sql.js Database type by one name. */
export type { SqlJsDatabase };

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;

// ── Durability / debounce ────────────────────────────────────────────────────

/** Debounce window for the post-write flush (parity with Windows' 5s cadence). */
const DEBOUNCE_MS = 5000;

// ── IndexedDB persistence (raw API, no deps) ─────────────────────────────────

const IDB_NAME = 'zira-android-pos';
const IDB_VERSION = 1;
const IDB_STORE = 'blobs';
/** Single blob record holding the live SQL.js DB image. */
const IDB_IMAGE_KEY = 'pos-db-image';
/**
 * Quarantine key prefix for corrupt images (mirrors the Windows
 * `pos.db.corrupted-<ts>` file suffix, database.ts:quarantineCorruptFile). The
 * corrupt bytes are preserved for forensic inspection, never discarded.
 */
const IDB_QUARANTINE_PREFIX = 'pos-db-image.corrupted-';

/** Abstraction over the persisted DB image so tests can inject a fake store. */
export interface AndroidDbPersistence {
  loadImage(): Promise<Uint8Array | null>;
  saveImage(image: Uint8Array): Promise<void>;
  quarantineImage(image: Uint8Array): Promise<void>;
}

function getIndexedDB(): IDBFactory | undefined {
  return (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
}

/**
 * Default persistence: the live DB image as a single IndexedDB blob record,
 * with corrupt images preserved under `pos-db-image.corrupted-<ts>` keys.
 * Gracefully no-ops (load → null, save → noop) when IndexedDB is absent, so the
 * engine still boots in-memory in environments without it.
 */
export class IndexedDbPersistence implements AndroidDbPersistence {
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const idb = getIndexedDB();
      if (!idb) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = idb.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(IDB_STORE)) {
          database.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    });
  }

  private async withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = database.transaction(IDB_STORE, mode);
      const store = tx.objectStore(IDB_STORE);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => database.close();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadImage(): Promise<Uint8Array | null> {
    if (!getIndexedDB()) return null;
    try {
      const record = await this.withStore<Uint8Array | undefined>('readonly', (store) => store.get(IDB_IMAGE_KEY));
      return record ?? null;
    } catch {
      return null;
    }
  }

  async saveImage(image: Uint8Array): Promise<void> {
    if (!getIndexedDB()) return;
    await this.withStore<IDBValidKey>('readwrite', (store) => store.put(image, IDB_IMAGE_KEY));
  }

  async quarantineImage(image: Uint8Array): Promise<void> {
    if (!getIndexedDB()) return;
    // Preserve the corrupt bytes under a timestamped quarantine key (mirrors
    // Windows renaming pos.db → pos.db.corrupted-<ts>, database.ts).
    const key = `${IDB_QUARANTINE_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await this.withStore<IDBValidKey>('readwrite', (store) => store.put(image, key));
  }
}

// ── SQLite header sanity check (database.ts:28-38) ───────────────────────────

// "SQLite format 3" (15 ASCII chars) + a NUL terminator at byte 15 = 16 bytes.
// The NUL is the \u0000 escape (not a raw byte) so this .ts stays diff-reviewable.
const SQLITE_MAGIC = 'SQLite format 3' + '\u0000';

/**
 * Cheap header check before handing a buffer to sql.js (database.ts:30-37). The
 * Android build works on a plain Uint8Array (IndexedDB returns Uint8Array, not a
 * Node Buffer), so it compares bytes directly instead of slicing + toString.
 */
export function isValidSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  for (let i = 0; i < 16; i += 1) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

// ── Engine: wraps a sql.js Database with the Windows all/get/run/transaction ─
// API + dirty-flag persistence.

/**
 * The Android DB handle. Mirrors the query surface of the Windows `database`
 * singleton (database.ts:296-350) so ported repos compile against it with only
 * an import-path change, and adds dirty-flag persistence to IndexedDB.
 */
export class AndroidDatabase {
  private dirty = false;
  private dirtyVersion = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight drain, if any. Concurrent flush()/debounce callers await it and
   *  it loops until the DB is clean, so an immediate flush() can never resolve
   *  while a paid-order write is still unpersisted. */
  private draining: Promise<void> | null = null;

  constructor(
    private readonly db: SqlJsDatabase,
    private readonly persistence: AndroidDbPersistence,
  ) {}

  /** Raw sql.js handle (schema introspection / tests). */
  getRawHandle(): SqlJsDatabase {
    return this.db;
  }

  private sanitizeParams(params?: unknown[]): SqlValue[] | undefined {
    if (!params) return undefined;
    return params.map((p) => (p === undefined ? null : p) as SqlValue);
  }

  /** Run a mutation; flags dirty + schedules a debounced ~5s flush. */
  run(sql: string, params?: unknown[]): void {
    this.db.run(sql, this.sanitizeParams(params));
    this.markDirty();
  }

  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    const stmt = this.db.prepare(sql);
    try {
      const sanitized = this.sanitizeParams(params);
      if (sanitized) stmt.bind(sanitized);
      return stmt.step() ? (stmt.getAsObject() as T) : null;
    } finally {
      stmt.free();
    }
  }

  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    try {
      const sanitized = this.sanitizeParams(params);
      if (sanitized) stmt.bind(sanitized);
      const results: T[] = [];
      while (stmt.step()) results.push(stmt.getAsObject() as T);
      return results;
    } finally {
      stmt.free();
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN');
    try {
      const result = fn();
      this.db.run('COMMIT');
      this.markDirty();
      return result;
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  // ── Persistence (dirty-flag model, database.ts:166-238) ────────────────────

  /** Flag dirty + (re)start the ~5s debounce timer (database.ts:184-187). */
  markDirty(): void {
    this.dirty = true;
    this.dirtyVersion += 1;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.drain();
    }, DEBOUNCE_MS);
  }

  /**
   * Immediate durability barrier — cancels any pending debounce and persists
   * now. Parity with the Windows paid-order path calling `database.save()`
   * (database.ts:189-238) so order-relevant writes survive a crash at once.
   */
  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.drain();
  }

  /**
   * Persist the in-memory DB to its image, looping until clean. Coalesces
   * concurrent callers onto one drain so a flush() issued while a debounced
   * save is mid-export does NOT return early (the old persist() bailed on
   * `saving` and dropped the durability barrier, risking a lost paid order).
   * Each pass captures dirtyVersion; if a newer write lands during export the
   * loop exports again rather than clearing dirty.
   */
  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.dirty) {
        const saveVersion = this.dirtyVersion;
        const exported = this.db.export();
        await this.persistence.saveImage(new Uint8Array(exported));
        if (this.dirtyVersion === saveVersion) this.dirty = false;
      }
    })().finally(() => { this.draining = null; });
    return this.draining;
  }

  /**
   * Wipe all salon-scoped data (catalog + orders + shifts + staff + sync
   * cursors) on an account switch — parity with the Windows clearSalonData
   * (database.ts) which archives-then-clears when the salon changes. Prevents a
   * tablet that logs from Salon A into Salon B from selling Salon A's catalog
   * or syncing Salon A's queued orders under Salon B's identity.
   */
  clearSalonData(): void {
    this.transaction(() => {
      for (const table of [
        'product_variants', 'categories', 'orders', 'order_items',
        'shifts', 'staff', 'sequence_counters', 'sync_meta',
        // v5: a frozen billiard checkout and any parked cart belong to the
        // PREVIOUS salon's register — they must never survive into salon B
        // (they carry cart lines, money totals and a salon-scoped order id).
        'pos_billiard_handoffs', 'pos_hold_orders',
      ]) {
        this.db.run(`DELETE FROM ${table}`);
      }
    });
  }

  /** Export the current DB image (for tests / backup). */
  exportImage(): Uint8Array {
    return new Uint8Array(this.db.export());
  }
}

// ── Initialization ───────────────────────────────────────────────────────────

export interface AndroidDbInitOptions {
  /**
   * Override the wasm locator.
   *  - `undefined` (production WebView): use the Vite `?url` import — sql.js
   *    fetches the bundled wasm asset.
   *  - `null` (Node tests): omit locateFile so sql.js resolves its own wasm from
   *    its package via fs (verified in this vitest/node env). NB a passthrough
   *    `(file) => file` does NOT work as a first call — sql.js then reads the
   *    bare filename relative to cwd and fails; the no-arg/empty-config form is
   *    what resolves it.
   *  - a function: use it verbatim as sql.js's locateFile.
   */
  locateFile?: ((file: string) => string) | null;
  /** Inject a persistence store (tests use a fake IndexedDB). */
  persistence?: AndroidDbPersistence;
}

// The WASM loads once per process; cache the promise so repeated inits don't
// re-fetch/reparse the binary.
let sqlJsPromise: Promise<SqlJsStatic> | null = null;

function loadSqlJs(locateFile?: ((file: string) => string) | null): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    const config =
      locateFile === undefined
        ? { locateFile: () => sqlWasmUrl } // production WebView default
        : locateFile === null
          ? {} // node tests: let sql.js resolve its own wasm
          : { locateFile };
    sqlJsPromise = initSqlJs(config);
  }
  return sqlJsPromise;
}

/**
 * Initialize the Android catalog DB: load sql.js, restore the persisted image
 * (or create a fresh DB when none/empty/corrupt — corrupt images are
 * quarantined, not discarded), apply the schema, and return a handle bound to
 * its persistence layer.
 */
export async function initAndroidDb(options: AndroidDbInitOptions = {}): Promise<AndroidDatabase> {
  const SQL = await loadSqlJs(options.locateFile);
  const persistence = options.persistence ?? new IndexedDbPersistence();

  const image = await persistence.loadImage().catch(() => null);
  let db: SqlJsDatabase;

  if (image && image.byteLength > 0) {
    if (isValidSqliteHeader(image)) {
      try {
        const candidate = new SQL.Database(image);
        // Page-level corruption probe (database.ts:55-78): a valid header can
        // still front a malformed page tree. quick_check walks every page.
        const probe = candidate.exec('PRAGMA quick_check');
        const row = probe?.[0]?.values?.[0]?.[0];
        if (row !== 'ok') {
          candidate.close();
          throw new Error(`quick_check returned: ${String(row).slice(0, 200)}`);
        }
        db = candidate;
      } catch {
        // Page-level corruption — quarantine the bytes and start fresh
        // (database.ts:64-78 tryLoadOrQuarantine catch branch).
        await persistence.quarantineImage(image).catch(() => {});
        db = new SQL.Database();
      }
    } else {
      // Header corruption (e.g. an all-zero buffer from a failed flush) —
      // quarantine and start fresh (database.ts:54-55).
      await persistence.quarantineImage(image).catch(() => {});
      db = new SQL.Database();
    }
  } else {
    // First run: no persisted image.
    db = new SQL.Database();
  }

  // In-memory journaling (sql.js is fully in-memory; persisted via export()).
  db.run('PRAGMA journal_mode = MEMORY');
  // Idempotent: creates the tables on first run, no-op on a restored image.
  applyAndroidSchema(db);

  return new AndroidDatabase(db, persistence);
}
