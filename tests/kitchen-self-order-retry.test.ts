import { describe, expect, it } from 'vitest';
import { resolveKitchenSelfOrderRetryAction } from '../src/shared/kitchen-self-order';

describe('kitchen self-order retry action', () => {
  it('returns none when kitchen and customer slip are printed', () => {
    expect(resolveKitchenSelfOrderRetryAction({ kitchenPrinted: 1, customerSlipPrinted: 1 })).toBe('none');
    expect(resolveKitchenSelfOrderRetryAction({ kitchenPrinted: true, customerSlipPrinted: true })).toBe('none');
  });

  it('returns reprint_slip when only the customer slip failed', () => {
    expect(resolveKitchenSelfOrderRetryAction({ kitchenPrinted: 1, customerSlipPrinted: 0 })).toBe('reprint_slip');
  });

  it('returns reprint_all when the kitchen ticket failed', () => {
    expect(resolveKitchenSelfOrderRetryAction({ kitchenPrinted: 0, customerSlipPrinted: 0 })).toBe('reprint_all');
    expect(resolveKitchenSelfOrderRetryAction({})).toBe('reprint_all');
    expect(resolveKitchenSelfOrderRetryAction({ kitchenPrinted: null, customerSlipPrinted: null })).toBe('reprint_all');
  });
});
