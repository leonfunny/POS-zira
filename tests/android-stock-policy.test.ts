import { afterEach, describe, expect, test, vi } from 'vitest';

import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';
import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { TokenStore, type TokenStoreStorage } from '../src/renderer/android-pos/shim/token-store';

const NODE_LOCATE_FILE = null;

function memoryStorage(): TokenStoreStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface StockRow {
  in_stock: number;
  available_qty: number;
}

function stockOf(database: AndroidDatabase, variantId: string): StockRow {
  return database.get<StockRow>(
    'SELECT in_stock, available_qty FROM product_variants WHERE id = ?',
    [variantId],
  )!;
}

async function makeCheckoutHarness(allowOversell: boolean, stocks: Record<string, number>) {
  const products = Object.entries(stocks).map(([id, stock]) => ({
    id,
    name: id,
    retailPrice: '10.00',
    totalStockQty: stock,
    availableQty: stock,
    itemType: 'stockable',
    trackInventory: true,
    template: { id: `template-${id}` },
  }));
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    if (String(input).includes('/warehouse/public/products')) {
      return jsonResponse({ products, categories: [], nextSyncCursor: 'stock-policy-cursor' });
    }
    return jsonResponse({});
  }));

  const configStore = new ShimConfigStore({
    storage: memoryStorage(),
    seed: { allowOversell } as any,
  });
  const tokenStore = new TokenStore({ storage: memoryStorage() });
  await tokenStore.setTokens('test-access-token');
  const transport = createRealTransport({
    configStore,
    tokenStore,
    dbInit: { locateFile: NODE_LOCATE_FILE },
  });
  expect(await transport.syncProducts!()).toMatchObject({ success: true, productsCount: products.length });
  const shift = await transport.openShift!({ staffId: 'staff-1', staffName: 'Anna', openingCash: 0 });
  expect(shift.success).toBe(true);
  return { transport, shiftId: shift.shiftId! };
}

function order(orderId: string, shiftId: string, billiardOrigin?: string) {
  return {
    id: orderId,
    status: 'COMPLETED',
    subtotal: 1000,
    total: 1000,
    payment_method: 'CASH',
    payment_amount: 1000,
    shift_id: shiftId,
    source: 'POS',
    mode: 'retail',
    billiard_origin_json: billiardOrigin ?? null,
  };
}

function line(orderId: string, lineId: string, variantId: string, quantity: number, inventoryPolicy?: string) {
  return {
    id: lineId,
    order_id: orderId,
    variant_id: variantId,
    name: variantId,
    price: 1000,
    quantity,
    sell_by: 'PIECE',
    total: 1000 * quantity,
    inventory_policy: inventoryPolicy ?? null,
  };
}

