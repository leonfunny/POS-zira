import { describe, expect, it } from 'vitest';
import { ulid } from '../src/main/utils/ulid';

const BASE32 = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('ulid', () => {
  it('produces 26-char Crockford base32 ids', () => {
    for (let i = 0; i < 50; i++) {
      expect(ulid()).toMatch(BASE32);
    }
  });

  it('is monotonic within the same millisecond', () => {
    const t = 1_700_000_000_000;
    const a = ulid(t);
    const b = ulid(t);
    const c = ulid(t);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it('sorts lexicographically by time', () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_001_000);
    expect(earlier < later).toBe(true);
  });

  it('does not collide across many rapid calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(ulid());
    expect(seen.size).toBe(5000);
  });
});
