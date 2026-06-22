import { describe, expect, it, vi } from 'vitest';
import { printKitchenSelfOrderCustomerSlipToPrinter } from '../src/main/printing/kitchen-payment-slip-printer';
import { PrinterType, type KitchenTicketData } from '../src/shared/types';

const ticket: KitchenTicketData = {
  orderId: 'kso-1',
  orderNumber: 'K-042',
  pickupNumber: 'K-042',
  createdAt: '2026-06-16T10:00:00.000Z',
  source: 'KIOSK',
  fulfillmentType: 'DINE_IN',
  customerLanguage: 'pl',
  paymentStatus: 'UNPAID',
  qrPayload: 'KSO1:test',
  totalGrosze: 2900,
  items: [
    { name: 'Pho bo', quantity: 2, unitPriceGrosze: 1200, lineTotalGrosze: 2400 },
    { name: 'Cha gio', quantity: 1, unitPriceGrosze: 500, lineTotalGrosze: 500 },
  ],
};

describe('kitchen self-order customer slip printer routing', () => {
  it('prints LABEL slips through the dedicated label method without requiring plain text support', async () => {
    const printKitchenPaymentLabel = vi.fn(async () => undefined);
    const printer = {
      isConnected: () => true,
      printKitchenPaymentLabel,
    };

    const result = await printKitchenSelfOrderCustomerSlipToPrinter(ticket, PrinterType.LABEL, printer);

    expect(result).toEqual({ printed: true, route: 'LOCAL' });
    expect(printKitchenPaymentLabel).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'PAYMENT_SLIP',
      orderNumber: 'K-042',
      qrPayload: 'KSO1:test',
    }));
  });

  it('fails LABEL slips clearly when the configured label driver lacks the dedicated method', async () => {
    const result = await printKitchenSelfOrderCustomerSlipToPrinter(ticket, PrinterType.LABEL, {
      isConnected: () => true,
      printPlainLines: vi.fn(async () => undefined),
    });

    expect(result).toEqual({ printed: false, error: 'label_printer_label_unavailable' });
  });

  it('keeps RECEIPT slips on the thermal plain-line path', async () => {
    const printPlainLines = vi.fn(async () => undefined);

    const result = await printKitchenSelfOrderCustomerSlipToPrinter(ticket, PrinterType.RECEIPT, {
      isConnected: () => true,
      printPlainLines,
    });

    expect(result).toEqual({ printed: true, route: 'LOCAL' });
    expect(printPlainLines).toHaveBeenCalledTimes(1);
    const lines = printPlainLines.mock.calls[0][0];
    expect(lines.some((line: any) => line.qrData === 'KSO1:test')).toBe(true);
  });
});
