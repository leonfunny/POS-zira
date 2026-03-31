import React, { useState } from 'react';
import { BooksyBookingSummary } from '../../../shared/types';
import type { StaffItem } from '../../hooks/useCheckinWizard';

function formatTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(11, 16);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface Props {
  t: (key: string) => string;
  booking: BooksyBookingSummary;
  staffList: StaffItem[];
  isSubmitting?: boolean;
  onConfirm: (booking: BooksyBookingSummary, staffName?: string, staffId?: string) => void;
  onBack: () => void;
}

export default function BookingDetailScreen({ t, booking, staffList, isSubmitting, onConfirm, onBack }: Props) {
  const [selectedStaffName, setSelectedStaffName] = useState<string>(booking.staffName || '');
  const [selectedStaffId, setSelectedStaffId] = useState<string>('');

  const handleStaffChange = (staffId: string) => {
    if (!staffId) {
      // Reset to original booking staff
      setSelectedStaffName(booking.staffName || '');
      setSelectedStaffId('');
      return;
    }
    const staff = staffList.find((s) => s.id === staffId);
    if (staff) {
      setSelectedStaffName(staff.name);
      setSelectedStaffId(staff.id);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
          <svg className="w-5 h-5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <h2 className="text-lg font-semibold text-slate-800">{t('wizard.bookingDetail')}</h2>
      </div>

      {/* Booking info card */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-lg mx-auto w-full">
        <div className="space-y-4">
          {/* Customer */}
          <div>
            <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">{t('wizard.customer')}</label>
            <div className="text-lg font-semibold text-slate-800 mt-1">{booking.customerName}</div>
          </div>

          {/* Time */}
          <div>
            <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">{t('wizard.time')}</label>
            <div className="text-sm text-slate-700 mt-1">
              {formatTime(booking.from)} - {formatTime(booking.till)}
            </div>
          </div>

          {/* Service */}
          <div>
            <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">{t('wizard.service')}</label>
            <div className="text-sm text-slate-700 mt-1">{booking.serviceName}</div>
          </div>

          {/* Staff (editable) */}
          <div>
            <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">{t('wizard.staff')}</label>
            <select
              value={selectedStaffId || ''}
              onChange={(e) => handleStaffChange(e.target.value)}
              className="w-full mt-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-300"
            >
              <option value="">{booking.staffName || '--'}</option>
              {staffList
                .filter((s) => s.name !== booking.staffName)
                .map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
            </select>
          </div>
        </div>

        {/* Confirm button */}
        <button
          onClick={() => onConfirm(booking, selectedStaffName || booking.staffName, selectedStaffId)}
          disabled={isSubmitting}
          className="w-full mt-6 px-6 py-3 bg-brand-600 text-white text-sm font-semibold rounded-xl hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSubmitting ? '...' : t('wizard.confirmCheckin')}
        </button>
      </div>
    </div>
  );
}
