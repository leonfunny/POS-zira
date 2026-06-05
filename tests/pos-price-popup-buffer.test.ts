import { describe, expect, it } from 'vitest';
import { applyPricePopupBufferKey } from '../src/renderer/components/pos/Cart';

describe('PricePopup price buffer', () => {
  it('replaces the formatted current price on the first digit input', () => {
    expect(applyPricePopupBufferKey('7.00', '6', true)).toBe('6');
  });

  it('starts a decimal price from zero on the first decimal input', () => {
    expect(applyPricePopupBufferKey('7.00', '.', true)).toBe('0.');
  });

  it('uses the empty-buffer double-zero semantics on the first 00 input', () => {
    expect(applyPricePopupBufferKey('7.00', '00', true)).toBe('0');
  });

  it('keeps existing append semantics after the first input', () => {
    let buffer = applyPricePopupBufferKey('7.00', '6', true);
    buffer = applyPricePopupBufferKey(buffer, '5', false);

    expect(buffer).toBe('65');
  });

  it('does not change non-pristine price append behavior', () => {
    expect(applyPricePopupBufferKey('7.00', '6', false)).toBe('7.006');
  });
});
