import { describe, expect, it } from 'vitest';
import { shouldCloseActiveShiftSession } from '../src/shared/shift-close';

describe('shouldCloseActiveShiftSession', () => {
  it('clears the session only for the shift owned by the completed close flow', () => {
    expect(shouldCloseActiveShiftSession('shift-old', ['shift-old'])).toBe(true);
    expect(shouldCloseActiveShiftSession('shift-new', ['shift-old'])).toBe(false);
  });

  it('protects a newer shift from a delayed end-of-day close', () => {
    expect(shouldCloseActiveShiftSession('shift-new', ['shift-yesterday-1', 'shift-yesterday-2'])).toBe(false);
    expect(shouldCloseActiveShiftSession('shift-yesterday-2', ['shift-yesterday-1', 'shift-yesterday-2'])).toBe(true);
  });

  it('never closes an empty session identity', () => {
    expect(shouldCloseActiveShiftSession(null, ['shift-old'])).toBe(false);
    expect(shouldCloseActiveShiftSession('', ['shift-old'])).toBe(false);
  });
});
