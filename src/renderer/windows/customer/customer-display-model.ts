import type { AgentConfig } from '../../../shared/types';
import type { Language } from '../../i18n/translations';

export interface CustomerDisplayBooking {
  id: number;
  customerName: string;
  serviceName: string;
  staffName: string;
  from: string;
  till: string;
  status: string;
}

export interface CustomerDisplayServiceItem {
  id: string;
  name: string;
  price: number;
  duration: number;
  imageUrl?: string;
}

export interface CustomerDisplayServiceCategory {
  id: string;
  name: string;
  services: CustomerDisplayServiceItem[];
}

export interface BrowseCategorySummary {
  id: string;
  name: string;
  serviceCount: number;
  startingPrice: number;
  maxDuration: number;
}

const LANGUAGES: Language[] = ['en', 'vi', 'tr', 'zh', 'uk', 'ru', 'pl'];
const ACTIVE_BOOKING_STATUSES = new Set(['BOOKED', 'PENDING']);
const LOCALE_BY_LANGUAGE: Record<Language, string> = {
  en: 'en-US',
  vi: 'vi-VN',
  tr: 'tr-TR',
  zh: 'zh-CN',
  uk: 'uk-UA',
  ru: 'ru-RU',
  pl: 'pl-PL',
};

function isLanguage(value?: string): value is Language {
  return !!value && LANGUAGES.includes(value as Language);
}

export function resolveCustomerDisplayLanguage(
  config?: Pick<AgentConfig, 'customerDisplayLanguage' | 'posLanguage' | 'language'> | null,
): Language {
  if (isLanguage(config?.customerDisplayLanguage)) return config.customerDisplayLanguage;
  if (isLanguage(config?.posLanguage)) return config.posLanguage;
  if (isLanguage(config?.language)) return config.language;
  return 'en';
}

export function sanitizePhoneDigits(value: string): string {
  return (value || '').replace(/\D/g, '');
}

export function formatPhoneDigitsForDisplay(value: string): string {
  const digits = sanitizePhoneDigits(value).slice(0, 9);
  if (!digits) return '';

  return digits.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
}

export function isVisibleBookingStatus(status?: string): boolean {
  return ACTIVE_BOOKING_STATUSES.has((status || '').toUpperCase());
}

export function filterVisibleBookings(
  bookings: CustomerDisplayBooking[],
  query: string,
): CustomerDisplayBooking[] {
  const normalizedQuery = query.trim().toLowerCase();

  return bookings.filter((booking) => {
    if (!isVisibleBookingStatus(booking.status)) return false;
    if (!normalizedQuery) return true;

    const haystack = [
      booking.customerName,
      booking.serviceName,
      booking.staffName,
    ].join(' ').toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}

export function summarizeServiceCategories(
  categories: CustomerDisplayServiceCategory[],
): BrowseCategorySummary[] {
  return categories
    .map((category) => {
      const services = category.services.filter((service) => service.price >= 0);
      if (!services.length) return null;

      return {
        id: category.id,
        name: category.name,
        serviceCount: services.length,
        startingPrice: Math.min(...services.map((service) => service.price)),
        maxDuration: Math.max(...services.map((service) => service.duration || 0)),
      };
    })
    .filter((category): category is BrowseCategorySummary => category !== null);
}

export function getLanguageLocale(language: Language): string {
  return LOCALE_BY_LANGUAGE[language] || LOCALE_BY_LANGUAGE.en;
}

export function formatDisplayCurrency(amount: number, language: Language): string {
  return new Intl.NumberFormat(getLanguageLocale(language), {
    style: 'currency',
    currency: 'PLN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount / 100);
}

export function formatDisplayTime(iso: string, language: Language): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleTimeString(getLanguageLocale(language), {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDisplayDate(date: Date, language: Language): string {
  return date.toLocaleDateString(getLanguageLocale(language), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}
