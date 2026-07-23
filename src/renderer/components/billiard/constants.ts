import type { TableStatus } from './types';

export const DEFAULT_FLOOR = 1;
export const SNAP_STEP_M = 0.1; // meters per snap step

// Table dimensions — stored as percentage of room (width_pct, height_pct)
// Standard pool table ~2.5m x 1.3m in 16m x 10m room → 15.5% x 13%
export const DEFAULT_TABLE_WIDTH_PCT = 15.5;
export const DEFAULT_TABLE_HEIGHT_PCT = 13.0;
export const MIN_TABLE_PCT = 3;   // ~0.5m in 16m room
export const MAX_TABLE_PCT = 60;  // ~10m in 16m room
export const SIZE_STEP_M = 0.2;   // meters per click

export const ROTATION_STEPS = [0, 90, 180, 270] as const;

export type FloorSurfaceTheme = 'dark' | 'light';

export const DEFAULT_FLOOR_SURFACE_THEME: FloorSurfaceTheme = 'dark';
export const FLOOR_SURFACE_THEME_STORAGE_KEY = 'billiard-floor-surface-theme-v1';

// Only the billiard canvas changes appearance. The surrounding POS chrome
// remains light and operational in both modes.
export const FLOOR_SURFACE_THEME_STYLES: Record<FloorSurfaceTheme, {
  backgroundColor: string;
  backgroundImage: string;
  backgroundSize: string;
  ringOffsetColor: string;
}> = {
  dark: {
    backgroundColor: '#152622',
    backgroundImage: [
      'radial-gradient(circle, rgba(180,220,200,0.08) 1px, transparent 1px)',
      'radial-gradient(ellipse at 50% 40%, rgba(140,200,175,0.07), transparent 55%)',
      'radial-gradient(circle at 22% 28%, rgba(255,210,140,0.025), transparent 32%)',
      'radial-gradient(circle at 78% 72%, rgba(255,210,140,0.025), transparent 32%)',
      'linear-gradient(155deg, #1c3330 0%, #152622 45%, #1a302c 100%)',
    ].join(', '),
    backgroundSize: '28px 28px, 100% 100%, 100% 100%, 100% 100%, 100% 100%',
    ringOffsetColor: '#152622',
  },
  light: {
    backgroundColor: '#f4f2ed',
    backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.05) 1px, transparent 1px)',
    backgroundSize: '28px 28px',
    ringOffsetColor: '#f4f2ed',
  },
};

export function resolveFloorSurfaceTheme(value: unknown): FloorSurfaceTheme {
  return value === 'light' ? 'light' : DEFAULT_FLOOR_SURFACE_THEME;
}

export const STATUS_THEME: Record<TableStatus, { ring: string; pill: string }> = {
  // A free table stays calm: bare felt, no ring, no pill.
  free:     { ring: '', pill: '' },
  occupied: { ring: 'ring-2 ring-red-500 ring-offset-2 ring-offset-[var(--floor-surface-ring)]', pill: 'bg-red-600 text-white' },
  paused:   { ring: 'ring-2 ring-amber-400 ring-offset-2 ring-offset-[var(--floor-surface-ring)]', pill: 'bg-amber-500 text-white' },
};
