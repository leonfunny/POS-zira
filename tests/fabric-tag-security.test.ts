import { readFile } from 'node:fs/promises';
import { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  FABRIC_TAG_LIMITS,
  type FabricTagData,
} from '../src/shared/types';
import {
  FabricTagInputError,
  FabricTagPrintBusyError,
  FabricTagPrintGate,
  parseFabricTagData,
  parseFabricTagLogoDataUrl,
} from '../src/main/hardware/tsc/fabric-tag-input';
import { applyStoredTsplMediaTuning } from '../src/main/hardware/tsc/tspl-config-merge';
import {
  assertNoHorizontalEdgeContact,
  buildFabricTagHtml,
  renderFabricTagBitmap,
  resolveFabricTagFitHeight,
} from '../src/main/hardware/tsc/fabric-tag-renderer';

vi.mock('electron', () => ({ BrowserWindow: vi.fn() }));

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function pngDataUrl(width = 1, height = 1): string {
  const bytes = Buffer.from(ONE_PIXEL_PNG);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function validTag(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { brandName: 'Zira', quantity: 1, ...overrides };
}

describe('fabric tag main-process trust boundary', () => {
  it('normalizes bounded fields and returns a fresh whitelisted payload', () => {
    const input = validTag({
      brandName: '  Zira  ',
      size: ' M ',
      careSymbols: ['WASH_30', 'IRON_LOW', 'WASH_30'],
      barcode: ' 5901234123457 ',
      barcodeType: 'EAN13',
      priceGrosze: 12_345,
      currency: ' zł ',
      layout: 'care-first',
      unexpected: { deeply: 'nested' },
    });

    expect(parseFabricTagData(input)).toEqual({
      brandName: 'Zira',
      logoDataUrl: undefined,
      size: 'M',
      composition: undefined,
      careSymbols: ['WASH_30', 'IRON_LOW'],
      careText: undefined,
      barcode: '5901234123457',
      barcodeType: 'EAN13',
      useQrCode: undefined,
      priceGrosze: 12_345,
      currency: 'zł',
      layout: 'care-first',
      quantity: 1,
    } satisfies FabricTagData);
  });

  it.each([
    ['brandName', validTag({ brandName: 'x'.repeat(FABRIC_TAG_LIMITS.brandName + 1) })],
    ['size', validTag({ size: 'x'.repeat(FABRIC_TAG_LIMITS.size + 1) })],
    ['composition', validTag({ composition: 'x'.repeat(FABRIC_TAG_LIMITS.composition + 1) })],
    ['careText', validTag({ careText: 'x'.repeat(FABRIC_TAG_LIMITS.careText + 1) })],
    ['barcode', validTag({ barcode: 'x'.repeat(FABRIC_TAG_LIMITS.barcode + 1) })],
    ['currency', validTag({ currency: 'x'.repeat(FABRIC_TAG_LIMITS.currency + 1) })],
    ['brandName controls', validTag({ brandName: 'Zira\r\nPRINT 999' })],
    ['barcode controls', validTag({ barcode: '590\nCLS' })],
  ])('rejects overlong or command-bearing %s', (_field, input) => {
    expect(() => parseFabricTagData(input)).toThrow(FabricTagInputError);
  });

  it.each([
    ['missing payload', null],
    ['array payload', []],
    ['no identity', { brandName: ' ', quantity: 1 }],
    ['non-array symbols', validTag({ careSymbols: 'WASH_30' })],
    ['unknown symbol', validTag({ careSymbols: ['WASH_9000'] })],
    ['sparse symbols', validTag({ careSymbols: new Array(1) })],
    ['too many symbols', validTag({ careSymbols: Array(FABRIC_TAG_LIMITS.careSymbols + 1).fill('WASH_30') })],
    ['contradictory wash symbols', validTag({ careSymbols: ['WASH_30', 'WASH_NO'] })],
    ['contradictory bleach symbols', validTag({ careSymbols: ['BLEACH_OK', 'BLEACH_NO'] })],
    ['contradictory tumble symbols', validTag({ careSymbols: ['TUMBLE_LOW', 'TUMBLE_NO'] })],
    ['contradictory iron symbols', validTag({ careSymbols: ['IRON_LOW', 'IRON_HIGH'] })],
    ['contradictory dry-clean symbols', validTag({ careSymbols: ['DRYCLEAN_P', 'DRYCLEAN_NO'] })],
    ['unknown barcode type', validTag({ barcode: 'abc', barcodeType: 'PDF417' })],
    ['EAN13 wrong shape', validTag({ barcode: 'abc', barcodeType: 'EAN13' })],
    ['barcode type without data', validTag({ barcodeType: 'CODE128' })],
    ['QR flag without data', validTag({ useQrCode: true })],
    ['unknown layout', validTag({ layout: 'sideways' })],
    ['string quantity', validTag({ quantity: '2' })],
    ['zero quantity', validTag({ quantity: 0 })],
    ['huge quantity', validTag({ quantity: FABRIC_TAG_LIMITS.quantity + 1 })],
    ['NaN quantity', validTag({ quantity: Number.NaN })],
    ['infinite quantity', validTag({ quantity: Number.POSITIVE_INFINITY })],
    ['fractional quantity', validTag({ quantity: 1.5 })],
    ['NaN price', validTag({ priceGrosze: Number.NaN })],
    ['infinite price', validTag({ priceGrosze: Number.POSITIVE_INFINITY })],
    ['negative price', validTag({ priceGrosze: -1 })],
  ])('rejects invalid %s as FINAL', (_label, input) => {
    try {
      parseFabricTagData(input);
      throw new Error('expected parser to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(FabricTagInputError);
      expect((error as FabricTagInputError).failureClass).toBe('FINAL');
    }
  });

  it('accepts a bounded raster logo and rejects active, mismatched, huge, and oversized images', () => {
    const atLimit = Buffer.alloc(FABRIC_TAG_LIMITS.logoBytes);
    ONE_PIXEL_PNG.copy(atLimit);
    const atLimitUrl = `data:image/png;base64,${atLimit.toString('base64')}`;
    expect(parseFabricTagLogoDataUrl(atLimitUrl)).toMatchObject({
      decodedBytes: FABRIC_TAG_LIMITS.logoBytes,
      width: 1,
      height: 1,
    });

    expect(() => parseFabricTagLogoDataUrl(
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    )).toThrow(/logoDataUrl/);
    expect(() => parseFabricTagLogoDataUrl(
      `data:image/jpeg;base64,${ONE_PIXEL_PNG.toString('base64')}`,
    )).toThrow(/logoDataUrl/);
    expect(() => parseFabricTagLogoDataUrl(
      `data:image/png;base64,${Buffer.alloc(FABRIC_TAG_LIMITS.logoBytes + 1).toString('base64')}`,
    )).toThrow(/logoDataUrl/);
    expect(() => parseFabricTagLogoDataUrl(
      pngDataUrl(FABRIC_TAG_LIMITS.logoMaxDimension + 1, 1),
    )).toThrow(/logoDataUrl/);
    expect(() => parseFabricTagLogoDataUrl(
      pngDataUrl(4096, 4096),
    )).toThrow(/logoDataUrl/);
  });

  it('rejects a PNG header with no image-data chunk', () => {
    const headerOnlyPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAAElFTkSuQmCC';
    expect(() => parseFabricTagLogoDataUrl(headerOnlyPng)).toThrow(/image data is missing/i);
  });

  it('rejects two natural-drying methods on one tag', () => {
    // Settled with the fabric workshop on 02/09/2026 and matching ISO 3758: a
    // garment is hung or it is laid flat. Tumble drying stays a separate
    // family, so "do not tumble dry" alongside "dry flat" is still valid.
    expect(() => parseFabricTagData(validTag({ careSymbols: ['DRY_LINE', 'DRY_FLAT'] })))
      .toThrow(/careSymbols/);
    expect(parseFabricTagData(validTag({ careSymbols: ['TUMBLE_NO', 'DRY_FLAT'] })).careSymbols)
      .toEqual(['TUMBLE_NO', 'DRY_FLAT']);
  });

  it('stops invalid input before invoking the renderer/spool operation', async () => {
    const operation = vi.fn(async () => undefined);
    const gate = new FabricTagPrintGate();

    await expect(gate.run(validTag({ quantity: Number.POSITIVE_INFINITY }), operation))
      .rejects.toThrow(/quantity/);
    expect(operation).not.toHaveBeenCalled();
  });

  it('allows only one renderer/spool operation and classifies overlap as safe before print', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const operation = vi.fn(async () => blocked);
    const gate = new FabricTagPrintGate();

    const first = gate.run(validTag(), operation);
    expect(operation).toHaveBeenCalledTimes(1);

    await expect(gate.run(validTag(), operation)).rejects.toMatchObject({
      name: 'FabricTagPrintBusyError',
      failureClass: 'SAFE_BEFORE_PRINT',
    } satisfies Partial<FabricTagPrintBusyError>);
    expect(operation).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toBeUndefined();
    await expect(gate.run(validTag(), operation)).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('shares the same busy state between generated tags and pre-rendered artwork', async () => {
    let releaseArtwork!: () => void;
    const artworkBlocked = new Promise<void>((resolve) => { releaseArtwork = resolve; });
    const gate = new FabricTagPrintGate();
    const generatedOperation = vi.fn(async () => undefined);

    const artworkRun = gate.runExclusive(async () => artworkBlocked);
    await expect(gate.run(validTag(), generatedOperation)).rejects.toMatchObject({
      name: 'FabricTagPrintBusyError',
      failureClass: 'SAFE_BEFORE_PRINT',
    });
    expect(generatedOperation).not.toHaveBeenCalled();
    releaseArtwork();
    await artworkRun;

    let releaseGenerated!: () => void;
    const generatedBlocked = new Promise<void>((resolve) => { releaseGenerated = resolve; });
    const generatedRun = gate.run(validTag(), async () => generatedBlocked);
    await expect(gate.runExclusive(async () => undefined)).rejects.toMatchObject({
      name: 'FabricTagPrintBusyError',
      failureClass: 'SAFE_BEFORE_PRINT',
    });
    releaseGenerated();
    await generatedRun;
  });
});

describe('fabric tag defence in depth', () => {
  it('wraps every operator-entered text block inside the printable width', () => {
    const html = buildFabricTagHtml({
      brandName: 'UNBROKEN-BRAND-NAME-THAT-IS-LONG',
      composition: 'UNBROKENCOMPOSITIONTHATISLONG',
      careText: 'UNBROKENCARETEXTTHATISLONG',
      quantity: 1,
    }, 160, 480);

    expect(html).toContain('.brand, .size, .composition, .care-text, .price');
    expect(html).toContain('overflow-wrap: anywhere');
    expect(html).toContain('max-width: 100%');
  });

  it('fails closed before RAW when rasterised ink still reaches a horizontal edge', () => {
    const clipped = Buffer.alloc(4, 0xff);
    clipped[0] &= 0x7f; // first dot of the first row is black

    expect(() => assertNoHorizontalEdgeContact({
      widthDots: 16,
      heightDots: 2,
      widthBytes: 2,
      data: clipped,
    })).toThrow(/left edge.*being cut off/i);

    const inset = Buffer.alloc(4, 0xff);
    inset[0] &= 0xbf; // second dot is black, leaving the boundary white
    expect(() => assertNoHorizontalEdgeContact({
      widthDots: 16,
      heightDots: 2,
      widthBytes: 2,
      data: inset,
    })).not.toThrow();
  });

  it('applies the horizontal edge guard to the captured bitmap before returning it', async () => {
    const bgra = Buffer.alloc(16 * 2 * 4, 0xff);
    // First pixel: opaque black BGRA. Every other pixel remains opaque white.
    bgra[0] = 0;
    bgra[1] = 0;
    bgra[2] = 0;
    bgra[3] = 0xff;
    const destroy = vi.fn();
    vi.mocked(BrowserWindow).mockImplementationOnce(function MockBrowserWindow() {
      const image = {
        getSize: () => ({ width: 16, height: 2 }),
        resize: vi.fn(),
        toBitmap: () => bgra,
      };
      return {
        loadURL: vi.fn(async () => undefined),
        webContents: { capturePage: vi.fn(async () => image) },
        destroy,
      } as any;
    });

    await expect(renderFabricTagBitmap({ brandName: 'Zira', quantity: 1 }, 16, 2))
      .rejects.toThrow(/left edge.*being cut off/i);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('fails before capture when Chromium cannot decode a header-valid logo', async () => {
    const capturePage = vi.fn();
    const destroy = vi.fn();
    vi.mocked(BrowserWindow).mockImplementationOnce(function MockBrowserWindow() {
      return {
        loadURL: vi.fn(async () => undefined),
        webContents: {
          executeJavaScript: vi.fn(async () => ({
            decodedOk: false,
            complete: true,
            naturalWidth: 0,
            naturalHeight: 0,
          })),
          capturePage,
        },
        isDestroyed: vi.fn(() => false),
        destroy,
      } as any;
    });

    await expect(renderFabricTagBitmap({
      brandName: '',
      logoDataUrl: `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`,
      quantity: 1,
    }, 160, 120)).rejects.toMatchObject({
      name: 'FabricTagInputError',
      failureClass: 'FINAL',
    });
    expect(capturePage).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('fails before capture when image.decode rejects despite matching dimensions', async () => {
    const capturePage = vi.fn();
    const destroy = vi.fn();
    vi.mocked(BrowserWindow).mockImplementationOnce(function MockBrowserWindow() {
      return {
        loadURL: vi.fn(async () => undefined),
        webContents: {
          executeJavaScript: vi.fn(async () => ({
            decodedOk: false,
            complete: true,
            naturalWidth: 1,
            naturalHeight: 1,
          })),
          capturePage,
        },
        isDestroyed: vi.fn(() => false),
        destroy,
      } as any;
    });

    await expect(renderFabricTagBitmap({
      brandName: '',
      logoDataUrl: `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`,
      quantity: 1,
    }, 160, 120)).rejects.toMatchObject({
      name: 'FabricTagInputError',
      failureClass: 'FINAL',
    });
    expect(capturePage).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('fails closed when natural content exceeds the configured media height', () => {
    expect(resolveFabricTagFitHeight(120, 120)).toBe(120);
    expect(resolveFabricTagFitHeight(111, 120)).toBe(112);
    expect(() => resolveFabricTagFitHeight(121, 120)).toThrow(
      /needs 121 dots.*allows 120/i,
    );
  });

  it('restores all TSPL tuning, including the measured origin inset, at runtime', () => {
    const target = { enabled: true, protocol: 'TSPL', windowsPrinter: 'TSC' } as const;
    const mutableTarget = { ...target };
    applyStoredTsplMediaTuning(mutableTarget, {
      enabled: true,
      protocol: 'TSPL',
      windowsPrinter: 'TSC',
      labelGapMm: 2,
      printSpeed: 4,
      printDensity: 12,
      labelOriginInsetMm: 1.1,
      mediaSensor: 'none',
    });

    expect(mutableTarget).toMatchObject({
      labelGapMm: 2,
      printSpeed: 4,
      printDensity: 12,
      labelOriginInsetMm: 1.1,
      mediaSensor: 'none',
    });
  });

  it('rejects SVG in both UI and the final renderer and bounds BrowserWindow before construction', async () => {
    const [composer, renderer] = await Promise.all([
      readFile('src/renderer/components/label/FabricTagComposer.tsx', 'utf8'),
      readFile('src/main/hardware/tsc/fabric-tag-renderer.ts', 'utf8'),
    ]);

    expect(composer).not.toContain('image/svg+xml');
    expect(composer).toContain('readRasterImageDimensions');
    expect(renderer).not.toContain('svg\\+xml');
    expect(renderer).toContain('parseFabricTagLogoDataUrl');
    expect(renderer).toContain('sandbox: true');
    expect(renderer.indexOf('validateFabricTagRasterDimensions(widthDots, heightDots)'))
      .toBeLessThan(renderer.indexOf('const win = new BrowserWindow'));
  });
});
