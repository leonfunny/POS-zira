import React, { useEffect, useMemo, useRef } from 'react';
import { LayoutGrid, SearchX, UtensilsCrossed } from 'lucide-react';
import type { Category, Product } from '../../../../hooks/usePosDb';
import { resolveName } from '../../../../../shared/catalog-names';
import ProductCard from '../../ProductCard';

// Muted category bands, paired with off-white text. Identity is independent
// of the active filter and of the operator's language.
const CATEGORY_COLORS = ['#345d59', '#626035', '#805622', '#7d4541', '#514b70', '#365d72'];
export function restaurantCategoryColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  return CATEGORY_COLORS[hash % CATEGORY_COLORS.length];
}

export function groupRestaurantProducts(products: Product[], categories: Category[]) {
  const byCategory = new Map<string | null, Product[]>();
  const known = new Set(categories.map(category => category.id));
  for (const product of products) {
    const key = product.category_id && known.has(product.category_id) ? product.category_id : null;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(product);
  }
  const groups: { category: Category | null; products: Product[] }[] = [];
  for (const category of categories) {
    const items = byCategory.get(category.id);
    if (items?.length) groups.push({ category, products: items });
  }
  const other = byCategory.get(null);
  if (other?.length) groups.push({ category: null, products: other });
  return groups;
}

interface CategoryRailProps {
  categories: Category[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  lang: string;
  t: (key: string) => string;
}

export function RestaurantCategoryRail({ categories, activeId, onSelect, lang, t }: CategoryRailProps) {
  return (
    <nav className="restaurant-categories" aria-label={t('pos.categories.title')}>
      <div className="restaurant-rail-heading"><UtensilsCrossed size={17} aria-hidden="true" />{t('pos.categories.title')}</div>
      <div className="restaurant-category-list">
        <button type="button" className="restaurant-category" aria-pressed={activeId === null} onClick={() => onSelect(null)}>
          <LayoutGrid size={17} aria-hidden="true" /><span>{t('pos.allCategories')}</span>
        </button>
        {categories.map(category => (
          <button type="button" key={category.id} className="restaurant-category" title={resolveName(category, lang)}
            aria-pressed={activeId === category.id} onClick={() => onSelect(category.id)}>
            <span className="restaurant-category-dot" style={{ backgroundColor: restaurantCategoryColor(category.id) }} aria-hidden="true" />
            <span>{resolveName(category, lang)}</span>
          </button>
        ))}
      </div>
      <div className="restaurant-rail-footer">ZIRA <span>POS</span></div>
    </nav>
  );
}

interface RestaurantMenuProps {
  products: Product[];
  categories: Category[];
  loading: boolean;
  error: string | null;
  searchQuery: string;
  resetScrollKey: string;
  onRetry: () => void;
  onClearSearch: () => void;
  onAddProduct: (product: Product) => void;
  lang: string;
  t: (key: string) => string;
}

export default function RestaurantMenu({ products, categories, loading, error, searchQuery, resetScrollKey, onRetry, onClearSearch, onAddProduct, lang, t }: RestaurantMenuProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupRestaurantProducts(products, categories), [products, categories]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [resetScrollKey]);
  return (
    <div className="restaurant-menu-scroll" ref={scrollRef} aria-busy={loading}>
      {error ? (
        <div className="restaurant-empty" role="alert">
          <UtensilsCrossed size={36} aria-hidden="true" />
          <h2>{t('pos.restaurant.catalogError')}</h2><p>{error}</p>
          <button type="button" className="restaurant-action" onClick={onRetry}>{t('common.retry')}</button>
        </div>
      ) : loading ? (
        <div className="restaurant-menu-grid" role="status" aria-label={t('common.loading')}>
          {Array.from({ length: 12 }, (_, index) => <div className="restaurant-skeleton" key={index} />)}
        </div>
      ) : groups.length === 0 ? (
        <div className="restaurant-empty" role="status">
          <SearchX size={36} aria-hidden="true" />
          <h2>{searchQuery.trim() ? t('pos.restaurant.noSearchResults').replace('{query}', searchQuery.trim()) : t('pos.noProducts')}</h2>
          <p>{t('pos.restaurant.tryAnotherCategory')}</p>
          <button type="button" className="restaurant-action" onClick={onClearSearch}>{t('pos.allCategories')}</button>
        </div>
      ) : groups.map(({ category, products: items }) => (
        <section className="restaurant-menu-section" key={category?.id ?? '__uncategorized'}>
          <h2><span className="restaurant-category-dot" style={{ backgroundColor: restaurantCategoryColor(category?.id ?? '') }} aria-hidden="true" />
            {category ? resolveName(category, lang) : t('pos.restaurant.otherMenu')}
            <span className="restaurant-section-count">{items.length}</span>
          </h2>
          <div className="restaurant-menu-grid">
            {items.map(product => <ProductCard key={product.id} product={product} onAdd={onAddProduct}
              t={t} lang={lang} restaurantColor={restaurantCategoryColor(category?.id ?? '')} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
