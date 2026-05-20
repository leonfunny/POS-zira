import React from 'react';
import { Package } from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import type { Category } from '../../hooks/usePosDb';
import type { ProductListItem } from '../../hooks/useProducts';
import ProductStatusBadge from './ProductStatusBadge';

interface ProductTableProps {
  products: ProductListItem[];
  categoryById: Map<string, Category>;
  language: string;
  t: (key: string) => string;
  selectedId?: string | null;
  onSelect: (product: ProductListItem) => void;
}

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function formatMoney(amountGrosze: number, currency: string): string {
  return `${((Number(amountGrosze) || 0) / 100).toFixed(2)} ${currency}`;
}

function ProductThumb({ product, displayName }: { product: ProductListItem; displayName: string }) {
  const image = product.thumbnail_url || product.image_url;
  if (image) {
    return (
      <img
        src={image}
        alt={displayName}
        className="h-12 w-12 rounded-md border border-slate-200 bg-slate-100 object-cover"
        loading="lazy"
      />
    );
  }
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-md border border-slate-200 bg-slate-100 text-slate-500">
      <Package size={20} />
    </div>
  );
}

interface ProductRowProps {
  product: ProductListItem;
  categoryById: Map<string, Category>;
  language: string;
  currency: string;
  t: (key: string) => string;
  selected: boolean;
  onSelect: (product: ProductListItem) => void;
}

// React.memo prevents the renderer from re-walking ~1000 product rows on every
// click. Selection toggles only re-render the 2 rows whose `selected` flipped;
// `t` is intentionally excluded from comparison because `useTranslation`
// returns a new function each render but the dictionary it closes over is
// stable per language — pairing with `language` makes that safe.
const ProductRow = React.memo(function ProductRow({
  product,
  categoryById,
  language,
  currency,
  t,
  selected,
  onSelect,
}: ProductRowProps) {
  const displayName = resolveName(product, language) || product.name;
  const category = product.category_id ? categoryById.get(product.category_id) : null;
  const categoryName = category ? resolveName(category, language) : '-';
  const stock = product.available_qty ?? product.in_stock ?? 0;

  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={() => onSelect(product)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(product);
        }
      }}
      className={`cursor-pointer outline-none transition hover:bg-slate-50 focus:bg-brand-50 ${
        selected ? 'bg-brand-50' : 'bg-white'
      }`}
    >
      <td className="border-b border-slate-100 px-4 py-3">
        <div className="flex min-h-[56px] items-center gap-3">
          <ProductThumb product={product} displayName={displayName} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-950">{displayName}</div>
            {product.name !== displayName ? (
              <div className="truncate text-xs text-slate-500">{product.name}</div>
            ) : null}
          </div>
        </div>
      </td>
      <td className="border-b border-slate-100 px-3 py-3 text-sm font-semibold tabular-nums text-slate-900">
        {formatMoney(product.retail_price, currency)}
      </td>
      <td className="border-b border-slate-100 px-3 py-3 text-sm tabular-nums text-slate-700">
        {stock}
      </td>
      <td className="border-b border-slate-100 px-3 py-3 text-sm text-slate-700">
        <span className="line-clamp-2">{categoryName}</span>
      </td>
      <td className="border-b border-slate-100 px-3 py-3 text-xs text-slate-600">
        <div className="truncate font-mono">{product.barcode || '-'}</div>
        <div className="truncate font-mono text-slate-400">{product.sku || '-'}</div>
      </td>
      <td className="border-b border-slate-100 px-3 py-3">
        <ProductStatusBadge product={product} t={t} />
      </td>
    </tr>
  );
}, (prev, next) => (
  prev.product === next.product
  && prev.categoryById === next.categoryById
  && prev.language === next.language
  && prev.currency === next.currency
  && prev.selected === next.selected
  && prev.onSelect === next.onSelect
));

export default function ProductTable({
  products,
  categoryById,
  language,
  t,
  selectedId,
  onSelect,
}: ProductTableProps) {
  const currency = tOr(t, 'pos.currency', 'zl');

  return (
    <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="h-full overflow-auto">
        <table className="min-w-full table-fixed border-separate border-spacing-0">
          <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
            <tr>
              <th className="w-[34%] border-b border-slate-200 px-4 py-3">{tOr(t, 'products.col.product', 'Product')}</th>
              <th className="w-[12%] border-b border-slate-200 px-3 py-3">{tOr(t, 'products.col.price', 'Price')}</th>
              <th className="w-[10%] border-b border-slate-200 px-3 py-3">{tOr(t, 'products.col.stock', 'Stock')}</th>
              <th className="w-[16%] border-b border-slate-200 px-3 py-3">{tOr(t, 'products.col.category', 'Category')}</th>
              <th className="w-[18%] border-b border-slate-200 px-3 py-3">{tOr(t, 'products.col.code', 'Barcode / SKU')}</th>
              <th className="w-[10%] border-b border-slate-200 px-3 py-3">{tOr(t, 'products.col.status', 'Status')}</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                categoryById={categoryById}
                language={language}
                currency={currency}
                t={t}
                selected={selectedId === product.id}
                onSelect={onSelect}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
