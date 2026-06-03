import React from 'react';
import {
  Hand,
  Loader2,
  PackageSearch,
  Search,
} from 'lucide-react';
import type {
  CatalogCategory,
  CatalogDepartment,
  SearchProduct,
} from '../types';
import type { ScLanguage } from '../i18n';
import { getScStrings } from '../i18n';
import CategoryChips from './CategoryChips';
import DepartmentTabs from './DepartmentTabs';
import ProductTile from './ProductTile';
import KioskCategoryGallery from './KioskCategoryGallery';

interface KioskMenuPanelProps {
  lang: ScLanguage;
  activeDepartment: CatalogDepartment;
  activeCategoryId: string | null;
  categories: CatalogCategory[];
  products: SearchProduct[];
  catalogLoading: boolean;
  allowOversell?: boolean;
  showDepartmentTabs?: boolean;
  onDepartmentChange: (department: CatalogDepartment) => void;
  onCategorySelect: (categoryId: string | null) => void;
  onAddProduct: (product: SearchProduct) => void;
  onOpenSearch: () => void;
  onCallStaff: () => void;
}

export default function KioskMenuPanel({
  lang,
  activeDepartment,
  activeCategoryId,
  categories,
  products,
  catalogLoading,
  allowOversell = false,
  showDepartmentTabs = true,
  onDepartmentChange,
  onCategorySelect,
  onAddProduct,
  onOpenSearch,
  onCallStaff,
}: KioskMenuPanelProps) {
  const t = getScStrings(lang);

  return (
    <div className="sc-surface sc-category-panel flex min-h-0 flex-1 flex-col overflow-hidden p-4">
      {showDepartmentTabs && (
        <DepartmentTabs
          lang={lang}
          activeDepartment={activeDepartment}
          onChange={onDepartmentChange}
        />
      )}

      <CategoryChips
        lang={lang}
        categories={categories}
        activeCategoryId={activeCategoryId}
        onSelect={onCategorySelect}
      />

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
        {catalogLoading ? (
          <div className="flex h-full min-h-[180px] flex-col items-center justify-center rounded-2xl border border-[var(--sc-border)] bg-[var(--sc-surface-muted)] px-8 text-center">
            <Loader2 size={58} className="mb-4 animate-spin text-[var(--sc-primary-deep)]" />
            <div className="text-xl font-black text-[var(--sc-ink)]">
              {t.catalogLoading}
            </div>
          </div>
        ) : activeCategoryId === null && categories.length > 0 ? (
          <KioskCategoryGallery
            lang={lang}
            categories={categories}
            onSelect={onCategorySelect}
          />
        ) : products.length === 0 ? (
          <div className="flex h-full min-h-[180px] flex-col items-center justify-center rounded-2xl border border-[var(--sc-border)] bg-[var(--sc-surface-muted)] px-8 text-center">
            <PackageSearch size={58} className="mb-4 text-[var(--sc-border)]" />
            <div className="text-xl font-black text-[var(--sc-ink)]">
              {t.noCategories}
            </div>
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={onOpenSearch}
                className="sc-secondary-action sc-focusable flex items-center gap-2 px-5 text-base"
              >
                <Search size={20} />
                {t.manualSearch}
              </button>
              <button
                type="button"
                onClick={onCallStaff}
                className="sc-secondary-action sc-focusable flex items-center gap-2 px-5 text-base text-amber-800"
              >
                <Hand size={20} />
                {t.callStaff}
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {products.map((product) => (
              <ProductTile
                key={product.id}
                lang={lang}
                product={product}
                allowOversell={allowOversell}
                onAdd={onAddProduct}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
