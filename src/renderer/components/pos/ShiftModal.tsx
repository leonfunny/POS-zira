import React, { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../shared/Modal';

interface ShiftStaffOption {
  id: string;
  name: string;
  role?: string | null;
  commission_rate?: number;
  is_active?: number;
}

interface ShiftModalProps {
  mode: 'open' | 'close';
  shiftId?: string | null;
  onSubmit: (data: { staffId?: string; staffName?: string; openingCash?: number; closingCash?: number }) => Promise<void>;
  onClose: () => void;
  t: (key: string) => string;
}

export default function ShiftModal({ mode, onSubmit, onClose, t }: ShiftModalProps) {
  const [staffList, setStaffList] = useState<ShiftStaffOption[]>([]);
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [loadingStaff, setLoadingStaff] = useState(false);
  const [cashAmount, setCashAmount] = useState('');
  const initialCashAmountRef = useRef(cashAmount);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [billiardLink, setBilliardLink] = useState<{
    billiardSalon: boolean;
    open: boolean;
    offline?: boolean;
  } | null>(null);

  const label = (key: string, fallback: string) => {
    const translated = t(key);
    return translated && translated !== key ? translated : fallback;
  };

  // Billiard salons: tell the cashier what this shift action also does.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.billiardShift?.preclose?.()
      .then((res: any) => { if (!cancelled && res) setBilliardLink(res); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [mode]);

  useEffect(() => {
    if (mode !== 'open') return;
    let cancelled = false;
    setLoadingStaff(true);
    window.electronAPI.pos.staff.getAll()
      .then((rows: ShiftStaffOption[]) => {
        if (cancelled) return;
        const activeRows = (rows || []).filter((row) => row.is_active !== 0 && row.name?.trim());
        setStaffList(activeRows);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || label('pos.shift.staffLoadFailed', 'Could not load staff list'));
      })
      .finally(() => {
        if (!cancelled) setLoadingStaff(false);
      });
    return () => { cancelled = true; };
  }, [mode]);

  const selectedStaff = useMemo(
    () => staffList.find((staff) => staff.id === selectedStaffId) || null,
    [staffList, selectedStaffId],
  );

  const handleSubmit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const amount = Math.round(parseFloat(cashAmount || '0') * 100);
      if (mode === 'open') {
        if (!selectedStaff) throw new Error(label('pos.shift.selectStaffRequired', 'Select a staff member'));
        await onSubmit({ staffId: selectedStaff.id, staffName: selectedStaff.name, openingCash: amount });
      } else {
        await onSubmit({ closingCash: amount });
      }
    } catch (err: any) {
      setError(err?.message || 'Operation failed');
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = !saving && (mode === 'close' || !!selectedStaff);
  const title = mode === 'open' ? t('pos.shift.open') : t('pos.shift.close');
  const titleIcon = (
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
  );

  return (
    <Modal
      title={title}
      titleIcon={titleIcon}
      onClose={onClose}
      size="sm"
      busy={saving}
      guardUnsaved={cashAmount !== initialCashAmountRef.current}
      closeLabel={label('pos.close', 'Close')}
      bodyClassName="px-5 py-4 space-y-4"
      footerClassName="px-5 pb-5 pt-1"
      footer={(
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={`w-full py-3.5 rounded-xl font-bold text-sm text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
            mode === 'open'
              ? 'bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700'
              : 'bg-brand-500 hover:bg-brand-600 active:bg-brand-700'
          }`}
        >
          {title}
        </button>
      )}
    >
          {mode === 'open' && (
            <div>
              <label className="text-xs text-slate-500 font-medium block mb-1.5">
                {label('pos.shift.selectStaff', 'Select staff')}
              </label>
              {loadingStaff ? (
                <div className="w-full px-3 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-500 text-sm">
                  {label('pos.loading', 'Loading...')}
                </div>
              ) : staffList.length > 0 ? (
                <div className="grid grid-cols-2 gap-2 max-h-52 overflow-y-auto pr-0.5">
                  {staffList.map((staff) => {
                    const active = staff.id === selectedStaffId;
                    return (
                      <button
                        key={staff.id}
                        type="button"
                        onClick={() => setSelectedStaffId(staff.id)}
                        className={`min-h-14 rounded-xl border px-3 py-2 text-left transition-colors ${
                          active
                            ? 'border-emerald-500 bg-emerald-50 text-emerald-800 ring-2 ring-emerald-100'
                            : 'border-slate-200 bg-slate-50 text-slate-800 hover:border-brand-300 hover:bg-white'
                        }`}
                      >
                        <span className="block text-sm font-bold truncate">{staff.name}</span>
                        {staff.role && <span className="block mt-0.5 text-xs opacity-70 truncate">{staff.role}</span>}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800">
                  {label('pos.shift.noStaff', 'No active staff. Add employees in Settings before opening a shift.')}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="text-xs text-slate-500 font-medium block mb-1.5">
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
                className="flex-1 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xl text-slate-900 text-right font-bold focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleSubmit()}
              />
              <span className="text-sm font-medium text-slate-500">{t('pos.currency')}</span>
            </div>
          </div>
          {billiardLink?.billiardSalon && mode === 'open' && (
            <div className="px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm">
              {label('pos.shift.billiardAutoOpen', 'A billiard business shift will open together with this POS shift (same float).')}
            </div>
          )}
          {billiardLink?.billiardSalon && mode === 'close' && billiardLink.open && (
            <div className="px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm">
              {label('pos.shift.billiardAutoClose', 'The open billiard shift will close together with this POS shift. Detailed cash reconciliation stays on the web (Daily close tab).')}
            </div>
          )}
        {error && (
          <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}
    </Modal>
  );
}
