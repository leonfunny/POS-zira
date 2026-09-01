import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/unused-user-data') },
  nativeImage: { createFromBuffer: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn() },
}));

vi.mock('../src/main/database/database', () => ({
  database: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
    saveCoalesced: vi.fn(),
  },
}));

vi.mock('../src/main/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { FABRIC_TAG_ARTWORK_CHANNELS } from '../src/shared/fabric-tag-artwork-ipc';
import {
  registerFabricTagArtworkIpcHandlers,
  type FabricTagArtworkIpcDependencies,
} from '../src/main/pos/fabric-tag-artwork-ipc';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function setup(overrides: Partial<FabricTagArtworkIpcDependencies> = {}) {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  };
  const service = {
    importSource: vi.fn(async () => ({ id: 'asset-1' })),
    attachProduction: vi.fn(async () => ({ id: 'asset-1', status: 'READY' })),
    list: vi.fn(() => []),
    getPreview: vi.fn(async () => null),
    retire: vi.fn(async () => ({ id: 'asset-1', status: 'RETIRED' })),
  };
  const getSalonId = vi.fn(() => 'salon-a');
  const print = vi.fn(async () => ({ success: true }));
  const pickFile = vi.fn(async () => 'C:\\trusted-picker\\customer-label.btw');
  registerFabricTagArtworkIpcHandlers(ipc as never, {
    service,
    getSalonId,
    print,
    pickFile,
    ...overrides,
  } as FabricTagArtworkIpcDependencies);
  return { handlers, ipc, service, getSalonId, print, pickFile };
}

