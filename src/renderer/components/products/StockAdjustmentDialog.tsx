import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProductAdminStockAdjustmentInput,
  ProductAdminStockAdjustmentResponse,
  ProductStockAdjustmentMode,
} from '../../../shared/types';
import { classifyProductSale } from '../../../shared/product-sale-classifier';
import type { ProductListItem } from '../../hooks/useProducts';
import Modal from '../shared/Modal';
import { sanitizeDecimalText } from './decimal-input';
import {
  completeCommittedMutation,
  createImmutableMutationAttemptStore,
  createMutationOutcomeTracker,
} from './mutation-idempotency';

interface StockAdjustmentDialogProps {
  product: ProductListItem;
  allowReceive?: boolean;
  t: (key: string) => string;
  onClose: () => void;
  onAdjusted: (result: ProductAdminStockAdjustmentResponse) => Promise<void> | void;
}

interface StockAdjustmentModeOption {
  value: ProductStockAdjustmentMode;
  labelKey: string;
  fallback: string;
}

type StockAdjustmentAttempt = Omit<ProductAdminStockAdjustmentInput, 'idempotencyKey'> & {
  variantId: string;
};

export function stockAdjustmentModes({
  allowReceive = true,
}: {
  allowReceive?: boolean;
}): StockAdjustmentModeOption[] {
  const modes: StockAdjustmentModeOption[] = [
    { value: 'receive', labelKey: 'products.stock.mode.receive', fallback: 'Receive stock' },
    { value: 'recount', labelKey: 'products.stock.mode.recount', fallback: 'Recount' },
    { value: 'damage', labelKey: 'products.stock.mode.damage', fallback: 'Damaged' },
    { value: 'loss', labelKey: 'products.stock.mode.loss', fallback: 'Lost' },
    { value: 'return', labelKey: 'products.stock.mode.return', fallback: 'Customer return' },
  ];
  return allowReceive ? modes : modes.filter((mode) => mode.value !== 'receive');
}

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

export function currentStock(product: ProductListItem): number {
  return Number(product.in_stock ?? product.available_qty ?? 0) || 0;
}

export function parseStockAdjustmentQuantity(
  value: string,
  sellBy: 'PIECE' | 'WEIGHT',
): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (sellBy === 'PIECE') return Number.isInteger(parsed) ? parsed : null;
  const [, fraction = ''] = normalized.split('.');
  if (fraction.length > 3) return null;
  return Math.round(parsed * 1000) / 1000;
}

