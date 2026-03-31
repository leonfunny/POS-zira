import React, { useState } from 'react';
import { BooksyBookingSummary } from '../../../shared/types';
import type { SalonCustomerData, ServiceRecommendation } from '../../hooks/useCheckinWizard';

interface Props {
  t: (key: string) => string;
  customer: SalonCustomerData;
  recommendations: ServiceRecommendation[];
  todayBookings: BooksyBookingSummary[];
  onContinue: () => void;
  onBack: () => void;
}

export default function CustomerProfileScreen({ t, customer, recommendations, todayBookings, onContinue, onBack }: Props) {
  const [showBookingPopup, setShowBookingPopup] = useState(false);

  // Check if customer has a booking today
  const todayBooking = todayBookings.find(
    (b) =>
      (b.status === 'BOOKED' || b.status === 'PENDING') &&
      b.customerName.toLowerCase().includes(customer.name.toLowerCase().split(' ')[0]),
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
          <svg className="w-5 h-5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <h2 className="text-lg font-semibold text-slate-800">{t('wizard.customerProfile')}</h2>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center max-w-lg mx-auto w-full">
        {/* Customer card */}
        <div className="bg-white rounded-xl border border-slate-200 p-6 w-full mb-4">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-14 h-14 rounded-full bg-brand-100 flex items-center justify-center">
              <span className="text-xl font-bold text-brand-600">
                {customer.name.charAt(0).toUpperCase()}
              </span>
            </div>
            <div>
              <div className="text-lg font-semibold text-slate-800">{customer.name}</div>
              {customer.phone && (
                <div className="text-sm text-slate-500">{customer.phone}</div>
              )}
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-slate-50 rounded-lg p-3 text-center">
              <div className="text-xl font-bold text-slate-800">{customer.visit_count}</div>
              <div className="text-[10px] text-slate-500 uppercase">{t('wizard.visits')}</div>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 text-center">
              <div className="text-sm font-medium text-slate-700 truncate">
                {customer.preferred_staff_name || '-'}
              </div>
              <div className="text-[10px] text-slate-500 uppercase">{t('wizard.preferredStaff')}</div>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 text-center">
              <div className="text-sm font-medium text-slate-700 truncate">
                {customer.last_service_name || '-'}
              </div>
              <div className="text-[10px] text-slate-500 uppercase">{t('wizard.lastService')}</div>
            </div>
          </div>

          {/* Recommendations */}
          {recommendations.length > 0 && (
            <div>
              <div className="text-xs font-medium text-slate-500 uppercase mb-2">{t('wizard.favoriteServices')}</div>
              <div className="flex flex-wrap gap-2">
                {recommendations.map((r, i) => (
                  <span key={i} className="px-2 py-1 bg-brand-50 text-brand-700 text-xs rounded-full">
                    {r.service_name} ({r.count}x)
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Booking detected popup */}
        {todayBooking && !showBookingPopup && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 w-full mb-4">
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <span className="text-sm font-semibold text-amber-800">{t('wizard.bookingDetected')}</span>
            </div>
            <p className="text-xs text-amber-700 mb-3">
              {todayBooking.serviceName} &middot; {todayBooking.staffName}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowBookingPopup(true)}
                className="text-xs px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700"
              >
                {t('wizard.continueWalkIn')}
              </button>
            </div>
          </div>
        )}

        {/* Continue button */}
        <button
          onClick={onContinue}
          className="w-full py-3 bg-brand-600 text-white text-sm font-semibold rounded-xl hover:bg-brand-700 transition-colors"
        >
          {t('wizard.selectServices')}
        </button>
      </div>
    </div>
  );
}
