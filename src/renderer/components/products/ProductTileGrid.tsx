import React from 'react';
import { ChevronLeft, Plus, ScanBarcode, Search } from 'lucide-react';
import type { ProductListItem } from '../../hooks/useProducts';
import ProductTile from './ProductTile';

interface ProductTileGridProps {
  products: ProductListItem[];
  categoryName: string;
  language: string;
  t: (key: string) => string;
  canCreateProduct: boolean;
  onBack: () => void;
  onAddProduct: () => void;
  onAddByBarcode: () => void;
  onOpenSearch: () => void;
  onSelect: (product: ProductListItem) => void;
}

const PRODUCT_TILE_RENDER_LIMIT = 300;

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

export default function ProductTileGrid({
  products,
  categoryName,
  language,
  t,
  canCreateProduct,
  onBack,
  onAddProduct,
  onAddByBarcode,
  onOpenSearch,
  onSelect,
}: ProductTileGridProps) {
  const visibleProducts = products.slice(0, PRODUCT_TILE_RENDER_LIMIT);
  const truncated = visibleProducts.length < products.length;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-11 shrink-0 items-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <ChevronLeft size={18} />
            {tOr(t, 'products.back', 'Back')}
          </button>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-slate-950">{categoryName}</h2>
            <p className="text-sm text-slate-500">
              {products.length} {tOr(t, 'products.count.visible', 'products')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenSearch}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            title={tOr(t, 'products.search', 'Search')}
            aria-label={tOr(t, 'products.search', 'Search')}
          >
            <Search size={18} />
          </button>
          <button
            type="button"
            onClick={onAddByBarcode}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            title={tOr(t, 'products.scanBarcode', 'Scan barcode')}
            aria-label={tOr(t, 'products.scanBarcode', 'Scan barcode')}
          >
            <ScanBarcode size={18} />
          </button>
          {canCreateProduct ? (
            <button
              type="button"
              onClick={onAddProduct}
              className="inline-flex h-11 items-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
            >
              <Plus size={18} />
              {tOr(t, 'products.addProduct', 'Add product')}
            </button>
          ) : null}
        </div>
      </header>

      {truncated ? (
        <div className="mb-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
          {tOr(t, 'products.renderLimitHint', 'Use search to narrow the product list.')} ({visibleProducts.length}/{products.length})
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {visibleProducts.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
            {visibleProducts.map((product) => (
              <ProductTile
                key={product.id}
                product={product}
                language={language}
                t={t}
                onSelect={onSelect}
              />
            ))}
          </div>
        ) : (
          <div className="flex min-h-40 items-center justify-center border border-dashed border-slate-300 text-sm text-slate-500">
            {tOr(t, 'products.empty', 'No products found')}
          </div>
        )}
      </div>
    </section>
  );
}
