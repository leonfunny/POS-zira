import { describe, it, expect } from 'vitest';
import {
  buildPackagingStickerHtml,
  PACKAGING_STICKER_BARCODE_ENABLED,
  PACKAGING_STICKER_LIMITS,
  parsePackagingSticker,
  layoutPackagingStickerText,
} from '../src/shared/packaging-sticker';

/**
 * Layout target is the sticker the customer supplied, photographed at the
 * factory (see docs/superpowers/specs/2026-09-02-label-print-order-design.md):
 *
 *   MoonCollection        <- customer
 *   KURTKA - 114          <- style name - style code
 *   CAPPUCCINO            <- colour
 *
 * The former SP code and Code 128 stay behind a switch in production source,
 * but the workshop does not want either printed today.
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

  it('accepts an empty legacy code because the visible sticker no longer uses it', () => {
    expect(parsePackagingSticker({ ...SAMPLE, code: '   ' }).code).toBe('');
  });

  it('does not apply barcode symbology rules while barcode printing is disabled', () => {
    expect(parsePackagingSticker({ ...SAMPLE, code: 'CZEKOLADĄ' }).code).toBe('CZEKOLADĄ');
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

  it('prints only the four details the workshop asked for', () => {
    expect(html).toContain('MoonCollection');
    expect(html).toContain('KURTKA - 114');
    expect(html).toContain('CAPPUCCINO');
    expect(html).not.toContain('SP006290');
  });

  it('keeps the reversible barcode switch off and emits no barcode graphics', () => {
    expect(PACKAGING_STICKER_BARCODE_ENABLED).toBe(false);
    expect(html).not.toContain('<div class="barcode">');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<rect ');
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

  it('steps the type down until the wrapped text fits the space left', () => {
    const layout = layoutPackagingStickerText(worst());
    expect(layout.textMm).toBeLessThanOrEqual(layout.budgetMm);
    expect(layout.customerPt).toBeLessThan(12);
  });

  it('leaves a sticker that already fits at full size', () => {
    const layout = layoutPackagingStickerText(parsePackagingSticker({
      customerName: 'New Fashion',
      styleName: 'KURTKA',
      styleCode: '114',
      colorName: 'CZEKOLADA',
      code: 'SP006290',
      widthMm: 50,
      heightMm: 30,
    }));
    expect(layout.customerPt).toBeGreaterThan(10);
    expect(layout.stylePt).toBeGreaterThan(14);
    expect(layout.colorPt).toBeGreaterThan(12);
    expect(layout.textMm).toBeLessThanOrEqual(layout.budgetMm);
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

  it('puts the sizes it decided into the stylesheet it prints', () => {
    const sticker = worst();
    const layout = layoutPackagingStickerText(sticker);
    expect(buildPackagingStickerHtml(sticker))
      .toContain(`.customer { font-size:${layout.customerPt.toFixed(1)}pt`);
  });
});
