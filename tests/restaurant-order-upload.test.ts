import { describe, expect, it, vi } from 'vitest';
import { addRestaurantOrderMetadata, orderUploadScope, prepareOrderUpload, restaurantMetadataVersion } from '../src/shared/restaurant-order-upload';

const scope = { salonId: 'salon-a', serverUrl: 'https://api.enail.pro' };
const order = { id: 'o1', mode: 'restaurant', order_type: 'dine_in', table_id: 'local-table', covers: 2, sync_metadata_eligible: 1, sync_attempts: 0 };
const lines = [{ id: 'line-a', notes: 'No onions', course: 2 }, { id: 'line-b', notes: null, course: 1 }];
const legacy = () => ({ id: 'o1', mode: 'restaurant', orderType: 'dine_in', items: [{ productId: 'v1', customPrice: 12.5 }, { productId: 'v1', customPrice: 12.5 }], discountAmount: 1, tip: 2, tenders: [{ method: 'CASH', amount: 26 }] });
function options(extra: Record<string, any> = {}) {
  return { order, scope, lines, buildLegacy: legacy, readCapabilities: vi.fn(async () => ({ restaurantMetadataVersion: 1 })),
    assertContext: vi.fn(), persist: vi.fn(async (_snapshot: string) => {}), ...extra };
}

describe('shared immutable restaurant upload', () => {
  it('adds metadata without changing any financial field or collapsing same-product lines', async () => {
    const args = options();
    const dto = await prepareOrderUpload(args);
    expect(dto.restaurant).toEqual({ schemaVersion: 1, tableId: 'local-table', covers: 2 });
    expect(dto.items.map((i: any) => i.restaurant)).toEqual(lines.map(line => ({ localLineId: line.id, notes: line.notes, course: line.course })));
    const { restaurant: _metadata, ...withoutEnvelope } = dto;
    expect({ ...withoutEnvelope, items: dto.items.map(({ restaurant: _line, ...rest }: any) => rest) }).toEqual(legacy());
    expect(JSON.parse(args.persist.mock.calls[0][0])).toMatchObject({ version: 1, ...scope, payload: dto });
  });

  it('only treats HTTP404 or explicit zero as legacy; auth/network/malformed never downgrades', async () => {
    expect(await restaurantMetadataVersion(async () => { throw { status: 404 }; })).toBe(0);
    expect(await restaurantMetadataVersion(async () => ({ restaurantMetadataVersion: 0 }))).toBe(0);
    for (const error of [{ status: 401 }, { status: 403 }, new Error('offline')]) {
      await expect(restaurantMetadataVersion(async () => { throw error; })).rejects.toEqual(error);
    }
    await expect(restaurantMetadataVersion(async () => ({}))).rejects.toThrow('INVALID_CAPABILITIES');
  });

  it('freezes legacy server payload permanently, even after upgrade', async () => {
    const first = options({ readCapabilities: async () => { throw { status: 404 }; } });
    expect(await prepareOrderUpload(first)).toEqual(legacy());
    const retry = options({ order: { ...order, sync_payload_json: first.persist.mock.calls[0][0] }, buildLegacy: vi.fn(() => { throw new Error('must not rebuild'); }) });
    expect(await prepareOrderUpload(retry)).toEqual(legacy());
    expect(retry.readCapabilities).not.toHaveBeenCalled();
    expect(retry.buildLegacy).not.toHaveBeenCalled();
  });

  it.each([{ sync_metadata_eligible: 0, sync_attempts: 0 }, { sync_metadata_eligible: 1, sync_attempts: 2 }, { sync_metadata_eligible: undefined, sync_attempts: 0 }])('does not enrich preexisting/uncertain row %j', async flags => {
    const args = options({ order: { ...order, ...flags } });
    expect(await prepareOrderUpload(args)).toEqual(legacy());
    expect(args.readCapabilities).not.toHaveBeenCalled();
  });

  it('retries exact payload after lost response/restart even when local lines and capability changed', async () => {
    const first = options(); const sent = await prepareOrderUpload(first);
    const persisted = first.persist.mock.calls[0][0];
    const retry = options({ order: { ...order, covers: 99, sync_payload_json: persisted }, lines: [], readCapabilities: vi.fn(() => { throw new Error('offline'); }), buildLegacy: vi.fn() });
    expect(await prepareOrderUpload(retry)).toEqual(sent);
    expect(retry.persist).toHaveBeenCalledWith(persisted);
    expect(retry.readCapabilities).not.toHaveBeenCalled();
  });

  it('fails before sending on snapshot corruption or tenant/server mismatch', async () => {
    const first = options(); await prepareOrderUpload(first);
    for (const badScope of [{ ...scope, salonId: 'salon-b' }, { ...scope, serverUrl: 'https://other.test' }]) {
      const args = options({ scope: badScope, order: { ...order, sync_payload_json: first.persist.mock.calls[0][0] } });
      await expect(prepareOrderUpload(args)).rejects.toThrow('SCOPE_MISMATCH');
      expect(args.persist).not.toHaveBeenCalled();
    }
    await expect(prepareOrderUpload(options({ order: { ...order, sync_payload_json: 'broken' } }))).rejects.toThrow('CORRUPT_SNAPSHOT');
    expect(() => orderUploadScope('', scope.serverUrl)).toThrow('IDENTITY_REQUIRED');
  });

  it('waits for durability and rechecks context after it; storage failure propagates', async () => {
    const failed = options({ persist: vi.fn(async () => { throw new Error('disk full'); }) });
    await expect(prepareOrderUpload(failed)).rejects.toThrow('disk full');
    let changed = false;
    await expect(prepareOrderUpload(options({ persist: async () => { changed = true; }, assertContext: () => { if (changed) throw new Error('context changed'); } }))).rejects.toThrow('context changed');
  });

  it('rejects invalid service/table, duplicate identity, covers, course and long notes', () => {
    const cases = [
      { order: { ...order, order_type: 'standard' }, lines },
      { order: { ...order, order_type: 'takeout' }, lines },
      { order: { ...order, table_id: '   ' }, lines },
      { order: { ...order, covers: -1 }, lines },
      { order, lines: [lines[0], lines[0]] },
      { order, lines: [{ ...lines[0], course: 100 }, lines[1]] },
      { order, lines: [{ ...lines[0], notes: 'a'.repeat(4001) }, lines[1]] },
    ];
    for (const args of cases) expect(() => addRestaurantOrderMetadata(legacy(), args.order, args.lines)).toThrow();
  });
});
