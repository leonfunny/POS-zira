import { describe, it, expect } from 'vitest';
import { parseRangeHeader } from '../../src/main/ad-display/http-range';

describe('parseRangeHeader', () => {
  const size = 1000;
  it('returns null when no range header', () => {
    expect(parseRangeHeader(undefined, size)).toBeNull();
    expect(parseRangeHeader('', size)).toBeNull();
  });
  it('parses bytes=0-499', () => {
    expect(parseRangeHeader('bytes=0-499', size)).toEqual({ start: 0, end: 499 });
  });
  it('open-ended bytes=500- goes to last byte', () => {
    expect(parseRangeHeader('bytes=500-', size)).toEqual({ start: 500, end: 999 });
  });
  it('suffix bytes=-200 returns last 200 bytes', () => {
    expect(parseRangeHeader('bytes=-200', size)).toEqual({ start: 800, end: 999 });
  });
  it('returns "unsatisfiable" when start >= size', () => {
    expect(parseRangeHeader('bytes=2000-3000', size)).toBe('unsatisfiable');
  });
  it('clamps end to size-1', () => {
    expect(parseRangeHeader('bytes=0-99999', size)).toEqual({ start: 0, end: 999 });
  });
});
