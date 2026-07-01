export type FiscalOnCashSaleMode = 'always' | 'never' | 'ask';
export type FiscalAction = 'prompt' | 'autoPrint' | 'skip';

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
