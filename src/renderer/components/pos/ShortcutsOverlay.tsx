import React from 'react';
import Modal from '../shared/Modal';

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
    <Modal
      title={t('pos.shortcuts')}
      onClose={onClose}
      size="md"
      bodyClassName="px-5 py-4 space-y-2"
      footer={(
        <button
          onClick={onClose}
          className="w-full py-2 rounded-lg bg-slate-900 font-semibold text-white transition-colors hover:bg-slate-950"
        >
          {t('pos.ok')}
        </button>
      )}
    >
          {shortcuts.map((s) => (
            <div key={s.combo} className="flex items-center justify-between text-sm">
              <span className="text-slate-700">{s.label}</span>
              <span className="px-2 py-0.5 rounded border border-slate-200 bg-slate-100 text-slate-800 text-xs font-mono">
                {s.combo}
              </span>
            </div>
          ))}
    </Modal>
  );
}
