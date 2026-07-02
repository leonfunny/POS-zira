import { Plus } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import type { Language } from '../../i18n/translations';
import type { BilliardFloorPlan } from './types';

interface FloorTabsProps {
  floors: BilliardFloorPlan[];
  activeFloor: BilliardFloorPlan | null;
  onFloorChange: (floor: BilliardFloorPlan) => void;
  tableCounts: Record<string, { total: number; occupied: number; paused: number }>;
  editMode: boolean;
  onAddFloor: () => void;
  language: Language;
}

export function FloorTabs({
  floors,
  activeFloor,
  onFloorChange,
  tableCounts,
  editMode,
  onAddFloor,
  language,
}: FloorTabsProps) {
  const { t } = useTranslation(language);

  // Hidden when only 1 floor and not in edit mode
  if (floors.length <= 1 && !editMode) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {floors.map((floor) => {
        const isActive = floor.id === activeFloor?.id;
        const counts = tableCounts[floor.id] || { total: 0, occupied: 0, paused: 0 };

        return (
          <button
            key={floor.id}
            type="button"
            onClick={() => onFloorChange(floor)}
            className={`
              inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium
              transition-all border
              ${isActive
                ? 'bg-brand-600 text-white border-brand-600 shadow-sm'
                : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50 hover:text-slate-900'
              }
            `}
          >
            <span>{floor.name}</span>
            <span className={`text-xs ${isActive ? 'text-white/80' : 'text-slate-400'}`}>
              ({counts.total})
            </span>
            {/* Status dots */}
            {(counts.occupied > 0 || counts.paused > 0) && (
              <span className="flex items-center gap-0.5">
                {counts.occupied > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                )}
                {counts.paused > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                )}
              </span>
            )}
          </button>
        );
      })}

      {editMode && (
        <button
          type="button"
          onClick={onAddFloor}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium
            border border-dashed border-slate-300 text-slate-500
            hover:border-blue-400 hover:text-blue-600 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('billiard.addFloor') || 'Add Floor'}
        </button>
      )}
    </div>
  );
}
