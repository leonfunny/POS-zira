import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    all: vi.fn(),
    get: vi.fn(),
    run: vi.fn(),
    transaction: vi.fn((fn: () => void) => fn()),
  },
}));

import { database } from '../src/main/database/database';
import { staffRepo } from '../src/main/database/repos/staff-repo';

describe('staffRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves existing canonical user_id when an incoming staff payload omits it', () => {
    staffRepo.upsertMany([
      {
        id: 'profile-1',
        user_id: null,
        name: 'Alice',
        commission_rate: 0,
        is_active: 1,
        updated_at: null,
      },
    ]);

    const sql = vi.mocked(database.run).mock.calls[0]?.[0] ?? '';

    expect(sql).toContain('ON CONFLICT(id) DO UPDATE SET');
    expect(sql).toContain('user_id = COALESCE(excluded.user_id, pos_staff.user_id)');
  });
});
