/**
 * PaymentModal — visible cashier feedback when receipt print fails (G1).
 *
 * Regression: PaymentModal awaited the printReceipt IPC but discarded
 * the `receiptPrinted` flag in the response. With a missing or failing
 * receipt printer, the sale still completed (correct), but the cashier
 * walked away without ever knowing the receipt didn't print. The next
 * time the customer asks for it, they'd find it on Order History only
 * by luck. The grocery POS live-test spec explicitly asks for a visible
 * non-blocking warning before the modal closes.
 *
 * Style: source-string assertions in the same convention as
 * retail-product-grid-layout.test.ts and retail-sync-respects-filter.test.ts.
 * Behavioural assertion would require mounting the React component +
 * mocking electronAPI + faking timers — overkill for what is essentially
 * a "did the developer wire up the response field" check.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAYMENT_MODAL = path.resolve(
  __dirname,
  '../src/renderer/components/pos/PaymentModal.tsx',
);

describe('PaymentModal — surfaces print failure to cashier (G1)', () => {
  const source = fs.readFileSync(PAYMENT_MODAL, 'utf8');

  it('declares a printWarning state for the inline banner', () => {
    expect(source).toMatch(/setPrintWarning/);
    expect(source).toMatch(/\[printWarning,\s*setPrintWarning\]\s*=\s*useState/);
  });

  it('reads receiptPrinted from the printReceipt IPC response (no longer discarded)', () => {
    // The fix must surface the boolean — string-grep for the property
    // access. Catches a future refactor that goes back to ignoring it.
    expect(source).toMatch(/receiptPrinted\s*=/);
    expect(source).toMatch(/printResult.*receiptPrinted|receiptPrinted.*printResult/);
  });

  it('renders an amber warning banner (separate from the red error banner)', () => {
    expect(source).toMatch(/printWarning\s*&&/);
    // Amber palette — must not collide with the existing red error banner.
    expect(source).toMatch(/border-amber-\d+/);
    expect(source).toMatch(/bg-amber-\d+/);
  });

  it('delays modal close on print failure so the warning is actually visible', () => {
    // The previous flow called onComplete()/onClose() synchronously
    // after the IPC. The new flow must hold the modal open for ~4s on
    // failure so the cashier sees the warning before it disappears.
    const idx = source.indexOf('setPrintWarning(');
    expect(idx, 'setPrintWarning() call not found').toBeGreaterThan(-1);
    // Look at the immediate aftermath of the setter — must include a
    // setTimeout that fires onComplete/onClose.
    const block = source.slice(idx, idx + 600);
    expect(block).toMatch(/setTimeout/);
    expect(block).toMatch(/onComplete|onClose/);
  });

  it('fallback string is shown when the i18n key is missing', () => {
    // Defensive: the cashier must still see SOMETHING readable even
    // before the translation lands in every language file.
    expect(source).toMatch(/Receipt not printed[^"]*/);
  });
});
