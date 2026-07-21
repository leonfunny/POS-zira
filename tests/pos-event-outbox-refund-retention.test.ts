import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
    markDirty: vi.fn(),
  },
}));

vi.mock('../src/main/utils/ulid', () => ({
  ulid: vi.fn(() => 'event-id'),
}));

import { database } from '../src/main/database/database';
import { posEventOutboxRepo } from '../src/main/database/repos/pos-event-outbox-repo';

describe('posEventOutboxRepo refund retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never prunes acknowledged RefundIssued financial journal rows', () => {
    vi.mocked(database.get)
      .mockReturnValueOnce({ n: 2 } as any)
      .mockReturnValueOnce({ n: 1 } as any);

    expect(posEventOutboxRepo.pruneAcked(30)).toBe(1);

    const sql = vi.mocked(database.run).mock.calls[0][0] as string;
    expect(sql).toContain("event_type <> 'RefundIssued'");
    expect(sql).toContain("status = 'acked'");
  });
});
