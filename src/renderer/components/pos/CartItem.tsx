import React, { useEffect, useState } from 'react';
import { Pencil, PencilLine, Printer, Scale, StickyNote, Trash2 } from 'lucide-react';
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
  onEditProduct?: (item: CartItemType) => void;
  onSelectField?: (id: string, field: 'qty' | 'price') => void;
  onEditPrice?: (item: CartItemType) => void;
  onReadScale?: (item: CartItemType) => void;
  scaleBusy?: boolean;
  scaleError?: string | null;
  activeField?: 'qty' | 'price' | null;
  activeBuffer?: string;
  fresh?: boolean;
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
  onEditProduct,
  onSelectField,
  onEditPrice,
  onReadScale,
  scaleBusy,
  scaleError,
  activeField,
  activeBuffer,
  fresh = false,
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
  const unitPriceQtyText = `${unitPriceText} × ${formulaQtyText}`;

  const qtyHighlight = activeField === 'qty';
  const priceHighlight = activeField === 'price';
  const isActive = !!activeField;

  return (
    <div className={`px-3 py-2 border-b border-slate-100 last:border-b-0 transition-colors ${
      isActive ? 'bg-brand-50' : ''
    } ${fresh ? 'sc-cart-item-fresh pos-cart-item-fresh' : ''}`}>
      <div className="flex items-start justify-between space-x-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-extrabold text-slate-950 leading-snug line-clamp-2">
            {resolveName(item, lang)}
          </p>
          {item.locked && item.billiard && (
            <div className="mt-1 -mr-1.5 -mb-1.5 flex flex-wrap items-center text-[10px] font-bold uppercase tracking-wide">
              <span className="mr-1.5 mb-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700">Billiard · {item.billiard.kind}</span>
              <span className="mr-1.5 mb-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">Locked</span>
              {item.billiard.durationMinutes != null && (
                <span className="mr-1.5 mb-1.5 normal-case text-slate-500 tabular-nums">{item.billiard.durationMinutes} min</span>
              )}
            </div>
          )}
        </div>
        <span className="text-base font-black text-slate-950 tabular-nums leading-none shrink-0">
          {lineTotalText}
        </span>
      </div>

      <div className="mt-0.5 flex items-center justify-between">
        <button
          type="button"
          onClick={() => { if (!item.locked) (onEditPrice ? onEditPrice(item) : onSelectField?.(item.id, 'price')); }}
          disabled={item.locked}
          title={tOr('pos.cart.editPrice', 'Edit price')}
          className={`min-h-11 min-w-0 flex-1 truncate rounded-md px-2 py-0.5 text-left text-sm font-semibold tabular-nums transition-colors cursor-pointer touch-manipulation ${
            priceHighlight
              ? 'bg-brand-100 text-brand-900 ring-1 ring-brand-400'
              : item.locked ? 'cursor-not-allowed text-slate-600' : 'text-slate-600 hover:text-brand-800'
          }`}
        >
          {unitPriceQtyText}
        </button>
      </div>

      <div className="mt-1.5 flex items-center justify-between space-x-2">
        <div className="flex min-w-0 items-center space-x-1.5">
          {sellBy === 'WEIGHT' && onReadScale && (
            <button
              type="button"
              onClick={() => onReadScale(item)}
              disabled={scaleBusy || item.locked}
              title={scaleBusy ? tOr('pos.scale.reading', 'Reading scale') : tOr('pos.scale.read', 'Read scale')}
              aria-label={tOr('pos.scale.read', 'Read scale')}
              className="w-11 h-11 flex items-center justify-center rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 active:bg-emerald-200 disabled:opacity-50 disabled:cursor-wait cursor-pointer touch-manipulation transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200"
            >
              <Scale size={18} strokeWidth={2.4} />
            </button>
          )}
          <div className="inline-flex h-12 items-center rounded-lg border border-slate-300 bg-slate-50 overflow-hidden">
            {sellBy !== 'WEIGHT' && (
              <button
                type="button"
                onClick={() => !item.locked && item.quantity > 1 && onUpdateQuantity(item.id, item.quantity - 1)}
                disabled={item.locked || item.quantity <= 1}
                aria-label="Decrease quantity"
                className={`w-12 h-12 flex items-center justify-center font-extrabold text-base touch-manipulation transition-colors ${
                  item.locked || item.quantity <= 1
                    ? 'text-slate-300 cursor-not-allowed'
                    : 'text-slate-700 hover:bg-slate-100 active:bg-slate-200 cursor-pointer'
                }`}
              >-</button>
            )}
            <button
              type="button"
              onClick={() => { if (!item.locked) onSelectField?.(item.id, 'qty'); }}
              disabled={item.locked}
              title={tOr('pos.tapToEdit', 'Tap to edit quantity')}
              className={`h-12 min-w-14 px-2 text-center text-sm font-extrabold cursor-pointer transition-colors ${
                sellBy === 'WEIGHT' ? '' : 'border-x'
              } ${
                item.locked
                  ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-700'
                  : qtyHighlight
                  ? 'bg-brand-100 text-brand-900 border-brand-400'
                  : 'bg-white text-slate-950 hover:text-brand-700 hover:bg-brand-50 border-slate-300'
              }`}
            >
              {qtyDisplay}{sellBy === 'WEIGHT' ? ` ${saleUnit}` : ''}
            </button>
            {sellBy !== 'WEIGHT' && (
              <button
                type="button"
                onClick={() => { if (!item.locked) onUpdateQuantity(item.id, item.quantity + 1); }}
                disabled={item.locked}
                aria-label="Increase quantity"
                className="w-12 h-12 flex items-center justify-center bg-slate-900 hover:bg-black active:bg-slate-800 text-white font-extrabold text-base cursor-pointer touch-manipulation transition-colors disabled:cursor-not-allowed disabled:bg-slate-300"
              >+</button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center space-x-1.5">
          {!item.locked && onPrintLabel && !editingNotes ? (
            <>
              <button
                type="button"
                onClick={handlePrintLabel}
                disabled={labelState === 'printing'}
                aria-label={tOr('pos.cart.printLabel', 'Print label')}
                title={tOr('pos.cart.printLabel', 'Print label')}
                className={`h-11 rounded-lg border px-2 text-xs font-bold cursor-pointer touch-manipulation transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 inline-flex items-center space-x-1.5 ${
                  labelState === 'printing'
                    ? 'border-slate-200 text-slate-400 bg-slate-100 cursor-wait'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:text-brand-800 hover:bg-brand-50'
                }`}
              >
                <Printer size={15} strokeWidth={2.4} />
                <span>{labelState === 'printing' ? tOr('pos.label.printingShort', 'Printing') : tOr('pos.cart.printLabelShort', 'Print')}</span>
              </button>
            </>
          ) : !item.locked && onSetNotes && !editingNotes && (
            <button
              type="button"
              onClick={() => setEditingNotes(true)}
              aria-label={item.notes ? tOr('pos.note', 'Note') : tOr('pos.addNote', 'Add note')}
              className={`h-11 rounded-lg border px-2 text-xs font-bold cursor-pointer touch-manipulation transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 inline-flex items-center space-x-1.5 ${
                item.notes
                  ? 'border-brand-300 text-brand-800 bg-brand-50 hover:bg-brand-100'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:text-brand-800 hover:bg-brand-50'
              }`}
            >
              {item.notes ? <StickyNote size={14} strokeWidth={2.4} aria-hidden="true" /> : <PencilLine size={14} strokeWidth={2.4} aria-hidden="true" />}
              <span>{item.notes ? tOr('pos.note', 'Note') : tOr('pos.addNoteShort', 'Note')}</span>
            </button>
          )}
          {/* Icon-only on purpose: this row already carries Print and Remove as
              text buttons, and the cart column is 296px (360px at xl). A third
              label ("Sửa sản phẩm", "Edytuj produkt") overflows the row, and the
              quantity stepper — overflow-hidden — is what gets clipped. */}
          {!item.locked && onEditProduct && item.variantId ? (
            <button
              type="button"
              onClick={() => onEditProduct(item)}
              aria-label={tOr('pos.cart.editProduct', 'Edit product')}
              title={tOr('pos.cart.editProduct', 'Edit product')}
              className="h-11 w-11 rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 cursor-pointer touch-manipulation shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 inline-flex items-center justify-center"
            >
              <Pencil size={16} strokeWidth={2.4} aria-hidden="true" />
            </button>
          ) : null}
          {!item.locked && <button
            type="button"
            onClick={() => onRemove(item.id)}
            aria-label={tOr('pos.cart.removeItem', 'Remove item')}
            className="h-11 rounded-lg border border-red-100 bg-white px-2 text-xs font-bold text-red-600 hover:border-red-200 hover:bg-red-50 active:bg-red-100 cursor-pointer touch-manipulation shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-200 inline-flex items-center space-x-1.5"
          >
            <Trash2 size={14} strokeWidth={2.4} aria-hidden="true" />
            <span>{tOr('pos.cart.remove', 'Remove')}</span>
          </button>}
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
          <div className="mt-2 flex space-x-2">
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
