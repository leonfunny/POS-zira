import { describe, expect, it } from 'vitest';
import { getNextName } from '../src/renderer/components/billiard/utils';

describe('getNextName — default seeding for a new floor object', () => {
  it('seeds from the DOMINANT numbered family, not from whatever name was added last', () => {
    // The real Klub Bilardowy bug: one stray "Ghế massage #1" added last made
    // every new table default to "Ghế massage #2".
    const names = ['Bàn #1', 'Bàn #2', 'Bàn #3', 'Ghế massage #1'];
    expect(getNextName('', names)).toBe('Bàn #4');
  });

  it('continues past the highest number in the family, skipping taken names', () => {
    expect(getNextName('', ['Bàn #1', 'Bàn #3', 'Bàn #7', 'Ghế massage #1'])).toBe('Bàn #8');
  });

  it('keeps the old behavior when there is no competing family', () => {
    expect(getNextName('', ['Stół 1'])).toBe('Stół 2');
    expect(getNextName('', [])).toBe('Table 1');
  });

  it('leaves arrow stepping on a typed value unchanged', () => {
    const names = ['Bàn #1', 'Bàn #2', 'Bàn #3'];
    expect(getNextName('Bàn #10', names, 'up')).toBe('Bàn #11');
    expect(getNextName('Bàn #10', names, 'down')).toBe('Bàn #9');
  });
});
