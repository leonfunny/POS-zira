import { useState, useEffect, useRef } from 'react';
import { Loader2, ChevronLeft, Check, RectangleHorizontal } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import { Language } from '../../i18n/translations';
import { useToast } from './Toast';
import TextInput from '../shared/TextInput';
import { getNextName } from './utils';
import {
  FLOOR_PLAN_CATEGORIES,
  FLOOR_PLAN_ASSETS,
  type FloorPlanAssetDef,
} from './floor-plan-assets';

/* ------------------------------------------------------------------ */
/*  Inline AssetPickerGrid (adapted from web app)                     */
/* ------------------------------------------------------------------ */

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
      <div className="w-full aspect-square flex items-center justify-center bg-slate-50 rounded overflow-hidden">
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

function AssetPickerGrid({
  selected,
  onSelect,
  language,
}: {
  selected: string | null;
  onSelect: (key: string | null) => void;
  language: Language;
}) {
  const { t } = useTranslation(language);
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
              : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
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
                : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
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

/* ------------------------------------------------------------------ */
/*  AddTableDialog                                                    */
/* ------------------------------------------------------------------ */

export function AddTableDialog({
  open,
  onOpenChange,
  onAdd,
  isPending,
  existingNames,
  currentFloor,
  language,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdd: (name: string, basePrice: number, topViewImage?: string) => void;
  isPending: boolean;
  existingNames: string[];
  currentFloor: number;
  language: Language;
}) {
  const { t } = useTranslation(language);
  const toast = useToast();
  const [step, setStep] = useState<'asset' | 'details'>('asset');
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [price, setPrice] = useState(60);
  const prevOpenRef = useRef(false);

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setName(getNextName('', existingNames));
      setStep('asset');
      setSelectedAsset(null);
    }
    prevOpenRef.current = open;
  }, [open, existingNames]);

  const handleSubmit = () => {
    if (!name.trim()) { toast.error(t('billiard.nameRequired') || 'Name is required'); return; }
    onAdd(name.trim(), price, selectedAsset || undefined);
    setName('');
    setPrice(60);
    setSelectedAsset(null);
    setStep('asset');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSubmit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setName(getNextName(name, existingNames, 'up'));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setName(getNextName(name, existingNames, 'down'));
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onClick={() => onOpenChange(false)}
    >
      <div
        className={`bg-white rounded-xl shadow-xl ${step === 'asset' ? 'max-w-lg' : 'max-w-sm'} w-full mx-4 max-h-[85vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            {step === 'details' && (
              <button
                type="button"
                onClick={() => setStep('asset')}
                className="p-0.5 rounded hover:bg-slate-100"
                aria-label={t('common.back') || 'Back'}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            )}
            {step === 'asset'
              ? (t('billiard.chooseType') || 'Choose Type')
              : (t('billiard.addTable') || 'Add Table')}
            {currentFloor > 1 && (
              <span className="ml-2 text-sm font-normal text-slate-500">
                ({t('billiard.floor') || 'Floor'} {currentFloor})
              </span>
            )}
          </h3>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto flex-1">
          {step === 'asset' ? (
            <AssetPickerGrid
              selected={selectedAsset}
              onSelect={setSelectedAsset}
              language={language}
            />
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <TextInput
                  id="table-name"
                  label={t('billiard.tableName') || 'Name'}
                  labelClassName="text-sm font-medium text-slate-900"
                  placeholder="Table 1"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoFocus
                />
                <p className="text-xs text-slate-500">
                  {t('billiard.nameSuggestionHint') || 'Press up/down to adjust number'}
                </p>
              </div>
              <TextInput
                id="table-price"
                label={`${t('billiard.hourlyRate') || 'Hourly Rate'} (PLN/h)`}
                labelClassName="text-sm font-medium text-slate-900"
                type="number"
                min={0}
                value={price}
                onChange={(e) => setPrice(Number(e.target.value))}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            type="button"
            className="px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-300 hover:bg-slate-50"
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel') || 'Cancel'}
          </button>
          {step === 'asset' ? (
            <button
              type="button"
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center"
              onClick={() => setStep('details')}
            >
              {t('common.next') || 'Next'}
            </button>
          ) : (
            <button
              type="button"
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center"
              onClick={handleSubmit}
              disabled={isPending}
            >
              {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t('common.add') || 'Add'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
