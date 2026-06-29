import React from 'react';
import { resolveName } from '../../../shared/catalog-names';
import type { ProductListItem } from '../../hooks/useProducts';
import { stockTileClasses } from './product-stock-color';

interface ProductTileProps {
  product: ProductListItem;
  language: string;
  t: (key: string) => string;
  onSelect: (product: ProductListItem) => void;
}

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

export default function ProductTile({ product, language, t, onSelect }: ProductTileProps) {
  const displayName = resolveName(product, language) || product.name;
  const price = Number(product.retail_price) || 0;
  const stock = Number(product.available_qty ?? product.in_stock) || 0;
  const currency = tOr(t, 'pos.currency', 'zl');

  return (
    <button
      type="button"
      onClick={() => onSelect(product)}
      className={`relative flex min-h-[96px] w-full flex-col justify-between overflow-hidden rounded-md border p-3 text-left shadow-sm transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 ${stockTileClasses(stock)} ${
        price <= 0 ? 'ring-2 ring-rose-900 ring-offset-2' : ''
      }`}
      title={displayName}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="line-clamp-2 text-sm font-semibold leading-5">{displayName}</span>
        <span className="shrink-0 rounded-md bg-white/90 px-2 py-1 text-xs font-bold tabular-nums text-slate-950">
          {stock}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
        <span className="text-base font-bold tabular-nums">
          {(price / 100).toFixed(2)} {currency}
        </span>
        <span className="flex flex-wrap justify-end gap-1">
          {product._isDraft ? (
            <span className="rounded-md bg-white/90 px-2 py-1 text-[11px] font-semibold text-violet-700">
              {tOr(t, 'products.status.draft', 'Draft')}
            </span>
          ) : null}
          {product.is_active === 0 ? (
            <span className="rounded-md bg-white/90 px-2 py-1 text-[11px] font-semibold text-slate-700">
              {tOr(t, 'products.status.inactive', 'Stopped')}
            </span>
          ) : null}
          {price <= 0 ? (
            <span className="rounded-md bg-white/90 px-2 py-1 text-[11px] font-semibold text-rose-700">
              {tOr(t, 'products.status.noPrice', 'No price')}
            </span>
          ) : null}
        </span>
      </div>
    </button>
  );
}
