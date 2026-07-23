import { describe, expect, it } from 'vitest';
import {
  findVariantPriceSessionItemGroup,
  formatSessionItemQuantity,
  getTotalSessionItemQuantity,
  groupSessionItems,
  pickSessionItemForDecrement,
} from '../src/renderer/components/billiard/session-item-groups';

describe('billiard session item grouping', () => {
  it('groups catalogue rows only when variant id and unit price both match', () => {
    const groups = groupSessionItems([
      {
        id: 'line-a',
        variantId: 'Tea-1',
        name: 'Tea',
        quantity: 1,
        unitPrice: 5,
      },
      {
        id: 'line-b',
        variantId: 'tea-1',
        name: 'Tea',
        quantity: '2',
        unitPrice: '5.00',
      },
      {
        id: 'line-old-price',
        variantId: 'tea-1',
        name: 'Tea',
        quantity: 1,
        unitPrice: 4.5,
      },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      variantId: 'Tea-1',
      quantity: 3,
      unitPrice: 5,
      totalPrice: 15,
      sourceItemIds: ['line-a', 'line-b'],
    });
    expect(groups[1]).toMatchObject({
      quantity: 1,
      unitPrice: 4.5,
      totalPrice: 4.5,
    });
    expect(
      findVariantPriceSessionItemGroup(groups, 'TEA-1', 5)?.quantity,
    ).toBe(3);
    expect(getTotalSessionItemQuantity(groups)).toBe(4);
  });

  it('keeps manually entered raw lines separate even when names and prices match', () => {
    const groups = groupSessionItems([
      {
        id: 'custom-a',
        variantId: null,
        name: 'Herbata',
        quantity: 1,
        unitPrice: 5,
      },
      {
        id: 'custom-b',
        variantId: null,
        name: 'Herbata',
        quantity: 2,
        unitPrice: 5,
      },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.key)).toEqual([
      'item:custom-a',
      'item:custom-b',
    ]);
  });

  it('selects a deterministic positive raw line within the exact display group', () => {
    const [group] = groupSessionItems([
      {
        id: 'line-a',
        variantId: 'tea',
        name: 'Tea',
        quantity: 2,
        unitPrice: 5,
      },
      {
        id: 'line-b',
        variantId: 'tea',
        name: 'Tea',
        quantity: 1,
        unitPrice: 5,
      },
    ]);

    expect(pickSessionItemForDecrement(group)?.id).toBe('line-b');
    expect(formatSessionItemQuantity(1.25)).toBe('1.25');
  });
});
