import React from 'react';

interface UpsellItem {
  id: string;
  name: string;
  price: number;
  imageUrl: string | null;
}

interface UpsellStripProps {
  items: UpsellItem[];
  currency: string;
  bundleTemplate: string;
  t: (key: string) => string;
  compact?: boolean;
}

function formatTemplate(template: string, price: string, name: string): string {
  return template.replace('{price}', price).replace('{name}', name);
}

export default function UpsellStrip({ items, currency, bundleTemplate, t, compact }: UpsellStripProps) {
  if (items.length === 0) return null;
  const priceText = (amount: number) => `${(amount / 100).toFixed(2)} ${currency}`;

  return (
    <div className={compact ? 'mt-4' : 'mt-8'}>
      <div className="text-lg text-slate-300 mb-2">{t('pos.customerUpsellTitle')}</div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="w-48 shrink-0 bg-slate-900/60 border border-white/10 rounded-lg p-3"
          >
            <div className="h-24 rounded-md overflow-hidden bg-slate-800 mb-2 flex items-center justify-center">
              {item.imageUrl ? (
                <img src={item.imageUrl} alt="" className="w-full h-full object-cover" draggable={false} />
              ) : (
                <div className="text-xs text-slate-500">{t('pos.noProducts')}</div>
              )}
            </div>
            <div className="text-sm font-medium text-slate-100 line-clamp-2">{item.name}</div>
            <div className="text-xs text-slate-400 mt-1">
              {formatTemplate(bundleTemplate, priceText(item.price), item.name)}
            </div>
            <div className="text-sm font-semibold mt-1">{priceText(item.price)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
