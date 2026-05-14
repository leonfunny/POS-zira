import type { AgentConfig } from '../../../shared/types';

export type SelfCheckoutMode = 'demo' | 'production';

export interface SelfCheckoutRuntime {
  mode: SelfCheckoutMode;
  unavailableReasons: string[];
}

export const SELF_CHECKOUT_PRODUCTION_BLOCKERS: string[] = [];

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
