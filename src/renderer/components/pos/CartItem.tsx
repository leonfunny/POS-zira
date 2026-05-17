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
  const isActive = !!activeField;

  return (
    <div className={`px-3 py-3 border-b border-slate-100 last:border-b-0 transition-colors ${
      isActive ? 'bg-brand-50' : ''
    }`}>
      {/* Row 1: name + line total + remove. Putting the line total here
           (rather than the unit price) anchors the row visually so the
           cashier can scan totals down the column without arithmetic. */}
      <div className="flex items-start justify-between gap-2">
        <p className="flex-1 min-w-0 text-sm font-extrabold text-slate-950 leading-snug line-clamp-1">
          {resolveName(item, lang)}
        </p>
        <span className="text-base font-extrabold text-slate-950 tabular-nums leading-none shrink-0">
          {(item.total / 100).toFixed(2)} <span className="text-xs text-slate-500 font-bold">{currency}</span>
        </span>
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          aria-label="Remove item"
          className="w-9 h-9 flex items-center justify-center rounded-md text-slate-400 hover:text-red-700 hover:bg-red-50 active:bg-red-100 cursor-pointer touch-manipulation shrink-0 focus:outline-none focus:ring-2 focus:ring-red-100 -mr-1 -mt-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Row 2: unit price (tap to edit) + note button + qty stepper.
           Stepper on the right keeps the dominant touch target close
           to the thumb when the panel is on the right side of a kiosk. */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={() => onSelectField?.(item.id, 'price')}
            title={tOr('pos.tapToEditPrice', 'Tap to edit price')}
            className={`min-h-[32px] text-xs tabular-nums rounded-md px-2 py-1 transition-colors cursor-pointer touch-manipulation ${
              priceHighlight
                ? 'bg-brand-100 text-brand-900 font-extrabold ring-1 ring-brand-400'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700 font-bold'
            }`}
          >
            {priceDisplay} {currency}{perUnit}
          </button>
          {onSetNotes && !editingNotes && (
            <button
              type="button"
              onClick={() => setEditingNotes(true)}
              aria-label={item.notes ? tOr('pos.note', 'Note') : tOr('pos.addNote', 'Add note')}
              className={`min-h-[32px] flex items-center justify-center rounded-md cursor-pointer touch-manipulation transition-colors ${
                item.notes
                  ? 'w-8 text-brand-700 bg-brand-50 hover:bg-brand-100'
                  : 'w-8 text-slate-400 hover:text-brand-700 hover:bg-brand-50'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
        </div>

        <div className="inline-flex items-center rounded-lg border border-slate-300 bg-slate-50 overflow-hidden shrink-0">
          <button
            type="button"
            onClick={() => item.quantity > 1 && onUpdateQuantity(item.id, item.quantity - 1)}
            disabled={item.quantity <= 1}
            aria-label="Decrease quantity"
            className={`w-10 h-10 flex items-center justify-center font-extrabold text-base touch-manipulation transition-colors ${
              item.quantity <= 1
                ? 'text-slate-300 cursor-not-allowed'
                : 'text-slate-700 hover:bg-slate-100 active:bg-slate-200 cursor-pointer'
            }`}
          >−</button>
          <button
            type="button"
            onClick={() => onSelectField?.(item.id, 'qty')}
            title={tOr('pos.tapToEdit', 'Tap to edit quantity')}
            className={`h-10 min-w-12 px-2 text-center text-sm font-extrabold cursor-pointer transition-colors border-x ${
              qtyHighlight
                ? 'bg-brand-100 text-brand-900 border-brand-400'
                : 'bg-white text-slate-950 hover:text-brand-700 hover:bg-brand-50 border-slate-300'
            }`}
          >
            {qtyDisplay}
          </button>
          <button
            type="button"
            onClick={() => onUpdateQuantity(item.id, item.quantity + 1)}
            aria-label="Increase quantity"
            className="w-10 h-10 flex items-center justify-center bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white font-extrabold text-base cursor-pointer touch-manipulation transition-colors"
          >+</button>
        </div>
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
            <button
              type="button"
              onClick={handleSaveNotes}
              className="h-10 px-4 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer font-bold touch-manipulation"
            >
              {tOr('pos.ok', 'OK')}
            </button>
            <button
              type="button"
              onClick={() => setEditingNotes(false)}
              className="h-10 px-4 text-sm rounded-lg bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer font-bold touch-manipulation"
            >
              {tOr('pos.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      )}

      {!editingNotes && item.notes && (
        <p className="mt-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-md px-2.5 py-1.5 line-clamp-2">
          {item.notes}
        </p>
      )}
    </div>
  );
}
