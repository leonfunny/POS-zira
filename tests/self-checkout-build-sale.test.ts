// Unit tests for the self-checkout order builder. These pin the IPC payload
// shape that ships to `pos:orders:create` so any regression that breaks the
// main process handler (or the stock-decrement loop) will fail here first.

import { describe, expect, it } from 'vitest';
import {
  buildSelfCheckoutSale,
  calculateIncludedTax,
} from '../src/renderer/windows/self-checkout/build-sale';
import type { ScCartItem } from '../src/renderer/windows/self-checkout/useScCart';

function makeItem(overrides: Partial<ScCartItem> = {}): ScCartItem {
  return {
    variantId: 'variant-1',
    productId: 'product-1',
    name: 'Test Product',
    sku: 'SKU-001',
    price: 1230, // 12.30 zł
    quantity: 1,
    vatRate: 23,
    ...overrides,
  };
}

const FIXED_NOW = new Date('2026-05-17T10:00:00.000Z');
let idCounter = 0;
const seqId = () => `item-${++idCounter}`;

describe('calculateIncludedTax', () => {
  it('returns 0 for an empty cart', () => {
    expect(calculateIncludedTax([])).toBe(0);
  });

  it('extracts 23% VAT from a 12.30 zł line (1.30 zł × 0.23/1.23 = 230 gr)', () => {
    expect(calculateIncludedTax([makeItem({ price: 1230, quantity: 1, vatRate: 23 })])).toBe(230);
  });

  it('extracts 8% VAT from a 5.40 zł line', () => {
    // 540 - 540 * 100 / 108 = 540 - 500 = 40 gr
    expect(calculateIncludedTax([makeItem({ price: 540, quantity: 1, vatRate: 8 })])).toBe(40);
  });

  it('extracts 5% VAT from a 5.25 zł line', () => {
    // 525 - 525 * 100 / 105 = 525 - 500 = 25 gr
    expect(calculateIncludedTax([makeItem({ price: 525, quantity: 1, vatRate: 5 })])).toBe(25);
  });

  it('skips items with vatRate 0 or undefined (bag fee)', () => {
    const items = [
      makeItem({ price: 1000, vatRate: 0 }),
      makeItem({ price: 1000, vatRate: undefined }),
    ];
    expect(calculateIncludedTax(items)).toBe(0);
  });

  it('accumulates VAT across multiple lines and quantities', () => {
    // 2 × 12.30 zł @ 23% = 2460 gr gross → 460 gr VAT
    // 3 × 5.40 zł @ 8% = 1620 gr gross → 120 gr VAT
    const items = [
      makeItem({ price: 1230, quantity: 2, vatRate: 23 }),
      makeItem({ variantId: 'v2', price: 540, quantity: 3, vatRate: 8 }),
    ];
    expect(calculateIncludedTax(items)).toBe(460 + 120);
  });
});

describe('buildSelfCheckoutSale — order shape', () => {
  it('produces an order with SELF_CHECKOUT source and tax-inclusive totals', () => {
    const sale = buildSelfCheckoutSale({
      items: [makeItem({ price: 1230, quantity: 1, vatRate: 23 })],
      orderId: 'order-123',
      method: 'CARD',
      kioskUserId: 'kiosk-user-1',
      now: FIXED_NOW,
      randomId: seqId,
    });

    expect(sale.order).toMatchObject({
      id: 'order-123',
      status: 'COMPLETED',
      source: 'SELF_CHECKOUT',
      subtotal: 1230,
      tax: 230,
      total: 1230,
      payment_method: 'CARD',
      payment_amount: 1230,
      change_amount: 0,
      discount: 0,
      tip: 0,
      mode: 'retail',
      order_type: 'standard',
      synced: 0,
      staff_id: 'kiosk-user-1',
      staff_name: 'Self-checkout',
      created_at: '2026-05-17T10:00:00.000Z',
      payment_tenders: null,
    });
  });

  it('serializes CASH method and accepts null kioskUserId', () => {
    const sale = buildSelfCheckoutSale({
      items: [makeItem({ price: 500, quantity: 1, vatRate: 23 })],
      orderId: 'order-cash',
      method: 'CASH',
      kioskUserId: null,
      now: FIXED_NOW,
      randomId: seqId,
    });
    expect(sale.order.payment_method).toBe('CASH');
    expect(sale.order.staff_id).toBeNull();
  });
});

