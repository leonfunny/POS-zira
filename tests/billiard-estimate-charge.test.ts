import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateCharge } from '../src/renderer/components/billiard/utils';

const MIN_MS = 60_000;

/** Hourly session at 60 zł/h → 1 zł per billable minute, easy to assert. */
function hourlySession(overrides: Record<string, unknown>): any {
  return { billingMode: 'PER_HOUR', hourlyRate: 60, totalPausedSeconds: 0, ...overrides };
}

describe('estimateCharge — a paused table stops the meter (parity with the elapsed clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('freezes the charge from pausedAt while the session is PAUSED', () => {
    // Started 60 min ago, paused 20 min ago, nothing banked yet:
    // only the 40 played minutes are billable.
    const session = hourlySession({
      status: 'PAUSED',
      startedAt: new Date(Date.now() - 60 * MIN_MS).toISOString(),
      pausedAt: new Date(Date.now() - 20 * MIN_MS).toISOString(),
    });
    expect(estimateCharge(session)).toBeCloseTo(40, 2);
  });

  it('shows the SAME amount paused as after the resume banks the interval', () => {
    const paused = hourlySession({
      status: 'PAUSED',
      startedAt: new Date(Date.now() - 60 * MIN_MS).toISOString(),
      pausedAt: new Date(Date.now() - 20 * MIN_MS).toISOString(),
    });
    const resumed = hourlySession({
      status: 'ACTIVE',
      startedAt: new Date(Date.now() - 60 * MIN_MS).toISOString(),
      totalPausedSeconds: 20 * 60,
    });
    expect(estimateCharge(paused)).toBeCloseTo(estimateCharge(resumed), 2);
  });

  it('adds the live pause on top of already-banked pause time', () => {
    // 90 min on the clock, 10 min banked from an earlier pause, paused again
    // 10 min ago → 70 billable minutes.
    const session = hourlySession({
      status: 'PAUSED',
      startedAt: new Date(Date.now() - 90 * MIN_MS).toISOString(),
      pausedAt: new Date(Date.now() - 10 * MIN_MS).toISOString(),
      totalPausedSeconds: 10 * 60,
    });
    expect(estimateCharge(session)).toBeCloseTo(70, 2);
  });

  it('PER_HOUR_ROUNDED ceils the billable time, not the wall clock', () => {
    // 70 wall minutes but 50 billable → 1 started hour, not 2.
    const session = hourlySession({
      billingMode: 'PER_HOUR_ROUNDED',
      status: 'PAUSED',
      startedAt: new Date(Date.now() - 70 * MIN_MS).toISOString(),
      pausedAt: new Date(Date.now() - 20 * MIN_MS).toISOString(),
    });
    expect(estimateCharge(session)).toBe(60);
  });

  it('an ACTIVE session still accrues on the wall clock (regression)', () => {
    const session = hourlySession({
      status: 'ACTIVE',
      startedAt: new Date(Date.now() - 60 * MIN_MS).toISOString(),
    });
    expect(estimateCharge(session)).toBeCloseTo(60, 2);
  });

  it('PACKAGE_COUNTDOWN still returns the fixed package price (regression)', () => {
    const session = {
      billingMode: 'PACKAGE_COUNTDOWN',
      packagePrice: 100,
      status: 'PAUSED',
      startedAt: new Date(Date.now() - 60 * MIN_MS).toISOString(),
      pausedAt: new Date(Date.now() - 20 * MIN_MS).toISOString(),
    };
    expect(estimateCharge(session)).toBe(100);
  });
});
