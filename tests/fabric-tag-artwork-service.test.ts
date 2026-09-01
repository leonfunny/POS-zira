import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  getRow: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  attachProduction: vi.fn(),
  retire: vi.fn(),
  toArtwork: vi.fn(),
  packMonochrome: vi.fn(),
  assertNoEdge: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/unused-user-data') },
  nativeImage: { createFromBuffer: vi.fn() },
}));

vi.mock('../src/main/database/database', () => ({
  database: {
    saveCoalesced: vi.fn(),
    getTenantGeneration: vi.fn(() => 0),
  },
}));

vi.mock('../src/main/database/repos/fabric-tag-artwork-repo', () => ({
  fabricTagArtworkRepo: {
    insert: mocks.insert,
    getRow: mocks.getRow,
    get: mocks.get,
    list: mocks.list,
    attachProduction: mocks.attachProduction,
    retire: mocks.retire,
  },
  toFabricTagArtwork: mocks.toArtwork,
}));

vi.mock('../src/main/hardware/tsc/fabric-tag-renderer', () => ({
  packFabricTagMonochrome: mocks.packMonochrome,
  assertNoHorizontalEdgeContact: mocks.assertNoEdge,
}));

vi.mock('../src/main/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.loggerError,
  },
}));

import {
  cropFabricArtworkCanvas,
  FabricTagArtworkInputError,
  FabricTagArtworkService,
  validateBtwSource,
  validateFabricTagArtworkMetadata,
  validateFabricTagArtworkPrintRequest,
  validateProductionPng,
  type DecodedFabricArtworkPng,
} from '../src/main/pos/fabric-tag-artwork-service';
import {
  FABRIC_TAG_ARTWORK_LIMITS,
  FABRIC_TAG_ARTWORK_MEDIA,
} from '../src/shared/types';
import type { FabricTagArtworkRow } from '../src/main/database/repos/fabric-tag-artwork-repo';

function pngChunk(type: string, payload = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(12 + payload.byteLength);
  chunk.writeUInt32BE(payload.byteLength, 0);
  chunk.write(type, 4, 4, 'ascii');
  payload.copy(chunk, 8);
  // CRC is deliberately zero: header parsing is only the allocation guard;
  // the injected/native decoder remains responsible for a full decode.
  return chunk;
}

function pngEnvelope(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT'),
    pngChunk('IEND'),
  ]);
}

function whiteDecode(widthPx: number, heightPx: number): DecodedFabricArtworkPng {
  return {
    widthPx,
    heightPx,
    bgra: Buffer.alloc(widthPx * heightPx * 4, 0xff),
  };
}

function productionRow(overrides: Partial<FabricTagArtworkRow> = {}): FabricTagArtworkRow {
  return {
    id: 'asset-1',
    salon_id: 'salon-a',
    customer_name: 'Customer A',
    order_code: 'ORDER-7',
    variant: 'S/M',
    revision: 'r1',
    original_filename: 'source.btw',
    source_type: 'BTW',
    status: 'READY',
    source_sha256: 'a'.repeat(64),
    source_path: '/unused/source.btw',
    production_filename: 'production.png',
    production_sha256: 'b'.repeat(64),
    production_path: '/unused/production.png',
    width_px: 160,
    height_px: 160,
    physical_width_mm: 20,
    physical_length_mm: 20,
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-01T10:00:00.000Z',
    retired_at: null,
    ...overrides,
  };
}

