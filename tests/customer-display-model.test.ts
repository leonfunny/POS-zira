import { describe, expect, it } from 'vitest';
import {
  filterVisibleBookings,
  formatPhoneDigitsForDisplay,
  resolveCustomerDisplayLanguage,
  sanitizePhoneDigits,
  summarizeServiceCategories,
} from '../src/renderer/windows/customer/customer-display-model';

describe('resolveCustomerDisplayLanguage', () => {
  it('prefers the dedicated customer display language over POS and main language', () => {
    expect(resolveCustomerDisplayLanguage({
      language: 'en',
      posLanguage: 'pl',
      customerDisplayLanguage: 'vi',
    })).toBe('vi');
  });

  it('falls back to POS language, then main language, then English', () => {
    expect(resolveCustomerDisplayLanguage({
      language: 'en',
      posLanguage: 'pl',
      customerDisplayLanguage: '',
    })).toBe('pl');

    expect(resolveCustomerDisplayLanguage({
      language: 'uk',
      posLanguage: '',
      customerDisplayLanguage: '',
    })).toBe('uk');

    expect(resolveCustomerDisplayLanguage({})).toBe('en');
  });
});

describe('sanitizePhoneDigits', () => {
  it('keeps digits only so keypad and pasted numbers behave the same', () => {
    expect(sanitizePhoneDigits('+48 600-123-456')).toBe('48600123456');
    expect(sanitizePhoneDigits('(555) 12A-90')).toBe('5551290');
  });
});

describe('formatPhoneDigitsForDisplay', () => {
  it('renders phone digits in readable 3-digit groups and caps customer display input at 9 digits', () => {
    expect(formatPhoneDigitsForDisplay('')).toBe('');
    expect(formatPhoneDigitsForDisplay('1')).toBe('1');
    expect(formatPhoneDigitsForDisplay('1234')).toBe('123 4');
    expect(formatPhoneDigitsForDisplay('123456789')).toBe('123 456 789');
    expect(formatPhoneDigitsForDisplay('1234567890')).toBe('123 456 789');
    expect(formatPhoneDigitsForDisplay('12a34 56-78_9')).toBe('123 456 789');
  });
});

describe('filterVisibleBookings', () => {
  const bookings = [
    {
      id: 1,
      customerName: 'Anna Kowalska',
      serviceName: 'Hybrid manicure',
      staffName: 'Mila',
      from: '2026-04-07T10:00:00.000Z',
      till: '2026-04-07T11:00:00.000Z',
      status: 'BOOKED',
    },
    {
      id: 2,
      customerName: 'Piotr Nowak',
      serviceName: 'Classic pedicure',
      staffName: 'Anya',
      from: '2026-04-07T12:00:00.000Z',
      till: '2026-04-07T13:00:00.000Z',
      status: 'PENDING',
    },
    {
      id: 3,
      customerName: 'Ghost Record',
      serviceName: 'Cancelled test',
      staffName: 'Nobody',
      from: '2026-04-07T09:00:00.000Z',
      till: '2026-04-07T09:30:00.000Z',
      status: 'CANCELLED',
    },
  ];

  it('shows only active bookings and matches query across customer, staff, and service', () => {
    expect(filterVisibleBookings(bookings, '')).toHaveLength(2);
    expect(filterVisibleBookings(bookings, 'mila').map((booking) => booking.id)).toEqual([1]);
    expect(filterVisibleBookings(bookings, 'pedicure').map((booking) => booking.id)).toEqual([2]);
  });
});

describe('summarizeServiceCategories', () => {
  it('builds browse-friendly category summaries with starting price and service count', () => {
    const categories = [
      {
        id: 'nails',
        name: 'Nails',
        services: [
          { id: 'svc-1', name: 'Express manicure', price: 4500, duration: 30 },
          { id: 'svc-2', name: 'Spa manicure', price: 6500, duration: 60 },
        ],
      },
      {
        id: 'lashes',
        name: 'Lashes',
        services: [],
      },
    ];

    expect(summarizeServiceCategories(categories)).toEqual([
      {
        id: 'nails',
        name: 'Nails',
        serviceCount: 2,
        startingPrice: 4500,
        maxDuration: 60,
      },
    ]);
  });
});
