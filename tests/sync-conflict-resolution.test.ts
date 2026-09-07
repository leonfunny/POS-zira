import initSqlJs, { type Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: null as Database | null }));
vi.mock('../src/main/database/database', () => ({
  database: {
    run: (sql: string, params: any[] = []) => state.db!.run(sql, params),
    get: (sql: string, params: any[] = []) => {
      const stmt = state.db!.prepare(sql, params);
      try { return stmt.step() ? stmt.getAsObject() : undefined; } finally { stmt.free(); }
    },
    all: (sql: string, params: any[] = []) => {
      const stmt = state.db!.prepare(sql, params);
      const rows = [];
      try { while (stmt.step()) rows.push(stmt.getAsObject()); return rows; } finally { stmt.free(); }
    },
    transaction: (fn: () => void) => {
      state.db!.run('BEGIN');
      try { fn(); state.db!.run('COMMIT'); } catch (error) { state.db!.run('ROLLBACK'); throw error; }
    },
    markDirty: vi.fn(),
  },
}));
vi.mock('../src/main/network/api-client', () => ({ apiClient: {} }));
vi.mock('../src/main/config/store', () => ({ getConfigValue: () => 'agent-test', getSecureAuthToken: () => 'token' }));
vi.mock('../src/main/sync/entity-applicators', () => ({ applyEntry: vi.fn() }));
vi.mock('../src/main/pos/ksef-auto-issue', () => ({ triggerKsefAutoIssue: vi.fn() }));
vi.mock('../src/main/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { SyncLogService } from '../src/main/sync/sync-log-service';
import { syncLogRepo } from '../src/main/sync/sync-log-repo';

describe('conflict retry with real SQLite repository operations', () => {
  let service: SyncLogService;
  beforeEach(async () => {
    const SQL = await initSqlJs();
    state.db = new SQL.Database();
    state.db.run(`
      CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
      CREATE TABLE local_sync_log (id INTEGER PRIMARY KEY, status TEXT, rejection_code TEXT, rejection_detail TEXT);
      CREATE TABLE sync_conflicts (id INTEGER PRIMARY KEY, log_entry_id INTEGER, resolution TEXT, resolved_at TEXT, created_at TEXT);
      INSERT INTO local_sync_log VALUES (8, 'rejected', 'OVERSELL', 'insufficient stock');
      INSERT INTO sync_conflicts VALUES (1, 8, NULL, NULL, '2026-09-07');
    `);
    service = new SyncLogService();
  });
  afterEach(() => { vi.restoreAllMocks(); state.db!.close(); });

  it('requeues the entry before clearing the unresolved conflict', () => {
    service.resolveConflict(1, 'retried');
    expect(state.db!.exec('SELECT status, rejection_code FROM local_sync_log')[0].values).toEqual([['pending', null]]);
    expect(syncLogRepo.getUnresolvedConflicts()).toEqual([]);
  });

  it('acknowledgement does not claim to retry a rejected entry', () => {
    service.resolveConflict(1, 'acknowledged');
    expect(state.db!.exec('SELECT status FROM local_sync_log')[0].values).toEqual([['rejected']]);
    expect(syncLogRepo.getUnresolvedConflicts()).toEqual([]);
  });

  it('rolls the retry back if acknowledging the conflict fails', () => {
    vi.spyOn(syncLogRepo, 'resolveConflict').mockImplementation(() => { throw new Error('disk error'); });
    expect(() => service.resolveConflict(1, 'retried')).toThrow('disk error');
    expect(state.db!.exec('SELECT status FROM local_sync_log')[0].values).toEqual([['rejected']]);
    expect(syncLogRepo.getUnresolvedConflicts()).toHaveLength(1);
  });

  it('rejects stale and unsupported actions without changing the log', () => {
    expect(() => service.resolveConflict(999, 'retried')).toThrow('no longer available');
    expect(() => service.resolveConflict(1, 'unknown')).toThrow('Unsupported');
    expect(state.db!.exec('SELECT status FROM local_sync_log')[0].values).toEqual([['rejected']]);
  });
});
