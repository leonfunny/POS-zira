// @vitest-environment happy-dom
/**
 * The salon flow keeps its tip on `PosState.tip`, not on the cart, and
 * `PaymentModal` charges `cart.total + tip` (PaymentModal.tsx:374). The salon
 * used to render its own cart panel which added the tip itself; moving it onto
 * the shared `Cart` would silently drop that row and show a total SMALLER than
 * the amount the payment modal then asks for.
 *
 * This renders the real component rather than grepping the source, because a
 * source-assertion test would pass against a comment.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import React from 'react';

vi.mock('../src/renderer/hooks/useConfig', () => ({
  useConfig: () => ({ config: { posLanguage: 'en', language: 'en' }, reload: () => {} }),
}));

import Cart from '../src/renderer/components/pos/Cart';

const CART = {
  items: [{
    id: 'l1', variantId: 'p1', name: 'Gel Polish', sku: 'SKU-1',
    price: 10000, quantity: 1, total: 10000, saleUnit: 'pc',
    sellBy: 'PIECE', vatRate: 23, name_translations: null,
  }],
  subtotal: 10000,
  discount: 0,
  tax: 0,
  total: 10000,
} as any;

/** Currency comes back as the raw key in tests; only the numbers matter here. */
const t = (k: string) => k;

let host: HTMLDivElement;
let root: Root;

function render(props: Record<string, unknown>) {
  act(() => {
    root.render(
      React.createElement(Cart, {
        cart: CART,
        dispatch: () => {},
        onPay: () => {},
        t,
        shiftOpen: true,
        ...props,
      } as any),
    );
  });
  return host.textContent ?? '';
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('cart total with a salon tip', () => {
  test('adds the tip to the displayed total and shows it on its own row', () => {
    const text = render({ tip: 1500 });
    // 100.00 + 15.00 = 115.00 — what PaymentModal will charge.
    expect(text).toContain('115.00');
    expect(text).toContain('+15.00');
  });

  test('the PAY button quotes the tip-inclusive amount', () => {
    render({ tip: 1500 });
    const pay = [...host.querySelectorAll('button')]
      .find((b) => /pos\.payCta|PAY/i.test(b.textContent ?? ''));
    expect(pay, 'pay button should be rendered').toBeTruthy();
    expect(pay!.textContent).toContain('115.00');
  });

  test('retail is untouched: no tip prop means no tip row and the plain total', () => {
    const text = render({});
    expect(text).toContain('100.00');
    expect(text).not.toContain('115.00');
    expect(text).not.toMatch(/\+\d+\.\d{2}/);
  });

  test('a zero or negative tip renders no row', () => {
    expect(render({ tip: 0 })).not.toMatch(/\+\d+\.\d{2}/);
    expect(render({ tip: -500 })).toContain('100.00');
  });
});
