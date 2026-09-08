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
    <div className="restaurant-dining-options">
      <div role="group" aria-label={t('pos.restaurant.orderType')}>
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            aria-pressed={orderType === opt.value}
            onClick={() => onChange(opt.value)}
            className="restaurant-dining-option"
          >
            {t(opt.key)}
          </button>
        ))}
      </div>
    </div>
  );
}
