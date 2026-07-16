import { describe, expect, it } from 'vitest';

import type { Category } from '../src/renderer/hooks/usePosDb';
import { categoryImageUrl, sortCategories } from '../src/renderer/components/products/CategoryGrid';

function category(id: string, name: string, sortOrder: number): Category {
  return {
    id,
    name,
    sort_order: sortOrder,
    color: null,
    icon: null,
    image_url: null,
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

  it('uses the dedicated category image and keeps one-release legacy icon fallback', () => {
    const canonical = { ...category('a', 'Apples', 0), image_url: 'https://img.example/apples.webp' };
    const legacy = { ...category('b', 'Bread', 1), icon: 'https://img.example/bread.webp' };
    const glyphOnly = { ...category('c', 'Coffee', 2), icon: '☕' };

    expect(categoryImageUrl(canonical)).toBe('https://img.example/apples.webp');
    expect(categoryImageUrl(legacy)).toBe('https://img.example/bread.webp');
    expect(categoryImageUrl(glyphOnly)).toBeNull();
  });
});
