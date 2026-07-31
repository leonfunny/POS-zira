import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../src/main/network/api-client', () => ({
  apiClient: {
    syncPull: vi.fn(),
    syncPush: vi.fn(),
  },
}));

vi.mock('../src/main/config/store', () => ({
  getSecureAuthToken: vi.fn(() => 'test-token'),
  getConfigValue: vi.fn((key: string) => key === 'agentId' ? 'gm-test' : undefined),
}));

vi.mock('../src/main/logger', () => ({
  default: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { database } from '../src/main/database/database';
import { apiClient } from '../src/main/network/api-client';
import { SyncLogService } from '../src/main/sync/sync-log-service';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
let db: SqlJsDatabase;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function createSchema(target: SqlJsDatabase): void {
  target.run(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      order_number TEXT,
      status TEXT,
      subtotal INTEGER,
      discount INTEGER,
      tax INTEGER,
      total INTEGER,
      payment_method TEXT,
      payment_amount INTEGER,
      change_amount INTEGER,
      staff_id TEXT,
      staff_name TEXT,
      customer_id TEXT,
      customer_name TEXT,
      customer_nip TEXT,
      shift_id TEXT,
      source TEXT,
      table_id TEXT,
      covers INTEGER,
      order_type TEXT,
      tip INTEGER,
      mode TEXT,
      payment_tenders TEXT,
      client_attempt_id TEXT,
      billiard_origin_json TEXT,
      synced INTEGER,
      backend_id TEXT,
      synced_at TEXT,
      refund_amount INTEGER,
      refund_reason TEXT,
      refunded_at TEXT,
      refund_lines TEXT,
      server_status TEXT,
      server_updated_at TEXT,
      sync_error TEXT,
      created_at TEXT
    );

    CREATE TABLE order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      variant_id TEXT,
      name TEXT NOT NULL,
      sku TEXT,
      price INTEGER NOT NULL,
      quantity REAL NOT NULL,
      sale_quantity REAL,
      sale_unit TEXT,
      sell_by TEXT,
      total INTEGER NOT NULL,
      vat_rate REAL,
      staff_id TEXT,
      staff_name TEXT,
      notes TEXT,
      course INTEGER,
      billiard_json TEXT,
      inventory_policy TEXT,
      refund_policy TEXT,
      allocated_discount INTEGER,
      payable_total INTEGER,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE pos_staff (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      commission_rate INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT,
      role TEXT,
      backend_synced_at TEXT
    );

    CREATE TABLE local_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_tx TEXT NOT NULL UNIQUE,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      server_seq INTEGER,
      rejection_code TEXT,
      rejection_detail TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      pushed_at TEXT,
      resolved_at TEXT
    );

    CREATE TABLE sync_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    );
  `);
}

function canonicalEntry(seq = 1) {
  return {
    seq,
    entityType: 'order',
    entityId: 'server-order-1',
    event: 'created',
    source: 'backend',
    sourceTx: `canonical-${seq}`,
    createdAt: '2026-07-31T10:00:00.000Z',
    payload: {
      id: 'server-order-1',
      orderNumber: 'ZAM-20260731-0001',
      status: 'DELIVERED',
      subtotal: '10.00',
      discountAmount: '0.00',
      taxAmount: '0.00',
      total: '10.00',
      paidAmount: '10.00',
      changeAmount: '0.00',
      paymentMethod: 'CASH',
      posMode: 'retail',
      createdAt: '2026-07-31T10:00:00.000Z',
      items: [{
        id: 'canonical-item-1',
        productName: 'Herbata',
        variantId: 'variant-1',
        unitPrice: '10.00',
        totalPrice: '10.00',
        taxRate: '0.00',
        packQuantity: 1,
      }],
    },
  };
}

function thinPosEntry(seq = 2) {
  return {
    seq,
    entityType: 'order',
    entityId: 'server-order-1',
    event: 'created',
    source: 'pos:other-device',
    sourceTx: `thin-${seq}`,
    createdAt: '2026-07-31T10:00:01.000Z',
    payload: {
      id: 'server-order-1',
      priceType: 'brutto',
      paymentMethod: 'CASH',
      items: [{
        productId: 'variant-1',
        variantId: 'variant-1',
        customPrice: 10,
        packQuantity: 1,
      }],
    },
  };
}

function staffEntry(seq = 1) {
  return {
    seq,
    entityType: 'staff',
    entityId: 'staff-profile-1',
    event: 'updated',
    source: 'backend',
    sourceTx: `staff-${seq}`,
    createdAt: '2026-07-31T10:00:02.000Z',
    payload: {
      id: 'staff-profile-1',
      userId: 'staff-user-1',
      name: 'Anna',
      commissionRate: 1500,
      isActive: true,
      role: 'STAFF',
      updatedAt: '2026-07-31T10:00:02.000Z',
    },
  };
}

function setPullEntries(entries: any[]): void {
  vi.mocked(apiClient.syncPull).mockResolvedValueOnce({
    entries,
    hasMore: false,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  createSchema(db);
  (database as any).db = db;
  (database as any).dirty = false;
  (database as any).dirtyVersion = 0;
  (database as any).saving = false;
});

afterEach(() => {
  (database as any).db = null;
  db.close();
});

describe('SyncLogService pull order transaction ownership', () => {
  it('commits the canonical order, items, accepted log and cursor together', async () => {
    setPullEntries([canonicalEntry()]);

    await expect(new SyncLogService().pullFromServer()).resolves.toBe(1);

    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM orders')?.count).toBe(1);
    expect(database.get<{ name: string }>('SELECT name FROM order_items')?.name).toBe('Herbata');
    expect(database.get<{ status: string }>('SELECT status FROM local_sync_log')?.status).toBe('accepted');
    expect(database.get<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'last_server_seq'",
    )?.value).toBe('1');
  });

  it('rolls back order, items, accepted log and cursor when an item insert fails', async () => {
    setPullEntries([canonicalEntry()]);
    const originalRun = database.run.bind(database);
    const runSpy = vi.spyOn(database, 'run').mockImplementation((sql: string, params?: any[]) => {
      if (/INSERT INTO order_items/i.test(sql)) {
        throw new Error('injected item insert failure');
      }
      return originalRun(sql, params);
    });

    try {
      await expect(new SyncLogService().pullFromServer())
        .rejects.toThrow('injected item insert failure');
    } finally {
      runSpy.mockRestore();
    }

    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM orders')?.count).toBe(0);
    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM order_items')?.count).toBe(0);
    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM local_sync_log')?.count).toBe(0);
    expect(database.get<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'last_server_seq'",
    )).toBeNull();
  });

  it('accepts canonical then thin POS-origin entries without a partial duplicate', async () => {
    setPullEntries([canonicalEntry(1), thinPosEntry(2)]);

    await expect(new SyncLogService().pullFromServer()).resolves.toBe(2);

    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM orders')?.count).toBe(1);
    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM order_items')?.count).toBe(1);
    expect(database.get<{ name: string }>('SELECT name FROM order_items')?.name).toBe('Herbata');
    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM local_sync_log')?.count).toBe(2);
    expect(database.get<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'last_server_seq'",
    )?.value).toBe('2');
  });

  it('accepts a thin POS invalidation before the canonical snapshot without blocking the cursor', async () => {
    setPullEntries([thinPosEntry(1), canonicalEntry(2)]);

    await expect(new SyncLogService().pullFromServer()).resolves.toBe(1);

    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM orders')?.count).toBe(1);
    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM order_items')?.count).toBe(1);
    expect(database.get<{ name: string }>('SELECT name FROM order_items')?.name).toBe('Herbata');
    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM local_sync_log')?.count).toBe(2);
    expect(database.get<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'last_server_seq'",
    )?.value).toBe('2');
  });
});

describe('SyncLogService pull staff transaction ownership', () => {
  it('commits staff, accepted log and cursor without a nested transaction', async () => {
    setPullEntries([staffEntry()]);

    await expect(new SyncLogService().pullFromServer()).resolves.toBe(1);

    expect(database.get<{ name: string; user_id: string }>(
      'SELECT name, user_id FROM pos_staff WHERE id = ?',
      ['staff-profile-1'],
    )).toEqual({ name: 'Anna', user_id: 'staff-user-1' });
    expect(database.get<{ status: string }>('SELECT status FROM local_sync_log')?.status).toBe('accepted');
    expect(database.get<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'last_server_seq'",
    )?.value).toBe('1');
  });

  it('rolls back the audit and cursor when the staff write fails', async () => {
    setPullEntries([staffEntry()]);
    const originalRun = database.run.bind(database);
    const runSpy = vi.spyOn(database, 'run').mockImplementation((sql: string, params?: any[]) => {
      if (/INSERT INTO pos_staff/i.test(sql)) {
        throw new Error('injected staff insert failure');
      }
      return originalRun(sql, params);
    });

    try {
      await expect(new SyncLogService().pullFromServer())
        .rejects.toThrow('injected staff insert failure');
    } finally {
      runSpy.mockRestore();
    }

    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM pos_staff')?.count).toBe(0);
    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM local_sync_log')?.count).toBe(0);
    expect(database.get<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'last_server_seq'",
    )).toBeNull();
  });
});
