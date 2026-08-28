import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_FLOOR_SURFACE_THEME,
  FLOOR_SURFACE_THEME_STYLES,
  resolveFloorSurfaceTheme,
  STATUS_THEME,
} from '../src/renderer/components/billiard/constants';

const readSource = (relativePath: string): string =>
  readFileSync(join(__dirname, relativePath), 'utf8');

describe('billiard floor surface theme', () => {
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

  it('defaults to the dark room while preserving the explicit light choice', () => {
    expect(DEFAULT_FLOOR_SURFACE_THEME).toBe('dark');
    expect(resolveFloorSurfaceTheme(null)).toBe('dark');
    expect(resolveFloorSurfaceTheme('invalid')).toBe('dark');
    expect(resolveFloorSurfaceTheme('dark')).toBe('dark');
    expect(resolveFloorSurfaceTheme('light')).toBe('light');

    expect(FLOOR_SURFACE_THEME_STYLES.dark.backgroundImage).toContain('#1c3330');
    expect(FLOOR_SURFACE_THEME_STYLES.dark.ringOffsetColor).toBe('#152622');
    expect(FLOOR_SURFACE_THEME_STYLES.light.backgroundColor).toBe('#f4f2ed');
    expect(FLOOR_SURFACE_THEME_STYLES.dark.backgroundImage)
      .not.toBe(FLOOR_SURFACE_THEME_STYLES.light.backgroundImage);
  });

  it('themes only the floor canvas, hides the toggle for custom backgrounds, and keeps adaptive ring offsets', () => {
    const floor = readSource('../src/renderer/components/billiard/BilliardFloorPlan.tsx');
    expect(floor).toContain("!editMode && !floorBackgroundUrl");
    expect(floor).toContain('<FloorSurfaceThemeToggle');
    expect(floor).toContain('FLOOR_SURFACE_THEME_STYLES[floorSurfaceTheme]');
    expect(floor).toContain("'--floor-surface-ring'");
    // The page shell keeps its neutral padding and carries no hardcoded dark
    // background, so the theme comes from the floor canvas alone. Matched on
    // the padding utilities rather than the whole class string: the shell has
    // since moved from `space-y-4` to a flex column with `gap-4`, which is the
    // same intent expressed differently.
    expect(floor).toMatch(/<div className="[^"]*\bp-4\b[^"]*\bsm:p-6\b[^"]*">/);
    expect(floor).not.toContain('bg-slate-900');

    const table = readSource('../src/renderer/components/billiard/DraggableTable.tsx');
    expect(table).toContain('ring-offset-[var(--floor-surface-ring)]');
  });

  it('uses at least 44px targets for the new floor controls', () => {
    const themeToggle = readSource('../src/renderer/components/billiard/FloorSurfaceThemeToggle.tsx');
    const floor = readSource('../src/renderer/components/billiard/BilliardFloorPlan.tsx');

    expect(themeToggle.match(/h-11 w-11/g)?.length).toBe(2);
    expect(floor).toContain('className="flex h-11 w-11');
  });
});
