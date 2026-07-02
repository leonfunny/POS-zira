import { useState } from 'react';
import { Check, RectangleHorizontal } from 'lucide-react';
import type { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { FLOOR_PLAN_CATEGORIES, FLOOR_PLAN_ASSETS, type FloorPlanAssetDef } from './floor-plan-assets';

export function AssetPickerGrid({
  selected,
  onSelect,
  language,
}: {
  selected: string | null; // asset key or null for plain rectangle
  onSelect: (key: string | null) => void;
  language?: Language;
}) {
  const { t } = useTranslation(language || 'en');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const filtered = activeCategory
    ? FLOOR_PLAN_ASSETS.filter((a) => a.category === activeCategory)
    : FLOOR_PLAN_ASSETS;

  return (
    <div className="space-y-3">
      {/* Category tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
        <button
          type="button"
          onClick={() => setActiveCategory(null)}
          className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
            activeCategory === null
              ? 'bg-brand-600 text-white'
              : 'bg-slate-100 hover:bg-slate-200 text-slate-500'
          }`}
        >
          {t('common.all') || 'All'}
        </button>
        {FLOOR_PLAN_CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            type="button"
            onClick={() => setActiveCategory(cat.key)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              activeCategory === cat.key
                ? 'bg-brand-600 text-white'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-500'
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-[300px] overflow-y-auto pr-1">
        {/* Plain Rectangle option */}
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`relative flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all hover:border-brand-400 ${
            selected === null
              ? 'border-brand-600 bg-brand-50'
              : 'border-slate-200 bg-white'
          }`}
        >
          {selected === null && (
            <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-brand-600 flex items-center justify-center">
              <Check className="w-2.5 h-2.5 text-white" />
            </span>
          )}
          <div className="w-full aspect-square flex items-center justify-center bg-slate-50 rounded">
            <RectangleHorizontal className="w-8 h-8 text-slate-400" />
          </div>
          <span className="text-[10px] text-slate-500 leading-tight text-center">
            {t('billiard.plainRectangle') || 'Plain Rectangle'}
          </span>
        </button>

        {filtered.map((asset) => (
          <AssetCard
            key={asset.key}
            asset={asset}
            isSelected={selected === asset.key}
            onSelect={() => onSelect(asset.key)}
          />
        ))}
      </div>
    </div>
  );
}

function AssetCard({
  asset,
  isSelected,
  onSelect,
}: {
  asset: FloorPlanAssetDef;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const [imgError, setImgError] = useState(false);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all hover:border-brand-400 ${
        isSelected
          ? 'border-brand-600 bg-brand-50'
          : 'border-slate-200 bg-white'
      }`}
    >
      {isSelected && (
        <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-brand-600 flex items-center justify-center">
          <Check className="w-2.5 h-2.5 text-white" />
        </span>
      )}
      <div className="w-full aspect-square flex items-center justify-center bg-slate-50/50 rounded overflow-hidden">
        {imgError ? (
          <RectangleHorizontal className="w-8 h-8 text-slate-300" />
        ) : (
          <img
            src={asset.url}
            alt={asset.name}
            className="w-full h-full object-contain"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        )}
      </div>
      <span className="text-[10px] text-slate-500 leading-tight text-center line-clamp-2">
        {asset.name}
      </span>
    </button>
  );
}
