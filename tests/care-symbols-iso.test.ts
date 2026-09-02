import { describe, it, expect } from 'vitest';
import {
  CARE_SYMBOLS,
  CARE_SYMBOL_FAMILIES,
  FABRIC_TAG_EXCLUSIVE_CARE_SYMBOL_GROUPS,
  isCareSymbol,
  type CareSymbol,
} from '../src/shared/types';
import {
  CARE_SYMBOL_ART,
  CARE_SYMBOL_LABELS,
  careSymbolLabel,
  careSymbolSvg,
} from '../src/shared/care-symbols';
import { parseFabricTagData } from '../src/main/hardware/tsc/fabric-tag-input';

function tag(careSymbols: CareSymbol[]) {
  return { size: 'M', composition: '100% BAWEŁNA', careSymbols, quantity: 1 };
}

describe('the ISO 3758:2012 set is complete', () => {
  it('carries all 44 symbols the standard defines', () => {
    expect(CARE_SYMBOLS).toHaveLength(44);
  });

  it('has every washing temperature, with its mild and very mild processes', () => {
    // Table 1 of the standard. Getting one wrong prints a wrong laundering
    // instruction onto a customer's garment, which is why they are spelled out
    // here rather than derived.
    expect(CARE_SYMBOL_FAMILIES[0].symbols).toEqual([
      'WASH_95', 'WASH_95_MILD',
      'WASH_70',
      'WASH_60', 'WASH_60_MILD',
      'WASH_50', 'WASH_50_MILD',
      'WASH_40', 'WASH_40_MILD', 'WASH_40_VERY_MILD',
      'WASH_30', 'WASH_30_MILD', 'WASH_30_VERY_MILD',
      'WASH_HAND', 'WASH_NO',
    ]);
  });

  it('has the oxygen-only bleach restriction, not just allow and forbid', () => {
    expect(CARE_SYMBOLS).toContain('BLEACH_OXYGEN');
  });

  it('has all four natural-drying methods and a shade variant of each', () => {
    for (const method of ['DRY_LINE', 'DRY_DRIP', 'DRY_FLAT', 'DRY_FLAT_DRIP']) {
      expect(CARE_SYMBOLS).toContain(method);
      expect(CARE_SYMBOLS).toContain(`${method}_SHADE`);
    }
  });

  it('has professional wet cleaning, which the old set omitted entirely', () => {
    expect(CARE_SYMBOLS).toContain('WETCLEAN_W');
    expect(CARE_SYMBOLS).toContain('WETCLEAN_W_MILD');
    expect(CARE_SYMBOLS).toContain('WETCLEAN_W_VERY_MILD');
    expect(CARE_SYMBOLS).toContain('WETCLEAN_NO');
  });

  it('has the mild dry-cleaning processes for both solvents', () => {
    expect(CARE_SYMBOLS).toContain('DRYCLEAN_P_MILD');
    expect(CARE_SYMBOLS).toContain('DRYCLEAN_F_MILD');
  });

  it('lists each symbol exactly once, in exactly one family', () => {
    expect(new Set(CARE_SYMBOLS).size).toBe(CARE_SYMBOLS.length);
    const fromFamilies = CARE_SYMBOL_FAMILIES.flatMap((family) => family.symbols);
    expect(fromFamilies).toEqual([...CARE_SYMBOLS]);
  });

  it('accepts every symbol at the print boundary', () => {
    for (const symbol of CARE_SYMBOLS) {
      expect(isCareSymbol(symbol)).toBe(true);
      expect(parseFabricTagData(tag([symbol])).careSymbols).toEqual([symbol]);
    }
  });
});

