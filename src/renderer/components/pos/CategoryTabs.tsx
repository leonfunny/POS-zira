import React from 'react';
import type { Category } from '../../hooks/usePosDb';
import { resolveName } from '../../../shared/catalog-names';

interface CategoryTabsProps {
  categories: Category[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  allLabel?: string;
  lang?: string;
}

export default function CategoryTabs({ categories, activeId, onSelect, allLabel, lang }: CategoryTabsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
      <button
        onClick={() => onSelect(null)}
        className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors shrink-0 cursor-pointer touch-manipulation ${
          activeId === null
            ? 'bg-brand-600 text-white shadow-sm'
            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
        }`}
      >
        {allLabel || 'All'}
      </button>
      {categories.map((cat) => (
        <button
          key={cat.id}
          onClick={() => onSelect(cat.id)}
          className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors shrink-0 cursor-pointer touch-manipulation ${
            activeId === cat.id
              ? 'text-white shadow-sm'
              : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
          }`}
          style={
            activeId === cat.id
              ? { backgroundColor: cat.color || '#f43f5e' }
              : undefined
          }
        >
          {resolveName(cat, lang)}
        </button>
      ))}
    </div>
  );
}