export default function StockAdjustmentDialog({
  product,
  allowReceive = true,
  t,
  onClose,
  onAdjusted,
}: StockAdjustmentDialogProps) {
  const session = useRef({
    variantId: product.id,
    expectedUpdatedAt: product.updated_at || undefined,
    stockBefore: currentStock(product),
    sellBy: classifyProductSale(product).sellBy,
  }).current;
  const [mode, setMode] = useState<ProductStockAdjustmentMode>(allowReceive ? 'receive' : 'recount');
  const [quantity, setQuantity] = useState('1');
  const [newQuantity, setNewQuantity] = useState(String(session.stockBefore));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [attemptDispatched, setAttemptDispatched] = useState(false);
  const mutationAttemptStore = useRef(createImmutableMutationAttemptStore<StockAdjustmentAttempt>());
  const mutationOutcomeTracker = useRef(createMutationOutcomeTracker());
  const sellBy = session.sellBy;

  useEffect(() => {
    if (!attemptDispatched && !allowReceive && mode === 'receive') setMode('recount');
  }, [allowReceive, attemptDispatched, mode]);

  const stockBefore = session.stockBefore;
  const stockAfter = useMemo(() => {
    const qty = parseStockAdjustmentQuantity(quantity, sellBy);
    const next = parseStockAdjustmentQuantity(newQuantity, sellBy);
    if (mode === 'recount') return next ?? stockBefore;
    if (qty === null) return stockBefore;
    if (mode === 'receive' || mode === 'return') return stockBefore + qty;
    return stockBefore - qty;
  }, [mode, newQuantity, quantity, sellBy, stockBefore]);

  const validate = (): string | null => {
    if (mode === 'recount') {
      const next = parseStockAdjustmentQuantity(newQuantity, sellBy);
      if (next === null) {
        return tOr(t, 'products.stock.quantityInvalid', 'Enter a valid quantity');
      }
      return null;
    }
    const qty = parseStockAdjustmentQuantity(quantity, sellBy);
    if (qty === null || qty <= 0) {
      return tOr(t, 'products.stock.quantityInvalid', 'Enter a valid quantity');
    }
    if (stockAfter < 0) return tOr(t, 'products.stock.negativeResult', 'Stock cannot go below zero');
    return null;
  };

  const handleSubmit = async () => {
    let attempt = mutationAttemptStore.current.current();
    if (!attempt) {
      const validationError = validate();
      if (validationError) {
        setMessage({ ok: false, text: validationError });
        return;
      }

      const trimmedNote = note.trim();
      const parsedQuantity = parseStockAdjustmentQuantity(quantity, sellBy);
      const parsedNewQuantity = parseStockAdjustmentQuantity(newQuantity, sellBy);
      attempt = mutationAttemptStore.current.dispatch({
        variantId: session.variantId,
        mode,
        quantity: mode === 'recount' ? undefined : parsedQuantity ?? undefined,
        newQuantity: mode === 'recount' ? parsedNewQuantity ?? undefined : undefined,
        reason: trimmedNote || undefined,
        expectedUpdatedAt: session.expectedUpdatedAt,
      });
      setAttemptDispatched(true);
    }

    const { variantId, idempotencyKey, ...body } = attempt;

    setBusy(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.pos.productAdmin.adjustStock(variantId, {
        ...body,
        idempotencyKey,
      });

      if (!result?.ok) {
        if (mutationOutcomeTracker.current.shouldRelease(result)) {
          mutationAttemptStore.current.clear();
          mutationOutcomeTracker.current.clear();
          setAttemptDispatched(false);
        }
        setMessage({
          ok: false,
          text: result?.error || result?.code || tOr(t, 'products.stock.failed', 'Could not adjust stock'),
        });
        return;
      }

      setMessage({ ok: true, text: tOr(t, 'products.stock.success', 'Stock updated') });
      await completeCommittedMutation(
        () => (result.data ? onAdjusted(result.data) : undefined),
        () => {
          mutationAttemptStore.current.clear();
          mutationOutcomeTracker.current.clear();
          onClose();
        },
      );
    } catch (err: any) {
      mutationOutcomeTracker.current.markAmbiguous();
      setMessage({ ok: false, text: err?.message || tOr(t, 'products.stock.failed', 'Could not adjust stock') });
    } finally {
      setBusy(false);
    }
  };

  const requestClose = () => {
    if (busy || mutationAttemptStore.current.current()) return;
    onClose();
  };

  const modeOptions = stockAdjustmentModes({ allowReceive });

  return (
    <Modal
      open
      size="md"
      zLayer="nested"
      title={tOr(t, 'products.stock.dialogTitle', 'Adjust stock')}
      onClose={requestClose}
      busy={busy}
      closeLabel={tOr(t, 'products.drawer.close', 'Close')}
      footer={(
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={requestClose}
            disabled={busy || attemptDispatched}
            className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {tOr(t, 'products.drawer.close', 'Close')}
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={busy}
            className="h-11 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy
              ? tOr(t, 'products.stock.saving', 'Saving...')
              : attemptDispatched
                ? tOr(t, 'products.mutation.retry', 'Retry exact request')
                : tOr(t, 'products.stock.submit', 'Save stock')}
          </button>
        </div>
      )}
    >

        <div className="space-y-4 p-4">
          {attemptDispatched ? (
            <div role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {tOr(t, 'products.mutation.retryLocked', 'The previous request may have reached the server. Editing and closing are locked; retry the exact request.')}
            </div>
          ) : null}
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
                  disabled={attemptDispatched}
                  className={`h-11 rounded-md border px-3 text-sm font-medium transition duration-150 motion-reduce:transition-none ${
                    mode === option.value
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {tOr(t, option.labelKey, option.fallback)}
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
                type="text"
                inputMode="decimal"
                min="0"
                step={sellBy === 'WEIGHT' ? '0.001' : '1'}
                value={newQuantity}
                onChange={(event) => setNewQuantity(sanitizeDecimalText(event.target.value))}
                disabled={attemptDispatched}
                className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
              />
            </label>
          ) : (
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.stock.quantity', 'Quantity')}
              </span>
              <input
                type="text"
                inputMode="decimal"
                min="0"
                step={sellBy === 'WEIGHT' ? '0.001' : '1'}
                value={quantity}
                onChange={(event) => setQuantity(sanitizeDecimalText(event.target.value))}
                disabled={attemptDispatched}
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
              disabled={attemptDispatched}
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
    </Modal>
  );
}
