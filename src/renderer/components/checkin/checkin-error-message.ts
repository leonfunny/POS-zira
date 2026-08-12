export type CheckinTranslator = (key: string) => string;

// Keep the hook's state/API stable (and preserve unknown backend messages),
// while allowing the shared renderer to present its known customer-facing
// failures in the currently selected language.
const ERROR_KEYS: Record<string, string> = {
  'Phone lookup failed. Please try again.': 'wizard.errorPhoneLookup',
  'Failed to create customer profile. Please try again.': 'wizard.errorCreateCustomer',
  'Check-in failed. Please try again.': 'wizard.errorCheckin',
  'Failed to start service. Please try again.': 'wizard.errorStartService',
  'Failed to complete check-in. Please try again.': 'wizard.errorCompleteCheckin',
  'Failed to mark no-show. Please try again.': 'wizard.errorNoShow',
  'Booking search is unavailable. Please see reception.': 'wizard.errorBookingSearchUnavailable',
  'Booking search failed. Please try again or see reception.': 'wizard.errorBookingSearch',
  'This appointment changed. Search again or see reception before checking in.': 'wizard.errorBookingChanged',
};

export function translateCheckinError(message: string, t: CheckinTranslator): string {
  const key = ERROR_KEYS[message];
  return key ? t(key) : message;
}
