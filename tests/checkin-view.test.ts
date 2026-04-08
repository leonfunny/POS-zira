import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import CheckInView, {
  getAutoOpenCustomerKeyboardTarget,
  getCustomerTouchKeyboardInset,
  shouldDismissCustomerTouchKeyboard,
} from '../src/renderer/windows/customer/views/CheckInView';
import type { CustomerDisplayServiceCategory } from '../src/renderer/windows/customer/customer-display-model';

const checkInViewSource = readFileSync(
  join(__dirname, '../src/renderer/windows/customer/views/CheckInView.tsx'),
  'utf8',
);

const bookingCardSource = readFileSync(
  join(__dirname, '../src/renderer/windows/customer/components/CustomerBookingCard.tsx'),
  'utf8',
);

const walkInServicePickerSource = readFileSync(
  join(__dirname, '../src/renderer/windows/customer/components/WalkInServicePicker.tsx'),
  'utf8',
);

const translations: Record<string, string> = {
  'checkin.welcome': 'Welcome',
  'customer.explore': 'Explore our services',
  'checkin.phoneSearch': 'Check in by phone',
  'checkinTab.searchPhone': 'Search by phone',
  'checkin.iHaveBooking': 'I have a booking',
  'wizard.searchBooking': 'Search booking',
  'checkin.walkIn': 'Walk-in guest',
  'checkin.walkInPlaceholder': 'Enter your name',
  'checkin.browseServices': 'Browse services',
  'priceList.title': 'Services & Pricing',
  'priceList.subtitle': 'Browse the full salon catalog',
  'customer.categories': 'Categories',
  'customer.serviceCount': '{count} services',
  'customer.fromPrice': 'From {price}',
};

function t(key: string): string {
  return translations[key] ?? key;
}

function buildCategory(id: string, name: string, price: number): CustomerDisplayServiceCategory {
  return {
    id,
    name,
    services: [
      {
        id: `${id}-service`,
        name: `${name} Service`,
        price,
        duration: 30,
      },
    ],
  };
}

