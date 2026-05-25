import React from 'react';
import { Plus, RefreshCw, Search, SlidersHorizontal, Tags } from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import type { Category } from '../../hooks/usePosDb';
import type { ProductKindFilter } from '../../hooks/useProducts';

interface ProductToolbarProps {
  t: (key: string) => string;
  language: string;
  query: string;
  onQueryChange: (value: string) => void;
  categoryId: string;
  onCategoryChange: (value: string) => void;
  categories: Category[];
  kindFilter: ProductKindFilter;
  onKindFilterChange: (value: ProductKindFilter) => void;
  loading: boolean;
  syncing: boolean;
  canManageCategories: boolean;
  onRefresh: () => void;
  onSync: () => void;
  onAddProduct: () => void;
  onManageCategories: () => void;
}

const FILTERS: ProductKindFilter[] = ['all', 'lowStock', 'outOfStock', 'noPrice', 'drafts'];

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

export default function ProductToolbar({
  t,
  language,
  query,
  onQueryChange,
  categoryId,
  onCategoryChange,
  categories,
  kindFilter,
  onKindFilterChange,
  loading,
  syncing,
  canManageCategories,
  onRefresh,
  onSync,
  onAddProduct,
  onManageCategories,
}: ProductToolbarProps) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={tOr(t, 'products.searchPlaceholder', 'Search by name, barcode, or SKU...')}
            className="h-11 w-full rounded-md border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-900 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </div>

        <label className="sr-only" htmlFor="products-category-filter">
          {tOr(t, 'products.filters.category', 'Category')}
        </label>
        <select
          id="products-category-filter"
          value={categoryId}
          onChange={(event) => onCategoryChange(event.target.value)}
          className="h-11 min-w-[190px] rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        >
          <option value="">{tOr(t, 'products.allCategories', 'All categories')}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {resolveName(category, language)}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={onAddProduct}
          className="inline-flex h-11 items-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700 active:bg-brand-800"
        >
          <Plus size={18} />
          {tOr(t, 'products.addProduct', 'Add product')}
        </button>

        <button
          type="button"
          onClick={onManageCategories}
          disabled={!canManageCategories}
          className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          title={!canManageCategories ? tOr(t, 'products.category.unavailable', 'Category management needs product admin backend support') : undefined}
        >
          <Tags size={17} />
          {tOr(t, 'products.category.manage', 'Categories')}
        </button>

        <button
          type="button"
          onClick={onSync}
          disabled={syncing}
          className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          title={tOr(t, 'products.syncTitle', 'Sync catalog from backend')}
        >
          <RefreshCw size={17} className={syncing ? 'animate-spin' : ''} />
          {syncing ? tOr(t, 'products.syncing', 'Syncing...') : tOr(t, 'products.sync', 'Sync')}
        </button>

        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          title={tOr(t, 'products.refreshLocal', 'Reload local catalog')}
          aria-label={tOr(t, 'products.refreshLocal', 'Reload local catalog')}
        >
          <RefreshCw size={17} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-2 text-xs font-medium uppercase text-slate-500">
          <SlidersHorizontal size={14} />
          {tOr(t, 'products.col.status', 'Status')}
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => {
            const active = kindFilter === filter;
            return (
              <button
                key={filter}
                type="button"
                onClick={() => onKindFilterChange(filter)}
                className={`min-h-10 rounded-md border px-3 text-sm font-medium transition ${
                  active
                    ? 'border-brand-600 bg-brand-50 text-brand-700'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                }`}
              >
                {tOr(t, `products.filters.${filter}`, filter)}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
