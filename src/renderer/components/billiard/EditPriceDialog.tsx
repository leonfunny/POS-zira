import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import { Language } from '../../i18n/translations';
import TextInput from '../shared/TextInput';

/** Edit the hourly rate of an existing table (writes resource pricing_rules). */
export function EditPriceDialog({
  open,
  tableName,
  initialPrice,
  isPending,
  onOpenChange,
  onSave,
  language,
}: {
  open: boolean;
  tableName: string;
  initialPrice: number;
  isPending: boolean;
  onOpenChange: (v: boolean) => void;
  onSave: (price: number) => void;
  language: Language;
}) {
  const { t } = useTranslation(language);
  const [price, setPrice] = useState<number>(initialPrice);

  useEffect(() => {
    if (open) setPrice(initialPrice);
  }, [open, initialPrice]);

  if (!open) return null;

  const valid = Number.isFinite(price) && price > 0;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center"
      style={{ bottom: 'var(--touch-keyboard-inset, 0px)' }}
      onClick={() => onOpenChange(false)}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-sm w-full mx-4 max-h-[calc(100%-2rem)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b">
          <h3 className="text-sm font-semibold">{tableName}</h3>
        </div>
        <div className="p-4">
          <TextInput
            id="edit-table-price"
            label={`${t('billiard.hourlyRate') || 'Hourly Rate'} (PLN/h)`}
            labelClassName="text-sm font-medium text-slate-900"
            type="number"
            min={0}
            value={price}
            onChange={(e) => setPrice(Number(e.target.value))}
            autoFocus
          />
        </div>
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            type="button"
            className="px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-300 hover:bg-slate-50"
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel') || 'Cancel'}
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center"
            disabled={!valid || isPending}
            onClick={() => onSave(price)}
          >
            {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {t('common.save') || 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
