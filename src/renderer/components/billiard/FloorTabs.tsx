import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
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
  onRenameFloor: (floor: BilliardFloorPlan) => void;
  onDeleteFloor: (floor: BilliardFloorPlan) => void;
  isAddingFloor: boolean;
  pendingFloorId: string | null;
  language: Language;
}

export function FloorTabs({
  floors,
  activeFloor,
  onFloorChange,
  tableCounts,
  editMode,
  onAddFloor,
  onRenameFloor,
  onDeleteFloor,
  isAddingFloor,
  pendingFloorId,
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
        const floorPending = pendingFloorId === floor.id;
        const canDelete = floors.length > 1 && counts.total === 0;

        return (
          <div key={floor.id} className="inline-flex items-center gap-2">
            <button
              type="button"
              onClick={() => onFloorChange(floor)}
              className={`
                inline-flex min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium
                transition-all
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

            {editMode && (
              <>
                <button
                  type="button"
                  onClick={() => onRenameFloor(floor)}
                  disabled={floorPending}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:border-brand-400 hover:text-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:opacity-50"
                  aria-label={`${t('billiard.rename')} ${floor.name}`}
                  title={t('billiard.rename')}
                >
                  {floorPending
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Pencil className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteFloor(floor)}
                  disabled={floorPending || !canDelete}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:border-red-400 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={`${t('billiard.delete')} ${floor.name}`}
                  title={canDelete ? t('billiard.delete') : counts.total > 0 ? 'Move or delete tables first' : 'Cannot delete the only floor'}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        );
      })}

      {editMode && (
        <button
          type="button"
          onClick={onAddFloor}
          disabled={isAddingFloor}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium
            border border-dashed border-slate-300 text-slate-500
            hover:border-blue-400 hover:text-blue-600 transition-colors disabled:cursor-wait disabled:opacity-50"
        >
          {isAddingFloor
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <Plus className="h-4 w-4" />}
          {t('billiard.addFloor') || 'Add Floor'}
        </button>
      )}
    </div>
  );
}
