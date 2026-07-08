import React, { useMemo } from 'react';
import { Folder, FolderX, Grid3X3, Plus, ScanBarcode, Search, Tags } from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import type { Category } from '../../hooks/usePosDb';
import type { ProductListItem } from '../../hooks/useProducts';

export type ProductCategorySelection = string | null | 'ALL';

interface CategoryGridProps {
  categories: Category[];
  products: ProductListItem[];
  language: string;
  t: (key: string) => string;
  canCreateProduct: boolean;
  canManageCategories: boolean;
  onOpenCategory: (categoryId: ProductCategorySelection) => void;
  onOpenSearch: () => void;
  onAddProduct: () => void;
  onAddByBarcode: () => void;
  onManageCategories: () => void;
}

type CategoryWithDisplayOrder = Category & { displayOrder?: number };

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

export function sortCategories(categories: Category[], language: string): Category[] {
  return [...categories].sort((a, b) => {
    const aOrder = a.sort_order ?? (a as CategoryWithDisplayOrder).displayOrder ?? 0;
    const bOrder = b.sort_order ?? (b as CategoryWithDisplayOrder).displayOrder ?? 0;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return resolveName(a, language).localeCompare(resolveName(b, language), language);
  });
}

function CategoryButton({
  label,
  count,
  icon,
  onClick,
}: {
  label: string;
  count: number;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[104px] w-full items-center gap-3 rounded-md border border-slate-200 bg-white p-4 text-left shadow-sm transition duration-150 hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 motion-reduce:transition-none"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="line-clamp-2 text-sm font-semibold text-slate-950">{label}</span>
        <span className="mt-1 block text-sm tabular-nums text-slate-500">{count}</span>
      </span>
    </button>
  );
}

export default function CategoryGrid({
  categories,
  products,
  language,
  t,
  canCreateProduct,
  canManageCategories,
  onOpenCategory,
  onOpenSearch,
  onAddProduct,
  onAddByBarcode,
  onManageCategories,
}: CategoryGridProps) {
  const sortedCategories = useMemo(() => sortCategories(categories, language), [categories, language]);
  const productCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const product of products) {
      if (!product.category_id) continue;
      counts.set(product.category_id, (counts.get(product.category_id) || 0) + 1);
    }
    return counts;
  }, [products]);
  const uncategorisedCount = products.filter((product) => product.category_id == null).length;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div>
          <h2 className="text-base font-semibold text-slate-950">
            {tOr(t, 'products.categories', 'Categories')}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {products.length} {tOr(t, 'products.count.catalog', 'POS products')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onOpenSearch}
            className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <Search size={18} />
            {tOr(t, 'products.search', 'Search')}
          </button>
          <button
            type="button"
            onClick={onAddByBarcode}
            className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <ScanBarcode size={18} />
            {tOr(t, 'products.scanBarcode', 'Scan barcode')}
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
          {canManageCategories ? (
            <button
              type="button"
              onClick={onManageCategories}
              className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              <Tags size={18} />
              {tOr(t, 'products.category.manage', 'Manage categories')}
            </button>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
          <CategoryButton
            label={tOr(t, 'products.allCategories', 'All products')}
            count={products.length}
            icon={<Grid3X3 size={22} />}
            onClick={() => onOpenCategory('ALL')}
          />
          <CategoryButton
            label={tOr(t, 'products.uncategorised', 'Uncategorised')}
            count={uncategorisedCount}
            icon={<FolderX size={22} />}
            onClick={() => onOpenCategory(null)}
          />
          {sortedCategories.map((category) => (
            <CategoryButton
              key={category.id}
              label={resolveName(category, language)}
              count={productCounts.get(category.id) || 0}
              icon={<Folder size={22} />}
              onClick={() => onOpenCategory(category.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
