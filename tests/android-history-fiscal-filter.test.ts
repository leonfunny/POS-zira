import { describe, expect, it } from 'vitest';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

describe('Android history does not invent fiscal evidence', () => {
  it('refuses a fiscal-only filter without treating a prefix, card payment or SERVER source as proof', async () => {
    const db = await initAndroidDb({ locateFile: null, persistence: new MemoryAndroidPersistence() });
    const repo = createOrderRepo(db);
    db.run(`INSERT INTO orders (id, order_number, source, payment_method, synced)
      VALUES ('local', 'POS-20260908-0001', 'POS', 'CARD', 0),
             ('mirror', 'FISCAL-0002', 'SERVER', 'CASH', 1)`);
    expect(() => repo.getHistory({ fiscalOnly: true })).toThrow('Fiscal-only history');
    expect(repo.getHistory({ fiscalOnly: false }).orders).toHaveLength(2);
    expect(repo.getUnsynced().map(order => order.id)).toEqual(['local']);
    await db.flush();
  });
});
