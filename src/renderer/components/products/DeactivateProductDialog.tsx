import React, { useState } from 'react';
import type { ProductListItem } from '../../hooks/useProducts';
import Modal from '../shared/Modal';

interface DeactivateProductDialogProps {
  product: ProductListItem;
  t: (key: string) => string;
  isProductInCart?: boolean;
  onClose: () => void;
  onDeactivated: () => Promise<void> | void;
  onStaleProductHidden?: () => Promise<void> | void;
}

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

export default function DeactivateProductDialog({
  product,
  t,
  isProductInCart = false,
  onClose,
  onDeactivated,
  onStaleProductHidden,
}: DeactivateProductDialogProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const productIsInCart = async (): Promise<boolean> => {
    if (isProductInCart) return true;
    try {
      const state = await window.electronAPI.pos.getState();
      return (state?.cart?.items || []).some((item: any) => item?.variantId === product.id);
    } catch {
      return false;
    }
  };

  const failureMessage = (result: { code?: string; error?: string; status?: number } | null | undefined): string => {
    const code = String(result?.code || '').toUpperCase();
    const error = String(result?.error || '').toUpperCase();
    if (code === 'STALE_PRODUCT' || result?.status === 409 || error.includes('STALE_PRODUCT')) {
      return tOr(t, 'products.deactivate.stale', 'Product changed. Refresh the product and try again.');
    }
    if (code === 'UNAUTHORIZED_PRODUCT_ADMIN' || result?.status === 401 || result?.status === 403 || error.includes('UNAUTHORIZED') || error.includes('FORBIDDEN')) {
      return tOr(t, 'products.deactivate.permissionRequired', 'Manager permission is required to hide products.');
    }
    if (code === 'UNSUPPORTED_CAPABILITY') {
      return tOr(t, 'products.deactivate.permissionRequired', 'Manager permission is required to hide products.');
    }
    if (code === 'PRODUCT_NOT_FOUND' || result?.status === 404 || error.includes('HTTP 404')) {
      return tOr(t, 'products.deactivate.notFound', 'Product was not found on the backend.');
    }
    return result?.error || result?.code || tOr(t, 'products.deactivate.failed', 'Could not hide product');
  };

  const isNotFound = (result: { code?: string; error?: string; status?: number } | null | undefined): boolean => {
    const code = String(result?.code || '').toUpperCase();
    const error = String(result?.error || '').toUpperCase();
    return code === 'PRODUCT_NOT_FOUND' || result?.status === 404 || error.includes('HTTP 404');
  };

  const handleDeactivate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (await productIsInCart()) {
        setMessage({
          ok: false,
          text: tOr(t, 'products.deactivate.inCart', 'Remove this product from cart before hiding it.'),
        });
        return;
      }

      const trimmedReason = reason.trim();
      const result = await window.electronAPI.pos.productAdmin.deactivateVariant(product.id, {
        expectedUpdatedAt: product.updated_at || undefined,
        reason: trimmedReason || 'Hidden from POS',
      });

      if (!result?.ok) {
        if (isNotFound(result) && onStaleProductHidden) {
          await onStaleProductHidden();
          onClose();
          return;
        }
        setMessage({
          ok: false,
          text: failureMessage(result),
        });
        return;
      }

      await onDeactivated();
      onClose();
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message || tOr(t, 'products.deactivate.failed', 'Could not hide product') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      size="md"
      zLayer="nested"
      title={tOr(t, 'products.deactivate.hideTitle', 'Hide product?')}
      onClose={onClose}
      busy={busy}
      closeLabel={tOr(t, 'products.drawer.close', 'Close')}
      footer={(
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {tOr(t, 'products.edit.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleDeactivate()}
            disabled={busy}
            className="h-11 rounded-md bg-rose-600 px-4 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? tOr(t, 'products.deactivate.saving', 'Saving...') : tOr(t, 'products.deactivate.hideConfirm', 'Hide product')}
          </button>
        </div>
      )}
    >

        <div className="space-y-4 p-4">
          <p className="text-sm text-slate-600">
            {tOr(t, 'products.deactivate.hideDescription', 'This product will no longer appear for sale in this salon. Existing orders and reports are not affected.')}
          </p>
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.deactivate.reasonOptional', 'Reason (optional)')}
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
    </Modal>
  );
}