describe('buildSelfCheckoutSale — items shape', () => {
  it('maps each cart line to an order_item with variant_id set', () => {
    const sale = buildSelfCheckoutSale({
      items: [
        makeItem({ variantId: 'v-a', price: 1230, quantity: 2 }),
        makeItem({ variantId: 'v-b', price: 540, quantity: 3, vatRate: 8 }),
      ],
      orderId: 'order-multi',
      method: 'CARD',
      kioskUserId: 'kiosk-1',
      now: FIXED_NOW,
      randomId: seqId,
    });

    expect(sale.items).toHaveLength(2);
    expect(sale.items[0]).toMatchObject({
      order_id: 'order-multi',
      variant_id: 'v-a',
      sku: 'SKU-001',
      price: 1230,
      quantity: 2,
      total: 2460,
      vat_rate: 23,
      notes: null,
    });
    expect(sale.items[1]).toMatchObject({
      variant_id: 'v-b',
      quantity: 3,
      total: 1620,
      vat_rate: 8,
    });
  });

  it('serializes the bag-fee line with variant_id=null and BAG_FEE note', () => {
    const sale = buildSelfCheckoutSale({
      items: [
        makeItem({ variantId: 'real', price: 1230 }),
        makeItem({
          variantId: '__bag-fee__',
          isBagFee: true,
          name: 'Torba foliowa',
          sku: 'BAG',
          price: 20,
          quantity: 2,
          vatRate: undefined,
        }),
      ],
      orderId: 'order-bag',
      method: 'CARD',
      kioskUserId: null,
      now: FIXED_NOW,
      randomId: seqId,
    });

    const bagLine = sale.items.find((i) => i.name === 'Torba foliowa');
    expect(bagLine).toBeDefined();
    expect(bagLine!.variant_id).toBeNull();
    expect(bagLine!.notes).toBe('SELF_CHECKOUT_BAG_FEE');
    expect(bagLine!.vat_rate).toBe(23); // fallback when vatRate undefined
  });

  it('uses null sku when cart line has an empty sku string', () => {
    const sale = buildSelfCheckoutSale({
      items: [makeItem({ sku: '' })],
      orderId: 'order-nosku',
      method: 'CARD',
      kioskUserId: null,
      now: FIXED_NOW,
      randomId: seqId,
    });
    expect(sale.items[0].sku).toBeNull();
  });

  it('each item gets a unique id from the injected randomId', () => {
    let n = 0;
    const sale = buildSelfCheckoutSale({
      items: [makeItem(), makeItem({ variantId: 'v-2' })],
      orderId: 'order-ids',
      method: 'CARD',
      kioskUserId: null,
      now: FIXED_NOW,
      randomId: () => `id-${++n}`,
    });
    expect(sale.items.map((i) => i.id)).toEqual(['id-1', 'id-2']);
  });
});

describe('buildSelfCheckoutSale — invariants the main handler depends on', () => {
  it('every non-bag item carries a truthy variant_id for the stock decrement loop', () => {
    const sale = buildSelfCheckoutSale({
      items: [
        makeItem({ variantId: 'v-a' }),
        makeItem({ variantId: 'v-b', price: 100 }),
      ],
      orderId: 'order-stock',
      method: 'CARD',
      kioskUserId: null,
      now: FIXED_NOW,
      randomId: seqId,
    });

    for (const item of sale.items) {
      // `pos:orders:create` calls productRepo.decrementStock(item.variant_id, item.quantity)
      // only when variant_id is truthy. Non-bag items MUST have a real variant_id.
      expect(item.variant_id).toBeTruthy();
      expect(item.quantity).toBeGreaterThan(0);
    }
  });

  it('subtotal equals total (brutto pricing, no separate net subtotal)', () => {
    const sale = buildSelfCheckoutSale({
      items: [
        makeItem({ price: 1230, quantity: 2 }),
        makeItem({ variantId: 'v-2', price: 540, quantity: 3, vatRate: 8 }),
      ],
      orderId: 'order-totals',
      method: 'CARD',
      kioskUserId: null,
      now: FIXED_NOW,
      randomId: seqId,
    });
    expect(sale.order.subtotal).toBe(sale.order.total);
    expect(sale.order.payment_amount).toBe(sale.order.total);
  });
});
