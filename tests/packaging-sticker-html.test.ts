import { describe, it, expect } from 'vitest';
import {
  buildPackagingStickerHtml,
  PACKAGING_STICKER_BARCODE_ENABLED,
  PACKAGING_STICKER_LIMITS,
  parsePackagingSticker,
  layoutPackagingStickerText,
  stickerLinesNeeded,
} from '../src/shared/packaging-sticker';

/**
 * Layout target is the sticker the customer supplied, photographed at the
 * factory (see docs/superpowers/specs/2026-09-02-label-print-order-design.md):
 *
 *   MoonCollection        <- customer
 *   |||| || ||||          <- Code 128 of the bag code
 *   SP006290              <- the same code, readable
 *   KURTKA - 114          <- kind of garment - style code
 *   CAPPUCCINO            <- colour
 *
 * The barcode was off for a day and the owner asked for it back; the switch
 * is kept so the decision stays one line.
 */
const SAMPLE = {
  customerName: 'MoonCollection',
  styleName: 'KURTKA',
  styleCode: '114',
  colorName: 'CAPPUCCINO',
  code: 'SP006290',
  widthMm: 50,
  heightMm: 30,
};

describe('parsePackagingSticker', () => {
  it('accepts the factory sample', () => {
    const parsed = parsePackagingSticker(SAMPLE);
    expect(parsed.code).toBe('SP006290');
    expect(parsed.sizeText).toBeUndefined();
  });

  it('trims surrounding whitespace so a stray space cannot change the barcode', () => {
    const parsed = parsePackagingSticker({ ...SAMPLE, code: '  SP006290  ' });
    expect(parsed.code).toBe('SP006290');
  });

  it('needs a code, since the barcode is printed again', () => {
    expect(() => parsePackagingSticker({ ...SAMPLE, code: '   ' })).toThrow(/code/);
  });

  it('refuses a code Code 128 cannot carry, here rather than at the printer', () => {
    expect(() => parsePackagingSticker({ ...SAMPLE, code: 'CZEKOLADĄ' })).toThrow();
  });

  it('caps each text field so long input cannot silently overflow the sticker', () => {
    const tooLong = 'X'.repeat(PACKAGING_STICKER_LIMITS.textChars + 1);
    expect(() => parsePackagingSticker({ ...SAMPLE, customerName: tooLong })).toThrow(/customerName/);
    expect(() => parsePackagingSticker({ ...SAMPLE, colorName: tooLong })).toThrow(/colorName/);
  });

  it('rejects control characters, which would break the HTML document', () => {
    const withControlChar = `CAPP\x00UCCINO`;
    expect(() => parsePackagingSticker({ ...SAMPLE, colorName: withControlChar })).toThrow(
      /control/i,
    );
  });

  it('rejects a non-positive or oversized label geometry', () => {
    expect(() => parsePackagingSticker({ ...SAMPLE, widthMm: 0 })).toThrow(/widthMm/);
    expect(() => parsePackagingSticker({ ...SAMPLE, heightMm: -3 })).toThrow(/heightMm/);
    expect(() =>
      parsePackagingSticker({ ...SAMPLE, widthMm: PACKAGING_STICKER_LIMITS.maxSideMm + 1 }),
    ).toThrow(/widthMm/);
  });

  it('carries no size at all — a size was wrong for a bag of mixed sizes', () => {
    expect(parsePackagingSticker({ ...SAMPLE, sizeText: 'M' } as never))
      .not.toHaveProperty('sizeText');
  });
});

describe('buildPackagingStickerHtml', () => {
  const html = buildPackagingStickerHtml(parsePackagingSticker(SAMPLE));

  it('prints the five lines of the customer sample', () => {
    expect(html).toContain('MoonCollection');
    expect(html).toContain('KURTKA - 114');
    expect(html).toContain('CAPPUCCINO');
    expect(html).toContain('<div class="code">SP006290</div>');
  });

  it('prints the barcode again, as the owner asked', () => {
    expect(PACKAGING_STICKER_BARCODE_ENABLED).toBe(true);
    expect(html).toContain('<div class="barcode">');
    expect(html).toContain('<svg');
  });

  it('clips inside a box the print path honours, never onto a second label', () => {
    // overflow on the body is ignored when printing; the excess became page two.
    expect(html).toMatch(/\.sheet \{[^}]*overflow:hidden/);
    expect(html).toMatch(/\.sheet \{[^}]*justify-content:safe center/);
    expect(html).toContain('<div class="sheet">');
  });

  it('sets the page box to the configured label size so the driver cannot rescale', () => {
    expect(html).toContain('@page { size: 50mm 30mm; margin: 0; }');
    expect(html).toContain('width:50mm');
    expect(html).toContain('height:30mm');
  });

  it('omits the style separator when there is no style code', () => {
    const noCode = buildPackagingStickerHtml(
      parsePackagingSticker({ ...SAMPLE, styleCode: '' }),
    );
    expect(noCode).toContain('KURTKA');
    expect(noCode).not.toContain('KURTKA - ');
  });

  it('prints the colour alone, never a size beside it', () => {
    const withSize = buildPackagingStickerHtml(
      parsePackagingSticker({ ...SAMPLE, sizeText: 'M' } as never),
    );
    expect(withSize).toContain('CAPPUCCINO');
    expect(withSize).not.toContain('CAPPUCCINO · M');
    expect(withSize).not.toContain('>M<');
    expect(html).not.toContain('·');
  });

  it('escapes HTML so a customer name cannot inject markup into the label', () => {
    const injected = buildPackagingStickerHtml(
      parsePackagingSticker({ ...SAMPLE, customerName: '<b>Moon</b>' }),
    );
    expect(injected).toContain('&lt;b&gt;Moon&lt;/b&gt;');
    expect(injected).not.toContain('<b>Moon</b>');
  });

  it('escapes ampersands and quotes, not just angle brackets', () => {
    // "H&M" is an ordinary customer name; unescaped it corrupts the document.
    const amp = buildPackagingStickerHtml(
      parsePackagingSticker({ ...SAMPLE, customerName: 'H&M "PL"' }),
    );
    expect(amp).toContain('H&amp;M &quot;PL&quot;');
    expect(amp).not.toMatch(/H&M/);
  });

  it('renders black on white with colour adjustment forced, for a thermal head', () => {
    expect(html).toContain('print-color-adjust:exact');
    expect(html).toContain('background:#fff');
  });
});

