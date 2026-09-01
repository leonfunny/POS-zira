import { describe, expect, it } from 'vitest';

import { totalTagsToPrint } from '../src/renderer/components/label/fabric-tag-size';

describe('counting a print run', () => {
  it('adds up the per-size quantities', () => {
    expect(totalTagsToPrint({ s: 20, m: 30, l: 15 })).toBe(65);
  });

  it('ignores blanks and nonsense instead of printing them', () => {
    expect(totalTagsToPrint({ s: 5, m: 0, l: -3, xl: NaN as unknown as number })).toBe(5);
  });
});
