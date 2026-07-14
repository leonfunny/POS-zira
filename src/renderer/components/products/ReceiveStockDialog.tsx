import React, { useMemo, useRef, useState } from 'react';
import {
  classifyProductSale,
  type ProductSaleClassifiable,
} from '../../../shared/product-sale-classifier';
import type {
  ProductAdminReceiveStockInput,
  ProductAdminReceiveStockResponse,
} from '../../../shared/types';
import type { ProductListItem } from '../../hooks/useProducts';
import Modal from '../shared/Modal';
import { sanitizeDecimalText } from './decimal-input';
import {
  completeCommittedMutation,
  createImmutableMutationAttemptStore,
  createMutationOutcomeTracker,
} from './mutation-idempotency';

interface ReceiveStockDialogProps {
  product: ProductListItem;
  canEnterUnitCost: boolean;
  t: (key: string) => string;
  onClose: () => void;
  onReceived: (result: ProductAdminReceiveStockResponse) => Promise<void> | void;
}

const MAX_RECEIVE_QUANTITY = 9_999_999;
type ReceiveStockAttempt = Omit<ProductAdminReceiveStockInput, 'idempotencyKey'> & {
  variantId: string;
};

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function expiryPreset(base: Date, amount: number, unit: 'days' | 'months'): string {
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  if (unit === 'days') next.setDate(next.getDate() + amount);
  else {
    const originalDay = next.getDate();
    const targetMonthStart = new Date(next.getFullYear(), next.getMonth() + amount, 1);
    const lastDay = new Date(
      targetMonthStart.getFullYear(),
      targetMonthStart.getMonth() + 1,
      0,
    ).getDate();
    next.setFullYear(targetMonthStart.getFullYear(), targetMonthStart.getMonth(), Math.min(originalDay, lastDay));
  }
  return localIsoDate(next);
}

function parseQuantity(value: string, weighted: boolean): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (!weighted && !Number.isInteger(parsed)) return null;
  const fraction = normalized.split('.')[1] || '';
  if (weighted && fraction.length > 3) return null;
  return weighted ? Math.round(parsed * 1000) / 1000 : parsed;
}

export function receiveUnitCostGrosze(value: string, canEnterUnitCost: boolean): number | null | undefined {
  if (!canEnterUnitCost) return null;
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed * 100);
}

export function isWeightedReceiptProduct(product: ProductSaleClassifiable): boolean {
  return classifyProductSale(product).isWeighted;
}

