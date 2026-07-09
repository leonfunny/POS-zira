import type { ProductCategorySelection } from './CategoryGrid';

export type BrowseView =
  | { name: 'categories' }
  | { name: 'products'; categoryId: ProductCategorySelection };

export type EditReturn = BrowseView | { name: 'external' };

export type ProductView = BrowseView | { name: 'edit'; productId: string; returnTo: EditReturn };

export type DeepLinkOutcome =
  | { kind: 'idle' }
  | { kind: 'reset' }
  | { kind: 'open'; productId: string }
  | { kind: 'missing' };

export function isExternalEdit(view: ProductView): boolean {
  return view.name === 'edit' && view.returnTo.name === 'external';
}

export function viewAfterEditExit(view: ProductView): BrowseView {
  if (view.name !== 'edit') return view;
  if (view.returnTo.name === 'external') return { name: 'categories' };
  return view.returnTo;
}

export function deepLinkOutcome(
  requestedProductId: string | null | undefined,
  loading: boolean,
  consumedProductId: string | null,
  productExists: (productId: string) => boolean,
): DeepLinkOutcome {
  if (!requestedProductId) {
    return consumedProductId ? { kind: 'reset' } : { kind: 'idle' };
  }
  if (loading || consumedProductId === requestedProductId) return { kind: 'idle' };
  return productExists(requestedProductId)
    ? { kind: 'open', productId: requestedProductId }
    : { kind: 'missing' };
}
