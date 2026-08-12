import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ServiceSelectionScreen from '../src/renderer/components/checkin/ServiceSelectionScreen';
import ConfirmationScreen from '../src/renderer/components/checkin/ConfirmationScreen';
import BookingDetailScreen from '../src/renderer/components/checkin/BookingDetailScreen';
import PhoneEntryScreen from '../src/renderer/components/checkin/PhoneEntryScreen';
import NewCustomerScreen from '../src/renderer/components/checkin/NewCustomerScreen';
import { getTranslation } from '../src/renderer/i18n/translations';
import { translateCheckinError } from '../src/renderer/components/checkin/checkin-error-message';

describe('shared customer check-in kiosk translations', () => {
  it('renders the one-service walk-in policy and empty basket in Vietnamese', () => {
    const t = getTranslation('vi');
    const markup = renderToStaticMarkup(
      React.createElement(ServiceSelectionScreen, {
        t,
        services: [],
        categories: [],
        staffList: [],
        selectedServices: [],
        selectedStaff: null,
        recommendations: [],
        bestsellers: [],
        customer: null,
        onAddService: vi.fn(),
        onRemoveService: vi.fn(),
        onSelectStaff: vi.fn(),
        onConfirm: vi.fn(),
        onBack: vi.fn(),
        maxSelectedServices: 1,
      }),
    );

    expect(markup).toContain('Kiosk này nhận một dịch vụ');
    expect(markup).toContain('Chưa chọn dịch vụ');
    expect(markup).toContain('Tổng tiền:');
    expect(markup).not.toContain('This kiosk accepts one service');
    expect(markup).not.toContain('No services selected');
  });

  it('localizes known hook errors while preserving unknown backend messages', () => {
    const t = getTranslation('pl');
    expect(translateCheckinError('Phone lookup failed. Please try again.', t)).toBe(
      'Nie udało się znaleźć numeru telefonu. Spróbuj ponownie.',
    );
    expect(translateCheckinError('BOOKING_STAFF_CHANGED', t)).toBe('BOOKING_STAFF_CHANGED');
  });

  it('keeps confirmation and Back controls above the WebView 83 touch minimum', () => {
    const markup = renderToStaticMarkup(
      React.createElement(ConfirmationScreen, {
        t: getTranslation('pl'),
        customer: { id: 'customer-1', name: 'Anna', phone: '500600700' },
        selectedServices: [],
        selectedStaff: null,
        onConfirm: vi.fn(),
        onBack: vi.fn(),
      }),
    );

    expect(markup.match(/min-h-12/g)).toHaveLength(2);
    expect(markup).toContain('min-w-12');

    const bookingMarkup = renderToStaticMarkup(
      React.createElement(BookingDetailScreen, {
        t: getTranslation('pl'),
        booking: {
          id: 'booking-1', from: '2026-08-11T10:00:00.000Z', till: '2026-08-11T11:00:00.000Z',
          customerName: 'Anna', serviceName: 'Manicure', staffName: 'Fixture Owner',
        },
        staffList: [],
        allowStaffOverride: false,
        onConfirm: vi.fn(),
        onBack: vi.fn(),
      }),
    );
    expect(bookingMarkup.match(/min-h-12/g)).toHaveLength(2);
    expect(bookingMarkup).toContain('min-w-12');
  });

  it.each([
    ['en', 'Back', 'Edit Phone'],
    ['vi', 'Quay lại', 'Sửa Điện thoại'],
    ['tr', 'Geri', 'Düzenle Telefon'],
    ['zh', '返回', '编辑 手机'],
    ['uk', 'Назад', 'Редагувати Телефон'],
    ['ru', 'Назад', 'Редактировать Телефон'],
    ['pl', 'Wstecz', 'Edytuj Telefon'],
  ] as const)('localizes customer accessibility controls in %s', (language, back, editPhone) => {
    const t = getTranslation(language);
    const phoneMarkup = renderToStaticMarkup(
      React.createElement(PhoneEntryScreen, {
        t,
        onSubmit: vi.fn(),
        onSkip: vi.fn(),
        onBack: vi.fn(),
        isLoading: false,
        minPhoneDigits: 9,
      }),
    );
    expect(phoneMarkup).toContain(`aria-label="${back}"`);

    const customerMarkup = renderToStaticMarkup(
      React.createElement(NewCustomerScreen, {
        t,
        initialPhone: '500600700',
        onSubmit: vi.fn(),
        onBack: vi.fn(),
        minimalProfile: true,
      }),
    );
    expect(customerMarkup).toContain(`aria-label="${back}"`);
    expect(customerMarkup).toContain(`aria-label="${editPhone}"`);
    expect(customerMarkup.match(/min-h-11/g)?.length).toBeGreaterThanOrEqual(2);
    expect(customerMarkup.match(/min-w-11/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
