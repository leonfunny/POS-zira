import React, { useEffect, useState } from 'react';
import type { CartItem as CartItemType } from '../../hooks/usePosStore';

interface CartItemProps {
  item: CartItemType;
  onUpdateQuantity: (id: string, quantity: number) => void;
  onRemove: (id: string) => void;
  onSetPrice?: (id: string, price: number) => void;
  onSetNotes?: (id: string, notes: string) => void;
  t?: (key: string) => string;
}

export default function CartItemRow({
  item, onUpdateQuantity, onRemove, onSetPrice, onSetNotes, t,
}: CartItemProps) {
  const currency = t?.('pos.currency') ?? 'PLN';
  const perUnit = t?.('pos.perUnit') ?? '/pc';
  const tOr = (key: string, fallback: string) => {
    if (!t) return fallback;
    const v = t(key);
    return v !== key ? v : fallback;
  };

  const [editingPrice, setEditingPrice] = useState(false);
  const [priceInput, setPriceInput] = useState((item.price / 100).toFixed(2));
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesInput, setNotesInput] = useState(item.notes || '');

  useEffect(() => { setPriceInput((item.price / 100).toFixed(2)); }, [item.price]);
  useEffect(() => { setNotesInput(item.notes || ''); }, [item.notes]);

  const handleSavePrice = () => {
    const value = Math.round(parseFloat(priceInput || '0') * 100);
    if (Number.isFinite(value) && onSetPrice) onSetPrice(item.id, value);
    setEditingPrice(false);
  };

  const handleSaveNotes = () => {
    if (onSetNotes) onSetNotes(item.id, notesInput.trim());
    setEditingNotes(false);
  };

  return (
    <div className="bg-white border border-gray-100 shadow-sm rounded-xl p-3 mb-2.5 last:mb-0">
      {/* Top: name + remove */}
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="text-sm font-semibold text-gray-800 leading-snug flex-1 min-w-0">{item.name}</p>
        <button
          onClick={() => onRemove(item.id)}
          className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50 active:bg-red-100 transition-colors cursor-pointer touch-manipulation shrink-0"
          aria-label="Remove item"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Middle: price per unit + edit/note links */}
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-xs text-gray-400">
          {(item.price / 100).toFixed(2)}&nbsp;{currency}{perUnit}
        </span>
        {onSetPrice && !editingPrice && (
          <button onClick={() => { setEditingPrice(true); setEditingNotes(false); }}
            className="px-2 py-1 text-[11px] text-gray-400 hover:text-brand-500 hover:bg-brand-50 rounded transition-colors cursor-pointer font-medium">
            {tOr('pos.editPrice', 'edit')}
          </button>
        )}
        {onSetNotes && !editingNotes && (
          <button onClick={() => { setEditingNotes(true); setEditingPrice(false); }}
            className="px-2 py-1 text-[11px] text-gray-400 hover:text-brand-500 hover:bg-brand-50 rounded transition-colors cursor-pointer font-medium">
            {tOr('pos.note', 'note')}
          </button>
        )}
      </div>

      {/* Bottom: qty controls (left) + total (right) */}
      <div className="flex items-center justify-between">
        {/* Grouped quantity stepper */}
        <div className="inline-flex items-center rounded-lg border border-gray-200 bg-slate-50 overflow-hidden">
          <button
            onClick={() => onUpdateQuantity(item.id, item.quantity - 1)}
            aria-label="Decrease quantity"
            className="w-8 h-7 flex items-center justify-center text-gray-500 hover:bg-gray-100 active:bg-gray-200 font-bold text-sm cursor-pointer touch-manipulation transition-colors"
          >−</button>
          <span className="px-2 text-center text-sm font-semibold text-gray-800 select-none">{item.quantity}</span>
          <button
            onClick={() => onUpdateQuantity(item.id, item.quantity + 1)}
            aria-label="Increase quantity"
            className="w-8 h-7 flex items-center justify-center bg-brand-500 hover:bg-brand-600 active:bg-brand-700 text-white font-bold text-sm cursor-pointer touch-manipulation transition-colors"
          >+</button>
        </div>
        <span className="text-base font-bold text-gray-900">{(item.total / 100).toFixed(2)}&nbsp;{currency}</span>
      </div>

      {/* Inline price editor */}
      {editingPrice && (
        <div className="mt-2 flex items-center gap-2">
          <input type="number" value={priceInput} onChange={(e) => setPriceInput(e.target.value)}
            className="w-24 px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-900 text-right focus:outline-none focus:border-brand-400"
            step="0.01" min="0" autoFocus />
          <button onClick={handleSavePrice} className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 cursor-pointer">{tOr('pos.ok', 'OK')}</button>
          <button onClick={() => setEditingPrice(false)} className="px-3 py-1.5 text-xs rounded-lg bg-white border border-gray-200 text-gray-500 hover:bg-gray-50 cursor-pointer">{tOr('pos.cancel', '✕')}</button>
        </div>
      )}

      {/* Inline notes editor */}
      {editingNotes && (
        <div className="mt-2">
          <textarea value={notesInput} onChange={(e) => setNotesInput(e.target.value)} rows={2}
            className="w-full px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-900 focus:outline-none focus:border-brand-400 resize-none"
            placeholder={tOr('pos.addNote', 'Add note...')} autoFocus />
          <div className="mt-1.5 flex gap-2">
            <button onClick={handleSaveNotes} className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 cursor-pointer">{tOr('pos.ok', 'OK')}</button>
            <button onClick={() => setEditingNotes(false)} className="px-3 py-1.5 text-xs rounded-lg bg-white border border-gray-200 text-gray-500 hover:bg-gray-50 cursor-pointer">{tOr('pos.cancel', '✕')}</button>
          </div>
        </div>
      )}

      {!editingNotes && item.notes && (
        <p className="mt-1.5 text-xs text-gray-400 italic">{item.notes}</p>
      )}
    </div>
  );
}
