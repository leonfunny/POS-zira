import React from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { resolveName } from '../../../../shared/catalog-names';
import {
  getProductAvailability,
} from '../catalog-model';
import type { SearchProduct } from '../types';
import type { ScLanguage } from '../i18n';
import { getScStrings } from '../i18n';
import { formatPLN } from '../useScCart';

interface ProductTileProps {
  lang: ScLanguage;
  product: SearchProduct;
  allowOversell?: boolean;
  onAdd: (product: SearchProduct) => void;
}

export default function ProductTile({
  lang,
  product,
  allowOversell = false,
  onAdd,
}: ProductTileProps) {
  const t = getScStrings(lang);
  const availability = getProductAvailability(product, { allowOversell });
  const disabled = !availability.canAdd;
  const oversoldStock = allowOversell && typeof availability.stock === 'number' && availability.stock <= 0 && availability.reason !== 'no_price';
  const imageUrl = product.thumbnail_url || product.image_url || '';
  const disabledLabel =
    availability.reason === 'out_of_stock' ? t.soldOut :
    availability.reason === 'no_price' ? t.noPrice :
    availability.reason === 'weighted' ? t.weighedAtCounter :
    null;
  const oversoldLabel = oversoldStock
    ? t.oversoldStock.replace('{stock}', String(availability.stock))
    : null;

  return (
    <button
      type="button"
      onClick={() => onAdd(product)}
      disabled={disabled}
      className="sc-focusable flex min-h-[168px] flex-col overflow-hidden rounded-2xl border border-[var(--sc-border)] bg-white text-left disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-75"
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          className="h-20 w-full object-cover"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      ) : (
        <div className="flex h-20 w-full items-center justify-center bg-[var(--sc-surface-muted)] text-[var(--sc-muted)]">
          <ImageIcon size={30} />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <div className="line-clamp-2 text-base font-black leading-snug text-[var(--sc-ink)]">
          {resolveName(product, lang)}
        </div>
        <div className="mt-auto flex items-end justify-between gap-2 pt-2">
          <div className="sc-tabular text-lg font-black text-[var(--sc-primary-deep)]">
            {formatPLN(availability.priceGrosze)}
          </div>
          {disabledLabel && (
            <span className="rounded-full bg-red-50 px-2 py-1 text-xs font-black uppercase tracking-wide text-[var(--sc-danger)]">
              {disabledLabel}
            </span>
          )}
          {oversoldLabel && (
            <span className="rounded-full border border-red-200 bg-red-50 px-2 py-1 text-xs font-black uppercase tracking-wide text-[var(--sc-danger)]">
              {oversoldLabel}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
