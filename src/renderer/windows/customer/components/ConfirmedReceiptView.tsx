import React from 'react';
import type { Language } from '../../../i18n/translations';
import { Panel, DetailRow } from './CustomerDisplayPrimitives';
import {
  CustomerDisplayServiceItem,
  formatDisplayCurrency,
  formatDisplayTime,
  formatPhoneDigitsForDisplay,
} from '../customer-display-model';

export interface ConfirmedReceiptViewProps {
  t: (key: string) => string;
  language: Language;
  customerName: string;
  services: CustomerDisplayServiceItem[];
  totalPrice: number | null;
  approxDurationMinutes: number | null;
  serviceLabel?: string;
  serviceName?: string;
  staffName?: string;
  bookingTime?: string;
  customerPhone?: string;
  rootAttr?: string;
  summaryAttr?: string;
  scrollAttr?: string;
}

export default function ConfirmedReceiptView({
  t,
  language,
  customerName,
  services,
  totalPrice,
  approxDurationMinutes,
  serviceLabel,
  serviceName,
  staffName,
  bookingTime,
  customerPhone,
  rootAttr,
  summaryAttr,
  scrollAttr,
}: ConfirmedReceiptViewProps) {
  const serviceCount = services.length > 0
    ? services.length
    : serviceLabel || serviceName
      ? 1
      : 0;

  const totalValue = totalPrice != null
    ? formatDisplayCurrency(totalPrice, language)
    : '-';

  const approxTimeValue = approxDurationMinutes
    ? `~${t('customer.duration').replace('{min}', String(approxDurationMinutes))}`
    : '-';

  const isBookingFallback = services.length === 0;

  return (
    <div className="min-h-0 flex-1">
      <Panel className="h-full w-full overflow-hidden p-0">
        <div className="grid h-full min-h-0 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">

          {/* Left column: at-a-glance */}
          <div
            className="relative flex min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(253,230,230,0.9),_transparent_42%),linear-gradient(135deg,rgba(255,250,250,0.96),rgba(255,247,239,0.94)_56%,rgba(255,244,210,0.9))] p-8 lg:p-10"
            {...(rootAttr ? { [rootAttr]: 'true' } : {})}
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/55 to-transparent" />

            <div className="relative flex h-full flex-col">
              {/* Status badge */}
              <div className="inline-flex shrink-0 items-center gap-3 self-start rounded-full border border-white/80 bg-white/76 px-5 py-2.5 shadow-sm">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-b from-rose-50 to-orange-50 text-brand-600">
                  <ConfirmedIcon />
                </div>
                <span className="text-lg font-semibold tracking-tight text-brand-600">
                  {t('checkin.confirmed')}
                </span>
              </div>

              {/* Customer name */}
              <div className="mt-8 shrink-0">
                <div className="text-5xl font-semibold tracking-tight text-slate-900">
                  {customerName}
                </div>
              </div>

              {/* Summary metrics — each shown exactly once */}
              <div className="mt-8 grid shrink-0 gap-3 sm:grid-cols-3">
                <ReceiptMetric
                  label={t('customer.selectedServices')}
                  value={String(serviceCount)}
                />
                <ReceiptMetric
                  label={t('wizard.total')}
                  value={totalValue}
                />
                <ReceiptMetric
                  label={t('customer.approxTime')}
                  value={approxTimeValue}
                />
              </div>

              {/* "Next step" banner — pushed to bottom */}
              <div className="mt-auto shrink-0 pt-8">
                <div className="rounded-[24px] border border-amber-100 bg-gradient-to-br from-amber-50/90 to-white px-6 py-5">
                  <div className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-700">
                    {t('checkin.walkinArrived')}
                  </div>
                  <div className="mt-2 text-base leading-7 text-slate-600">
                    {t('checkin.pleaseWait')}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right column: service receipt / booking details */}
          <div
            className="flex min-h-0 flex-col border-l border-white/70 bg-white/72 p-6 lg:p-8"
            {...(summaryAttr ? { [summaryAttr]: 'true' } : {})}
          >
            <div className="shrink-0 pb-5">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                {isBookingFallback ? t('wizard.bookingDetail') : t('customer.selectedServices')}
              </div>
            </div>

            <div
              className="min-h-0 flex-1 overflow-y-auto pr-1"
              {...(scrollAttr ? { [scrollAttr]: 'true' } : {})}
            >
              {!isBookingFallback ? (
                <div className="space-y-2">
                  {services.map((service) => (
                    <div
                      key={service.id}
                      className="flex min-h-[44px] items-center justify-between gap-4 rounded-2xl border border-slate-100 bg-white/88 px-5 py-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900">{service.name}</div>
                        {service.duration > 0 && (
                          <div className="mt-1 text-xs font-medium text-slate-500">
                            {t('customer.duration').replace('{min}', String(service.duration))}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 text-sm font-semibold text-slate-600">
                        {formatDisplayCurrency(service.price, language)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-[24px] border border-slate-100 bg-white/88 p-5">
                  <div className="space-y-2">
                    {(serviceLabel || serviceName) && (
                      <DetailRow label={t('wizard.service')} value={serviceLabel || serviceName || ''} />
                    )}
                    {staffName && (
                      <DetailRow label={t('wizard.staff')} value={staffName} />
                    )}
                    {bookingTime && (
                      <DetailRow
                        label={t('wizard.time')}
                        value={formatDisplayTime(bookingTime, language) || '-'}
                      />
                    )}
                    {customerPhone && (
                      <DetailRow
                        label={t('wizard.phone')}
                        value={formatPhoneDigitsForDisplay(customerPhone)}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>
      </Panel>
    </div>
  );
}

function ConfirmedIcon() {
  return (
    <svg className="h-9 w-9" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function ReceiptMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[24px] border border-white/80 bg-white/78 px-5 py-4 shadow-[0_12px_32px_rgba(15,23,42,0.04)]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{label}</div>
      <div className="mt-2 text-xl font-semibold tracking-tight text-slate-900">{value}</div>
    </div>
  );
}