export default function ReceiveStockDialog({
  product,
  canEnterUnitCost,
  t,
  onClose,
  onReceived,
}: ReceiveStockDialogProps) {
  const session = useRef({
    variantId: product.id,
    expectedUpdatedAt: product.updated_at || undefined,
    weighted: isWeightedReceiptProduct(product),
  }).current;
  const weighted = session.weighted;
  const [quantity, setQuantity] = useState('1');
  const [unitCost, setUnitCost] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [expirationDate, setExpirationDate] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [attemptDispatched, setAttemptDispatched] = useState(false);
  const mutationAttemptStore = useRef(createImmutableMutationAttemptStore<ReceiveStockAttempt>());
  const mutationOutcomeTracker = useRef(createMutationOutcomeTracker());
  const today = useMemo(() => localIsoDate(new Date()), []);

  const validate = (): { parsedQuantity: number; parsedUnitCost: number | null } | string => {
    const parsedQuantity = parseQuantity(quantity, weighted);
    if (parsedQuantity === null) {
      return weighted
        ? tOr(t, 'products.receive.quantityWeightInvalid', 'Enter a positive kg quantity with up to 3 decimal places')
        : tOr(t, 'products.receive.quantityPieceInvalid', 'Piece quantity must be a positive whole number');
    }
    if (parsedQuantity > MAX_RECEIVE_QUANTITY) {
      return tOr(t, 'products.receive.quantityTooLarge', 'Quantity cannot exceed 9,999,999');
    }
    const parsedUnitCost = receiveUnitCostGrosze(unitCost, canEnterUnitCost);
    if (parsedUnitCost === undefined) {
      return tOr(t, 'products.receive.costInvalid', 'Enter a valid unit cost with up to 2 decimal places');
    }
    if (expirationDate && expirationDate < today) {
      return tOr(t, 'products.receive.expiryPast', 'Expiry date cannot be in the past for a new receipt');
    }
    return { parsedQuantity, parsedUnitCost };
  };

  const submit = async () => {
    let attempt = mutationAttemptStore.current.current();
    if (!attempt) {
      const validation = validate();
      if (typeof validation === 'string') {
        setMessage({ ok: false, text: validation });
        return;
      }

      const trimmedLot = lotNumber.trim();
      const trimmedReason = reason.trim();
      attempt = mutationAttemptStore.current.dispatch({
        variantId: session.variantId,
        quantity: validation.parsedQuantity,
        unitCostGrosze: validation.parsedUnitCost ?? undefined,
        lotNumber: trimmedLot || undefined,
        expirationDate: expirationDate || undefined,
        reason: trimmedReason || undefined,
        expectedUpdatedAt: session.expectedUpdatedAt,
      });
      setAttemptDispatched(true);
    }

    const { variantId, idempotencyKey, ...body } = attempt;

    setBusy(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.pos.productAdmin.receiveStock(variantId, {
        ...body,
        idempotencyKey,
      });
      if (!result?.ok || !result.data) {
        if (mutationOutcomeTracker.current.shouldRelease(result)) {
          mutationAttemptStore.current.clear();
          mutationOutcomeTracker.current.clear();
          setAttemptDispatched(false);
        }
        setMessage({
          ok: false,
          text: result?.error || result?.code || tOr(t, 'products.receive.failed', 'Could not receive stock'),
        });
        return;
      }
      await completeCommittedMutation(
        () => onReceived(result.data!),
        () => {
          mutationAttemptStore.current.clear();
          mutationOutcomeTracker.current.clear();
          onClose();
        },
      );
    } catch (error) {
      mutationOutcomeTracker.current.markAmbiguous();
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : tOr(t, 'products.receive.failed', 'Could not receive stock'),
      });
    } finally {
      setBusy(false);
    }
  };

  const requestClose = () => {
    if (busy || mutationAttemptStore.current.current()) return;
    onClose();
  };

  const presets: Array<{ amount: number; unit: 'days' | 'months'; label: string }> = [
    { amount: 7, unit: 'days', label: '+7d' },
    { amount: 14, unit: 'days', label: '+14d' },
    { amount: 30, unit: 'days', label: '+30d' },
    { amount: 3, unit: 'months', label: '+3m' },
    { amount: 6, unit: 'months', label: '+6m' },
    { amount: 12, unit: 'months', label: '+12m' },
  ];

  return (
    <Modal
      open
      keyboardAware
      size="lg"
      zLayer="nested"
      title={tOr(t, 'products.receive.title', 'Receive stock batch')}
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
            {tOr(t, 'products.edit.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="h-11 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy
              ? tOr(t, 'products.receive.saving', 'Receiving...')
              : attemptDispatched
                ? tOr(t, 'products.mutation.retry', 'Retry exact request')
                : tOr(t, 'products.receive.submit', 'Receive batch')}
          </button>
        </div>
      )}
    >
      <div className="space-y-4 p-4">
        <p className="text-sm text-slate-600">
          {tOr(t, 'products.receive.description', 'Add stock to a real lot so quantity, cost, and expiry stay auditable together.')}
        </p>
        {attemptDispatched ? (
          <div role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {tOr(t, 'products.mutation.retryLocked', 'The previous request may have reached the server. Editing and closing are locked; retry the exact request.')}
          </div>
        ) : null}

        <div className={`grid grid-cols-1 gap-3 ${canEnterUnitCost ? 'sm:grid-cols-2' : ''}`}>
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {weighted
                ? tOr(t, 'products.receive.quantityKg', 'Quantity (kg)')
                : tOr(t, 'products.receive.quantityPieces', 'Quantity (pcs)')}
            </span>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={quantity}
              onChange={(event) => setQuantity(sanitizeDecimalText(event.target.value))}
              disabled={attemptDispatched}
              className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
              autoFocus
            />
          </label>
          {canEnterUnitCost ? (
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.receive.unitCost', 'Unit purchase cost (optional)')}
              </span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={unitCost}
                onChange={(event) => setUnitCost(sanitizeDecimalText(event.target.value))}
                disabled={attemptDispatched}
                placeholder="0.00"
                className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
              />
            </label>
          ) : null}
        </div>

        <label className="block">
          <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
            {tOr(t, 'products.receive.lotNumber', 'Lot number (optional)')}
          </span>
          <input
            value={lotNumber}
            onChange={(event) => setLotNumber(event.target.value)}
            disabled={attemptDispatched}
            maxLength={100}
            className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
          />
        </label>

        <div>
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.receive.expiry', 'Expiry date (optional)')}
            </span>
            <input
              type="date"
              min={today}
              value={expirationDate}
              onChange={(event) => setExpirationDate(event.target.value)}
              disabled={attemptDispatched}
              className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500"
            />
          </label>
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {presets.map((preset) => (
              <button
                key={`${preset.amount}-${preset.unit}`}
                type="button"
                onClick={() => setExpirationDate(expiryPreset(new Date(), preset.amount, preset.unit))}
                disabled={attemptDispatched}
                className="h-11 rounded-md border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
            {tOr(t, 'products.receive.note', 'Delivery note (optional)')}
          </span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={attemptDispatched}
            maxLength={255}
            className="min-h-[80px] w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
          />
        </label>

        {message ? (
          <div role={message.ok ? 'status' : 'alert'} className={`rounded-md border px-3 py-2 text-sm ${
            message.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}>
            {message.text}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
