import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cartItemsSignature, shouldRefocusSearchAfterCartChange } from '../src/renderer/components/pos/cart-refocus';

const base = { paymentOpen: false, activeTag: null, activeId: null };

describe('cart refocus after state broadcast', () => {
  it('signature ignores array identity and reflects id/qty/price', () => {
    const a = [{ id: 'x', quantity: 1, price: 100 }];
    expect(cartItemsSignature(a)).toBe(cartItemsSignature([...a.map((i) => ({ ...i }))]));
    expect(cartItemsSignature(a)).not.toBe(cartItemsSignature([{ id: 'x', quantity: 2, price: 100 }]));
    expect(cartItemsSignature(a)).not.toBe(cartItemsSignature([{ id: 'x', quantity: 1, price: 150 }]));
    expect(cartItemsSignature([])).toBe('');
  });

  it('does not refocus when the cart content is unchanged (NIP keystroke broadcast)', () => {
    expect(shouldRefocusSearchAfterCartChange({ ...base, previousSignature: 'x:1:100', nextSignature: 'x:1:100' })).toBe(false);
  });

  it('refocuses after a real cart mutation when nothing else has focus', () => {
    expect(shouldRefocusSearchAfterCartChange({ ...base, previousSignature: '', nextSignature: 'x:1:100' })).toBe(true);
    expect(shouldRefocusSearchAfterCartChange({ ...base, previousSignature: 'x:1:100', nextSignature: 'x:1:100', activeTag: 'BUTTON', activeId: null })).toBe(false);
    expect(shouldRefocusSearchAfterCartChange({ ...base, previousSignature: 'x:1:100', nextSignature: 'x:2:100', activeTag: 'BUTTON', activeId: null })).toBe(true);
    expect(shouldRefocusSearchAfterCartChange({ ...base, previousSignature: 'x:1:100', nextSignature: 'x:2:100', activeTag: 'INPUT', activeId: 'pos-product-search' })).toBe(true);
  });

  it('never yanks focus from the payment modal or another text field', () => {
    expect(shouldRefocusSearchAfterCartChange({ ...base, previousSignature: '', nextSignature: 'x:1:100', paymentOpen: true })).toBe(false);
    expect(shouldRefocusSearchAfterCartChange({ ...base, previousSignature: '', nextSignature: 'x:1:100', activeTag: 'INPUT', activeId: 'payment-customer-nip' })).toBe(false);
    expect(shouldRefocusSearchAfterCartChange({ ...base, previousSignature: '', nextSignature: 'x:1:100', activeTag: 'TEXTAREA', activeId: 'note' })).toBe(false);
  });

  it('RetailTemplate wires the guarded helper instead of the bare cart.items effect', () => {
    const src = readFileSync('src/renderer/components/pos/templates/retail/RetailTemplate.tsx', 'utf8');
    expect(src).toContain('shouldRefocusSearchAfterCartChange(');
    expect(src).toContain('cartItemsSignature(cart.items)');
    expect(src).not.toMatch(/useEffect\(\(\) => \{\s*document\.dispatchEvent\(new CustomEvent\('pos:focus-search'\)\);\s*\}, \[cart\.items\]\);/);
  });
});
