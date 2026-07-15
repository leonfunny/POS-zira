import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('Products drill-down components', () => {
  it('renders ProductTile as a neutral touch button with stock strip, code, price warnings, and status badges', () => {
    const tile = source('src/renderer/components/products/ProductTile.tsx');

    expect(tile).toContain('stockColor(stock)');
    expect(tile).toContain('stockStripClasses[stockBand]');
    expect(tile).toContain('stockBadgeClasses[stockBand]');
    expect(tile).toContain('resolveName(product, language)');
    expect(tile).toContain('min-h-[148px]');
    expect(tile).toContain('min-w-0 flex-1 overflow-hidden');
    expect(tile).toContain('min-w-12 shrink-0 whitespace-nowrap');
    expect(tile).toContain('line-clamp-3');
    expect(tile).toContain('<ProductThumbnail');
    expect(tile).toContain('product.sku || product.barcode');
    expect(tile).toContain('bg-white text-slate-950');
    expect(tile).toContain('product._isDraft');
    expect(tile).toContain('product.is_active === 0');
    expect(tile).toContain('price <= 0');
    expect(tile).toContain('onClick={() => onSelect(product)}');
  });

  it('renders ProductTileGrid with touch-safe navigation, capability-gated create, and incremental loading', () => {
    const grid = source('src/renderer/components/products/ProductTileGrid.tsx');

    expect(grid).toContain('products.slice(0, visibleLimit)');
    expect(grid).toContain('const PRODUCT_TILE_PAGE_SIZE = 300');
    expect(grid).toContain('useEffect(() => {');
    expect(grid).toContain('}, [browseKey]);');
    expect(grid).toContain("tOr(t, 'products.loadMore', 'Load more')");
    expect(grid).toContain('canCreateProduct ? (');
    expect(grid).toContain('<ProductTile');
    expect(grid).toContain('onOpenSearch');
    expect(grid).toContain('onAddByBarcode');
    expect(grid).toContain('onBack');
    expect(grid).toContain('minmax(220px,1fr)');
  });

  it('renders sorted category buttons plus all and uncategorised entries', () => {
    const grid = source('src/renderer/components/products/CategoryGrid.tsx');

    expect(grid).toContain('sortCategories(categories, language)');
    expect(grid).toContain("onOpenCategory('ALL')");
    expect(grid).toContain('onOpenCategory(null)');
    expect(grid).toContain('product.category_id == null');
    expect(grid).toContain('canCreateProduct ? (');
    expect(grid).toContain('canManageCategories ? (');
    expect(grid).toContain('onAddByBarcode');
  });

  it('uses the POS barcode resolver, duplicate warning, scanner bridge, and keyboard inset in search', () => {
    const overlay = source('src/renderer/components/products/ProductSearchOverlay.tsx');

    expect(overlay).toContain('resolveScan(code, allProducts');
    expect(overlay).toContain('window.electronAPI.pos.products.getByBarcode');
    expect(overlay).toContain('window.electronAPI.onBarcodeScanned');
    expect(overlay).toContain("resolution?.kind === 'many'");
    expect(overlay).toContain("'Trùng mã EAN'");
    expect(overlay).toContain("var(--touch-keyboard-inset, 0px)");
    expect(overlay).toContain('canCreateProduct && resolution.kind ===');
    expect(overlay).toContain('requestIdRef.current += 1');
    expect(overlay).toContain('<ProductThumbnail');
    expect(overlay).toContain('productStockDisplay(product).available');
    expect(overlay).toContain('const SEARCH_RESULT_PAGE_SIZE = 100');
    expect(overlay).toContain('products.slice(0, visibleLimit)');
    expect(overlay).not.toContain('products.slice(0, 100)');
    expect(overlay).toContain('categoryById.get(product.category_id)');
    expect(overlay).toContain("tOr(t, 'products.loadMore', 'Load more')");
    expect(overlay).toContain('onClick={() => void resolveCode(query)}');
    expect(overlay).toContain("tOr(t, 'common.retry', 'Retry')");
  });

  it('keeps ProductDetailDrawer behavior in the full-screen ProductEditView', () => {
    const editView = source('src/renderer/components/products/ProductEditView.tsx');

    expect(editView).toContain('<ProductEditForm');
    expect(editView).toContain('window.electronAPI.printLabel');
    expect(editView).toContain('onImportDraft(product)');
    expect(editView).toContain('<StockAdjustmentDialog');
    expect(editView).toContain('<DeactivateProductDialog');
    expect(editView).toContain('productInCart && canDeactivateProduct');
    expect(editView).toContain('isProductInCart={productInCart}');
    expect(editView).toContain('onStaleProductHidden');
    expect(editView).toContain('products.edit.discardConfirm');
    expect(editView).toContain('<ProductStatusBadge');
    expect(editView).toContain("'products.drawer.availableStock'");
    expect(editView).toContain("'products.drawer.physicalStock'");
  });

  it('routes ProductModule through categories, product tiles, edit view, and search overlay', () => {
    const moduleSource = source('src/renderer/components/products/ProductModule.tsx');
    const navSource = source('src/renderer/components/products/product-view-nav.ts');

    expect(navSource).toContain("{ name: 'categories' }");
    expect(navSource).toContain("{ name: 'products'; categoryId: ProductCategorySelection }");
    expect(navSource).toContain("{ name: 'edit'; productId: string; returnTo: EditReturn }");
    expect(moduleSource).toContain("type ProductView");
    expect(moduleSource).toContain('<CategoryGrid');
    expect(moduleSource).toContain('<ProductTileGrid');
    expect(moduleSource).toContain('<ProductEditView');
    expect(moduleSource).toContain('<ProductSearchOverlay');
    expect(moduleSource).toContain('canCreateProduct={adminCapabilities?.canCreateProduct === true}');
    expect(moduleSource).toContain("setAddInitialBarcode('')");
    expect(moduleSource).toContain('syncProducts');
    expect(moduleSource).toContain('setKindFilter');
    expect(moduleSource).toContain('categoryById={categoryById}');
    expect(moduleSource).toContain("browseKey={`${view.categoryId ?? 'UNCATEGORISED'}:${kindFilter}`}");
    expect(moduleSource).not.toContain('<ProductTable');
    expect(moduleSource).not.toContain('<ProductToolbar');
    expect(moduleSource).not.toContain('<ProductDetailDrawer');
  });

  it('seeds create category and barcode while keeping one idempotency key per dialog open', () => {
    const moduleSource = source('src/renderer/components/products/ProductModule.tsx');
    const dialog = source('src/renderer/components/products/ProductCreateDialog.tsx');

    expect(moduleSource).toContain('initialCategoryId={createCategoryId}');
    expect(moduleSource).toContain('initialBarcode={createBarcode}');
    expect(moduleSource).toContain("view.categoryId !== 'ALL'");
    expect(dialog).toContain('initialCategoryId?: string | null');
    expect(dialog).toContain('initialBarcode?: string');
    expect(dialog).toContain("setStockQty('0')");
    expect(dialog).toContain('setCategoryId(initialCategoryId ??');
    expect(dialog).toContain('setBarcode(initialBarcode ??');
    expect(dialog).toContain('setIdempotencyKey(makeIdempotencyKey())');
    expect(dialog).toContain('parseProductMoneyInputToGrosze(value, { allowZero: false })');
    expect(dialog).toContain('idempotencyKey,');
    expect(dialog).toContain('sellBy,');
    expect(dialog).toContain('result.data.variant');
    expect(dialog).not.toContain('idempotencyKey: makeIdempotencyKey()');
  });
});
