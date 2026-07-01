import React, { useRef, useEffect } from 'react';
import { SearchX } from 'lucide-react';
import type { Product } from '../../hooks/usePosDb';
import Button from '../shared/Button';
import ProductCard, { type ProductLongPressResult } from './ProductCard';

interface ProductGridProps {
  products: Product[];
  onAddProduct: (product: Product) => void;
  onLongPressProduct?: (product: Product) => void | ProductLongPressResult | Promise<void | ProductLongPressResult>;
  t?: (key: string) => string;
  allowOversell?: boolean;
  /** When this value changes (e.g. activeCategoryId), scroll resets to top */
  resetScrollKey?: string | null;
  /** Operator UI language — forwarded to ProductCard for display-only localization. */
  lang?: string;
  loading?: boolean;
  emptySearchQuery?: string;
  onClearSearch?: () => void;
}

function formatTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

function ProductGridSkeleton() {
  return (
    <div className="grid [grid-template-columns:repeat(auto-fill,minmax(154px,1fr))] 2xl:[grid-template-columns:repeat(auto-fill,minmax(172px,1fr))] gap-2 p-1 pb-2">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="bg-white rounded-lg p-1.5 h-full min-h-[196px] flex flex-col animate-pulse">
          <div className="rounded-md bg-slate-200 shrink-0 aspect-[3/2] w-full" />
          <div className="flex flex-1 flex-col gap-2 px-1 pt-3 pb-1">
            <div className="h-4 w-full rounded bg-slate-200" />
            <div className="h-4 w-3/4 rounded bg-slate-100" />
            <div className="mt-auto flex items-center justify-between gap-2 pt-2">
              <div className="h-6 w-20 rounded bg-slate-200" />
              <div className="h-5 w-12 rounded bg-slate-100" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ProductGrid({ products, onAddProduct, onLongPressProduct, t, allowOversell = false, resetScrollKey, lang, loading = false, emptySearchQuery, onClearSearch }: ProductGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tOr = (key: string, fallback: string) => {
    const value = t?.(key);
    return value && value !== key ? value : fallback;
  };
  const trimmedSearchQuery = emptySearchQuery?.trim() ?? '';

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetScrollKey]);

  if (loading) {
    return (
      <div ref={scrollRef} className="flex-1 overflow-y-auto" aria-busy="true" aria-label="Loading products">
        <ProductGridSkeleton />
      </div>
    );
  }

  if (products.length === 0 && trimmedSearchQuery) {
    const message = formatTemplate(
      tOr('pos.search.noResults', 'No products match "{query}"'),
      { query: trimmedSearchQuery },
    );

    return (
      <div className="flex-1 flex items-center justify-center text-slate-500 bg-white border border-slate-200 rounded-lg">
        <div className="text-center px-6 max-w-sm">
          <SearchX className="w-12 h-12 mx-auto mb-3 text-slate-300" aria-hidden="true" />
          <p className="text-sm font-medium text-slate-600">{message}</p>
          {onClearSearch && (
            <Button onClick={onClearSearch} className="mt-4">
              {tOr('pos.search.clear', 'Clear search')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500 bg-white border border-slate-200 rounded-lg">
        <div className="text-center px-6">
          <svg className="w-12 h-12 mx-auto mb-3 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
          </svg>
          <p className="text-sm font-medium text-slate-500">{t?.('pos.noProducts') ?? 'No products found'}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="grid [grid-template-columns:repeat(auto-fill,minmax(154px,1fr))] 2xl:[grid-template-columns:repeat(auto-fill,minmax(172px,1fr))] gap-2 p-1 pb-2">
        {products.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            onAdd={onAddProduct}
            onLongPress={onLongPressProduct}
            t={t}
            allowOversell={allowOversell}
            lang={lang}
          />
        ))}
      </div>
    </div>
  );
}
