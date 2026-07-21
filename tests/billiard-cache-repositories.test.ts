import { afterEach, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { database } from '../src/main/database/database';
import { billiardSessionRepo } from '../src/main/database/repos/billiard-session-repo';
import {
  billiardMutationRepo,
  SAFE_BILLIARD_REPLAY_OPERATIONS,
} from '../src/main/database/repos/billiard-mutation-repo';
import { billiardFloorPlanRepo } from '../src/main/database/repos/billiard-floor-plan-repo';
import {
  replaceBilliardResources,
  upsertBilliardResources,
} from '../src/main/database/repos/billiard-resource-cache';

async function createCacheDb() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  db.run(`
    CREATE TABLE billiard_resources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT,
      type_id TEXT,
      type_name TEXT,
      pricing_rules TEXT,
      payload_json TEXT,
      is_active INTEGER,
      updated_at TEXT
    );
    CREATE TABLE billiard_floor_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      floor_number INTEGER,
      room_width_m REAL,
      room_height_m REAL,
      background_image TEXT,
      updated_at TEXT
    );
    CREATE TABLE billiard_table_layouts (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      floor_plan_id TEXT,
      position_x REAL,
      position_y REAL,
      rotation REAL,
      width_pct REAL,
      height_pct REAL,
      shape TEXT,
      asset_key TEXT,
      updated_at TEXT,
      FOREIGN KEY (resource_id) REFERENCES billiard_resources(id),
      FOREIGN KEY (floor_plan_id) REFERENCES billiard_floor_plans(id)
    );
  `);
  return db;
}

