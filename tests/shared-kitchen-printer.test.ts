import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrintJobType, PrinterType, type KitchenTicketData } from '../src/shared/types';

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

import { submitSharedKitchenPrint, submitSharedPickupSlip } from '../src/main/printing/shared-kitchen-printer';

const ticket: KitchenTicketData = {
  orderId: 'kso-1',
  orderNumber: 'K-001',
  createdAt: '2026-06-18T10:00:00.000Z',
  source: 'KIOSK PC-YURI',
  items: [{ name: 'Pho', quantity: 1 }],
};

const readyKitchenPrinter = {
  id: 'kitchen-printer-1',
  agentId: 'agent-pos-1',
  printerType: 'KITCHEN',
  protocol: 'THERMAL',
  displayName: 'Kitchen printer',
  windowsPrinterName: 'Kitchen Epson',
  isEnabled: true,
  isOnline: true,
  agentIsOnline: true,
};

describe('submitSharedKitchenPrint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockReturnValue({ serverUrl: 'https://api.example.test', machineId: 'machine-2' });
    getSecureAuthToken.mockReturnValue('jwt-token');
    getSecureApiKey.mockReturnValue(null);
    listPrinterAssignments.mockResolvedValue({
      assignments: [{ role: 'KITCHEN', printerId: 'kitchen-printer-1' }],
    });
    listSalonPrinters.mockResolvedValue({ printers: [readyKitchenPrinter] });
  });

  it('posts a non-blocking kitchen ticket job and treats accepted jobs as released', async () => {
    createPrintJob.mockResolvedValue({ jobId: 'job-1', status: 'QUEUED', sent: true });

    const result = await submitSharedKitchenPrint(ticket);

    expect(result).toMatchObject({
      handled: true,
      printed: true,
      printerId: 'kitchen-printer-1',
      jobId: 'job-1',
      status: 'QUEUED',
    });
    expect(createPrintJob).toHaveBeenCalledWith(
      'jwt-token',
      expect.objectContaining({
        jobType: PrintJobType.KITCHEN_TICKET,
        printerType: PrinterType.KITCHEN,
        printerId: 'kitchen-printer-1',
        referenceType: 'KITCHEN_TICKET',
        referenceId: 'kso-1',
        waitForCompletion: false,
        payload: ticket,
      }),
    );
    expect(createPrintJob.mock.calls[0][1]).not.toHaveProperty('timeoutMs');
  });

  it('does not release the customer slip when the backend rejects the kitchen job', async () => {
    createPrintJob.mockResolvedValue({ jobId: 'job-1', status: 'FAILED', sent: true, message: 'offline' });

    const result = await submitSharedKitchenPrint(ticket);

    expect(result).toMatchObject({
      handled: true,
      printed: false,
      printerId: 'kitchen-printer-1',
      jobId: 'job-1',
      status: 'FAILED',
    });
    expect(result.error).toContain('failed');
  });

  it('keeps the shared pickup slip route blocking so unrelated receipt-slip behavior is unchanged', async () => {
    listPrinterAssignments.mockResolvedValue({
      assignments: [{ role: 'SELF_CHECKOUT_RECEIPT', printerId: 'receipt-printer-1' }],
    });
    listSalonPrinters.mockResolvedValue({
      printers: [{
        ...readyKitchenPrinter,
        id: 'receipt-printer-1',
        printerType: 'RECEIPT',
        displayName: 'Receipt printer',
      }],
    });
    createPrintJob.mockResolvedValue({ jobId: 'job-2', status: 'COMPLETED', sent: true });

    const result = await submitSharedPickupSlip(ticket);

    expect(result).toMatchObject({
      handled: true,
      printed: true,
      printerId: 'receipt-printer-1',
      jobId: 'job-2',
      status: 'COMPLETED',
    });
    expect(createPrintJob).toHaveBeenCalledWith(
      'jwt-token',
      expect.objectContaining({
        printerType: PrinterType.RECEIPT,
        printerId: 'receipt-printer-1',
        waitForCompletion: true,
        timeoutMs: 30000,
      }),
    );
  });
});
