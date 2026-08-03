/**
 * Billiard settle gates that BOTH platforms must apply identically.
 *
 * Moved out of src/main/pos/fiscal-tender-preflight.ts (which re-exports them,
 * so its Windows importers are unchanged). They were already pure; sitting in
 * the main process is what made them unreachable for the Android shim, and a
 * gate that only one platform enforces is not a gate.
 *
 * Ending a billiard session is the point of no return: it stops the clock,
 * freezes the bill and hands it to POS. Everything here fails CLOSED — the
 * table keeps running rather than a session ending with no way to issue its
 * fiscal receipt.
 */

/**
 * Is this register fiscally routed at all? Any one of these means a fiscal
 * document is expected for the sale, so the printer must be ready before the
 * session may end.
 */
export function requiresBilliardFiscalPrinterReadiness(input: {
  allowRealFiscalPrint?: boolean;
  fiscalOnCashSale?: string;
  localFiscalEnabled?: boolean;
  detectedFiscalConfigured?: boolean;
}): boolean {
  return input.allowRealFiscalPrint === true
    || input.fiscalOnCashSale === 'always'
    || input.localFiscalEnabled === true
    || input.detectedFiscalConfigured === true;
}

/**
 * Production go-live gate: a configured fiscal route may only be exercised when
 * `allowRealFiscalPrint` is explicitly on. Runs unchanged on both platforms —
 * a tablet must not be able to slip past it.
 */
export function assertBilliardRealFiscalGate(input: {
  allowRealFiscalPrint?: boolean;
  fiscalOnCashSale?: string;
  localFiscalEnabled?: boolean;
  detectedFiscalConfigured?: boolean;
}): void {
  const fiscalRouteExpected = input.fiscalOnCashSale === 'always'
    || input.localFiscalEnabled === true
    || input.detectedFiscalConfigured === true;
  if (fiscalRouteExpected && input.allowRealFiscalPrint !== true) {
    throw new Error(
      'REAL_FISCAL_PRINT_DISABLED: the configured fiscal route is disabled by the production safety gate. '
      + 'Enable allowRealFiscalPrint only during controlled production go-live.',
    );
  }
}

export interface BilliardFiscalReadinessInput {
  allowRealFiscalPrint?: boolean;
  fiscalOnCashSale?: string;
  /**
   * A fiscal device attached to THIS machine. Always false on Android: a tablet
   * has no directly connected fiscal printer, and claiming one would distort
   * the `allowRealFiscalPrint` gate above.
   */
  localFiscalEnabled?: boolean;
  /** A fiscal printer is configured/assigned for this salon. */
  detectedFiscalConfigured?: boolean;
  /**
   * A live link to whatever owns that printer.
   *  - Windows: the locally attached device answered (`configured && connected`).
   *  - Android: the print-agent socket is up. The tablet owns no printer, so the
   *    socket IS the fiscal path; `connected` from the assignment lookup is not
   *    a real liveness signal there (it merely mirrors `assigned`).
   */
  fiscalChannelConnected?: boolean;
}

/**
 * Refuse to end a billiard session when a fiscal document is expected and the
 * fiscal path is not actually usable. Same rule, same message, both platforms.
 */
export function assertBilliardFiscalPrinterReady(input: BilliardFiscalReadinessInput): void {
  if (!requiresBilliardFiscalPrinterReadiness(input)) return;
  if (input.fiscalChannelConnected === true) return;
  throw new Error('The fiscal printer is not ready. Connect it before ending this Billiard session.');
}

/**
 * D2 (2026-08-03): a device with no stable, server-known register identity may
 * not open a frozen checkout.
 *
 * The journal is scoped by salon+user+register; an invented identity would let
 * two devices collide on one register and see each other's frozen checkouts.
 * On Android the only such identity is `agentId`, written from the
 * `/print-agent/connect` response — Windows' `machineId` is server-assigned
 * (auth.module.ts:241), so minting a local UUID is not an option.
 *
 * The refusal names the fix, because "register identity is incomplete" tells a
 * cashier nothing actionable.
 */
export const TABLET_NOT_PAIRED_MESSAGE =
  'This tablet is not paired with the salon print-agent yet, so it cannot take payment for a Billiard session. '
  + 'Pair it first — the fiscal receipt for this bill is printed through that same agent.';
