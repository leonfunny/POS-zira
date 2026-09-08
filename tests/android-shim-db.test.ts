import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  initAndroidDb,
  isValidSqliteHeader,
  IndexedDbPersistence,
  type AndroidDbPersistence,
} from '../src/renderer/android-pos/shim/db/db';
import { createProductRepo, type AndroidProductRow } from '../src/renderer/android-pos/shim/db/product-repo';
import { createCategoryRepo, type AndroidCategoryRow } from '../src/renderer/android-pos/shim/db/category-repo';
import { createSyncMeta, PRODUCTS_SYNC_CURSOR_KEY } from '../src/renderer/android-pos/shim/db/sync-meta';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Node-friendly sql.js load: `null` tells the engine to omit locateFile so
 * sql.js resolves its own wasm from its package via fs (verified in this
 * vitest/node env — mirrors tests/migration-runner.test.ts). Production
 * (WebView) leaves locateFile unset so the Vite `?url` import is used.
 */
const NODE_LOCATE_FILE = null;

function product(overrides: Partial<AndroidProductRow> = {}): AndroidProductRow {
  return {
    id: 'p1',
    template_id: null,
    name: 'Product One',
    sku: 'SKU-1',
    barcode: '5900000000017',
    retail_price: 1000,
    category_id: 'c1',
    image_url: null,
    in_stock: 10,
    available_qty: 10,
    vat_rate: 23,
    is_active: 1,
    is_on_sale: 0,
    thumbnail_url: null,
    sale_unit: 'PIECE',
    sell_by: 'PIECE',
    updated_at: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function category(overrides: Partial<AndroidCategoryRow> = {}): AndroidCategoryRow {
  return {
    id: 'c1',
    name: 'Drinks',
    image_url: null,
    icon: null,
    color: null,
    sort_order: 0,
    updated_at: '2026-07-18T00:00:00.000Z',
    kitchen_print: 0,
    ...overrides,
  };
}

// ── Minimal in-memory IndexedDB stub (raw IDB API surface the engine uses) ────
// Backs a single object store ('blobs') with a Map<key, value>. Callbacks fire
// as microtasks so `await` resolves naturally; transactions fire oncomplete for
// readwrite mode. Exposes the live `blobs` map so tests can pre-seed / assert.

interface FakeIdb {
  idb: unknown;
  blobs: Map<string, Uint8Array>;
}

function createFakeIndexedDB(): FakeIdb {
  const blobs = new Map<string, Uint8Array>();
  const objectStoreNames = { contains: (n: string) => n === 'blobs' };

  const fire = (req: any) => {
    Promise.resolve().then(() => {
      if (req.onsuccess) req.onsuccess({ target: req });
    });
  };

  const makeStore = (complete: () => void = () => {}) => ({
    get: (key: string) => {
      const req: any = { result: blobs.has(key) ? blobs.get(key) : undefined, error: null, onsuccess: null, onerror: null };
      fire(req);
      Promise.resolve().then(complete);
      return req;
    },
    put: (value: Uint8Array, key: string) => {
      blobs.set(key, value);
      const req: any = { result: key, error: null, onsuccess: null, onerror: null };
      fire(req);
      Promise.resolve().then(complete);
      return req;
    },
  });

  const makeDatabase = () => ({
    name: 'zira-android-pos',
    version: 1,
    objectStoreNames,
    createObjectStore: () => makeStore(),
    transaction: (_store: string, _mode: string) => {
      const tx: any = { error: null, oncomplete: null, onerror: null, onabort: null,
        objectStore: () => makeStore(() => tx.oncomplete?.({ target: tx })) };
      return tx;
    },
    close: () => {},
  });

  const idb = {
    open: () => {
      const req: any = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      Promise.resolve().then(() => {
        req.result = makeDatabase();
        if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };

  return { idb, blobs };
}

function setFakeIndexedDB(fake: FakeIdb): void {
  (globalThis as unknown as { indexedDB?: unknown }).indexedDB = fake.idb;
}

function clearIndexedDB(): void {
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('android shim catalog DB (S5)', () => {
  beforeEach(() => { setFakeIndexedDB(createFakeIndexedDB()); });
  afterEach(() => { clearIndexedDB(); vi.useRealTimers(); });

  describe('initialization + schema', () => {
    test('boots sql.js in node and creates the current schema', async () => {
      const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });

      const tables = db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ).map((r) => r.name);
      expect(tables).toContain('product_variants');
      expect(tables).toContain('categories');
      expect(tables).toContain('sync_meta');

      // user_version stamped at schema apply time.
      const version = db.getRawHandle().exec('PRAGMA user_version')[0].values[0][0];
      expect(version).toBe(13); // v13 adds staged canonical refund evidence, without backfill.
      expect(tables).toContain('pos_refund_attempts');
      const orderColumns = db.all<{ name: string; dflt_value: string | null }>('PRAGMA table_info(orders)');
      expect(orderColumns.find(column => column.name === 'sync_payload_json')).toBeDefined();
      expect(orderColumns.find(column => column.name === 'sync_metadata_eligible')?.dflt_value).toBe('0');
      const itemColumns = db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>('PRAGMA table_info(order_items)');
      expect(itemColumns.find(column => column.name === 'restaurant_line_id')).toMatchObject({
        type: 'TEXT', notnull: 0, dflt_value: null,
      });
    });

    test('is idempotent — re-init over a persisted image keeps the schema', async () => {
      const fake = createFakeIndexedDB();
      setFakeIndexedDB(fake);
      const db1 = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      createProductRepo(db1).upsertProducts([product({ id: 'persisted' })]);
      await db1.flush();

      // Re-open from the persisted image: schema is reapplied (IF NOT EXISTS),
      // no duplicate tables, data intact.
      const db2 = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      const tables = db2.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
      expect(tables.filter((t) => t.name === 'product_variants')).toHaveLength(1);
      expect(createProductRepo(db2).getById('persisted')?.id).toBe('persisted');
    });
  });

  describe('product repo parity (copied from Windows product-repo.ts)', () => {
    function seed() {
      return [
        product({ id: 'p1', name: 'Bánh Mì', sku: 'SKU-001', barcode: '5901234500017', retail_price: 500, category_id: 'c1' }),
        product({ id: 'p2', name: 'Pasta Carbonara', sku: 'SKU-002', barcode: '1234', retail_price: 1200, category_id: 'c1' }),
        product({ id: 'p3', name: 'Żółć', sku: 'SKU-003', barcode: null, retail_price: 300, category_id: 'c1' }),
        product({ id: 'p4', name: 'Coffee', sku: 'SKU-004', barcode: 'COFFEE-2024', retail_price: 900, category_id: 'c2' }),
        // A template row with an active variant child — getAll/getByBarcode
        // hide the template (HIDE_TEMPLATES_WITH_VARIANTS, product-repo.ts:206-212).
        product({ id: 'tmpl', template_id: null, name: 'Template', sku: 'TPL', barcode: 'TPL-1', is_active: 1 }),
        product({ id: 'tmpl-v', template_id: 'tmpl', name: 'Template', sku: 'TPL', barcode: 'TPL-1', is_active: 1 }),
      ];
    }

    test('getAll returns active rows sorted by name, hiding templates with variants', async () => {
      const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      createProductRepo(db).upsertProducts(seed());

      const all = createProductRepo(db).getAll();
      const ids = all.map((p) => p.id);
      expect(ids).not.toContain('tmpl'); // template hidden (has active variant)
      expect(ids).toContain('tmpl-v'); // the sellable variant stays
      // ORDER BY name (SQLite BINARY collation): diacritic-heavy names sort by
      // code unit, so assert the NAMES are ordered — not the ids.
      const names = all.map((p) => p.name);
      expect(names).toEqual([...names].sort());
    });

    test('getById returns the row or null', async () => {
      const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      createProductRepo(db).upsertProducts(seed());
      const repo = createProductRepo(db);
      expect(repo.getById('p1')?.name).toBe('Bánh Mì');
      expect(repo.getById('nope')).toBeNull();
    });

    test('getByBarcode walks the Windows fallback ladder (product-repo.ts:349-395)', async () => {
      const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      createProductRepo(db).upsertProducts(seed());
      const repo = createProductRepo(db);

      expect(repo.getByBarcode('5901234500017')?.id).toBe('p1'); // 1. exact
      expect(repo.getByBarcode('00001234')?.id).toBe('p2'); // 2. leading-zero strip
      expect(repo.getByBarcode('XXCOFFEE-2024XX')?.id).toBe('p4'); // 3. substring
      expect(repo.getByBarcode('SKU-001')?.id).toBe('p1'); // 5. sku fallback
      expect(repo.getByBarcode('NOPE-9999')).toBeNull();
    });

    test('search matches diacritics-insensitively and case-insensitively (Windows normalizeSearch)', async () => {
      const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      createProductRepo(db).upsertProducts(seed());
      const repo = createProductRepo(db);

      const ids = (rows: AndroidProductRow[]) => rows.map((p) => p.id);

      // Diacritics normalized: "bánh" / "banh" both match "Bánh Mì".
      expect(ids(repo.search('bánh'))).toContain('p1');
      expect(ids(repo.search('banh'))).toContain('p1');
      // Case-insensitive.
      expect(ids(repo.search('BANH'))).toContain('p1');
      // Polish diacritics: żółć → zolc.
      expect(ids(repo.search('żółć'))).toContain('p3');
      expect(ids(repo.search('zolc'))).toContain('p3');
      // Phrase / substring on a later word.
      expect(ids(repo.search('carbonara'))).toContain('p2');
      // Code-like query matches sku/barcode (high priority).
      expect(ids(repo.search('SKU-001'))).toContain('p1');
      expect(ids(repo.search('COFFEE-2024'))).toContain('p4');
      // No match + too-short guard.
      expect(repo.search('zzzzzz')).toEqual([]);
      expect(repo.search('a')).toEqual([]);
    });

    test('search ranks an exact normalized name above a token/substring match', async () => {
      const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      createProductRepo(db).upsertProducts([
        product({ id: 'exact', name: 'Coffee', sku: 'A', barcode: '111' }),
        product({ id: 'fuzzy', name: 'Coffee Mug Deluxe', sku: 'B', barcode: '222' }),
      ]);
      const repo = createProductRepo(db);
      const top = repo.search('coffee')[0];
      expect(top.id).toBe('exact'); // exact normalized name (8000) beats phrase (6800)
    });

    test('upsertProducts replaces on conflict (INSERT OR REPLACE)', async () => {
      const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      const repo = createProductRepo(db);
      repo.upsertProducts([product({ id: 'p1', name: 'First', retail_price: 100 })]);
      repo.upsertProducts([product({ id: 'p1', name: 'Second', retail_price: 200 })]);
      const row = repo.getById('p1');
      expect(row?.name).toBe('Second');
      expect(row?.retail_price).toBe(200);
    });

    test('upsertProducts rejects rows missing id or name', async () => {
      const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      const repo = createProductRepo(db);
      expect(() => repo.upsertProducts([{ ...product(), id: '' } as AndroidProductRow])).toThrow();
      expect(() => repo.upsertProducts([{ ...product(), name: '' } as AndroidProductRow])).toThrow();
    });
  });

  describe('category repo + sync-meta', () => {
    test('getCategories returns only categories with an active, sellable product', async () => {
      const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      createCategoryRepo(db).upsertCategories([
        category({ id: 'c1', name: 'Drinks', sort_order: 1 }),
        category({ id: 'c2', name: 'Food', sort_order: 0 }),
        category({ id: 'c-empty', name: 'Empty', sort_order: 2 }),
      ]);
      createProductRepo(db).upsertProducts([
        product({ id: 'p1', name: 'Coffee', category_id: 'c2' }),
        product({ id: 'p2', name: 'Tea', category_id: 'c1' }),
      ]);
      const cats = createCategoryRepo(db).getCategories();
      // c-empty has no products → excluded; sorted by sort_order, name.
      expect(cats.map((c) => c.id)).toEqual(['c2', 'c1']);
    });

    test('upsertCategories preserves a locally-known kitchen_print flag when omitted', async () => {
      const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      const repo = createCategoryRepo(db);
      repo.upsertCategories([category({ id: 'c1', kitchen_print: 1 })]);
      // Sync payload omits kitchen_print (null) → COALESCE keeps the local 1.
      repo.upsertCategories([category({ id: 'c1', name: 'Drinks', kitchen_print: null })]);
      const row = db.get<{ kitchen_print: number }>('SELECT kitchen_print FROM categories WHERE id = ?', ['c1']);
      expect(row?.kitchen_print).toBe(1);
    });

    test('sync cursor round-trips through sync_meta', async () => {
      const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      const sync = createSyncMeta(db);
      expect(sync.getSyncMeta()).toEqual({ cursor: null, syncedAt: null });
      sync.setSyncMeta('cursor-abc');
      expect(sync.getSyncMeta().cursor).toBe('cursor-abc');
      expect(sync.getSyncMeta().syncedAt).not.toBeNull();
      // null cursor (full resync) overwrites.
      sync.setSyncMeta(null);
      expect(sync.getSyncMeta().cursor).toBeNull();
      expect(PRODUCTS_SYNC_CURSOR_KEY).toBe('products_sync_cursor');
    });
  });

  describe('persistence (IndexedDB, single blob record)', () => {
    test('round-trips the DB image across re-init via a fake indexedDB', async () => {
      const fake = createFakeIndexedDB();
      setFakeIndexedDB(fake);

      const db1 = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      createProductRepo(db1).upsertProducts([
        product({ id: 'survivor', name: 'Survives Restart', barcode: '555' }),
      ]);
      await db1.flush();

      // The live image is a single blob record under the canonical key.
      expect(fake.blobs.has('pos-db-image')).toBe(true);
      const image = fake.blobs.get('pos-db-image') as Uint8Array;
      expect(isValidSqliteHeader(image)).toBe(true);

      // A fresh engine instance restores from that image.
      const db2 = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      expect(createProductRepo(db2).getById('survivor')?.name).toBe('Survives Restart');
    });

    test('debounces the post-write flush by ~5s and flushes immediately on flush()', async () => {
      vi.useFakeTimers();
      const fake = createFakeIndexedDB();
      setFakeIndexedDB(fake);

      const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
      createProductRepo(db).upsertProducts([product({ id: 'debounced' })]);

      // Inside the debounce window → not persisted yet.
      await vi.advanceTimersByTimeAsync(4999);
      expect(fake.blobs.has('pos-db-image')).toBe(false);

      // Crossing the 5s mark fires the debounced persist.
      await vi.advanceTimersByTimeAsync(2);
      expect(fake.blobs.has('pos-db-image')).toBe(true);

      // flush() persists immediately, ahead of the debounce timer.
      createProductRepo(db).upsertProducts([product({ id: 'immediate' })]);
      // reset the store to prove flush() writes synchronously-ish.
      fake.blobs.delete('pos-db-image');
      await db.flush();
      expect(fake.blobs.has('pos-db-image')).toBe(true);
    });

    test('a corrupt image is preserved and blocks sales instead of replacing the financial database', async () => {
      const fake = createFakeIndexedDB();
      setFakeIndexedDB(fake);

      // Pre-seed a corrupt image (all-zero buffer — invalid SQLite header).
      const corrupt = new Uint8Array(64);
      fake.blobs.set('pos-db-image', corrupt);

      await expect(initAndroidDb({ locateFile: NODE_LOCATE_FILE })).rejects.toThrow('ANDROID_DB_RECOVERY_REQUIRED');
      expect(fake.blobs.get('pos-db-image')).toBe(corrupt);

      // The corrupt bytes were NOT silently discarded: a quarantine-keyed
      // record preserves them for inspection.
      const quarantineKeys = [...fake.blobs.keys()].filter((k) => k.startsWith('pos-db-image.corrupted-'));
      expect(quarantineKeys.length).toBe(1);
      expect(fake.blobs.get(quarantineKeys[0])).toBe(corrupt);
    });

    test('isValidSqliteHeader matches the SQLite magic and rejects corruption', () => {
      const good = new Uint8Array(16);
      good.set(Array.from('SQLite format 3').map((c) => c.charCodeAt(0)), 0);
      good[15] = 0;
      expect(isValidSqliteHeader(good)).toBe(true);

      const zeros = new Uint8Array(64); // all-zero (Type B fsync corruption)
      expect(isValidSqliteHeader(zeros)).toBe(false);

      expect(isValidSqliteHeader(new Uint8Array(8))).toBe(false); // too short
    });

    test('IndexedDbPersistence refuses to pretend persistence when IndexedDB is absent', async () => {
      clearIndexedDB();
      const persistence: AndroidDbPersistence = new IndexedDbPersistence();
      await expect(persistence.saveImage(new Uint8Array([1, 2, 3]))).rejects.toThrow('IndexedDB unavailable');
      await expect(persistence.loadImage()).rejects.toThrow('IndexedDB unavailable');
    });
    test('request success is not durability: an abort before transaction completion rejects', async () => {
      let tx: any; let write: any;
      const database = { close: vi.fn(), transaction: () => {
        tx = { error: new Error('Quota exceeded after request'), objectStore: () => ({ put: () => {
          write = { result: 'pos-db-image' }; return write;
        } }) }; return tx;
      } };
      (globalThis as any).indexedDB = { open: () => {
        const req: any = { result: database };
        Promise.resolve().then(() => req.onsuccess()); return req;
      } };
      let settled = false;
      const save = new IndexedDbPersistence().saveImage(new Uint8Array([1])).finally(() => { settled = true; });
      const rejection = expect(save).rejects.toThrow('Quota exceeded');
      await vi.waitFor(() => expect(write).toBeDefined());
      write.onsuccess(); await Promise.resolve();
      expect(settled).toBe(false);
      tx.onabort(); await rejection; expect(database.close).toHaveBeenCalled();
    });
    test('a storage read error cannot create a fresh empty financial database', async () => {
      const persistence = { loadImage: vi.fn(async () => { throw new Error('Storage locked'); }),
        saveImage: vi.fn(), quarantineImage: vi.fn() };
      await expect(initAndroidDb({ locateFile: null, persistence })).rejects.toThrow('Storage locked');
      expect(persistence.saveImage).not.toHaveBeenCalled();
    });
    test('failure to preserve corrupt bytes cannot replace them with a fresh database', async () => {
      const persistence = { loadImage: vi.fn(async () => new Uint8Array(64)),
        saveImage: vi.fn(), quarantineImage: vi.fn(async () => { throw new Error('Quarantine full'); }) };
      await expect(initAndroidDb({ locateFile: null, persistence })).rejects.toThrow('Quarantine full');
      expect(persistence.saveImage).not.toHaveBeenCalled();
    });
  });
});
