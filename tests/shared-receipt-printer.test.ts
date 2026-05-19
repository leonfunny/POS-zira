import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrintJobType, PrinterType, ReceiptData } from '../src/shared/types';

const {
  createPrintJob,
  getConfig,
  getSecureAuthToken,
  listPrinterAssignments,
} = vi.hoisted(() => ({
  createPrintJob: vi.fn(),
  getConfig: vi.fn(),
  getSecureAuthToken: vi.fn(),
  listPrinterAssignments: vi.fn(),
}));

vi.mock('../src/main/config/store', () => ({
  getConfig,
  getSecureAuthToken,
}));

vi.mock('../src/main/network/api-client', () => ({
  ApiClient: class {
    createPrintJob = createPrintJob;
    listPrinterAssignments = listPrinterAssignments;
  },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { submitSharedReceiptPrint } from '../src/main/printing/shared-receipt-printer';

const receiptData: ReceiptData = {
  orderId: 'order-1',
  orderNumber: 'POS-1',
  items: [{ name: 'Tea', quantity: 1, unitPrice: 1200, totalPrice: 1200, vatRate: 23 }],
  payment: { method: 'CARD', amount: 1200 },
  subtotal: 1200,
  total: 1200,
};

describe('submitSharedReceiptPrint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockReturnValue({ serverUrl: 'https://api.example.test' });
    getSecureAuthToken.mockReturnValue('jwt-token');
  });

  it('skips remote routing when the app is not authenticated', async () => {
    getSecureAuthToken.mockReturnValue(null);
    const result = await submitSharedReceiptPrint(receiptData);
    expect(result).toEqual({ handled: false, printed: false });
    expect(listPrinterAssignments).not.toHaveBeenCalled();
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it('posts a receipt print job with the assigned shared printerId', async () => {
    listPrinterAssignments.mockResolvedValue({
      assignments: [{ role: 'SELF_CHECKOUT_RECEIPT', printerId: 'printer-remote-1' }],
    });
    createPrintJob.mockResolvedValue({ jobId: 'job-1', sent: true });

    const result = await submitSharedReceiptPrint(receiptData, {
      referenceType: 'POS_RECEIPT',
      referenceId: 'order-1',
      source: 'pos',
    });

    expect(result).toMatchObject({
      handled: true,
      printed: true,
      printerId: 'printer-remote-1',
      jobId: 'job-1',
    });
    expect(createPrintJob).toHaveBeenCalledWith(
      'jwt-token',
      expect.objectContaining({
        jobType: PrintJobType.RECEIPT,
        printerType: PrinterType.RECEIPT,
        printerId: 'printer-remote-1',
        referenceType: 'POS_RECEIPT',
        referenceId: 'order-1',
        payload: receiptData,
      }),
    );
  });

  it('falls back to local printing when no shared receipt assignment exists', async () => {
    listPrinterAssignments.mockResolvedValue({ assignments: [] });
    const result = await submitSharedReceiptPrint(receiptData);
    expect(result).toEqual({ handled: false, printed: false });
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it('briefly caches endpoint-unavailable assignment lookups', async () => {
    listPrinterAssignments.mockRejectedValue(new Error('HTTP 404'));

    const first = await submitSharedReceiptPrint(receiptData);
    const second = await submitSharedReceiptPrint(receiptData);

    expect(first).toMatchObject({ handled: false, printed: false, error: 'HTTP 404' });
    expect(second).toEqual({ handled: false, printed: false });
    expect(listPrinterAssignments).toHaveBeenCalledTimes(1);
    expect(createPrintJob).not.toHaveBeenCalled();
  });
});
