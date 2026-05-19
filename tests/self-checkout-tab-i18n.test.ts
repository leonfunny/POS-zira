import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Language, translations } from '../src/renderer/i18n/translations';

const source = readFileSync(
  resolve(__dirname, '../src/renderer/components/SelfCheckoutTab.tsx'),
  'utf-8',
);
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
  'selfCheckout.runtimeMode',
  'selfCheckout.fakePayment',
  'selfCheckout.fakePaymentHelp',
  'selfCheckout.defaultLanguage',
  'selfCheckout.displayMonitor',
  'selfCheckout.idleTimeout',
  'selfCheckout.blocker.paymentTerminal',
  'selfCheckout.openError',
];

describe('SelfCheckoutTab i18n', () => {
  it('receives the operator tab language from the sidebar-selected app language', () => {
    expect(appSource).toContain("<SelfCheckoutTab language={(config?.language as Language) || 'en'} />");
    expect(source).toContain('export default function SelfCheckoutTab({ language: uiLanguage }: SelfCheckoutTabProps)');
    expect(source).toContain('useTranslation(uiLanguage)');
    expect(source).not.toContain("const uiLanguage = (config?.language as Language) || 'en'");
  });

  it('keeps the customer kiosk default language separate from the operator UI language', () => {
    expect(source).toContain("const [kioskLanguage, setKioskLanguage] = useState<ScLang>('pl')");
    expect(source).toContain('setKioskLanguage((c.selfCheckoutLanguage as ScLang) ??');
    expect(source).toContain('selfCheckoutLanguage: kioskLanguage');
    expect(source).toContain('value={kioskLanguage}');
    expect(source).toContain('setKioskLanguage(v)');
  });

  it('does not render the main operator labels as hardcoded English', () => {
    for (const phrase of [
      'POS kiosk control',
      'Self-Checkout Kiosk',
      'Demo kiosk is available',
      'Open demo self-checkout',
      'Kiosk settings',
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
