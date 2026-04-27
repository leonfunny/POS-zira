import { describe, expect, it } from 'vitest';

import { BooksySyncStatus } from '../src/shared/types';
import { deriveBooksyPushWarning } from '../src/renderer/components/booksyPushWarning';

function baseStatus(overrides: Partial<BooksySyncStatus> = {}): BooksySyncStatus {
  return {
    enabled: true,
    running: false,
    hasToken: true,
    sessionExpired: false,
    lastSyncTime: null,
    lastSyncReport: null,
    isBusinessHours: true,
    nextSyncIn: null,
    chromeConnected: true,
    customerCount: 0,
    lastCustomerSyncReport: null,
    staffCount: 0,
    lastStaffSyncReport: null,
    resourceCount: 0,
    lastResourceSyncReport: null,
    serviceCount: 0,
    lastServiceSyncReport: null,
    addonCount: 0,
    lastAddonSyncReport: null,
    ...overrides,
  };
}

describe('deriveBooksyPushWarning', () => {
  it('returns null for null status', () => {
    expect(deriveBooksyPushWarning(null)).toBeNull();
  });

  it('returns null for no reports', () => {
    expect(deriveBooksyPushWarning(baseStatus())).toBeNull();
  });

  it('returns null for a report with no push attempt reason', () => {
    expect(deriveBooksyPushWarning(baseStatus({
      lastStaffSyncReport: {
        time: '2026-04-27T10:00:00.000Z',
        totalFetched: 2,
        pushed: false,
      },
    }))).toBeNull();
  });

  it('returns null for not-configured', () => {
    expect(deriveBooksyPushWarning(baseStatus({
      lastStaffSyncReport: {
        time: '2026-04-27T10:00:00.000Z',
        totalFetched: 2,
        pushed: false,
        pushReason: 'not-configured',
      },
    }))).toBeNull();
  });

  it('returns null for jwt-expired', () => {
    expect(deriveBooksyPushWarning(baseStatus({
      lastStaffSyncReport: {
        time: '2026-04-27T10:00:00.000Z',
        totalFetched: 2,
        pushed: false,
        pushReason: 'jwt-expired',
      },
    }))).toBeNull();
  });

  it('returns warning for network-error', () => {
    expect(deriveBooksyPushWarning(baseStatus({
      lastCustomerSyncReport: {
        time: '2026-04-27T10:00:00.000Z',
        totalFetched: 5,
        newCustomers: 1,
        pushed: false,
        pushReason: 'network-error',
      },
    }))).toEqual({
      entity: 'Customers',
      reason: 'network-error',
      partial: false,
      errors: 0,
    });
  });

  it('returns warning for timeout', () => {
    expect(deriveBooksyPushWarning(baseStatus({
      lastResourceSyncReport: {
        time: '2026-04-27T10:00:00.000Z',
        totalFetched: 2,
        pushed: false,
        pushReason: 'timeout',
      },
    }))).toEqual({
      entity: 'Resources',
      reason: 'timeout',
      partial: false,
      errors: 0,
    });
  });

  it('returns warning for non-2xx', () => {
    expect(deriveBooksyPushWarning(baseStatus({
      lastServiceSyncReport: {
        time: '2026-04-27T10:00:00.000Z',
        categoriesFetched: 2,
        servicesFetched: 8,
        pushed: false,
        pushReason: 'non-2xx',
      },
    }))).toEqual({
      entity: 'Services',
      reason: 'non-2xx',
      partial: false,
      errors: 0,
    });
  });

  it('returns partial warning for pushed reports with row errors', () => {
    expect(deriveBooksyPushWarning(baseStatus({
      lastAddonSyncReport: {
        time: '2026-04-27T10:00:00.000Z',
        totalFetched: 3,
        pushed: true,
        pushErrors: 2,
      },
    }))).toEqual({
      entity: 'Addons',
      reason: undefined,
      partial: true,
      errors: 2,
    });
  });

  it('chooses the newest report by time when multiple reports have failures', () => {
    expect(deriveBooksyPushWarning(baseStatus({
      lastStaffSyncReport: {
        time: '2026-04-27T09:00:00.000Z',
        totalFetched: 2,
        pushed: false,
        pushReason: 'network-error',
      },
      lastSyncReport: {
        date: '2026-04-27',
        bookings: 4,
        pushed: false,
        time: '2026-04-27T11:00:00.000Z',
        pushReason: 'non-2xx',
      },
    }))).toEqual({
      entity: 'Calendar',
      reason: 'non-2xx',
      partial: false,
      errors: 0,
    });
  });
});
