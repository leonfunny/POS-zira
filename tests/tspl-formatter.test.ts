import { describe, expect, it } from 'vitest';

import { TsplFormatter } from '../src/main/hardware/tsc/tspl-formatter';
import type { MonoBitmap } from '../src/main/hardware/tsc/fabric-tag-renderer';
import type { FabricTagData, LabelData } from '../src/shared/types';

/** TSPL is latin1 on the wire; decoding that way keeps binary bytes intact. */
function text(buffer: Buffer): string {
  return buffer.toString('latin1');
}

function label(overrides: Partial<LabelData> = {}): LabelData {
  return { barcode: '5901234123457', barcodeType: 'AUTO', quantity: 1, ...overrides };
}

function fabricTag(overrides: Partial<FabricTagData> = {}): FabricTagData {
  return { brandName: 'ZIRA', quantity: 1, ...overrides };
}

function fakeGraphic(widthDots: number, heightDots: number): MonoBitmap {
  const widthBytes = Math.ceil(widthDots / 8);
  return {
    widthDots,
    heightDots,
    widthBytes,
    // 0x00 = all black, so the payload is unmistakable in the byte stream.
    data: Buffer.alloc(widthBytes * heightDots, 0x00),
  };
}

describe('TsplFormatter media header', () => {
  it('declares size, gap, speed and density before clearing the buffer', () => {
    const out = text(new TsplFormatter(40, 60, 203, { gapMm: 3, speed: 2, density: 13 }).formatLabel(label()));
    expect(out).toContain('SIZE 40 mm,60 mm\r\n');
    expect(out).toContain('GAP 3 mm,0 mm\r\n');
    expect(out).toContain('SPEED 2\r\n');
    expect(out).toContain('DENSITY 13\r\n');
    // CLS must come after setup, otherwise the drawing commands are wiped.
    expect(out.indexOf('CLS')).toBeGreaterThan(out.indexOf('DENSITY 13'));
  });

  it('uses BLINE for black-mark media and a zero gap for continuous media', () => {
    expect(text(new TsplFormatter(40, 60, 203, { sensor: 'bline', gapMm: 4 }).formatLabel(label())))
      .toContain('BLINE 4 mm,0 mm');
    expect(text(new TsplFormatter(40, 60, 203, { sensor: 'none', gapMm: 4 }).formatLabel(label())))
      .toContain('GAP 0 mm,0 mm');
  });

  it('clamps darkness into the range the firmware accepts', () => {
    expect(text(new TsplFormatter(40, 60, 203, { density: 99 }).formatLabel(label()))).toContain('DENSITY 15');
    expect(text(new TsplFormatter(40, 60, 203, { density: -4 }).formatLabel(label()))).toContain('DENSITY 0');
  });
});

describe('TsplFormatter product labels', () => {
  it('picks EAN13 for a 13-digit barcode and CODE128 otherwise', () => {
    expect(text(new TsplFormatter().formatLabel(label({ barcode: '5901234123457' })))).toContain('"EAN13"');
    expect(text(new TsplFormatter().formatLabel(label({ barcode: 'SKU-77-A' })))).toContain('"128"');
  });

  it('honours an explicit QR request over the digit heuristic', () => {
    const out = text(new TsplFormatter().formatLabel(label({ barcode: '5901234123457', barcodeType: 'QR' })));
    expect(out).toContain('QRCODE ');
    expect(out).not.toContain('BARCODE ');
  });

  it('folds non-ASCII text down to what the internal fonts can render', () => {
    const out = text(new TsplFormatter().formatLabel(label({ text1: 'Áo thun đỏ — Łódź' })));
    expect(out).toContain('Ao thun do - Lodz');
  });

  it('escapes quotes and backslashes so a product name cannot break the command', () => {
    const out = text(new TsplFormatter().formatLabel(label({ text1: 'He said "hi" \\ bye' })));
    expect(out).toContain('He said \\"hi\\" \\\\ bye');
  });

  it('clamps the copy count into the range PRINT accepts', () => {
    expect(text(new TsplFormatter().formatLabel(label({ quantity: 0 })))).toContain('PRINT 1,1');
    expect(text(new TsplFormatter().formatLabel(label({ quantity: 5000 })))).toContain('PRINT 1,999');
    expect(text(new TsplFormatter().formatLabel(label({ quantity: NaN })))).toContain('PRINT 1,1');
  });
});

