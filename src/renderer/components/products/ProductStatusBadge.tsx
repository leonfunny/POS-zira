import React from 'react';
import { isStockTracked, productItemType } from '../../../shared/product-stock-tracking';
import type { ProductListItem } from '../../hooks/useProducts';
import { productStockDisplay } from './product-stock-display';

interface ProductStatusBadgeProps {
  product: ProductListItem;
  t: (key: string) => string;
}

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

export type ProductStatusKind =
  | 'draft'
  | 'inactive'
  | 'noPrice'
  | 'service'
  | 'notTracked'
  | 'oversold'
  | 'outOfStock'
  | 'lowStock'
  | 'active';

export function productStatusKind(product: ProductListItem): ProductStatusKind {
  if (product._isDraft) return 'draft';
  if (product.is_active === 0) return 'inactive';
  if ((Number(product.retail_price) || 0) <= 0) return 'noPrice';
  if (!isStockTracked(product)) {
    return productItemType(product) === 'service' ? 'service' : 'notTracked';
  }

  const stock = productStockDisplay(product);
  if (stock.physical < 0 || stock.available < 0) return 'oversold';
  if (stock.available <= 0) return 'outOfStock';
  if (stock.available <= 5) return 'lowStock';
  return 'active';
}

export default function ProductStatusBadge({ product, t }: ProductStatusBadgeProps) {
  const status = productStatusKind(product);

  if (status === 'draft') {
    return (
      <span className="inline-flex whitespace-nowrap rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-xs font-semibold text-violet-700">
        {tOr(t, 'products.status.draft', 'Draft')}
      </span>
    );
  }

  if (status === 'inactive') {
    return (
      <span className="inline-flex whitespace-nowrap rounded-md border border-slate-300 bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
        {tOr(t, 'products.status.inactive', 'Stopped')}
      </span>
    );
  }

  if (status === 'noPrice') {
    return (
      <span className="inline-flex whitespace-nowrap rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700">
        {tOr(t, 'products.status.noPrice', 'No price')}
      </span>
    );
  }

  if (status === 'service' || status === 'notTracked') {
    return (
      <span className="inline-flex whitespace-nowrap rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-600">
        {status === 'service'
          ? tOr(t, 'products.itemType.service', 'Service')
          : tOr(t, 'products.itemType.noStock', 'No stock')}
      </span>
    );
  }

  if (status === 'oversold') {
    return (
      <span className="inline-flex whitespace-nowrap rounded-md border border-rose-300 bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-800">
        {tOr(t, 'products.status.oversold', 'Negative stock')}
      </span>
    );
  }

  if (status === 'outOfStock') {
    return (
      <span className="inline-flex whitespace-nowrap rounded-md border border-slate-300 bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
        {tOr(t, 'products.status.outOfStock', 'Out of stock')}
      </span>
    );
  }

  if (status === 'lowStock') {
    return (
      <span className="inline-flex whitespace-nowrap rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">
        {tOr(t, 'products.status.lowStock', 'Low stock')}
      </span>
    );
  }

  return (
    <span className="inline-flex whitespace-nowrap rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
      {tOr(t, 'products.status.active', 'Active')}
    </span>
  );
}
