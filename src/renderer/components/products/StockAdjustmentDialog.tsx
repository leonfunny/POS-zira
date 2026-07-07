import React, { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { ProductStockAdjustmentMode } from '../../../shared/types';
import type { ProductListItem } from '../../hooks/useProducts';

interface StockAdjustmentDialogProps {
  product: ProductListItem;
  t: (key: string) => string;
  onClose: () => void;
  onAdjusted: () => Promise<void> | void;
}

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function currentStock(product: ProductListItem): number {
  return Number(product.available_qty ?? product.in_stock ?? 0) || 0;
}

function makeIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `stock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function StockAdjustmentDialog({
  product,
  t,
  onClose,
  onAdjusted,
}: StockAdjustmentDialogProps) {
  const [mode, setMode] = useState<ProductStockAdjustmentMode>('receive');
  const [quantity, setQuantity] = useState('1');
  const [newQuantity, setNewQuantity] = useState(String(currentStock(product)));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const stockBefore = currentStock(product);
  const stockAfter = useMemo(() => {
    const qty = Number(quantity);
    const next = Number(newQuantity);
    if (mode === 'recount') return Number.isFinite(next) ? next : stockBefore;
    if (!Number.isFinite(qty)) return stockBefore;
    if (mode === 'receive' || mode === 'return') return stockBefore + qty;
    return stockBefore - qty;
  }, [mode, newQuantity, quantity, stockBefore]);

  const validate = (): string | null => {
    if (mode === 'recount') {
      const next = Number(newQuantity);
      if (!Number.isFinite(next) || next < 0) {
        return tOr(t, 'products.stock.quantityInvalid', 'Enter a valid quantity');
      }
      return null;
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return tOr(t, 'products.stock.quantityInvalid', 'Enter a valid quantity');
    }
    if (stockAfter < 0) return tOr(t, 'products.stock.negativeResult', 'Stock cannot go below zero');
    return null;
  };

  const handleSubmit = async () => {
    const validationError = validate();
    if (validationError) {
      setMessage({ ok: false, text: validationError });
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const trimmedNote = note.trim();
      const result = await window.electronAPI.pos.productAdmin.adjustStock(product.id, {
        mode,
        quantity: mode === 'recount' ? undefined : Number(quantity),
        newQuantity: mode === 'recount' ? Number(newQuantity) : undefined,
        reason: trimmedNote || undefined,
        expectedUpdatedAt: product.updated_at || undefined,
        idempotencyKey: makeIdempotencyKey(),
      });

      if (!result?.ok) {
        setMessage({
          ok: false,
          text: result?.error || result?.code || tOr(t, 'products.stock.failed', 'Could not adjust stock'),
        });
        return;
      }

      setMessage({ ok: true, text: tOr(t, 'products.stock.success', 'Stock updated') });
      await onAdjusted();
      onClose();
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message || tOr(t, 'products.stock.failed', 'Could not adjust stock') });
    } finally {
      setBusy(false);
    }
  };

  const modeOptions: Array<{ value: ProductStockAdjustmentMode; label: string }> = [
    { value: 'receive', label: tOr(t, 'products.stock.mode.receive', 'Receive stock') },
    { value: 'recount', label: tOr(t, 'products.stock.mode.recount', 'Recount') },
    { value: 'damage', label: tOr(t, 'products.stock.mode.damage', 'Damaged') },
    { value: 'loss', label: tOr(t, 'products.stock.mode.loss', 'Lost') },
    { value: 'return', label: tOr(t, 'products.stock.mode.return', 'Customer return') },
  ];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/45 px-4" onClick={onClose}>
      <section
        className="w-full max-w-[440px] rounded-lg bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        aria-label={tOr(t, 'products.stock.dialogTitle', 'Adjust stock')}
      >
        <header className="flex min-h-14 items-center justify-between border-b border-slate-200 px-4">
          <h3 className="text-base font-semibold text-slate-950">
            {tOr(t, 'products.stock.dialogTitle', 'Adjust stock')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            title={tOr(t, 'products.drawer.close', 'Close')}
          >
            <X size={18} />
          </button>
        </header>

        <div className="space-y-4 p-4">
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.stock.mode', 'Mode')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {modeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setMode(option.value)}
                  className={`h-11 rounded-md border px-3 text-sm font-medium transition ${
                    mode === option.value
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {mode === 'recount' ? (
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.stock.newQuantity', 'Actual quantity')}
              </span>
              <input
                type="number"
                min="0"
                step="1"
                value={newQuantity}
                onChange={(event) => setNewQuantity(event.target.value)}
                className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
              />
            </label>
          ) : (
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.stock.quantity', 'Quantity')}
              </span>
              <input
                type="number"
                min="0"
                step="1"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
              />
            </label>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-semibold uppercase text-slate-500">{tOr(t, 'products.stock.current', 'Current')}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-slate-950">{stockBefore}</div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-semibold uppercase text-slate-500">{tOr(t, 'products.stock.after', 'After')}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-slate-950">{Number.isFinite(stockAfter) ? stockAfter : '-'}</div>
            </div>
          </div>

          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.stock.noteOptional', 'Note (optional)')}
            </span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={tOr(t, 'products.stock.notePlaceholder', 'Delivery, recount, damaged package...')}
              className="min-h-[84px] w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
            />
          </label>

          {message ? (
            <div className={`rounded-md border px-3 py-2 text-sm ${
              message.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'
            }`}>
              {message.text}
            </div>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100"
          >
            {tOr(t, 'products.drawer.close', 'Close')}
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={busy}
            className="h-11 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? tOr(t, 'products.stock.saving', 'Saving...') : tOr(t, 'products.stock.submit', 'Save stock')}
          </button>
        </footer>
      </section>
    </div>
  );
}
