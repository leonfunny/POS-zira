import React, { useState, useEffect } from 'react';
import { useConfig } from '../../hooks/useConfig';
import { useTranslation } from '../../i18n/useTranslation';
import { Language, languageNames } from '../../i18n/translations';
import { useCheckinWizard } from '../../hooks/useCheckinWizard';
import EntryScreen from './EntryScreen';
import BookingListScreen from './BookingListScreen';
import BookingDetailScreen from './BookingDetailScreen';
import PhoneEntryScreen from './PhoneEntryScreen';
import CustomerProfileScreen from './CustomerProfileScreen';
import NewCustomerScreen from './NewCustomerScreen';
import ServiceSelectionScreen from './ServiceSelectionScreen';
import ConfirmationScreen from './ConfirmationScreen';

const STATUS_COLORS: Record<string, string> = {
  waiting: 'bg-amber-100 text-amber-700',
  in_service: 'bg-blue-100 text-blue-700',
  completed: 'bg-emerald-100 text-emerald-700',
  no_show: 'bg-red-100 text-red-700',
};

const CHECKIN_LANGS: Language[] = ['en', 'vi', 'pl', 'ru', 'uk', 'tr', 'zh'];

function getStepInfo(step: string, flow: string | null): { current: number; total: number; label: string } | null {
  if (step === 'entry' || step === 'done') return null;
  if (flow === 'booking') {
    const steps = [
      { key: 'booking-list', label: 'Select' },
      { key: 'booking-detail', label: 'Confirm' },
    ];
    const idx = steps.findIndex((s) => s.key === step);
    return idx >= 0 ? { current: idx + 1, total: steps.length, label: steps[idx].label } : null;
  }
  if (flow === 'walkin') {
    const steps = [
      { key: 'phone-entry', label: 'Phone' },
      { key: 'customer-found', label: 'Profile' },
      { key: 'service-select', label: 'Services' },
      { key: 'confirm', label: 'Confirm' },
    ];
    const normalized = step === 'new-customer' ? 'customer-found' : step;
    const idx = steps.findIndex((s) => s.key === normalized);
    return idx >= 0 ? { current: idx + 1, total: steps.length, label: steps[idx].label } : null;
  }
  return null;
}

function formatWaitTime(checkedInAt: string): string {
  const mins = Math.floor((Date.now() - new Date(checkedInAt).getTime()) / 60000);
  if (mins < 1) return '< 1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return remainingMins > 0 ? `${hrs}h ${remainingMins}m` : `${hrs}h`;
}

interface CheckinWizardProps {
  onFullscreen?: () => void;
}

