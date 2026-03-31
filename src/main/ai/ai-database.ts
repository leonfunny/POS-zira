/**
 * AI Database Helper
 * Provides a better-sqlite3-like interface on top of the existing sql.js database
 */

import { database } from '../database/database';
import logger from '../logger';

/**
 * A prepared statement-like object for sql.js
 */
class PreparedStatement {
  private db: any;
  private sql: string;

  constructor(db: any, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  run(...params: any[]): { changes: number; lastInsertRowid: number } {
    try {
      this.db.run(this.sql, params);
      // sql.js doesn't return changes directly, but we can estimate
      const result = this.db.exec('SELECT changes() as changes, last_insert_rowid() as lastId');
      if (result.length > 0 && result[0].values.length > 0) {
        return {
          changes: result[0].values[0][0] as number,
          lastInsertRowid: result[0].values[0][1] as number,
        };
      }
      return { changes: 0, lastInsertRowid: 0 };
    } catch (error) {
      logger.error('[AIDb] Run error:', error);
      throw error;
    }
  }

  get(...params: any[]): any {
    try {
      const stmt = this.db.prepare(this.sql);
      if (params.length > 0) stmt.bind(params);
      const result = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      return result;
    } catch (error) {
      logger.error('[AIDb] Get error:', error);
      throw error;
    }
  }

  all(...params: any[]): any[] {
    try {
      const stmt = this.db.prepare(this.sql);
      if (params.length > 0) stmt.bind(params);
      const results: any[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
      return results;
    } catch (error) {
      logger.error('[AIDb] All error:', error);
      throw error;
    }
  }
}

/**
 * AI Database wrapper with better-sqlite3-like interface
 */
class AIDatabase {
  private initialized = false;

  /**
   * Get the underlying database (sql.js instance)
   */
  private getDb(): any {
    // Access the private db property through the database wrapper methods
    // We'll use the database's existing methods
    return (database as any).db;
  }

  /**
   * Check if database is available
   */
  isAvailable(): boolean {
    const db = this.getDb();
    return db !== null;
  }

  /**
   * Execute multi-statement SQL (like CREATE TABLE)
   */
  exec(sql: string): void {
    const db = this.getDb();
    if (!db) {
      logger.warn('[AIDb] Database not available for exec');
      return;
    }
    try {
      db.run(sql);
    } catch (error) {
      logger.error('[AIDb] Exec error:', error);
      throw error;
    }
  }

  /**
   * Prepare a statement for reuse
   */
  prepare(sql: string): PreparedStatement {
    const db = this.getDb();
    if (!db) {
      throw new Error('Database not available');
    }
    return new PreparedStatement(db, sql);
  }

  /**
   * Run a simple query with parameters
   */
  run(sql: string, ...params: any[]): { changes: number; lastInsertRowid: number } {
    const db = this.getDb();
    if (!db) {
      return { changes: 0, lastInsertRowid: 0 };
    }
    try {
      db.run(sql, params);
      const result = db.exec('SELECT changes() as changes, last_insert_rowid() as lastId');
      if (result.length > 0 && result[0].values.length > 0) {
        return {
          changes: result[0].values[0][0] as number,
          lastInsertRowid: result[0].values[0][1] as number,
        };
      }
      return { changes: 0, lastInsertRowid: 0 };
    } catch (error) {
      logger.error('[AIDb] Run error:', error);
      return { changes: 0, lastInsertRowid: 0 };
    }
  }

  /**
   * Get a single row
   */
  get<T = any>(sql: string, ...params: any[]): T | null {
    return database.get<T>(sql, params);
  }

  /**
   * Get all rows
   */
  all<T = any>(sql: string, ...params: any[]): T[] {
    return database.all<T>(sql, params);
  }
}

// Singleton instance
export const aiDatabase = new AIDatabase();

/**
 * Get the AI database instance (for compatibility with existing code)
 */
export function getDatabase(): AIDatabase | null {
  if (!aiDatabase.isAvailable()) {
    return null;
  }
  return aiDatabase;
}
