import type {
  AgentConfig,
  CustomerDisplayProfile,
  LiveCustomerDisplayProfile,
  ReservedCustomerDisplayProfile,
} from './types';

export const CUSTOMER_DISPLAY_LIVE_PROFILES: LiveCustomerDisplayProfile[] = [
  'retail_assisted',
  'salon_checkin',
  'promo_only',
];

export const CUSTOMER_DISPLAY_RESERVED_PROFILES: ReservedCustomerDisplayProfile[] = [
  'retail_self_checkout',
  'restaurant_table_display',
];

export function isCustomerDisplayProfile(value?: string): value is CustomerDisplayProfile {
  return [
    ...CUSTOMER_DISPLAY_LIVE_PROFILES,
    ...CUSTOMER_DISPLAY_RESERVED_PROFILES,
  ].includes(value as CustomerDisplayProfile);
}

export function isLiveCustomerDisplayProfile(value?: string): value is LiveCustomerDisplayProfile {
  return CUSTOMER_DISPLAY_LIVE_PROFILES.includes(value as LiveCustomerDisplayProfile);
}

export function resolveCustomerDisplayProfile(
  config?: Pick<AgentConfig, 'customerDisplayProfile' | 'posMode'> | null,
): LiveCustomerDisplayProfile {
  if (isLiveCustomerDisplayProfile(config?.customerDisplayProfile)) {
    return config.customerDisplayProfile;
  }

  if (config?.posMode === 'salon') return 'salon_checkin';
  return 'retail_assisted';
}
