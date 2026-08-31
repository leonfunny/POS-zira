import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrintJobType, PrinterType, ReceiptData } from '../src/shared/types';

const {
  createPrintJob,
  createPrintJobWithApiKey,
  getPrintJobStatus,
  getPrintJobStatusWithApiKey,
  getConfig,
  getSecureApiKey,
  getSecureAuthToken,
  listPrinterAssignments,
  listPrinterAssignmentsWithApiKey,
  listSalonPrinters,
  listSalonPrintersWithApiKey,
  safeRetryPrintJob,
  safeRetryPrintJobWithApiKey,
  fiscalAttemptRepo,
} = vi.hoisted(() => ({
  createPrintJob: vi.fn(),
  createPrintJobWithApiKey: vi.fn(),
  getPrintJobStatus: vi.fn(),
  getPrintJobStatusWithApiKey: vi.fn(),
  getConfig: vi.fn(),
  getSecureApiKey: vi.fn(),
  getSecureAuthToken: vi.fn(),
  listPrinterAssignments: vi.fn(),
  listPrinterAssignmentsWithApiKey: vi.fn(),
  listSalonPrinters: vi.fn(),
  listSalonPrintersWithApiKey: vi.fn(),
  safeRetryPrintJob: vi.fn(),
  safeRetryPrintJobWithApiKey: vi.fn(),
  fiscalAttemptRepo: {
    findLatestRemoteByOrder: vi.fn(),
    getNextAttemptNo: vi.fn(),
    createPending: vi.fn(),
    markSent: vi.fn(),
    markSuccess: vi.fn(),
    markFailed: vi.fn(),
    markUnknown: vi.fn(),
    flush: vi.fn(),
  },
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
    getPrintJobStatus = getPrintJobStatus;
    getPrintJobStatusWithApiKey = getPrintJobStatusWithApiKey;
    listPrinterAssignments = listPrinterAssignments;
    listPrinterAssignmentsWithApiKey = listPrinterAssignmentsWithApiKey;
    listSalonPrinters = listSalonPrinters;
    listSalonPrintersWithApiKey = listSalonPrintersWithApiKey;
    safeRetryPrintJob = safeRetryPrintJob;
    safeRetryPrintJobWithApiKey = safeRetryPrintJobWithApiKey;
  },
}));