describe('TsplFormatter fabric tags', () => {
  it('declares the length the tag actually needs, not the configured maximum', () => {
    // Care-label ribbon is continuous: the configured height is a ceiling, and
    // a tag that fits in 18mm must advance 18mm or every tag leaves a blank
    // gap behind it. The rasteriser measures the content and the length it
    // returns has to reach SIZE.
    const formatter = new TsplFormatter(20, 60);
    const out = text(formatter.formatFabricTag(fabricTag(), fakeGraphic(formatter.widthDots, 144), 18));
    expect(out).toContain('SIZE 20 mm,18 mm');
    expect(out).not.toContain('SIZE 20 mm,60 mm');
  });

  it('falls back to the configured length when no measured length is given', () => {
    const formatter = new TsplFormatter(20, 60);
    const out = text(formatter.formatFabricTag(fabricTag(), fakeGraphic(formatter.widthDots, 480)));
    expect(out).toContain('SIZE 20 mm,60 mm');
  });

  it('emits the bitmap payload with no separator between the command and its bytes', () => {
    const formatter = new TsplFormatter(40, 60);
    const graphic = fakeGraphic(formatter.widthDots, 200);
    const out = formatter.formatFabricTag(fabricTag(), graphic);

    const header = `BITMAP 0,0,${graphic.widthBytes},200,0,`;
    const start = out.indexOf(Buffer.from(header, 'latin1'));
    expect(start).toBeGreaterThanOrEqual(0);

    // A CRLF here would be read as the first two pixels of the image.
    const payloadStart = start + header.length;
    expect(out.subarray(payloadStart, payloadStart + graphic.data.length)).toEqual(graphic.data);
    // ...and the payload is followed by the terminator, then the next command.
    expect(out.subarray(payloadStart + graphic.data.length, payloadStart + graphic.data.length + 2))
      .toEqual(Buffer.from('\r\n', 'latin1'));
  });

  it('places the barcode below the graphic block instead of over it', () => {
    const formatter = new TsplFormatter(40, 60);
    const graphic = fakeGraphic(formatter.widthDots, 300);
    const out = text(formatter.formatFabricTag(fabricTag({ barcode: 'SKU-1' }), graphic));

    const barcodeLine = out.split('\r\n').find((line) => line.startsWith('BARCODE '));
    expect(barcodeLine).toBeDefined();
    const y = Number(barcodeLine!.split(',')[1]);
    expect(y).toBeGreaterThan(300);
  });

  it('reserves height for the barcode zone only when there is a barcode', () => {
    const formatter = new TsplFormatter(40, 60);
    expect(formatter.graphicHeightMm(false)).toBe(60);
    expect(formatter.graphicHeightMm(true)).toBeLessThan(60);
  });

  it('never lets the barcode zone eat more than 60% of a short tag', () => {
    // 20mm tag: a fixed 13mm reservation would leave almost nothing to print on.
    expect(new TsplFormatter(40, 20).graphicHeightMm(true)).toBe(8);
  });

  it('still prints a tag with no barcode at all', () => {
    const formatter = new TsplFormatter(40, 60);
    const out = text(formatter.formatFabricTag(fabricTag({ quantity: 3 }), fakeGraphic(formatter.widthDots, 480)));
    expect(out).not.toContain('BARCODE ');
    expect(out).not.toContain('QRCODE ');
    expect(out).toContain('PRINT 1,3');
  });
});

describe('TsplFormatter narrow media', () => {
  // A 20mm fabric ribbon is 160 dots; minus 2mm margins that leaves 128 usable.
  const RIBBON_USABLE_DOTS = 128;

  it('falls back to QR when a 1D symbol cannot fit the ribbon width', () => {
    const formatter = new TsplFormatter(20, 40);
    const out = text(formatter.formatFabricTag(
      fabricTag({ barcode: '5901234123457' }),
      fakeGraphic(formatter.widthDots, 200),
    ));
    // EAN13 needs 113 modules. A 1-dot module technically fits in 128 dots but
    // is unscannable on fabric, and 2 dots would be 226 — off the ribbon.
    expect(out).toContain('QRCODE ');
    expect(out).not.toContain('BARCODE ');
  });

  it('keeps the QR symbol inside the usable width', () => {
    const formatter = new TsplFormatter(20, 40);
    const out = text(formatter.formatFabricTag(
      fabricTag({ barcode: 'ZIRA-1', useQrCode: true }),
      fakeGraphic(formatter.widthDots, 200),
    ));
    const cell = Number(out.split('\r\n').find((l) => l.startsWith('QRCODE '))!.split(',')[3]);
    // A version-2 QR is 25 modules across.
    expect(cell * 25).toBeLessThanOrEqual(RIBBON_USABLE_DOTS);
    expect(cell).toBeGreaterThanOrEqual(3);
  });

  it('still uses wide bars when the media has room for them', () => {
    const formatter = new TsplFormatter(100, 50);
    const line = text(formatter.formatLabel(label({ barcode: '5901234123457' })))
      .split('\r\n').find((l) => l.startsWith('BARCODE '))!;
    const [narrow, wide] = line.split(',').slice(6, 8).map(Number);
    expect(narrow).toBeGreaterThanOrEqual(2);
    expect(wide).toBe(narrow * 2);
    // The whole symbol must still fit inside the 100mm label.
    expect(narrow * 113).toBeLessThanOrEqual(formatter.widthDots);
  });

  it('shrinks the module rather than overflowing a mid-width label', () => {
    // 40mm = 320 dots, 288 usable: room for a 2-dot module but not the 3-dot cap.
    const formatter = new TsplFormatter(40, 40);
    const line = text(formatter.formatLabel(label({ barcode: '5901234123457' })))
      .split('\r\n').find((l) => l.startsWith('BARCODE '))!;
    const narrow = Number(line.split(',')[6]);
    expect(narrow).toBe(2);
    expect(narrow * 113).toBeLessThanOrEqual(formatter.widthDots - formatter.mmToDots(2) * 2);
  });

  it('refuses bars on a 30mm label too, where only a 1-dot module would fit', () => {
    const out = text(new TsplFormatter(30, 40).formatLabel(label({ barcode: '5901234123457' })));
    expect(out).toContain('QRCODE ');
    expect(out).not.toContain('BARCODE ');
  });
});

describe('TsplFormatter geometry', () => {
  it('converts millimetres to dots at the head resolution', () => {
    expect(new TsplFormatter(40, 60, 203).mmToDots(25.4)).toBe(203);
    expect(new TsplFormatter(40, 60, 300).mmToDots(25.4)).toBe(300);
    expect(new TsplFormatter(40, 60, 203).widthDots).toBe(320);
  });
});
