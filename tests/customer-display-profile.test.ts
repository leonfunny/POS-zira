import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_DISPLAY_LIVE_PROFILES,
  CUSTOMER_DISPLAY_RESERVED_PROFILES,
  isLiveCustomerDisplayProfile,
  resolveCustomerDisplayProfile,
} from '../src/shared/customer-display-profile';

describe('customer display profile contract', () => {
  it('keeps live profiles separate from reserved profiles', () => {
    expect(CUSTOMER_DISPLAY_LIVE_PROFILES).toEqual([
      'retail_assisted',
      'salon_checkin',
      'promo_only',
    ]);
    expect(CUSTOMER_DISPLAY_RESERVED_PROFILES).toEqual([
      'retail_self_checkout',
      'restaurant_table_display',
    ]);
  });

  it('accepts only live profiles for first-slice routing', () => {
    expect(isLiveCustomerDisplayProfile('retail_assisted')).toBe(true);
    expect(isLiveCustomerDisplayProfile('salon_checkin')).toBe(true);
    expect(isLiveCustomerDisplayProfile('promo_only')).toBe(true);
    expect(isLiveCustomerDisplayProfile('retail_self_checkout')).toBe(false);
    expect(isLiveCustomerDisplayProfile('restaurant_table_display')).toBe(false);
    expect(isLiveCustomerDisplayProfile('unknown')).toBe(false);
  });

  it('uses an explicit live profile over posMode defaults', () => {
    expect(resolveCustomerDisplayProfile({
      customerDisplayProfile: 'promo_only',
      posMode: 'salon',
    })).toBe('promo_only');
  });

  it('maps missing or reserved profile values from posMode', () => {
    expect(resolveCustomerDisplayProfile({ posMode: 'salon' })).toBe('salon_checkin');
    expect(resolveCustomerDisplayProfile({ posMode: 'retail' })).toBe('retail_assisted');
    expect(resolveCustomerDisplayProfile({ posMode: 'b2b' })).toBe('retail_assisted');
    expect(resolveCustomerDisplayProfile({ posMode: 'restaurant' })).toBe('retail_assisted');
    expect(resolveCustomerDisplayProfile({
      customerDisplayProfile: 'retail_self_checkout',
      posMode: 'retail',
    })).toBe('retail_assisted');
  });
});