describe('CheckInView hub category summary', () => {
  it('renders all available categories instead of truncating the list to four', () => {
    const categories = [
      buildCategory('nails', 'Nails', 500),
      buildCategory('hair', 'Hair', 1800),
      buildCategory('cosmetics', 'Cosmetics', 2800),
      buildCategory('accessories', 'Accessories', 800),
      buildCategory('services', 'Services', 6000),
    ];

    const markup = renderToStaticMarkup(
      React.createElement(CheckInView, {
        t,
        language: 'en',
        salonName: 'Zira AI',
        categories,
        upsellItems: [],
        onBrowseServices: () => undefined,
        onBack: () => undefined,
        onLanguageChange: () => undefined,
      }),
    );

    expect(markup).toContain('Nails');
    expect(markup).toContain('Hair');
    expect(markup).toContain('Cosmetics');
    expect(markup).toContain('Accessories');
    expect(markup).toContain('Services');
    expect(markup).toContain('data-customer-display-hub="hub"');
    expect(markup).toContain('data-customer-display-hub-actions="actions"');
    expect(markup).toContain('data-customer-display-hub-categories="panel"');
    expect(markup).toContain('data-customer-display-hub-category-list="scroll"');
    expect(markup).toContain('data-customer-display-touch-keyboard="true"');
    expect(markup).toContain('absolute bottom-0 left-0 right-0 z-20');
    expect(markup).toContain('lg:min-h-0 lg:flex-1 lg:overflow-y-auto');
    expect(markup).toContain('lg:h-[var(--hub-actions-height)] lg:max-h-[var(--hub-actions-height)]');
    expect(markup).toContain('data-customer-display-main="content"');
    expect(markup).toContain('grid min-h-0 flex-1 gap-6 lg:items-start lg:grid-cols-[minmax(0,1.15fr)_380px]');
    expect(markup).toContain('relative z-10 flex min-h-0 flex-1 overflow-hidden px-8 py-8');
    expect(markup).toContain('mx-auto flex min-h-0 w-full max-w-[1440px] flex-1 flex-col overflow-hidden');
    expect(markup).not.toContain('pointer-events-none absolute inset-0 rounded-[28px] border border-white/80 bg-white/88 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur');
    expect(markup).not.toContain('relative min-h-0 lg:h-full');
  });

  it('auto-opens the customer touch keyboard only for booking search and walk-in name entry', () => {
    expect(getAutoOpenCustomerKeyboardTarget('hub', 'identity')).toBeNull();
    expect(getAutoOpenCustomerKeyboardTarget('booking', 'identity')).toBe('bookingSearch');
    expect(getAutoOpenCustomerKeyboardTarget('walkin', 'identity')).toBe('walkInName');
    expect(getAutoOpenCustomerKeyboardTarget('walkin', 'service')).toBeNull();
    expect(getAutoOpenCustomerKeyboardTarget('phone', 'identity')).toBeNull();
  });

  it('uses a fixed bottom inset when the customer touch keyboard is visible', () => {
    expect(getCustomerTouchKeyboardInset(null)).toBe(0);
    expect(getCustomerTouchKeyboardInset('bookingSearch')).toBe(264);
    expect(getCustomerTouchKeyboardInset('walkInName')).toBe(264);
    expect(getCustomerTouchKeyboardInset('walkInServiceSearch' as any)).toBe(264);
  });

  it('dismisses the customer touch keyboard only when tapping outside the input and keyboard', () => {
    const keyboardTarget = {
      closest: (selector: string) => selector === '[data-customer-display-touch-keyboard="true"]' ? true : null,
    } as unknown as Element;
    const inputTarget = {
      closest: (selector: string) => selector === '[data-customer-display-text-input="true"]' ? true : null,
    } as unknown as Element;
    const outsideTarget = {
      closest: () => null,
    } as unknown as Element;

    expect(shouldDismissCustomerTouchKeyboard(keyboardTarget)).toBe(false);
    expect(shouldDismissCustomerTouchKeyboard(inputTarget)).toBe(false);
    expect(shouldDismissCustomerTouchKeyboard(outsideTarget)).toBe(true);
    expect(shouldDismissCustomerTouchKeyboard(null)).toBe(true);
  });

  it('uses a browse-services style walk-in service picker with a read-only summary rail', () => {
    expect(checkInViewSource).toContain('selectedWalkInServices');
    expect(checkInViewSource).not.toContain('const [selectedWalkInService, setSelectedWalkInService]');
    expect(checkInViewSource).toContain('data-customer-display-checkin-walkin-basket="true"');
    expect(checkInViewSource).toContain('data-customer-display-checkin-walkin-summary="true"');
    expect(checkInViewSource).toContain('services: selectedWalkInServices');
    expect(checkInViewSource).toContain('walkInServiceSearch');
    expect(checkInViewSource).not.toContain('data-customer-display-selected-service-remove="true"');
  });

  it('passes controlled browse-style service picker props into the walk-in service step', () => {
    expect(checkInViewSource).toContain('selectedCategoryId={walkInSelectedCategoryId}');
    expect(checkInViewSource).toContain('searchQuery={walkInServiceSearchQuery}');
    expect(checkInViewSource).toContain('categoryMenuOpen={walkInCategoryMenuOpen}');
    expect(checkInViewSource).toContain('onSelectCategory={selectWalkInCategory}');
    expect(checkInViewSource).toContain('onToggleCategoryMenu={toggleWalkInCategoryMenu}');
    expect(checkInViewSource).toContain("onSearchFocus={() => setKeyboardTarget('walkInServiceSearch')}");
  });

  it('uses review rails for booking and phone flows instead of immediate check-in buttons on every card', () => {
    expect(checkInViewSource).toContain('data-customer-display-checkin-booking-review="true"');
    expect(checkInViewSource).toContain('selectedBooking');
    expect(checkInViewSource).toContain('selectedPhoneBooking');
    expect(checkInViewSource).not.toContain('actionLabel={t(\'checkin.imHere\')}');
    expect(bookingCardSource).toContain('selected?: boolean;');
    expect(bookingCardSource).toContain('onSelect: () => void;');
    expect(bookingCardSource).not.toContain('actionLabel: string;');
  });

  it('keeps the phone lookup flow to two columns with a single walk-in fallback action', () => {
    expect(checkInViewSource).toContain("lg:grid-cols-[320px_minmax(0,1fr)]");
    expect(checkInViewSource).not.toContain("lg:grid-cols-[320px_minmax(0,1fr)_340px]");
    expect(checkInViewSource).toContain('data-customer-display-checkin-phone-selection="true"');
    expect(checkInViewSource).not.toContain('data-customer-display-checkin-phone-review="true"');
    expect(checkInViewSource).toContain('selectedPhoneBooking ? (');
  });

  it('renders the legacy check-in confirmation using the fixed-height receipt layout with internal scroll regions', () => {
    expect(checkInViewSource).toContain('data-customer-display-checkin-confirmed-receipt="true"');
    expect(checkInViewSource).toContain('data-customer-display-checkin-confirmed-summary="true"');
    expect(checkInViewSource).toContain('data-customer-display-checkin-confirmed-detail-scroll="true"');
    expect(checkInViewSource).toContain('data-customer-display-checkin-receipt-sticky-summary="true"');
    expect(checkInViewSource).toContain('approxDurationMinutes');
    expect(checkInViewSource).toContain('totalPrice');
    expect(checkInViewSource).not.toContain('flex min-h-0 flex-1 items-center justify-center');
  });

  it('renders the walk-in service picker as a compact browse-style toolbar without the old category rail', () => {
    expect(walkInServicePickerSource).toContain('data-customer-display-checkin-walkin-category-toolbar="true"');
    expect(walkInServicePickerSource).toContain('data-customer-display-checkin-walkin-category-trigger="true"');
    expect(walkInServicePickerSource).toContain('data-customer-display-checkin-walkin-category-menu="true"');
    expect(walkInServicePickerSource).toContain('data-customer-display-checkin-walkin-search-input="true"');
    expect(walkInServicePickerSource).not.toContain('data-customer-display-checkin-walkin-category-list="true"');
  });
});
