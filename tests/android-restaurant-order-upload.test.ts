import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore } from '../src/renderer/android-pos/shim/token-store';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const memory = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } }; };
async function build(persistence = new MemoryAndroidPersistence(), salonId = 'salon-1') {
  const configStore = new ShimConfigStore({ storage: memory(), seed: { salonId, posMode: 'restaurant', authUser: { id: 'staff-1', salonId, role: 'STAFF' } } as any });
  const tokenStore = new TokenStore({ storage: memory(), allowInsecureFallback: true });
  await tokenStore.setTokens('jwt-1', 'refresh-1');
  const transport = createRealTransport({ configStore, tokenStore, dbInit: { locateFile: null, persistence }, agentConnection: {
    connect: async () => ({ connected: false, reason: 'no-key' as const }), disconnect: async () => {}, isConnected: () => false,
    getPushedJobStatus: () => null, onJobStatus: () => () => {},
  } });
  const db = await transport.getRestaurantDatabase!();
  const repo = createOrderRepo(db);
  return { transport, db, repo, persistence, configStore, tokenStore };
}
async function seed(built: Awaited<ReturnType<typeof build>>, id = 'order-1') {
  built.repo.create({ id, mode: 'restaurant', order_type: 'dine_in', table_id: 'table-a', covers: 3, subtotal: 2400,
    discount: 400, total: 2000, tip: 100, payment_method: 'CASH', payment_amount: 3000, change_amount: 900,
    payment_tenders: JSON.stringify([{ method: 'CASH', amount: 2100 }]) },
  [{ id: `${id}-line-a`, order_id: id, variant_id: 'v1', name: 'Tea', price: 1200, quantity: 1, total: 1200, notes: 'No sugar', course: 2 },
    { id: `${id}-line-b`, order_id: id, variant_id: 'v1', name: 'Tea', price: 1200, quantity: 1, total: 1200, notes: 'Extra ice', course: 3 }]);
  await built.db.flush();
}
afterEach(() => vi.unstubAllGlobals());

