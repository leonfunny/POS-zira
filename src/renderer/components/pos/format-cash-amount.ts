/**
 * Format a grosze amount as the cash-received input default string.
 *
 * Extracted from PaymentModal so the .tsx file can stay a pure
 * component module — React Fast Refresh requires component files to
 * export only components, otherwise HMR invalidates instead of
 * updating and the running renderer keeps stale code.
 */
export function formatInitialCashAmount(grosze?: number): string {
  return grosze && grosze > 0 ? (grosze / 100).toFixed(2) : '';
}
