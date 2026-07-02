import { Pencil, RotateCw, ImageIcon, Ruler, Trash2 } from 'lucide-react';
import { ROTATION_STEPS } from '../constants';
import type { Language } from '../../../i18n/translations';
import { useTranslation } from '../../../i18n/useTranslation';

interface MenuActionItemsProps {
  tableId: string;
  rotation: number;
  onRename: () => void;
  onRotate: (id: string, rotation: number) => void;
  onChangeImage: (id: string) => void;
  onMeasureStart: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  language: Language;
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  variant,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  variant?: 'danger';
}) {
  return (
    <button
      type="button"
      className={`
        w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-100 rounded-sm transition-colors
        ${variant === 'danger' ? 'text-red-600 hover:bg-red-50' : ''}
      `}
      onClick={onClick}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

export function MenuActionItems({
  tableId,
  rotation,
  onRename,
  onRotate,
  onChangeImage,
  onMeasureStart,
  onDelete,
  onClose,
  language,
}: MenuActionItemsProps) {
  const { t } = useTranslation(language);
  return (
    <div className="py-1">
      <MenuItem
        icon={Pencil}
        label={t('billiard.rename') || 'Rename'}
        onClick={() => { onRename(); onClose(); }}
      />
      <MenuItem
        icon={RotateCw}
        label={`${t('billiard.rotate') || 'Rotate'} (${rotation}\u00B0)`}
        onClick={() => {
          const idx = ROTATION_STEPS.indexOf(rotation as typeof ROTATION_STEPS[number]);
          const next = ROTATION_STEPS[(idx + 1) % ROTATION_STEPS.length];
          onRotate(tableId, next);
          onClose();
        }}
      />
      <MenuItem
        icon={ImageIcon}
        label={t('billiard.changeImage') || 'Change Image'}
        onClick={() => { onChangeImage(tableId); onClose(); }}
      />
      <MenuItem
        icon={Ruler}
        label={t('billiard.measureDistance') || 'Measure Distance'}
        onClick={() => { onMeasureStart(tableId); onClose(); }}
      />
      <div className="my-1 border-t border-slate-200" />
      <MenuItem
        icon={Trash2}
        label={t('billiard.delete') || 'Delete'}
        variant="danger"
        onClick={() => {
          if (confirm(t('billiard.deleteConfirm') || 'Delete this table?')) {
            onDelete(tableId);
            onClose();
          }
        }}
      />
    </div>
  );
}
