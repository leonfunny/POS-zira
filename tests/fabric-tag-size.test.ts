import { describe, expect, it } from 'vitest';

import { deriveSizeFromVariantName, totalTagsToPrint } from '../src/renderer/components/label/fabric-tag-size';

/**
 * The size printed on a garment tag is guessed from the variant's name, since
 * there is no size column. The guess is shown to the operator before printing,
 * so the contract here is: be right when the name is clear, and return nothing
 * -- never something plausible-but-wrong -- when it is not.
 */
describe('deriving a size from a variant name', () => {
  it('takes the part after a separator', () => {
    expect(deriveSizeFromVariantName('Polo shirt - M')).toBe('M');
    expect(deriveSizeFromVariantName('Polo shirt / XL')).toBe('XL');
    expect(deriveSizeFromVariantName('Áo thun · S/M')).toBe('S/M');
  });

  it('strips a known style name before looking', () => {
    expect(deriveSizeFromVariantName('Áo thun ZIRA XL', 'Áo thun ZIRA')).toBe('XL');
  });

  it('finds a size-shaped word when there is no separator', () => {
    expect(deriveSizeFromVariantName('Polo shirt XL')).toBe('XL');
    expect(deriveSizeFromVariantName('Spodnie 42')).toBe('42');
  });

  it('normalises case so the tag reads the same however it was typed', () => {
    expect(deriveSizeFromVariantName('Polo - xl')).toBe('XL');
  });

  it('returns nothing rather than a wrong guess', () => {
    // "Cotton" is a fabric, not a size; printing it as one would be worse than
    // leaving the field empty for the operator to fill.
    expect(deriveSizeFromVariantName('Polo shirt - Cotton')).toBe('');
    expect(deriveSizeFromVariantName('Áo khoác mùa đông')).toBe('');
    expect(deriveSizeFromVariantName('')).toBe('');
  });
});

describe('counting a print run', () => {
  it('adds up the per-size quantities', () => {
    expect(totalTagsToPrint({ s: 20, m: 30, l: 15 })).toBe(65);
  });

  it('ignores blanks and nonsense instead of printing them', () => {
    expect(totalTagsToPrint({ s: 5, m: 0, l: -3, xl: NaN as unknown as number })).toBe(5);
  });
});
