import { vi } from 'vitest';
import type { CheckinRuntime } from '../src/renderer/components/checkin/runtime';

export function createCheckinRuntime(overrides: Partial<CheckinRuntime> = {}): CheckinRuntime {
  const runtime: CheckinRuntime = {
    presentation: {
      audience: 'staff',
      showQueue: true,
      showStats: true,
      allowStatusMutations: true,
      allowBookingStaffOverride: true,
      requireCustomerPhone: false,
    },
    checkins: {
      getToday: vi.fn().mockResolvedValue([]),
      getStats: vi.fn().mockResolvedValue({
        total: 0,
        waiting: 0,
        inService: 0,
        completed: 0,
        noShow: 0,
        walkIns: 0,
      }),
      createWithCustomer: vi.fn().mockResolvedValue({ success: true, bookingNumber: 'A001' }),
      printConfirmation: vi.fn().mockResolvedValue({ success: true }),
      startService: vi.fn().mockResolvedValue({ success: true }),
      complete: vi.fn().mockResolvedValue({ success: true }),
      markNoShow: vi.fn().mockResolvedValue({ success: true }),
    },
    bookings: {
      getToday: vi.fn().mockResolvedValue([]),
    },
    catalog: {
      getServices: vi.fn().mockResolvedValue([]),
      getCategories: vi.fn().mockResolvedValue([]),
      getStaff: vi.fn().mockResolvedValue([]),
    },
    customers: {
      getByPhone: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ success: false }),
      getRecommendations: vi.fn().mockResolvedValue([]),
    },
    servicePopularity: {
      get: vi.fn().mockResolvedValue([]),
    },
  };

  return {
    ...runtime,
    ...overrides,
    presentation: { ...runtime.presentation, ...overrides.presentation },
    checkins: { ...runtime.checkins, ...overrides.checkins },
    bookings: { ...runtime.bookings, ...overrides.bookings },
    catalog: { ...runtime.catalog, ...overrides.catalog },
    customers: { ...runtime.customers, ...overrides.customers },
    servicePopularity: { ...runtime.servicePopularity, ...overrides.servicePopularity },
  };
}
