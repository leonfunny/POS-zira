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

export const STATUS_STYLES: Record<TableStatus, { bg: string; border: string; felt: string; glow: string }> = {
  free:     { bg: 'bg-emerald-900/80', border: 'border-emerald-500', felt: 'bg-emerald-700', glow: '' },
  occupied: { bg: 'bg-red-900/80',     border: 'border-red-400',     felt: 'bg-red-800',     glow: 'shadow-red-500/30 shadow-lg' },
  paused:   { bg: 'bg-amber-900/80',   border: 'border-amber-400',   felt: 'bg-amber-800',   glow: 'shadow-amber-500/20 shadow-md' },
};