describe('fabric artwork input boundary', () => {
  it('normalizes metadata into a fresh allowlisted object and rejects hidden storage fields', () => {
    expect(validateFabricTagArtworkMetadata({
      customerName: '  Customer A ',
      orderCode: ' ORDER-7 ',
      variant: ' 44/46 ',
      revision: ' r1 ',
    })).toEqual({
      customerName: 'Customer A',
      orderCode: 'ORDER-7',
      variant: '44/46',
      revision: 'r1',
    });
    expect(() => validateFabricTagArtworkMetadata({
      customerName: 'Customer A',
      variant: '44/46',
      revision: 'r1',
      sourcePath: 'C:\\must-not-cross-ipc\\label.btw',
    })).toThrow(/unexpected field sourcePath/i);
  });

  it.each([
    ['missing object', null],
    ['missing customer', { variant: 'M', revision: 'r1' }],
    ['blank variant', { customerName: 'A', variant: ' ', revision: 'r1' }],
    ['control characters', { customerName: 'A\r\nPRINT 999', variant: 'M', revision: 'r1' }],
    ['overlong revision', {
      customerName: 'A',
      variant: 'M',
      revision: 'x'.repeat(FABRIC_TAG_ARTWORK_LIMITS.revision + 1),
    }],
  ])('rejects invalid metadata: %s', (_label, input) => {
    expect(() => validateFabricTagArtworkMetadata(input))
      .toThrow(FabricTagArtworkInputError);
  });

  it('accepts only assetId plus an integer quantity from 1 through 999', () => {
    const parsed = validateFabricTagArtworkPrintRequest({
      assetId: ' asset-1 ',
      quantity: 999,
    });

    expect(parsed).toEqual({ assetId: 'asset-1', quantity: 999 });
    expect(Object.keys(parsed)).toEqual(['assetId', 'quantity']);
    expect(() => validateFabricTagArtworkPrintRequest({
      assetId: 'asset-1',
      quantity: 1,
      salonId: 'other-salon',
    })).toThrow(/unexpected field salonId/i);
    expect(() => validateFabricTagArtworkPrintRequest({
      assetId: 'asset-1',
      quantity: 1,
      productionPath: 'C:\\untrusted\\payload.png',
    })).toThrow(/unexpected field productionPath/i);
  });

  it.each([0, 1_000, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unsafe print quantity %s',
    (quantity) => {
      expect(() => validateFabricTagArtworkPrintRequest({ assetId: 'asset-1', quantity }))
        .toThrow(/quantity.*integer.*1.*999/i);
    },
  );

  it('recognizes a bounded BTW source but rejects extension spoofing and bad magic', () => {
    const bytes = Buffer.from('\r\nBar Tender Format File\r\nfixture');
    expect(() => validateBtwSource(bytes, 'CUSTOMER.BTW')).not.toThrow();
    expect(() => validateBtwSource(bytes, 'CUSTOMER.png')).toThrow(/\.btw extension/i);
    expect(() => validateBtwSource(Buffer.from('x'.repeat(26)), 'CUSTOMER.btw'))
      .toThrow(/header/i);
  });
});

describe('production PNG geometry and decoding', () => {
  beforeEach(() => {
    mocks.assertNoEdge.mockReset();
    mocks.packMonochrome.mockReset().mockImplementation(
      (_bgra: Buffer, widthDots: number, heightDots: number) => {
        const widthBytes = Math.ceil(widthDots / 8);
        const data = Buffer.alloc(widthBytes * heightDots, 0xff);
        data[1] = 0xfe; // one interior ink dot; never the guarded edge column
        return { widthDots, heightDots, widthBytes, data };
      },
    );
  });

  it.each([80, 480])('accepts the exact height boundary %d and preserves it', (height) => {
    const bytes = pngEnvelope(160, height);
    const decoder = vi.fn(() => whiteDecode(160, height));

    const result = validateProductionPng(bytes, decoder);

    expect(decoder).toHaveBeenCalledOnce();
    expect(decoder).toHaveBeenCalledWith(bytes);
    expect(result).toMatchObject({
      widthPx: 160,
      heightPx: height,
      physicalWidthMm: 20,
      physicalLengthMm: height / 8,
      printableBitmap: {
        widthDots: 142,
        heightDots: height,
        widthBytes: 18,
      },
    });
    expect(mocks.packMonochrome).toHaveBeenCalledWith(
      expect.objectContaining({ byteLength: 142 * height * 4 }),
      142,
      height,
    );
    expect(mocks.assertNoEdge).toHaveBeenCalledWith(result.printableBitmap);
  });

  it.each([79, 481])('rejects out-of-range height %d before decode', (height) => {
    const decoder = vi.fn(() => whiteDecode(160, height));
    expect(() => validateProductionPng(pngEnvelope(160, height), decoder))
      .toThrow(/height.*80-480/i);
    expect(decoder).not.toHaveBeenCalled();
    expect(mocks.packMonochrome).not.toHaveBeenCalled();
  });

  it('rejects a 201px/25mm artwork instead of silently scaling it to 160px', () => {
    const decoder = vi.fn(() => whiteDecode(201, 160));
    expect(() => validateProductionPng(pngEnvelope(201, 160), decoder))
      .toThrow(/width.*exactly 160px.*got 201px/i);
    expect(decoder).not.toHaveBeenCalled();
    expect(mocks.packMonochrome).not.toHaveBeenCalled();
  });

  it('requires PNG magic and a successful full decode', () => {
    const decoder = vi.fn(() => whiteDecode(160, 160));
    expect(() => validateProductionPng(Buffer.alloc(64), decoder)).toThrow(/PNG signature/i);
    expect(decoder).not.toHaveBeenCalled();

    const decodeFailure = vi.fn(() => {
      throw new Error('CRC or compressed stream is corrupt');
    });
    expect(() => validateProductionPng(pngEnvelope(160, 160), decodeFailure))
      .toThrow(/could not be decoded.*corrupt/i);
    expect(decodeFailure).toHaveBeenCalledOnce();
  });

  it('rejects a decoder result that disagrees with the bounded header', () => {
    const decoder = vi.fn(() => whiteDecode(159, 160));
    expect(() => validateProductionPng(pngEnvelope(160, 160), decoder))
      .toThrow(/decoded dimensions 159x160.*header 160x160/i);
    expect(mocks.packMonochrome).not.toHaveBeenCalled();
  });

  it('rejects a fully decoded but blank production canvas', () => {
    mocks.packMonochrome.mockReturnValueOnce({
      widthDots: 142,
      heightDots: 160,
      widthBytes: 18,
      data: Buffer.alloc(18 * 160, 0xff),
    });
    expect(() => validateProductionPng(
      pngEnvelope(160, 160),
      () => whiteDecode(160, 160),
    )).toThrow(/blank.*no printable ink/i);
  });

  it('crops the central 142 dots without changing row order or height', () => {
    const width = FABRIC_TAG_ARTWORK_MEDIA.fullCanvasWidthPx;
    const height = 2;
    const bgra = Buffer.alloc(width * height * 4, 0xff);
    const setPixel = (x: number, y: number, value: [number, number, number, number]) => {
      bgra.set(value, (y * width + x) * 4);
    };
    setPixel(9, 0, [1, 2, 3, 255]);
    setPixel(150, 0, [4, 5, 6, 255]);
    setPixel(9, 1, [7, 8, 9, 255]);
    setPixel(150, 1, [10, 11, 12, 255]);

    const cropped = cropFabricArtworkCanvas(bgra, width, height);
    const rowBytes = FABRIC_TAG_ARTWORK_MEDIA.printableWidthPx * 4;

    expect(cropped).toHaveLength(rowBytes * height);
    expect([...cropped.subarray(0, 4)]).toEqual([1, 2, 3, 255]);
    expect([...cropped.subarray(rowBytes - 4, rowBytes)]).toEqual([4, 5, 6, 255]);
    expect([...cropped.subarray(rowBytes, rowBytes + 4)]).toEqual([7, 8, 9, 255]);
    expect([...cropped.subarray(rowBytes * 2 - 4)]).toEqual([10, 11, 12, 255]);
  });

  it.each([
    ['left outer edge', 'left', 0],
    ['left inner edge', 'left', 8],
    ['right inner edge', 'right', 151],
    ['right outer edge', 'right', 159],
  ])('rejects ink at the %s of the nine-dot safety margin', (_label, side, x) => {
    const bgra = Buffer.alloc(160 * 80 * 4, 0xff);
    bgra.set([0, 0, 0, 255], x * 4);
    expect(() => cropFabricArtworkCanvas(bgra, 160, 80))
      .toThrow(new RegExp(`${side} safety margin`, 'i'));
  });
});

describe('fabric artwork storage-to-print boundary', () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.toArtwork.mockImplementation((value: FabricTagArtworkRow) => ({
      id: value.id,
      salonId: value.salon_id,
      status: value.status,
    }));
    mocks.assertNoEdge.mockImplementation(() => undefined);
    mocks.packMonochrome.mockImplementation(
      (_bgra: Buffer, widthDots: number, heightDots: number) => {
        const widthBytes = Math.ceil(widthDots / 8);
        const data = Buffer.alloc(widthBytes * heightDots, 0xff);
        data[1] = 0xfe;
        return { widthDots, heightDots, widthBytes, data };
      },
    );
  });

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'zira-fabric-artwork-'));
    tempRoots.push(root);
    return root;
  }

  function productionPath(root: string, salonId: string, digest: string): string {
    const tenant = createHash('sha256')
      .update(salonId.trim().toLowerCase(), 'utf8')
      .digest('hex');
    return join(root, 'fabric-tag-artworks', tenant, 'production', `${digest}.png`);
  }

  it('archives a BTW as NEEDS_CONVERSION with no printable payload', async () => {
    const root = tempRoot();
    const source = join(root, 'customer-label.btw');
    writeFileSync(source, Buffer.from('\r\nBar Tender Format File\r\nfixture'));
    const persist = vi.fn(async () => undefined);
    mocks.insert.mockImplementation((input) => ({ id: input.id, status: input.status }));
    const decodePng = vi.fn();
    const service = new FabricTagArtworkService({
      userDataPath: () => root,
      id: () => 'asset-1',
      now: () => '2026-09-01T10:00:00.000Z',
      decodePng,
      persist,
    });

    await service.importSource('salon-a', {
      customerName: 'Customer A',
      variant: 'S/M',
      revision: 'r1',
    }, source);

    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'asset-1',
      salonId: 'salon-a',
      sourceType: 'BTW',
      status: 'NEEDS_CONVERSION',
      productionFilename: null,
      productionSha256: null,
      productionPath: null,
      widthPx: null,
      heightPx: null,
    }));
    expect(decodePng).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('reads at most maximum plus one byte from one handle when a file grows after stat', async () => {
    const close = vi.fn(async () => undefined);
    const readSizes: number[] = [];
    const handle = {
      stat: vi.fn(async () => ({ size: 4, isFile: () => true })),
      read: vi.fn(async (buffer: Buffer) => {
        readSizes.push(buffer.byteLength);
        buffer.fill(0x41, 0, 5);
        return { bytesRead: 5 };
      }),
      close,
    };
    const service = new FabricTagArtworkService({
      openFile: vi.fn(async () => handle),
    });

    await expect((service as any).readBoundedFile('C:\\share\\growing.btw', 4))
      .rejects.toThrow(/changed size while being imported/i);
    expect(readSizes).toEqual([5]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps persistence details in the main log and returns a path-free error', async () => {
    const root = tempRoot();
    const source = join(root, 'customer-label.btw');
    writeFileSync(source, Buffer.from('\r\nBar Tender Format File\r\nfixture'));
    mocks.insert.mockReturnValue({ id: 'asset-1', status: 'NEEDS_CONVERSION' });
    const raw = new Error('SQLITE_IOERR at C:\\Users\\Operator\\AppData\\Zira AI\\pos.db');
    const service = new FabricTagArtworkService({
      userDataPath: () => root,
      id: () => 'asset-1',
      persist: vi.fn(async () => { throw raw; }),
    });

    let exposed: unknown;
    try {
      await service.importSource('salon-a', {
        customerName: 'Customer A',
        variant: 'M',
        revision: 'r1',
      }, source);
    } catch (error) {
      exposed = error;
    }

    expect(exposed).toBeInstanceOf(Error);
    expect((exposed as Error).message).toBe('Fabric artwork metadata could not be saved');
    expect((exposed as Error).message).not.toMatch(/Users|AppData|pos\.db/i);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringMatching(/failed to persist artwork metadata/i),
      raw,
    );
  });

  it.each([
    ['a direct PNG row', { source_type: 'PNG', status: 'READY' }],
    ['an already converted BTW row', { source_type: 'BTW', status: 'READY' }],
    ['a retired BTW row', { source_type: 'BTW', status: 'RETIRED' }],
  ] as const)('never replaces production bytes on %s', async (_case, override) => {
    const root = tempRoot();
    const selected = join(root, 'replacement.png');
    writeFileSync(selected, pngEnvelope(160, 160));
    mocks.getRow.mockReturnValue(productionRow(override));
    const decoder = vi.fn(() => whiteDecode(160, 160));
    const service = new FabricTagArtworkService({ userDataPath: () => root, decodePng: decoder });

    await expect(service.attachProduction('salon-a', 'asset-1', selected))
      .rejects.toThrow(/only be attached once.*import a new revision/i);
    expect(decoder).not.toHaveBeenCalled();
    expect(mocks.attachProduction).not.toHaveBeenCalled();
  });

  it('rechecks the immutable BTW revision after async PNG validation and storage', async () => {
    const root = tempRoot();
    const selected = join(root, 'production.png');
    writeFileSync(selected, pngEnvelope(160, 160));
    const awaiting = productionRow({
      status: 'NEEDS_CONVERSION',
      production_filename: null,
      production_sha256: null,
      production_path: null,
      width_px: null,
      height_px: null,
      physical_width_mm: null,
      physical_length_mm: null,
    });
    mocks.getRow
      .mockReturnValueOnce(awaiting)
      .mockReturnValueOnce({
        ...awaiting,
        status: 'READY',
        production_filename: 'other.png',
        production_sha256: 'f'.repeat(64),
        production_path: '/managed/other.png',
        width_px: 160,
        height_px: 160,
        physical_width_mm: 20,
        physical_length_mm: 20,
      });
    const service = new FabricTagArtworkService({
      userDataPath: () => root,
      decodePng: () => whiteDecode(160, 160),
    });

    await expect(service.attachProduction('salon-a', 'asset-1', selected))
      .rejects.toThrow(/only be attached once.*new revision/i);
    expect(mocks.attachProduction).not.toHaveBeenCalled();
  });

  it('refuses to print a BTW asset until a production PNG is attached', async () => {
    mocks.getRow.mockReturnValue(productionRow({
      status: 'NEEDS_CONVERSION',
      production_filename: null,
      production_sha256: null,
      production_path: null,
      width_px: null,
      height_px: null,
      physical_width_mm: null,
      physical_length_mm: null,
    }));
    const service = new FabricTagArtworkService({ userDataPath: tempRoot });

    await expect(service.loadProductionForPrint(
      'salon-a',
      { assetId: 'asset-1', quantity: 1 },
    )).rejects.toThrow(/does not have a printable production PNG/i);
    expect(mocks.getRow).toHaveBeenCalledWith('salon-a', 'asset-1');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('revalidates salon path, SHA-256, dimensions, and crop before returning print bytes', async () => {
    const root = tempRoot();
    const bytes = pngEnvelope(160, 160);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const storedPath = productionPath(root, 'salon-a', digest);
    mkdirSync(join(storedPath, '..'), { recursive: true });
    writeFileSync(storedPath, bytes);
    mocks.getRow.mockReturnValue(productionRow({
      production_sha256: digest,
      production_path: storedPath,
    }));
    mocks.get.mockReturnValue({ id: 'asset-1', salonId: 'salon-a', status: 'READY' });
    const decodePng = vi.fn(() => whiteDecode(160, 160));
    const service = new FabricTagArtworkService({
      userDataPath: () => root,
      decodePng,
    });

    const loaded = await service.loadProductionForPrint(
      'salon-a',
      { assetId: 'asset-1', quantity: 23 },
    );

    expect(mocks.getRow).toHaveBeenCalledWith('salon-a', 'asset-1');
    expect(mocks.getRow).toHaveBeenCalledTimes(2);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(decodePng).toHaveBeenCalledWith(bytes);
    expect(loaded).toMatchObject({
      quantity: 23,
      physicalLengthMm: 20,
      bitmap: { widthDots: 142, heightDots: 160, widthBytes: 18 },
    });
  });

  it('rejects a modified production file before any bitmap can reach the printer', async () => {
    const root = tempRoot();
    const bytes = pngEnvelope(160, 160);
    const actualDigest = createHash('sha256').update(bytes).digest('hex');
    const storedPath = productionPath(root, 'salon-a', actualDigest);
    mkdirSync(join(storedPath, '..'), { recursive: true });
    writeFileSync(storedPath, bytes);
    mocks.getRow.mockReturnValue(productionRow({
      production_sha256: 'c'.repeat(64),
      production_path: storedPath,
    }));
    const decodePng = vi.fn(() => whiteDecode(160, 160));
    const service = new FabricTagArtworkService({ userDataPath: () => root, decodePng });

    await expect(service.loadProductionForPrint(
      'salon-a',
      { assetId: 'asset-1', quantity: 1 },
    )).rejects.toThrow(/hash no longer matches/i);
    expect(decodePng).not.toHaveBeenCalled();
    expect(mocks.packMonochrome).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('rejects a production path belonging to another salon even if the row leaks', async () => {
    const root = tempRoot();
    const bytes = pngEnvelope(160, 160);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const otherSalonPath = productionPath(root, 'salon-b', digest);
    mocks.getRow.mockReturnValue(productionRow({
      salon_id: 'salon-b',
      production_sha256: digest,
      production_path: otherSalonPath,
    }));
    const service = new FabricTagArtworkService({ userDataPath: () => root });

    await expect(service.loadProductionForPrint(
      'salon-a',
      { assetId: 'asset-1', quantity: 1 },
    )).rejects.toThrow(/outside the current salon storage/i);
    expect(mocks.getRow).toHaveBeenCalledWith('salon-a', 'asset-1');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('aborts when the active salon generation changes during file validation', async () => {
    const root = tempRoot();
    const bytes = pngEnvelope(160, 160);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const storedPath = productionPath(root, 'salon-a', digest);
    mkdirSync(join(storedPath, '..'), { recursive: true });
    writeFileSync(storedPath, bytes);
    mocks.getRow.mockReturnValue(productionRow({
      production_sha256: digest,
      production_path: storedPath,
    }));
    const tenantGeneration = vi.fn()
      .mockReturnValueOnce(4)
      .mockReturnValueOnce(5);
    const decodePng = vi.fn(() => whiteDecode(160, 160));
    const service = new FabricTagArtworkService({
      userDataPath: () => root,
      tenantGeneration,
      decodePng,
    });

    await expect(service.loadProductionForPrint(
      'salon-a',
      { assetId: 'asset-1', quantity: 1 },
    )).rejects.toThrow(/salon changed.*retry/i);
    expect(tenantGeneration).toHaveBeenCalledTimes(2);
    expect(decodePng).not.toHaveBeenCalled();
    expect(mocks.packMonochrome).not.toHaveBeenCalled();
  });

  it('re-reads the scoped row and aborts if production metadata changes during decode', async () => {
    const root = tempRoot();
    const bytes = pngEnvelope(160, 160);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const storedPath = productionPath(root, 'salon-a', digest);
    mkdirSync(join(storedPath, '..'), { recursive: true });
    writeFileSync(storedPath, bytes);
    const initial = productionRow({
      production_sha256: digest,
      production_path: storedPath,
    });
    mocks.getRow
      .mockReturnValueOnce(initial)
      .mockReturnValueOnce({ ...initial, production_sha256: 'd'.repeat(64) });
    const decodePng = vi.fn(() => whiteDecode(160, 160));
    const service = new FabricTagArtworkService({
      userDataPath: () => root,
      tenantGeneration: () => 9,
      decodePng,
    });

    await expect(service.loadProductionForPrint(
      'salon-a',
      { assetId: 'asset-1', quantity: 1 },
    )).rejects.toThrow(/artwork changed while.*being validated/i);
    expect(mocks.getRow).toHaveBeenNthCalledWith(1, 'salon-a', 'asset-1');
    expect(mocks.getRow).toHaveBeenNthCalledWith(2, 'salon-a', 'asset-1');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('fences a retired or replaced row at the final synchronous dispatch boundary', () => {
    const current = productionRow();
    mocks.getRow.mockReturnValue(current);
    const service = new FabricTagArtworkService({
      userDataPath: tempRoot,
      tenantGeneration: () => 12,
    });
    const loaded = {
      artwork: { id: current.id } as any,
      bitmap: { widthDots: 142, heightDots: 160, widthBytes: 18, data: Buffer.alloc(18 * 160) },
      physicalLengthMm: 20,
      salonId: 'salon-a',
      tenantGeneration: 12,
      dispatchFence: {
        sourceSha256: current.source_sha256,
        productionPath: current.production_path!,
        productionSha256: current.production_sha256!,
        widthPx: current.width_px!,
        heightPx: current.height_px!,
        physicalWidthMm: Number(current.physical_width_mm),
        physicalLengthMm: Number(current.physical_length_mm),
        updatedAt: current.updated_at,
      },
    };

    expect(() => service.assertProductionCurrentForDispatch(loaded)).not.toThrow();

    mocks.getRow.mockReturnValueOnce({ ...current, status: 'RETIRED' });
    expect(() => service.assertProductionCurrentForDispatch(loaded))
      .toThrow(/artwork changed before it reached the printer/i);

    mocks.getRow.mockReturnValueOnce({
      ...current,
      production_path: '/managed/new-revision.png',
      production_sha256: 'e'.repeat(64),
    });
    expect(() => service.assertProductionCurrentForDispatch(loaded))
      .toThrow(/artwork changed before it reached the printer/i);
  });
});
