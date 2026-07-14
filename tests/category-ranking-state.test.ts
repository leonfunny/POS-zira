import { describe, expect, it } from 'vitest';
import type { ProductAdminCategory } from '../src/shared/types';
import type { Category } from '../src/renderer/hooks/usePosDb';
import {
  buildCategoryOrderUpdates,
  mergePersistedCategoryOrder,
} from '../src/renderer/components/pos/category-ranking-state';

function category(id: string, rank: number, revision: string): Category {
  return {
    id,
    name: id,
    icon: null,
    color: null,
    sort_order: rank,
    updated_at: revision,
  };
}

function canonical(id: string, rank: number, revision: string): ProductAdminCategory {
  return {
    id,
    name: id,
    sortOrder: rank,
    isActive: true,
    updatedAt: revision,
  };
}

describe('category ranking OCC state', () => {
  it('uses the canonical revisions returned by the first save in a consecutive second reorder', () => {
    const initial = [category('a', 0, 'rev-a-1'), category('b', 1, 'rev-b-1')];
    const firstTarget = [initial[1], initial[0]];

    expect(buildCategoryOrderUpdates(firstTarget)).toEqual([
      { id: 'b', sortOrder: 0, expectedUpdatedAt: 'rev-b-1' },
      { id: 'a', sortOrder: 1, expectedUpdatedAt: 'rev-a-1' },
    ]);

    const afterFirstSave = mergePersistedCategoryOrder(firstTarget, firstTarget, [
      canonical('b', 0, 'rev-b-2'),
      canonical('a', 1, 'rev-a-2'),
    ]);
    const secondTarget = [afterFirstSave[1], afterFirstSave[0]];

    expect(buildCategoryOrderUpdates(secondTarget)).toEqual([
      { id: 'a', sortOrder: 0, expectedUpdatedAt: 'rev-a-2' },
      { id: 'b', sortOrder: 1, expectedUpdatedAt: 'rev-b-2' },
    ]);
  });

  it('merges a completed save baseline without discarding a newer in-flight drag order', () => {
    const initial = [category('a', 0, 'rev-a-1'), category('b', 1, 'rev-b-1'), category('c', 2, 'rev-c-1')];
    const persistedTarget = [initial[1], initial[0], initial[2]];
    const newerCurrentOrder = [initial[2], initial[1], initial[0]];

    const merged = mergePersistedCategoryOrder(newerCurrentOrder, persistedTarget, [
      canonical('b', 0, 'rev-b-2'),
      canonical('a', 1, 'rev-a-2'),
    ]);

    expect(merged.map((row) => row.id)).toEqual(['c', 'b', 'a']);
    expect(buildCategoryOrderUpdates(merged)).toEqual([
      { id: 'c', sortOrder: 0, expectedUpdatedAt: 'rev-c-1' },
      { id: 'b', sortOrder: 1, expectedUpdatedAt: 'rev-b-2' },
      { id: 'a', sortOrder: 2, expectedUpdatedAt: 'rev-a-2' },
    ]);
  });
});
