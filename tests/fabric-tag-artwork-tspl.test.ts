import { describe, expect, it } from 'vitest';
import { TsplFormatter } from '../src/main/hardware/tsc/tspl-formatter';
import type { MonoBitmap } from '../src/main/hardware/tsc/fabric-tag-renderer';

function artworkBitmap(heightDots = 160): MonoBitmap {
  const widthDots = 142;
  const widthBytes = 18;
  const data = Buffer.alloc(widthBytes * heightDots, 0xff);
  // Include bytes that would be destructive if a binary payload were ever
  // concatenated or re-encoded as text instead of kept as a Buffer.
  Buffer.from([0x00, 0x0d, 0x0a, 0x50, 0x52, 0x49, 0x4e, 0x54, 0xff, 0x80])
    .copy(data, 7);
  return { widthDots, widthBytes, heightDots, data };
}

function artworkFormatter(): TsplFormatter {
  return new TsplFormatter(20, 60, 203, {
    sensor: 'none',
    originInsetMm: 1.1,
    speed: 2,
    density: 12,
  });
}

describe('external fabric artwork TSPL boundary', () => {
  it('emits one byte-exact BITMAP followed by PRINT 1,n', () => {
    const formatter = artworkFormatter();
    const graphic = artworkBitmap(160);
    const output = formatter.formatFabricArtwork(graphic, 17, 20);
    const header = Buffer.from('BITMAP 0,0,18,160,0,', 'latin1');
    const start = output.indexOf(header);

    expect(start).toBeGreaterThanOrEqual(0);
    const payloadStart = start + header.byteLength;
    expect(output.subarray(payloadStart, payloadStart + graphic.data.byteLength))
      .toEqual(graphic.data);
    expect(output.subarray(payloadStart + graphic.data.byteLength))
      .toEqual(Buffer.from('\r\nPRINT 1,17\r\n', 'latin1'));
    expect(output.subarray(0, start).toString('latin1')).toContain('SIZE 20 mm,20 mm\r\n');
  });

  it('preserves the exact source height instead of using the configured 60mm ceiling', () => {
    const formatter = artworkFormatter();
    const output = formatter.formatFabricArtwork(artworkBitmap(240), 1, 30);
    const textPrefix = output.subarray(0, output.indexOf(Buffer.from('BITMAP ', 'latin1')))
      .toString('latin1');

    expect(textPrefix).toContain('SIZE 20 mm,30 mm\r\n');
    expect(textPrefix).not.toContain('SIZE 20 mm,60 mm\r\n');
    expect(output.indexOf(Buffer.from('BITMAP 0,0,18,240,0,', 'latin1')))
      .toBeGreaterThanOrEqual(0);
  });

  it('rejects a full 160-dot canvas instead of auto-scaling or printing its margins', () => {
    const fullCanvas: MonoBitmap = {
      widthDots: 160,
      heightDots: 160,
      widthBytes: 20,
      data: Buffer.alloc(20 * 160, 0xff),
    };

    expect(() => artworkFormatter().formatFabricArtwork(fullCanvas, 1, 20))
      .toThrow(/bitmap dimensions or byte length are invalid/i);
  });

  it('rejects media geometry that cannot address the measured 142-dot centre', () => {
    expect(() => new TsplFormatter(20, 60, 203, {
      sensor: 'none',
      originInsetMm: 0,
    }).formatFabricArtwork(artworkBitmap(), 1, 20))
      .toThrow(/requires 20mm media at 203dpi with a 1\.1mm origin inset/i);

    expect(() => new TsplFormatter(25.1, 60, 203, {
      sensor: 'none',
      originInsetMm: 1.1,
    }).formatFabricArtwork(artworkBitmap(), 1, 20))
      .toThrow(/requires 20mm media/i);

    // These near misses round to the same 160/142-dot geometry. Exact source
    // metadata, not only rounded dots, must remain part of the production contract.
    expect(() => new TsplFormatter(20.01, 60, 203, {
      sensor: 'none',
      originInsetMm: 1.1,
    }).formatFabricArtwork(artworkBitmap(), 1, 20))
      .toThrow(/requires 20mm media/i);
    expect(() => new TsplFormatter(20, 60, 203.1, {
      sensor: 'none',
      originInsetMm: 1.1,
    }).formatFabricArtwork(artworkBitmap(), 1, 20))
      .toThrow(/at 203dpi/i);
    expect(() => new TsplFormatter(20, 60, 203, {
      sensor: 'none',
      originInsetMm: 1.12,
    }).formatFabricArtwork(artworkBitmap(), 1, 20))
      .toThrow(/1\.1mm origin inset/i);
    expect(() => new TsplFormatter(20, 60, 300, {
      sensor: 'none',
      originInsetMm: 1.1,
    }).formatFabricArtwork(artworkBitmap(), 1, 20))
      .toThrow(/at 203dpi/i);
  });

  it.each([0, 1_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unsafe copy count %s instead of clamping it',
    (quantity) => {
      expect(() => artworkFormatter().formatFabricArtwork(artworkBitmap(), quantity, 20))
        .toThrow(/quantity.*integer.*1.*999/i);
    },
  );

  it('rejects a physical length that would resample or clip the source rows', () => {
    expect(() => artworkFormatter().formatFabricArtwork(artworkBitmap(160), 1, 20.125))
      .toThrow(/does not preserve its 160px height/i);
  });

  it('rejects malformed packed bytes before building a spool payload', () => {
    const short = artworkBitmap();
    short.data = short.data.subarray(1);
    expect(() => artworkFormatter().formatFabricArtwork(short, 1, 20))
      .toThrow(/bitmap dimensions or byte length are invalid/i);
  });
});
