import React, { useState } from 'react';

interface ShiftModalProps {
  mode: 'open' | 'close';
  shiftId?: string | null;
  onSubmit: (data: { staffName?: string; openingCash?: number; closingCash?: number }) => void;
  onClose: () => void;
  t: (key: string) => string;
}

export default function ShiftModal({ mode, onSubmit, onClose, t }: ShiftModalProps) {
  const [staffName, setStaffName] = useState('');
  const [cashAmount, setCashAmount] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (saving) return;
    setSaving(true);

    const amount = Math.round(parseFloat(cashAmount || '0') * 100);

    if (mode === 'open') {
      onSubmit({ staffName: staffName || t('pos.cashier'), openingCash: amount });
    } else {
      onSubmit({ closingCash: amount });
    }
  };

  const canSubmit = !saving && (mode === 'close' || staffName.trim().length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-2xl w-full max-w-sm mx-4 shadow-2xl border border-gray-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${mode === 'open' ? 'bg-emerald-100' : 'bg-red-100'}`}>
              {mode === 'open' ? (
                <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                </svg>
              )}
            </div>
            <h2 className="text-base font-bold text-gray-900">
              {mode === 'open' ? t('pos.shift.open') : t('pos.shift.close')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {mode === 'open' && (
            <div>
              <label className="text-xs text-gray-500 font-medium block mb-1.5">
                {t('pos.shift.staffName')}
              </label>
              <input
                type="text"
                value={staffName}
                onChange={(e) => setStaffName(e.target.value)}
                placeholder={t('pos.namePlaceholder')}
                autoFocus
                className="w-full px-3 py-2.5 bg-slate-50 border border-gray-200 rounded-xl text-gray-900 text-sm focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100 placeholder-gray-400"
                onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleSubmit()}
              />
            </div>
          )}

          <div>
            <label className="text-xs text-gray-500 font-medium block mb-1.5">
              {mode === 'open' ? t('pos.shift.openingCash') : t('pos.shift.closingCash')}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="decimal"
                value={cashAmount}
                onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setCashAmount(e.target.value); }}
                placeholder="0.00"
                autoFocus={mode === 'close'}
                className="flex-1 px-3 py-2.5 bg-slate-50 border border-gray-200 rounded-xl text-xl text-gray-900 text-right font-bold focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleSubmit()}
              />
              <span className="text-sm font-medium text-gray-500">{t('pos.currency')}</span>
            </div>
          </div>
        </div>

        <div className="px-5 pb-5 pt-1">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={`w-full py-3.5 rounded-xl font-bold text-sm text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
              mode === 'open'
                ? 'bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700'
                : 'bg-brand-500 hover:bg-brand-600 active:bg-brand-700'
            }`}
          >
            {mode === 'open' ? t('pos.shift.open') : t('pos.shift.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
