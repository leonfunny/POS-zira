import React from 'react';

export type NumpadMode = 'cash' | 'qty' | 'price' | 'weight' | 'discount';

export interface POSNumpadProps {
  mode: NumpadMode;
  buffer: string;
  label?: string;
  currency?: string;
  isPercent?: boolean;
  total?: number;
  presets?: number[];
  onKey: (digit: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  onDecimal: () => void;
  onDoubleZero: () => void;
  onTogglePercent?: () => void;
  onPreset?: (groszeAmount: number) => void;
  onExact?: () => void;
  onDone: () => void;
  t?: (key: string) => string;
}

const DEFAULT_PRESETS_GROSZE = [1000, 2000, 5000, 10000];

const BackspaceIcon: React.FC = () => (
  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9.75L14.25 12m0 0l2.25 2.25M14.25 12l2.25-2.25M14.25 12L12 14.25m-2.58 4.92l-6.375-6.375a1.125 1.125 0 010-1.59L9.42 4.83c.211-.211.498-.33.796-.33H19.5a2.25 2.25 0 012.25 2.25v10.5a2.25 2.25 0 01-2.25 2.25h-9.284c-.298 0-.585-.119-.796-.33z" />
  </svg>
);

const CheckIcon: React.FC = () => (
  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

function formatBufferDisplay(buffer: string, mode: NumpadMode): string {
  if (!buffer) return mode === 'qty' ? '0' : '0.00';
  return buffer;
}

interface KeyBtnProps {
  onClick: () => void;
  disabled?: boolean;
  variant?: 'digit' | 'util' | 'primary' | 'preset' | 'danger';
  children: React.ReactNode;
  ariaLabel?: string;
}

const KeyBtn: React.FC<KeyBtnProps> = ({ onClick, disabled, variant = 'digit', children, ariaLabel }) => {
  const base = 'flex items-center justify-center font-extrabold text-xl rounded-lg select-none touch-manipulation transition-all duration-75 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1';
  const styles: Record<NonNullable<KeyBtnProps['variant']>, string> = {
    digit: 'h-14 bg-white border border-slate-300 text-slate-900 hover:bg-slate-50 active:bg-slate-100 focus-visible:ring-brand-300',
    util: 'h-14 bg-slate-100 border border-slate-300 text-slate-700 hover:bg-slate-200 active:bg-slate-300 focus-visible:ring-slate-400',
    danger: 'h-14 bg-amber-50 border border-amber-300 text-amber-800 hover:bg-amber-100 active:bg-amber-200 focus-visible:ring-amber-400',
    primary: 'h-14 bg-brand-600 border border-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 focus-visible:ring-brand-400',
    preset: 'h-11 bg-emerald-50 border border-emerald-300 text-emerald-800 hover:bg-emerald-100 active:bg-emerald-200 text-sm focus-visible:ring-emerald-400',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`${base} ${styles[variant]} ${disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      {children}
    </button>
  );
};

export default function POSNumpad({
  mode,
  buffer,
  label,
  currency = 'PLN',
  isPercent,
  total,
  presets = DEFAULT_PRESETS_GROSZE,
  onKey,
  onBackspace,
  onClear,
  onDecimal,
  onDoubleZero,
  onTogglePercent,
  onPreset,
  onExact,
  onDone,
  t,
}: POSNumpadProps) {
  const tOr = (key: string, fallback: string) => {
    if (!t) return fallback;
    const v = t(key);
    return v !== key ? v : fallback;
  };

  const showPresets = mode === 'cash';
  const decimalAllowed = mode !== 'qty';
  const doubleZeroAllowed = mode !== 'qty';
  const percentEnabled = mode === 'discount';
  const exactEnabled = mode === 'cash' && typeof total === 'number' && total > 0;

  const display = formatBufferDisplay(buffer, mode);
  const suffix = (() => {
    if (mode === 'qty') return tOr('pos.numpad.unit', 'pcs');
    if (mode === 'weight') return 'kg';
    if (mode === 'discount' && isPercent) return '%';
    return currency;
  })();

  return (
    <div className="bg-slate-50 border-t border-slate-300 px-3 pt-2 pb-3" role="group" aria-label="POS numeric keypad">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
          {label || tOr(`pos.numpad.mode.${mode}`, mode)}
        </span>
        <span className="tabular-nums text-xl font-extrabold text-slate-950">
          {display}
          <span className="ml-1.5 text-xs font-bold text-slate-500">{suffix}</span>
        </span>
      </div>

      {showPresets && (
        <div className="mb-2 grid grid-cols-5 gap-1.5">
          {presets.slice(0, 4).map((grosze) => (
            <KeyBtn
              key={grosze}
              variant="preset"
              onClick={() => onPreset?.(grosze)}
              ariaLabel={`Quick cash ${(grosze / 100).toFixed(0)}`}
            >
              {(grosze / 100).toFixed(0)}
            </KeyBtn>
          ))}
          <KeyBtn
            variant="preset"
            disabled={!exactEnabled}
            onClick={() => onExact?.()}
            ariaLabel="Exact change"
          >
            {tOr('pos.numpad.exact', 'Exact')}
          </KeyBtn>
        </div>
      )}

      <div className="grid grid-cols-4 gap-1.5">
        <KeyBtn variant="digit" onClick={() => onKey('7')}>7</KeyBtn>
        <KeyBtn variant="digit" onClick={() => onKey('8')}>8</KeyBtn>
        <KeyBtn variant="digit" onClick={() => onKey('9')}>9</KeyBtn>
        <KeyBtn variant="danger" onClick={onBackspace} ariaLabel="Backspace">
          <BackspaceIcon />
        </KeyBtn>

        <KeyBtn variant="digit" onClick={() => onKey('4')}>4</KeyBtn>
        <KeyBtn variant="digit" onClick={() => onKey('5')}>5</KeyBtn>
        <KeyBtn variant="digit" onClick={() => onKey('6')}>6</KeyBtn>
        <KeyBtn variant="danger" onClick={onClear} ariaLabel="Clear">C</KeyBtn>

        <KeyBtn variant="digit" onClick={() => onKey('1')}>1</KeyBtn>
        <KeyBtn variant="digit" onClick={() => onKey('2')}>2</KeyBtn>
        <KeyBtn variant="digit" onClick={() => onKey('3')}>3</KeyBtn>
        <KeyBtn
          variant="util"
          disabled={!percentEnabled}
          onClick={() => onTogglePercent?.()}
          ariaLabel="Toggle percent"
        >
          {percentEnabled ? (isPercent ? currency : '%') : '%'}
        </KeyBtn>

        <KeyBtn variant="digit" onClick={() => onKey('0')}>0</KeyBtn>
        <KeyBtn variant="digit" disabled={!doubleZeroAllowed} onClick={onDoubleZero}>00</KeyBtn>
        <KeyBtn variant="digit" disabled={!decimalAllowed} onClick={onDecimal}>.</KeyBtn>
        <KeyBtn variant="primary" onClick={onDone} ariaLabel="Confirm">
          <CheckIcon />
        </KeyBtn>
      </div>
    </div>
  );
}
