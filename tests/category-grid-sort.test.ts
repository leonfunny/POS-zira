import { describe, expect, it } from 'vitest';

import type { Category } from '../src/renderer/hooks/usePosDb';
import { sortCategories } from '../src/renderer/components/products/CategoryGrid';

function category(id: string, name: string, sortOrder: number): Category {
  return {
    id,
    name,
    sort_order: sortOrder,
    color: null,
    icon: null,
    updated_at: null,
  };
}

describe('CategoryGrid sorting', () => {
  it('sorts by sort_order and then display name', () => {
    const rows = [
      category('z', 'Zebra', 2),
      category('b', 'Bread', 1),
      category('a', 'Apples', 1),
    ];

    expect(sortCategories(rows, 'en').map((row) => row.id)).toEqual(['a', 'b', 'z']);
  });
});
