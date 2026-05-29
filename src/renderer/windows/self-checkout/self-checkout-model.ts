import type { AgentConfig } from '../../../shared/types';

export type SelfCheckoutMode = 'demo' | 'production';
export type SelfCheckoutProfile = 'retail_scan' | 'menu_kitchen';
export type SelfCheckoutPaymentProfile =
  | 'assistedDemo'
  | 'assistedProduction'
  | 'terminalProduction'
  | 'unavailable';

export interface SelfCheckoutRuntime {
  mode: SelfCheckoutMode;
  paymentProfile: SelfCheckoutPaymentProfile;
  unavailableReasons: string[];
}

export const SELF_CHECKOUT_PRODUCTION_BLOCKERS: string[] = [];

export function resolveSelfCheckoutMode(value: unknown): SelfCheckoutMode {
  return value === 'production' ? 'production' : 'demo';
}

export function resolveSelfCheckoutProfile(value: unknown): SelfCheckoutProfile {
  return value === 'menu_kitchen' ? 'menu_kitchen' : 'retail_scan';
}

export function resolveSelfCheckoutPaymentProfile(
  mode: SelfCheckoutMode,
  unavailableReasons: string[],
): SelfCheckoutPaymentProfile {
  if (unavailableReasons.length > 0) return 'unavailable';
  return mode === 'production' ? 'assistedProduction' : 'assistedDemo';
}

export function resolveSelfCheckoutRuntime(
  config?: Pick<AgentConfig, 'selfCheckoutMode'> | null,
): SelfCheckoutRuntime {
  const mode = resolveSelfCheckoutMode(config?.selfCheckoutMode);
  const unavailableReasons = mode === 'production'
    ? [...SELF_CHECKOUT_PRODUCTION_BLOCKERS]
    : [];
  return {
    mode,
    paymentProfile: resolveSelfCheckoutPaymentProfile(mode, unavailableReasons),
    unavailableReasons,
  };
}
