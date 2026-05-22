import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory store + fake transaction. The fake `transaction` runs `fn`
// inside try/catch; on throw we mark a flag so the test can assert
// rollback was simulated.
const state = {
  bookings: new Map<string, any>(),
  logs: [] as Array<{ entity_type: string; entity_id: string; event: string; payload: any }>,
  saveCount: 0,
  rolledBack: false,
};

vi.mock('../src/main/database/database', () => ({
  database: {
    all: vi.fn(),
    get: vi.fn(),
    run: vi.fn(),
    save: vi.fn(() => { state.saveCount++; }),
    markDirty: vi.fn(() => { state.saveCount++; }),
    transaction: vi.fn((fn: () => void) => {
      const beforeBookings = new Map(state.bookings);
      const beforeLogs = [...state.logs];
      try {
        return fn();
      } catch (err) {
        // Roll back: restore both maps to their pre-tx state.
        state.bookings = beforeBookings;
        state.logs = beforeLogs;
        state.rolledBack = true;
        throw err;
      }
    }),
  },
}));

vi.mock('../src/main/database/repos/booking-repo', () => ({
  bookingRepo: {
    upsert: vi.fn((row: any) => { state.bookings.set(row.id, row); }),
    applyLocalUpdate: vi.fn((id: string, patch: any) => {
      const cur = state.bookings.get(id) ?? { id };
      state.bookings.set(id, { ...cur, ...patch });
    }),
    applyLocalStatusChange: vi.fn((id: string, status: string, extras: any) => {
      const cur = state.bookings.get(id) ?? { id };
      state.bookings.set(id, { ...cur, status, ...extras });
    }),
  },
}));

vi.mock('../src/main/database/repos/service-repo', () => ({
  serviceRepo: {
    getById: vi.fn(() => ({
      id: 'svc-1',
      name: 'Mani',
      is_active: 1,
      base_duration_minutes: 150,
      base_price_pln: 12000,
    })),
  },
}));

vi.mock('../src/main/database/repos/service-rule-repo', () => ({
  serviceRuleRepo: {
    getById: vi.fn(() => ({ id: 'rule-1', duration_min: 60, base_price_pln: 5000 })),
    getByService: vi.fn(() => [{ id: 'rule-1', duration_min: 60, base_price_pln: 5000 }]),
  },
}));

vi.mock('../src/main/database/repos/staff-repo', () => ({
  staffRepo: {
    getByBookingStaffId: vi.fn(() => ({ id: 'profile-1', user_id: 'user-1', name: 'Alice', is_active: 1, commission_rate: 0, updated_at: null })),
  },
}));

import {
  repairOrphanBookings,
  writeBookingCreated,
  writeBookingStatusChanged,
  writeBookingUpdated,
} from '../src/main/sync/booking-sync';
import { database } from '../src/main/database/database';
import { serviceRuleRepo } from '../src/main/database/repos/service-rule-repo';

const fakeSyncLog = {
  writeLocalEntry: vi.fn((entityType: string, entityId: string, event: string, payload: any) => {
    state.logs.push({ entity_type: entityType, entity_id: entityId, event, payload });
    return 'fake-tx-uuid';
  }),
} as any;

