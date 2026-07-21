import { describe, expect, it } from 'vitest';
import { normalizeOpenShiftResponse } from '../src/main/network/api-client';

describe('POS shift API response contract', () => {
  it('normalizes the backend PosShift entity id', () => {
    expect(normalizeOpenShiftResponse({ id: 'shift-local-1' })).toEqual({
      shiftId: 'shift-local-1',
    });
  });

  it('keeps the legacy shiftId alias compatible', () => {
    expect(normalizeOpenShiftResponse({ shiftId: 'shift-legacy-1' })).toEqual({
      shiftId: 'shift-legacy-1',
    });
  });

  it('rejects a successful response without an id', () => {
    expect(() => normalizeOpenShiftResponse({ status: 'OPEN' })).toThrow(
      'Invalid open shift response: missing shift id',
    );
  });
});
