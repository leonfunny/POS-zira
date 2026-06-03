import { describe, expect, it } from 'vitest';
import { ELZAB_FISCAL_ITEM_NAME_MAX, toFiscalSafeItemName, toFiscalSafeText } from '../src/shared/fiscal-text';

describe('toFiscalSafeText', () => {
  it('folds Vietnamese receipt text to ASCII', () => {
    expect(toFiscalSafeText('Chả')).toBe('Cha');
    expect(toFiscalSafeText('Bún Bò Huế')).toBe('Bun Bo Hue');
    expect(toFiscalSafeText('đặc sản Hải Dương')).toBe('dac san Hai Duong');
    expect(toFiscalSafeText('cái')).toBe('cai');
  });

  it('folds Polish fiscal text to ASCII', () => {
    expect(toFiscalSafeText('Napój')).toBe('Napoj');
    expect(toFiscalSafeText('trójkątne')).toBe('trojkatne');
    expect(toFiscalSafeText('jęczmienia')).toBe('jeczmienia');
    expect(toFiscalSafeText('Sól Mąka Żółty ryż')).toBe('Sol Maka Zolty ryz');
  });

  it('folds German diacritics and sharp s', () => {
    expect(toFiscalSafeText('Fähre Öl über Straße')).toBe('Fahre Ol uber Strasse');
  });

  it('collapses whitespace and drops remaining unprintable glyphs', () => {
    expect(toFiscalSafeText('  Chả\tcái\n龍虾  ')).toBe('Cha cai');
  });

  it('caps ELZAB item names and strips Polish diacritics', () => {
    const safe = toFiscalSafeItemName('Sól Mąka Żółty ryż trójkątne opakowanie jęczmienia ekstra');

    expect(safe.length).toBeLessThanOrEqual(ELZAB_FISCAL_ITEM_NAME_MAX);
    expect(safe).toBe('Sol Maka Zolty ryz trojkatne opakowanie');
    expect(safe).not.toMatch(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/);
  });
});
