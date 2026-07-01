import React from 'react';

type OrderType = 'dine_in' | 'takeout' | 'delivery';

interface DiningOptionsProps {
  orderType: OrderType;
  onChange: (type: OrderType) => void;
  t: (key: string) => string;
}

const OPTIONS: { value: OrderType; key: string }[] = [
  { value: 'dine_in', key: 'pos.restaurant.dineIn' },
  { value: 'takeout', key: 'pos.restaurant.takeout' },
  { value: 'delivery', key: 'pos.restaurant.delivery' },
];

export default function DiningOptions({ orderType, onChange, t }: DiningOptionsProps) {
  return (
    <div className="p-2 border-t border-slate-700">
      <div className="flex gap-1">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`
              flex-1 px-1 py-1 text-xs rounded transition-colors
              ${orderType === opt.value
                ? 'bg-brand-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }
            `}
          >
            {t(opt.key)}
          </button>
        ))}
      </div>
    </div>
  );
}
