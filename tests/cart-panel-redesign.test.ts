import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const CART = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/Cart.tsx'), 'utf8');
const CART_ITEM = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/CartItem.tsx'), 'utf8');
const QUICK_ACTIONS = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/templates/retail/QuickActions.tsx'), 'utf8');
const RETAIL_TEMPLATE = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/templates/retail/RetailTemplate.tsx'), 'utf8');

describe('POS cart panel redesign', () => {
  it('shows unique item count and total quantity in the cart header', () => {
    expect(CART).toContain('totalQuantityStr');
    expect(CART).toContain("tOr('pos.cart.qty', 'Qty')");
    expect(CART).toContain('aria-hidden="true">–</span>');
  });

  it('puts product identity and line total before row actions', () => {
    const rendered = CART_ITEM.slice(CART_ITEM.indexOf('return ('));
    expect(rendered.indexOf('resolveName(item, lang)')).toBeLessThan(rendered.indexOf("tOr('pos.cart.printLabelShort', 'Print')"));
    expect(rendered.indexOf('{lineTotalText}')).toBeLessThan(rendered.indexOf("tOr('pos.cart.printLabelShort', 'Print')"));
  });

  it('shows unit price times quantity without repeating the line total calculation', () => {
    expect(CART_ITEM).toContain('unitPriceQtyText');
    expect(CART_ITEM).toContain('unitPriceText');
    expect(CART_ITEM).toContain('lineTotalText');
    expect(CART_ITEM).toContain('×');
    expect(CART_ITEM).not.toContain('= ${lineTotalText}');
  });

  it('keeps print and delete as explicit secondary actions', () => {
    expect(CART_ITEM).toContain("tOr('pos.cart.printLabelShort', 'Print')");
    expect(CART_ITEM).toContain("tOr('pos.cart.remove', 'Remove')");
    expect(CART_ITEM).not.toContain("tOr('pos.cart.editPriceShort', 'Price')");
  });

  it('keeps the primary checkout action as a high-priority PAY button', () => {
    expect(CART).toContain("tOr('pos.payCta', 'PAY')");
    expect(CART).toContain('bg-slate-950');
  });

  it('keeps retail quick actions in one compact horizontal rail', () => {
    expect(QUICK_ACTIONS).toContain('overflow-x-auto whitespace-nowrap scrollbar-hide');
    expect(QUICK_ACTIONS).not.toContain('flex-wrap');
    expect(QUICK_ACTIONS).toContain("label={tOr('pos.holdCart', 'Hold')}");
    expect(QUICK_ACTIONS).toContain("label={tOr('pos.quickDiscount', 'Discount')}");
    expect(QUICK_ACTIONS).toContain("label={tOr('pos.history', 'History')}");
    expect(QUICK_ACTIONS).toContain("label={tOr('pos.quickAdd.camera', 'Camera')}");
    expect(QUICK_ACTIONS).toContain("label={tOr('pos.quickAdd.createProduct', 'Tạo sản phẩm')}");
    expect(RETAIL_TEMPLATE).toContain('showOrderActionChips={false}');
  });
});