describe('every symbol is drawn', () => {
  it('has art, and the art is shapes rather than text of the enum name', () => {
    for (const symbol of CARE_SYMBOLS) {
      const art = CARE_SYMBOL_ART[symbol];
      expect(art, symbol).toBeTruthy();
      expect(art, symbol).toMatch(/<(path|rect|circle|g)\b/);
      expect(art, symbol).not.toContain(symbol);
    }
  });

  it('wraps the art in a sized svg', () => {
    const svg = careSymbolSvg('WASH_30', 26);
    expect(svg).toContain('width="26"');
    expect(svg).toContain('viewBox="0 0 100 100"');
  });

  it('draws the milder processes as the same symbol with bars under it', () => {
    // One bar means reduced agitation, two the gentlest cycle. Without them the
    // mild variants would be indistinguishable from the normal ones.
    expect(CARE_SYMBOL_ART.WASH_30_MILD).not.toBe(CARE_SYMBOL_ART.WASH_30);
    expect(CARE_SYMBOL_ART.WASH_30_MILD.match(/<rect/g) ?? []).toHaveLength(1);
    expect(CARE_SYMBOL_ART.WASH_30_VERY_MILD.match(/<rect/g) ?? []).toHaveLength(2);
    expect(CARE_SYMBOL_ART.WETCLEAN_W_MILD.match(/<rect/g) ?? []).toHaveLength(1);
    expect(CARE_SYMBOL_ART.WETCLEAN_W_VERY_MILD.match(/<rect/g) ?? []).toHaveLength(2);
  });

  it('scales the barred art so the bars do not sit on top of the symbol', () => {
    expect(CARE_SYMBOL_ART.WASH_30_MILD).toContain('scale(0.82)');
    expect(CARE_SYMBOL_ART.WASH_30_VERY_MILD).toContain('scale(0.74)');
  });

  it('gives the shade variants a stroke the plain method does not have', () => {
    expect(CARE_SYMBOL_ART.DRY_FLAT_SHADE).toContain(CARE_SYMBOL_ART.DRY_FLAT);
    expect(CARE_SYMBOL_ART.DRY_FLAT_SHADE.length).toBeGreaterThan(
      CARE_SYMBOL_ART.DRY_FLAT.length,
    );
  });

  it('keeps the temperature legible inside the washtub', () => {
    expect(CARE_SYMBOL_ART.WASH_95).toContain('>95<');
    expect(CARE_SYMBOL_ART.WASH_70).toContain('>70<');
    expect(CARE_SYMBOL_ART.WASH_50).toContain('>50<');
  });
});

describe('every symbol says what it means', () => {
  it('is described in all three shop-floor languages', () => {
    for (const symbol of CARE_SYMBOLS) {
      const entry = CARE_SYMBOL_LABELS[symbol];
      expect(entry, symbol).toBeTruthy();
      for (const locale of ['vi', 'pl', 'en'] as const) {
        expect(entry[locale], `${symbol}.${locale}`).toBeTruthy();
        // A description that is just the enum name is no description.
        expect(entry[locale], `${symbol}.${locale}`).not.toBe(symbol);
      }
    }
  });

  it('never reuses one description for two different symbols', () => {
    for (const locale of ['vi', 'pl', 'en'] as const) {
      const texts = CARE_SYMBOLS.map((symbol) => CARE_SYMBOL_LABELS[symbol][locale]);
      expect(new Set(texts).size, locale).toBe(texts.length);
    }
  });

  it('answers in the asked language and falls back to English', () => {
    expect(careSymbolLabel('WASH_NO', 'vi')).toBe('Không giặt');
    expect(careSymbolLabel('WASH_NO', 'pl')).toBe('Nie prać');
    expect(careSymbolLabel('WASH_NO', 'de')).toBe('Do not wash');
  });
});

describe('the families are the exclusivity rule', () => {
  it('lets a tag carry one symbol from each family at once', () => {
    const oneEach = CARE_SYMBOL_FAMILIES.map((family) => family.symbols[0]);
    expect(parseFabricTagData(tag([...oneEach])).careSymbols).toEqual(oneEach);
  });

  it('refuses two symbols from the same family', () => {
    for (const family of FABRIC_TAG_EXCLUSIVE_CARE_SYMBOL_GROUPS) {
      expect(() => parseFabricTagData(tag([family[0], family[1]])), family[0])
        .toThrow(/careSymbols/);
    }
  });

  it('keeps tumble drying and natural drying independent', () => {
    // The commonest marking on knitwear: no machine, lay it flat.
    expect(parseFabricTagData(tag(['TUMBLE_NO', 'DRY_FLAT'])).careSymbols)
      .toEqual(['TUMBLE_NO', 'DRY_FLAT']);
  });

  it('keeps dry cleaning and wet cleaning independent', () => {
    expect(parseFabricTagData(tag(['DRYCLEAN_P', 'WETCLEAN_NO'])).careSymbols)
      .toEqual(['DRYCLEAN_P', 'WETCLEAN_NO']);
  });
});