describe('Android real upload snapshot parity', () => {
  it('reloads later batch rows after earlier HTTP waits, honoring edits and deletions', async () => {
    const built = await build(); await seed(built); await seed(built, 'deleted-order'); await seed(built, 'edited-order');
    const sent: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/capabilities')) return json({ restaurantMetadataVersion: 1 });
      const payload = JSON.parse(String(init.body)); sent.push(payload);
      if (payload.id === 'order-1') {
        expect(built.repo.deleteLocalUnsynced('deleted-order').deleted).toBe(true);
        built.db.run('UPDATE orders SET covers = ? WHERE id = ?', [9, 'edited-order']);
      }
      return json({ id: payload.id });
    }));
    await built.transport.syncOrders!();
    expect(sent.map(p => p.id)).toEqual(['order-1', 'edited-order']);
    expect(sent[1].restaurant.covers).toBe(9);
  });
  it('locks the local row before capability await so it cannot be deleted mid-preparation', async () => {
    const built = await build(); await seed(built);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/capabilities')) { await pending; return json({ restaurantMetadataVersion: 1 }); }
      return json({ id: 'backend-1' });
    });
    vi.stubGlobal('fetch', fetcher);
    const upload = built.transport.syncOrders!();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(built.repo.getById('order-1')).toMatchObject({ synced: 2, sync_payload_json: null });
    expect(built.repo.deleteLocalUnsynced('order-1')).toMatchObject({ deleted: false, error: expect.stringContaining('in progress') });
    release(); await upload;
    expect(built.repo.getById('order-1').synced).toBe(1);
  });
  it('persists v1 before POST, survives lost reply/restart and capability downgrade with byte-identical JSON', async () => {
    const built = await build(); await seed(built);
    let firstBody = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/capabilities')) return json({ restaurantMetadataVersion: 1 });
      firstBody = String(init.body);
      const disk = await build(built.persistence);
      expect(JSON.parse(disk.repo.getById('order-1').sync_payload_json).payload).toEqual(JSON.parse(firstBody));
      throw new Error('response lost');
    }));
    await built.transport.syncOrders!();
    expect(JSON.parse(firstBody)).toMatchObject({ restaurant: { schemaVersion: 1, tableId: 'table-a', covers: 3 }, discountAmount: 4, tip: 1,
      tenders: [{ method: 'CASH', amount: 21 }], items: [{ restaurant: { localLineId: 'order-1-line-a', notes: 'No sugar', course: 2 } }, { restaurant: { localLineId: 'order-1-line-b', notes: 'Extra ice', course: 3 } }] });
    const reloaded = await build(built.persistence);
    reloaded.db.run('UPDATE order_items SET notes = ?, price = ? WHERE id = ?', ['changed after attempt', 9999, 'order-1-line-a']);
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toMatch(/\/orders$/); expect(String(init.body)).toBe(firstBody);
      return json({ id: 'backend-1' });
    });
    vi.stubGlobal('fetch', fetcher);
    await reloaded.transport.syncOrders!();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await build(built.persistence)).repo.getById('order-1').synced).toBe(1);
  });

  it.each([401, 403, 500])('capability HTTP%s never silently downgrades or POSTs', async status => {
    const built = await build(); await seed(built);
    const fetcher = vi.fn(async (url: string) => url.includes('/auth/refresh') ? json({}, 401) : json({ message: 'capability unavailable' }, status));
    vi.stubGlobal('fetch', fetcher);
    await built.transport.syncOrders!().catch(() => {}); // Expired auth aborts the batch.
    expect(fetcher.mock.calls.some(call => call[0].endsWith('/orders'))).toBe(false);
    expect(built.repo.getById('order-1').sync_payload_json).toBeNull();
  });

  it('legacy 404 freezes a metadata-free request and old migrated rows never negotiate', async () => {
    const built = await build(); await seed(built); await seed(built, 'old-order');
    built.db.run('UPDATE orders SET sync_metadata_eligible = 0 WHERE id = ?', ['old-order']);
    const requests: any[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/capabilities')) return json({}, 404);
      const body = JSON.parse(String(init.body)); requests.push(body);
      return json({ id: body.id });
    });
    vi.stubGlobal('fetch', fetcher); await built.transport.syncOrders!();
    expect(fetcher.mock.calls.filter(call => call[0].endsWith('/capabilities'))).toHaveLength(1);
    expect(requests).toHaveLength(2);
    for (const body of requests) { expect(body.restaurant).toBeUndefined(); expect(body.items[0].restaurant).toBeUndefined(); }
  });

  it('storage failure before POST blocks network and requires restart; no false success', async () => {
    const built = await build(); await seed(built); built.persistence.failSave = true;
    const synced = vi.fn(); built.transport.onOrderSynced(synced);
    const fetcher = vi.fn(async () => json({ restaurantMetadataVersion: 1 })); vi.stubGlobal('fetch', fetcher);
    await expect(built.transport.syncOrders!()).rejects.toThrow('STORAGE_RESTART_REQUIRED');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(synced).not.toHaveBeenCalled();
    built.persistence.failSave = false;
    await expect(built.transport.syncOrders!()).rejects.toThrow('STORAGE_RESTART_REQUIRED');
  });

  it('accepted response with failed local flush emits no success and reload preserves frozen retry', async () => {
    const built = await build(); await seed(built);
    const synced = vi.fn(); built.transport.onOrderSynced(synced);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/capabilities')) return json({ restaurantMetadataVersion: 1 });
      built.persistence.failSave = true; return json({ id: 'backend-1' });
    }));
    await expect(built.transport.syncOrders!()).rejects.toThrow('STORAGE_RESTART_REQUIRED');
    expect(synced).not.toHaveBeenCalled(); built.persistence.failSave = false;
    const reloaded = await build(built.persistence);
    expect(reloaded.repo.getById('order-1')).toMatchObject({ synced: 2, backend_id: null });
    expect(JSON.parse(reloaded.repo.getById('order-1').sync_payload_json).payload.restaurant.schemaVersion).toBe(1);
  });

  it('late reply after tenant change does not write, notify or process subsequent captured rows', async () => {
    const built = await build(); await seed(built); await seed(built, 'order-2');
    const writes = vi.spyOn(built.db, 'run'); const synced = vi.fn(); built.transport.onOrderSynced(synced);
    let writesAtSwitch = -1;
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/capabilities')) return json({ restaurantMetadataVersion: 1 });
      built.configStore.setConfig({ salonId: 'salon-2' }); writesAtSwitch = writes.mock.calls.length;
      return json({ id: 'backend-1' });
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(built.transport.syncOrders!()).rejects.toThrow('CONTEXT_CHANGED');
    expect(writes.mock.calls).toHaveLength(writesAtSwitch); expect(synced).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(call => call[0].endsWith('/orders'))).toHaveLength(1);
  });

  it('refuses a persisted snapshot under another tenant and blocks local deletion after uncertainty', async () => {
    const built = await build(); await seed(built);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/capabilities')) return json({ restaurantMetadataVersion: 1 });
      throw new Error('lost response');
    }));
    await built.transport.syncOrders!();
    expect(built.repo.deleteLocalUnsynced('order-1')).toMatchObject({ deleted: false, error: expect.stringContaining('frozen') });
    const other = await build(built.persistence, 'salon-2'); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await other.transport.syncOrders!();
    expect(fetcher).not.toHaveBeenCalled(); expect(other.repo.getById('order-1').sync_error).toContain('SCOPE_MISMATCH');
  });
});
