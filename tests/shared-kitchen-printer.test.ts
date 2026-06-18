import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';
import { PrintJobType, PrinterType, type KitchenTicketData } from '../src/shared/types';

const {
  createPrintJob,
  createPrintJobWithApiKey,
  dispatchLanFirstPrintJobWithApiKey,
  fetchMock,
  getConfig,
  getSecureApiKey,
  getSecureAuthToken,
  listPrinterAssignments,
  listPrinterAssignmentsWithApiKey,
  listSalonPrinters,
  listSalonPrintersWithApiKey,
  reserveLanFirstPrintJobWithApiKey,
} = vi.hoisted(() => ({
  createPrintJob: vi.fn(),
  createPrintJobWithApiKey: vi.fn(),
  dispatchLanFirstPrintJobWithApiKey: vi.fn(),
  fetchMock: vi.fn(),
  getConfig: vi.fn(),
  getSecureApiKey: vi.fn(),
  getSecureAuthToken: vi.fn(),
  listPrinterAssignments: vi.fn(),
  listPrinterAssignmentsWithApiKey: vi.fn(),
  listSalonPrinters: vi.fn(),
  listSalonPrintersWithApiKey: vi.fn(),
  reserveLanFirstPrintJobWithApiKey: vi.fn(),
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
    dispatchLanFirstPrintJobWithApiKey = dispatchLanFirstPrintJobWithApiKey;
    listPrinterAssignments = listPrinterAssignments;
    listPrinterAssignmentsWithApiKey = listPrinterAssignmentsWithApiKey;
    listSalonPrinters = listSalonPrinters;
    listSalonPrintersWithApiKey = listSalonPrintersWithApiKey;
    reserveLanFirstPrintJobWithApiKey = reserveLanFirstPrintJobWithApiKey;
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
  machineId: 'target-machine-1',
  isEnabled: true,
  isOnline: true,
  agentIsOnline: true,
};
const LAN_SHARED_SECRET = 'test-lan-secret';

function lanResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('submitSharedKitchenPrint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getConfig.mockReturnValue({ serverUrl: 'https://api.example.test', machineId: 'machine-2' });
    getSecureAuthToken.mockReturnValue('jwt-token');
    getSecureApiKey.mockReturnValue(null);
    listPrinterAssignments.mockResolvedValue({
      assignments: [{ role: 'KITCHEN', printerId: 'kitchen-printer-1' }],
    });
    listSalonPrinters.mockResolvedValue({ printers: [readyKitchenPrinter] });
    listPrinterAssignmentsWithApiKey.mockResolvedValue({
      assignments: [{ role: 'KITCHEN', printerId: 'kitchen-printer-1' }],
    });
    listSalonPrintersWithApiKey.mockResolvedValue({ printers: [readyKitchenPrinter] });
    reserveLanFirstPrintJobWithApiKey.mockResolvedValue({ jobId: 'reserved-job-1', status: 'RESERVED' });
    dispatchLanFirstPrintJobWithApiKey.mockImplementation(async (_apiKey: string, jobId: string) => ({
      jobId,
      status: 'QUEUED',
      sent: true,
    }));
  });

  it('keeps the LAN_FIRST sender disabled by default and uses the existing create-job path', async () => {
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
    expect(reserveLanFirstPrintJobWithApiKey).not.toHaveBeenCalled();
    expect(dispatchLanFirstPrintJobWithApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('when LAN_FIRST sender is enabled without a LAN target, skips LAN_FIRST and uses the existing create-job path', async () => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {},
      },
    });
    getSecureAuthToken.mockReturnValue('jwt-token');
    getSecureApiKey.mockReturnValue('api-key-1');
    createPrintJob.mockResolvedValue({ jobId: 'legacy-job-no-lan-target', status: 'QUEUED', sent: true });

    const result = await submitSharedKitchenPrint(ticket);

    expect(result).toMatchObject({
      handled: true,
      printed: true,
      printerId: 'kitchen-printer-1',
      jobId: 'legacy-job-no-lan-target',
      status: 'QUEUED',
    });
    expect(createPrintJob).toHaveBeenCalledWith(
      'jwt-token',
      expect.objectContaining({
        jobType: PrintJobType.KITCHEN_TICKET,
        printerType: PrinterType.KITCHEN,
        printerId: 'kitchen-printer-1',
      }),
    );
    expect(reserveLanFirstPrintJobWithApiKey).not.toHaveBeenCalled();
    expect(dispatchLanFirstPrintJobWithApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('when LAN_FIRST sender is enabled without a shared secret, skips LAN_FIRST and uses the existing create-job path', async () => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue('jwt-token');
    getSecureApiKey.mockReturnValue('api-key-1');
    createPrintJob.mockResolvedValue({ jobId: 'legacy-job-no-lan-secret', status: 'QUEUED', sent: true });

    const result = await submitSharedKitchenPrint(ticket);

    expect(result).toMatchObject({
      handled: true,
      printed: true,
      printerId: 'kitchen-printer-1',
      jobId: 'legacy-job-no-lan-secret',
      status: 'QUEUED',
    });
    expect(reserveLanFirstPrintJobWithApiKey).not.toHaveBeenCalled();
    expect(dispatchLanFirstPrintJobWithApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createPrintJob).toHaveBeenCalledWith(
      'jwt-token',
      expect.objectContaining({
        jobType: PrintJobType.KITCHEN_TICKET,
        printerType: PrinterType.KITCHEN,
        printerId: 'kitchen-printer-1',
      }),
    );
  });

  it('uses a deterministic LAN_FIRST idempotencyKey for identical normal kitchen tickets', async () => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue(null);
    getSecureApiKey.mockReturnValue('api-key-1');
    fetchMock.mockImplementation(async () => lanResponse({ success: true, status: 'COMPLETED' }));

    await submitSharedKitchenPrint(ticket);
    await submitSharedKitchenPrint(ticket);

    const firstReserveBody = reserveLanFirstPrintJobWithApiKey.mock.calls[0][1];
    const secondReserveBody = reserveLanFirstPrintJobWithApiKey.mock.calls[1][1];
    expect(secondReserveBody.idempotencyKey).toBe(firstReserveBody.idempotencyKey);
    expect(firstReserveBody.idempotencyKey).toBe(
      `kitchen-ticket:${ticket.orderId}:kitchen-printer-1:${firstReserveBody.payloadHash}`,
    );
  });

  it('uses a fresh LAN_FIRST idempotencyKey for manual kitchen ticket reprints', async () => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue(null);
    getSecureApiKey.mockReturnValue('api-key-1');
    fetchMock.mockImplementation(async () => lanResponse({ success: true, status: 'COMPLETED' }));

    await submitSharedKitchenPrint({ ...ticket, isReprint: true });
    await submitSharedKitchenPrint({ ...ticket, isReprint: true });

    const firstReserveBody = reserveLanFirstPrintJobWithApiKey.mock.calls[0][1];
    const secondReserveBody = reserveLanFirstPrintJobWithApiKey.mock.calls[1][1];
    expect(firstReserveBody.idempotencyKey).toMatch(
      /^kitchen-ticket-reprint:kso-1:kitchen-printer-1:[0-9a-f-]+$/,
    );
    expect(secondReserveBody.idempotencyKey).toMatch(
      /^kitchen-ticket-reprint:kso-1:kitchen-printer-1:[0-9a-f-]+$/,
    );
    expect(secondReserveBody.idempotencyKey).not.toBe(firstReserveBody.idempotencyKey);
  });

  it('when LAN_FIRST sender is enabled and LAN succeeds, it does not backend-dispatch', async () => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue(null);
    getSecureApiKey.mockReturnValue('api-key-1');
    fetchMock.mockResolvedValueOnce(lanResponse({ success: true, status: 'COMPLETED' }));

    const result = await submitSharedKitchenPrint(ticket);

    expect(result).toMatchObject({
      handled: true,
      printed: true,
      printerId: 'kitchen-printer-1',
      status: 'COMPLETED',
    });
    expect(reserveLanFirstPrintJobWithApiKey).toHaveBeenCalledTimes(1);
    const fetchOptions = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string>; body: string };
    const timestamp = fetchOptions.headers['x-zira-lan-first-timestamp'];
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17892/print/kitchen-ticket',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-zira-lan-first-machine-id': 'machine-2',
          'x-zira-lan-first-timestamp': expect.any(String),
          'x-zira-lan-first-signature': expect.any(String),
        }),
      }),
    );
    expect(fetchOptions.headers['x-zira-lan-first-signature']).toBe(
      createHmac('sha256', LAN_SHARED_SECRET)
        .update(`${timestamp}.${fetchOptions.body}`)
        .digest('hex'),
    );
    expect(dispatchLanFirstPrintJobWithApiKey).not.toHaveBeenCalled();
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it('uses the backend reserve jobId for the LAN POST body and result', async () => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue(null);
    getSecureApiKey.mockReturnValue('api-key-1');
    reserveLanFirstPrintJobWithApiKey.mockResolvedValueOnce({ jobId: 'backend-existing-job-1', status: 'RESERVED' });
    fetchMock.mockResolvedValueOnce(lanResponse({ success: true, status: 'COMPLETED' }));

    const result = await submitSharedKitchenPrint(ticket);

    const initialReserveBody = reserveLanFirstPrintJobWithApiKey.mock.calls[0][1];
    const lanBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(initialReserveBody.jobId).not.toBe('backend-existing-job-1');
    expect(lanBody.jobId).toBe('backend-existing-job-1');
    expect(result.jobId).toBe('backend-existing-job-1');
    expect(dispatchLanFirstPrintJobWithApiKey).not.toHaveBeenCalled();
  });

  it('when LAN_FIRST reserve throws before LAN is attempted, it falls back to the existing create-job path', async () => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue('jwt-token');
    getSecureApiKey.mockReturnValue('api-key-1');
    reserveLanFirstPrintJobWithApiKey.mockRejectedValueOnce(new Error('reserve unavailable'));
    createPrintJob.mockResolvedValue({ jobId: 'legacy-job-1', status: 'QUEUED', sent: true });

    const result = await submitSharedKitchenPrint(ticket);

    expect(result).toMatchObject({
      handled: true,
      printed: true,
      printerId: 'kitchen-printer-1',
      jobId: 'legacy-job-1',
      status: 'QUEUED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dispatchLanFirstPrintJobWithApiKey).not.toHaveBeenCalled();
    expect(createPrintJob).toHaveBeenCalledWith(
      'jwt-token',
      expect.objectContaining({
        jobType: PrintJobType.KITCHEN_TICKET,
        printerType: PrinterType.KITCHEN,
        printerId: 'kitchen-printer-1',
      }),
    );
  });

  it('when LAN_FIRST sender times out on LAN, it backend-dispatches the reserved job', async () => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        timeoutMs: 10,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue(null);
    getSecureApiKey.mockReturnValue('api-key-1');
    fetchMock.mockRejectedValueOnce(new Error('LAN timeout'));

    await submitSharedKitchenPrint(ticket);

    const reserveBody = reserveLanFirstPrintJobWithApiKey.mock.calls[0][1];
    expect(dispatchLanFirstPrintJobWithApiKey).toHaveBeenCalledWith(
      'api-key-1',
      'reserved-job-1',
      expect.objectContaining({
        idempotencyKey: reserveBody.idempotencyKey,
        payloadHash: reserveBody.payloadHash,
        reason: 'LAN_NETWORK_ERROR',
      }),
      'machine-2',
    );
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it('when LAN is attempted and backend dispatch throws, it does not call the old create-job path', async () => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        timeoutMs: 10,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue('jwt-token');
    getSecureApiKey.mockReturnValue('api-key-1');
    fetchMock.mockRejectedValueOnce(new Error('LAN timeout'));
    dispatchLanFirstPrintJobWithApiKey.mockRejectedValueOnce(new Error('dispatch unavailable'));

    const result = await submitSharedKitchenPrint(ticket);

    expect(result).toMatchObject({
      handled: true,
      printed: false,
      printerId: 'kitchen-printer-1',
      jobId: 'reserved-job-1',
    });
    expect(result.error).toContain('dispatch unavailable');
    expect(createPrintJob).not.toHaveBeenCalled();
    expect(createPrintJobWithApiKey).not.toHaveBeenCalled();
  });

  it('when LAN reports SAFE_BEFORE_PRINT, it backend-dispatches the reserved job', async () => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue(null);
    getSecureApiKey.mockReturnValue('api-key-1');
    fetchMock.mockResolvedValueOnce(lanResponse({
      success: false,
      status: 'FAILED',
      failureClass: 'SAFE_BEFORE_PRINT',
      error: 'printer offline',
    }, 422));

    await submitSharedKitchenPrint(ticket);

    const reserveBody = reserveLanFirstPrintJobWithApiKey.mock.calls[0][1];
    expect(dispatchLanFirstPrintJobWithApiKey).toHaveBeenCalledWith(
      'api-key-1',
      'reserved-job-1',
      expect.objectContaining({
        idempotencyKey: reserveBody.idempotencyKey,
        payloadHash: reserveBody.payloadHash,
        reason: 'LAN_SAFE_BEFORE_PRINT',
      }),
      'machine-2',
    );
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it.each([403, 404])('when LAN returns HTTP %i without failureClass, it backend-dispatches fallback', async (statusCode) => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue(null);
    getSecureApiKey.mockReturnValue('api-key-1');
    fetchMock.mockResolvedValueOnce(lanResponse({
      success: false,
      error: 'not allowed',
    }, statusCode));

    await submitSharedKitchenPrint(ticket);

    const reserveBody = reserveLanFirstPrintJobWithApiKey.mock.calls[0][1];
    expect(dispatchLanFirstPrintJobWithApiKey).toHaveBeenCalledWith(
      'api-key-1',
      'reserved-job-1',
      expect.objectContaining({
        idempotencyKey: reserveBody.idempotencyKey,
        payloadHash: reserveBody.payloadHash,
        reason: `LAN_HTTP_${statusCode}`,
      }),
      'machine-2',
    );
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it('when LAN returns HTTP 200 with invalid JSON, it backend-dispatches fallback', async () => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue(null);
    getSecureApiKey.mockReturnValue('api-key-1');
    fetchMock.mockResolvedValueOnce(new Response('<html>not the LAN receiver</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }));

    await submitSharedKitchenPrint(ticket);

    const reserveBody = reserveLanFirstPrintJobWithApiKey.mock.calls[0][1];
    expect(dispatchLanFirstPrintJobWithApiKey).toHaveBeenCalledWith(
      'api-key-1',
      'reserved-job-1',
      expect.objectContaining({
        idempotencyKey: reserveBody.idempotencyKey,
        payloadHash: reserveBody.payloadHash,
        reason: 'LAN_UNEXPECTED_RESPONSE',
      }),
      'machine-2',
    );
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it.each([
    ['empty JSON', {}],
    ['unknown status', { success: true, status: 'QUEUED' }],
  ])('when LAN returns HTTP 200 with %s, it backend-dispatches fallback', async (_caseName, body) => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue(null);
    getSecureApiKey.mockReturnValue('api-key-1');
    fetchMock.mockResolvedValueOnce(lanResponse(body, 200));

    await submitSharedKitchenPrint(ticket);

    const reserveBody = reserveLanFirstPrintJobWithApiKey.mock.calls[0][1];
    expect(dispatchLanFirstPrintJobWithApiKey).toHaveBeenCalledWith(
      'api-key-1',
      'reserved-job-1',
      expect.objectContaining({
        idempotencyKey: reserveBody.idempotencyKey,
        payloadHash: reserveBody.payloadHash,
        reason: 'LAN_UNEXPECTED_RESPONSE',
      }),
      'machine-2',
    );
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it('when LAN returns HTTP 200 FAILED without failureClass, it does not mark the LAN response printed', async () => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue('jwt-token');
    getSecureApiKey.mockReturnValue('api-key-1');
    fetchMock.mockResolvedValueOnce(lanResponse({
      success: false,
      status: 'FAILED',
    }, 200));
    dispatchLanFirstPrintJobWithApiKey.mockRejectedValueOnce(new Error('dispatch unavailable'));

    const result = await submitSharedKitchenPrint(ticket);

    const reserveBody = reserveLanFirstPrintJobWithApiKey.mock.calls[0][1];
    expect(dispatchLanFirstPrintJobWithApiKey).toHaveBeenCalledWith(
      'api-key-1',
      'reserved-job-1',
      expect.objectContaining({
        idempotencyKey: reserveBody.idempotencyKey,
        payloadHash: reserveBody.payloadHash,
        reason: 'LAN_UNEXPECTED_RESPONSE',
      }),
      'machine-2',
    );
    expect(result).toMatchObject({
      handled: true,
      printed: false,
      printerId: 'kitchen-printer-1',
      jobId: 'reserved-job-1',
      status: 'FAILED',
    });
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it('when LAN reports UNCERTAIN_AFTER_PRINT, it does not backend-dispatch', async () => {
    getConfig.mockReturnValue({
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      lanFirstKitchenSender: {
        enabled: true,
        auth: { sharedSecret: LAN_SHARED_SECRET },
        targets: {
          'target-machine-1:kitchen-printer-1': { host: '127.0.0.1', port: 17892 },
        },
      },
    });
    getSecureAuthToken.mockReturnValue(null);
    getSecureApiKey.mockReturnValue('api-key-1');
    fetchMock.mockResolvedValueOnce(lanResponse({
      success: false,
      status: 'FAILED',
      failureClass: 'UNCERTAIN_AFTER_PRINT',
      error: 'write failed after spooler accepted bytes',
    }, 500));

    const result = await submitSharedKitchenPrint(ticket);

    expect(result).toMatchObject({
      handled: true,
      printed: false,
      printerId: 'kitchen-printer-1',
      status: 'FAILED',
    });
    expect(dispatchLanFirstPrintJobWithApiKey).not.toHaveBeenCalled();
    expect(createPrintJob).not.toHaveBeenCalled();
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
