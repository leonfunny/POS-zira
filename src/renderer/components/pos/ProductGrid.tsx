import React, { useRef, useEffect } from 'react';
import type { Product } from '../../hooks/usePosDb';
import ProductCard from './ProductCard';

interface ProductGridProps {
  products: Product[];
  onAddProduct: (product: Product) => void;
  t?: (key: string) => string;
  /** When this value changes (e.g. activeCategoryId), scroll resets to top */
  resetScrollKey?: string | null;
}

export default function ProductGrid({ products, onAddProduct, t, resetScrollKey }: ProductGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetScrollKey]);

  if (products.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
          </svg>
          <p className="text-sm text-gray-400">{t?.('pos.noProducts') ?? 'No products found'}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="grid grid-cols-3 gap-3 p-1">
        {products.map((product) => (
          <ProductCard key={product.id} product={product} onAdd={onAddProduct} t={t} />
        ))}
      </div>
    </div>
  );
}
