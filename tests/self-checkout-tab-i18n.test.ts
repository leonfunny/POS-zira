import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Language, translations } from '../src/renderer/i18n/translations';

const tabSource = readFileSync(
  resolve(__dirname, '../src/renderer/components/SelfCheckoutTab.tsx'),
  'utf-8',
);
const groceryPanelSource = readFileSync(
  resolve(__dirname, '../src/renderer/components/pos/GrocerySelfCheckoutPanel.tsx'),
  'utf-8',
);
const kitchenPanelSource = readFileSync(
  resolve(__dirname, '../src/renderer/components/pos/KitchenSelfOrderPanel.tsx'),
  'utf-8',
);
const source = [tabSource, groceryPanelSource, kitchenPanelSource].join('\n');
const appSource = readFileSync(
  resolve(__dirname, '../src/renderer/App.tsx'),
  'utf-8',
);

const REQUIRED_KEYS = [
  'selfCheckout.badge',
  'selfCheckout.title',
  'selfCheckout.subtitle',
  'selfCheckout.demoAvailable',
  'selfCheckout.productionClosed',
  'selfCheckout.openDemo',
  'selfCheckout.settings',
  'selfCheckout.profile',
  'selfCheckout.profileHelp',
  'selfCheckout.profile.retailScan',
  'selfCheckout.runtimeMode',
  'selfCheckout.defaultLanguage',
  'selfCheckout.displayMonitor',
  'selfCheckout.idleTimeout',
  'selfCheckout.blocker.paymentTerminal',
  'selfCheckout.openError',
];

describe('SelfCheckoutTab i18n', () => {
  it('receives the operator tab language from the sidebar-selected app language', () => {
    expect(appSource).toContain("<SelfCheckoutTab language={(config?.language as Language) || 'en'} />");
    expect(tabSource).toContain('export default function SelfCheckoutTab({ language: uiLanguage }: SelfCheckoutTabProps)');
    expect(tabSource).toContain('useTranslation(uiLanguage)');
    expect(tabSource).not.toContain("const uiLanguage = (config?.language as Language) || 'en'");
  });

  it('keeps the customer kiosk default language separate from the operator UI language', () => {
    expect(groceryPanelSource).toContain("const [kioskLanguage, setKioskLanguage] = useState<ScLang>('pl')");
    expect(groceryPanelSource).toContain('setKioskLanguage((c.selfCheckoutLanguage as ScLang) ??');
    expect(groceryPanelSource).toContain('selfCheckoutLanguage: kioskLanguage');
    expect(groceryPanelSource).toContain("selfCheckoutProfile: 'retail_scan'");
    expect(groceryPanelSource).not.toContain('setProfile');
    expect(groceryPanelSource).not.toContain('selfCheckoutProfile: profile');
    expect(groceryPanelSource).toContain('value={kioskLanguage}');
    expect(groceryPanelSource).toContain('setKioskLanguage(v)');
  });

  it('shows payment readiness from the runtime profile instead of the fake payment flag', () => {
    expect(source).toContain('runtime.paymentProfile ===');
    expect(source).toContain("runtime.paymentProfile === 'unavailable'");
    expect(source).toContain('state={paymentRuntimeState}');
    expect(source).toContain('blocked={paymentRuntimeBlocked}');
    expect(source).not.toContain("state={mode === 'demo' ? t('selfCheckout.demoOnly') : fakePayment ?");
    expect(source).not.toContain('selfCheckoutFakePaymentEnabled');
    expect(source).not.toContain('setFakePayment');
  });

  it('does not render the main operator labels as hardcoded English', () => {
    for (const phrase of [
      'POS kiosk control',
      'Self-Checkout Kiosk',
      'Demo kiosk is available',
      'Open demo self-checkout',
      'Kiosk settings',
      'Kiosk profile',
      'Runtime mode',
      'Default language',
      'Display monitor',
    ]) {
      expect(source).not.toContain(phrase);
    }
  });

  it('defines self-checkout operator translations for every app language', () => {
    for (const lang of Object.keys(translations) as Language[]) {
      for (const key of REQUIRED_KEYS) {
        expect(translations[lang][key], `${lang}.${key}`).toBeTruthy();
      }
    }
  });

  it('has Vietnamese labels for the selected-language case shown in the app', () => {
    expect(translations.vi['selfCheckout.title']).toBe('Kiosk tự thanh toán');
    expect(translations.vi['selfCheckout.openDemo']).toBe('Mở tự thanh toán demo');
    expect(translations.vi['selfCheckout.settings']).toBe('Cài đặt kiosk');
  });
});
