import React, { useRef, useState } from 'react';
import type { Product } from '../../hooks/usePosDb';
import type { ProductSaleClassification } from '../../../shared/product-sale-classifier';
import { isValidManualWeightQuantity } from '../../../shared/pos-sale';
import Modal from '../shared/Modal';

export interface ManualWeightPrompt {
  product: Product;
  saleClass: ProductSaleClassification;
  displayName: string;
  error?: string;
}

interface Props {
  prompt: ManualWeightPrompt;
  tOr: (key: string, fallback: string) => string;
  onClose: () => void;
  onSubmit: (weightKg: number) => void | Promise<void>;
  dark?: boolean;
}

export default function ManualWeightModal({ prompt, tOr, onClose, onSubmit, dark = false }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const unit = prompt.saleClass.saleUnit || 'kg';
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    const normalized = value.trim().replace(',', '.');
    const weightKg = /^\d*(?:\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
    if (!isValidManualWeightQuantity(weightKg)) {
      setError(tOr('pos.scale.manualWeightInvalid', 'Enter a valid weight'));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try { await onSubmit(weightKg); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return (
    <Modal title={tOr('pos.scale.manualWeightTitle', 'Manual weight')} size="sm" keyboardAware busy={busy}
      closeLabel={tOr('common.close', 'Close')} onClose={onClose}
      panelClassName={dark ? 'restaurant-weight-modal' : ''} bodyClassName="p-4">
      <form onSubmit={submit}>
        <p className="text-sm font-semibold break-words">{prompt.displayName}</p>
        {prompt.error && <p className="mt-1 text-sm text-amber-700">{prompt.error}</p>}
        <label className="block mt-4">
          <span className="text-sm font-bold">{unit}</span>
          <input autoFocus disabled={busy} value={value}
            onChange={event => { setValue(event.target.value); setError(null); }}
            inputMode="decimal" placeholder="0.000"
            className="mt-1 w-full h-12 rounded-md border border-slate-300 px-3 text-lg font-bold tabular-nums text-slate-900 focus:ring-2 focus:ring-emerald-400" />
        </label>
        {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose}
            className="min-h-11 px-4 rounded-md border border-slate-300 text-sm font-semibold">
            {tOr('common.cancel', 'Cancel')}
          </button>
          <button type="submit" disabled={busy}
            className="min-h-11 px-4 rounded-md bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50">
            {busy ? tOr('common.loading', 'Loading…') : tOr('pos.scale.addManualWeight', 'Add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
