import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { STATUS_THEME } from '../src/renderer/components/billiard/constants';

const readSource = (relativePath: string): string =>
  readFileSync(join(__dirname, relativePath), 'utf8');

describe('billiard light & clean theme (P3)', () => {
  it('one STATUS_THEME drives every table render path — ring + pill, no per-file palettes', () => {
    expect(Object.keys(STATUS_THEME).sort()).toEqual(['free', 'occupied', 'paused']);
    // Free tables stay calm: no ring, no pill.
    expect(STATUS_THEME.free.ring).toBe('');
    expect(STATUS_THEME.free.pill).toBe('');
    for (const status of ['occupied', 'paused'] as const) {
      expect(STATUS_THEME[status].ring).toContain('ring-2');
      expect(STATUS_THEME[status].pill).not.toBe('');
    }

    const table = readSource('../src/renderer/components/billiard/DraggableTable.tsx');
    expect(table).toContain('STATUS_THEME');
    expect(table).not.toContain('TABLE_COLORS');
    expect(table).not.toContain('STATUS_STYLES');
  });

  it('the floor is a light operational room, not the dark felt surface', () => {
    const floor = readSource('../src/renderer/components/billiard/BilliardFloorPlan.tsx');
    expect(floor).not.toContain('#17312b');
    expect(floor).not.toContain('bg-slate-900');

    const table = readSource('../src/renderer/components/billiard/DraggableTable.tsx');
    expect(table).not.toContain('#17312b');
  });
});
