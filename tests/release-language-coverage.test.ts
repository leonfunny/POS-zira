import { describe, expect, it } from 'vitest';
import { translations } from '../src/renderer/i18n/translations';

describe('primary release language coverage', () => {
  it.each(['vi', 'pl'] as const)('%s supplies every English key and matching interpolation values', (language) => {
    const missing = Object.keys(translations.en).filter(key => !(key in translations[language]));
    expect(missing).toEqual([]);
    const placeholders = (text: string) => [...text.matchAll(/\{\{?(\w+)\}?\}/g)].map(match => match[1]).sort();
    for (const [key, english] of Object.entries(translations.en)) {
      expect(placeholders(translations[language][key]), key).toEqual(placeholders(english));
    }
  });
});
