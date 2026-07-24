export type FiscalOnCashSaleMode = 'always' | 'never' | 'ask';
export type FiscalAction = 'prompt' | 'autoPrint' | 'skip';

export function shouldPrintNonFiscalOrderCopy(input: {
  hasCash: boolean;
  hasBlik: boolean;
  hasFiscalPrinter: boolean;
  mode: FiscalOnCashSaleMode | undefined;
}): boolean {
  const needsCashSideDocument = input.hasCash || input.hasBlik;
  if (!needsCashSideDocument) return false;

  // In `always` mode the fiscal paragon is the customer document. Printing
  // an additional order copy wastes paper and, on legacy POSNET-only
  // installs, previously risked routing that "copy" into the fiscal driver.
  return !(input.hasFiscalPrinter && input.mode === 'always');
}

export function resolveFiscalAction(input: {
  printOrderCopy: boolean;
  hasFiscalPrinter: boolean;
  method: string;
  mode: FiscalOnCashSaleMode | undefined;
}): FiscalAction {
  if (!input.hasFiscalPrinter) return 'skip';

  if (!input.printOrderCopy) {
    return input.method === 'INVOICE' ? 'skip' : 'autoPrint';
  }

  const mode = input.mode ?? 'ask';
  if (mode === 'always') return 'autoPrint';
  if (mode === 'never') return 'skip';
  return 'prompt';
}
