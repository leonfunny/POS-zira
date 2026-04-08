import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(__dirname, '../src/renderer/windows/customer/views/SalonInteractiveView.tsx'),
  'utf8',
);

describe('SalonInteractiveView browse flow', () => {
  it('uses the customer touch keyboard pattern for service search and walk-in name inputs', () => {
    expect(source).toContain('data-customer-display-touch-keyboard="true"');
    expect(source).toContain('data-customer-display-text-input="true"');
    expect(source).toContain('readOnly');
    expect(source).toContain('paddingBottom: keyboardInset > 0 ? `${keyboardInset}px` : undefined');
  });

  it('supports multi-service selection across categories before walk-in handoff', () => {
    expect(source).toContain('selectedServices');
    expect(source).toContain('toggleSelectedService');
    expect(source).toContain('selectedServices.length');
    expect(source).toContain('services: selectedServices');
    expect(source).not.toContain('const [selectedService, setSelectedService]');
  });

  it('only auto-opens the keyboard for the walk-in name step', () => {
    expect(source).not.toContain("if (view === 'category') return 'browseSearch';");
    expect(source).toContain("if (view === 'handoff') return 'browseWalkInName';");
    expect(source).toContain("setKeyboardTarget('browseSearch');");
    expect(source).toContain("setCategoryMenuOpen(false);");
    expect(source).toContain("setKeyboardTarget('browseWalkInName')");
  });

  it('uses a compact browse-services toolbar with an inline category chooser', () => {
    expect(source).toContain('const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);');
    expect(source).toContain('data-customer-display-category-toolbar="true"');
    expect(source).toContain('data-customer-display-category-trigger="true"');
    expect(source).toContain('data-customer-display-category-menu="true"');
  });

  it('clears search and keeps the basket when switching categories from the chooser', () => {
    expect(source).toContain('const selectBrowseCategory = useCallback');
    expect(source).toContain('setSelectedCategoryId(categoryId);');
    expect(source).toContain("setSearchQuery('');");
    expect(source).toContain('selectedServices');
    expect(source).toContain("setCategoryMenuOpen(false);");
  });

  it('dismisses the keyboard when opening the category chooser and closes the chooser on outside taps', () => {
    expect(source).toContain('const toggleCategoryMenu = useCallback');
    expect(source).toContain('if (keyboardTarget) {');
    expect(source).toContain('dismissTouchKeyboard();');
    expect(source).toContain("target.closest('[data-customer-display-category-menu=\"true\"]')");
    expect(source).toContain("target.closest('[data-customer-display-category-trigger=\"true\"]')");
  });

  it('renders selected services as a readable basket with scroll regions and total', () => {
    expect(source).toContain('data-customer-display-selected-services-scroll="true"');
    expect(source).toContain('data-customer-display-basket-summary-scroll="true"');
    expect(source).toContain("t('customer.selectedServices')");
    expect(source).toContain("t('wizard.total')");
    expect(source).toContain('selectedServices.reduce((total, service) => total + service.price, 0)');
  });

  it('does not use the full joined selected-services label as the walk-in subtitle', () => {
    expect(source).not.toContain(": view === 'handoff'\r\n        ? selectedServicesLabel");
    expect(source).not.toContain(": view === 'handoff'\n        ? selectedServicesLabel");
  });

  it('makes the handoff basket editable from the large left panel', () => {
    expect(source).toContain('data-customer-display-selected-service-remove="true"');
    expect(source).toContain("aria-label={t('common.remove')}");
  });

  it('returns to browse when the last service is removed from handoff', () => {
    expect(source).toContain('const removeSelectedService = useCallback');
    expect(source).toContain("setView('category');");
  });

  it('keeps the handoff right panel as a compact summary instead of a duplicate basket list', () => {
    const basketSummaryScrollMatches = source.match(/data-customer-display-basket-summary-scroll=\"true\"/g) || [];
    expect(basketSummaryScrollMatches).toHaveLength(1);
    expect(source).toContain('data-customer-display-handoff-summary="true"');
  });

  it('uses the editorial receipt layout for the confirmed walk-in screen', () => {
    expect(source).toContain('data-customer-display-confirmed-receipt="true"');
    expect(source).toContain('data-customer-display-confirmed-metrics="true"');
    expect(source).toContain('data-customer-display-confirmed-services-scroll="true"');
    expect(source).toContain("t('customer.approxTime')");
    expect(source).toContain('selectedServices.reduce((total, service) => total + service.duration, 0)');
  });
});
