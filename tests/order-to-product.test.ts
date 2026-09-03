import { describe, it, expect } from 'vitest';

import { createEmptyOrder, LabelPrintOrder } from '../src/shared/label-print-order';
import {
  MAX_PRODUCT_VARIANTS,
  buildProductDraft,
  groszeToText,
  resolveCategoryForStyle,
  skuToken,
  textToGrosze,
  validateProductDraft,
} from '../src/shared/order-to-product';

/**
 * A sheet as it looks on the panel: colours down the side, sizes across the top,
 * quantities in the cells.
 */
function sheet(
  colours: Array<{ name: string; quantities: number[] }>,
  sizeLabels: string[],
  overrides: Partial<LabelPrintOrder> = {},
): LabelPrintOrder {
  const sizes = sizeLabels.map((label, index) => ({ id: `s${index}`, label }));
  return {
    ...createEmptyOrder(),
    styleName: 'Kurtka LOTUS',
    styleCode: 'LOT114',
    sizes,
    rows: colours.map((colour, index) => ({
      id: `r${index}`,
      colorName: colour.name,
      code: '',
      quantities: Object.fromEntries(
        sizes.map((size, sizeIndex) => [size.id, colour.quantities[sizeIndex] ?? 0]),
      ),
    })),
    ...overrides,
  };
}

const TWO_BY_TWO = sheet(
  [
    { name: 'Beżowy', quantities: [4, 2] },
    { name: 'Czarny', quantities: [7, 3] },
  ],
  ['M', 'L'],
);

describe('buildProductDraft', () => {
  it('makes one variant per filled cell', () => {
    const draft = buildProductDraft(TWO_BY_TWO);

    expect(draft.variants.map((v) => [v.colorName, v.sizeName, v.initialStockQty])).toEqual([
      ['Beżowy', 'M', 4],
      ['Beżowy', 'L', 2],
      ['Czarny', 'M', 7],
      ['Czarny', 'L', 3],
    ]);
  });

  it('skips the cells nobody ordered', () => {
    const draft = buildProductDraft(
      sheet(
        [
          { name: 'Beżowy', quantities: [4, 0] },
          { name: 'Czarny', quantities: [0, 0] },
          { name: 'Biały', quantities: [0, 5] },
        ],
        ['M', 'L'],
      ),
    );

    expect(draft.variants.map((v) => [v.colorName, v.sizeName])).toEqual([
      ['Beżowy', 'M'],
      ['Biały', 'L'],
    ]);
  });

  it('treats a negative quantity as an empty cell', () => {
    const draft = buildProductDraft(
      sheet([{ name: 'Beżowy', quantities: [-3, 2] }], ['M', 'L']),
    );

    expect(draft.variants.map((v) => v.sizeName)).toEqual(['L']);
  });

  it('makes one variant per colour when the sheet has no size columns', () => {
    const draft = buildProductDraft(
      sheet([{ name: 'Beżowy', quantities: [] }, { name: 'Czarny', quantities: [] }], []),
    );

    expect(draft.variants.map((v) => [v.colorName, v.sizeName, v.initialStockQty])).toEqual([
      ['Beżowy', null, 0],
      ['Czarny', null, 0],
    ]);
  });

  it('ignores a colour row left blank on a sheet with no sizes', () => {
    const draft = buildProductDraft(
      sheet([{ name: '  ', quantities: [] }, { name: 'Czarny', quantities: [] }], []),
    );

    expect(draft.variants.map((v) => v.colorName)).toEqual(['Czarny']);
  });

  it('ignores a size column whose header was never typed', () => {
    const order = sheet([{ name: 'Beżowy', quantities: [4, 9] }], ['M', '   ']);
    const draft = buildProductDraft(order);

    expect(draft.variants.map((v) => v.sizeName)).toEqual(['M']);
  });

  it('builds a SKU from style code, colour and size', () => {
    const draft = buildProductDraft(TWO_BY_TWO);

    expect(draft.variants.map((v) => v.sku)).toEqual([
      'LOT114-BEZOWY-M',
      'LOT114-BEZOWY-L',
      'LOT114-CZARNY-M',
      'LOT114-CZARNY-L',
    ]);
  });

  it('leaves the SKU to the server when the sheet has no style code', () => {
    const draft = buildProductDraft(sheet([{ name: 'Beżowy', quantities: [4] }], ['M'], {
      styleCode: '',
    }));

    expect(draft.sku).toBeNull();
    expect(draft.variants[0].sku).toBeNull();
  });

  it('breaks a SKU collision rather than sending the same code twice', () => {
    // Both colours fold to the same 12 characters, and the server rejects a grid
    // holding one SKU twice.
    const draft = buildProductDraft(
      sheet(
        [
          { name: 'Czarny fioletowy jasny', quantities: [1] },
          { name: 'Czarnyfioletowyciemny', quantities: [1] },
        ],
        ['M'],
      ),
    );

    const skus = draft.variants.map((v) => v.sku);
    expect(new Set(skus).size).toBe(2);
    expect(skus[1]).toBe(`${skus[0]}-2`);
  });

  it('carries the name and price straight through', () => {
    const draft = buildProductDraft(
      sheet([{ name: 'Beżowy', quantities: [1] }], ['M'], {
        styleName: '  Kurtka LOTUS  ',
        priceGrossGrosze: 12900,
      }),
    );

    expect(draft.name).toBe('Kurtka LOTUS');
    expect(draft.priceGrossGrosze).toBe(12900);
  });

  it('survives a sheet saved before these fields existed', () => {
    const legacy = sheet([{ name: 'Beżowy', quantities: [1] }], ['M']);
    delete (legacy as Partial<LabelPrintOrder>).priceGrossGrosze;

    const draft = buildProductDraft(legacy);

    expect(draft.priceGrossGrosze).toBe(0);
  });
});