describe('writeBookingCreated', () => {
  beforeEach(() => {
    state.bookings.clear();
    state.logs = [];
    state.saveCount = 0;
    state.rolledBack = false;
    vi.clearAllMocks();
    fakeSyncLog.writeLocalEntry.mockImplementation((entityType: string, entityId: string, event: string, payload: any) => {
      state.logs.push({ entity_type: entityType, entity_id: entityId, event, payload });
      return 'fake-tx-uuid';
    });
  });

  it('writes both bookings row and local_sync_log entry atomically', () => {
    const id = writeBookingCreated(fakeSyncLog, {
      serviceId: 'svc-1',
      staffUserId: 'user-1',
      startsAt: '2026-04-30T13:00:00Z',
      customerPhone: '500111222',
      customerName: 'TEST',
    });

    expect(state.bookings.has(id)).toBe(true);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]?.entity_type).toBe('booking');
    expect(state.logs[0]?.event).toBe('created');
    expect(state.logs[0]?.entity_id).toBe(id);
    // database.save() should fire after a successful transaction so the
    // booking + log entry survive a crash before the next push cycle.
    expect(state.saveCount).toBe(1);
    expect(state.rolledBack).toBe(false);
  });

  it('throws when input.ruleId references a rule from a different service', () => {
    // Mismatch surfaces stale-state bugs early instead of silently
    // creating a booking with the wrong duration / price.
    vi.mocked(serviceRuleRepo.getById).mockReturnValueOnce({
      id: 'rule-OTHER',
      service_id: 'svc-OTHER',
      duration_min: 60,
      base_price_pln: 9999,
    } as any);

    expect(() =>
      writeBookingCreated(fakeSyncLog, {
        serviceId: 'svc-1',
        staffUserId: 'user-1',
        startsAt: '2026-04-30T13:00:00Z',
        ruleId: 'rule-OTHER',
        customerPhone: '500111222',
        customerName: 'TEST',
      }),
    ).toThrow(/belongs to service svc-OTHER/);

    expect(state.bookings.size).toBe(0);
    expect(state.logs).toHaveLength(0);
  });

  it('falls back to service base duration/price when the service has no rules', () => {
    // No rules: getById returns null, getByService returns [].
    vi.mocked(serviceRuleRepo.getById).mockReturnValueOnce(null as any);
    vi.mocked(serviceRuleRepo.getByService).mockReturnValueOnce([]);

    const id = writeBookingCreated(fakeSyncLog, {
      serviceId: 'svc-1',
      staffUserId: 'user-1',
      startsAt: '2026-04-30T13:00:00Z',
      // ruleId intentionally omitted
      customerPhone: '500111222',
      customerName: 'TEST',
    });

    const row = state.bookings.get(id);
    expect(row?.rule_id).toBeNull();
    // Booking duration/price come from the service base fields when no
    // rule exists (base_duration_minutes=150, base_price_pln=12000).
    expect(row?.duration_minutes).toBe(150);
    expect(row?.base_price_pln).toBe(12000);
    expect(row?.total_price_pln).toBe(12000);
    // Outbound payload should omit rule_id when there is no rule so the
    // server's BookingsService.create runs the same fallback path.
    expect(state.logs[0]?.payload).not.toHaveProperty('rule_id');
  });

  it('rolls back the booking row when sync_log insert fails', () => {
    fakeSyncLog.writeLocalEntry.mockImplementationOnce(() => {
      throw new Error('local_sync_log insert failed');
    });

    expect(() => writeBookingCreated(fakeSyncLog, {
      serviceId: 'svc-1',
      staffUserId: 'user-1',
      startsAt: '2026-04-30T13:00:00Z',
      customerPhone: '500111222',
      customerName: 'TEST',
    })).toThrow('local_sync_log insert failed');

    // Rolled back: no booking row, no log row, no save fired.
    expect(state.bookings.size).toBe(0);
    expect(state.logs).toHaveLength(0);
    expect(state.saveCount).toBe(0);
    expect(state.rolledBack).toBe(true);
  });
});

