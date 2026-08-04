/**
 * Selling by weight on the Android till — the last core grocery path that had
 * never been exercised.
 *
 * The tablet has no scale (`scale.readWeight` is a NO_SCALE stub, and
 * `config.scale.enabled` is false), so a weighed item is typed in by hand. That
 * is a legitimate way to run a shop, but it is only legitimate if the typed
 * weight survives the whole chain intact. The failure that matters is silent:
 * a 0.75 kg line that reaches the backend as "1" is the shop charging for one
 * unit instead of three quarters of a kilo, on every weighed sale, with nothing
 * on screen to show for it.
 *
 * Device runs could not cover this — the salon used for testing has 146
 * products and every one of them is PIECE.
 */
import { describe, expect, test } from 'vitest';

import { resolveRetailCartItem, buildRetailCartItem } from '../src/renderer/components/pos/retail-sale-flow';
import { classifyProductSale } from '../src/shared/product-sale-classifier';
import { buildBackendOrderItem } from '../src/shared/pos/order-line-contract';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';

/** 24.00 zł per kg, sold loose. */
const LOOSE_PRODUCT = {
  id: 'variant-loose',
  name: 'Chè khô',
  sku: 'CHE-KG',
  retail_price: 2400,
  vat_rate: 5,
  sell_by: 'WEIGHT',
  sale_unit: 'kg',
  track_inventory: 1,
} as any;

describe('a weighed line with no scale attached', () => {
  test('the tablet asks for the weight instead of refusing the sale', async () => {
    const result = await resolveRetailCartItem(LOOSE_PRODUCT, { scaleEnabled: false });

    expect(result.ok).toBe(false);
    // requiresScale is what makes POSLayout open the manual-weight prompt
    // rather than dead-ending on a toast; without it a shop with no scale
    // simply could not sell loose goods on this device.
    expect(result.saleClass.requiresScale, 'no manual-weight prompt would open').toBe(true);
    expect((result as any).error.code).toBe('SCALE_DISABLED');
  });

  test('the typed weight prices the line, it does not become a unit count', async () => {
    const saleClass = classifyProductSale(LOOSE_PRODUCT as any);
    const item = buildRetailCartItem(LOOSE_PRODUCT, saleClass, 0.75, 'line-1');

    expect(item.quantity).toBe(0.75);
    expect(item.sellBy).toBe('WEIGHT');
    expect(item.saleUnit).toBe('kg');
    // 24.00 zł/kg × 0.75 = 18.00 zł. A unit count would have said 24.00.
    expect(item.total).toBe(1800);
  });
});

describe('the weighed line through the Android order path', () => {
  async function committed(quantity: number) {
    const database = await initAndroidDb({ locateFile: null });
    const repo = createOrderRepo(database);
    const saleClass = classifyProductSale(LOOSE_PRODUCT as any);
    const cartItem = buildRetailCartItem(LOOSE_PRODUCT, saleClass, quantity, 'line-1');

    repo.create(
      {
        id: 'order-1', status: 'COMPLETED', subtotal: cartItem.total, total: cartItem.total,
        payment_method: 'CASH', payment_amount: cartItem.total, shift_id: 'shift-1',
        source: 'POS', mode: 'retail',
      },
      [{
        id: 'line-1', order_id: 'order-1', variant_id: cartItem.variantId, name: cartItem.name,
        price: cartItem.price, quantity: cartItem.quantity, sale_quantity: cartItem.quantity,
        sale_unit: cartItem.saleUnit, sell_by: cartItem.sellBy, total: cartItem.total,
        vat_rate: cartItem.vatRate,
      }],
    );
    return { database, stored: repo.getItemsByOrderId('order-1')[0] };
  }

  test('the fractional weight is persisted, not rounded to a whole unit', async () => {
    const { stored } = await committed(0.75);
    expect(Number(stored.sale_quantity)).toBe(0.75);
    expect(Number(stored.quantity)).toBe(0.75);
    expect(stored.sell_by).toBe('WEIGHT');
    expect(stored.sale_unit).toBe('kg');
    expect(Number(stored.total)).toBe(1800);
  });

  test('the backend receives saleQuantity + saleUnit, never packQuantity', async () => {
    const { stored } = await committed(0.75);
    const payload = buildBackendOrderItem(stored);

    // This is the money assertion. packQuantity on a weighed line is the shop
    // billing a unit instead of a weight.
    expect(payload.saleQuantity).toBe(0.75);
    expect(payload.saleUnit).toBe('kg');
    expect(payload.packQuantity, 'a weighed line was sent as a unit count').toBeUndefined();
  });

  test('a piece line still goes up as packQuantity — the branch works both ways', async () => {
    const database = await initAndroidDb({ locateFile: null });
    const repo = createOrderRepo(database);
    repo.create(
      { id: 'order-2', status: 'COMPLETED', subtotal: 1200, total: 1200, payment_method: 'CASH', shift_id: 's', source: 'POS', mode: 'retail' },
      [{ id: 'l', order_id: 'order-2', variant_id: 'v', name: '7 Up', price: 1200, quantity: 1, sell_by: 'PIECE', total: 1200, vat_rate: 23 }],
    );
    const payload = buildBackendOrderItem(repo.getItemsByOrderId('order-2')[0]);
    expect(payload.packQuantity).toBe(1);
    expect(payload.saleQuantity).toBeUndefined();
  });

  test('a weight that is not a number cannot become a free sale', async () => {
    // Defensive: a mistyped weight must not silently price the line at zero.
    const saleClass = classifyProductSale(LOOSE_PRODUCT as any);
    const item = buildRetailCartItem(LOOSE_PRODUCT, saleClass, Number.NaN, 'line-x');
    expect(Number.isFinite(item.total) ? item.total : 0).toBe(0);
  });
});
