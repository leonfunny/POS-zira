import React from 'react';
import { resolveName } from '../../../../shared/catalog-names';
import type { CatalogCategory } from '../types';
import type { ScLanguage } from '../i18n';
import { getScStrings } from '../i18n';

interface CategoryChipsProps {
  lang: ScLanguage;
  categories: CatalogCategory[];
  activeCategoryId: string | null;
  onSelect: (categoryId: string | null) => void;
}

export default function CategoryChips({
  lang,
  categories,
  activeCategoryId,
  onSelect,
}: CategoryChipsProps) {
  const t = getScStrings(lang);
  const baseClass = 'sc-focusable shrink-0 rounded-2xl border-2 px-5 py-3 text-lg font-black';
  const activeClass = 'border-[var(--sc-primary)] bg-[var(--sc-primary-soft)] text-[var(--sc-primary-deep)]';
  const inactiveClass = 'border-[var(--sc-border)] bg-white text-[var(--sc-ink)]';

  return (
    <div className="scrollbar-hide mt-3 flex shrink-0 gap-2 overflow-x-auto pb-1">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`${baseClass} ${activeCategoryId === null ? activeClass : inactiveClass}`}
      >
        {t.allCategories}
      </button>
      {categories.map((category) => (
        <button
          key={category.id}
          type="button"
          onClick={() => onSelect(category.id)}
          className={`${baseClass} ${activeCategoryId === category.id ? activeClass : inactiveClass}`}
        >
          {resolveName(category, lang)}
        </button>
      ))}
    </div>
  );
}
