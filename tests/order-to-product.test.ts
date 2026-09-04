import { describe, it, expect } from 'vitest';

import { createEmptyOrder, LabelPrintOrder } from '../src/shared/label-print-order';
import {
  MAX_PRODUCT_VARIANTS,
  buildAddedVariant,
  buildMissingVariants,
  buildProductDraft,
  priceForColour,
  rowBelongsToStyle,
  styleCodeOfRow,
  styleNameOfRow,
  groszeToText,
  resolveCategoryForStyle,
  resolveOrderCategory,
  sameStyleCode,
  skuToken,
  textToGrosze,
  validateAddedCell,
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
    customerName: 'MOON',
    styleName: 'Kurtka LOTUS',
    styleCode: 'LOT114',
    priceGrossGrosze: 12900,
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

describe('a price per colour', () => {
  // The shop sells a colour dearer than the rest; sizes never differ.
  const order = {
    ...sheet([], ['S', 'M']),
    rows: [
      { id: 'r1', colorName: 'BEŻOWY', code: '', quantities: {} },
      { id: 'r2', colorName: 'CZARNY', code: '', quantities: {}, priceGrossGrosze: 3500 },
      { id: 'r3', colorName: 'BORDO', code: '', quantities: {}, priceGrossGrosze: 0 },
    ],
  };

  it('puts the colour price on every row of that colour, and none on the others', () => {
    const draft = buildProductDraft(order);
    const byColour = (colour: string) => draft.variants.filter((v) => v.colorName === colour).map((v) => v.priceGrossGrosze);
    expect(byColour('CZARNY')).toEqual([3500, 3500]);
    expect(byColour('BEŻOWY')).toEqual([undefined, undefined]);
    // Zero is "not typed", not "free".
    expect(byColour('BORDO')).toEqual([undefined, undefined]);
  });

  it('answers the price a colour sells at, the sheet\'s when it has none of its own', () => {
    expect(priceForColour(order, 'czarny')).toBe(3500);
    expect(priceForColour(order, 'BEŻOWY')).toBe(12900);
    expect(priceForColour(order, 'BORDO')).toBe(12900);
    expect(priceForColour(order, 'NIEBIESKI')).toBe(12900);
  });
});

describe('styleCodeOfRow / rowBelongsToStyle', () => {
  // The server keeps no style code for a style filed from the sheet; the
  // rows' SKUs are all the tab has to recognise it by.
  it('takes the colour and size tokens back off a row SKU', () => {
    expect(styleCodeOfRow('115-CZARNY-S', 'CZARNY', 'S')).toBe('115');
    expect(styleCodeOfRow('LOT114-BEZOWY-M', 'Beżowy', 'M')).toBe('LOT114');
    expect(styleCodeOfRow('115-CZARNY-S-2', 'CZARNY', 'S')).toBe('115');
    expect(styleCodeOfRow('MOON-VE114-BEZ', 'beżowy', 'UNI')).toBe('MOON-VE114-BEZ');
    expect(styleCodeOfRow('115-M', null, 'M')).toBe('115');
    expect(styleCodeOfRow(null, 'CZARNY', 'S')).toBe('');
  });

  it('takes the style name back off a row name the server built', () => {
    expect(styleNameOfRow('KOMPLET DRESOWY - CZARNY / S', 'CZARNY', 'S')).toBe('KOMPLET DRESOWY');
    expect(styleNameOfRow('Komplet - Bordo / M', 'BORDO', 'm')).toBe('Komplet');
    expect(styleNameOfRow('KURTKA - CZARNY', 'CZARNY', null)).toBe('KURTKA');
    expect(styleNameOfRow('KURTKA - UNI', '', 'UNI')).toBe('KURTKA');
    expect(styleNameOfRow('KURTKA ZIMOWA', 'CZARNY', 'S')).toBe('KURTKA ZIMOWA');
    expect(styleNameOfRow(' - CZARNY / S', 'CZARNY', 'S')).toBe('- CZARNY / S');
    expect(styleNameOfRow(null, 'CZARNY', 'S')).toBe('');
  });

  it('knows which rows were built from a style code, and which merely start alike', () => {
    expect(rowBelongsToStyle('115-CZARNY-S', '115')).toBe(true);
    expect(rowBelongsToStyle('115-CZARNY-S', ' 115 ')).toBe(true);
    expect(rowBelongsToStyle('MOON-VE114-BEZ', 'MOON-VE114')).toBe(true);
    expect(rowBelongsToStyle('lot114-bezowy-s', 'LOT114')).toBe(true);
    expect(rowBelongsToStyle('115-CZARNY-S', '11')).toBe(false);
    expect(rowBelongsToStyle('115-CZARNY-S', '1150')).toBe(false);
    expect(rowBelongsToStyle('115-CZARNY-S', '')).toBe(false);
  });
});

describe('buildProductDraft', () => {
  it('makes one variant per colour and size, with the stock opened at zero', () => {
    // The sheet counts garments per size and bags per colour; it does not say
    // how many of each colour × size, so the web order carries those numbers.
    const draft = buildProductDraft(TWO_BY_TWO);

    expect(draft.variants.map((v) => [v.colorName, v.sizeName, v.initialStockQty])).toEqual([
      ['Beżowy', 'M', 0],
      ['Beżowy', 'L', 0],
      ['Czarny', 'M', 0],
      ['Czarny', 'L', 0],
    ]);
  });

  it('makes every colour in every size, whatever an old grid still holds', () => {
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
      ['Beżowy', 'M'], ['Beżowy', 'L'],
      ['Czarny', 'M'], ['Czarny', 'L'],
      ['Biały', 'M'], ['Biały', 'L'],
    ]);
  });

  it('skips a colour row left blank on a sheet with sizes', () => {
    const draft = buildProductDraft(
      sheet([{ name: '  ', quantities: [1, 1] }, { name: 'Czarny', quantities: [0, 0] }], ['M', 'L']),
    );
    expect(draft.variants.map((v) => v.colorName)).toEqual(['Czarny', 'Czarny']);
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

  it('keeps the style code as typed for the style itself, folding only the rows', () => {
    const draft = buildProductDraft(sheet([{ name: 'Czarny', quantities: [1] }], ['S'], {
      styleCode: ' moon-ve114 ',
    }));

    expect(draft.sku).toBe('MOON-VE114');
    expect(draft.variants[0].sku).toBe('MOONVE114-CZARNY-S');
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

describe('sameStyleCode', () => {
  it('matches without case and without stray blanks', () => {
    expect(sameStyleCode('moon-ve114', ' MOON-VE114 ')).toBe(true);
    expect(sameStyleCode('114', '115')).toBe(false);
  });

  it('never matches two blanks', () => {
    expect(sameStyleCode('', '')).toBe(false);
    expect(sameStyleCode('  ', '')).toBe(false);
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

  it('refuses a sheet without a price, since the whole style rings up at it', () => {
    const order = { ...TWO_BY_TWO, priceGrossGrosze: 0 };
    expect(validateProductDraft(order, buildProductDraft(order))).toContain('NO_PRICE');
    const priced = { ...TWO_BY_TWO, priceGrossGrosze: 1 };
    expect(validateProductDraft(priced, buildProductDraft(priced))).not.toContain('NO_PRICE');
  });

  it('refuses a sheet with no colour, and takes one whose sizes carry no numbers', () => {
    const empty = sheet([], ['M']);
    expect(validateProductDraft(empty, buildProductDraft(empty))).toContain('NO_CELLS');

    const order = sheet([{ name: 'Beżowy', quantities: [0] }], ['M']);
    expect(validateProductDraft(order, buildProductDraft(order))).not.toContain('NO_CELLS');
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

describe('adding a colour or size to a style that already exists', () => {
  const EXISTING = [
    { colorName: 'CZARNY', sizeName: 'S' },
    { colorName: 'CZARNY', sizeName: 'M' },
  ];

  it('files every style as not stock-tracked, because a workshop sews to order', () => {
    // Left tracked, the till refuses to sell at zero stock until goods that
    // were never bought are booked in.
    expect(buildProductDraft(TWO_BY_TWO).trackInventory).toBe(false);
  });

  it('builds the SKU the print order sheet would have built', () => {
    expect(
      buildAddedVariant('115', { colorName: 'ZIELONY', sizeName: 'L' }, []),
    ).toEqual({
      colorName: 'ZIELONY',
      sizeName: 'L',
      sku: '115-ZIELONY-L',
      // Stock arrives through the warehouse screens; this row is a label to
      // print, not a bundle that exists yet.
      initialStockQty: 0,
    });
  });

  it('steps around a SKU the style already carries', () => {
    // The server refuses a collision, and finding that out after the operator
    // has typed is worse than not offering the number.
    expect(
      buildAddedVariant('115', { colorName: 'ZIELONY', sizeName: 'L' }, [
        '115-ZIELONY-L',
      ]).sku,
    ).toBe('115-ZIELONY-L-2');
  });

  it('folds Polish spelling out of the SKU but keeps it on the label', () => {
    const added = buildAddedVariant('115', { colorName: 'BEŻOWY', sizeName: '' }, []);
    expect(added.sku).toBe('115-BEZOWY');
    expect(added.colorName).toBe('BEŻOWY');
    expect(added.sizeName).toBeNull();
  });

  it('needs a colour or a size', () => {
    expect(validateAddedCell({ colorName: '  ', sizeName: '' }, EXISTING)).toEqual([
      'NO_COLOR_OR_SIZE',
    ]);
    expect(validateAddedCell({ colorName: '', sizeName: 'XL' }, EXISTING)).toEqual([]);
  });

  it('refuses a cell the style already has, whatever case it is typed in', () => {
    expect(validateAddedCell({ colorName: 'CZARNY', sizeName: 'S' }, EXISTING)).toEqual([
      'ALREADY_EXISTS',
    ]);
    // The server compares exactly and would accept this; a till showing
    // "czarny" beside "CZARNY" cannot tell the two rows apart.
    expect(validateAddedCell({ colorName: 'czarny', sizeName: 's' }, EXISTING)).toEqual([
      'ALREADY_EXISTS',
    ]);
    expect(validateAddedCell({ colorName: 'CZARNY', sizeName: 'L' }, EXISTING)).toEqual([]);
  });
});

describe('resolveOrderCategory', () => {
  const CATEGORIES = [
    { id: 'cat-jackets', name: 'Kurtki' },
    { id: 'cat-trousers', name: 'Spodnie' },
  ];

  it('takes the category picked on the sheet over every guess', () => {
    const order = { styleName: 'KURTKA', categoryId: 'cat-trousers' };
    expect(resolveOrderCategory(order, CATEGORIES, { KURTKA: 'cat-jackets' })?.id).toBe(
      'cat-trousers',
    );
  });

  it('falls back to the category the machine learned for the style name', () => {
    const order = { styleName: ' spodnie ', categoryId: null };
    expect(resolveOrderCategory(order, CATEGORIES, { SPODNIE: 'cat-trousers' })?.id).toBe(
      'cat-trousers',
    );
  });

  it('falls back to the built-in guess when nothing was learned', () => {
    const order = { styleName: 'KURTKA', categoryId: null };
    expect(resolveOrderCategory(order, CATEGORIES)?.id).toBe('cat-jackets');
  });

  it('ignores a picked or learned category that no longer exists', () => {
    const order = { styleName: 'KURTKA', categoryId: 'cat-gone' };
    expect(resolveOrderCategory(order, CATEGORIES, { KURTKA: 'cat-also-gone' })?.id).toBe(
      'cat-jackets',
    );
  });

  it('is null for a style nobody has filed yet', () => {
    expect(resolveOrderCategory({ styleName: 'SUKIENKA', categoryId: null }, CATEGORIES)).toBeNull();
  });
});

describe('validateProductDraft — category', () => {
  it('refuses a sheet that resolved to no category', () => {
    expect(validateProductDraft(TWO_BY_TWO, buildProductDraft(TWO_BY_TWO), null)).toContain(
      'NO_CATEGORY',
    );
  });

  it('passes once a category is resolved', () => {
    const category = { id: 'cat-jackets', name: 'Kurtki' };
    expect(validateProductDraft(TWO_BY_TWO, buildProductDraft(TWO_BY_TWO), category)).toEqual([]);
  });

  it('does not check the category when the caller did not pass one', () => {
    expect(validateProductDraft(TWO_BY_TWO, buildProductDraft(TWO_BY_TWO))).toEqual([]);
  });
});

describe('buildMissingVariants', () => {
  const EXISTING = [
    { id: 'v1', color_name: 'BEŻOWY', size_name: 'M', sku: 'LOT114-BEZOWY-M' },
    { id: 'v2', color_name: 'czarny', size_name: 'm', sku: 'LOT114-CZARNY-M' },
  ];

  it('returns only the cells the style does not have, matched without case', () => {
    const missing = buildMissingVariants(TWO_BY_TWO, EXISTING);
    expect(missing.map((v) => [v.colorName, v.sizeName])).toEqual([
      ['Beżowy', 'L'],
      ['Czarny', 'L'],
    ]);
  });

  it('steps around a SKU the style already carries', () => {
    const existing = [{ id: 'v9', color_name: 'Other', size_name: 'X', sku: 'LOT114-BEZOWY-L' }];
    const missing = buildMissingVariants(TWO_BY_TWO, existing);
    expect(missing.find((v) => v.colorName === 'Beżowy' && v.sizeName === 'L')?.sku).toBe(
      'LOT114-BEZOWY-L-2',
    );
  });

  it('is empty when every cell is already there', () => {
    const all = [
      ...EXISTING,
      { id: 'v3', color_name: 'BEŻOWY', size_name: 'L', sku: 'x' },
      { id: 'v4', color_name: 'CZARNY', size_name: 'L', sku: 'y' },
    ];
    expect(buildMissingVariants(TWO_BY_TWO, all)).toEqual([]);
  });
});
