import React, { useEffect, useRef } from 'react';

export type KeyboardMode = 'alpha' | 'full' | 'numeric' | 'integer';

interface Props {
  visible: boolean;
  mode: KeyboardMode;
  onKey: (key: string) => void;
  onBackspace: () => void;
  onDone: () => void;
  doneLabel?: string;
  spaceLabel?: string;
  onHeightChange?: (heightPx: number) => void;
}

const ALPHA_ROWS = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
];

const NUMBER_ROW = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const PUNCT_KEYS = ['.', ',', '@', '-', '_', '/'];

const NUMPAD_ROWS = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
];

const BackspaceIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9.75L14.25 12m0 0l2.25 2.25M14.25 12l2.25-2.25M14.25 12L12 14.25m-2.58 4.92l-6.375-6.375a1.125 1.125 0 010-1.59L9.42 4.83c.211-.211.498-.33.796-.33H19.5a2.25 2.25 0 012.25 2.25v10.5a2.25 2.25 0 01-2.25 2.25h-9.284c-.298 0-.585-.119-.796-.33z" />
  </svg>
);

export default function TouchKeyboard({
  visible,
  mode,
  onKey,
  onBackspace,
  onDone,
  doneLabel = 'DONE',
  spaceLabel = 'SPACE',
  onHeightChange,
}: Props) {
  const keyboardRef = useRef<HTMLDivElement | null>(null);
  const lastReportedHeightRef = useRef<number | null>(null);

  useEffect(() => {
    const element = keyboardRef.current;
    if (!element) return undefined;

    let frame = 0;
    const syncHeight = (force = false) => {
      // Use the target content height, not the in-flight animated box height.
      // Reporting every transition frame feeds back into App padding/inset and
      // can make fixed POS modals visibly jitter above the touch keyboard.
      const nextHeight = visible ? Math.ceil(element.scrollHeight) : 0;
      if (!force && lastReportedHeightRef.current === nextHeight) return;
      lastReportedHeightRef.current = nextHeight;
      onHeightChange?.(nextHeight);
    };

    syncHeight(true);
    frame = window.requestAnimationFrame(() => syncHeight());
    const handleResize = () => syncHeight();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', handleResize);
      return () => {
        window.cancelAnimationFrame(frame);
        window.removeEventListener('resize', handleResize);
      };
    }

    const observer = new ResizeObserver(() => syncHeight());
    observer.observe(element);
    window.addEventListener('resize', handleResize);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [mode, onHeightChange, visible]);

  return (
    <div
      ref={keyboardRef}
      className={`
        w-full bg-slate-100 border-t border-slate-300 px-3 pt-2 pb-3
        transition-all duration-300 ease-in-out overflow-hidden
        relative z-[60]
        ${visible ? 'max-h-[440px] opacity-100' : 'h-0 max-h-0 opacity-0 !p-0 border-t-0'}
      `}
    >
      {mode === 'numeric' || mode === 'integer' ? (
        /* Numpad layout */
        <div className="max-w-[220px] mx-auto space-y-1.5">
          {NUMPAD_ROWS.map((row, i) => (
            <div key={i} className="flex gap-1.5 justify-center">
              {row.map((k) => (
                <NumKey key={k} label={k} onPress={() => onKey(k)} />
              ))}
            </div>
          ))}
          <div className="flex gap-1.5 justify-center">
            {mode === 'numeric' ? (
              <NumKey label="." onPress={() => onKey('.')} />
            ) : (
              <span className="h-14 w-[68px]" aria-hidden="true" />
            )}
            <NumKey label="0" onPress={() => onKey('0')} />
            <button
              type="button"
              onPointerDown={(e) => { e.preventDefault(); onBackspace(); }}
              className="flex items-center justify-center w-[68px] h-14 bg-slate-300 hover:bg-slate-400 active:bg-slate-500 rounded-xl text-slate-700 transition-colors select-none cursor-pointer"
            >
              <BackspaceIcon />
            </button>
          </div>
          <button
            type="button"
            onPointerDown={(e) => { e.preventDefault(); onDone(); }}
            className="w-full h-12 bg-brand-600 hover:bg-brand-700 active:bg-brand-800 rounded-xl text-white text-sm font-bold transition-colors select-none cursor-pointer"
          >
            {doneLabel}
          </button>
        </div>
      ) : (
        /* Alpha / Full layout */
        <div className="max-w-lg mx-auto space-y-1.5">
          {mode === 'full' && (
            <div className="flex gap-1 justify-center">
              {NUMBER_ROW.map((k) => (
                <KeyBtn key={k} label={k} onPress={() => onKey(k)} />
              ))}
            </div>
          )}

          {ALPHA_ROWS.map((row, i) => (
            <div key={i} className="flex gap-1 justify-center">
              {row.map((k) => (
                <KeyBtn key={k} label={k} onPress={() => onKey(k)} />
              ))}
              {i === 2 && (
                <button
                  type="button"
                  onPointerDown={(e) => { e.preventDefault(); onBackspace(); }}
                  className="flex items-center justify-center h-12 px-3 min-w-[52px] bg-slate-300 hover:bg-slate-400 active:bg-slate-500 rounded-lg text-slate-700 transition-colors select-none cursor-pointer"
                >
                  <BackspaceIcon />
                </button>
              )}
            </div>
          ))}

          {mode === 'full' && (
            <div className="flex gap-1 justify-center">
              {PUNCT_KEYS.map((k) => (
                <KeyBtn key={k} label={k} onPress={() => onKey(k)} />
              ))}
            </div>
          )}

          <div className="flex gap-1.5 justify-center mt-1">
            <button
              type="button"
              onPointerDown={(e) => { e.preventDefault(); onKey(' '); }}
              className="h-12 flex-1 max-w-[280px] bg-white hover:bg-slate-50 active:bg-slate-200 rounded-lg border border-slate-300 text-slate-500 text-xs font-semibold uppercase tracking-wider transition-colors select-none cursor-pointer"
            >
              {spaceLabel}
            </button>
            <button
              type="button"
              onPointerDown={(e) => { e.preventDefault(); onDone(); }}
              className="h-12 px-6 bg-brand-600 hover:bg-brand-700 active:bg-brand-800 rounded-lg text-white text-sm font-bold transition-colors select-none cursor-pointer"
            >
              {doneLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function KeyBtn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <button
      type="button"
      onPointerDown={(e) => { e.preventDefault(); onPress(); }}
      className="flex items-center justify-center w-10 h-12 bg-white hover:bg-slate-50 active:bg-slate-200 rounded-lg border border-slate-200 text-slate-800 font-bold text-base shadow-sm transition-colors select-none cursor-pointer"
    >
      {label}
    </button>
  );
}

function NumKey({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <button
      type="button"
      onPointerDown={(e) => { e.preventDefault(); onPress(); }}
      className="flex items-center justify-center w-[68px] h-14 bg-white hover:bg-slate-50 active:bg-slate-200 rounded-xl border border-slate-200 text-slate-800 font-bold text-xl shadow-sm transition-colors select-none cursor-pointer"
    >
      {label}
    </button>
  );
}
