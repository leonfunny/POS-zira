import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    get: vi.fn(),
    run: vi.fn(),
    save: vi.fn(),
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
    expect(params).toEqual(['order-1', 'SUCCESS_CONFIRMED', 'UNKNOWN_NEEDS_RECONCILIATION']);
  });
});
