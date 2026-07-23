export const FLOOR_VIEW_STORAGE_PREFIX = 'billiard-floor-view-v1';

export interface LockedFloorView {
  scale: number;
  positionX: number;
  positionY: number;
  locked: true;
}

function storageSegment(value: string | number | null | undefined, fallback: string): string {
  const normalized = String(value ?? '').trim();
  return encodeURIComponent(normalized || fallback);
}

export function buildFloorViewStorageKey(input: {
  salonId?: string | null;
  floorId?: string | null;
  floorNumber?: number | null;
}): string {
  const salonId = String(input.salonId ?? '').trim();
  const salonScope = salonId
    ? `salon-${storageSegment(salonId, 'unknown')}`
    : 'local';
  const floorScope = storageSegment(
    input.floorId,
    input.floorNumber == null ? 'default' : `number-${input.floorNumber}`,
  );

  return `${FLOOR_VIEW_STORAGE_PREFIX}:${salonScope}:floor-${floorScope}`;
}

export function parseLockedFloorView(value: unknown): LockedFloorView | null {
  if (!value || typeof value !== 'object') return null;

  const candidate = value as Record<string, unknown>;
  const scale = Number(candidate.scale);
  const positionX = Number(candidate.positionX);
  const positionY = Number(candidate.positionY);

  if (
    candidate.locked !== true
    || !Number.isFinite(scale)
    || scale < 0.5
    || scale > 3
    || !Number.isFinite(positionX)
    || !Number.isFinite(positionY)
  ) {
    return null;
  }

  return { scale, positionX, positionY, locked: true };
}

export function deserializeLockedFloorView(raw: string | null): LockedFloorView | null {
  if (!raw) return null;
  try {
    return parseLockedFloorView(JSON.parse(raw));
  } catch {
    return null;
  }
}
