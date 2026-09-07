import { describe, expect, it, vi } from 'vitest';
import {
  PRINT_ORDER_LIMITS,
  parsePrintOrderId,
  parsePrintOrderInput,
  registerPrintOrderIpcHandlers,
} from '../src/main/pos/label-print-order-ipc';
import { PRINT_ORDER_CHANNELS } from '../src/shared/label-print-order-ipc';

function harness() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, fn: any) => handlers.set(channel, fn) };
  const repository = {
    list: vi.fn(() => [] as any[]),
    save: vi.fn(),
    remove: vi.fn(),
    flush: vi.fn(async () => {}),
  };
  const syncer = { sync: vi.fn(async () => 0) };
  registerPrintOrderIpcHandlers(ipc as any, repository, syncer);
  return { handlers, repository, syncer };
}

describe('what the renderer is allowed to store', () => {
  it('refuses a sheet that is not an object', () => {
    expect(() => parsePrintOrderInput('order')).toThrow(TypeError);
    expect(() => parsePrintOrderInput([{ id: 'a' }])).toThrow(TypeError);
  });

  it('refuses an empty or oversized id', () => {
    expect(() => parsePrintOrderId('')).toThrow(TypeError);
    expect(() => parsePrintOrderId('x'.repeat(PRINT_ORDER_LIMITS.id + 1))).toThrow(TypeError);
  });

  it('refuses a sheet too large to store', () => {
    const huge = { id: 'a', order: { photo: 'x'.repeat(PRINT_ORDER_LIMITS.payload) } };
    expect(() => parsePrintOrderInput(huge)).toThrow(TypeError);
  });

  it('keeps the sheet whole — its fields belong to the label module', () => {
    const order = { customerName: 'MOON', rows: [{ size: 'M', qty: 100 }], nested: { a: [1] } };
    expect(parsePrintOrderInput({ id: 'a', name: 'MOON', order }).order).toEqual(order);
  });

  it('trims a name past the column width instead of failing the save', () => {
    const parsed = parsePrintOrderInput({ id: 'a', name: 'N'.repeat(500), order: {} });
    expect(parsed.name).toHaveLength(PRINT_ORDER_LIMITS.name);
  });

  it('stamps a sheet that arrives without a usable date', () => {
    const parsed = parsePrintOrderInput({ id: 'a', order: {}, savedAt: 'not a date' });
    expect(Number.isNaN(Date.parse(parsed.savedAt))).toBe(false);
  });
});

describe('the handlers the panel calls', () => {
  it('answers from this machine copy and syncs behind it, so saving works offline', async () => {
    const { handlers, repository, syncer } = harness();
    repository.list.mockReturnValue([{ id: 'a', name: '', savedAt: 'now', order: {} }]);
    const result = (await handlers.get(PRINT_ORDER_CHANNELS.save)!({}, {
      id: 'a',
      name: '',
      order: {},
    })) as unknown[];
    expect(repository.save).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(syncer.sync).toHaveBeenCalled();
  });

  it('does not fail a save when the sync fails — the sheet is stored either way', async () => {
    const { handlers, repository, syncer } = harness();
    syncer.sync.mockRejectedValue(new Error('offline'));
    await expect(handlers.get(PRINT_ORDER_CHANNELS.save)!({}, { id: 'a', order: {} })).resolves.toEqual([]);
    expect(repository.save).toHaveBeenCalled();
    // The rejection must not escape as an unhandled one in the main process.
    await Promise.resolve();
  });

  it('deletes by id and stamps the moment', async () => {
    const { handlers, repository } = harness();
    await handlers.get(PRINT_ORDER_CHANNELS.remove)!({}, 'a');
    const [id, at] = repository.remove.mock.calls[0];
    expect(id).toBe('a');
    expect(Number.isNaN(Date.parse(at as string))).toBe(false);
  });

  it('refuses a malformed id rather than passing it to SQLite', async () => {
    const { handlers, repository } = harness();
    await expect(handlers.get(PRINT_ORDER_CHANNELS.remove)!({}, 42)).rejects.toThrow(TypeError);
    expect(repository.remove).not.toHaveBeenCalled();
  });
});

describe('durable acknowledgements', () => {
  it.each([PRINT_ORDER_CHANNELS.save, PRINT_ORDER_CHANNELS.remove])('waits for disk before acknowledging %s', async (channel) => {
    const { handlers, repository, syncer } = harness();
    let release!: () => void;
    repository.flush.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    let acknowledged = false;
    const input = channel === PRINT_ORDER_CHANNELS.save ? { id: 'a', order: {} } : 'a';
    const result = Promise.resolve(handlers.get(channel)!({}, input)).then(() => { acknowledged = true; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(syncer.sync).not.toHaveBeenCalled();
    release();
    await result;
    expect(acknowledged).toBe(true);
  });

  it('propagates disk failure instead of reporting Saved', async () => {
    const { handlers, repository, syncer } = harness();
    repository.flush.mockRejectedValueOnce(new Error('Disk full'));
    await expect(handlers.get(PRINT_ORDER_CHANNELS.save)!({}, { id: 'a', order: {} }))
      .rejects.toThrow('Disk full');
    expect(syncer.sync).not.toHaveBeenCalled();
  });
});
