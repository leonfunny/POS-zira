/**
 * PaymentModal "receipt did not print" feedback — PRD-driven behaviour.
 *
 * Reverse-engineered from the PR-1 spec
 * (AUDIT-printer-readiness-pr1.md, gap G1) plus owner feedback after
 * the first attempt:
 *
 *   "When printReceipt returns receiptPrinted:false, the sale must
 *    still complete, the modal must stay open so the cashier sees a
 *    readable warning (NOT a raw i18n key), and the modal must close
 *    after the warning has been on screen long enough to read."
 *
 * The previous test asserted the source contained an English fallback
 * string. That passed even though the runtime was using
 *   `t('pos.payment.receiptNotPrinted') || 'fallback'`
 * which returns the i18n KEY when the translation is missing — and
 * `'pos.payment.receiptNotPrinted' || 'fallback'` evaluates to the
 * truthy key, so the cashier saw the raw key on screen. Source-only
 * grep can't catch that. These tests assert the actual decision logic
 * via a pure function, exercised with a `t = key => key` mock that
 * simulates the missing-translation state.
 *
 * The pure helpers under test (`deriveReceiptOutcome`,
 * `decideCloseAction`) live in receipt-outcome.ts; PaymentModal wires
 * them into its state + setTimeout. The minimal source-string check at
 * the bottom only verifies that wiring exists — the BEHAVIOUR is
 * pinned by the helper tests.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  deriveReceiptOutcome,
  decideCloseAction,
  RECEIPT_NOT_PRINTED_KEY,
  RECEIPT_NOT_PRINTED_FALLBACK,
} from '../src/renderer/components/pos/receipt-outcome';

const PAYMENT_MODAL = path.resolve(
  __dirname,
  '../src/renderer/components/pos/PaymentModal.tsx',
);
const TRANSLATIONS = path.resolve(
  __dirname,
  '../src/renderer/i18n/translations.ts',
);

// ─── PRD behaviour: deriveReceiptOutcome ─────────────────────────────

describe('deriveReceiptOutcome — sale-vs-warning decision', () => {
  it('receiptPrinted=true → no warning, modal can close immediately', () => {
    const out = deriveReceiptOutcome(
      { success: true, receiptPrinted: true },
      (k) => k,
    );
    expect(out.receiptPrinted).toBe(true);
    expect(out.warning).toBeNull();
  });

  it('receiptPrinted=false with MISSING translation (t = key => key) returns the readable English fallback, NEVER the raw i18n key', () => {
    // This is the regression that slipped past the source-grep test:
    // the runtime was showing the raw key string.
    const out = deriveReceiptOutcome(
      { success: true, receiptPrinted: false },
      (k) => k,
    );
    expect(out.receiptPrinted).toBe(false);
    expect(out.warning).not.toBe(RECEIPT_NOT_PRINTED_KEY);
    expect(out.warning).not.toMatch(/^pos\./);
    expect(out.warning).toBe(RECEIPT_NOT_PRINTED_FALLBACK);
  });

  it('receiptPrinted=false with RESOLVED translation returns the translation, not the fallback', () => {
    const out = deriveReceiptOutcome(
      { success: true, receiptPrinted: false },
      (k) =>
        k === RECEIPT_NOT_PRINTED_KEY
          ? 'Paragon nie został wydrukowany — wydrukuj ponownie z Historii zamówień.'
          : k,
    );
    expect(out.receiptPrinted).toBe(false);
    expect(out.warning).toContain('Paragon');
    expect(out.warning).not.toBe(RECEIPT_NOT_PRINTED_FALLBACK);
  });

  it('receiptPrinted=false with t() returning empty string falls back to readable English', () => {
    const out = deriveReceiptOutcome(
      { success: true, receiptPrinted: false },
      () => '',
    );
    expect(out.warning).toBe(RECEIPT_NOT_PRINTED_FALLBACK);
  });

  it('treats undefined printResult (IPC layer rejected) as a print failure with readable warning', () => {
    const out = deriveReceiptOutcome(undefined, (k) => k);
    expect(out.receiptPrinted).toBe(false);
    expect(out.warning).toBe(RECEIPT_NOT_PRINTED_FALLBACK);
  });

  it('treats null printResult the same as undefined', () => {
    const out = deriveReceiptOutcome(null, (k) => k);
    expect(out.receiptPrinted).toBe(false);
    expect(out.warning).toBe(RECEIPT_NOT_PRINTED_FALLBACK);
  });

  it('treats { success: false } (no receiptPrinted field) as a print failure', () => {
    const out = deriveReceiptOutcome({ success: false }, (k) => k);
    expect(out.receiptPrinted).toBe(false);
    expect(out.warning).toBe(RECEIPT_NOT_PRINTED_FALLBACK);
  });

  it('treats { receiptPrinted: undefined } as a print failure (defensive against partial responses)', () => {
    const out = deriveReceiptOutcome(
      { success: true, receiptPrinted: undefined },
      (k) => k,
    );
    expect(out.receiptPrinted).toBe(false);
  });
});

// ─── PRD behaviour: decideCloseAction ────────────────────────────────

describe('decideCloseAction — modal stays open until cashier reads the warning', () => {
  it('on success: returns close-now (modal closes immediately)', () => {
    const action = decideCloseAction({ receiptPrinted: true, warning: null });
    expect(action.type).toBe('close-now');
  });

  it('on failure: returns show-warning-then-close with default 4s delay', () => {
    const action = decideCloseAction({
      receiptPrinted: false,
      warning: 'Receipt not printed - reprint from Order History.',
    });
    expect(action.type).toBe('show-warning-then-close');
    if (action.type === 'show-warning-then-close') {
      expect(action.warning).toContain('Receipt not printed');
      expect(action.delayMs).toBe(4000);
    }
  });

  it('on failure: surfaces the upstream warning text verbatim (translated or fallback)', () => {
    const action = decideCloseAction({
      receiptPrinted: false,
      warning: 'Paragon nie został wydrukowany',
    });
    if (action.type === 'show-warning-then-close') {
      expect(action.warning).toBe('Paragon nie został wydrukowany');
    }
  });

  it('on failure with null upstream warning: still emits the readable fallback (defensive)', () => {
    const action = decideCloseAction({ receiptPrinted: false, warning: null });
    expect(action.type).toBe('show-warning-then-close');
    if (action.type === 'show-warning-then-close') {
      expect(action.warning).toBe(RECEIPT_NOT_PRINTED_FALLBACK);
      expect(action.warning).not.toBe(RECEIPT_NOT_PRINTED_KEY);
    }
  });

  it('respects a custom delay (used by tests / future tuning)', () => {
    const action = decideCloseAction(
      { receiptPrinted: false, warning: 'x' },
      1500,
    );
    if (action.type === 'show-warning-then-close') {
      expect(action.delayMs).toBe(1500);
    }
  });
});

// ─── i18n key coverage ──────────────────────────────────────────────

describe('i18n: pos.payment.receiptNotPrinted is defined in every language', () => {
  const source = fs.readFileSync(TRANSLATIONS, 'utf8');

  // Every existing pos.payment.complete entry signals a language
  // section. The new key MUST appear at least the same number of times
  // — one per language — so a future contributor adding a language
  // can't accidentally ship without the cashier-facing string.
  const languageCount = (source.match(/'pos\.payment\.complete'\s*:/g) ?? []).length;

  it(`appears once per language section (${languageCount} languages detected)`, () => {
    expect(languageCount).toBeGreaterThan(0);
    const keyCount = (
      source.match(/'pos\.payment\.receiptNotPrinted'\s*:/g) ?? []
    ).length;
    expect(keyCount).toBe(languageCount);
  });

  it('every translation value is non-empty and not the raw key', () => {
    const matches = [...source.matchAll(
      /'pos\.payment\.receiptNotPrinted'\s*:\s*'([^']+)'/g,
    )];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      const value = m[1];
      expect(value.length).toBeGreaterThan(5);
      expect(value).not.toBe(RECEIPT_NOT_PRINTED_KEY);
    }
  });
});

// ─── Wiring guard ──────────────────────────────────────────────────
// Minimal source-string assertion: prove PaymentModal actually USES
// the helpers above, and never falls back to the broken `t() || ...`
// pattern that returns the raw key string when translation is missing.

describe('PaymentModal wires the helpers (regression guard, not behaviour)', () => {
  const source = fs.readFileSync(PAYMENT_MODAL, 'utf8');

  it('imports deriveReceiptOutcome from receipt-outcome', () => {
    expect(source).toMatch(/import\s*\{[^}]*deriveReceiptOutcome[^}]*\}\s*from\s*['"]\.\/receipt-outcome['"]/);
  });

  it('does NOT use the broken `t(key) || fallback` pattern for the receipt warning', () => {
    // The runtime bug we are guarding against:
    //   t('pos.payment.receiptNotPrinted') || 'Receipt not printed...'
    // Returns the raw key when the translation is missing. Allowed:
    // anything routed through deriveReceiptOutcome (which checks
    // `translated !== KEY` explicitly).
    expect(source).not.toMatch(
      /t\(\s*['"]pos\.payment\.receiptNotPrinted['"]\s*\)\s*\|\|/,
    );
  });

  it('keeps the modal in explicit recovery state after receipt print failure', () => {
    expect(source).toContain('setReceiptRecovery({');
    expect(source).toContain('handleRetryReceipt');
    expect(source).toContain('handleContinueWithoutReceipt');
  });

  it('does not skip non-cash fiscal printing once hasFiscalPrinter reports a configured route', () => {
    expect(source).toContain("const autoPrintFiscal = !hasCash && method !== 'INVOICE';");
    const fiscalBranch = source.slice(
      source.indexOf('if (autoPrintFiscal)'),
      source.indexOf('const outcome = deriveReceiptOutcome'),
    );
    expect(fiscalBranch).toContain('if (!hasFiscalPrinter)');
    expect(fiscalBranch).toContain('window.electronAPI.pos.payment.printFiscalReceipt(orderId)');
  });
});
