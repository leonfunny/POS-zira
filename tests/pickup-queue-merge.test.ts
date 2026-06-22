import { describe, expect, it } from 'vitest';
import {
  mergePickupEvent,
  seedPickupOrders,
  removePickupOrder,
  type PickupOrderRow,
} from '../src/renderer/components/pos/pickup-queue-merge';

const row = (over: Partial<PickupOrderRow> = {}): PickupOrderRow => ({
  id: 'po-1',
  sourceOrderId: 'kso-1',
  orderNumber: 'K-001',
  sequence: 1,
  totalGrosze: 1500,
  status: 'PENDING',
  ...over,
});

describe('seedPickupOrders', () => {
  it('keeps only open rows, ordered by sequence', () => {
    const seeded = seedPickupOrders([
      row({ id: 'a', sequence: 2 }),
      row({ id: 'b', sequence: 1 }),
      row({ id: 'c', status: 'SETTLED' }),
      row({ id: 'd', status: 'CANCELLED' }),
    ]);
    expect(seeded.map((r) => r.id)).toEqual(['b', 'a']);
  });
  it('tolerates null/garbage', () => {
    expect(seedPickupOrders(null)).toEqual([]);
    expect(seedPickupOrders(undefined)).toEqual([]);
  });
});

describe('mergePickupEvent', () => {
  it('adds a new pending order', () => {
    const next = mergePickupEvent([], { event: 'new', data: row({ id: 'x' }) });
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('x');
  });

  it('upserts (no duplicate) when the same id arrives again', () => {
    const start = [row({ id: 'x', totalGrosze: 1000 })];
    const next = mergePickupEvent(start, { event: 'new', data: row({ id: 'x', totalGrosze: 2000 }) });
    expect(next).toHaveLength(1);
    expect(next[0].totalGrosze).toBe(2000);
  });

  it('marks claimed and keeps the row (claimed elsewhere stays visible)', () => {
    const start = [row({ id: 'x' })];
    const next = mergePickupEvent(start, {
      event: 'claimed',
      data: { id: 'x', status: 'CLAIMED', claimedByMachineId: 'POS2' },
    });
    expect(next[0].status).toBe('CLAIMED');
    expect(next[0].claimedByMachineId).toBe('POS2');
  });

  it('released returns the row to pending', () => {
    const start = [row({ id: 'x', status: 'CLAIMED', claimedByMachineId: 'POS2' })];
    const next = mergePickupEvent(start, { event: 'released', data: { id: 'x', status: 'PENDING' } });
    expect(next[0].status).toBe('PENDING');
  });

  it('settled removes the row', () => {
    const start = [row({ id: 'x' }), row({ id: 'y', sequence: 2 })];
    const next = mergePickupEvent(start, { event: 'settled', data: { id: 'x', status: 'SETTLED' } });
    expect(next.map((r) => r.id)).toEqual(['y']);
  });

  it('cancelled removes the row', () => {
    const start = [row({ id: 'x' })];
    const next = mergePickupEvent(start, { event: 'cancelled', data: { id: 'x', status: 'CANCELLED' } });
    expect(next).toEqual([]);
  });

  it('ignores events without an id', () => {
    const start = [row({ id: 'x' })];
    expect(mergePickupEvent(start, { event: 'new', data: {} })).toBe(start);
  });
});

describe('removePickupOrder', () => {
  it('drops the given id', () => {
    expect(removePickupOrder([row({ id: 'x' }), row({ id: 'y' })], 'x').map((r) => r.id)).toEqual(['y']);
  });
});
