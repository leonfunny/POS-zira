import React from 'react';
import { resolveName } from '../../../shared/catalog-names';
import type { ProductListItem } from '../../hooks/useProducts';
import { stockColor, type StockColor } from './product-stock-color';

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

const stockStripClasses: Record<StockColor, string> = {
  red: 'bg-rose-500',
  amber: 'bg-amber-400',
  green: 'bg-emerald-500',
};

const stockBadgeClasses: Record<StockColor, string> = {
  red: 'border-rose-200 bg-rose-50 text-rose-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-700',
  green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
};

export default function ProductTile({ product, language, t, onSelect }: ProductTileProps) {
  const displayName = resolveName(product, language) || product.name;
  const price = Number(product.retail_price) || 0;
  const stock = Number(product.available_qty ?? product.in_stock) || 0;
  const currency = tOr(t, 'pos.currency', 'zl');
  const productCode = product.sku || product.barcode || '';
  const stockBand = stockColor(stock);

  return (
    <button
      type="button"
      onClick={() => onSelect(product)}
      className={`relative flex min-h-[96px] w-full flex-col justify-between overflow-hidden rounded-md border border-slate-200 bg-white text-slate-950 p-3 text-left shadow-sm transition duration-150 hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 motion-reduce:transition-none ${
        price <= 0 ? 'ring-2 ring-rose-300 ring-offset-2' : ''
      }`}
      title={displayName}
    >
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${stockStripClasses[stockBand]}`} />
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 pl-1">
          <span className="line-clamp-2 text-sm font-semibold leading-5 text-slate-950">{displayName}</span>
          {productCode ? (
            <span className="mt-1 block truncate text-xs font-medium text-slate-500">{productCode}</span>
          ) : null}
        </span>
        <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-bold tabular-nums ${stockBadgeClasses[stockBand]}`}>
          {stock}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
        <span className="pl-1 text-base font-bold tabular-nums text-slate-950">
          {(price / 100).toFixed(2)} {currency}
        </span>
        <span className="flex flex-wrap justify-end gap-1">
          {product._isDraft ? (
            <span className="rounded-md bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-700">
              {tOr(t, 'products.status.draft', 'Draft')}
            </span>
          ) : null}
          {product.is_active === 0 ? (
            <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">
              {tOr(t, 'products.status.inactive', 'Stopped')}
            </span>
          ) : null}
          {price <= 0 ? (
            <span className="rounded-md bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-700">
              {tOr(t, 'products.status.noPrice', 'No price')}
            </span>
          ) : null}
        </span>
      </div>
    </button>
  );
}
