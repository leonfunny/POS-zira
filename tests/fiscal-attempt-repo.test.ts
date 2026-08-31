import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
    save: vi.fn(),
    saveCoalesced: vi.fn(),
    markDirty: vi.fn(),
  },
}));

import { database } from '../src/main/database/database';
import { fiscalAttemptRepo } from '../src/main/database/repos/fiscal-attempt-repo';

describe('fiscalAttemptRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks leftover SENT attempts as unknown on startup', () => {
    vi.mocked(database.get).mockReturnValueOnce({ count: 2 });

    const count = fiscalAttemptRepo.markOpenSentAsUnknownOnStartup();

    expect(count).toBe(2);
    expect(database.run).toHaveBeenCalledWith(
      expect.stringContaining("WHERE status = 'SENT'"),
      [JSON.stringify({ reason: 'App restarted with fiscal attempt left in SENT state' })],
    );
    expect(database.markDirty).toHaveBeenCalledTimes(1);
  });

  it('does not write during startup recovery when no SENT attempts exist', () => {
    vi.mocked(database.get).mockReturnValueOnce({ count: 0 });

    const count = fiscalAttemptRepo.markOpenSentAsUnknownOnStartup();

    expect(count).toBe(0);
    expect(database.run).not.toHaveBeenCalled();
    expect(database.markDirty).not.toHaveBeenCalled();
  });

  it('does not treat pre-open ReceiptBegin failures as blocking unknown attempts', () => {
    vi.mocked(database.get).mockReturnValueOnce(null);

    const row = fiscalAttemptRepo.findBlockingAttempt('order-1');

    expect(row).toBeNull();
    const [sql, params] = vi.mocked(database.get).mock.calls[0];
    expect(sql).toContain("result_json LIKE '%ReceiptBegin failed:%'");
    expect(sql).toContain("result_json LIKE '%ReceiptConditions failed:%'");
    expect(params).toEqual(['order-1', 'SENT', 'SUCCESS_CONFIRMED', 'UNKNOWN_NEEDS_RECONCILIATION']);
  });

  it('flushes the in-memory fiscal ledger through the coalesced durability barrier', async () => {
    vi.mocked(database.saveCoalesced).mockResolvedValueOnce({ success: true } as any);

    await expect(fiscalAttemptRepo.flush()).resolves.toEqual({ success: true });
    expect(database.saveCoalesced).toHaveBeenCalledTimes(1);
  });

  it('recovers the original sale when a newer confirmed refund masks it', () => {
    vi.mocked(database.all).mockReturnValueOnce([
      {
        printer_type: 'LOCAL',
        payload_json: JSON.stringify({ isRefund: true, items: [{}], payment: {}, total: -100 }),
        result_json: '{}',
      },
      {
        printer_type: 'LOCAL',
        payload_json: JSON.stringify({ items: [{}], payment: { method: 'cash' }, total: 100 }),
        result_json: '{}',
      },
    ]);

    expect(fiscalAttemptRepo.getOriginalSaleReceiptSnapshot('order-1')).toMatchObject({
      total: 100,
    });
    expect(database.all).toHaveBeenCalledWith(
      expect.stringContaining("status = 'SUCCESS_CONFIRMED'"),
      ['order-1'],
    );
  });

  it('rejects an unproven remote original sale snapshot', () => {
    vi.mocked(database.all).mockReturnValueOnce([
      {
        printer_type: 'REMOTE',
        payload_json: JSON.stringify({ items: [{}], payment: { method: 'cash' }, total: 100 }),
        result_json: JSON.stringify({ remote: true }),
      },
    ]);

    expect(fiscalAttemptRepo.getOriginalSaleReceiptSnapshot('order-1')).toBeNull();
  });

  it('recovers an evidenced remote original sale behind a newer reprint', () => {
    vi.mocked(database.all).mockReturnValueOnce([
      {
        printer_type: 'REMOTE',
        payload_json: JSON.stringify({ isReprint: true, items: [{}], payment: {}, total: 100 }),
        result_json: JSON.stringify({ remote: true, jobId: 'reprint-job', printerId: 'printer-1' }),
      },
      {
        printer_type: 'REMOTE',
        payload_json: JSON.stringify({ items: [{}], payment: { method: 'cash' }, total: 100 }),
        result_json: JSON.stringify({ remote: true, jobId: 'sale-job', printerId: 'printer-1' }),
      },
    ]);

    expect(fiscalAttemptRepo.getOriginalSaleReceiptSnapshot('order-1')).toMatchObject({
      total: 100,
    });
  });
});
