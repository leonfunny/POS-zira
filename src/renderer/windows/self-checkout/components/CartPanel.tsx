import React from 'react';
import {
  Image as ImageIcon,
  Minus,
  PackageSearch,
  Plus,
  ShoppingCart,
  Trash2,
} from 'lucide-react';
import { resolveName } from '../../../../shared/catalog-names';
import type { ScLanguage } from '../i18n';
import { getScStrings } from '../i18n';
import {
  type ScCartItem,
  formatPLN,
} from '../useScCart';

interface CartPanelProps {
  lang: ScLanguage;
  items: ScCartItem[];
  totalGrosze: number;
  freshVariantId: string | null;
  totalTickKey: number;
  onIncrement: (variantId: string) => void;
  onDecrement: (variantId: string) => void;
  onRemove: (variantId: string) => void;
  onCheckout: () => void;
}

export default function CartPanel({
  lang,
  items,
  totalGrosze,
  freshVariantId,
  totalTickKey,
  onIncrement,
  onDecrement,
  onRemove,
  onCheckout,
}: CartPanelProps) {
  const t = getScStrings(lang);
  const productCount = items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <aside className="sc-surface sc-cart-panel flex min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--sc-border)] px-4 py-3">
        <div className="flex items-center gap-3">
          <ShoppingCart size={24} className="text-[var(--sc-primary-deep)]" />
          <div>
            <div className="text-xl font-black text-[var(--sc-ink)]">
              {t.total}
            </div>
            <div className="text-sm font-semibold text-[var(--sc-muted)]">
              {productCount} {t.items}
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <PackageSearch size={64} className="mb-5 text-[var(--sc-border)]" />
            <div className="text-2xl font-black text-[var(--sc-ink)]">
              {t.emptyCart}
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--sc-border)]">
            {items.map((item) => {
              const isFresh = freshVariantId === item.variantId;
              const isLastOne = item.quantity === 1;
              return (
                <li
                  key={item.variantId}
                  className={`sc-cart-item px-4 py-3 ${isFresh ? 'sc-cart-item-fresh bg-emerald-50/60' : ''}`}
                >
                  <div className="flex items-start gap-3">
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt=""
                        className="h-14 w-14 shrink-0 rounded-xl object-cover"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-[var(--sc-surface-muted)] text-[var(--sc-muted)]">
                        <ImageIcon size={24} />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-lg font-black leading-snug text-[var(--sc-ink)]">
                        {resolveName(item, lang)}
                      </div>
                      <div className="mt-1 text-sm font-semibold text-[var(--sc-muted)]">
                        {formatPLN(item.price)}
                        {item.sku ? ` · ${item.sku}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemove(item.variantId)}
                      className="sc-focusable flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-[var(--sc-muted)] hover:bg-red-50 hover:text-[var(--sc-danger)]"
                      aria-label={t.remove}
                    >
                      <Trash2 size={22} />
                    </button>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onDecrement(item.variantId)}
                      className={`sc-focusable flex h-14 w-14 items-center justify-center rounded-xl border-2 font-black ${
                        isLastOne
                          ? 'border-red-200 bg-red-50 text-[var(--sc-danger)] hover:bg-red-100'
                          : 'border-[var(--sc-border)] bg-white hover:bg-[var(--sc-surface-muted)]'
                      }`}
                      aria-label={isLastOne ? t.remove : '-'}
                    >
                      {isLastOne ? <Trash2 size={20} /> : <Minus size={22} />}
                    </button>
                    <span className="sc-tabular min-w-[3ch] text-center text-2xl font-black">
                      {item.quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() => onIncrement(item.variantId)}
                      className="sc-focusable flex h-14 w-14 items-center justify-center rounded-xl border-2 border-[var(--sc-border)] bg-white font-black hover:bg-[var(--sc-surface-muted)]"
                      aria-label="+"
                    >
                      <Plus size={22} />
                    </button>
                    <span className="sc-tabular ml-auto text-lg font-black text-[var(--sc-ink)]">
                      {formatPLN(item.price * item.quantity)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="sc-cart-footer border-t border-[var(--sc-border)] bg-white p-4">
        <div className="mb-3 flex items-end justify-between gap-4">
          <span className="text-lg font-black uppercase tracking-wide text-[var(--sc-muted)]">
            {t.total}
          </span>
          <span
            key={totalTickKey}
            className="sc-tabular sc-total-tick text-6xl font-black text-[var(--sc-ink)] xl:text-7xl"
          >
            {formatPLN(totalGrosze)}
          </span>
        </div>
        <button
          type="button"
          onClick={onCheckout}
          disabled={productCount === 0}
          className="sc-action sc-action-success sc-cart-pay sc-focusable flex w-full items-center justify-center gap-3 text-2xl"
        >
          {t.pay}
        </button>
      </div>
    </aside>
  );
}
