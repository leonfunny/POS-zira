import React from 'react';
import type { ProductListItem } from '../../hooks/useProducts';

interface ProductStatusBadgeProps {
  product: ProductListItem;
  t: (key: string) => string;
}

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

export default function ProductStatusBadge({ product, t }: ProductStatusBadgeProps) {
  const stock = product.available_qty ?? product.in_stock ?? 0;
  const price = Number(product.retail_price) || 0;

  if (product._isDraft) {
    return (
      <span className="inline-flex rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-xs font-semibold text-violet-700">
        {tOr(t, 'products.status.draft', 'Draft')}
      </span>
    );
  }

  if (price <= 0) {
    return (
      <span className="inline-flex rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700">
        {tOr(t, 'products.status.noPrice', 'No price')}
      </span>
    );
  }

  if (stock <= 0) {
    return (
      <span className="inline-flex rounded-md border border-slate-300 bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
        {tOr(t, 'products.status.outOfStock', 'Out of stock')}
      </span>
    );
  }

  if (stock <= 5) {
    return (
      <span className="inline-flex rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">
        {tOr(t, 'products.status.lowStock', 'Low stock')}
      </span>
    );
  }

  return (
    <span className="inline-flex rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
      {tOr(t, 'products.status.active', 'Active')}
    </span>
  );
}
