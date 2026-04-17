import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { app } from 'electron';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import logger from '../logger';
import { migrations } from './migrations';

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

    // Auto-save every 5 seconds if dirty
    this.saveInterval = setInterval(() => {
      if (this.dirty) {
        this.save();
      }
    }, 5000);
  }

  private consecutiveFailures = 0;
  private saving = false;

  save(): void {
    if (!this.db) return;
    if (this.saving) return; // Prevent concurrent saves
    this.saving = true;

    try {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
      this.dirty = false;
      if (this.consecutiveFailures > 0) {
        logger.info(`[DB] Save recovered after ${this.consecutiveFailures} failures`);
        this.consecutiveFailures = 0;
      }
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
    } finally {
      this.saving = false;
    }
  }

  run(sql: string, params?: any[]): void {
    if (!this.db) {
      logger.error('[DB] Cannot run query: database not initialized');
      return;
    }
    this.db.run(sql, params);
    this.dirty = true;
  }

  get<T = any>(sql: string, params?: any[]): T | null {
    if (!this.db) {
      logger.error('[DB] Cannot get: database not initialized');
      return null;
    }
    const stmt = this.db.prepare(sql);
    try {
      if (params) stmt.bind(params);
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
      if (params) stmt.bind(params);
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
    this.save(); // Final save
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
      // Sync state
      'change_feed_cursor',
      // Path B sync log tables
      'local_sync_log',
      'sync_conflicts',
      'sync_state',
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
    this.save();
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
