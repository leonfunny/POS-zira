import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const db = vi.hoisted(() => ({
  get: vi.fn(),
  run: vi.fn(),
  transaction: vi.fn((fn: () => void) => fn()),
}));
const repo = vi.hoisted(() => ({
  listDirty: vi.fn(() => [] as any[]),
  markSynced: vi.fn(),
  applyFromServer: vi.fn(),
}));
const token = vi.hoisted(() => ({ value: 'jwt-token' as string | null }));

vi.mock('../src/main/network/api-client', () => ({ apiClient: api }));
vi.mock('../src/main/database/database', () => ({ database: db }));
vi.mock('../src/main/database/repos/label-print-order-repo', () => ({
  labelPrintOrderRepo: repo,
}));
vi.mock('../src/main/config/store', () => ({ getSecureAuthToken: () => token.value }));
vi.mock('../src/main/logger', () => ({ default: { warn: vi.fn(), info: vi.fn() } }));

import { PrintOrderSync } from '../src/main/sync/print-order-sync';

function dirtyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    name: 'MOON',
    payload: JSON.stringify({ customerName: 'MOON' }),
    updated_at: '2026-09-06T10:00:00.000Z',
    deleted_at: null,
    dirty: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  token.value = 'jwt-token';
  db.get.mockReturnValue(undefined);
  db.transaction.mockImplementation((fn: () => void) => fn());
  repo.listDirty.mockReturnValue([]);
  api.request.mockResolvedValue({ items: [], serverTime: '2026-09-06T12:00:00.000Z' });
});

describe('keeping this machine and the salon in step', () => {
  it('pushes what was typed here before it pulls anything', async () => {
    // A sheet typed while the line was down exists nowhere else; sending it
    // first is what stops a pull from overwriting it.
    repo.listDirty.mockReturnValue([dirtyRow()]);
    await new PrintOrderSync().sync();
    const methods = api.request.mock.calls.map((call) => call[0]);
    expect(methods).toEqual(['PUT', 'GET']);
  });

  it('sends the sheet under its own id and stores the server stamp', async () => {
    repo.listDirty.mockReturnValue([dirtyRow()]);
    api.request.mockImplementation(async (method: string) =>
      method === 'PUT'
        ? { id: 'order-1', updatedAt: '2026-09-06T11:59:00.000Z' }
        : { items: [], serverTime: '2026-09-06T12:00:00.000Z' },
    );
    await new PrintOrderSync().sync();
    expect(api.request).toHaveBeenCalledWith('PUT', '/label-print-orders/order-1', 'jwt-token', {
      name: 'MOON',
      payload: { customerName: 'MOON' },
    });
    expect(repo.markSynced).toHaveBeenCalledWith(
      'order-1',
      '2026-09-06T10:00:00.000Z',
      '2026-09-06T11:59:00.000Z',
      false,
    );
  });

  it('pushes a deletion as a DELETE', async () => {
    repo.listDirty.mockReturnValue([dirtyRow({ deleted_at: '2026-09-06T10:00:00.000Z' })]);
    await new PrintOrderSync().sync();
    expect(api.request).toHaveBeenCalledWith('DELETE', '/label-print-orders/order-1', 'jwt-token');
    expect(repo.markSynced).toHaveBeenCalledWith(
      'order-1',
      '2026-09-06T10:00:00.000Z',
      '2026-09-06T10:00:00.000Z',
      true,
    );
  });

  it('carries on past a sheet the server refuses, so one bad row cannot block the shop', async () => {
    repo.listDirty.mockReturnValue([dirtyRow({ id: 'bad' }), dirtyRow({ id: 'good' })]);
    api.request.mockImplementation(async (method: string, path: string) => {
      if (path.endsWith('/bad')) {
        const err = new Error('Bad Request') as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      return method === 'GET' ? { items: [], serverTime: 'now' } : { id: 'good', updatedAt: 'now' };
    });
    await new PrintOrderSync().sync();
    expect(api.request.mock.calls.map((call) => call[1])).toContain('/label-print-orders/good');
  });

  it('stops the round trip on a server error rather than moving the cursor past unseen sheets', async () => {
    repo.listDirty.mockReturnValue([dirtyRow()]);
    const err = new Error('Bad Gateway') as Error & { status?: number };
    err.status = 502;
    api.request.mockRejectedValue(err);
    await expect(new PrintOrderSync().sync()).resolves.toBe(0);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('asks for everything the first time and for the delta afterwards', async () => {
    await new PrintOrderSync().sync();
    expect(api.request).toHaveBeenCalledWith('GET', '/label-print-orders', 'jwt-token');

    db.get.mockReturnValue({ value: '2026-09-06T12:00:00.000Z' });
    await new PrintOrderSync().sync();
    expect(api.request).toHaveBeenLastCalledWith(
      'GET',
      '/label-print-orders?since=2026-09-06T12%3A00%3A00.000Z',
      'jwt-token',
    );
  });

  it('stores the cursor the server gave, not this machine clock', async () => {
    // A POS running a minute fast would set a cursor that skips every sheet
    // saved in that minute.
    api.request.mockResolvedValue({ items: [], serverTime: '2026-09-06T12:00:00.000Z' });
    await new PrintOrderSync().sync();
    expect(db.run.mock.calls.at(-1)?.[1]).toEqual([
      'label_print_orders_cursor',
      '2026-09-06T12:00:00.000Z',
    ]);
  });

  it('applies each sheet that came down', async () => {
    api.request.mockResolvedValue({
      items: [
        {
          id: 'order-9',
          name: 'H&M',
          payload: { customerName: 'H&M' },
          updatedAt: '2026-09-06T11:00:00.000Z',
          deletedAt: null,
        },
      ],
      serverTime: '2026-09-06T12:00:00.000Z',
    });
    await new PrintOrderSync().sync();
    expect(repo.applyFromServer).toHaveBeenCalledWith({
      id: 'order-9',
      name: 'H&M',
      payload: { customerName: 'H&M' },
      updatedAt: '2026-09-06T11:00:00.000Z',
      deletedAt: null,
    });
  });

  it('does nothing at all when nobody is logged in', async () => {
    token.value = null;
    await expect(new PrintOrderSync().sync()).resolves.toBe(0);
    expect(api.request).not.toHaveBeenCalled();
  });

  it('shares one round trip between concurrent callers', async () => {
    const sync = new PrintOrderSync();
    await Promise.all([sync.sync(), sync.sync()]);
    expect(api.request.mock.calls.filter((call) => call[0] === 'GET')).toHaveLength(1);
  });
});
