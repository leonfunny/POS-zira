import type { AgentConfig } from '../../../shared/types';

export type SelfCheckoutMode = 'demo' | 'production';
export type SelfCheckoutPaymentProfile =
  | 'assistedDemo'
  | 'terminalProduction'
  | 'unavailable';

export interface SelfCheckoutRuntime {
  mode: SelfCheckoutMode;
  paymentProfile: SelfCheckoutPaymentProfile;
  unavailableReasons: string[];
}

export const SELF_CHECKOUT_PRODUCTION_BLOCKERS: string[] = [
  'no_terminal',
  'no_fiscal_printer',
  'order_creation_unverified',
];

export function resolveSelfCheckoutMode(value: unknown): SelfCheckoutMode {
  return value === 'production' ? 'production' : 'demo';
}

export function resolveSelfCheckoutPaymentProfile(
  mode: SelfCheckoutMode,
  unavailableReasons: string[],
): SelfCheckoutPaymentProfile {
  if (unavailableReasons.length > 0) return 'unavailable';
  return mode === 'production' ? 'terminalProduction' : 'assistedDemo';
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