describe('writeBookingStatusChanged', () => {
  beforeEach(() => {
    state.bookings.clear();
    state.logs = [];
    state.saveCount = 0;
    state.rolledBack = false;
    vi.clearAllMocks();
    fakeSyncLog.writeLocalEntry.mockImplementation((entityType: string, entityId: string, event: string, payload: any) => {
      state.logs.push({ entity_type: entityType, entity_id: entityId, event, payload });
      return 'fake-tx-uuid';
    });
    state.bookings.set('b-1', { id: 'b-1', status: 'BOOKED' });
  });

  it('applies status change and enqueues sync_log atomically', () => {
    writeBookingStatusChanged(fakeSyncLog, 'b-1', 'CANCELLED', {
      cancelReason: 'no show',
    });

    expect(state.bookings.get('b-1')?.status).toBe('CANCELLED');
    expect(state.bookings.get('b-1')?.cancel_reason).toBe('no show');
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]?.event).toBe('status_changed');
    expect(state.logs[0]?.payload.status).toBe('CANCELLED');
    expect(state.logs[0]?.payload.cancel_reason).toBe('no show');
    expect(state.saveCount).toBe(1);
    expect(state.rolledBack).toBe(false);
  });

  it('rolls back the local status change when sync_log insert fails', () => {
    fakeSyncLog.writeLocalEntry.mockImplementationOnce(() => {
      throw new Error('local_sync_log insert failed');
    });

    expect(() =>
      writeBookingStatusChanged(fakeSyncLog, 'b-1', 'CHECKED_IN'),
    ).toThrow('local_sync_log insert failed');

    // status reverted to BOOKED on rollback (the in-memory snapshot
    // restores both maps to their pre-tx state).
    expect(state.bookings.get('b-1')?.status).toBe('BOOKED');
    expect(state.logs).toHaveLength(0);
    expect(state.saveCount).toBe(0);
    expect(state.rolledBack).toBe(true);
  });
});

describe('writeBookingUpdated', () => {
  beforeEach(() => {
    state.bookings.clear();
    state.logs = [];
    state.saveCount = 0;
    state.rolledBack = false;
    vi.clearAllMocks();
    fakeSyncLog.writeLocalEntry.mockImplementation((entityType: string, entityId: string, event: string, payload: any) => {
      state.logs.push({ entity_type: entityType, entity_id: entityId, event, payload });
      return 'fake-tx-uuid';
    });
    state.bookings.set('b-1', { id: 'b-1', staff_user_id: 'old-staff' });
  });

  it('applies field update and enqueues sync_log atomically', () => {
    writeBookingUpdated(fakeSyncLog, 'b-1', {
      staffUserId: 'new-staff',
      startsAt: '2026-04-30T14:00:00Z',
    });

    expect(state.bookings.get('b-1')?.staff_user_id).toBe('new-staff');
    expect(state.bookings.get('b-1')?.starts_at).toBe('2026-04-30T14:00:00Z');
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]?.event).toBe('updated');
    expect(state.logs[0]?.payload.staff_user_id).toBe('new-staff');
    expect(state.logs[0]?.payload.starts_at).toBe('2026-04-30T14:00:00Z');
    expect(state.saveCount).toBe(1);
    expect(state.rolledBack).toBe(false);
  });

  it('rolls back the local update when sync_log insert fails', () => {
    fakeSyncLog.writeLocalEntry.mockImplementationOnce(() => {
      throw new Error('local_sync_log insert failed');
    });

    expect(() =>
      writeBookingUpdated(fakeSyncLog, 'b-1', { staffUserId: 'new-staff' }),
    ).toThrow('local_sync_log insert failed');

    expect(state.bookings.get('b-1')?.staff_user_id).toBe('old-staff');
    expect(state.logs).toHaveLength(0);
    expect(state.saveCount).toBe(0);
    expect(state.rolledBack).toBe(true);
  });
});

