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

export function normalizeNip(value: string): string {
  return value.replace(/\D/g, '');
}

export function isValidPolishNip(value: string): boolean {
  const digits = normalizeNip(value);
  if (!/^\d{10}$/.test(digits)) return false;

  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = weights.reduce(
    (acc, weight, index) => acc + weight * Number(digits[index]),
    0,
  );
  return sum % 11 === Number(digits[9]);
}
