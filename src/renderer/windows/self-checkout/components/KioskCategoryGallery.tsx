import React from 'react';
import { resolveName } from '../../../../shared/catalog-names';
import {
  sortCategoriesByRank,
  categoryImageUrl,
} from '../../../components/pos/templates/retail/retailBrowseFilters';
import type { CatalogCategory } from '../types';
import type { ScLanguage } from '../i18n';

interface KioskCategoryGalleryProps {
  lang: ScLanguage;
  categories: CatalogCategory[];
  onSelect: (categoryId: string) => void;
}

/**
 * Customer-facing landing: big image-first category tiles. Shown when no
 * category is picked yet. Categories follow the same owner-configured priority
 * order as the cashier POS (fresh, must-tap groups first) but are rendered
 * larger and with minimal text, since customers browse by picture and may not
 * read the operator language.
 */
export default function KioskCategoryGallery({
  lang,
  categories,
  onSelect,
}: KioskCategoryGalleryProps) {
  const ordered = sortCategoriesByRank(categories);
  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
      {ordered.map((cat) => {
        const img = categoryImageUrl(cat);
        const name = resolveName(cat, lang);
        const bg = cat.color || 'var(--sc-primary)';
        return (
          <button
            key={cat.id}
            type="button"
            onClick={() => onSelect(cat.id)}
            className="sc-focusable group flex flex-col overflow-hidden rounded-3xl border-2 border-[var(--sc-border)] bg-white text-left transition-transform active:scale-[0.98]"
          >
            <div className="relative aspect-[4/3] w-full overflow-hidden bg-[var(--sc-surface-muted)]">
              {img ? (
                <img
                  src={img}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-200 group-active:scale-[1.04]"
                />
              ) : (
                <div
                  className="flex h-full w-full items-center justify-center text-6xl font-black"
                  style={{ color: bg }}
                  aria-hidden="true"
                >
                  {name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <div className="px-4 py-3">
              <div className="truncate text-2xl font-black text-[var(--sc-ink)]">{name}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
