import React, { useState } from 'react';
import type { Product } from '../../hooks/usePosDb';

interface ProductCardProps {
  product: Product;
  onAdd: (product: Product) => void;
  t?: (key: string) => string;
}

const PLACEHOLDER_COLORS = [
  'bg-brand-50 text-brand-500',
  'bg-blue-50 text-blue-500',
  'bg-emerald-50 text-emerald-600',
  'bg-amber-50 text-amber-700',
  'bg-slate-100 text-slate-600',
  'bg-teal-50 text-teal-600',
];

function placeholderColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return PLACEHOLDER_COLORS[Math.abs(hash) % PLACEHOLDER_COLORS.length];
}

function ProductCard({ product, onAdd, t }: ProductCardProps) {
  const [imgError, setImgError] = useState(false);
  const isService = product.category_id === 'cat-5';
  const stockQty = product.available_qty ?? product.in_stock;
  const lowStock = !isService && stockQty <= 5;
  const currency = t?.('pos.currency') ?? 'zl';
  const pieces = t?.('pos.pieces') ?? 'pcs';
  const colorClass = placeholderColor(product.name);
  const imgSrc = product.thumbnail_url || product.image_url;
  const showImage = imgSrc && !imgError;

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm hover:border-slate-300 hover:shadow-md focus-within:ring-2 focus-within:ring-brand-100 transition-colors duration-150 flex flex-col p-2 h-full min-h-[190px]">
      <div className="relative rounded-md overflow-hidden bg-slate-100 shrink-0 aspect-[3/2] w-full border border-slate-100">
        {showImage ? (
          <img
            src={imgSrc!}
            alt={product.name}
            loading="lazy"
            onError={() => setImgError(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className={`w-full h-full flex flex-col items-center justify-center gap-1 text-lg font-bold ${colorClass}`}>
            <svg className="w-5 h-5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20 7v10a2 2 0 01-2 2H6a2 2 0 01-2-2V7m16 0a2 2 0 00-2-2H6a2 2 0 00-2 2m16 0H4m5 4h6" />
            </svg>
            <span>{product.name.charAt(0).toUpperCase()}</span>
          </div>
        )}
        {lowStock && (
          <span className="absolute top-2 left-2 text-[10px] text-amber-800 bg-amber-50 border border-amber-300 px-2 py-1 rounded font-bold leading-none shadow-sm">
            {stockQty} {pieces}
          </span>
        )}
        {product.is_on_sale === 1 && (
          <span className="absolute top-2 right-2 text-[10px] text-red-700 bg-red-50 border border-red-300 px-2 py-1 rounded font-bold leading-none shadow-sm">
            SALE
          </span>
        )}
      </div>

      <div className="flex-1 pt-2 pb-1 flex flex-col min-h-[54px]">
        <p className="text-xs font-bold text-slate-900 leading-snug line-clamp-2">{product.name}</p>
        {product.sku && (
          <p className="text-[10px] text-slate-500 mt-1 truncate tracking-wide">{product.sku}</p>
        )}
      </div>

      <div className="flex items-end justify-between gap-2 shrink-0">
        <span className="text-sm font-extrabold text-slate-900 leading-tight tabular-nums min-w-0">
          {(product.retail_price / 100).toFixed(2)}&nbsp;{currency}
        </span>
        <button
          onClick={() => onAdd(product)}
          aria-label={`Add ${product.name}`}
          className="w-11 h-11 bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white rounded-md flex items-center justify-center shadow-sm transition-colors cursor-pointer touch-manipulation shrink-0 focus:outline-none focus:ring-2 focus:ring-brand-200 focus:ring-offset-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default React.memo(ProductCard);
