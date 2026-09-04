import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  formatIsoDate,
  monthCells,
  monthTitle,
  parseIsoDate,
  shiftMonth,
  toIsoDate,
  weekdayLabels,
} from '../../../shared/calendar';
import { todayIsoDate } from '../../../shared/label-print-order';

interface DateFieldProps {
  value: string | null | undefined;
  onChange: (iso: string) => void;
  language: string;
  testId: string;
  /** The visible label of the control, for screen readers. */
  label: string;
}

const COPY: Record<string, { today: string; previous: string; next: string; empty: string }> = {
  vi: { today: 'Hôm nay', previous: 'Tháng trước', next: 'Tháng sau', empty: 'Chọn ngày' },
  pl: { today: 'Dziś', previous: 'Poprzedni miesiąc', next: 'Następny miesiąc', empty: 'Wybierz datę' },
  en: { today: 'Today', previous: 'Previous month', next: 'Next month', empty: 'Pick a date' },
};

/**
 * A date the operator reads as day/month/year, with a month grid in the app's
 * language. The value in and out is ISO `YYYY-MM-DD`, as the sheet stores it.
 */
export default function DateField({ value, onChange, language, testId, label }: DateFieldProps) {
  const copy = COPY[language] || COPY.vi;
  const [open, setOpen] = useState(false);
  const selected = parseIsoDate(value);
  const today = parseIsoDate(todayIsoDate())!;
  const [view, setView] = useState({ year: (selected ?? today).year, month: (selected ?? today).month });
  const rootRef = useRef<HTMLDivElement>(null);

  // Opening shows the month of the date on the sheet, not the one last browsed.
  useEffect(() => {
    if (open) setView({ year: (selected ?? today).year, month: (selected ?? today).month });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (iso: string) => {
    onChange(iso);
    setOpen(false);
  };

  const todayIso = toIsoDate(today.year, today.month, today.day);
  const selectedIso = selected ? toIsoDate(selected.year, selected.month, selected.day) : '';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid={testId}
        data-value={selectedIso}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-10 w-full items-center justify-between rounded-md border border-slate-300 px-2 text-left text-sm focus:border-emerald-500 focus:outline-none"
      >
        <span className={selected ? '' : 'text-slate-400'}>
          {selected ? formatIsoDate(selectedIso, language) : copy.empty}
        </span>
        <CalendarDays size={16} aria-hidden="true" className="text-slate-500" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          data-testid={`${testId}-calendar`}
          className="absolute left-0 top-11 z-20 w-72 rounded-md border border-slate-300 bg-white p-2 shadow-lg"
        >
          <div className="mb-1 flex items-center justify-between">
            <button
              type="button"
              data-testid={`${testId}-prev`}
              aria-label={copy.previous}
              onClick={() => setView((current) => shiftMonth(current.year, current.month, -1))}
              className="rounded p-1 hover:bg-slate-100"
            >
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            <span className="text-sm font-bold" data-testid={`${testId}-month`}>
              {monthTitle(view.year, view.month, language)}
            </span>
            <button
              type="button"
              data-testid={`${testId}-next`}
              aria-label={copy.next}
              onClick={() => setView((current) => shiftMonth(current.year, current.month, 1))}
              className="rounded p-1 hover:bg-slate-100"
            >
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] font-bold uppercase text-slate-500">
            {weekdayLabels(language).map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {monthCells(view.year, view.month).map((cell) => {
              const isSelected = cell.iso === selectedIso;
              const isToday = cell.iso === todayIso;
              return (
                <button
                  key={cell.iso}
                  type="button"
                  data-testid={`${testId}-day`}
                  data-iso={cell.iso}
                  aria-pressed={isSelected}
                  onClick={() => pick(cell.iso)}
                  className={[
                    'h-9 rounded text-sm',
                    cell.inMonth ? 'text-slate-900' : 'text-slate-300',
                    isSelected ? 'bg-emerald-600 font-bold text-white' : 'hover:bg-slate-100',
                    isToday && !isSelected ? 'font-bold underline' : '',
                  ].join(' ')}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            data-testid={`${testId}-today`}
            onClick={() => pick(todayIso)}
            className="mt-1 w-full rounded border border-slate-300 py-1 text-sm font-bold hover:bg-slate-50"
          >
            {copy.today}
          </button>
        </div>
      )}
    </div>
  );
}
