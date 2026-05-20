import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { ProductListItem } from '../../hooks/useProducts';

interface DeactivateProductDialogProps {
  product: ProductListItem;
  t: (key: string) => string;
  onClose: () => void;
  onDeactivated: () => Promise<void> | void;
}

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

export default function DeactivateProductDialog({
  product,
  t,
  onClose,
  onDeactivated,
}: DeactivateProductDialogProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const handleDeactivate = async () => {
    if (!reason.trim()) {
      setMessage({ ok: false, text: tOr(t, 'products.deactivate.reasonRequired', 'Enter a reason') });
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.pos.productAdmin.deactivateVariant(product.id, {
        reason: reason.trim(),
        expectedUpdatedAt: product.updated_at || undefined,
      });

      if (!result?.ok) {
        setMessage({
          ok: false,
          text: result?.error || result?.code || tOr(t, 'products.deactivate.failed', 'Could not stop selling product'),
        });
        return;
      }

      setMessage({ ok: true, text: tOr(t, 'products.deactivate.success', 'Product stopped') });
      await onDeactivated();
      onClose();
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message || tOr(t, 'products.deactivate.failed', 'Could not stop selling product') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/45 px-4" onClick={onClose}>
      <section
        className="w-full max-w-[420px] rounded-lg bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        aria-label={tOr(t, 'products.deactivate.title', 'Stop selling')}
      >
        <header className="flex min-h-14 items-center justify-between border-b border-slate-200 px-4">
          <h3 className="text-base font-semibold text-slate-950">
            {tOr(t, 'products.deactivate.title', 'Stop selling')}
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
          <p className="text-sm text-slate-600">
            {tOr(t, 'products.deactivate.description', 'This hides the product from POS sales but keeps old orders and receipts intact.')}
          </p>
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.deactivate.reason', 'Reason')}
            </span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={tOr(t, 'products.deactivate.reasonPlaceholder', 'No longer sold, duplicate item...')}
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
            {tOr(t, 'products.edit.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleDeactivate()}
            disabled={busy}
            className="h-11 rounded-md bg-rose-600 px-4 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? tOr(t, 'products.deactivate.saving', 'Saving...') : tOr(t, 'products.deactivate.confirm', 'Stop selling')}
          </button>
        </footer>
      </section>
    </div>
  );
}
