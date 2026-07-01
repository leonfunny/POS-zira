import { describe, expect, it } from 'vitest';
import { computeIdlePhase } from '../src/renderer/hooks/useKioskIdleReset';

const LAST_ACTIVITY = 1_000_000;
const WARN_AFTER_MS = 60_000;
const RESET_AFTER_MS = 75_000;

describe('kiosk idle reset phase helper', () => {
  it('stays active before the warning threshold', () => {
    expect(computeIdlePhase(
      LAST_ACTIVITY,
      LAST_ACTIVITY + WARN_AFTER_MS - 1,
      WARN_AFTER_MS,
      RESET_AFTER_MS,
    )).toBe('active');
  });

  it('enters warning at the threshold with the full countdown window', () => {
    expect(computeIdlePhase(
      LAST_ACTIVITY,
      LAST_ACTIVITY + WARN_AFTER_MS,
      WARN_AFTER_MS,
      RESET_AFTER_MS,
    )).toEqual({ phase: 'warning', secondsLeft: 15 });
  });

  it('rounds the warning countdown up to whole seconds', () => {
    expect(computeIdlePhase(
      LAST_ACTIVITY,
      LAST_ACTIVITY + WARN_AFTER_MS + 1,
      WARN_AFTER_MS,
      RESET_AFTER_MS,
    )).toEqual({ phase: 'warning', secondsLeft: 15 });

    expect(computeIdlePhase(
      LAST_ACTIVITY,
      LAST_ACTIVITY + RESET_AFTER_MS - 1,
      WARN_AFTER_MS,
      RESET_AFTER_MS,
    )).toEqual({ phase: 'warning', secondsLeft: 1 });
  });

  it('expires at and after the reset threshold', () => {
    expect(computeIdlePhase(
      LAST_ACTIVITY,
      LAST_ACTIVITY + RESET_AFTER_MS,
      WARN_AFTER_MS,
      RESET_AFTER_MS,
    )).toBe('expired');

    expect(computeIdlePhase(
      LAST_ACTIVITY,
      LAST_ACTIVITY + RESET_AFTER_MS + 20_000,
      WARN_AFTER_MS,
      RESET_AFTER_MS,
    )).toBe('expired');
  });

  it('handles boundary values without producing negative idle time', () => {
    expect(computeIdlePhase(
      LAST_ACTIVITY,
      LAST_ACTIVITY - 1_000,
      WARN_AFTER_MS,
      RESET_AFTER_MS,
    )).toBe('active');

    expect(computeIdlePhase(
      LAST_ACTIVITY,
      LAST_ACTIVITY,
      0,
      1_000,
    )).toEqual({ phase: 'warning', secondsLeft: 1 });

    expect(computeIdlePhase(
      LAST_ACTIVITY,
      LAST_ACTIVITY,
      0,
      0,
    )).toBe('expired');
  });
});