describe('long text has to fit the label, not run off it', () => {
  const LIMIT = PACKAGING_STICKER_LIMITS.textChars;
  const worst = () => parsePackagingSticker({
    customerName: 'M'.repeat(LIMIT),
    styleName: 'K'.repeat(LIMIT),
    styleCode: '9'.repeat(8),
    colorName: 'C'.repeat(LIMIT),
    sizeText: '44/46',
    code: 'S'.repeat(LIMIT),
    widthMm: 50,
    heightMm: 30,
  });

  it('wraps a long word instead of letting it run past the edge', () => {
    // The label is overflow:hidden, and a style code has no spaces to break at.
    const html = buildPackagingStickerHtml(worst());
    expect(html).toContain('overflow-wrap:anywhere');
    expect(html).toContain('word-break:break-word');
  });

  it('steps the type down as far as the head can resolve when nothing else fits', () => {
    // Three forty-character lines and a code do not fit a 50x30 under a
    // barcode at any legible size. The type stops at the floor and the tail is
    // clipped inside the label — the estimate says so instead of pretending.
    const layout = layoutPackagingStickerText(worst());
    expect(layout.customerPt).toBe(5);
    expect(layout.textMm).toBeGreaterThan(layout.budgetMm);
  });

  it('steps the type down until a long colour fits, and no further', () => {
    const layout = layoutPackagingStickerText(parsePackagingSticker({
      ...worst(),
      styleName: 'KOMPLETY DRESOWE',
      colorName: 'CZARNY Z BIAŁYM PASKIEM I KAPTUREM',
    }));
    expect(layout.textMm).toBeLessThanOrEqual(layout.budgetMm);
    expect(layout.colorPt).toBeLessThan(6.5);
    expect(layout.colorPt).toBeGreaterThan(5);
  });

  it('leaves a sticker that already fits at the sample sizes', () => {
    const layout = layoutPackagingStickerText(parsePackagingSticker({
      customerName: 'New Fashion',
      styleName: 'KURTKA',
      styleCode: '114',
      colorName: 'CZEKOLADA',
      code: 'SP006290',
      widthMm: 50,
      heightMm: 30,
    }));
    expect(layout.customerPt).toBe(6.5);
    expect(layout.stylePt).toBe(6.5);
    expect(layout.colorPt).toBe(6.5);
    expect(layout.textMm).toBeLessThanOrEqual(layout.budgetMm);
  });

  it('fits the sticker that came out on two labels, on one', () => {
    // 04/09: MOONCOLLECTION / KOMPLETY DRESOWE - 115 / CZARNY at 50x30 measured
    // as fitting and printed as five wrapped lines across two labels.
    const layout = layoutPackagingStickerText(parsePackagingSticker({
      customerName: 'MOONCOLLECTION',
      styleName: 'KOMPLETY DRESOWE',
      styleCode: '115',
      colorName: 'CZARNY',
      code: 'SP123456',
      widthMm: 50,
      heightMm: 30,
    }));
    expect(layout.textMm).toBeLessThanOrEqual(layout.budgetMm);
    expect(layout.stylePt).toBe(6.5);
  });

  it('never shrinks below what the print head can resolve', () => {
    // A 20mm-tall label leaves almost nothing once the barcode has its share;
    // the floor has to hold rather than let the type vanish.
    const layout = layoutPackagingStickerText(parsePackagingSticker({
      customerName: 'M'.repeat(LIMIT),
      styleName: 'K'.repeat(LIMIT),
      styleCode: '9'.repeat(8),
      colorName: 'C'.repeat(LIMIT),
      code: 'S'.repeat(LIMIT),
      widthMm: 30,
      heightMm: 20,
    }));
    for (const pt of [layout.customerPt, layout.codePt, layout.stylePt, layout.colorPt]) {
      expect(pt).toBeGreaterThanOrEqual(5);
    }
  });

  it('counts lines the way the browser breaks them: at spaces, then anywhere', () => {
    // Bold capitals at 17.4pt in 45mm hold about ten characters a line.
    expect(stickerLinesNeeded('KOMPLETY DRESOWE - 115', 17.4, 45)).toBe(3);
    expect(stickerLinesNeeded('KOMPLETY DRESOWE - 115', 6.5, 45)).toBe(1);
    // One word longer than the line is broken inside, after moving down.
    expect(stickerLinesNeeded('MOONCOLLECTION', 17.4, 45)).toBe(2);
    expect(stickerLinesNeeded('AB MOONCOLLECTION', 17.4, 45)).toBe(3);
    expect(stickerLinesNeeded('', 10, 45)).toBe(0);
  });

  it('puts the sizes it decided into the stylesheet it prints', () => {
    const sticker = worst();
    const layout = layoutPackagingStickerText(sticker);
    expect(buildPackagingStickerHtml(sticker))
      .toContain(`.customer { font-size:${layout.customerPt.toFixed(1)}pt`);
  });
});
