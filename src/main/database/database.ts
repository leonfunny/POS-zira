import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { app } from 'electron';
import { join } from 'path';
import { readFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import logger from '../logger';
import { migrations, type Migration } from './migrations';
import { atomicWriteFile, atomicWriteFileSync } from './atomic-write';
import type { BackupFlushResult } from './backup-service';

class Database {
  // SQLite file format magic — bytes 0..14 spell "SQLite format 3" then
  // a NUL terminator at byte 15. See https://www.sqlite.org/fileformat.html.
  private static readonly SQLITE_MAGIC = 'SQLite format 3';

  private db: SqlJsDatabase | null = null;
  private dbPath: string = '';
  /** Bumped after every durable clearSalonData; sync writers fence on it so
   *  a fetch started under the previous tenant can never apply its payload. */
  private tenantGeneration = 0;
  private saveInterval: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private dirtyVersion = 0;

  /**
   * Cheap header sanity check before handing a buffer to sql.js. sql.js
   * throws an unrecoverable "file is not a database" if magic is wrong,
   * and that throw happens *inside* its WASM trampoline where we can't
   * cleanly recover — so we have to gate at the JS layer instead.
   * Returns false for any file shorter than 16 bytes or with mismatched
   * magic.
   */
  static isValidSqliteHeader(buffer: Buffer): boolean {
    if (buffer.length < 16) return false;
    return buffer.slice(0, 15).toString('ascii') === Database.SQLITE_MAGIC;
  }

  /**
   * Move a corrupt pos.db aside with a timestamp suffix so it survives
   * for forensic inspection. Logs the path + size + first-16-bytes hex
   * so the runtime team can grep `\[DB\] Quarantined corrupt database`
   * to find every occurrence. If the rename itself fails (file locked
   * by another process, ACL issue), log and return — the caller will
   * still recover by creating a fresh empty DB on top of the corrupt
   * file's path (overwriting it on first save).
   */
  /**
   * Attempt to open `buffer` with sql.js and verify it can answer a basic
   * sqlite_master query. Two failure modes are caught here:
   *
   *  1. Header corruption (Type B from Windows SSD fsync lie) — sql.js
   *     throws "file is not a database" inside the WASM trampoline at
   *     construction time. We catch the throw at the JS layer.
   *  2. Page-level corruption — header is valid, file loads, but pages
   *     past the schema root have bad checksums. sql.js succeeds in
   *     `new SQL.Database(buffer)` but the first read query throws
   *     "database disk image is malformed". Without this probe, the
   *     orchestrator boots OK, login succeeds, then `clearSalonData`
   *     transaction explodes and post-login sync sees malformed errors
   *     forever — leaving the cashier staring at an empty catalog.
   *
   * Returns the loaded database when sane, or null when the buffer was
   * quarantined (caller should create a fresh empty DB on top of the
   * now-renamed path). Probe uses `PRAGMA quick_check` — SQLite walks
   * every page and verifies btree linkage. An earlier version probed
   * only `SELECT count(*) FROM sqlite_master` (schema root page) and
   * passed clean on a file whose product/booking pages were corrupt,
   * letting the app run with a poisoned database. quick_check on a 6MB
   * file runs in tens of milliseconds and catches that.
   */
  static tryLoadOrQuarantine(
    SQL: { Database: new (data?: Buffer) => SqlJsDatabase },
    buffer: Buffer,
    dbPath: string,
  ): SqlJsDatabase | null {
    if (!Database.isValidSqliteHeader(buffer)) {
      Database.quarantineCorruptFile(dbPath, buffer);
      return null;
    }
    let candidate: SqlJsDatabase | null = null;
    try {
      candidate = new SQL.Database(buffer);
      // PRAGMA quick_check returns a single row with the literal 'ok' on
      // a clean database. Any other value (e.g. "*** in database main ***
      // Page 47: btree ...") is an integrity error and we must NOT use
      // this database — let the caller recreate empty and resync from
      // backend. quick_check skips cross-table index/value validation
      // (slower integrity_check does that), but catches every page-level
      // corruption we've seen in the wild on Windows POS terminals.
      const result = candidate.exec('PRAGMA quick_check');
      const row = result?.[0]?.values?.[0]?.[0];
      if (row !== 'ok') {
        throw new Error(`quick_check returned: ${String(row).slice(0, 200)}`);
      }
      return candidate;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        `[DB] Corrupt database detected during integrity probe (${reason}); quarantining.`,
      );
      try {
        candidate?.close();
      } catch {
        // closing a half-constructed db can throw — safe to ignore
      }
      Database.quarantineCorruptFile(dbPath, buffer);
      return null;
    }
  }

  static quarantineCorruptFile(dbPath: string, buffer: Buffer): void {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${dbPath}.corrupted-${ts}`;
    const headHex = buffer
      .slice(0, 16)
      .toString('hex')
      .match(/../g)
      ?.join(' ');
    logger.error(
      `[DB] Quarantined corrupt database: path=${dbPath} size=${buffer.length} headHex="${headHex}" → ${target}`,
    );
    try {
      renameSync(dbPath, target);
    } catch (err) {
      logger.error(
        `[DB] Failed to quarantine corrupt file (continuing with fresh DB): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async initialize(): Promise<void> {
    if (this.db) {
      logger.warn('[DB] Already initialized, skipping');
      return;
    }

    const userDataPath = app.getPath('userData');
    this.dbPath = join(userDataPath, 'pos.db');

    // Ensure directory exists
    const dir = join(userDataPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // sql.js needs the WASM file path in Node/Electron
    const SQL = await initSqlJs();

    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      const loaded = Database.tryLoadOrQuarantine(SQL, buffer, this.dbPath);
      if (loaded) {
        this.db = loaded;
        logger.info(`[DB] Loaded existing database: ${this.dbPath}`);
      } else {
        this.db = new SQL.Database();
        logger.info(`[DB] Created fresh empty database after corruption quarantine: ${this.dbPath}`);
      }
    } else {
      this.db = new SQL.Database();
      logger.info(`[DB] Created new database: ${this.dbPath}`);
    }

    // In-memory journaling (sql.js is fully in-memory, persisted via export())
    this.db.run('PRAGMA journal_mode = MEMORY');
    this.db.run('PRAGMA foreign_keys = ON');

    this.runMigrations();

    // Auto-save every 5 seconds if dirty. Skip when a save is already in
    // flight so overlapping writes don't queue up.
    this.saveInterval = setInterval(() => {
      if (this.dirty && !this.saving) {
        void this.save();
      }
    }, 5000);
  }

  private consecutiveFailures = 0;
  private saving = false;

  /**
   * Flag the DB as dirty so the 5s auto-save loop will flush it. O(1) and
   * never touches disk — repos should call this on hot mutation paths instead
   * of {@link save}, so a single user action that triggers many small writes
   * doesn't fan out into N synchronous full-DB flushes that stall IPC.
   */
  markDirty(): void {
    this.dirty = true;
    this.dirtyVersion++;
  }

  async save(): Promise<BackupFlushResult> {
    if (!this.db) {
      return { success: false, dbPath: this.dbPath || undefined, error: 'Database not initialized' };
    }
    if (this.saving) {
      return { success: false, dbPath: this.dbPath || undefined, error: 'Database save already in progress' };
    }
    this.saving = true;
    const saveVersion = this.dirtyVersion;

    try {
      const data = this.db.export();
      await atomicWriteFile(this.dbPath, Buffer.from(data));
      if (this.dirtyVersion === saveVersion) {
        this.dirty = false;
      } else {
        logger.debug('[DB] Save completed with newer changes still dirty; scheduling another flush');
      }
      if (this.consecutiveFailures > 0) {
        logger.info(`[DB] Save recovered after ${this.consecutiveFailures} failures`);
        this.consecutiveFailures = 0;
      }
      return { success: true, dbPath: this.dbPath };
    } catch (error) {
      this.consecutiveFailures++;
      logger.error(`[DB] Save failed (consecutive failures: ${this.consecutiveFailures}):`, error);

      // Notify renderer windows about persistent save failure
      if (this.consecutiveFailures >= 2) {
        try {
          const { BrowserWindow } = require('electron');
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('db:save-error', {
                consecutiveFailures: this.consecutiveFailures,
                dbPath: this.dbPath,
              });
            }
          }
        } catch { /* ignore if electron not ready */ }
      }
      return {
        success: false,
        dbPath: this.dbPath || undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.saving = false;
    }
  }

  /**
   * Durability barrier for safety ledgers. If the periodic autosave currently
   * owns the exporter, wait for it and then save the latest dirty version.
   * This avoids treating a healthy, large pos.db as failed merely because its
   * atomic write takes longer than a few hundred milliseconds.
   */
  async saveCoalesced(timeoutMs = 5000): Promise<BackupFlushResult> {
    const deadline = Date.now() + Math.max(100, timeoutMs);
    while (this.saving) {
      if (Date.now() >= deadline) {
        return {
          success: false,
          dbPath: this.dbPath || undefined,
          error: 'Database save remained in progress past durability deadline',
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.save();
  }

  /**
   * Synchronous flush — only for shutdown where the event loop is about to
   * exit and an async save can't reliably complete. Repos must not call this.
   */
  saveSync(): BackupFlushResult {
    if (!this.db) {
      return { success: false, dbPath: this.dbPath || undefined, error: 'Database not initialized' };
    }
    // Async and sync atomic writers share `<pos.db>.tmp`. Never let saveSync
    // race an in-flight async export/write: the two renames can report false
    // success, overwrite a newer snapshot, or corrupt the temp-file protocol.
    // Synchronous callers fail closed and may retry after the async writer.
    if (this.saving) {
      return {
        success: false,
        dbPath: this.dbPath || undefined,
        error: 'Database async save is in progress; synchronous save refused',
      };
    }
    try {
      const saveVersion = this.dirtyVersion;
      const data = this.db.export();
      atomicWriteFileSync(this.dbPath, Buffer.from(data));
      if (this.dirtyVersion === saveVersion) {
        this.dirty = false;
      }
      return { success: true, dbPath: this.dbPath };
    } catch (error) {
      logger.error('[DB] saveSync failed:', error);
      return {
        success: false,
        dbPath: this.dbPath || undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async flushToDiskForBackup(): Promise<BackupFlushResult> {
    return this.save();
  }

  private sanitizeParams(params?: any[]): any[] | undefined {
    if (!params) return params;
    return params.map(p => p === undefined ? null : p);
  }

  run(sql: string, params?: any[]): void {
    if (!this.db) {
      logger.error('[DB] Cannot run query: database not initialized');
      return;
    }
    this.db.run(sql, this.sanitizeParams(params));
    this.markDirty();
  }

  get<T = any>(sql: string, params?: any[]): T | null {
    if (!this.db) {
      logger.error('[DB] Cannot get: database not initialized');
      return null;
    }
    const stmt = this.db.prepare(sql);
    try {
      if (params) stmt.bind(this.sanitizeParams(params)!);
      return stmt.step() ? (stmt.getAsObject() as T) : null;
    } finally {
      stmt.free();
    }
  }

  all<T = any>(sql: string, params?: any[]): T[] {
    if (!this.db) {
      logger.error('[DB] Cannot query: database not initialized');
      return [];
    }
    const stmt = this.db.prepare(sql);
    try {
      if (params) stmt.bind(this.sanitizeParams(params)!);
      const results: T[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject() as T);
      }
      return results;
    } finally {
      stmt.free();
    }
  }

  transaction<T>(fn: () => T): T {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
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

  destroy(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    this.saveSync(); // Final save (sync — event loop is about to exit)
    this.db?.close();
    this.db = null;
    logger.info('[DB] Database closed');
  }

  /**
   * Clear all salon-specific data tables when switching salons.
   * This prevents data leakage between different salon accounts.
   * Keeps schema intact but removes all business data.
   */
  clearSalonData(
    salonId = '',
    options: { archivedReviewEvidence?: boolean } = {},
  ): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    this.assertSynchronousSaveAvailable('clearing salon data');

    logger.info('[DB] Clearing salon-specific data for tenant isolation...');

    const tablesToClear = [
      'kitchen_self_order_items',
      'kitchen_self_orders',
      // Receipt rows have already been guarded/cancelled above. On an
      // archived tenant switch the refreshed per-salon archive retains the
      // evidence; the live DB must not expose old payloads to the new tenant.
      'receipt_print_outbox',
      'order_items',      // Must be first (FK to orders)
      'orders',
      'forecast_order_draft_lines',
      'forecast_order_drafts',
      'forecast_recommendations',
      'forecast_runs',
      'replenishment_policies',
      'shifts',
      // Per-device end-of-day ledger. It is keyed by business_date alone, and
      // scheduling treats a SUCCESS row as "this date is done" -- so leaving
      // the previous tenant's rows behind would silently skip the new
      // tenant's first end-of-day: no shift close, no sync, no purge.
      'pos_eod_runs',
      // Product/catalog mirrors, including local-only imports from master drafts
      'product_admin_mutation_outbox',
      'local_variant_imports',
      'product_variants',
      'categories',
      'kitchen_self_order_category_prefs',
      'draft_products',
      'pos_tables',
      'pos_customers',
      'pos_staff',
      'pos_schedule_cache',
      'pos_hold_orders',
      'pos_billiard_handoffs',
      'pos_quickkey_assignments',  // FK to layouts, clear before layouts
      'pos_quickkey_layouts',
      'pos_recommended_items',
      'sequence_counters',
      // Check-in wizard tables (FK order: history → customers, popularity standalone)
      'customer_service_history',  // FK to salon_customers
      'salon_customers',
      'service_popularity',
      'checkins',
      'sync_queue',
      // Billiard tables (FK-aware order)
      'billiard_session_items',    // FK to sessions
      'billiard_sessions',
      'billiard_combo_items',      // FK to combos
      'billiard_combos',
      'billiard_table_layouts',    // FK to resources + floor plans
      'billiard_resources',
      'billiard_floor_plans',
      'billiard_mutation_queue',
      'billiard_history_cache',    // offline history cache is per-salon data
      // Booking pipeline (FK order: bookings ← service_rules ← services).
      // Wiping these on salon switch / re-login matches the rest of the
      // tenant-isolation contract: the previous behavior left bookings
      // around while local_sync_log got cleared, so the next cancel
      // pushed a status_changed for a booking the server had never
      // received (NOT_FOUND on TEST123 / 5KOL on 2026-04-30).
      'bookings',
      'service_rules',
      'services',
      // Local invoicing/accounting data (seller identity, customers, documents, products)
      'invoice_payments',
      'invoice_items',
      'invoices',
      'invoice_customers',
      'invoice_sequences',
      'accounting_products',
      'seller_settings',
      // Sync state
      'change_feed_cursor',
      // Path B sync log tables
      'local_sync_log',
      'sync_conflicts',
      'sync_state',
      // Local device mirrors
      'local_printers',
      // Local fiscal journal (contains order payloads and tax-device safety state)
      'fiscal_attempts',
      // Durable backend sync queue for fiscal receipt telemetry
      'fiscal_receipt_sync_queue',
      // Local automatic fiscal daily report guard/outbox
      'fiscal_daily_report_runs',
      // Local print journal (which printer printed each order receipt copy)
      'print_attempts',
      // ERP-AI cashflow event outbox: salon-scoped financial events. MUST be
      // cleared on tenant switch — otherwise pending events from the previous
      // salon would upload under the new salon's token (toEnvelope omits salonId,
      // backend trusts the JWT salon) and be attributed to the wrong tenant.
      'pos_event_outbox',
      // LAN_FIRST receiver dedupe ledger
      'lan_first_print_attempts',
    ];

    // SECURITY: Validate table names against known set (defense-in-depth — prevents injection if list ever becomes dynamic)
    const validTablePattern = /^[a-z_]+$/;

    this.transaction(() => {
      this.prepareReceiptPrintOutboxForTenantExitInTransaction(
        salonId,
        'Initial receipt cancelled before clearing salon data',
        { allowNeedsReview: options.archivedReviewEvidence === true },
      );
      for (const table of tablesToClear) {
        if (!validTablePattern.test(table)) {
          logger.error(`[DB] Invalid table name rejected: ${table}`);
          throw new Error(`Invalid table name rejected: ${table}`);
        }
        this.db!.run(`DELETE FROM ${table}`);
        logger.info(`[DB] Cleared table: ${table}`);
      }

      // Reset sync metadata to force full sync on next login
      this.db!.run(`DELETE FROM sync_metadata`);
      logger.info('[DB] Reset sync metadata');
    });

    this.markDirty();
    // Tenant switches must be durable before the next salon can continue.
    const flush = this.saveSync();
    if (!flush.success) {
      throw new Error(`Failed to persist cleared salon data: ${flush.error || 'unknown error'}`);
    }
    // Image bytes queued for a Product Workspace mutation are tenant-scoped
    // business data too. The leaving salon DB is archived before this method
    // runs; an explicit tenant switch intentionally discards live pending
    // commands/assets so they can never be sent under the next salon token.
    try {
      rmSync(join(app.getPath('userData'), 'product-admin-pending'), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      logger.warn(`[DB] Failed to clear product-admin pending assets: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.tenantGeneration += 1;
    logger.info('[DB] Salon data cleared successfully');
  }

  getTenantGeneration(): number {
    return this.tenantGeneration;
  }

  /**
   * Cancel only rows that are provably pre-dispatch before logout/salon
   * switch. Active dispatch/remote acceptance blocks the identity change;
   * archived tenant switches may retain NEEDS_REVIEW in the archive while
   * ordinary logout keeps it immutable in the live DB.
   */
  prepareReceiptPrintOutboxForTenantExit(
    salonId = '',
    reason = 'Initial receipt cancelled before leaving the salon session',
    options: { allowNeedsReview?: boolean } = {},
  ): { cancelled: number } {
    this.assertSynchronousSaveAvailable('preparing receipt state for tenant exit');
    let cancelled = 0;
    this.transaction(() => {
      cancelled = this.prepareReceiptPrintOutboxForTenantExitInTransaction(
        salonId,
        reason,
        options,
      );
    });
    // Ensure an older async save cannot clear the dirty flag for this guard
    // transition before the synchronous durability barrier below.
    this.markDirty();
    // Always cross a disk barrier, including a retry that sees CANCELLED in
    // memory after an earlier save failed. Otherwise logout/switch could
    // proceed while the on-disk row is still PENDING and resurrect it later.
    const flush = this.saveSync();
    if (!flush.success) {
      throw new Error(
        `Không thể lưu trạng thái hủy tác vụ in trước khi rời salon: ${flush.error || 'unknown error'}`,
      );
    }
    return { cancelled };
  }

  private assertSynchronousSaveAvailable(context: string): void {
    if (!this.saving) return;
    const error = new Error(
      `Database async save is in progress; ${context} was not started`,
    ) as Error & { code?: string };
    error.code = 'DATABASE_SAVE_IN_PROGRESS';
    throw error;
  }

  assertNoActiveReceiptPrintOutcomes(salonId = ''): void {
    const blocker = this.findUncertainReceiptPrintOutcome(salonId, false);
    if (blocker) {
      throw this.receiptPrintTenantExitBlockedError(blocker);
    }
  }

  private prepareReceiptPrintOutboxForTenantExitInTransaction(
    salonId: string,
    reason: string,
    options: { allowNeedsReview?: boolean } = {},
  ): number {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const blocker = this.findUncertainReceiptPrintOutcome(
      salonId,
      options.allowNeedsReview !== true,
    );
    if (blocker) {
      throw this.receiptPrintTenantExitBlockedError(blocker);
    }
    const scope = String(salonId || '').trim();
    const scopeClause = scope ? ' AND salon_id = ?' : '';
    const params = scope ? [scope] : [];
    const cancellable = this.get<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM receipt_print_outbox
       WHERE status IN ('PENDING', 'FAILED_SAFE')
       ${scopeClause}`,
      params,
    )?.count ?? 0;
    if (cancellable <= 0) return 0;

    const updatedAt = new Date().toISOString();
    this.run(
      `UPDATE receipt_print_outbox
       SET status = 'CANCELLED',
           failure_class = 'SAFE_BEFORE_PRINT',
           last_error = ?,
           next_attempt_at = NULL,
           updated_at = ?
       WHERE status IN ('PENDING', 'FAILED_SAFE')
       ${scopeClause}`,
      [String(reason || '').trim().slice(0, 2000), updatedAt, ...params],
    );
    return cancellable;
  }

  private findUncertainReceiptPrintOutcome(
    salonId: string,
    includeNeedsReview: boolean,
  ): {
    job_id: string;
    status: string;
    printer_id: string | null;
    remote_job_id: string | null;
  } | null {
    const scope = String(salonId || '').trim();
    const scopeClause = scope ? ' AND salon_id = ?' : '';
    const blockedStatuses = includeNeedsReview
      ? "'DISPATCHING', 'REMOTE_ACCEPTED', 'NEEDS_REVIEW'"
      : "'DISPATCHING', 'REMOTE_ACCEPTED'";
    return this.get<{
      job_id: string;
      status: string;
      printer_id: string | null;
      remote_job_id: string | null;
    }>(
      `SELECT job_id, status, printer_id, remote_job_id
       FROM receipt_print_outbox
       WHERE status IN (${blockedStatuses})
      ${scopeClause}
       ORDER BY seq ASC LIMIT 1`,
      scope ? [scope] : [],
    );
  }

  private receiptPrintTenantExitBlockedError(blocker: {
    job_id: string;
    status: string;
    remote_job_id: string | null;
  }): Error {
    const remoteIdentity = blocker.remote_job_id
      ? `, remote job ${blocker.remote_job_id}`
      : '';
    const error = new Error(
      `Không thể đăng xuất hoặc đổi salon khi kết quả in đơn chưa chắc chắn `
      + `(${blocker.status}, job ${blocker.job_id}${remoteIdentity}). `
      + 'Hãy kiểm tra giấy/máy in và xử lý cảnh báo in trước.',
    ) as Error & { code?: string; receiptPrintJobId?: string };
    error.code = 'RECEIPT_PRINT_OUTCOME_UNCERTAIN';
    error.receiptPrintJobId = blocker.job_id;
    return error;
  }

  private runMigrations(): void {
    const { applied, repaired } = Database.applyMigrations(this.db!, migrations);
    if (applied > 0 || repaired > 0) {
      logger.info(`[DB] Applied ${applied} migration(s), repaired ${repaired} diverged migration(s)`);
      this.dirty = true;
    }
  }

  /**
   * Apply pending migrations. Static + parameterized so tests can drive it
   * against an in-memory sql.js DB with synthetic migration lists.
   *
   * Hardened against two real failure modes:
   *
   * 1. LINEAGE DIVERGENCE — migrations are matched by (version, name), not
   *    version alone. A DB created on a branch where v9–16 were billiard
   *    migrations silently skipped main's v9–16 (checkin_wizard etc.) with
   *    the old version-only check, leaving tables missing months later
   *    ("no such table: customer_service_history", 2026-06-04). When the
   *    stored name differs from the code's, the migration is re-run in
   *    tolerant mode (IF NOT EXISTS DDL is naturally idempotent; "duplicate
   *    column"/"already exists" errors are skipped) and the row is
   *    re-stamped with the current name.
   *
   * 2. PARTIAL APPLY — each migration runs inside its own transaction. A
   *    mid-migration crash used to leave half-applied DDL with no version
   *    row; the retry then died forever on "duplicate column" and the app
   *    never booted again. With a transaction the retry starts clean.
   */
  static applyMigrations(
    db: SqlJsDatabase,
    migrationList: Migration[],
  ): { applied: number; repaired: number } {
    db.run(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `);

    const appliedByVersion = new Map<number, string>();
    const stmt = db.prepare('SELECT version, name FROM _schema_version');
    while (stmt.step()) {
      const row = stmt.getAsObject() as { version: number; name: string };
      appliedByVersion.set(row.version, row.name);
    }
    stmt.free();

    const runStatements = (migration: Migration, tolerateExisting: boolean): void => {
      // Split by semicolons and run each statement. NOTE: this breaks on
      // BEGIN…END trigger bodies — none exist today; add real splitting
      // before ever shipping a CREATE TRIGGER migration.
      const statements = migration.up
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const sql of statements) {
        try {
          db.run(sql);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (tolerateExisting && /duplicate column name|already exists/i.test(msg)) {
            logger.warn(
              `[DB] Migration v${migration.version} (${migration.name}) repair: skipping already-applied statement (${msg})`,
            );
            continue;
          }
          throw err;
        }
      }
    };

    let applied = 0;
    let repaired = 0;

    for (const migration of migrationList) {
      const appliedName = appliedByVersion.get(migration.version);
      if (appliedName === migration.name) continue;

      if (appliedName !== undefined) {
        logger.warn(
          `[DB] Migration lineage divergence at v${migration.version}: DB has "${appliedName}", code has "${migration.name}" — repairing`,
        );
        db.run('BEGIN');
        try {
          runStatements(migration, true);
          db.run(
            "UPDATE _schema_version SET name = ?, applied_at = datetime('now') WHERE version = ?",
            [migration.name, migration.version],
          );
          db.run('COMMIT');
        } catch (err) {
          db.run('ROLLBACK');
          logger.error(
            `[DB] Repair of diverged migration v${migration.version} (${migration.name}) failed:`,
            err,
          );
          throw err;
        }
        repaired++;
        continue;
      }

      logger.info(`[DB] Running migration v${migration.version}: ${migration.name}`);
      db.run('BEGIN');
      try {
        runStatements(migration, false);
        db.run('INSERT INTO _schema_version (version, name) VALUES (?, ?)', [
          migration.version,
          migration.name,
        ]);
        db.run('COMMIT');
      } catch (err) {
        db.run('ROLLBACK');
        logger.error(`[DB] Migration v${migration.version} (${migration.name}) failed (rolled back):`, err);
        throw err;
      }
      applied++;
    }

    return { applied, repaired };
  }
}

export const database = new Database();