async function makeRepoHarness() {
  const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
  database.run(
    `INSERT INTO product_variants (id, name, in_stock, available_qty, track_inventory)
     VALUES ('beer', 'Beer', 5, 5, 1), ('chips', 'Chips', 7, 7, 1)`,
  );
  return { database, repo: createOrderRepo(database) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Android billiard stock policy', () => {
  test('ordinary checkout decrements both tracked variants by their quantities', async () => {
    const { transport, shiftId } = await makeCheckoutHarness(false, { beer: 10, chips: 8 });
    const result = await transport.createOrder!(
      order('ordinary-checkout', shiftId),
      [line('ordinary-checkout', 'line-beer', 'beer', 2), line('ordinary-checkout', 'line-chips', 'chips', 3)],
    );

    expect(result.success).toBe(true);
    expect(await transport.getProductById!('beer')).toMatchObject({ in_stock: 8, available_qty: 8 });
    expect(await transport.getProductById!('chips')).toMatchObject({ in_stock: 5, available_qty: 5 });
  });

  test('billiard checkout leaves every variant row unchanged', async () => {
    const { transport, shiftId } = await makeCheckoutHarness(false, { beer: 10, chips: 8 });
    const result = await transport.createOrder!(
      order('billiard-checkout', shiftId, JSON.stringify({ type: 'BILLIARD_SESSION' })),
      [line('billiard-checkout', 'line-beer', 'beer', 2), line('billiard-checkout', 'line-chips', 'chips', 3)],
    );

    expect(result.success).toBe(true);
    expect(await transport.getProductById!('beer')).toMatchObject({ in_stock: 10, available_qty: 10 });
    expect(await transport.getProductById!('chips')).toMatchObject({ in_stock: 8, available_qty: 8 });
  });

  test('deleting an ordinary unsynced order restocks and deletes its rows', async () => {
    const { database, repo } = await makeRepoHarness();
    repo.create(order('ordinary-delete', 'shift-1'), [
      line('ordinary-delete', 'line-beer', 'beer', 2),
      line('ordinary-delete', 'line-chips', 'chips', 3),
    ]);

    const result = repo.deleteLocalUnsynced('ordinary-delete');

    expect(result).toEqual({ deleted: true, restocked: 5 });
    expect(stockOf(database, 'beer')).toEqual({ in_stock: 7, available_qty: 7 });
    expect(stockOf(database, 'chips')).toEqual({ in_stock: 10, available_qty: 10 });
    expect(database.get('SELECT id FROM orders WHERE id = ?', ['ordinary-delete'])).toBeNull();
    expect(database.all('SELECT id FROM order_items WHERE order_id = ?', ['ordinary-delete'])).toEqual([]);
    await database.flush();
  });

  test('deleting skips ALREADY_CONSUMED lines while restocking other lines', async () => {
    const { database, repo } = await makeRepoHarness();
    repo.create(order('mixed-delete', 'shift-1'), [
      line('mixed-delete', 'line-beer', 'beer', 2, 'ALREADY_CONSUMED'),
      line('mixed-delete', 'line-chips', 'chips', 3),
    ]);

    const result = repo.deleteLocalUnsynced('mixed-delete');

    expect(result).toEqual({ deleted: true, restocked: 3 });
    expect(stockOf(database, 'beer')).toEqual({ in_stock: 5, available_qty: 5 });
    expect(stockOf(database, 'chips')).toEqual({ in_stock: 10, available_qty: 10 });
    await database.flush();
  });

  test('deleting a billiard order is refused without changing rows', async () => {
    const { database, repo } = await makeRepoHarness();
    repo.create(order('billiard-delete', 'shift-1', JSON.stringify({ type: 'BILLIARD_SESSION' })), [
      line('billiard-delete', 'line-beer', 'beer', 2, 'ALREADY_CONSUMED'),
      line('billiard-delete', 'line-chips', 'chips', 3),
    ]);

    const result = repo.deleteLocalUnsynced('billiard-delete');

    expect(result).toEqual({
      deleted: false,
      restocked: 0,
      error: 'Billiard POS orders cannot be deleted. Use the owner correction flow.',
    });
    expect(database.get('SELECT id FROM orders WHERE id = ?', ['billiard-delete'])).toEqual({ id: 'billiard-delete' });
    expect(database.all('SELECT id FROM order_items WHERE order_id = ? ORDER BY id', ['billiard-delete'])).toEqual([
      { id: 'line-beer' },
      { id: 'line-chips' },
    ]);
    expect(stockOf(database, 'beer')).toEqual({ in_stock: 5, available_qty: 5 });
    expect(stockOf(database, 'chips')).toEqual({ in_stock: 7, available_qty: 7 });
    await database.flush();
  });

  test('checkout clamps at zero unless oversell is enabled', async () => {
    const clamped = await makeCheckoutHarness(false, { beer: 1 });
    expect(await clamped.transport.createOrder!(
      order('clamped-order', clamped.shiftId),
      [line('clamped-order', 'clamped-line', 'beer', 3)],
    )).toMatchObject({ success: true });
    expect(await clamped.transport.getProductById!('beer')).toMatchObject({ in_stock: 0, available_qty: 0 });

    const negative = await makeCheckoutHarness(true, { beer: 1 });
    expect(await negative.transport.createOrder!(
      order('negative-order', negative.shiftId),
      [line('negative-order', 'negative-line', 'beer', 3)],
    )).toMatchObject({ success: true });
    expect(await negative.transport.getProductById!('beer')).toMatchObject({ in_stock: -2, available_qty: -2 });
  });
});
