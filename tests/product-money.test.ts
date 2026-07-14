import { describe, expect, it } from 'vitest';
import {
  isValidProductMoneyGrosze,
  parseProductMoneyInputToGrosze,
  PRODUCT_MONEY_MAX_GROSZE,
} from '../src/shared/product-money';

describe('product money limits', () => {
  it('parses decimal input exactly without floating-point rounding', () => {
    expect(parseProductMoneyInputToGrosze('21.50')).toBe(2150);
    expect(parseProductMoneyInputToGrosze('21,05')).toBe(2105);
    expect(parseProductMoneyInputToGrosze('0.01', { allowZero: false })).toBe(1);
    expect(parseProductMoneyInputToGrosze('1.')).toBe(100);
  });

  it('enforces the PostgreSQL numeric(12,2) upper bound', () => {
    expect(parseProductMoneyInputToGrosze('9999999999.99')).toBe(PRODUCT_MONEY_MAX_GROSZE);
    expect(parseProductMoneyInputToGrosze('10000000000.00')).toBeUndefined();
    expect(parseProductMoneyInputToGrosze('9999999999.999')).toBeUndefined();
    expect(isValidProductMoneyGrosze(PRODUCT_MONEY_MAX_GROSZE)).toBe(true);
    expect(isValidProductMoneyGrosze(PRODUCT_MONEY_MAX_GROSZE + 1)).toBe(false);
  });

  it('keeps blank, zero, negative, and malformed states distinct', () => {
    expect(parseProductMoneyInputToGrosze('', { allowBlank: true })).toBeNull();
    expect(parseProductMoneyInputToGrosze('0', { allowZero: false })).toBeUndefined();
    expect(parseProductMoneyInputToGrosze('0', { allowZero: true })).toBe(0);
    expect(parseProductMoneyInputToGrosze('-1')).toBeUndefined();
    expect(parseProductMoneyInputToGrosze('12abc')).toBeUndefined();
  });
});