describe('billiard cache repositories', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates a resource in place without deleting its FK-referenced layout', async () => {
    const db = await createCacheDb();
    const runner = { run: (sql: string, params?: any[]) => db.run(sql, params) };
    upsertBilliardResources(runner, [{ id: 'table-1', name: 'Old name' }]);
    db.run("INSERT INTO billiard_table_layouts (id, resource_id) VALUES ('layout-1', 'table-1')");

    expect(() => upsertBilliardResources(runner, [{ id: 'table-1', name: 'New name' }])).not.toThrow();
    expect(db.exec("SELECT name FROM billiard_resources WHERE id = 'table-1'")[0].values[0][0]).toBe('New name');
    expect(db.exec('SELECT COUNT(*) FROM billiard_table_layouts')[0].values[0][0]).toBe(1);
    db.close();
  });

  it('removes stale layouts before their resources under foreign-key enforcement', async () => {
    const db = await createCacheDb();
    const runner = { run: (sql: string, params?: any[]) => db.run(sql, params) };
    upsertBilliardResources(runner, [
      { id: 'table-1', name: 'Keep' },
      { id: 'table-2', name: 'Remove' },
    ]);
    db.run("INSERT INTO billiard_table_layouts (id, resource_id) VALUES ('layout-2', 'table-2')");

    expect(() => replaceBilliardResources(runner, [{ id: 'table-1', name: 'Keep' }])).not.toThrow();
    expect(db.exec('SELECT id FROM billiard_resources ORDER BY id')[0].values).toEqual([['table-1']]);
    expect(db.exec('SELECT COUNT(*) FROM billiard_table_layouts')[0].values[0][0]).toBe(0);
    db.close();
  });

  it('hydrates a fresh FK-enforced cache by inserting floor and resource parents before layouts', async () => {
    const db = await createCacheDb();
    const runner = { run: (sql: string, params?: any[]) => db.run(sql, params) };
    vi.spyOn(database as any, 'run').mockImplementation(
      (sql: string, params?: any[]) => db.run(sql, params),
    );
    vi.spyOn(database as any, 'get').mockImplementation(
      (sql: string, params?: any[]) => {
        const statement = db.prepare(sql);
        try {
          statement.bind(params || []);
          return statement.step() ? statement.getAsObject() : undefined;
        } finally {
          statement.free();
        }
      },
    );
    const floor = { id: 'floor-1', name: 'Main floor', floorNumber: 1 };
    const layout = {
      id: 'layout-1',
      resourceId: 'table-1',
      floorPlanId: 'floor-1',
      positionX: 10,
      positionY: 20,
    };

    billiardFloorPlanRepo.upsertMany([floor]);
    billiardFloorPlanRepo.upsertLayouts([layout]);
    expect(db.exec('SELECT COUNT(*) FROM billiard_table_layouts')[0].values[0][0]).toBe(0);

    replaceBilliardResources(runner, [{ id: 'table-1', name: 'Table 1' }]);
    expect(() => billiardFloorPlanRepo.upsertLayouts([layout])).not.toThrow();
    expect(db.exec('SELECT id FROM billiard_table_layouts')[0].values).toEqual([
      ['layout-1'],
    ]);
    db.close();
  });

  it('defers a dashboard layout when its floor-plan parent is still missing', async () => {
    const db = await createCacheDb();
    const runner = { run: (sql: string, params?: any[]) => db.run(sql, params) };
    vi.spyOn(database as any, 'run').mockImplementation(
      (sql: string, params?: any[]) => db.run(sql, params),
    );
    vi.spyOn(database as any, 'get').mockImplementation(
      (sql: string, params?: any[]) => {
        const statement = db.prepare(sql);
        try {
          statement.bind(params || []);
          return statement.step() ? statement.getAsObject() : undefined;
        } finally {
          statement.free();
        }
      },
    );
    replaceBilliardResources(runner, [{ id: 'table-1', name: 'Table 1' }]);

    expect(() => billiardFloorPlanRepo.upsertLayouts([{
      id: 'layout-1',
      resourceId: 'table-1',
      floorPlanId: 'floor-not-synced',
    }])).not.toThrow();
    expect(db.exec('SELECT COUNT(*) FROM billiard_table_layouts')[0].values[0][0]).toBe(0);
    db.close();
  });

  it('prunes deleted floor plans and detaches stale local layouts', async () => {
    const db = await createCacheDb();
    db.run("INSERT INTO billiard_resources (id, name) VALUES ('table-1', 'Table 1')");
    db.run(`
      INSERT INTO billiard_floor_plans (id, name, floor_number) VALUES
        ('floor-1', 'Floor 1', 1),
        ('floor-2-stale', 'Floor 2', 2)
    `);
    db.run(`
      INSERT INTO billiard_table_layouts (id, resource_id, floor_plan_id)
      VALUES ('layout-1', 'table-1', 'floor-2-stale')
    `);
    vi.spyOn(database as any, 'run').mockImplementation(
      (sql: string, params?: any[]) => db.run(sql, params),
    );

    billiardFloorPlanRepo.syncSnapshot([
      { id: 'floor-1', name: 'Floor 1', floorNumber: 1 },
    ]);

    expect(db.exec('SELECT id FROM billiard_floor_plans ORDER BY id')[0].values).toEqual([
      ['floor-1'],
    ]);
    expect(db.exec('SELECT floor_plan_id FROM billiard_table_layouts')[0].values).toEqual([
      [null],
    ]);
    db.close();
  });

  it('does not resurrect a completed payment-journal row from a stale dashboard', () => {
    vi.spyOn(database as any, 'all')
      .mockReturnValueOnce([{ id: 'session-ended' }])
      .mockReturnValueOnce([{ id: 'session-old-active' }]);
    vi.spyOn(database as any, 'run').mockReturnValue(undefined);
    const upsertMany = vi
      .spyOn(billiardSessionRepo, 'upsertMany')
      .mockImplementation(() => undefined);

    billiardSessionRepo.replaceActive([
      { id: 'session-ended', status: 'ACTIVE' },
      { id: 'session-current', status: 'ACTIVE' },
    ]);

    expect(upsertMany).toHaveBeenCalledWith([
      { id: 'session-current', status: 'ACTIVE' },
    ]);
  });

  it('recovers the authoritative pending snapshot and preserves only fresh paid tombstones', () => {
    const now = Date.now();
    vi.spyOn(database as any, 'all').mockReturnValue([
      {
        id: 'session-server-settled',
        payload_json: JSON.stringify({ paymentStatus: 'UNPAID' }),
        updated_at: new Date(now - 20_000).toISOString(),
      },
      {
        id: 'session-paid-fresh',
        payload_json: JSON.stringify({ paymentStatus: 'PAID' }),
        updated_at: new Date(now - 2_000).toISOString(),
      },
      {
        id: 'session-paid-old',
        payload_json: JSON.stringify({ paymentStatus: 'PAID' }),
        updated_at: new Date(now - 20_000).toISOString(),
      },
    ]);
    const deleteById = vi
      .spyOn(billiardSessionRepo, 'deleteById')
      .mockImplementation(() => undefined);
    const upsertOne = vi
      .spyOn(billiardSessionRepo, 'upsertOne')
      .mockImplementation(() => undefined);

    billiardSessionRepo.reconcilePendingSnapshot(
      [{ id: 'session-pending', paymentStatus: 'UNPAID' }],
      now,
    );

    expect(deleteById).toHaveBeenCalledWith('session-server-settled');
    expect(deleteById).toHaveBeenCalledWith('session-paid-old');
    expect(deleteById).not.toHaveBeenCalledWith('session-paid-fresh');
    expect(upsertOne).toHaveBeenCalledWith({
      id: 'session-pending',
      paymentStatus: 'UNPAID',
    });
  });

  it('prunes an expired paid tombstone even when the server snapshot is unchanged', () => {
    const now = Date.now();
    vi.spyOn(database as any, 'all').mockReturnValue([
      {
        id: 'session-paid-old',
        payload_json: JSON.stringify({ paymentStatus: 'PAID' }),
        updated_at: new Date(now - 20_000).toISOString(),
      },
      {
        id: 'session-paid-fresh',
        payload_json: JSON.stringify({ paymentStatus: 'PAID' }),
        updated_at: new Date(now - 2_000).toISOString(),
      },
      {
        id: 'session-unpaid',
        payload_json: JSON.stringify({ paymentStatus: 'UNPAID' }),
        updated_at: new Date(now - 20_000).toISOString(),
      },
    ]);
    const deleteById = vi
      .spyOn(billiardSessionRepo, 'deleteById')
      .mockImplementation(() => undefined);

    expect(billiardSessionRepo.pruneExpiredPaidTombstones(now)).toBe(1);
    expect(deleteById).toHaveBeenCalledWith('session-paid-old');
    expect(deleteById).not.toHaveBeenCalledWith('session-paid-fresh');
    expect(deleteById).not.toHaveBeenCalledWith('session-unpaid');
  });

  it('quarantines every unsafe legacy queue row before recovering safe replays', () => {
    const run = vi.spyOn(database as any, 'run').mockReturnValue(undefined);
    vi.spyOn(database as any, 'get')
      .mockReturnValueOnce({ count: 2 })
      .mockReturnValueOnce({ count: 1 });

    expect(billiardMutationRepo.recoverInterrupted()).toEqual({
      recovered: 1,
      quarantined: 2,
    });
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("status = 'quarantined'"),
      [...SAFE_BILLIARD_REPLAY_OPERATIONS],
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("status = 'in_flight' AND operation IN"),
      [...SAFE_BILLIARD_REPLAY_OPERATIONS],
    );
  });

  it('selects only allowlisted queue-safe operation labels for replay', () => {
    const all = vi.spyOn(database as any, 'all').mockReturnValue([]);

    expect(billiardMutationRepo.getPending()).toEqual([]);
    expect(all).toHaveBeenCalledWith(
      expect.stringContaining("status = 'pending' AND operation IN"),
      [...SAFE_BILLIARD_REPLAY_OPERATIONS],
    );
  });
});
