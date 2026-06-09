import { beforeEach, describe, expect, it, vi } from 'vitest';

const txState = vi.hoisted(() => ({
  inTransaction: false,
}));

vi.mock('../src/main/network/api-client', () => ({
  apiClient: {
    getStaffProfiles: vi.fn(),
    getStaff: vi.fn(),
    setStaffProfileStatus: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/staff-repo', () => ({
  staffRepo: {
    getById: vi.fn(),
    reconcileFromBackend: vi.fn(() => {
      if (txState.inTransaction) {
        throw new Error('cannot start a transaction within a transaction');
      }
    }),
  },
}));

vi.mock('../src/main/database/database', () => ({
  database: {
    run: vi.fn(),
    save: vi.fn(),
    markDirty: vi.fn(),
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
    vi.mocked(apiClient.getStaffProfiles).mockResolvedValue([]);
    vi.mocked(apiClient.getStaff).mockResolvedValue([]);
  });

  it('lets staffRepo own the write transaction when staff data is returned', async () => {
    vi.mocked(apiClient.getStaffProfiles).mockResolvedValue([
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

    expect(staffRepo.reconcileFromBackend).toHaveBeenCalledWith([
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
        updated_at: expect.any(String),
        role: null,
      }),
    ]);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.markDirty).toHaveBeenCalled();
  });

  it('falls back to public POS staff data when authenticated staff list is unavailable', async () => {
    vi.mocked(apiClient.getStaffProfiles).mockRejectedValue(new Error('Unauthorized'));
    vi.mocked(apiClient.getStaff).mockResolvedValue([
      {
        id: 'staff-profile-1',
        userId: 'user-1',
        fullName: 'Public Staff',
        commissionRate: 0.4,
        isActive: true,
        role: 'STAFF',
      },
    ] as any);

    await expect(new StaffSync().pullStaff()).resolves.toBe(1);

    expect(apiClient.getStaff).toHaveBeenCalledWith('secure-token');
    expect(staffRepo.reconcileFromBackend).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'staff-profile-1',
        user_id: 'user-1',
        name: 'Public Staff',
        commission_rate: 4000,
        is_active: 1,
        role: 'STAFF',
      }),
    ]);
  });

  it('deactivates staff through staff profile status, not user active status', async () => {
    vi.mocked(staffRepo.getById)
      .mockReturnValueOnce({
        id: 'staff-profile-1',
        user_id: 'user-1',
        name: 'Alice Staff',
        commission_rate: 4000,
        is_active: 1,
        updated_at: null,
      })
      .mockReturnValueOnce({
        id: 'staff-profile-1',
        user_id: 'user-1',
        name: 'Alice Staff',
        commission_rate: 4000,
        is_active: 0,
        updated_at: null,
      });
    vi.mocked(apiClient.setStaffProfileStatus).mockResolvedValue({});

    await expect(new StaffSync().setStaffActive('staff-profile-1', false)).resolves.toEqual(
      expect.objectContaining({ id: 'staff-profile-1', is_active: 0 }),
    );

    expect(apiClient.setStaffProfileStatus).toHaveBeenCalledWith('secure-token', 'user-1', 'OFF');
  });
});
