import { describe, expect, it } from 'vitest';
import { toFiscalSafeText } from '../src/shared/fiscal-text';

describe('toFiscalSafeText', () => {
  it('folds Vietnamese receipt text to ASCII', () => {
    expect(toFiscalSafeText('Chả')).toBe('Cha');
    expect(toFiscalSafeText('Bún Bò Huế')).toBe('Bun Bo Hue');
    expect(toFiscalSafeText('đặc sản Hải Dương')).toBe('dac san Hai Duong');
    expect(toFiscalSafeText('cái')).toBe('cai');
  });

  it('preserves Polish fiscal-printer characters', () => {
    const polish = 'Sól Mąka Żółty ryż Sos rybny ze świeżych anchois';
    expect(toFiscalSafeText(polish)).toBe(polish);
  });

  it('folds German diacritics and sharp s', () => {
    expect(toFiscalSafeText('Fähre Öl über Straße')).toBe('Fahre Ol uber Strasse');
  });

  it('collapses whitespace and drops remaining unprintable glyphs', () => {
    expect(toFiscalSafeText('  Chả\tcái\n龍虾  ')).toBe('Cha cai');
  });
});
