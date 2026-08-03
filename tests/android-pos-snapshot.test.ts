/**
 * Task 4 of docs/superpowers/plans/2026-07-25-android-pos-device-readiness-fixes.md.
 *
 * Storage for the crash-survivable cart. The cart lives in ShimPosStore memory,
 * which is fine on Windows — Electron has no back button and the OS does not
 * reclaim the process mid-sale — and is not fine on a tablet, where both happen
 * routinely. Task 5 does the persisting; this is the table it writes to.
 */
import { describe, expect, test } from 'vitest';

import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import {
  POS_SNAPSHOT_CART_KEY,
  createPosSnapshotRepo,
} from '../src/renderer/android-pos/shim/db/pos-snapshot-repo';

/** Node-friendly sql.js load — mirrors tests/android-shim-db.test.ts. */
const NODE_LOCATE_FILE = null;

async function freshDb() {
  return initAndroidDb({ locateFile: NODE_LOCATE_FILE });
}

describe('pos snapshot repo', () => {
  test('returns null before anything is saved', async () => {
    const repo = createPosSnapshotRepo(await freshDb());
    expect(repo.load(POS_SNAPSHOT_CART_KEY)).toBeNull();
  });

  test('round-trips a snapshot', async () => {
    const repo = createPosSnapshotRepo(await freshDb());
    repo.save(POS_SNAPSHOT_CART_KEY, '{"items":[{"id":"a"}]}');
    expect(repo.load(POS_SNAPSHOT_CART_KEY)).toBe('{"items":[{"id":"a"}]}');
  });

  test('overwrites rather than accumulating rows', async () => {
    const db = await freshDb();
    const repo = createPosSnapshotRepo(db);
    repo.save(POS_SNAPSHOT_CART_KEY, '{"v":1}');
    repo.save(POS_SNAPSHOT_CART_KEY, '{"v":2}');
    expect(repo.load(POS_SNAPSHOT_CART_KEY)).toBe('{"v":2}');
    const rows = db.all<{ n: number }>('SELECT COUNT(*) AS n FROM pos_snapshot');
    expect(rows[0].n).toBe(1);
  });

  test('clear removes the row', async () => {
    const repo = createPosSnapshotRepo(await freshDb());
    repo.save(POS_SNAPSHOT_CART_KEY, '{"v":1}');
    repo.clear(POS_SNAPSHOT_CART_KEY);
    expect(repo.load(POS_SNAPSHOT_CART_KEY)).toBeNull();
  });

  test('clearSalonData wipes the snapshot — a cart must never cross tenants', async () => {
    const db = await freshDb();
    const repo = createPosSnapshotRepo(db);
    repo.save(POS_SNAPSHOT_CART_KEY, '{"items":[{"id":"salonA-line"}]}');
    db.clearSalonData();
    expect(repo.load(POS_SNAPSHOT_CART_KEY)).toBeNull();
  });
});
