import React from 'react';
import type { Product } from '../../hooks/usePosDb';

interface ProductCardProps {
  product: Product;
  onAdd: (product: Product) => void;
  t?: (key: string) => string;
}

const PLACEHOLDER_COLORS = [
  'bg-brand-50 text-brand-400',
  'bg-purple-50 text-purple-400',
  'bg-blue-50 text-blue-400',
  'bg-emerald-50 text-emerald-400',
  'bg-amber-50 text-amber-400',
  'bg-orange-50 text-orange-400',
  'bg-teal-50 text-teal-400',
  'bg-brand-50 text-brand-400',
];

function placeholderColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return PLACEHOLDER_COLORS[Math.abs(hash) % PLACEHOLDER_COLORS.length];
}

export default function ProductCard({ product, onAdd, t }: ProductCardProps) {
  const isService = product.category_id === 'cat-5';
  const lowStock = !isService && product.in_stock <= 5;
  const currency = t?.('pos.currency') ?? 'zł';
  const pieces = t?.('pos.pieces') ?? 'pcs';
  const colorClass = placeholderColor(product.name);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-all duration-200 flex flex-col p-2 h-full">

      {/* Top: inset image — fixed proportion, never grows */}
      <div className="relative rounded-xl overflow-hidden bg-slate-50 shrink-0 aspect-[4/3] w-full">
        {product.image_url ? (
          <img
            src={product.image_url}
            alt={product.name}
            loading="lazy"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className={`w-full h-full flex items-center justify-center text-xl font-bold ${colorClass}`}>
            {product.name.charAt(0).toUpperCase()}
          </div>
        )}
        {lowStock && (
          <span className="absolute top-1.5 left-1.5 text-[10px] text-amber-600 bg-white/90 border border-amber-200 px-1.5 py-0.5 rounded-full font-medium">
            {product.in_stock} {pieces}
          </span>
        )}
      </div>

      {/* Middle: name + SKU — flex-grow absorbs extra space */}
      <div className="flex-1 px-0.5 pt-2 pb-1 flex flex-col">
        <p className="text-[11px] font-semibold text-gray-800 leading-snug line-clamp-2">{product.name}</p>
        {product.sku && (
          <p className="text-[10px] text-gray-400 mt-0.5 truncate">{product.sku}</p>
        )}
      </div>

      {/* Bottom: price + "+" — always anchored, never shifts */}
      <div className="flex items-center justify-between px-0.5 shrink-0">
        <span className="text-sm font-bold text-brand-500 leading-none">
          {(product.retail_price / 100).toFixed(2)}&nbsp;{currency}
        </span>
        <button
          onClick={() => onAdd(product)}
          aria-label={`Add ${product.name}`}
          className="w-7 h-7 bg-brand-500 hover:bg-brand-600 active:bg-brand-700 text-white rounded-full flex items-center justify-center shadow-sm active:scale-95 transition-all cursor-pointer touch-manipulation shrink-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

    </div>
  );
}
