import React from 'react';
import type { SalonCustomerData, SelectedService, StaffItem } from '../../hooks/useCheckinWizard';

function formatPrice(grosze: number): string {
  return (grosze / 100).toFixed(2);
}

interface Props {
  t: (key: string) => string;
  customer: SalonCustomerData | null;
  selectedServices: SelectedService[];
  selectedStaff: StaffItem | null;
  isSubmitting?: boolean;
  onConfirm: () => void;
  onBack: () => void;
}

export default function ConfirmationScreen({ t, customer, selectedServices, selectedStaff, isSubmitting, onConfirm, onBack }: Props) {
  const total = selectedServices.reduce((sum, s) => sum + (s.price || 0), 0);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center space-x-3 mb-4">
        <button onClick={onBack} className="flex min-h-12 min-w-12 items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
          <svg className="w-5 h-5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <h2 className="text-lg font-semibold text-slate-800">{t('wizard.confirmation')}</h2>
      </div>

      <div className="flex-1 flex items-center justify-center">
        <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-md w-full">
          {/* Customer */}
          <div className="flex items-center space-x-3 mb-5 pb-4 border-b border-slate-100">
            <div className="w-12 h-12 rounded-full bg-brand-100 flex items-center justify-center">
              <span className="text-lg font-bold text-brand-600">
                {(customer?.name || 'G').charAt(0).toUpperCase()}
              </span>
            </div>
            <div>
              <div className="text-base font-semibold text-slate-800">{customer?.name || t('wizard.guest')}</div>
              {customer?.phone && <div className="text-xs text-slate-500">{customer.phone}</div>}
            </div>
          </div>

          {/* Services */}
          <div className="mb-4">
            <div className="text-xs font-medium text-slate-500 uppercase mb-2">{t('wizard.services')}</div>
            <div className="space-y-2">
              {selectedServices.map((svc) => (
                <div key={svc.id} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">{svc.name}</span>
                  <span className="text-slate-500">{formatPrice(svc.price || 0)} zł</span>
                </div>
              ))}
            </div>
            {total > 0 && (
              <div className="flex items-center justify-between text-sm font-semibold text-slate-800 mt-3 pt-2 border-t border-slate-100">
                <span>{t('wizard.total')}</span>
                <span>{formatPrice(total)} zł</span>
              </div>
            )}
          </div>

          {/* Staff */}
          {selectedStaff && (
            <div className="mb-5">
              <div className="text-xs font-medium text-slate-500 uppercase mb-1">{t('wizard.staff')}</div>
              <div className="text-sm text-slate-700">{selectedStaff.name}</div>
            </div>
          )}

          {/* Confirm */}
          <button
            onClick={onConfirm}
            disabled={isSubmitting}
            className="min-h-12 w-full py-3 bg-emerald-600 text-white text-sm font-semibold rounded-xl hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSubmitting ? '...' : t('wizard.confirmCheckin')}
          </button>
        </div>
      </div>
    </div>
  );
}
