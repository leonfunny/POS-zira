import { describe, it, expect } from 'vitest';
import {
  buildPackagingStickerHtml,
  PACKAGING_STICKER_LIMITS,
  parsePackagingSticker,
  layoutPackagingStickerText,
  stickerLinesNeeded,
} from '../src/shared/packaging-sticker';

/**
 * Three lines since 04/09, when the barcode and the bag code under it came off
 * for good — no reader in the workshop, and the code was generated rather than
 * meaningful:
 *
 *   MOONCOLLECTION        <- customer
 *   KURTKA - 114          <- kind of garment - style code
 *   CAPPUCCINO            <- colour
 */
const SAMPLE = {
  customerName: 'MoonCollection',
  styleName: 'KURTKA',
  styleCode: '114',
  colorName: 'CAPPUCCINO',
  widthMm: 50,
  heightMm: 30,
};

describe('parsePackagingSticker', () => {
  it('accepts the factory sample', () => {
    const parsed = parsePackagingSticker(SAMPLE);
    expect(parsed.customerName).toBe('MoonCollection');
    expect(parsed.sizeText).toBeUndefined();
  });

  it('trims surrounding whitespace so a stray space cannot shift a line', () => {
    const parsed = parsePackagingSticker({ ...SAMPLE, colorName: '  CAPPUCCINO  ' });
    expect(parsed.colorName).toBe('CAPPUCCINO');
  });

  it('drops the bag code a caller may still be sending: nothing prints it', () => {
    expect(parsePackagingSticker({ ...SAMPLE, code: 'SP006290' } as never))
      .not.toHaveProperty('code');
  });

  it('prints a sticker that has only a colour rather than refusing the run', () => {
    const bare = parsePackagingSticker({ colorName: 'CAPPUCCINO', widthMm: 50, heightMm: 30 });
    expect(bare.customerName).toBe('');
    expect(buildPackagingStickerHtml(bare)).toContain('CAPPUCCINO');
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

  it('prints the three lines of the customer sample', () => {
    expect(html).toContain('MoonCollection');
    expect(html).toContain('KURTKA - 114');
    expect(html).toContain('CAPPUCCINO');
  });

  it('prints no barcode and no code line, as the owner asked', () => {
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('class="barcode"');
    expect(html).not.toContain('class="code"');
    expect(html).not.toContain('SP006290');
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
    widthMm: 50,
    heightMm: 30,
  });

  it('wraps a long word instead of letting it run past the edge', () => {
    // The label is overflow:hidden, and a style code has no spaces to break at.
    const html = buildPackagingStickerHtml(worst());
    expect(html).toContain('overflow-wrap:anywhere');
    expect(html).toContain('word-break:break-word');
  });

  it('now fits the worst sticker in the catalogue, which used to be clipped', () => {
    // Three forty-character lines did not fit a 50x30 under the barcode at any
    // legible size; with those 12mm back the same sticker fits, stepped down.
    const layout = layoutPackagingStickerText(worst());
    expect(layout.textMm).toBeLessThanOrEqual(layout.budgetMm);
    expect(layout.customerPt).toBeLessThan(11);
    expect(layout.customerPt).toBeGreaterThan(5);
  });

  it('steps the type down until a long colour fits, and no further', () => {
    const layout = layoutPackagingStickerText(parsePackagingSticker({
      ...worst(),
      styleName: 'KOMPLETY DRESOWE',
      colorName: 'CZARNY Z BIAŁYM PASKIEM I KAPTUREM',
    }));
    expect(layout.textMm).toBeLessThanOrEqual(layout.budgetMm);
    expect(layout.colorPt).toBeLessThan(13);
    expect(layout.colorPt).toBeGreaterThan(5);
  });

  it('leaves a sticker that already fits at the sample sizes', () => {
    const layout = layoutPackagingStickerText(parsePackagingSticker({
      customerName: 'New Fashion',
      styleName: 'KURTKA',
      styleCode: '114',
      colorName: 'CZEKOLADA',
      widthMm: 50,
      heightMm: 30,
    }));
    // The sizes the 45mm text column allows: "MARYNARKA - 111" is the longest
    // line the catalogue produces and it holds one line at 11pt, two at 12.
    expect(layout.customerPt).toBe(11);
    expect(layout.stylePt).toBe(11);
    expect(layout.colorPt).toBe(13);
    expect(layout.textMm).toBeLessThanOrEqual(layout.budgetMm);
  });

  it('keeps the longest style line in the catalogue on one line', () => {
    expect(stickerLinesNeeded('MARYNARKA - 111', 11, 45)).toBe(1);
    expect(stickerLinesNeeded('MARYNARKA - 111', 12, 45)).toBe(2);
  });

  it('fits the sticker that came out on two labels, on one', () => {
    // 04/09: MOONCOLLECTION / KOMPLETY DRESOWE - 115 / CZARNY at 50x30 measured
    // as fitting and printed as five wrapped lines across two labels.
    const layout = layoutPackagingStickerText(parsePackagingSticker({
      customerName: 'MOONCOLLECTION',
      styleName: 'KOMPLETY DRESOWE',
      styleCode: '115',
      colorName: 'CZARNY',
      widthMm: 50,
      heightMm: 30,
    }));
    expect(layout.textMm).toBeLessThanOrEqual(layout.budgetMm);
    expect(layout.stylePt).toBe(11);
  });

  it('never shrinks below what the print head can resolve', () => {
    // A 30x20 label with three forty-character lines is past what any legible
    // type can hold; the floor has to hold rather than let the type vanish.
    const layout = layoutPackagingStickerText(parsePackagingSticker({
      customerName: 'M'.repeat(LIMIT),
      styleName: 'K'.repeat(LIMIT),
      styleCode: '9'.repeat(8),
      colorName: 'C'.repeat(LIMIT),
      widthMm: 30,
      heightMm: 20,
    }));
    for (const pt of [layout.customerPt, layout.stylePt, layout.colorPt]) {
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
