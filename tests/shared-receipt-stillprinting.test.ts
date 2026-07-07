import { describe, it, expect, vi, beforeEach } from 'vitest';

const listPrinterAssignments = vi.fn();
const createPrintJob = vi.fn();
const getPrintJobStatus = vi.fn();
const safeRetryPrintJob = vi.fn();

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/config/store', () => ({
  getConfig: () => ({ serverUrl: 'https://api.test', machineId: 'pos2-machine' }),
  getSecureAuthToken: () => 'jwt-token',
  getSecureApiKey: () => null,
}));

vi.mock('../src/main/network/api-client', () => ({
  ApiClient: class {
    listPrinterAssignments = listPrinterAssignments;
    createPrintJob = createPrintJob;
    getPrintJobStatus = getPrintJobStatus;
    safeRetryPrintJob = safeRetryPrintJob;
  },
}));

// Zero wait budget: a job that is still in flight when the budget is spent
// must come back as stillPrinting, not as a generic printer failure.
vi.mock('../src/main/printing/shared-print-retry-policy', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, delay: () => Promise.resolve(), SHARED_RECEIPT_TOTAL_WAIT_MS: 0 };
});

import {
  resetSharedReceiptResumeRegistry,
  submitSharedReceiptPrint,
} from '../src/main/printing/shared-receipt-printer';

beforeEach(() => {
  vi.clearAllMocks();
  resetSharedReceiptResumeRegistry();
  listPrinterAssignments.mockResolvedValue({
    assignments: [{ role: 'SELF_CHECKOUT_RECEIPT', printerId: 'PRN-POS1' }],
  });
});

describe('submitSharedReceiptPrint — wait budget exhausted', () => {
  it('reports stillPrinting instead of a hard failure when the job is not terminal', async () => {
    createPrintJob.mockResolvedValue({ jobId: 'JOB-Z', status: 'SENT' });

    const result = await submitSharedReceiptPrint(
      {
        orderId: 'ORD-Z',
        orderNumber: 'ZAM-Z',
        items: [{ name: 'Che', quantity: 1, price: 5 }],
        payment: { method: 'CASH', amount: 5 },
        total: 5,
      } as any,
      { referenceType: 'POS_RECEIPT', source: 'test' },
    );

    expect(result.printed).toBe(false);
    expect(result.stillPrinting).toBe(true);
    expect(result.jobId).toBe('JOB-Z');
    expect(result.error).toMatch(/still printing/i);
  });
});
