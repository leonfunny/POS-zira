import { Minus, Plus, ArrowLeftRight, ArrowUpDown } from 'lucide-react';
import { MIN_TABLE_PCT, MAX_TABLE_PCT, SIZE_STEP_M } from '../constants';
import type { Language } from '../../../i18n/translations';
import { useTranslation } from '../../../i18n/useTranslation';

interface MenuResizeControlsProps {
  tableId: string;
  widthPct: number;
  heightPct: number;
  roomWidthM: number;
  roomHeightM: number;
  onResize: (id: string, wPct: number, hPct: number) => void;
  language: Language;
}

export function MenuResizeControls({
  tableId,
  widthPct,
  heightPct,
  roomWidthM,
  roomHeightM,
  onResize,
  language,
}: MenuResizeControlsProps) {
  const { t } = useTranslation(language);
  const widthM = +(widthPct / 100 * roomWidthM).toFixed(1);
  const heightM = +(heightPct / 100 * roomHeightM).toFixed(1);

  const stepWPct = (SIZE_STEP_M / roomWidthM) * 100;
  const stepHPct = (SIZE_STEP_M / roomHeightM) * 100;

  const canShrinkW = widthPct > MIN_TABLE_PCT;
  const canGrowW = widthPct < MAX_TABLE_PCT;
  const canShrinkH = heightPct > MIN_TABLE_PCT;
  const canGrowH = heightPct < MAX_TABLE_PCT;

  const resize = (nextW: number, nextH: number) => {
    onResize(tableId, +nextW.toFixed(1), +nextH.toFixed(1));
  };

  return (
    <div className="px-3 py-2 border-t border-gray-200 space-y-1.5">
      {/* Width row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-xs text-gray-500">
          <ArrowLeftRight className="w-3 h-3" />
          <span>{t('billiard.width') || 'Width'}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`p-0.5 rounded hover:bg-gray-100 ${canShrinkW ? '' : 'opacity-30 cursor-not-allowed'}`}
            disabled={!canShrinkW}
            onClick={(e) => {
              e.stopPropagation();
              resize(Math.max(MIN_TABLE_PCT, widthPct - stepWPct), heightPct);
            }}
            aria-label="Shrink width"
          >
            <Minus className="w-3 h-3" />
          </button>
          <span className="text-xs font-medium tabular-nums w-10 text-center">{widthM}m</span>
          <button
            type="button"
            className={`p-0.5 rounded hover:bg-gray-100 ${canGrowW ? '' : 'opacity-30 cursor-not-allowed'}`}
            disabled={!canGrowW}
            onClick={(e) => {
              e.stopPropagation();
              resize(Math.min(MAX_TABLE_PCT, widthPct + stepWPct), heightPct);
            }}
            aria-label="Grow width"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
      </div>
      {/* Height row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-xs text-gray-500">
          <ArrowUpDown className="w-3 h-3" />
          <span>{t('billiard.height') || 'Height'}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`p-0.5 rounded hover:bg-gray-100 ${canShrinkH ? '' : 'opacity-30 cursor-not-allowed'}`}
            disabled={!canShrinkH}
            onClick={(e) => {
              e.stopPropagation();
              resize(widthPct, Math.max(MIN_TABLE_PCT, heightPct - stepHPct));
            }}
            aria-label="Shrink height"
          >
            <Minus className="w-3 h-3" />
          </button>
          <span className="text-xs font-medium tabular-nums w-10 text-center">{heightM}m</span>
          <button
            type="button"
            className={`p-0.5 rounded hover:bg-gray-100 ${canGrowH ? '' : 'opacity-30 cursor-not-allowed'}`}
            disabled={!canGrowH}
            onClick={(e) => {
              e.stopPropagation();
              resize(widthPct, Math.min(MAX_TABLE_PCT, heightPct + stepHPct));
            }}
            aria-label="Grow height"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
