import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { app } from 'electron';
import { join } from 'path';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import logger from '../logger';
import { migrations } from './migrations';
import { atomicWriteFile, atomicWriteFileSync } from './atomic-write';
import type { BackupFlushResult } from './backup-service';

class Database {
  private db: SqlJsDatabase | null = null;
  private dbPath: string = '';
  private saveInterval: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

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
      this.db = new SQL.Database(buffer);
      logger.info(`[DB] Loaded existing database: ${this.dbPath}`);
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
  }

  async save(): Promise<BackupFlushResult> {
    if (!this.db) {
      return { success: false, dbPath: this.dbPath || undefined, error: 'Database not initialized' };
    }
    if (this.saving) {
      return { success: false, dbPath: this.dbPath || undefined, error: 'Database save already in progress' };
    }
    this.saving = true;

    try {
      const data = this.db.export();
      await atomicWriteFile(this.dbPath, Buffer.from(data));
      this.dirty = false;
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
   * Synchronous flush — only for shutdown where the event loop is about to
   * exit and an async save can't reliably complete. Repos must not call this.
   */
  saveSync(): BackupFlushResult {
    if (!this.db) {
      return { success: false, dbPath: this.dbPath || undefined, error: 'Database not initialized' };
    }
    try {
      const data = this.db.export();
      atomicWriteFileSync(this.dbPath, Buffer.from(data));
      this.dirty = false;
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
    this.dirty = true;
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
      this.dirty = true;
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
  clearSalonData(): void {
    if (!this.db) {
      logger.warn('[DB] Cannot clear data: database not initialized');
      return;
    }

    logger.info('[DB] Clearing salon-specific data for tenant isolation...');

    const tablesToClear = [
      'order_items',      // Must be first (FK to orders)
      'orders',
      'forecast_order_draft_lines',
      'forecast_order_drafts',
      'forecast_recommendations',
      'forecast_runs',
      'replenishment_policies',
      'shifts',
      'product_variants',
      'categories',
      'pos_tables',
      'pos_customers',
      'pos_staff',
      'pos_hold_orders',
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
      // Booking pipeline (FK order: bookings ← service_rules ← services).
      // Wiping these on salon switch / re-login matches the rest of the
      // tenant-isolation contract: the previous behavior left bookings
      // around while local_sync_log got cleared, so the next cancel
      // pushed a status_changed for a booking the server had never
      // received (NOT_FOUND on TEST123 / 5KOL on 2026-04-30).
      'bookings',
      'service_rules',
      'services',
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
    ];

    // SECURITY: Validate table names against known set (defense-in-depth — prevents injection if list ever becomes dynamic)
    const validTablePattern = /^[a-z_]+$/;

    this.transaction(() => {
      for (const table of tablesToClear) {
        if (!validTablePattern.test(table)) {
          logger.error(`[DB] Invalid table name rejected: ${table}`);
          continue;
        }
        try {
          this.db!.run(`DELETE FROM ${table}`);
          logger.info(`[DB] Cleared table: ${table}`);
        } catch (error) {
          // Table might not exist in older versions
          logger.warn(`[DB] Could not clear table ${table}:`, error);
        }
      }

      // Reset sync metadata to force full sync on next login
      try {
        this.db!.run(`DELETE FROM sync_metadata`);
        logger.info('[DB] Reset sync metadata');
      } catch (error) {
        logger.warn('[DB] Could not reset sync_metadata:', error);
      }
    });

    this.dirty = true;
    // Fire-and-forget — auto-save loop will pick up the dirty flag within 5s.
    // Awaiting here would force callers to be async unnecessarily.
    void this.save();
    logger.info('[DB] Salon data cleared successfully');
  }

  private runMigrations(): void {
    // Ensure schema_version table exists
    this.db!.run(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `);

    const applied = new Set<number>();
    const stmt = this.db!.prepare('SELECT version FROM _schema_version');
    while (stmt.step()) {
      const row = stmt.getAsObject() as { version: number };
      applied.add(row.version);
    }
    stmt.free();

    let count = 0;
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;

      logger.info(`[DB] Running migration v${migration.version}: ${migration.name}`);
      // Split by semicolons and run each statement
      const statements = migration.up
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const sql of statements) {
        this.db!.run(sql);
      }

      this.db!.run('INSERT INTO _schema_version (version, name) VALUES (?, ?)', [
        migration.version,
        migration.name,
      ]);
      count++;
    }

    if (count > 0) {
      logger.info(`[DB] Applied ${count} migration(s)`);
      this.dirty = true;
    }
  }
}

export const database = new Database();
