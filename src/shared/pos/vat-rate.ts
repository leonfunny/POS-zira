/**
 * One place that decides what a VAT rate is.
 *
 * Every VAT mapping in this codebase used to end in `|| 23`, and `||` in
 * JavaScript treats the number 0 exactly like null: a genuine 0% rate became
 * 23%. The intent was only ever "if we cannot read a rate, assume the standard
 * one" — but `||` cannot tell "unknown" from "known to be zero".
 *
 * 0% is a real Polish rate (exports, intra-EU supply), the product dialogs
 * offer it as a first-class choice (FALLBACK_PRODUCT_VAT_RATES = [23, 8, 5, 0]),
 * and Poland applied it to basic foodstuffs for two years running. Getting it
 * wrong does not just misprice a line — it misstates the tax on a receipt that
 * has already been handed to a customer.
 *
 * Kept deliberately narrow: this decides ONLY the fallback, not which field to
 * read. Callers keep their own `??` chains so this change cannot quietly alter
 * which source wins.
 */

/** The standard Polish rate, used when no readable rate is available. */
export const DEFAULT_VAT_RATE = 23;

/**
 * A readable, non-negative rate — including 0 — or the fallback.
 *
 * Accepts the shapes the backends actually send: a number, a numeric string
 * ("8", "8.00"), or null/undefined/garbage.
 */
export function normalizeVatRate(value: unknown, fallback: number = DEFAULT_VAT_RATE): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  // Number.isFinite rejects NaN and Infinity; the >= 0 check rejects a negative
  // rate, which is not a thing and would otherwise sail through as "readable".
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
