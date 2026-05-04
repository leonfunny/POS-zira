import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BooksySync } from '../src/main/booksy/booksy-sync';

/**
 * Calendar auto-sync cadence — narrow surface around
 * `calculateNextInterval()` and `scheduleNext()`.
 *
 * The full sync orchestration involves Chrome CDP, fetch, and IPC; we
 * stub all of it. These tests pin the scheduling contract:
 *   - healthy cadence around 60s ± 10s
 *   - hard floor at 30s
 *   - exponential backoff up to 600s on failure
 *   - successful sync resets the streak
 *   - `syncNow` does not break the loop
 *   - in-flight sync skips the tick rather than starting a second one
 *
 * Anything beyond the scheduler (token capture, push transport, etc.)
 * is intentionally out of scope.
 */

const baseConfig = {
  enabled: true,
  businessId: '282140',
  cdpPort: 9222,
  enailApiUrl: 'https://example.invalid/api/v1',
  enailJwt: '',
  syncIntervalMin: 30,
  workStartHour: 0,
  workStartMin: 0,
  workEndHour: 23,
  workEndMin: 59,
  workDays: [0, 1, 2, 3, 4, 5, 6],
} as any;

function makeService() {
  const svc = new BooksySync(baseConfig);
  // Calling private API by design — the scheduler is the contract,
  // not the public surface.
  return svc as any;
}

describe('BooksySync.calculateNextInterval', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // → jitter = 0
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns the 60s base interval after a successful sync (jitter neutralised)', () => {
    const svc = makeService();
    svc.lastSyncSucceeded = true;
    svc.syncFailureStreak = 0;
    expect(svc.calculateNextInterval()).toBe(60_000);
  });

  it('keeps the success interval inside [50s, 70s] across the jitter range', () => {
    const svc = makeService();
    svc.lastSyncSucceeded = true;
    svc.syncFailureStreak = 0;
    // Sweep the random source across the full range [0, 1).
    for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999]) {
      vi.spyOn(Math, 'random').mockReturnValueOnce(r);
      const ms = svc.calculateNextInterval();
      expect(ms).toBeGreaterThanOrEqual(50_000);
      expect(ms).toBeLessThanOrEqual(70_000);
    }
  });

  it('walks the backoff steps 60s → 120s → 240s → 480s → 600s', () => {
    const svc = makeService();
    svc.lastSyncSucceeded = false;
    const expected = [60_000, 120_000, 240_000, 480_000, 600_000];
    expected.forEach((want, idx) => {
      svc.syncFailureStreak = idx + 1;
      expect(svc.calculateNextInterval()).toBe(want);
    });
  });

  it('clamps the backoff at the 10-minute cap even with a runaway streak', () => {
    const svc = makeService();
    svc.lastSyncSucceeded = false;
    svc.syncFailureStreak = 99;
    expect(svc.calculateNextInterval()).toBe(600_000);
  });

  it('never returns less than the 30s floor', () => {
    // Internal constants are private; verify the floor through the
    // observable behaviour (jitter cannot pull the success interval
    // below 50s, so we drive failure path with a bogus streak that
    // would otherwise underflow).
    const svc = makeService();
    svc.lastSyncSucceeded = false;
    svc.syncFailureStreak = -10; // pathological — should still be safe
    expect(svc.calculateNextInterval()).toBeGreaterThanOrEqual(30_000);
  });
});

describe('BooksySync.scheduleNext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('updates nextSyncAt to base interval after success', () => {
    const svc = makeService();
    svc.started = true;
    svc.lastSyncSucceeded = true;
    svc.syncFailureStreak = 0;
    const before = Date.now();
    svc.scheduleNext();
    const expected = before + 60_000;
    expect(svc.nextSyncAt).toBeGreaterThanOrEqual(expected - 5);
    expect(svc.nextSyncAt).toBeLessThanOrEqual(expected + 5);
    if (svc.syncTimer) clearTimeout(svc.syncTimer);
  });

  it('skips the tick when a sync is already in flight (anti-overlap)', () => {
    const svc = makeService();
    svc.started = true;
    svc.lastSyncSucceeded = true;
    svc.isRunning = true; // simulate previous sync still running

    const syncOnce = vi.fn().mockResolvedValue(undefined);
    svc.syncOnce = syncOnce;

    svc.scheduleNext();
    // Advance past the first tick — the in-flight guard should skip
    // calling syncOnce and re-schedule the next tick instead.
    vi.advanceTimersByTime(70_000);
    expect(syncOnce).not.toHaveBeenCalled();
    expect(svc.overlappedTickCount).toBeGreaterThanOrEqual(1);
    if (svc.syncTimer) clearTimeout(svc.syncTimer);
  });

  it('does not schedule when stop() has been called (started=false)', () => {
    const svc = makeService();
    svc.started = false;
    svc.scheduleNext();
    expect(svc.syncTimer).toBeNull();
  });
});

describe('BooksySync.syncOnce — out of scope for auto loop', () => {
  // Belt-and-braces: the spec says full sync (customers/staff/services)
  // must NOT run every interval. Confirm by calling syncOnce on a
  // service where every full-sync method would throw if hit.
  it('does not invoke customer / staff / services / addons sync paths', async () => {
    const svc = makeService();
    svc.captureTokenFromChrome = vi.fn().mockRejectedValue(
      new Error('SESSION_EXPIRED'),
    );
    svc.syncCustomersOnce = vi.fn().mockRejectedValue(new Error('should not run'));
    svc.syncStaffOnce = vi.fn().mockRejectedValue(new Error('should not run'));
    svc.syncServicesOnce = vi.fn().mockRejectedValue(new Error('should not run'));
    svc.syncAddonsOnce = vi.fn().mockRejectedValue(new Error('should not run'));
    svc.syncResourcesOnce = vi.fn().mockRejectedValue(new Error('should not run'));
    svc.sendTelegramAlert = vi.fn();
    svc.emitStatus = vi.fn();

    await svc.syncOnce(true);

    expect(svc.syncCustomersOnce).not.toHaveBeenCalled();
    expect(svc.syncStaffOnce).not.toHaveBeenCalled();
    expect(svc.syncServicesOnce).not.toHaveBeenCalled();
    expect(svc.syncAddonsOnce).not.toHaveBeenCalled();
    expect(svc.syncResourcesOnce).not.toHaveBeenCalled();
  });
});
