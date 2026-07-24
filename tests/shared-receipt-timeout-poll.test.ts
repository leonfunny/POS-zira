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

// Instant polls: keep the real 30s wait budget but skip the 1s sleeps.
vi.mock('../src/main/printing/shared-print-retry-policy', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, delay: () => Promise.resolve() };
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

describe('submitSharedReceiptPrint — backend wait expiry', () => {
  it('polls the in-flight job after a backend TIMEOUT response and reports the completed print', async () => {
    // Chesaigon POS1 receipts take 13-19s while the backend hold is 10s: the
    // create call answers status=TIMEOUT/timedOut while the paper is still
    // feeding. The old classify treated that as terminal, so ~95% of POS2
    // receipts surfaced as failures that a retry merely rediscovered
    // (2026-07-24).
    createPrintJob.mockResolvedValue({ jobId: 'JOB-T', status: 'TIMEOUT', timedOut: true, retryAllowed: false });
    getPrintJobStatus
      .mockResolvedValueOnce({ jobId: 'JOB-T', status: 'PRINTING' })
      .mockResolvedValue({ jobId: 'JOB-T', status: 'COMPLETED' });

    const result = await submitSharedReceiptPrint(
      {
        orderId: 'ORD-T',
        orderNumber: 'ZAM-T',
        items: [{ name: 'Che', quantity: 1, price: 5 }],
        payment: { method: 'CASH', amount: 5 },
        total: 5,
      } as any,
      { referenceType: 'POS_RECEIPT', source: 'pos' },
    );

    expect(result.printed).toBe(true);
    expect(result.jobId).toBe('JOB-T');
    expect(result.status).toBe('COMPLETED');
    expect(getPrintJobStatus).toHaveBeenCalled();
    expect(createPrintJob).toHaveBeenCalledTimes(1);
  });
});
