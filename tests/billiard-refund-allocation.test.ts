import { describe, expect, it } from 'vitest';
import {
  buildRefundLineAmountBasis,
  calculateRefundLineAmount,
  getRefundLineUnitPrice,
} from '../src/renderer/components/pos/refund-line-amount';

describe('Billiard F&B refund allocation', () => {
  it('pro-rates partial and full-quantity refunds from the frozen discounted payable total', () => {
    const basis = buildRefundLineAmountBasis({
      price: 1000,
      quantity: 4,
      remainingQuantity: 4,
      total: 4000,
      authoritativePayableTotal: 3000,
      refundedAmount: 0,
      sell_by: 'PIECE',
    });

    expect(getRefundLineUnitPrice(basis)).toBe(750);
    expect(calculateRefundLineAmount(basis, 1)).toBe(750);
    expect(calculateRefundLineAmount(basis, 4)).toBe(3000);
  });

  it('uses the unrefunded remainder of the same allocation on a later refund', () => {
    const basis = buildRefundLineAmountBasis({
      price: 1000,
      quantity: 4,
      remainingQuantity: 3,
      total: 4000,
      authoritativePayableTotal: 3000,
      refundedAmount: 750,
      sell_by: 'PIECE',
    });

    expect(calculateRefundLineAmount(basis, 1)).toBe(750);
    expect(calculateRefundLineAmount(basis, 3)).toBe(2250);
  });
});
