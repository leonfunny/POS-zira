import React, { useEffect, useState } from 'react';
import type { CartItem as CartItemType } from '../../hooks/usePosStore';
import { resolveName } from '../../../shared/catalog-names';

interface CartItemProps {
  item: CartItemType;
  onUpdateQuantity: (id: string, quantity: number) => void;
  onRemove: (id: string) => void;
  onSetNotes?: (id: string, notes: string) => void;
  onSelectField?: (id: string, field: 'qty' | 'price') => void;
  activeField?: 'qty' | 'price' | null;
  activeBuffer?: string;
  t?: (key: string) => string;
  /** Operator UI language. Resolves item.name_translations for display only;
   *  orders/fiscal lines keep canonical item.name while paper receipts
   *  localize separately at print time. */
  lang?: string;
}

export default function CartItemRow({
  item,
  onUpdateQuantity,
  onRemove,
  onSetNotes,
  onSelectField,
  activeField,
  activeBuffer,
  t,
  lang,
}: CartItemProps) {
  const currency = t?.('pos.currency') ?? 'PLN';
  const perUnit = t?.('pos.perUnit') ?? '/pc';
  const tOr = (key: string, fallback: string) => {
    if (!t) return fallback;
    const v = t(key);
    return v !== key ? v : fallback;
  };

  const [editingNotes, setEditingNotes] = useState(false);
  const [notesInput, setNotesInput] = useState(item.notes || '');
  useEffect(() => { setNotesInput(item.notes || ''); }, [item.notes]);

  const handleSaveNotes = () => {
    if (onSetNotes) onSetNotes(item.id, notesInput.trim());
    setEditingNotes(false);
  };

  const qtyDisplay = activeField === 'qty' && activeBuffer ? activeBuffer : String(item.quantity);
  const priceDisplay = activeField === 'price' && activeBuffer
    ? activeBuffer
    : (item.price / 100).toFixed(2);

  const qtyHighlight = activeField === 'qty';
  const priceHighlight = activeField === 'price';

  return (
    <div className={`bg-white border rounded-lg p-3 mb-2.5 last:mb-0 shadow-sm transition-colors ${
      activeField ? 'border-brand-400 ring-2 ring-brand-100' : 'border-slate-200'
    }`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-extrabold text-slate-950 leading-snug line-clamp-2">{resolveName(item, lang)}</p>
          <button
            type="button"
            onClick={() => onSelectField?.(item.id, 'price')}
            className={`mt-1 text-xs tabular-nums rounded px-1.5 py-0.5 transition-colors cursor-pointer ${
              priceHighlight
                ? 'bg-brand-100 text-brand-900 font-extrabold ring-1 ring-brand-400'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
            }`}
            title={tOr('pos.tapToEditPrice', 'Tap to edit price')}
          >
            {priceDisplay}&nbsp;{currency}{perUnit}
          </button>
        </div>
        <button
          onClick={() => onRemove(item.id)}
          className="w-11 h-11 flex items-center justify-center rounded-lg text-slate-500 hover:text-red-700 hover:bg-red-50 active:bg-red-100 border border-transparent hover:border-red-200 transition-colors cursor-pointer touch-manipulation shrink-0 focus:outline-none focus:ring-2 focus:ring-red-100"
          aria-label="Remove item"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex items-center gap-2 mb-2.5">
        {onSetNotes && !editingNotes && (
          <button
            onClick={() => setEditingNotes(true)}
            className="h-11 px-3 text-xs text-slate-600 hover:text-brand-700 hover:bg-brand-50 rounded-md border border-slate-200 hover:border-brand-200 transition-colors cursor-pointer font-bold touch-manipulation"
          >
            {item.notes ? tOr('pos.note', 'Note') : tOr('pos.note', 'Add note')}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex items-center rounded-lg border border-slate-300 bg-slate-50 overflow-hidden">
          <button
            onClick={() => item.quantity > 1 && onUpdateQuantity(item.id, item.quantity - 1)}
            disabled={item.quantity <= 1}
            aria-label="Decrease quantity"
            className={`w-11 h-11 flex items-center justify-center font-extrabold text-base touch-manipulation transition-colors ${
              item.quantity <= 1
                ? 'text-slate-300 cursor-not-allowed'
                : 'text-slate-700 hover:bg-slate-100 active:bg-slate-200 cursor-pointer'
            }`}
          >-</button>
          <button
            type="button"
            onClick={() => onSelectField?.(item.id, 'qty')}
            className={`h-11 min-w-14 px-3 text-center text-sm font-extrabold cursor-pointer transition-colors border-x ${
              qtyHighlight
                ? 'bg-brand-100 text-brand-900 border-brand-400'
                : 'bg-white text-slate-950 hover:text-brand-700 hover:bg-brand-50 border-slate-300'
            }`}
            title={tOr('pos.tapToEdit', 'Tap to edit quantity')}
          >
            {qtyDisplay}
          </button>
          <button
            onClick={() => onUpdateQuantity(item.id, item.quantity + 1)}
            aria-label="Increase quantity"
            className="w-11 h-11 flex items-center justify-center bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white font-extrabold text-base cursor-pointer touch-manipulation transition-colors"
          >+</button>
        </div>
        <span className="text-base font-extrabold text-slate-950 tabular-nums text-right">{(item.total / 100).toFixed(2)}&nbsp;{currency}</span>
      </div>

      {editingNotes && (
        <div className="mt-3">
          <textarea
            value={notesInput}
            onChange={(e) => setNotesInput(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm text-slate-950 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 resize-none"
            placeholder={tOr('pos.addNote', 'Add note')}
            autoFocus
          />
          <div className="mt-2 flex gap-2">
            <button onClick={handleSaveNotes} className="h-11 px-4 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer font-bold">{tOr('pos.ok', 'OK')}</button>
            <button onClick={() => setEditingNotes(false)} className="h-11 px-4 text-sm rounded-lg bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer font-bold">{tOr('pos.cancel', 'Cancel')}</button>
          </div>
        </div>
      )}

      {!editingNotes && item.notes && (
        <p className="mt-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-md px-2.5 py-2">{item.notes}</p>
      )}
    </div>
  );
}
