import { Moon, Sun } from 'lucide-react';
import type { FloorSurfaceTheme } from './constants';

export function FloorSurfaceThemeToggle({
  value,
  onChange,
  darkLabel,
  lightLabel,
}: {
  value: FloorSurfaceTheme;
  onChange: (theme: FloorSurfaceTheme) => void;
  darkLabel: string;
  lightLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label="Floor background appearance"
      className="inline-flex h-12 shrink-0 items-center rounded-lg border border-slate-300 bg-slate-100 p-0.5"
    >
      <button
        type="button"
        onClick={() => onChange('dark')}
        aria-label={darkLabel}
        aria-pressed={value === 'dark'}
        title={darkLabel}
        className={`flex h-11 w-11 items-center justify-center rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-400 ${
          value === 'dark'
            ? 'bg-[#17241f] text-white'
            : 'text-slate-500 hover:bg-white hover:text-slate-800'
        }`}
      >
        <Moon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onChange('light')}
        aria-label={lightLabel}
        aria-pressed={value === 'light'}
        title={lightLabel}
        className={`flex h-11 w-11 items-center justify-center rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-400 ${
          value === 'light'
            ? 'bg-white text-amber-700 shadow-sm'
            : 'text-slate-500 hover:bg-white hover:text-amber-700'
        }`}
      >
        <Sun className="h-4 w-4" />
      </button>
    </div>
  );
}