describe('repairOrphanBookings', () => {
  beforeEach(() => {
    state.bookings.clear();
    state.logs = [];
    state.saveCount = 0;
    vi.clearAllMocks();
    fakeSyncLog.writeLocalEntry.mockImplementation((entityType: string, entityId: string, event: string, payload: any) => {
      state.logs.push({ entity_type: entityType, entity_id: entityId, event, payload });
      return 'fake-tx-uuid';
    });
  });

  it('enqueues exactly one booking/created entry for a BOOKED orphan and is idempotent on second run', () => {
    // First run: DB has one orphan, repair should enqueue it.
    vi.mocked(database.all).mockReturnValueOnce([
      {
        id: 'orphan-1',
        owner_id: null,
        owner_full_name: 'Walk-in',
        owner_phone: '500111222',
        staff_user_id: 'user-1',
        service_id: 'svc-1',
        rule_id: 'rule-1',
        starts_at: '2026-04-30T13:00:00Z',
        customer_notes: null,
        internal_notes: null,
        cancel_reason: null,
        status: 'BOOKED',
      },
    ]);

    const r1 = repairOrphanBookings(fakeSyncLog);
    expect(r1.scanned).toBe(1);
    expect(r1.enqueued).toBe(1);
    expect(r1.enqueued_status).toBe(0);
    expect(r1.skipped).toBe(0);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]?.event).toBe('created');
    expect(state.logs[0]?.payload.id).toBe('orphan-1');
    expect(state.logs[0]?.payload.customer_phone).toBe('500111222');
    expect(state.saveCount).toBe(1);

    // Second run: NOT EXISTS (event='created') in the SELECT excludes
    // already-enqueued orphans, so the repair returns empty. Simulate by
    // returning [].
    vi.mocked(database.all).mockReturnValueOnce([]);
    const r2 = repairOrphanBookings(fakeSyncLog);
    expect(r2.scanned).toBe(0);
    expect(r2.enqueued).toBe(0);
    expect(state.logs).toHaveLength(1);   // unchanged
    expect(state.saveCount).toBe(1);      // no extra save
  });

  it('enqueues created + status_changed in FIFO for a CHECKED_IN orphan that has only a rejected status_changed log', () => {
    // The SELECT joins `WHERE event='created'` so a row that already has
    // a status_changed (rejected) but no created log still matches as an
    // orphan. The TEST123 case from 2026-04-30.
    vi.mocked(database.all).mockReturnValueOnce([
      {
        id: 'TEST123',
        owner_id: null,
        owner_full_name: 'TEST',
        owner_phone: '500111222',
        staff_user_id: 'user-1',
        service_id: 'svc-1',
        rule_id: 'rule-1',
        starts_at: '2026-04-30T13:00:00Z',
        customer_notes: null,
        internal_notes: null,
        cancel_reason: null,
        status: 'CHECKED_IN',
      },
    ]);

    const r = repairOrphanBookings(fakeSyncLog);
    expect(r.scanned).toBe(1);
    expect(r.enqueued).toBe(1);
    expect(r.enqueued_status).toBe(1);
    expect(state.logs).toHaveLength(2);

    // FIFO order: created MUST land before status_changed so the server
    // replays the transition correctly.
    expect(state.logs[0]?.event).toBe('created');
    expect(state.logs[0]?.entity_id).toBe('TEST123');
    expect(state.logs[1]?.event).toBe('status_changed');
    expect(state.logs[1]?.entity_id).toBe('TEST123');
    expect(state.logs[1]?.payload.status).toBe('CHECKED_IN');
  });

  it('enqueues booking/created without rule_id when orphan has rule_id null', () => {
    vi.mocked(database.all).mockReturnValueOnce([
      {
        id: 'no-rule-1',
        owner_id: null,
        owner_full_name: 'X',
        owner_phone: '500111222',
        staff_user_id: 'u',
        service_id: 'svc-no-rules',
        rule_id: null, // service has no rules
        starts_at: '2026-04-30T13:00:00Z',
        customer_notes: null,
        internal_notes: null,
        cancel_reason: null,
        status: 'BOOKED',
      },
    ]);

    const r = repairOrphanBookings(fakeSyncLog);
    expect(r.scanned).toBe(1);
    expect(r.enqueued).toBe(1);
    expect(r.skipped).toBe(0);
    expect(state.logs).toHaveLength(1);
    // Outbound payload omits rule_id so the server's
    // BookingsService.create runs the same fallback path
    // (service.base_duration_minutes / base_price_pln).
    expect(state.logs[0]?.payload).not.toHaveProperty('rule_id');
    expect(state.logs[0]?.payload.service_id).toBe('svc-no-rules');
  });

  it('forwards cancel_reason on CANCELLED orphans', () => {
    vi.mocked(database.all).mockReturnValueOnce([
      {
        id: 'CANC1',
        owner_id: null,
        owner_full_name: 'X',
        owner_phone: '500111222',
        staff_user_id: 'u',
        service_id: 's',
        rule_id: 'r',
        starts_at: 't',
        customer_notes: null,
        internal_notes: null,
        cancel_reason: 'no show',
        status: 'CANCELLED',
      },
    ]);

    const r = repairOrphanBookings(fakeSyncLog);
    expect(r.enqueued).toBe(1);
    expect(r.enqueued_status).toBe(1);
    expect(state.logs[1]?.payload.status).toBe('CANCELLED');
    expect(state.logs[1]?.payload.cancel_reason).toBe('no show');
  });

  it('rolls back created log when the follow-up status_changed write fails for a CHECKED_IN orphan', () => {
    // First call (created) succeeds, second call (status_changed)
    // throws — the per-orphan transaction must roll back BOTH writes
    // so we don't leave a created without its companion status_changed.
    let callIndex = 0;
    fakeSyncLog.writeLocalEntry.mockImplementation((entityType: string, entityId: string, event: string, payload: any) => {
      callIndex++;
      if (callIndex === 2) throw new Error('status log write failed');
      state.logs.push({ entity_type: entityType, entity_id: entityId, event, payload });
      return 'fake-tx-uuid';
    });

    vi.mocked(database.all).mockReturnValueOnce([
      {
        id: 'orphan-x',
        owner_id: null,
        owner_full_name: 'X',
        owner_phone: '500',
        staff_user_id: 'u',
        service_id: 's',
        rule_id: 'r',
        starts_at: 't',
        customer_notes: null,
        internal_notes: null,
        cancel_reason: null,
        status: 'CHECKED_IN',
      },
    ]);

    const r = repairOrphanBookings(fakeSyncLog);
    expect(r.scanned).toBe(1);
    expect(r.enqueued).toBe(0);          // rolled back
    expect(r.enqueued_status).toBe(0);   // never committed
    expect(r.skipped).toBe(1);
    expect(Object.keys(r.skipped_reasons)[0]).toMatch(/^enqueue_failed:/);
    expect(state.logs).toHaveLength(0);  // rollback removed the created
  });

  it('skips orphans missing required fields and groups skip reasons', () => {
    vi.mocked(database.all).mockReturnValueOnce([
      // missing service_id
      { id: 'a', owner_id: null, owner_full_name: 'X', owner_phone: '500', staff_user_id: 'u', service_id: null, rule_id: 'r', starts_at: 't', customer_notes: null, internal_notes: null, cancel_reason: null, status: 'BOOKED' },
      // missing staff_user_id
      { id: 'b', owner_id: null, owner_full_name: 'X', owner_phone: '500', staff_user_id: null, service_id: 's', rule_id: 'r', starts_at: 't', customer_notes: null, internal_notes: null, cancel_reason: null, status: 'BOOKED' },
      // missing owner identity (no owner_id, no phone+name pair)
      { id: 'c', owner_id: null, owner_full_name: null, owner_phone: '500', staff_user_id: 'u', service_id: 's', rule_id: 'r', starts_at: 't', customer_notes: null, internal_notes: null, cancel_reason: null, status: 'BOOKED' },
    ]);

    const r = repairOrphanBookings(fakeSyncLog);
    expect(r.scanned).toBe(3);
    expect(r.enqueued).toBe(0);
    expect(r.skipped).toBe(3);
    expect(r.skipped_reasons).toMatchObject({
      missing_service_id: 1,
      missing_staff_user_id: 1,
      missing_owner_identity: 1,
    });
    expect(state.logs).toHaveLength(0);
    expect(state.saveCount).toBe(0);
  });
});
