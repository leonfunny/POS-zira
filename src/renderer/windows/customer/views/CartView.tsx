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

  const hasUpsell = upsellItems && upsellItems.length > 0;

  return (
    <div className="w-full max-w-2xl px-8">
      <div className="space-y-3">
        {cart.items.map((item) => (
          <div
            key={item.id}
            className="flex justify-between text-2xl animate-fadeIn"
          >
            <span className="text-slate-200">
              {item.name}
              {item.quantity > 1 && (
                <span className="text-slate-500 ml-2">x{item.quantity}</span>
              )}
              {item.staffName && (
                <span className="text-slate-500 text-sm ml-2">({item.staffName})</span>
              )}
            </span>
            <span className="font-mono tabular-nums">
              {new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(item.total / 100)}
            </span>
          </div>
        ))}
      </div>
      {cart.discount > 0 && (
        <div className="flex justify-between text-xl text-green-400 mt-4">
          <span>{t('customer.discount')}</span>
          <span>-{new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(cart.discount / 100)}</span>
        </div>
      )}
      <div className="border-t border-white/20 mt-6 pt-6 text-right">
        <p className="text-sm text-slate-500 mb-1">{t('customer.toPay')}</p>
        <span className="text-5xl font-bold">
          {new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(cart.total / 100)}
        </span>
      </div>

      {/* Upsell strip */}
      {hasUpsell && (
        <div className="mt-8 border-t border-white/10 pt-6">
          <p className="text-lg text-slate-300 mb-3">
            {t('customer.completeYourLook') || 'Complete your look'}
          </p>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {upsellItems!.map((item) => (
              <div
                key={item.id}
                className="w-44 shrink-0 bg-slate-900/60 border border-white/10 rounded-lg p-3"
              >
                <div className="h-20 rounded-md overflow-hidden bg-slate-800 mb-2 flex items-center justify-center">
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt="" className="w-full h-full object-cover" draggable={false} />
                  ) : (
                    <div className="text-3xl">💅</div>
                  )}
                </div>
                <div className="text-sm font-medium text-slate-100 line-clamp-2">{item.name}</div>
                <div className="text-sm font-semibold mt-1 text-purple-300">
                  {new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(item.price / 100)}
                </div>
                {onRequestService && (
                  <button
                    onClick={() => onRequestService(item.id)}
                    className="mt-2 w-full py-1.5 text-xs bg-purple-600/80 hover:bg-purple-500 text-white rounded transition-colors"
                  >
                    {t('customer.addToVisit') || 'Add to my visit'}
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
