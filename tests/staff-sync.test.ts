import { beforeEach, describe, expect, it, vi } from 'vitest';

const txState = vi.hoisted(() => ({
  inTransaction: false,
}));

vi.mock('../src/main/network/api-client', () => ({
  apiClient: {
    getStaff: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/staff-repo', () => ({
  staffRepo: {
    upsertMany: vi.fn(() => {
      if (txState.inTransaction) {
        throw new Error('cannot start a transaction within a transaction');
      }
    }),
  },
}));

vi.mock('../src/main/database/database', () => ({
  database: {
    save: vi.fn(),
    transaction: vi.fn((fn: () => void) => {
      txState.inTransaction = true;
      try {
        fn();
      } finally {
        txState.inTransaction = false;
      }
    }),
  },
}));

vi.mock('../src/main/config/store', () => ({
  getSecureAuthToken: vi.fn(),
}));

vi.mock('../src/main/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
  },
}));

import { apiClient } from '../src/main/network/api-client';
import { staffRepo } from '../src/main/database/repos/staff-repo';
import { database } from '../src/main/database/database';
import { getSecureAuthToken } from '../src/main/config/store';
import { StaffSync } from '../src/main/sync/staff-sync';

describe('StaffSync.pullStaff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txState.inTransaction = false;
    vi.mocked(getSecureAuthToken).mockReturnValue('secure-token');
  });

  it('lets staffRepo own the write transaction when staff data is returned', async () => {
    vi.mocked(apiClient.getStaff).mockResolvedValue([
      {
        id: 'staff-profile-1',
        name: 'Alice Staff',
        commissionRate: 1500,
        isActive: true,
        updatedAt: '2026-04-28T12:00:00.000Z',
        role: 'stylist',
      },
      {
        id: 'staff-profile-2',
        fullName: 'Bob Staff',
        commission_rate: 500,
        isActive: false,
      },
    ] as any);

    await expect(new StaffSync().pullStaff()).resolves.toBe(2);

    expect(staffRepo.upsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'staff-profile-1',
        name: 'Alice Staff',
        commission_rate: 1500,
        is_active: 1,
        updated_at: '2026-04-28T12:00:00.000Z',
        role: 'stylist',
      }),
      expect.objectContaining({
        id: 'staff-profile-2',
        name: 'Bob Staff',
        commission_rate: 500,
        is_active: 0,
        updated_at: null,
        role: null,
      }),
    ]);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.save).toHaveBeenCalled();
  });
});
