import React from 'react';
import type { CartState } from '../../../hooks/usePosStore';

interface UpsellItem {
  id: string;
  name: string;
  price: number;
  imageUrl?: string;
  description?: string;
}

interface CartViewProps {
  cart: CartState;
  t: (key: string) => string;
  upsellItems?: UpsellItem[];
  onRequestService?: (serviceId: string) => void;
}

export default function CartView({ cart, t, upsellItems, onRequestService }: CartViewProps) {
  if (cart.items.length === 0) return null;

  const tOr = (key: string, fallback: string) => {
    const value = t(key);
    return value !== key ? value : fallback;
  };
  const hasUpsell = upsellItems && upsellItems.length > 0;

  return (
    <div className="w-full max-w-2xl px-8">
      <p className="text-xs font-semibold uppercase tracking-[0.25em] text-brand-500 mb-5">
        {tOr('customer.yourOrder', 'Your order')}
      </p>
      <div className="space-y-3">
        {cart.items.map((item) => (
          <div
            key={item.id}
            className="flex justify-between items-baseline text-2xl animate-fadeIn border-b border-slate-100 pb-3"
          >
            <span className="text-slate-800">
              {item.name}
              {item.quantity > 1 && (
                <span className="text-slate-400 ml-2 text-xl">x{item.quantity}</span>
              )}
              {item.staffName && (
                <span className="text-slate-400 text-sm ml-2">({item.staffName})</span>
              )}
            </span>
            <span className="text-right tabular-nums font-semibold text-slate-900">
              {(item.lineDiscount ?? 0) > 0 && (
                <span className="mr-2 text-base text-slate-400 line-through">
                  {new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(item.total / 100)}
                </span>
              )}
              {new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format((item.total - (item.lineDiscount ?? 0)) / 100)}
            </span>
          </div>
        ))}
      </div>
      {cart.discount > 0 && (
        <div className="flex justify-between text-xl text-emerald-600 mt-4 font-medium">
          <span>{t('customer.discount')}</span>
          <span className="tabular-nums">-{new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(cart.discount / 100)}</span>
        </div>
      )}
      <div className="mt-8 pt-6 border-t-2 border-brand-100 text-right">
        <p className="text-sm text-slate-500 mb-2 uppercase tracking-wider font-medium">{t('customer.toPay')}</p>
        <span className="text-6xl font-bold text-brand-600 tabular-nums">
          {new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(cart.total / 100)}
        </span>
      </div>

      {/* Upsell strip */}
      {hasUpsell && (
        <div className="mt-10 border-t border-slate-100 pt-6">
          <p className="text-lg text-slate-600 mb-4 font-medium">
            {tOr('customer.completeYourLook', 'Complete your look')}
          </p>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {upsellItems!.map((item) => (
              <div
                key={item.id}
                className="w-44 shrink-0 bg-white border border-slate-200 rounded-xl p-3 shadow-sm"
              >
                <div className="h-20 rounded-lg overflow-hidden bg-slate-50 mb-2 flex items-center justify-center text-slate-300">
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt="" className="w-full h-full object-cover" draggable={false} />
                  ) : (
                    <svg className="h-10 w-10" viewBox="0 0 48 48" fill="none" aria-hidden="true">
                      <rect x="8" y="8" width="32" height="32" rx="6" stroke="currentColor" strokeWidth="2" />
                      <path d="M16 32l7-7 5 5 4-4 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      <circle cx="21" cy="19" r="2.5" stroke="currentColor" strokeWidth="2" />
                    </svg>
                  )}
                </div>
                <div className="text-sm font-medium text-slate-800 line-clamp-2">{item.name}</div>
                <div className="text-sm font-semibold mt-1 text-brand-600">
                  {new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(item.price / 100)}
                </div>
                {onRequestService && (
                  <button
                    onClick={() => onRequestService(item.id)}
                    className="mt-2 w-full py-1.5 text-xs bg-brand-500 hover:bg-brand-600 text-white rounded-lg transition-colors font-medium"
                  >
                    {tOr('customer.addToVisit', 'Add to my visit')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
