import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildFloorViewStorageKey,
  deserializeLockedFloorView,
  parseLockedFloorView,
} from '../src/renderer/components/billiard/floor-view-preferences';

const readSource = (relativePath: string): string =>
  readFileSync(join(__dirname, relativePath), 'utf8');

describe('billiard locked floor view preferences', () => {
  it('scopes saved views by salon and floor when the salon identity is available', () => {
    const salonAFloor1 = buildFloorViewStorageKey({ salonId: 'salon-a', floorId: 'floor-1' });
    const salonAFloor2 = buildFloorViewStorageKey({ salonId: 'salon-a', floorId: 'floor-2' });
    const salonBFloor1 = buildFloorViewStorageKey({ salonId: 'salon-b', floorId: 'floor-1' });

    expect(salonAFloor1).not.toBe(salonAFloor2);
    expect(salonAFloor1).not.toBe(salonBFloor1);
    expect(salonAFloor1).toContain('salon-salon-a');
    expect(salonAFloor1).toContain('floor-floor-1');
  });

  it('falls back to a floor-only scope when no salon identity is available', () => {
    expect(buildFloorViewStorageKey({ floorId: 'floor-1' }))
      .toBe('billiard-floor-view-v1:local:floor-floor-1');
    expect(buildFloorViewStorageKey({ salonId: '   ', floorId: 'floor-1' }))
      .toBe('billiard-floor-view-v1:local:floor-floor-1');
    expect(buildFloorViewStorageKey({ floorNumber: 2 }))
      .toBe('billiard-floor-view-v1:local:floor-number-2');
  });

  it('accepts only finite, locked transforms within the supported scale range', () => {
    expect(parseLockedFloorView({
      scale: 1.5,
      positionX: -120,
      positionY: 42,
      locked: true,
    })).toEqual({
      scale: 1.5,
      positionX: -120,
      positionY: 42,
      locked: true,
    });

    expect(parseLockedFloorView({ scale: 1, positionX: 0, positionY: 0, locked: false })).toBeNull();
    expect(parseLockedFloorView({ scale: 4, positionX: 0, positionY: 0, locked: true })).toBeNull();
    expect(parseLockedFloorView({ scale: 1, positionX: Number.NaN, positionY: 0, locked: true })).toBeNull();
    expect(deserializeLockedFloorView('{broken')).toBeNull();
  });

  it('disables only transform gestures while locked, preserving table interactions', () => {
    const floor = readSource('../src/renderer/components/billiard/BilliardFloorPlan.tsx');

    expect(floor).toContain('wheel={{ step: 0.08, disabled: editMode || viewLocked }}');
    expect(floor).toContain('pinch={{ step: 5, disabled: editMode || viewLocked }}');
    expect(floor).toContain('disabled: editMode || viewLocked');
    expect(floor).not.toContain('disabled={editMode || viewLocked}');
    expect(floor).toContain('localStorage.removeItem(viewStorageKey)');
    expect(floor).toContain('setTransform(');
  });
});
