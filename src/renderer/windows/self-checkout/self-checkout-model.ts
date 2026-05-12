import type { AgentConfig } from '../../../shared/types';

export type SelfCheckoutMode = 'demo' | 'production';

export interface SelfCheckoutRuntime {
  mode: SelfCheckoutMode;
  unavailableReasons: string[];
}

export const SELF_CHECKOUT_PRODUCTION_BLOCKERS = [
  'Payment terminal SDK is not integrated.',
  'Fiscal printer flow is not wired to self-checkout.',
  'Real order creation for kiosk sales is not wired.',
];

export function resolveSelfCheckoutMode(value: unknown): SelfCheckoutMode {
  return value === 'production' ? 'production' : 'demo';
}

export function resolveSelfCheckoutRuntime(
  config?: Pick<AgentConfig, 'selfCheckoutMode'> | null,
): SelfCheckoutRuntime {
  const mode = resolveSelfCheckoutMode(config?.selfCheckoutMode);
  return {
    mode,
    unavailableReasons: mode === 'production'
      ? [...SELF_CHECKOUT_PRODUCTION_BLOCKERS]
      : [],
  };
}
