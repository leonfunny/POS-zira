import React from 'react';

interface ShiftReportData {
  shiftId: string;
  staffName: string | null;
  openedAt: string;
  closedAt: string;
  openingCash: number;
  closingCash: number;
  totalSales: number;
  totalOrders: number;
  cashTotal: number;
  cardTotal: number;
  difference: number;
}

interface ShiftReportProps {
  report: ShiftReportData;
  onClose: () => void;
  t: (key: string) => string;
}

function formatPrice(grosze: number, currency: string): string {
  return `${(grosze / 100).toFixed(2)} ${currency}`;
}

export default function ShiftReportModal({ report, onClose, t }: ShiftReportProps) {
  const currency = t('pos.currency');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-slate-800 rounded-xl w-full max-w-sm mx-4 shadow-2xl border border-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">{t('pos.shift.report')}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {report.staffName && (
            <div className="text-center text-sm text-slate-400">
              {report.staffName}
            </div>
          )}

          <div className="space-y-2">
            <Row label={t('pos.shift.openingCash')} value={formatPrice(report.openingCash, currency)} />
            <Row label={t('pos.shift.closingCash')} value={formatPrice(report.closingCash, currency)} />
            <div className="border-t border-slate-700 my-2" />
            <Row label={t('pos.shift.totalOrders')} value={String(report.totalOrders)} />
            <Row label={t('pos.shift.totalSales')} value={formatPrice(report.totalSales, currency)} bold />
            <Row label={t('pos.shift.cashSales')} value={formatPrice(report.cashTotal, currency)} />
            <Row label={t('pos.shift.cardSales')} value={formatPrice(report.cardTotal, currency)} />
            <div className="border-t border-slate-700 my-2" />
            <Row
              label={t('pos.shift.difference')}
              value={`${report.difference >= 0 ? '+' : ''}${formatPrice(report.difference, currency)}`}
              bold
              color={report.difference === 0 ? 'text-green-400' : report.difference > 0 ? 'text-yellow-400' : 'text-red-400'}
            />
          </div>
        </div>

        <div className="px-5 py-4 border-t border-slate-700">
          <button
            onClick={onClose}
            className="w-full py-3 rounded-lg font-semibold text-white bg-slate-700 hover:bg-slate-600 transition-colors"
          >
            {t('pos.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, bold, color }: { label: string; value: string; bold?: boolean; color?: string }) {
  return (
    <div className={`flex justify-between ${bold ? 'text-base font-semibold' : 'text-sm'}`}>
      <span className="text-slate-400">{label}</span>
      <span className={color || 'text-white'}>{value}</span>
    </div>
  );
}
