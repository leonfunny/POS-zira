import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
    save: vi.fn(),
    markDirty: vi.fn(),
  },
}));

import { database } from '../src/main/database/database';
import { printAttemptRepo } from '../src/main/database/repos/print-attempt-repo';

describe('printAttemptRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records a print attempt with all columns and marks the db dirty', () => {
    vi.mocked(database.get).mockReturnValueOnce({ id: 'x', order_id: 'order-1', status: 'PRINTED' });

    const row = printAttemptRepo.record({
      orderId: 'order-1',
      documentType: 'ORDER',
      printerType: 'RECEIPT',
      printerName: 'Xprinter XP-80T',
      printerTarget: 'COM7',
      route: 'LOCAL',
      status: 'PRINTED',
    });

    const [sql, params] = vi.mocked(database.run).mock.calls[0];
    expect(sql).toContain('INSERT INTO print_attempts');
    // id is generated; the rest map positionally after it
    expect(params.slice(1)).toEqual([
      'order-1', 'ORDER', 'RECEIPT', 'Xprinter XP-80T', 'COM7', 'LOCAL', 'PRINTED', null,
    ]);
    expect(database.markDirty).toHaveBeenCalledTimes(1);
    expect(row.order_id).toBe('order-1');
  });

  it('defaults optional fields to null (e.g. NO_PRINTER with no printer)', () => {
    vi.mocked(database.get).mockReturnValueOnce({ id: 'y' });

    printAttemptRepo.record({
      orderId: 'order-2',
      documentType: 'REFUND',
      printerType: 'RECEIPT',
      status: 'NO_PRINTER',
    });

    const [, params] = vi.mocked(database.run).mock.calls[0];
    expect(params.slice(1)).toEqual([
      'order-2', 'REFUND', 'RECEIPT', null, null, null, 'NO_PRINTER', null,
    ]);
  });

  it('findByOrder queries by order_id, newest first', () => {
    vi.mocked(database.all).mockReturnValueOnce([{ id: 'a' }, { id: 'b' }]);

    const rows = printAttemptRepo.findByOrder('order-1');

    expect(rows).toHaveLength(2);
    const [sql, params] = vi.mocked(database.all).mock.calls[0];
    expect(sql).toContain('WHERE order_id = ?');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(params).toEqual(['order-1']);
  });

  it('findLatestByOrder filters by document type when given', () => {
    vi.mocked(database.get).mockReturnValueOnce({ id: 'a', document_type: 'ORDER' });

    printAttemptRepo.findLatestByOrder('order-1', 'ORDER');

    const [sql, params] = vi.mocked(database.get).mock.calls[0];
    expect(sql).toContain('AND document_type = ?');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual(['order-1', 'ORDER']);
  });
});
