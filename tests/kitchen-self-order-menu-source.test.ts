import { describe, expect, it } from 'vitest';
import { buildKitchenSelfOrderMenu } from '../src/main/kitchen-self-order/menu-service';
import { resolveKitchenSelfOrderMenuSource } from '../src/shared/kitchen-self-order';

const flagged = [
  { id: 'drinks', name: 'Drinks', kitchen_print: 1 },
  { id: 'shelf', name: 'Shelf goods', kitchen_print: 0 },
] as any[];

const products = [
  { id: 'p-tea', name: 'Bubble tea', category_id: 'drinks', retail_price: 1500, is_active: 1 },
  { id: 'p-can', name: 'Canned fish', category_id: 'shelf', retail_price: 900, is_active: 1 },
] as any[];

describe('kitchen self-order menu source', () => {
  it('honors explicit all vs selected', () => {
    expect(resolveKitchenSelfOrderMenuSource({ kitchenSelfOrderMenuSource: 'all' }, flagged)).toBe('all');
    expect(resolveKitchenSelfOrderMenuSource({ kitchenSelfOrderMenuSource: 'selected' }, flagged)).toBe('selected');
  });

  it('derives from kitchen_print flags when config is missing or legacy', () => {
    expect(resolveKitchenSelfOrderMenuSource({}, flagged)).toBe('selected');
    expect(resolveKitchenSelfOrderMenuSource({ kitchenSelfOrderMenuSource: null }, flagged)).toBe('selected');
    expect(resolveKitchenSelfOrderMenuSource({ kitchenSelfOrderMenuSource: 'bogus' }, flagged)).toBe('selected');
    expect(resolveKitchenSelfOrderMenuSource({}, [{ id: 'a', name: 'A', kitchen_print: 0 }])).toBe('all');
    expect(resolveKitchenSelfOrderMenuSource({}, [])).toBe('all');
  });

  it('all shows every category; selected shows only flagged; selected-with-none is empty', () => {
    const all = buildKitchenSelfOrderMenu({
      config: { kitchenSelfOrderMenuSource: 'all' },
      categories: flagged,
      products,
    });
    expect(all.categories.map((category) => category.id).sort()).toEqual(['drinks', 'shelf']);

    const selected = buildKitchenSelfOrderMenu({
      config: { kitchenSelfOrderMenuSource: 'selected' },
      categories: flagged,
      products,
    });
    expect(selected.categories.map((category) => category.id)).toEqual(['drinks']);
    expect(selected.products.map((product) => product.id)).toEqual(['p-tea']);

    const emptySelected = buildKitchenSelfOrderMenu({
      config: { kitchenSelfOrderMenuSource: 'selected' },
      categories: [{ id: 'x', name: 'X', kitchen_print: 0 }] as any[],
      products: [],
    });
    expect(emptySelected.categories).toEqual([]);
    expect(emptySelected.products).toEqual([]);
  });
});
