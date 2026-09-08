import { describe, expect, it } from 'vitest';
import { canChangeRestaurantContext, isPosMode, resolveSalonPosMode } from '../src/shared/pos-mode';

describe('Salon mode resolution', () => {
  it.each(['salon', 'restaurant', 'retail', 'b2b'] as const)('uses %s on a clean first login', (mode) => {
    expect(resolveSalonPosMode({ posMode: 'retail' }, 'new', mode)).toMatchObject({ posMode: mode, posModesBySalon: { new: mode } });
  });
  it('migrates the legacy choice only to its original salon', () => {
    expect(resolveSalonPosMode({ salonId: 'old', posMode: 'salon' }, 'new', 'restaurant')).toMatchObject({
      posMode: 'restaurant', posModesBySalon: { old: 'salon', new: 'restaurant' },
    });
  });
  it('does not promote a temporary fallback to a saved preference', () => {
    const fallback = resolveSalonPosMode({ salonId: 'old', posMode: 'salon' }, 'new', null);
    const retried = resolveSalonPosMode({ ...fallback, salonId: 'new' }, 'new', 'restaurant');
    expect(retried.posMode).toBe('restaurant');
  });
  it('does not inherit a previous salon mode when the suggestion is invalid', () => {
    expect(resolveSalonPosMode({ salonId: 'old', posMode: 'salon' }, 'new', 'billiard').posMode).toBe('retail');
    expect(isPosMode({ toString: () => 'retail' })).toBe(false);
  });
});

describe('Restaurant context guard', () => {
  const state = { cart: { items: [{}] }, checkoutDraft: {}, activeTable: 'A' };
  it('permits reselecting the same context but not moving a populated cart', () => {
    expect(canChangeRestaurantContext(state, 'A', 'dine_in')).toBe(true);
    expect(canChangeRestaurantContext(state, 'B', 'dine_in')).toBe(false);
    expect(canChangeRestaurantContext(state, null, 'takeout')).toBe(false);
  });
  it('permits switching when there is no sale to move', () => {
    expect(canChangeRestaurantContext({ ...state, cart: { items: [] } }, 'B', 'dine_in')).toBe(true);
  });
});