describe('skuToken', () => {
  it('folds Polish letters instead of dropping them', () => {
    expect(skuToken('Beżowy')).toBe('BEZOWY');
    expect(skuToken('Biały')).toBe('BIALY');
    expect(skuToken('Żółty')).toBe('ZOLTY');
  });

  it('drops punctuation and spacing', () => {
    expect(skuToken('S/M')).toBe('SM');
    expect(skuToken('44 / 46')).toBe('4446');
  });

  it('is empty when nothing usable is left', () => {
    expect(skuToken('///')).toBe('');
  });
});

describe('money on the sheet', () => {
  it('reads the comma as the decimal point', () => {
    expect(textToGrosze('129,50')).toBe(12950);
  });

  it('reads a typed dot too, because the keypad makes one', () => {
    expect(textToGrosze('129.50')).toBe(12950);
  });

  it('reads a whole number of złoty', () => {
    expect(textToGrosze('129')).toBe(12900);
  });

  it('ignores spacing and a currency mark', () => {
    expect(textToGrosze('1 129,50 zł')).toBe(112950);
  });

  it('treats an unreadable price as no price rather than NaN', () => {
    expect(textToGrosze('abc')).toBe(0);
    expect(textToGrosze('')).toBe(0);
  });

  it('shows an empty field rather than 0,00 when nothing is priced', () => {
    expect(groszeToText(0)).toBe('');
    expect(groszeToText(undefined)).toBe('');
  });

  it('shows a price back in Polish notation', () => {
    expect(groszeToText(12950)).toBe('129,50');
    expect(groszeToText(12900)).toBe('129,00');
  });
});

describe('validateProductDraft', () => {
  it('passes a filled sheet', () => {
    expect(validateProductDraft(TWO_BY_TWO, buildProductDraft(TWO_BY_TWO))).toEqual([]);
  });

  it('refuses a sheet with no style name', () => {
    const order = sheet([{ name: 'Beżowy', quantities: [1] }], ['M'], { styleName: '  ' });

    expect(validateProductDraft(order, buildProductDraft(order))).toContain('NO_NAME');
  });

  it('refuses a sheet where every cell is empty', () => {
    const order = sheet([{ name: 'Beżowy', quantities: [0] }], ['M']);

    expect(validateProductDraft(order, buildProductDraft(order))).toContain('NO_CELLS');
  });

  it('refuses a sheet already filed, so a second press cannot duplicate it', () => {
    const order = { ...TWO_BY_TWO, productId: 'product-1' };

    expect(validateProductDraft(order, buildProductDraft(order))).toContain('ALREADY_FILED');
  });

  it('refuses a grid past the server ceiling', () => {
    const colours = Array.from({ length: MAX_PRODUCT_VARIANTS + 1 }, (_, i) => ({
      name: `Kolor ${i}`,
      quantities: [1],
    }));
    const order = sheet(colours, ['M']);

    expect(validateProductDraft(order, buildProductDraft(order))).toContain(
      'TOO_MANY_VARIANTS',
    );
  });

  it('accepts a grid exactly at the ceiling', () => {
    const colours = Array.from({ length: MAX_PRODUCT_VARIANTS }, (_, i) => ({
      name: `Kolor ${i}`,
      quantities: [1],
    }));
    const order = sheet(colours, ['M']);

    expect(validateProductDraft(order, buildProductDraft(order))).toEqual([]);
  });
});

describe('resolveCategoryForStyle', () => {
  const CATEGORIES = [
    { id: 'cat-jackets', name: 'Kurtki' },
    { id: 'cat-tracksuits', name: 'Komplety dresowe' },
  ];

  it('matches the style the operator picked to the salon category', () => {
    expect(resolveCategoryForStyle('KURTKA', CATEGORIES)?.id).toBe('cat-jackets');
    expect(resolveCategoryForStyle('KOMPLET DRESOWY', CATEGORIES)?.id).toBe(
      'cat-tracksuits',
    );
  });

  it('ignores case, spacing and Polish diacritics in the category name', () => {
    expect(
      resolveCategoryForStyle('  kurtka ', [{ id: 'c', name: ' KÓRTKI ' }]),
    ).toBeNull();
    expect(
      resolveCategoryForStyle('kurtka', [{ id: 'c', name: '  kurtki  ' }])?.id,
    ).toBe('c');
  });

  it('returns null for a style the shop invented, rather than a wrong category', () => {
    expect(resolveCategoryForStyle('SUKIENKA', CATEGORIES)).toBeNull();
  });

  it('returns null when the salon has no category by that name', () => {
    expect(resolveCategoryForStyle('KURTKA', [{ id: 'c', name: 'Spodnie' }])).toBeNull();
  });
});
