import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrintJobType, PrinterType, ReceiptData } from '../src/shared/types';

const {
  createPrintJob,
  createPrintJobWithApiKey,
  getConfig,
  getSecureApiKey,
  getSecureAuthToken,
  listPrinterAssignments,
  listPrinterAssignmentsWithApiKey,
} = vi.hoisted(() => ({
  createPrintJob: vi.fn(),
  createPrintJobWithApiKey: vi.fn(),
  getConfig: vi.fn(),
  getSecureApiKey: vi.fn(),
  getSecureAuthToken: vi.fn(),
  listPrinterAssignments: vi.fn(),
  listPrinterAssignmentsWithApiKey: vi.fn(),
}));

vi.mock('../src/main/config/store', () => ({
  getConfig,
  getSecureApiKey,
  getSecureAuthToken,
}));

vi.mock('../src/main/network/api-client', () => ({
  ApiClient: class {
    createPrintJob = createPrintJob;
    createPrintJobWithApiKey = createPrintJobWithApiKey;
    listPrinterAssignments = listPrinterAssignments;
    listPrinterAssignmentsWithApiKey = listPrinterAssignmentsWithApiKey;
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
    getConfig.mockReturnValue({ serverUrl: 'https://api.example.test', machineId: 'machine-2' });
    getSecureAuthToken.mockReturnValue('jwt-token');
    getSecureApiKey.mockReturnValue(null);
  });

  it('skips remote routing when the app has no JWT or print-agent API key', async () => {
    getSecureAuthToken.mockReturnValue(null);
    getSecureApiKey.mockReturnValue(null);
    const result = await submitSharedReceiptPrint(receiptData);
    expect(result).toEqual({ handled: false, printed: false });
    expect(listPrinterAssignments).not.toHaveBeenCalled();
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it('uses the print-agent API key when no staff JWT is available', async () => {
    getSecureAuthToken.mockReturnValue(null);
    getSecureApiKey.mockReturnValue('pa_self_checkout');
    listPrinterAssignmentsWithApiKey.mockResolvedValue({
      assignments: [{ role: 'SELF_CHECKOUT_RECEIPT', printerId: 'printer-remote-1' }],
    });
    createPrintJobWithApiKey.mockResolvedValue({ jobId: 'job-api-key', sent: true });

    const result = await submitSharedReceiptPrint(receiptData, {
      referenceType: 'POS_RECEIPT',
      referenceId: 'order-1',
      source: 'self-checkout',
    });

    expect(result).toMatchObject({
      handled: true,
      printed: true,
      printerId: 'printer-remote-1',
      jobId: 'job-api-key',
    });
    expect(listPrinterAssignmentsWithApiKey).toHaveBeenCalledWith('pa_self_checkout', 'machine-2');
    expect(createPrintJobWithApiKey).toHaveBeenCalledWith(
      'pa_self_checkout',
      expect.objectContaining({
        printerId: 'printer-remote-1',
        referenceType: 'POS_RECEIPT',
      }),
      'machine-2',
    );
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

  it('adds openDrawer only when the caller explicitly requests a remote drawer pulse', async () => {
    listPrinterAssignments.mockResolvedValue({
      assignments: [{ role: 'SELF_CHECKOUT_RECEIPT', printerId: 'printer-remote-1' }],
    });
    createPrintJob.mockResolvedValue({ jobId: 'job-1', sent: true });

    const result = await submitSharedReceiptPrint(receiptData, {
      referenceType: 'POS_RECEIPT',
      referenceId: 'order-1',
      source: 'pos',
      openDrawer: true,
    });

    expect(result).toMatchObject({
      handled: true,
      printed: true,
      drawerOpenRequested: true,
    });
    expect(createPrintJob).toHaveBeenCalledWith(
      'jwt-token',
      expect.objectContaining({
        referenceType: 'POS_RECEIPT',
        openDrawer: true,
      }),
    );
  });

  it('retries without openDrawer when the backend has not deployed the drawer field yet', async () => {
    listPrinterAssignments.mockResolvedValue({
      assignments: [{ role: 'SELF_CHECKOUT_RECEIPT', printerId: 'printer-remote-1' }],
    });
    createPrintJob
      .mockRejectedValueOnce(new Error('HTTP 400: property openDrawer should not exist'))
      .mockResolvedValueOnce({ jobId: 'job-1', sent: true });

    const result = await submitSharedReceiptPrint(receiptData, {
      referenceType: 'POS_RECEIPT',
      referenceId: 'order-1',
      source: 'pos',
      openDrawer: true,
    });

    expect(result).toMatchObject({
      handled: true,
      printed: true,
      drawerOpenRequested: false,
    });
    expect(createPrintJob).toHaveBeenCalledTimes(2);
    expect(createPrintJob).toHaveBeenNthCalledWith(
      1,
      'jwt-token',
      expect.objectContaining({ openDrawer: true }),
    );
    expect(createPrintJob).toHaveBeenNthCalledWith(
      2,
      'jwt-token',
      expect.not.objectContaining({ openDrawer: expect.anything() }),
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
