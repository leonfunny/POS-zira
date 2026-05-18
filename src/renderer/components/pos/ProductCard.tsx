import React, { useState } from 'react';
import type { Product } from '../../hooks/usePosDb';
import { resolveName } from '../../../shared/catalog-names';

interface ProductCardProps {
  product: Product;
  onAdd: (product: Product) => void;
  t?: (key: string) => string;
  /** Operator UI language — drives display-name resolution. Canonical
   *  `product.name` is still used for placeholder-color stability and for
   *  persisted order/fiscal lines; paper receipts localize at print time. */
  lang?: string;
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

function ProductCard({ product, onAdd, t, lang }: ProductCardProps) {
  const [imgError, setImgError] = useState(false);
  const isService = product.category_id === 'cat-5';
  const isDraft = product._isDraft === true;
  const stockQty = product.available_qty ?? product.in_stock;
  // Drafts are click-to-import — stock is informational at best, so don't
  // gate the click or surface "Sold out" / "Low stock" chrome on them.
  const soldOut = !isDraft && !isService && stockQty <= 0;
  const lowStock = !isDraft && !isService && stockQty > 0 && stockQty <= 5;
  const currency = t?.('pos.currency') ?? 'zl';
  const pieces = t?.('pos.pieces') ?? 'pcs';
  // Placeholder color hashes canonical `name` so the same product keeps the
  // same tile color regardless of operator language.
  const colorClass = placeholderColor(product.name);
  const displayName = resolveName(product, lang);
  const imgSrc = product.thumbnail_url || product.image_url;
  const showImage = imgSrc && !imgError;
  const handleAdd = () => { if (!soldOut) onAdd(product); };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.key === 'Enter' || event.key === ' ') && !soldOut) {
      event.preventDefault();
      handleAdd();
    }
  };

  return (
    <div
      role="button"
      tabIndex={soldOut ? -1 : 0}
      onClick={handleAdd}
      onKeyDown={handleKeyDown}
      aria-label={soldOut ? `${displayName} — ${t?.('pos.product.soldOut') ?? 'Sold out'}` : `Add ${displayName}`}
      aria-disabled={soldOut || undefined}
      className={`group bg-white rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-100 transition-shadow duration-150 flex flex-col p-1.5 h-full min-h-[184px] select-none ${
        soldOut
          ? 'opacity-60 cursor-not-allowed'
          : 'hover:shadow-md cursor-pointer touch-manipulation'
      }`}
    >
      <div className="relative rounded-md overflow-hidden bg-slate-100 shrink-0 aspect-[3/2] w-full">
        {showImage ? (
          <img
            src={imgSrc!}
            alt={displayName}
            loading="lazy"
            onError={() => setImgError(true)}
            className={`w-full h-full object-cover ${soldOut ? 'grayscale' : ''}`}
          />
        ) : (
          <div className={`w-full h-full flex flex-col items-center justify-center gap-1 text-lg font-bold ${colorClass}`}>
            <svg className="w-5 h-5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20 7v10a2 2 0 01-2 2H6a2 2 0 01-2-2V7m16 0a2 2 0 00-2-2H6a2 2 0 00-2 2m16 0H4m5 4h6" />
            </svg>
            <span>{(displayName || product.name).charAt(0).toUpperCase()}</span>
          </div>
        )}
        {soldOut && (
          <div className="absolute inset-0 bg-white/60 flex items-center justify-center">
            <span className="text-[11px] text-red-700 bg-red-50 border border-red-300 px-3 py-1.5 rounded font-extrabold leading-none shadow-sm">
              {t?.('pos.product.soldOut') ?? 'Sold out'}
            </span>
          </div>
        )}
        {lowStock && (
          <span className="absolute top-2 left-2 text-[10px] text-amber-800 bg-amber-50 border border-amber-300 px-2 py-1 rounded font-bold leading-none shadow-sm">
            {stockQty} {pieces}
          </span>
        )}
        {product.is_on_sale === 1 && !soldOut && !isDraft && (
          <span className="absolute top-2 right-2 text-[10px] text-red-700 bg-red-50 border border-red-300 px-2 py-1 rounded font-bold leading-none shadow-sm">
            SALE
          </span>
        )}
        {isDraft && (
          <span className="absolute top-2 right-2 text-[10px] text-purple-700 bg-purple-50 border border-purple-300 px-2 py-1 rounded font-bold leading-none shadow-sm">
            DRAFT
          </span>
        )}
      </div>

      <div className="flex-1 pt-1.5 pb-1 flex flex-col">
        <p className="text-xs font-bold text-slate-900 leading-snug line-clamp-2">{displayName}</p>
      </div>

      <div className="flex items-end justify-between gap-2 shrink-0">
        <span className="text-sm font-extrabold text-slate-900 leading-tight tabular-nums min-w-0">
          {(product.retail_price / 100).toFixed(2)}&nbsp;{currency}
        </span>
        {!soldOut && (
          <span
            aria-hidden="true"
            className="w-11 h-11 bg-brand-600 group-hover:bg-brand-700 group-active:bg-brand-800 text-white rounded-md flex items-center justify-center shadow-sm transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 4v16m8-8H4" />
            </svg>
          </span>
        )}
      </div>
    </div>
  );
}

export default React.memo(ProductCard);
