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

// Keep the retry policy real but make waits instant so terminal-status polls
// run without wall-clock delays.
vi.mock('../src/main/printing/shared-print-retry-policy', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, delay: () => Promise.resolve() };
});

import {
  resetSharedReceiptResumeRegistry,
  submitSharedReceiptPrint,
} from '../src/main/printing/shared-receipt-printer';

function receiptFor(orderId: string): any {
  return {
    orderId,
    orderNumber: `ZAM-${orderId}`,
    items: [{ name: 'Pho', quantity: 1, price: 10 }],
    payment: { method: 'CASH', amount: 10 },
    total: 10,
  };
}

const POS_RECEIPT_META = { referenceType: 'POS_RECEIPT', source: 'test' };

beforeEach(() => {
  vi.clearAllMocks();
  resetSharedReceiptResumeRegistry();
  listPrinterAssignments.mockResolvedValue({
    assignments: [{ role: 'SELF_CHECKOUT_RECEIPT', printerId: 'PRN-POS1' }],
  });
});

describe('submitSharedReceiptPrint — in-flight polling (POS2 timeout bug)', () => {
  it('polls a job that outlives the backend hold to COMPLETED instead of failing', async () => {
    createPrintJob.mockResolvedValue({ jobId: 'JOB-A', status: 'SENT' });
    getPrintJobStatus
      .mockResolvedValueOnce({ jobId: 'JOB-A', status: 'PRINTING' })
      .mockResolvedValueOnce({ jobId: 'JOB-A', status: 'PRINTING' })
      .mockResolvedValue({ jobId: 'JOB-A', status: 'COMPLETED' });

    const result = await submitSharedReceiptPrint(receiptFor('ORD-A'), POS_RECEIPT_META);

    expect(result.printed).toBe(true);
    expect(result.jobId).toBe('JOB-A');
    expect(getPrintJobStatus.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('submitSharedReceiptPrint — same-session resume (POS2 409 bug)', () => {
  it('re-submitting the same order polls the known job instead of re-creating', async () => {
    createPrintJob.mockResolvedValue({ jobId: 'JOB-B', status: 'SENT' });
    getPrintJobStatus.mockResolvedValue({ jobId: 'JOB-B', status: 'COMPLETED' });

    const first = await submitSharedReceiptPrint(receiptFor('ORD-B'), POS_RECEIPT_META);
    expect(first.printed).toBe(true);
    expect(createPrintJob).toHaveBeenCalledTimes(1);

    const second = await submitSharedReceiptPrint(receiptFor('ORD-B'), POS_RECEIPT_META);
    expect(second.printed).toBe(true);
    expect(second.jobId).toBe('JOB-B');
    // The whole point: no second create — that is what 409'd in production.
    expect(createPrintJob).toHaveBeenCalledTimes(1);
  });

  it('surfaces an idempotency 409 as operator guidance, without blind retries', async () => {
    createPrintJob.mockRejectedValue(
      new Error('409 Conflict: same idempotencyKey was already used with a different print job'),
    );

    const result = await submitSharedReceiptPrint(receiptFor('ORD-C'), POS_RECEIPT_META);

    expect(result.handled).toBe(true);
    expect(result.printed).toBe(false);
    expect(result.error).toMatch(/already exists/i);
    expect(createPrintJob).toHaveBeenCalledTimes(1);
  });

  it('reprints stay keyless and skip the resume registry', async () => {
    createPrintJob.mockResolvedValue({ jobId: 'JOB-D', sent: true });

    const receipt = { ...receiptFor('ORD-D'), isReprint: true };
    const result = await submitSharedReceiptPrint(receipt, {
      referenceType: 'POS_RECEIPT_REPRINT',
      referenceId: 'ORD-D',
      source: 'pos-reprint',
    });

    expect(result.printed).toBe(true);
    const body = createPrintJob.mock.calls[0][1];
    expect(body.idempotencyKey).toBeUndefined();
    expect(body.waitForCompletion).toBeUndefined();
    expect(body.referenceType).toBe('POS_RECEIPT_REPRINT');
  });
});
