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
  listSalonPrinters,
  listSalonPrintersWithApiKey,
} = vi.hoisted(() => ({
  createPrintJob: vi.fn(),
  createPrintJobWithApiKey: vi.fn(),
  getConfig: vi.fn(),
  getSecureApiKey: vi.fn(),
  getSecureAuthToken: vi.fn(),
  listPrinterAssignments: vi.fn(),
  listPrinterAssignmentsWithApiKey: vi.fn(),
  listSalonPrinters: vi.fn(),
  listSalonPrintersWithApiKey: vi.fn(),
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
    listSalonPrinters = listSalonPrinters;
    listSalonPrintersWithApiKey = listSalonPrintersWithApiKey;
  },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getSharedFiscalPrinterStatus, submitSharedFiscalPrint } from '../src/main/printing/shared-fiscal-printer';

const receiptData: ReceiptData = {
  orderId: 'order-1',
  orderNumber: 'POS-1',
  items: [{ name: 'Tea', quantity: 1, unitPrice: 1200, totalPrice: 1200, vatRate: 23 }],
  payment: { method: 'CARD', amount: 1200 },
  subtotal: 1200,
  total: 1200,
};

const readyFiscalPrinter = {
  id: 'fiscal-printer-1',
  agentId: 'agent-pos-1',
  printerType: 'FISCAL',
  protocol: 'POSNET',
  displayName: 'POS1 fiscal',
  address: 'COM4',
  isEnabled: true,
  isOnline: true,
  agentIsOnline: true,
};

describe('submitSharedFiscalPrint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockReturnValue({ serverUrl: 'https://api.example.test', machineId: 'machine-2' });
    getSecureAuthToken.mockReturnValue('jwt-token');
    getSecureApiKey.mockReturnValue(null);
    listPrinterAssignments.mockResolvedValue({
      assignments: [{ role: 'FISCAL_RECEIPT', printerId: 'fiscal-printer-1' }],
    });
    listSalonPrinters.mockResolvedValue({ printers: [readyFiscalPrinter] });
  });

  it('reports a ready remote fiscal assignment as configured and connected', async () => {
    await expect(getSharedFiscalPrinterStatus()).resolves.toEqual({
      configured: true,
      connected: true,
      printerId: 'fiscal-printer-1',
    });
    expect(listPrinterAssignments).toHaveBeenCalledTimes(1);
    expect(listSalonPrinters).toHaveBeenCalledTimes(1);
  });

  it('uses the print-agent API key when no staff JWT is available', async () => {
    getSecureAuthToken.mockReturnValue(null);
    getSecureApiKey.mockReturnValue('pa_self_checkout');
    listPrinterAssignmentsWithApiKey.mockResolvedValue({
      assignments: [{ role: 'FISCAL_RECEIPT', printerId: 'fiscal-printer-1' }],
    });
    listSalonPrintersWithApiKey.mockResolvedValue({ printers: [readyFiscalPrinter] });
    createPrintJobWithApiKey.mockResolvedValue({ jobId: 'job-api-key', status: 'COMPLETED', sent: true });

    const result = await submitSharedFiscalPrint(receiptData, {
      referenceType: 'POS_FISCAL_RECEIPT',
      referenceId: 'order-1',
      source: 'self-checkout',
    });

    expect(result).toMatchObject({
      handled: true,
      printed: true,
      printerId: 'fiscal-printer-1',
      jobId: 'job-api-key',
      status: 'COMPLETED',
    });
    expect(listPrinterAssignmentsWithApiKey).toHaveBeenCalledWith('pa_self_checkout', 'machine-2');
    expect(listSalonPrintersWithApiKey).toHaveBeenCalledWith('pa_self_checkout', {}, 'machine-2');
    expect(createPrintJobWithApiKey).toHaveBeenCalledWith(
      'pa_self_checkout',
      expect.objectContaining({
        printerType: PrinterType.FISCAL,
        printerId: 'fiscal-printer-1',
        waitForCompletion: true,
      }),
      'machine-2',
    );
  });

  it('posts a FISCAL receipt job and prints only after final COMPLETED', async () => {
    createPrintJob.mockResolvedValue({ jobId: 'job-1', status: 'COMPLETED', sent: true });

    const result = await submitSharedFiscalPrint(receiptData, {
      referenceType: 'POS_FISCAL_RECEIPT',
      referenceId: 'order-1',
      source: 'pos',
    });

    expect(result).toMatchObject({
      handled: true,
      printed: true,
      printerId: 'fiscal-printer-1',
      jobId: 'job-1',
      status: 'COMPLETED',
    });
    expect(createPrintJob).toHaveBeenCalledWith(
      'jwt-token',
      expect.objectContaining({
        jobType: PrintJobType.RECEIPT,
        printerType: PrinterType.FISCAL,
        printerId: 'fiscal-printer-1',
        referenceType: 'POS_FISCAL_RECEIPT',
        referenceId: 'order-1',
        waitForCompletion: true,
        timeoutMs: 60000,
        payload: receiptData,
      }),
    );
    expect(createPrintJob.mock.calls[0][1]).not.toHaveProperty('openDrawer');
  });

  it('fails closed when the backend only reports sent=true without final completion', async () => {
    createPrintJob.mockResolvedValue({ jobId: 'job-1', sent: true });

    const result = await submitSharedFiscalPrint(receiptData, {
      referenceType: 'POS_FISCAL_RECEIPT',
      referenceId: 'order-1',
    });

    expect(result).toMatchObject({
      handled: true,
      printed: false,
      printerId: 'fiscal-printer-1',
      jobId: 'job-1',
    });
    expect(result.error).toContain('final COMPLETED');
  });

  it('fails closed when the final fiscal result is FAILED or TIMEOUT', async () => {
    createPrintJob.mockResolvedValue({ jobId: 'job-timeout', status: 'TIMEOUT', message: 'POS1 did not answer' });

    const result = await submitSharedFiscalPrint(receiptData, {
      referenceType: 'POS_FISCAL_RECEIPT',
      referenceId: 'order-1',
    });

    expect(result).toMatchObject({
      handled: true,
      printed: false,
      status: 'TIMEOUT',
    });
    expect(result.error).toContain('timeout');
  });

  it('does not route through a non-fiscal or not-ready assignment', async () => {
    listSalonPrinters.mockResolvedValue({
      printers: [{ ...readyFiscalPrinter, printerType: 'RECEIPT' }],
    });

    const result = await submitSharedFiscalPrint(receiptData);

    expect(result).toMatchObject({
      handled: true,
      printed: false,
      printerId: 'fiscal-printer-1',
    });
    expect(createPrintJob).not.toHaveBeenCalled();
  });
});