describe('fabric artwork IPC picker and tenant boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers every exact shared channel once', () => {
    const { handlers, ipc } = setup();
    expect([...handlers.keys()]).toEqual(Object.values(FABRIC_TAG_ARTWORK_CHANNELS));
    expect(ipc.handle).toHaveBeenCalledTimes(Object.keys(FABRIC_TAG_ARTWORK_CHANNELS).length);
  });

  it('lets only the main-process picker introduce a source path', async () => {
    const { handlers, service, pickFile, getSalonId } = setup();
    const event = { sender: { id: 7 } };
    const metadata = {
      customerName: ' Customer A ',
      orderCode: ' ORDER-7 ',
      variant: ' S/M ',
      revision: ' r1 ',
    };

    await expect(handlers.get(FABRIC_TAG_ARTWORK_CHANNELS.importSource)!(event, metadata))
      .resolves.toEqual({ id: 'asset-1' });

    expect(pickFile).toHaveBeenCalledWith(event, 'source');
    expect(getSalonId).toHaveBeenCalledTimes(3);
    expect(service.importSource).toHaveBeenCalledWith(
      'salon-a',
      {
        customerName: 'Customer A',
        orderCode: 'ORDER-7',
        variant: 'S/M',
        revision: 'r1',
      },
      'C:\\trusted-picker\\customer-label.btw',
    );
  });

  it('rejects a renderer-supplied path before opening the picker', async () => {
    const { handlers, service, pickFile } = setup();

    await expect(Promise.resolve().then(() =>
      handlers.get(FABRIC_TAG_ARTWORK_CHANNELS.importSource)!({}, {
        customerName: 'Customer A',
        variant: 'M',
        revision: 'r1',
        selectedPath: 'C:\\renderer-controlled\\evil.btw',
      })))
      .rejects.toThrow(/unexpected field selectedPath/i);
    expect(pickFile).not.toHaveBeenCalled();
    expect(service.importSource).not.toHaveBeenCalled();
  });

  it('returns null on picker cancellation without creating an artwork row', async () => {
    const pickFile = vi.fn(async () => null);
    const { handlers, service } = setup({ pickFile });

    await expect(handlers.get(FABRIC_TAG_ARTWORK_CHANNELS.importSource)!({}, {
      customerName: 'Customer A',
      variant: 'M',
      revision: 'r1',
    })).resolves.toBeNull();
    expect(service.importSource).not.toHaveBeenCalled();
  });

  it('does not start an import if the active salon changes while the picker is open', async () => {
    const getSalonId = vi.fn()
      .mockReturnValueOnce('salon-a')
      .mockReturnValueOnce('salon-b');
    const { handlers, service } = setup({ getSalonId });

    await expect(handlers.get(FABRIC_TAG_ARTWORK_CHANNELS.importSource)!({}, {
      customerName: 'Customer A',
      variant: 'M',
      revision: 'r1',
    })).rejects.toThrow(/salon changed.*retry/i);
    expect(service.importSource).not.toHaveBeenCalled();
    expect(getSalonId).toHaveBeenCalledTimes(2);
  });

  it('does not return an async import result after the active salon changes', async () => {
    const getSalonId = vi.fn()
      .mockReturnValueOnce('salon-a')
      .mockReturnValueOnce('salon-a')
      .mockReturnValueOnce('salon-b');
    const { handlers, service } = setup({ getSalonId });

    await expect(handlers.get(FABRIC_TAG_ARTWORK_CHANNELS.importSource)!({}, {
      customerName: 'Customer A',
      variant: 'M',
      revision: 'r1',
    })).rejects.toThrow(/salon changed.*retry/i);
    expect(service.importSource).toHaveBeenCalledWith(
      'salon-a',
      expect.any(Object),
      'C:\\trusted-picker\\customer-label.btw',
    );
    expect(getSalonId).toHaveBeenCalledTimes(3);
  });

  it('validates an asset id before opening the production picker', async () => {
    const { handlers, service, pickFile } = setup();

    await expect(Promise.resolve().then(() =>
      handlers.get(FABRIC_TAG_ARTWORK_CHANNELS.attachProduction)!({}, '   ')))
      .rejects.toThrow(/assetId/i);
    expect(pickFile).not.toHaveBeenCalled();
    expect(service.attachProduction).not.toHaveBeenCalled();
  });

  it('does not attach a selected PNG if the salon changed while its picker was open', async () => {
    const getSalonId = vi.fn()
      .mockReturnValueOnce('salon-a')
      .mockReturnValueOnce('salon-b');
    const { handlers, service } = setup({ getSalonId });

    await expect(handlers.get(FABRIC_TAG_ARTWORK_CHANNELS.attachProduction)!({}, 'asset-1'))
      .rejects.toThrow(/salon changed.*picker.*retry/i);
    expect(service.attachProduction).not.toHaveBeenCalled();
  });

  it('derives list, preview, and retire ownership from the current main-process salon', async () => {
    const { handlers, service } = setup();

    expect(handlers.get(FABRIC_TAG_ARTWORK_CHANNELS.list)!({})).toEqual([]);
    await handlers.get(FABRIC_TAG_ARTWORK_CHANNELS.getPreview)!({}, ' asset-1 ');
    await handlers.get(FABRIC_TAG_ARTWORK_CHANNELS.retire)!({}, ' asset-2 ');

    expect(service.list).toHaveBeenCalledWith('salon-a');
    expect(service.getPreview).toHaveBeenCalledWith('salon-a', 'asset-1');
    expect(service.retire).toHaveBeenCalledWith('salon-a', 'asset-2');
  });

  it('forwards only a strictly validated assetId and quantity to hardware', async () => {
    const { handlers, print } = setup();

    await expect(handlers.get(FABRIC_TAG_ARTWORK_CHANNELS.print)!({}, {
      assetId: ' asset-1 ',
      quantity: 17,
    })).resolves.toEqual({ success: true });
    expect(print).toHaveBeenCalledWith({ assetId: 'asset-1', quantity: 17 });

    await expect(Promise.resolve().then(() =>
      handlers.get(FABRIC_TAG_ARTWORK_CHANNELS.print)!({}, {
        assetId: 'asset-1',
        quantity: 17,
        productionPath: 'C:\\renderer-controlled\\evil.png',
      })))
      .rejects.toThrow(/unexpected field productionPath/i);
    expect(print).toHaveBeenCalledTimes(1);
  });
});
