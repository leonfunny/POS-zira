import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import TextInput from '../shared/TextInput';

interface RenameFloorDialogProps {
  open: boolean;
  floorName: string;
  isPending: boolean;
  language: Language;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string) => void;
}

export function RenameFloorDialog({
  open,
  floorName,
  isPending,
  language,
  onOpenChange,
  onSave,
}: RenameFloorDialogProps) {
  const { t } = useTranslation(language);
  const titleId = useId();
  const [name, setName] = useState(floorName);

  useEffect(() => {
    if (open) setName(floorName);
  }, [floorName, open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isPending) return;
      event.preventDefault();
      onOpenChange(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPending, onOpenChange, open]);

  if (!open) return null;

  const normalizedName = name.trim();
  const canSave = normalizedName.length > 0 && normalizedName !== floorName.trim();

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 px-4 py-6"
      style={{ bottom: 'var(--touch-keyboard-inset, 0px)' }}
      onClick={() => {
        if (!isPending) onOpenChange(false);
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave && !isPending) onSave(normalizedName);
        }}
      >
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            {t('billiard.rename')}
          </h2>
          <p className="mt-1 truncate text-sm text-slate-500" title={floorName}>
            {floorName}
          </p>
        </div>

        <div className="px-5 py-4">
          <TextInput
            id="rename-floor-name"
            label={t('billiard.floor')}
            value={name}
            maxLength={100}
            disabled={isPending}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            type="button"
            className="inline-flex h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-300 disabled:opacity-50"
            disabled={isPending}
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="inline-flex h-11 min-w-24 items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canSave || isPending}
          >
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
