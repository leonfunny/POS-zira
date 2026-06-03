import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const CART = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/Cart.tsx'), 'utf8');
const CART_ITEM = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/CartItem.tsx'), 'utf8');

describe('POS cart panel redesign', () => {
  it('shows unique item count and total quantity in the cart header', () => {
    expect(CART).toContain('totalQuantityStr');
    expect(CART).toContain("tOr('pos.cart.qty', 'Qty')");
  });

  it('shows line math and a visible line total for each cart row', () => {
    expect(CART_ITEM).toContain('lineFormula');
    expect(CART_ITEM).toContain('unitPriceText');
    expect(CART_ITEM).toContain('lineTotalText');
    expect(CART_ITEM).toContain('×');
  });

  it('keeps row actions explicit instead of icon-only', () => {
    expect(CART_ITEM).toContain("tOr('pos.cart.editPriceShort', 'Price')");
    expect(CART_ITEM).toContain("tOr('pos.cart.printLabelShort', 'Print')");
    expect(CART_ITEM).toContain("tOr('pos.cart.remove', 'Remove')");
  });

  it('keeps the primary checkout action as a high-priority PAY button', () => {
    expect(CART).toContain("tOr('pos.payCta', 'PAY')");
    expect(CART).toContain('bg-slate-950');
  });
});
