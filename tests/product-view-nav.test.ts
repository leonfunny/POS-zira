import { describe, expect, it } from 'vitest';
import {
  deepLinkOutcome,
  isExternalEdit,
  viewAfterEditExit,
  type ProductView,
} from '../src/renderer/components/products/product-view-nav';

const categories: ProductView = { name: 'categories' };
const productsInCategory: ProductView = { name: 'products', categoryId: 'cat-1' };

describe('isExternalEdit', () => {
  it('is true only for an edit view opened from another tab', () => {
    expect(isExternalEdit({ name: 'edit', productId: 'v1', returnTo: { name: 'external' } })).toBe(true);
  });

  it('is false for an edit view opened from the catalog', () => {
    expect(isExternalEdit({ name: 'edit', productId: 'v1', returnTo: { name: 'categories' } })).toBe(false);
  });

  it('is false for any browse view', () => {
    expect(isExternalEdit(categories)).toBe(false);
    expect(isExternalEdit(productsInCategory)).toBe(false);
  });
});

describe('viewAfterEditExit', () => {
  it('returns to the browse view the edit was opened from', () => {
    expect(viewAfterEditExit({ name: 'edit', productId: 'v1', returnTo: { name: 'products', categoryId: 'cat-1' } }))
      .toEqual({ name: 'products', categoryId: 'cat-1' });
  });

  it('NEVER returns the external sentinel because it is not a renderable browse view', () => {
    const result = viewAfterEditExit({ name: 'edit', productId: 'v1', returnTo: { name: 'external' } });
    expect(result).toEqual({ name: 'categories' });
    expect(result.name).not.toBe('external');
  });

  it('leaves a browse view untouched', () => {
    expect(viewAfterEditExit(categories)).toEqual(categories);
    expect(viewAfterEditExit(productsInCategory)).toEqual(productsInCategory);
  });
});

describe('deepLinkOutcome', () => {
  const known = (id: string) => id === 'v1' || id === 'deactivated-v2';

  it('does nothing without a request', () => {
    expect(deepLinkOutcome(undefined, false, null, known)).toEqual({ kind: 'idle' });
  });

  it('forgets the consumed id once the request is cleared, so the same product reopens', () => {
    expect(deepLinkOutcome(undefined, false, 'v1', known)).toEqual({ kind: 'reset' });
  });

  it('waits while the catalog is still loading', () => {
    expect(deepLinkOutcome('v1', true, null, known)).toEqual({ kind: 'idle' });
  });

  it('opens a product that exists', () => {
    expect(deepLinkOutcome('v1', false, null, known)).toEqual({ kind: 'open', productId: 'v1' });
  });

  it('opens a deactivated product too because useProducts reads inactive rows', () => {
    expect(deepLinkOutcome('deactivated-v2', false, null, known))
      .toEqual({ kind: 'open', productId: 'deactivated-v2' });
  });

  it('reports a product deleted from the catalog', () => {
    expect(deepLinkOutcome('gone', false, null, known)).toEqual({ kind: 'missing' });
  });

  it('never re-opens the id it already consumed', () => {
    expect(deepLinkOutcome('v1', false, 'v1', known)).toEqual({ kind: 'idle' });
  });
});
