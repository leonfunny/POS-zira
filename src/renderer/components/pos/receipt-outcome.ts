/**
 * Pure helpers backing PaymentModal's "did the receipt print?" UX.
 *
 * Extracted into a sibling module because:
 *   1. The decision logic (translate-or-fallback, close-now-or-delay)
 *      has two failure modes that cost the cashier real time at the
 *      till — wrong text shown to a customer / modal not closing —
 *      and behaviour-driven tests are easier on a pure function than
 *      on a React component without a DOM in vitest.
 *   2. Source-string assertions on PaymentModal alone can't prove the
 *      i18n fallback actually fires when t() returns the raw key (the
 *      common "missing translation" mode). A pure-function test with
 *      a mocked t can.
 */

export const RECEIPT_NOT_PRINTED_KEY = 'pos.payment.receiptNotPrinted';

// Hardcoded English fallback. Used when t() either returns nothing or
// returns the raw key (i18n libraries vary). NEVER show the raw key to
// a cashier — that's the regression this whole helper exists to prevent.
export const RECEIPT_NOT_PRINTED_FALLBACK =
  'Receipt not printed - reprint from Order History.';

export interface PrintReceiptResponse {
  success?: boolean;
  receiptPrinted?: boolean;
}

export interface ReceiptOutcome {
  /** Did the printer accept and emit the paper receipt? */
  receiptPrinted: boolean;
  /** User-visible warning string, or null if no warning needed. */
  warning: string | null;
}

/**
 * Decide what to display based on the IPC response from
 * `window.electronAPI.pos.payment.printReceipt(orderId)`. The IPC
 * always resolves (the controller layer catches print errors and
 * returns `{ success: true, receiptPrinted: false }`); this helper
 * normalises absence/undefined/missing-flag into a clean failure case
 * so the modal never ends up showing nothing AND printing nothing.
 */
export function deriveReceiptOutcome(
  printResult: PrintReceiptResponse | undefined | null,
  t: (key: string) => string,
): ReceiptOutcome {
  const receiptPrinted = Boolean(printResult?.receiptPrinted);
  if (receiptPrinted) return { receiptPrinted: true, warning: null };

  const translated = t(RECEIPT_NOT_PRINTED_KEY);
  const isReadable =
    typeof translated === 'string' &&
    translated.length > 0 &&
    translated !== RECEIPT_NOT_PRINTED_KEY;

  return {
    receiptPrinted: false,
    warning: isReadable ? translated : RECEIPT_NOT_PRINTED_FALLBACK,
  };
}

export type CloseAction =
  | { type: 'close-now' }
  | { type: 'show-warning-then-close'; warning: string; delayMs: number };

/**
 * Pair the receipt outcome with the modal close behaviour the cashier
 * sees. Success: close immediately, customer keeps moving. Failure:
 * hold the modal open with an inline warning for `delayOnFailureMs`
 * (default 4s) so the cashier reads it before the modal disappears.
 */
export function decideCloseAction(
  outcome: ReceiptOutcome,
  delayOnFailureMs: number = 4000,
): CloseAction {
  if (outcome.receiptPrinted) return { type: 'close-now' };
  return {
    type: 'show-warning-then-close',
    warning: outcome.warning ?? RECEIPT_NOT_PRINTED_FALLBACK,
    delayMs: delayOnFailureMs,
  };
}
