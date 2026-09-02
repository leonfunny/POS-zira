import { describe, it, expect } from 'vitest';
import { parseFabricTagData } from '../src/main/hardware/tsc/fabric-tag-input';

/**
 * The garment factory prints its customers' care labels. Those carry a size, a
 * fibre composition and wash symbols — and no brand at all; the sample .btw the
 * shop supplied reads:
 *
 *   S/M
 *   70% LEN
 *   30% wiskoza
 *   [wash symbols]
 *   NATURALNY LEN
 *
 * The print boundary used to demand a brand name or a logo, which would have
 * made operators invent one. It now demands only that the tag has something to
 * print.
 */
describe('a fabric tag does not need a brand', () => {
  it('accepts a tag carrying only a size', () => {
    const tag = parseFabricTagData({ size: 'S/M', quantity: 1 });
    expect(tag.size).toBe('S/M');
    expect(tag.brandName).toBe('');
  });

  it('accepts a tag carrying only a composition', () => {
    const tag = parseFabricTagData({ composition: '70% LEN 30% WISKOZA', quantity: 1 });
    expect(tag.composition).toBe('70% LEN 30% WISKOZA');
  });

  it('accepts the factory sample: size, composition, symbols and a note', () => {
    const tag = parseFabricTagData({
      size: 'S/M',
      composition: '70% LEN 30% WISKOZA',
      careSymbols: ['WASH_30', 'IRON_LOW'],
      careText: 'NATURALNY LEN',
      quantity: 200,
    });
    expect(tag.careSymbols).toEqual(['WASH_30', 'IRON_LOW']);
    expect(tag.quantity).toBe(200);
  });

  it('still accepts a branded tag, so the existing composer is unaffected', () => {
    const tag = parseFabricTagData({ brandName: 'Zira', quantity: 1 });
    expect(tag.brandName).toBe('Zira');
  });

  it('still refuses a tag with nothing at all to print', () => {
    expect(() => parseFabricTagData({ quantity: 1 })).toThrow(
      /brandName, raster logoDataUrl, size or composition/,
    );
  });

  it('still refuses a tag whose only fields are blank strings', () => {
    expect(() =>
      parseFabricTagData({ brandName: '   ', size: '  ', composition: '', quantity: 1 }),
    ).toThrow(/brandName, raster logoDataUrl, size or composition/);
  });

  it('still requires a quantity', () => {
    expect(() => parseFabricTagData({ size: 'M' })).toThrow(/quantity/);
  });
});
