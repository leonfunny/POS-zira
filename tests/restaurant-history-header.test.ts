import { describe, expect, it } from 'vitest';
import { readRestaurantHistoryHeader, readRestaurantHistoryLines } from '../src/shared/restaurant-history-header';

const restaurant = (patch: any = {}) => ({ posMode: 'restaurant', posOrderType: 'dine_in',
  externalMetadata: { meta: { restaurant: { schemaVersion: 1, tableId: 'local-A', covers: 2, ...patch } } } });

describe('proven restaurant history header', () => {
  it('reads canonical metadata without using current table settings or lines', () => {
    expect(readRestaurantHistoryHeader(restaurant({ lines: [{ lineIndex: 0, notes: 'opaque/unlinked' }] })))
      .toEqual({ tableId: 'local-A', covers: 2, orderType: 'dine_in' });
  });
  it.each(['takeout', 'delivery'])('supports %s without inventing a table', orderType => {
    expect(readRestaurantHistoryHeader({ ...restaurant({ tableId: null, covers: 0 }), posOrderType: orderType }))
      .toEqual({ tableId: null, covers: 0, orderType });
    expect(readRestaurantHistoryHeader({ ...restaurant(), posOrderType: orderType })).toBeNull();
  });
  it.each([
    { schemaVersion: 2 }, { covers: '2' }, { covers: null }, { covers: -1 }, { covers: 0.5 }, { covers: 10001 },
    { tableId: '' }, { tableId: '  ' }, { tableId: 42 }, { tableId: 'A'.repeat(129) },
  ])('rejects malformed known fields %j', patch => { expect(readRestaurantHistoryHeader(restaurant(patch))).toBeNull(); });
  it('does not borrow metadata for retail/billiard or infer service type from generic orderType', () => {
    expect(readRestaurantHistoryHeader({ ...restaurant(), posMode: 'retail' })).toBeNull();
    expect(readRestaurantHistoryHeader({ ...restaurant(), billiardOrigin: { sessionId: 'b1' } })).toBeNull();
    expect(readRestaurantHistoryHeader({ ...restaurant(), posOrderType: undefined, orderType: 'dine_in' })).toBeNull();
    expect(readRestaurantHistoryHeader({ ...restaurant(), externalMetadata: null })).toBeNull();
  });
});

function linkedOrder(): any {
  return { ...restaurant({ lines: [
    { orderItemId: 'server-a', localLineId: 'local-a', productId: 'tea', lineIndex: 0, notes: 'No sugar', course: 1 },
    { orderItemId: 'server-b', localLineId: 'local-b', productId: 'tea', lineIndex: 1, notes: 'Extra sugar', course: 2 },
  ] }), id: 'order-1', items: [
    { id: 'server-b', orderId: 'order-1', productId: 'tea' },
    { id: 'server-a', orderId: 'order-1', productId: 'tea' },
  ] };
}

describe('explicit restaurant history item links', () => {
  it('maps reversed duplicate product lines by server ID, never array position', () => {
    const result = readRestaurantHistoryLines(linkedOrder())!;
    expect(result.get('server-a')).toEqual({ orderItemId: 'server-a', localLineId: 'local-a', productId: 'tea', notes: 'No sugar', course: 1 });
    expect(result.get('server-b')?.notes).toBe('Extra sugar');
  });

  it('uses canonical variantId before productId exactly as the server linker does', () => {
    const order = linkedOrder(); order.items[0].variantId = 'tea'; order.items[0].productId = 'parent-product';
    expect(readRestaurantHistoryLines(order)?.get('server-b')?.productId).toBe('tea');
    order.externalMetadata.meta.restaurant.lines[1].productId = 'parent-product';
    expect(readRestaurantHistoryLines(order)).toBeNull();
  });

  it.each([
    ['legacy unlinked', (o: any) => { delete o.externalMetadata.meta.restaurant.lines[0].orderItemId; }],
    ['duplicate server link', (o: any) => { o.externalMetadata.meta.restaurant.lines[1].orderItemId = 'server-a'; }],
    ['duplicate local identity', (o: any) => { o.externalMetadata.meta.restaurant.lines[1].localLineId = 'local-a'; }],
    ['missing server item', (o: any) => { o.externalMetadata.meta.restaurant.lines[0].orderItemId = 'missing'; }],
    ['different product', (o: any) => { o.externalMetadata.meta.restaurant.lines[0].productId = 'coffee'; }],
    ['bad note type', (o: any) => { o.externalMetadata.meta.restaurant.lines[0].notes = 1; }],
    ['overlong note', (o: any) => { o.externalMetadata.meta.restaurant.lines[0].notes = 'x'.repeat(4001); }],
    ['bad course type', (o: any) => { o.externalMetadata.meta.restaurant.lines[0].course = '1'; }],
    ['bad course range', (o: any) => { o.externalMetadata.meta.restaurant.lines[0].course = 100; }],
    ['whitespace ID', (o: any) => { o.externalMetadata.meta.restaurant.lines[0].localLineId = '  '; }],
    ['unknown line shape', (o: any) => { o.externalMetadata.meta.restaurant.lines[0].payable = 10; }],
    ['duplicate index', (o: any) => { o.externalMetadata.meta.restaurant.lines[1].lineIndex = 0; }],
    ['foreign order item', (o: any) => { o.items[0].orderId = 'other-order'; }],
    ['duplicate response item', (o: any) => { o.items[0].id = 'server-a'; }],
    ['partial item set', (o: any) => { o.items.pop(); }],
    ['no item set', (o: any) => { delete o.items; }],
    ['invalid header', (o: any) => { o.externalMetadata.meta.restaurant.schemaVersion = 2; }],
    ['retail mode', (o: any) => { o.posMode = 'retail'; }],
    ['snake identity alias', (o: any) => { o.items[0].product_id = o.items[0].productId; delete o.items[0].productId; }],
  ])('fails the whole metadata set closed: %s', (_label, mutate) => {
    const order = linkedOrder(); (mutate as (o: any) => void)(order);
    expect(readRestaurantHistoryLines(order)).toBeNull();
  });
});
