import { describe, expect, it } from 'vitest';
import { defaultNameForAsset } from '../src/renderer/components/billiard/utils';

const POOL_TABLE = { key: 'pool-table-green', category: 'billiard', name: 'Pool Table (Green)' };
const MASSAGE_BED = { key: 'massage-bed', category: 'massage', name: 'Massage Bed' };

const CLUB_NAMES = [
  'Bàn #1', 'Bàn #2', 'Bàn #3', 'Bàn #4', 'Bàn #5', 'Bàn #6', 'Bàn #7',
  'Bàn #8', 'Bàn #9', 'Bàn #10', 'Bàn #11', 'Bàn #12', 'Bàn #13', 'Bàn #14',
];

describe('defaultNameForAsset — the name a freshly picked asset suggests', () => {
  it('a billiard asset continues the dominant table family', () => {
    expect(defaultNameForAsset(POOL_TABLE, CLUB_NAMES)).toBe('Bàn #15');
  });

  it('a non-billiard asset starts its own family instead of hijacking the tables', () => {
    expect(defaultNameForAsset(MASSAGE_BED, CLUB_NAMES)).toBe('Massage Bed 1');
  });

  it('a non-billiard asset continues its own existing family', () => {
    const names = [...CLUB_NAMES, 'Massage Bed 1', 'Massage Bed 3'];
    expect(defaultNameForAsset(MASSAGE_BED, names)).toBe('Massage Bed 4');
  });

  it('no asset yet falls back to the dominant family', () => {
    expect(defaultNameForAsset(undefined, CLUB_NAMES)).toBe('Bàn #15');
  });
});
