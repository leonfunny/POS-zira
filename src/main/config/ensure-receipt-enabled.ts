import { getConfig, setConfig } from './store';
import logger from '../logger';
import type { AgentConfig, PrinterConfig } from '../../shared/types';

/**
 * On every boot, force the RECEIPT printer toggle ON. Cashiers can still
 * disable it mid-shift (jam, paper out), but the toggle resets to ON at
 * the next restart so a forgotten "off" never silently stops receipts.
 *
 * Only flips an EXISTING receipt-printer config — never invents one. A
 * fresh install with no printer set up keeps the default (off) so the
 * inference in store.ts and the multi-printer-mode auto-detect aren't
 * disturbed.
 */
export function ensureReceiptPrinterEnabledOnBoot(): void {
  const config = getConfig();
  const updates: Partial<AgentConfig> = {};

  const existingMulti: PrinterConfig | undefined = config.printers?.RECEIPT;
  if (existingMulti && existingMulti.enabled !== true) {
    updates.printers = {
      ...config.printers,
      RECEIPT: { ...existingMulti, enabled: true },
    };
  }

  const existingLegacy: PrinterConfig | undefined = config.receiptPrinter;
  if (existingLegacy && existingLegacy.enabled !== true) {
    updates.receiptPrinter = { ...existingLegacy, enabled: true };
  }

  if (Object.keys(updates).length === 0) {
    return;
  }

  setConfig(updates);
  logger.info('[Boot] Receipt printer toggle reset to ON for this session');
}
