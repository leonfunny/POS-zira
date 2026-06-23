import type { AgentConfig } from '../../../shared/types';

export type SelfCheckoutMode = 'demo' | 'production';
export type SelfCheckoutProfile = 'retail_scan';
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

// While the payment overlay is open the customer is often NOT touching the
// kiosk (sending a BLIK transfer on their own phone, waiting for staff to
// bring change). The regular idle timeout would hard-reset the session and
// silently drop a sale the customer may have ALREADY paid for. Give payment
// 3x the configured idle window instead of disabling the reset entirely so
// an abandoned payment overlay still self-recovers for the next customer.
export const PAYMENT_IDLE_TIMEOUT_MULTIPLIER = 3;

export function resolveIdleTimeoutMs(baseMs: number, paymentOpen: boolean): number {
  return paymentOpen ? baseMs * PAYMENT_IDLE_TIMEOUT_MULTIPLIER : baseMs;
}

export function resolveSelfCheckoutMode(value: unknown): SelfCheckoutMode {
  return value === 'production' ? 'production' : 'demo';
}

export function resolveSelfCheckoutProfile(value: unknown): SelfCheckoutProfile {
  return 'retail_scan';
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
