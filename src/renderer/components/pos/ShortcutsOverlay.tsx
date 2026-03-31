import React from 'react';

interface ShortcutRow {
  combo: string;
  label: string;
}

interface ShortcutsOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  t: (key: string) => string;
}

export default function ShortcutsOverlay({ isOpen, onClose, t }: ShortcutsOverlayProps) {
  if (!isOpen) return null;

  const shortcuts: ShortcutRow[] = [
    { combo: 'F1', label: t('pos.shortcut.help') },
    { combo: 'Ctrl+F', label: t('pos.shortcut.search') },
    { combo: 'Ctrl+Shift+L', label: t('pos.shortcut.layouts') },
    { combo: 'Ctrl+Shift+H', label: t('pos.shortcut.hold') },
    { combo: 'Ctrl+Shift+R', label: t('pos.shortcut.resume') },
    { combo: 'Ctrl+Shift+P', label: t('pos.shortcut.pay') },
    { combo: 'Alt+1…9', label: t('pos.shortcut.quickkeys') },
    { combo: 'Esc', label: t('pos.shortcut.close') },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-slate-800 rounded-xl w-full max-w-md mx-4 shadow-2xl border border-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">{t('pos.shortcuts')}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4 space-y-2">
          {shortcuts.map((s) => (
            <div key={s.combo} className="flex items-center justify-between text-sm">
              <span className="text-slate-300">{s.label}</span>
              <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-200 text-xs font-mono">
                {s.combo}
              </span>
            </div>
          ))}
        </div>
        <div className="px-5 py-4 border-t border-slate-700">
          <button
            onClick={onClose}
            className="w-full py-2 rounded-lg font-semibold text-white bg-slate-700 hover:bg-slate-600 transition-colors"
          >
            {t('pos.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