export default function CheckinWizard({ onFullscreen }: CheckinWizardProps = {}) {
  const { config, saveConfig } = useConfig();
  const [lang, setLang] = useState<Language>('en');
  const [confirmingNoShow, setConfirmingNoShow] = useState<string | null>(null);
  const showStatsBar = config?.checkinShowStatsBar ?? true;
  const showQueue = config?.checkinShowQueue ?? true;

  // Sync language from persisted config once it loads
  useEffect(() => {
    if (config?.language) {
      setLang(config.language as Language);
    }
  }, [config?.language]);
  const { t } = useTranslation(lang);
  const wizard = useCheckinWizard();
  const { state } = wizard;
  const activeCheckins = state.checkins.filter((c: any) => c.status === 'waiting' || c.status === 'in_service');

  return (
    <div className="max-w-7xl mx-auto flex flex-col h-[calc(100vh-2rem)]">
      {/* Top bar — always visible; stats section is staff-only */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        {showStatsBar ? (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2.5">
              <span className="text-sm text-slate-500">{state.stats.total} {t('wizard.total')}</span>
              <span className="w-px h-4 bg-slate-200" />
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                {state.stats.waiting} {t('wizard.waiting')}
              </span>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                {state.stats.inService} {t('wizard.inService')}
              </span>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                {state.stats.completed} {t('wizard.completed')}
              </span>
            </div>
          </div>
        ) : <div />}
        <div className="flex items-center gap-2">
          {/* Fullscreen / Customer Kiosk button */}
          {onFullscreen && (
            <button
              onClick={onFullscreen}
              className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-xl hover:bg-brand-700 active:bg-brand-800 transition-colors duration-150 cursor-pointer shadow-sm"
              title="Enter customer kiosk mode"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9M20.25 20.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              </svg>
              Customer Kiosk
            </button>
          )}
          {/* Language selector */}
          <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
            {CHECKIN_LANGS.map((l) => (
              <button
                key={l}
                onClick={() => {
                  if (l !== lang) {
                    setLang(l);
                    saveConfig({ language: l });
                  }
                }}
                className={`px-2 py-0.5 rounded text-xs font-semibold transition-all duration-150 cursor-pointer ${
                  lang === l ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>

          {state.step !== 'entry' && (
            <button
              onClick={wizard.reset}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors duration-150 cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
              </svg>
              {t('wizard.backToStart')}
            </button>
          )}
        </div>
      </div>

      {/* Error banner */}
      {state.errorMessage && (
        <div className="mb-3 shrink-0 flex items-center gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <svg className="w-4 h-4 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <span className="flex-1">{state.errorMessage}</span>
          <button
            onClick={wizard.clearError}
            className="shrink-0 text-red-400 hover:text-red-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 min-h-0 flex gap-4">
        {/* Wizard area */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Step progress indicator */}
          {(() => {
            const info = getStepInfo(state.step, state.flow);
            if (!info) return null;
            return (
              <div className="flex items-center gap-1.5 mb-3 shrink-0">
                {Array.from({ length: info.total }).map((_, i) => (
                  <div
                    key={i}
                    className={`h-1.5 rounded-full transition-all duration-300 ${
                      i < info.current ? 'bg-brand-500' : 'bg-slate-200'
                    } ${i === info.current - 1 ? 'w-8' : 'w-3'}`}
                  />
                ))}
                <span className="ml-1 text-xs text-slate-400 tabular-nums">{info.current} / {info.total} · {info.label}</span>
              </div>
            );
          })()}
          <div className="flex-1 min-h-0">
          {state.step === 'entry' && (
            <EntryScreen
              t={t}
              onBooking={wizard.selectBookingFlow}
              onWalkIn={wizard.selectWalkInFlow}
              bookingCount={state.todayBookings.filter((b) => b.status === 'BOOKED' || b.status === 'PENDING').length}
            />
          )}
          {state.step === 'booking-list' && (
            <BookingListScreen
              t={t}
              bookings={state.todayBookings}
              checkins={state.checkins}
              onSelect={wizard.selectBooking}
              onBack={wizard.reset}
            />
          )}
          {state.step === 'booking-detail' && state.selectedBooking && (
            <BookingDetailScreen
              t={t}
              booking={state.selectedBooking}
              staffList={state.staffList}
              isSubmitting={state.isSubmitting}
              onConfirm={wizard.confirmBookingCheckin}
              onBack={() => wizard.goTo('booking-list')}
            />
          )}
          {state.step === 'phone-entry' && (
            <PhoneEntryScreen
              t={t}
              onSubmit={wizard.lookupPhone}
              onSkip={wizard.skipPhone}
              onBack={wizard.reset}
              isLoading={state.isLoading}
            />
          )}
          {state.step === 'customer-found' && state.customer && (
            <CustomerProfileScreen
              t={t}
              customer={state.customer}
              recommendations={state.recommendations}
              todayBookings={state.todayBookings}
              onContinue={wizard.goToServiceSelect}
              onBack={() => wizard.goTo('phone-entry')}
            />
          )}
          {state.step === 'new-customer' && (
            <NewCustomerScreen
              t={t}
              initialPhone={state.phoneNumber}
              onSubmit={wizard.createCustomer}
              onBack={() => wizard.goTo('phone-entry')}
            />
          )}
          {state.step === 'service-select' && (
            <ServiceSelectionScreen
              t={t}
              services={state.services}
              categories={state.categories}
              staffList={state.staffList}
              selectedServices={state.selectedServices}
              selectedStaff={state.selectedStaff}
              recommendations={state.recommendations}
              bestsellers={state.bestsellers}
              customer={state.customer}
              onAddService={wizard.addService}
              onRemoveService={wizard.removeService}
              onSelectStaff={wizard.selectStaff}
              onConfirm={wizard.goToConfirm}
              onBack={() => {
                if (state.isNewCustomer) wizard.goTo('new-customer');
                else if (state.customer) wizard.goTo('customer-found');
                else wizard.goTo('phone-entry');
              }}
            />
          )}
          {state.step === 'confirm' && (
            <ConfirmationScreen
              t={t}
              customer={state.customer}
              selectedServices={state.selectedServices}
              selectedStaff={state.selectedStaff}
              isSubmitting={state.isSubmitting}
              onConfirm={wizard.confirmWalkIn}
              onBack={() => wizard.goTo('service-select')}
            />
          )}
          {state.step === 'done' && (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <div className="w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center">
                <svg className="w-10 h-10 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-slate-800">{t('wizard.done')}</h2>
              <p className="text-sm text-slate-500">{t('wizard.doneMessage')}</p>
              <button
                onClick={wizard.reset}
                className="mt-4 px-6 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
              >
                {t('wizard.newCheckin')}
              </button>
            </div>
          )}
          </div>
        </div>

        {/* Right: Active queue — staff only */}
        {showQueue && <div className={`shrink-0 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col transition-all duration-300 ${activeCheckins.length > 0 ? 'w-72' : 'w-14'}`}>
          {activeCheckins.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 py-6">
              <svg className="w-5 h-5 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
              </svg>
              <span className="text-[10px] font-bold text-slate-300">0</span>
            </div>
          ) : (
          <>
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-600 uppercase tracking-wider">
              {t('wizard.activeQueue')}
            </h3>
            <span className="bg-slate-200 text-slate-600 text-xs font-bold px-2 py-0.5 rounded-full">
              {activeCheckins.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-slate-50">
            {activeCheckins.map((c: any) => {
                const initials = (c.customer_name || '?').charAt(0).toUpperCase();
                const isWaiting = c.status === 'waiting';
                const isConfirmingThisNoShow = confirmingNoShow === c.id;
                return (
                  <div key={c.id} className="px-3 py-3 hover:bg-slate-50 transition-colors duration-150">
                    <div className="flex items-start gap-2.5">
                      {/* Avatar */}
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${isWaiting ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                        {initials}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full ${STATUS_COLORS[c.status] || 'bg-slate-100 text-slate-600'}`}>
                            <span className={`w-1 h-1 rounded-full ${isWaiting ? 'bg-amber-500' : 'bg-blue-500'}`} />
                            {isWaiting ? t('wizard.waiting') : t('wizard.inService')}
                          </span>
                          {c.is_walkin === 1 && (
                            <span className="text-[10px] bg-purple-100 text-purple-600 font-semibold px-1.5 py-0.5 rounded-full">{t('wizard.walkIn')}</span>
                          )}
                        </div>
                        <div className="text-xs font-semibold text-slate-800 truncate">{c.customer_name || 'Guest'}</div>
                        {c.service_name && (
                          <div className="text-[10px] text-slate-400 truncate mt-0.5">{c.service_name}</div>
                        )}
                        {/* Wait time */}
                        {c.checked_in_at && (
                          <div className="text-[10px] text-slate-400 mt-0.5">
                            {formatWaitTime(c.checked_in_at)}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1.5 mt-2 ml-10">
                      {isWaiting && (
                        <button
                          onClick={() => wizard.startService(c.id)}
                          disabled={state.isSubmitting}
                          className="px-2.5 py-1 text-[10px] font-bold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {t('wizard.start')}
                        </button>
                      )}
                      {c.status === 'in_service' && (
                        <button
                          onClick={() => wizard.completeCheckin(c.id)}
                          disabled={state.isSubmitting}
                          className="px-2.5 py-1 text-[10px] font-bold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {t('wizard.complete')}
                        </button>
                      )}
                      {isWaiting && (
                        isConfirmingThisNoShow ? (
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-red-600 font-medium">Sure?</span>
                            <button
                              onClick={() => { wizard.markNoShow(c.id); setConfirmingNoShow(null); }}
                              disabled={state.isSubmitting}
                              className="px-2 py-1 text-[10px] font-bold bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors duration-150 disabled:opacity-50"
                            >
                              Yes
                            </button>
                            <button
                              onClick={() => setConfirmingNoShow(null)}
                              className="px-2 py-1 text-[10px] font-medium text-slate-500 hover:bg-slate-100 rounded-lg transition-colors duration-150"
                            >
                              No
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmingNoShow(c.id)}
                            disabled={state.isSubmitting}
                            className="px-2.5 py-1 text-[10px] font-medium text-red-500 hover:bg-red-50 rounded-lg transition-colors duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {t('wizard.noShow')}
                          </button>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            {activeCheckins.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 px-4 gap-3">
                <div className="w-16 h-16 rounded-2xl bg-slate-50 border border-slate-100 flex items-center justify-center">
                  <svg className="w-8 h-8 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                  </svg>
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-slate-500">{t('wizard.noActive')}</p>
                  <p className="text-xs text-slate-400 mt-1">{t('wizard.noActiveHint')}</p>
                </div>
              </div>
            )}
          </div>
          </>
          )}
        </div>}
      </div>
    </div>
  );
}
