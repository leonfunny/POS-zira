import React, { useEffect, useState } from 'react';
import { PencilLine, Printer, Scale, StickyNote, Trash2 } from 'lucide-react';
import type { CartItem as CartItemType } from '../../hooks/usePosStore';
import { resolveName } from '../../../shared/catalog-names';
import { formatSaleQuantity, normalizeSaleUnit, normalizeSellBy } from '../../../shared/pos-sale';

export interface CartItemLabelPrintResult {
  success: boolean;
  message?: string;
  error?: string;
}

interface CartItemProps {
  item: CartItemType;
  onUpdateQuantity: (id: string, quantity: number) => void;
  onRemove: (id: string) => void;
  onSetNotes?: (id: string, notes: string) => void;
  onPrintLabel?: (item: CartItemType) => void | CartItemLabelPrintResult | Promise<void | CartItemLabelPrintResult>;
  onSelectField?: (id: string, field: 'qty' | 'price') => void;
  onEditPrice?: (item: CartItemType) => void;
  onReadScale?: (item: CartItemType) => void;
  scaleBusy?: boolean;
  scaleError?: string | null;
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
  onPrintLabel,
  onSelectField,
  onEditPrice,
  onReadScale,
  scaleBusy,
  scaleError,
  activeField,
  activeBuffer,
  t,
  lang,
}: CartItemProps) {
  const currency = t?.('pos.currency') ?? 'PLN';
  const sellBy = normalizeSellBy(item.sellBy);
  const saleUnit = normalizeSaleUnit({ saleUnit: item.saleUnit, sellBy });
  const perUnit = sellBy === 'WEIGHT'
    ? `/${saleUnit}`
    : (item.saleUnit ? `/${item.saleUnit}` : (t?.('pos.perUnit') ?? '/pc'));
  const tOr = (key: string, fallback: string) => {
    if (!t) return fallback;
    const v = t(key);
    return v !== key ? v : fallback;
  };

  const [editingNotes, setEditingNotes] = useState(false);
  const [notesInput, setNotesInput] = useState(item.notes || '');
  const [labelState, setLabelState] = useState<'idle' | 'printing' | 'printed' | 'error'>('idle');
  const [labelMessage, setLabelMessage] = useState('');
  useEffect(() => { setNotesInput(item.notes || ''); }, [item.notes]);
  useEffect(() => {
    if (labelState === 'idle' || labelState === 'printing') return;
    const timer = window.setTimeout(() => {
      setLabelState('idle');
      setLabelMessage('');
    }, 2200);
    return () => window.clearTimeout(timer);
  }, [labelState]);

  const handleSaveNotes = () => {
    if (onSetNotes) onSetNotes(item.id, notesInput.trim());
    setEditingNotes(false);
  };
  const handlePrintLabel = async () => {
    if (!onPrintLabel || labelState === 'printing') return;
    setLabelState('printing');
    setLabelMessage(tOr('pos.label.printing', 'Đang in mã...'));
    try {
      const result = await onPrintLabel(item);
      if (result?.success === false) {
        setLabelState('error');
        setLabelMessage(result.error || result.message || tOr('pos.label.failed', 'Không in được mã'));
        return;
      }
      setLabelState('printed');
      setLabelMessage(result?.message || tOr('pos.label.printed', 'Đã in mã'));
    } catch (err: any) {
      setLabelState('error');
      setLabelMessage(err?.message || tOr('pos.label.failed', 'Không in được mã'));
    }
  };

  const qtyDisplay = activeField === 'qty' && activeBuffer
    ? activeBuffer
    : formatSaleQuantity(item.quantity, sellBy);
  const priceDisplay = activeField === 'price' && activeBuffer
    ? activeBuffer
    : (item.price / 100).toFixed(2);
  const unitPriceText = `${priceDisplay} ${currency}${perUnit}`;
  const lineTotalText = `${(item.total / 100).toFixed(2)} ${currency}`;
  const formulaQtyText = `${qtyDisplay}${sellBy === 'WEIGHT' ? ` ${saleUnit}` : ''}`;
  const lineFormula = `${unitPriceText} × ${formulaQtyText} = ${lineTotalText}`;

  const qtyHighlight = activeField === 'qty';
  const priceHighlight = activeField === 'price';
  const isActive = !!activeField;

  return (
    <div className={`px-3 py-2 border-b border-slate-100 last:border-b-0 transition-colors ${
      isActive ? 'bg-brand-50' : ''
    }`}>
      <div className="flex items-start justify-between gap-3">
        <p className="flex-1 min-w-0 text-sm font-extrabold text-slate-950 leading-snug line-clamp-1">
          {resolveName(item, lang)}
        </p>
        <span className="text-base font-black text-slate-950 tabular-nums leading-none shrink-0">
          {(item.total / 100).toFixed(2)} <span className="text-xs text-slate-500 font-bold">{currency}</span>
        </span>
      </div>

      <div className="mt-1 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onEditPrice ? onEditPrice(item) : onSelectField?.(item.id, 'price')}
          title={tOr('pos.cart.editPrice', 'Edit price')}
          className={`min-h-8 min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-xs font-bold tabular-nums transition-colors cursor-pointer touch-manipulation ${
            priceHighlight
              ? 'bg-brand-100 text-brand-900 ring-1 ring-brand-400'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <span className="mr-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-[0.08em] text-slate-500">
            {tOr('pos.cart.editPriceShort', 'Price')}
          </span>
          {lineFormula}
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {onPrintLabel && !editingNotes ? (
            <>
              <button
                type="button"
                onClick={handlePrintLabel}
                disabled={labelState === 'printing'}
                aria-label={tOr('pos.cart.printLabel', 'Print label')}
                title={tOr('pos.cart.printLabel', 'Print label')}
                className={`min-h-10 rounded-lg border px-2.5 text-xs font-extrabold cursor-pointer touch-manipulation transition-colors focus:outline-none focus:ring-2 focus:ring-brand-200 inline-flex items-center gap-1.5 ${
                  labelState === 'printing'
                    ? 'border-slate-200 text-slate-400 bg-slate-100 cursor-wait'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-brand-300 hover:text-brand-800 hover:bg-brand-50'
                }`}
              >
                <Printer size={15} strokeWidth={2.4} />
                <span>{labelState === 'printing' ? tOr('pos.label.printingShort', 'Printing') : tOr('pos.cart.printLabelShort', 'Print')}</span>
              </button>
            </>
          ) : onSetNotes && !editingNotes && (
            <button
              type="button"
              onClick={() => setEditingNotes(true)}
              aria-label={item.notes ? tOr('pos.note', 'Note') : tOr('pos.addNote', 'Add note')}
              className={`min-h-10 rounded-lg border px-2.5 text-xs font-extrabold cursor-pointer touch-manipulation transition-colors focus:outline-none focus:ring-2 focus:ring-brand-200 inline-flex items-center gap-1.5 ${
                item.notes
                  ? 'border-brand-300 text-brand-800 bg-brand-50 hover:bg-brand-100'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-brand-300 hover:text-brand-800 hover:bg-brand-50'
              }`}
            >
              {item.notes ? <StickyNote size={14} strokeWidth={2.4} aria-hidden="true" /> : <PencilLine size={14} strokeWidth={2.4} aria-hidden="true" />}
              <span>{item.notes ? tOr('pos.note', 'Note') : tOr('pos.addNoteShort', 'Note')}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {sellBy === 'WEIGHT' && onReadScale && (
            <button
              type="button"
              onClick={() => onReadScale(item)}
              disabled={scaleBusy}
              title={scaleBusy ? tOr('pos.scale.reading', 'Reading scale') : tOr('pos.scale.read', 'Read scale')}
              aria-label={tOr('pos.scale.read', 'Read scale')}
              className="w-10 h-10 flex items-center justify-center rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 active:bg-emerald-200 disabled:opacity-50 disabled:cursor-wait cursor-pointer touch-manipulation transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-200"
            >
              <Scale size={18} strokeWidth={2.4} />
            </button>
          )}
          <div className="inline-flex items-center rounded-lg border border-slate-300 bg-slate-50 overflow-hidden">
            {sellBy !== 'WEIGHT' && (
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
              >-</button>
            )}
            <button
              type="button"
              onClick={() => onSelectField?.(item.id, 'qty')}
              title={tOr('pos.tapToEdit', 'Tap to edit quantity')}
              className={`h-10 min-w-12 px-2 text-center text-sm font-extrabold cursor-pointer transition-colors ${
                sellBy === 'WEIGHT' ? '' : 'border-x'
              } ${
                qtyHighlight
                  ? 'bg-brand-100 text-brand-900 border-brand-400'
                  : 'bg-white text-slate-950 hover:text-brand-700 hover:bg-brand-50 border-slate-300'
              }`}
            >
              {qtyDisplay}{sellBy === 'WEIGHT' ? ` ${saleUnit}` : ''}
            </button>
            {sellBy !== 'WEIGHT' && (
              <button
                type="button"
                onClick={() => onUpdateQuantity(item.id, item.quantity + 1)}
                aria-label="Increase quantity"
                className="w-10 h-10 flex items-center justify-center bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white font-extrabold text-base cursor-pointer touch-manipulation transition-colors"
              >+</button>
            )}
          </div>
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            aria-label={tOr('pos.cart.removeItem', 'Remove item')}
            className="min-h-10 rounded-lg border border-red-200 bg-red-50 px-2.5 text-xs font-extrabold text-red-700 hover:bg-red-100 active:bg-red-200 cursor-pointer touch-manipulation shrink-0 focus:outline-none focus:ring-2 focus:ring-red-200 inline-flex items-center gap-1.5"
          >
            <Trash2 size={14} strokeWidth={2.4} aria-hidden="true" />
            <span>{tOr('pos.cart.remove', 'Remove')}</span>
          </button>
        </div>
      </div>

      {sellBy === 'WEIGHT' && scaleError && (
        <p className="mt-2 text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
          {scaleError}
        </p>
      )}

      {labelState !== 'idle' && labelMessage && (
        <p className={`mt-2 text-xs font-bold rounded-md px-2.5 py-1.5 border ${
          labelState === 'error'
            ? 'text-red-800 bg-red-50 border-red-200'
            : 'text-emerald-800 bg-emerald-50 border-emerald-200'
        }`}>
          {labelMessage}
        </p>
      )}

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
