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

// P3 "Light & clean": the room is a light operational surface and every table
// looks like a real pool table; status is carried ONLY by a ring around the
// table plus a pill above it. This is the single status palette for every
// render path (CSS table and asset image alike) — do not add per-file colors.
export const ROOM_BG = '#f4f2ed';

export const STATUS_THEME: Record<TableStatus, { ring: string; pill: string }> = {
  // A free table stays calm: bare felt, no ring, no pill.
  free:     { ring: '', pill: '' },
  occupied: { ring: 'ring-2 ring-red-500 ring-offset-2 ring-offset-[#f4f2ed]', pill: 'bg-red-600 text-white' },
  paused:   { ring: 'ring-2 ring-amber-400 ring-offset-2 ring-offset-[#f4f2ed]', pill: 'bg-amber-500 text-white' },
};
