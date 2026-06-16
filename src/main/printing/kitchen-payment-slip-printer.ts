import { PrinterType, type KitchenTicketData } from '../../shared/types';
import {
  buildKitchenPaymentSlipLines,
} from './kitchen-ticket';

export type KitchenSelfOrderSlipPrintResult = {
  printed: boolean;
  route?: 'LOCAL';
  error?: string;
};

type KitchenSelfOrderSlipPrinter = {
  isConnected?: () => boolean;
  printPlainLines?: (lines: unknown[]) => Promise<void>;
  printKitchenPaymentLabel?: (ticket: KitchenTicketData) => Promise<void>;
};

export async function printKitchenSelfOrderCustomerSlipToPrinter(
  ticket: KitchenTicketData,
  printerType: PrinterType,
  printer: KitchenSelfOrderSlipPrinter | null | undefined,
): Promise<KitchenSelfOrderSlipPrintResult> {
  if (!printer?.isConnected?.()) {
    return { printed: false, error: `${printerType.toLowerCase()}_printer_not_connected` };
  }

  try {
    const paymentTicket = { ...ticket, kind: 'PAYMENT_SLIP' as const };
    if (printerType === PrinterType.LABEL) {
      if (typeof printer.printKitchenPaymentLabel !== 'function') {
        return { printed: false, error: 'label_printer_label_unavailable' };
      }
      await printer.printKitchenPaymentLabel(paymentTicket);
      return { printed: true, route: 'LOCAL' };
    }

    if (typeof printer.printPlainLines !== 'function') {
      return { printed: false, error: `${printerType.toLowerCase()}_printer_plain_text_unavailable` };
    }

    await printer.printPlainLines(buildKitchenPaymentSlipLines(paymentTicket));
    return { printed: true, route: 'LOCAL' };
  } catch (err: any) {
    return { printed: false, error: err?.message || String(err) };
  }
}