vi.mock('../src/main/database/repos/fiscal-attempt-repo', () => ({ fiscalAttemptRepo }));

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
    fiscalAttemptRepo.findLatestRemoteByOrder.mockReturnValue(null);
    fiscalAttemptRepo.getNextAttemptNo.mockReturnValue(1);
    fiscalAttemptRepo.createPending.mockImplementation((input: any) => ({
      id: 'remote-attempt-1',
      order_id: input.orderId,
      payment_id: null,
      attempt_no: input.attemptNo,
      idempotency_key: input.idempotencyKey,
      printer_type: input.printerType,
      payload_json: input.payloadJson,
      payload_hash: input.payloadHash,
      status: 'PENDING',
      result_json: null,
      error_code: null,
      created_at: null,
      sent_at: null,
      resolved_at: null,
    }));
    fiscalAttemptRepo.flush.mockResolvedValue({ success: true });
  });

  it('reports a ready remote fiscal assignment as configured and connected', async () => {
    await expect(getSharedFiscalPrinterStatus()).resolves.toEqual({
      configured: true,
      connected: true,
      printerId: 'fiscal-printer-1',
      protocol: 'POSNET',
    });
    expect(listPrinterAssignments).toHaveBeenCalledTimes(1);
    expect(listSalonPrinters).toHaveBeenCalledTimes(1);
  });

  it.each([
    [' posnet ', 'POSNET'],
    ['elzab', 'ELZAB_STX'],
    ['stx', 'ELZAB_STX'],
    ['vendor-specific', null],
  ])('normalizes shared fiscal protocol %j to %j', async (rawProtocol, expectedProtocol) => {
    listSalonPrinters.mockResolvedValue({
      printers: [{ ...readyFiscalPrinter, protocol: rawProtocol }],
    });

    await expect(getSharedFiscalPrinterStatus()).resolves.toMatchObject({
      configured: true,
      connected: true,
      printerId: 'fiscal-printer-1',
      protocol: expectedProtocol,
    });
  });

  it('preserves the normalized protocol when the resolved fiscal printer is not ready', async () => {
    listSalonPrinters.mockResolvedValue({
      printers: [{ ...readyFiscalPrinter, protocol: 'ELZAB-STX', isOnline: false }],
    });

    await expect(getSharedFiscalPrinterStatus()).resolves.toMatchObject({
      configured: false,
      connected: false,
      printerId: 'fiscal-printer-1',
      protocol: 'ELZAB_STX',
    });
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
        idempotencyKey: 'pos-fiscal:machine-2:order-1:default:v1',
        payload: receiptData,
      }),
    );
    expect(createPrintJob.mock.calls[0][1]).not.toHaveProperty('openDrawer');
    expect(fiscalAttemptRepo.markSuccess).toHaveBeenCalledWith(
      'remote-attempt-1',
      expect.objectContaining({
        remote: true,
        jobId: 'job-1',
        printerId: 'fiscal-printer-1',
        printed: true,
      }),
    );
  });

  it('auto retries fiscal only after backend reports SAFE_BEFORE_PRINT', async () => {
    vi.useFakeTimers();
    try {
      createPrintJob.mockResolvedValue({
        jobId: 'job-safe',
        status: 'FAILED',
        failureClass: 'SAFE_BEFORE_PRINT',
        retryAllowed: true,
        sent: false,
      });
      safeRetryPrintJob.mockResolvedValue({
        jobId: 'job-safe',
        status: 'SENT',
        retryAllowed: true,
        sent: true,
      });
      getPrintJobStatus.mockResolvedValue({
        jobId: 'job-safe',
        status: 'COMPLETED',
        retryAllowed: false,
        sent: false,
      });

      const pending = submitSharedFiscalPrint(receiptData, {
        referenceType: 'POS_FISCAL_RECEIPT',
        referenceId: 'order-1',
        source: 'pos',
      });
      await vi.advanceTimersByTimeAsync(2000);
      const result = await pending;

      expect(result).toMatchObject({ handled: true, printed: true, jobId: 'job-safe' });
      expect(safeRetryPrintJob).toHaveBeenCalledWith('jwt-token', 'job-safe', 'POS fiscal auto-retry #1');
      expect(getPrintJobStatus).toHaveBeenCalledWith('jwt-token', 'job-safe');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto retry fiscal TIMEOUT responses', async () => {
    createPrintJob.mockResolvedValue({
      jobId: 'job-timeout',
      status: 'TIMEOUT',
      timedOut: true,
      retryAllowed: false,
      message: 'POS1 did not answer',
    });

    const result = await submitSharedFiscalPrint(receiptData, {
      referenceType: 'POS_FISCAL_RECEIPT',
      referenceId: 'order-1',
    });

    expect(result).toMatchObject({
      handled: true,
      printed: false,
      status: 'TIMEOUT',
    });
    expect(safeRetryPrintJob).not.toHaveBeenCalled();
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

  it('reuses the durable first payload when order sync changes the displayed order number', async () => {
    const originalReceipt = { ...receiptData, orderNumber: 'POS-20260830-0005' };
    fiscalAttemptRepo.findLatestRemoteByOrder.mockReturnValue({
      id: 'remote-attempt-old',
      order_id: 'order-1',
      payment_id: null,
      attempt_no: 1,
      idempotency_key: 'pos-fiscal:machine-2:order-1:default:v1',
      printer_type: 'REMOTE',
      payload_json: JSON.stringify(originalReceipt),
      payload_hash: 'sha256:old',
      status: 'UNKNOWN_NEEDS_RECONCILIATION',
      result_json: null,
      error_code: null,
      created_at: null,
      sent_at: null,
      resolved_at: null,
    });
    createPrintJob.mockResolvedValue({ jobId: 'job-original', status: 'COMPLETED', sent: true });

    const result = await submitSharedFiscalPrint(
      { ...receiptData, orderNumber: 'POS260830-0052' },
      { referenceType: 'POS_FISCAL_RECEIPT', referenceId: 'order-1' },
    );

    expect(result).toMatchObject({ printed: true, jobId: 'job-original' });
    expect(createPrintJob).toHaveBeenCalledWith(
      'jwt-token',
      expect.objectContaining({
        idempotencyKey: 'pos-fiscal:machine-2:order-1:default:v1',
        payload: originalReceipt,
      }),
    );
  });

  it('resumes a durable failed job by job id instead of creating a changed job', async () => {
    fiscalAttemptRepo.findLatestRemoteByOrder.mockReturnValue({
      id: 'remote-attempt-known',
      order_id: 'order-1',
      payment_id: null,
      attempt_no: 1,
      idempotency_key: 'pos-fiscal:machine-2:order-1:default:v1',
      printer_type: 'REMOTE',
      payload_json: JSON.stringify({ ...receiptData, orderNumber: 'POS-20260830-0005' }),
      payload_hash: 'sha256:old',
      status: 'FAILED_CONFIRMED',
      result_json: JSON.stringify({ jobId: 'job-safe-old' }),
      error_code: 'REMOTE_SAFE_BEFORE_PRINT',
      created_at: null,
      sent_at: null,
      resolved_at: null,
    });
    getPrintJobStatus.mockResolvedValue({ jobId: 'job-safe-old', status: 'COMPLETED', sent: true });

    const result = await submitSharedFiscalPrint(
      { ...receiptData, orderNumber: 'POS260830-0052' },
      { referenceType: 'POS_FISCAL_RECEIPT', referenceId: 'order-1' },
    );

    expect(result).toMatchObject({ printed: true, jobId: 'job-safe-old' });
    expect(getPrintJobStatus).toHaveBeenCalledWith('jwt-token', 'job-safe-old');
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it('does not dispatch a fiscal job until its immutable attempt is durable', async () => {
    fiscalAttemptRepo.flush.mockResolvedValue({ success: false, error: 'disk busy' });

    const result = await submitSharedFiscalPrint(receiptData, {
      referenceType: 'POS_FISCAL_RECEIPT',
      referenceId: 'order-1',
    });

    expect(result).toMatchObject({ handled: true, printed: false });
    expect(result.error).toContain('Cannot persist remote fiscal attempt');
    expect(createPrintJob).not.toHaveBeenCalled();
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
