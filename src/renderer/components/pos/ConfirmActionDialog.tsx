import React, { useEffect, useId, useState } from 'react';
import type { ConfirmActionTier } from './confirm-action-copy';

interface ConfirmActionDialogProps {
  open: boolean;
  tier: ConfirmActionTier;
  title: string;
  body: string;
  consequence?: string;
  itemName?: string;
  confirmLabel: string;
  cancelLabel: string;
  continueLabel?: string;
  backLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmActionDialog({
  open,
  tier,
  title,
  body,
  consequence,
  itemName,
  confirmLabel,
  cancelLabel,
  continueLabel = 'Continue',
  backLabel = 'Back',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmActionDialogProps) {
  const [step, setStep] = useState<'review' | 'final'>('review');
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    setStep('review');
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      onCancel();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel, open]);

  if (!open) return null;

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (!busy) onCancel();
  };

  const cancelClasses =
    'min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-800 shadow-sm transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-200 disabled:cursor-not-allowed disabled:opacity-50';
  const confirmClasses = danger
    ? 'min-h-11 rounded-lg border border-red-600 bg-red-600 px-4 text-sm font-extrabold text-white shadow-sm transition-colors hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-200 disabled:cursor-not-allowed disabled:opacity-50'
    : 'min-h-11 rounded-lg border border-slate-900 bg-slate-900 px-4 text-sm font-extrabold text-white shadow-sm transition-colors hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-200 disabled:cursor-not-allowed disabled:opacity-50';

  const itemBlock = itemName ? (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-extrabold text-slate-900">
      {itemName}
    </div>
  ) : null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 px-3 py-4"
      onClick={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {tier === 'review' && step === 'final' ? (
          <div className="p-5">
            <div className="rounded-xl border border-red-300 bg-red-50 p-4">
              <h2 id={titleId} className="text-lg font-extrabold text-red-950">
                {title}
              </h2>
              <div className="mt-3 space-y-3">
                {itemBlock}
                <p id={bodyId} className="text-sm font-semibold leading-6 text-red-900">
                  {consequence || body}
                </p>
              </div>
            </div>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setStep('review')}
                disabled={busy}
                className={`${cancelClasses} flex-[1.15]`}
              >
                {backLabel}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={busy}
                className={`${confirmClasses} flex-1`}
              >
                {busy ? `${confirmLabel}...` : confirmLabel}
              </button>
            </div>
          </div>
        ) : (
          <div className="p-5">
            <h2 id={titleId} className="text-lg font-extrabold text-slate-950">
              {title}
            </h2>
            <div className="mt-3 space-y-3">
              {itemBlock}
              <p id={bodyId} className="text-sm font-semibold leading-6 text-slate-700">
                {body}
              </p>
              {tier === 'review' && consequence && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm font-bold leading-6 text-amber-950">
                  {consequence}
                </div>
              )}
            </div>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className={`${cancelClasses} flex-[1.2]`}
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={tier === 'review' ? () => setStep('final') : onConfirm}
                disabled={busy}
                className={`${confirmClasses} flex-1`}
              >
                {tier === 'review' ? continueLabel : busy ? `${confirmLabel}...` : confirmLabel}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
