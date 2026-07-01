import React from 'react';

interface QuickKeyItem {
  id: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'neutral' | 'danger';
}

interface QuickKeysProps {
  items: QuickKeyItem[];
  columns?: 2 | 3 | 4;
}

export default function QuickKeys({ items, columns = 3 }: QuickKeysProps) {
  if (items.length === 0) return null;

  const gridCols = columns === 4
    ? 'grid-cols-4'
    : columns === 2
      ? 'grid-cols-2'
      : 'grid-cols-3';

  return (
    <div className={`grid ${gridCols} gap-2`}>
      {items.map((item) => (
        (() => {
          const variant = item.variant ?? 'neutral';
          const variantClass = variant === 'primary'
            ? 'bg-brand-600/20 text-brand-200 border-brand-500/40 hover:bg-brand-600/30'
            : variant === 'danger'
              ? 'bg-red-900/30 text-red-200 border-red-700/50 hover:bg-red-900/50'
              : 'bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700';

          return (
        <button
          key={item.id}
          onClick={item.onClick}
          disabled={item.disabled}
          className={`min-h-[36px] px-2.5 py-2 text-[11px] leading-tight rounded-lg border font-medium transition-colors ${
            item.disabled
              ? 'bg-slate-800/50 text-slate-500 border-slate-700 cursor-not-allowed'
              : `${variantClass} hover:border-slate-600`
          }`}
        >
          {item.label}
        </button>
          );
        })()
      ))}
    </div>
  );
}
