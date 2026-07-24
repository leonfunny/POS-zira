import type { BilliardCartLineMetadata } from '../../shared/billiard-pos-handoff';
import { assertPosnetVatRateSupported } from '../hardware/posnet/receipt-formatter';

export interface TenderFiscalLine {
  vatRate?: number;
  vat_rate?: number;
  billiard?: BilliardCartLineMetadata;
  billiard_json?: string | null;
  allocatedDiscountGrosze?: number;
  allocated_discount?: number;
}

export interface TenderFiscalCompatibilityOptions {
  /** Frozen checkout-level discount in grosze. */
  checkoutDiscountGrosze?: number;
}

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

function allocatedBilliardDiscount(line: TenderFiscalLine): number {
  let jsonDiscount = 0;
  if (line.billiard_json) {
    try { jsonDiscount = Number(JSON.parse(line.billiard_json)?.allocatedDiscountGrosze || 0); }
    catch { /* frozen Billiard order validation owns malformed metadata */ }
  }
  return Number(
    line.billiard?.allocatedDiscountGrosze
    ?? line.allocatedDiscountGrosze
    ?? line.allocated_discount
    ?? jsonDiscount,
  );
}

export function hasTenderFiscalDiscount(
  lines: TenderFiscalLine[],
  options: TenderFiscalCompatibilityOptions = {},
): boolean {
  return Number(options.checkoutDiscountGrosze || 0) > 0
    || lines.some((line) => allocatedBilliardDiscount(line) > 0);
}

/** Fail before a protected tender boundary/order commit, not during printing. */
export function assertTenderFiscalCompatibilityForProtocol(
  protocolInput: unknown,
  lines: TenderFiscalLine[],
  options: TenderFiscalCompatibilityOptions = {},
): void {
  const protocol = String(protocolInput || '').toUpperCase();
  if (protocol === 'POSNET') {
    lines.forEach((line) => assertPosnetVatRateSupported(Number(line.vatRate ?? line.vat_rate ?? 23)));
  }
  if (protocol === 'ELZAB_STX' && hasTenderFiscalDiscount(lines, options)) {
    throw new Error(
      'ELZAB_LINE_DISCOUNT_UNSUPPORTED: this protected checkout contains a discount '
      + 'and cannot be tendered on the configured fiscal printer.',
    );
  }
}
