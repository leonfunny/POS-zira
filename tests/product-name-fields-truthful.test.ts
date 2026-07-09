import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { translations, type Language } from '../src/renderer/i18n/translations';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

const LOCALES_WITH_KEY: Language[] = ['en', 'vi', 'pl'];
const CLAIMS_RECEIPT = /receipt|fiscal|fiskal|paragon|hóa đơn/i;

const CANONICAL_LABEL_FILES = [
  'src/renderer/components/products/ProductCreateDialog.tsx',
  'src/renderer/components/products/ProductDetailDrawer.tsx',
  'src/renderer/components/products/ProductEditForm.tsx',
  'src/renderer/components/products/ProductEditView.tsx',
];

describe('product name field labels tell the truth', () => {
  it('the canonical name is never labelled as the receipt/fiscal name', () => {
    for (const lang of LOCALES_WITH_KEY) {
      const label = translations[lang]['products.drawer.canonicalName'];
      expect(label, `${lang}: key missing`).toBeTruthy();
      expect(CLAIMS_RECEIPT.test(label), `${lang}: "${label}"`).toBe(false);
    }
  });

  it('the Polish display name IS labelled as the receipt/fiscal name', () => {
    for (const lang of LOCALES_WITH_KEY) {
      const label = translations[lang]['products.edit.displayNamePl'];
      expect(label, `${lang}: key missing`).toBeTruthy();
      expect(CLAIMS_RECEIPT.test(label), `${lang}: "${label}"`).toBe(true);
    }
  });

  it('every component fallback for the canonical label is receipt-free', () => {
    for (const file of CANONICAL_LABEL_FILES) {
      const matches = source(file).match(/'products\.drawer\.canonicalName',\s*'[^']+'/g) ?? [];
      expect(matches.length, `${file}: no tOr fallback found`).toBeGreaterThan(0);
      for (const match of matches) {
        expect(CLAIMS_RECEIPT.test(match), `${file}: ${match}`).toBe(false);
      }
    }
  });

  it('the Polish field fallback claims the receipt', () => {
    const matches = source('src/renderer/components/products/ProductEditForm.tsx')
      .match(/'products\.edit\.displayNamePl',\s*'[^']+'/g) ?? [];
    expect(matches.length).toBe(1);
    expect(CLAIMS_RECEIPT.test(matches[0])).toBe(true);
  });
});
