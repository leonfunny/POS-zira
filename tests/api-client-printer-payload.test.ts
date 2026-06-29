import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/main/network/auth-refresh', () => ({
  refreshAccessToken: vi.fn(),
  AuthRefreshNetworkError: class AuthRefreshNetworkError extends Error {},
}));

import { ApiClient, printerMappingForTests } from '../src/main/network/api-client';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as any;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApiClient printer payload normalization', () => {
  it('keeps create payload compatible with backend CreatePrinterDto', () => {
    const payload = printerMappingForTests.normalizeAgentPrinterCreatePayload({
      displayName: 'Xprinter XP-80T',
      printerType: 'RECEIPT',
      protocol: 'WINDOWS',
      windowsPrinterName: 'Xprinter XP-80T [USB002]',
      address: null,
      baudRate: 9600,
      paperWidth: 80,
      paperHeight: null,
      charsPerLine: 48,
      supportsCut: true,
      supportsCashDrawer: true,
      isEnabled: true,
    });

    expect(payload).toEqual({
      displayName: 'Xprinter XP-80T',
      printerType: 'RECEIPT',
      protocol: 'WINDOWS',
      baudRate: 9600,
      paperWidth: 80,
      charsPerLine: 48,
      supportsCut: true,
      supportsCashDrawer: true,
    });
    expect(payload).not.toHaveProperty('isEnabled');
    expect(payload).not.toHaveProperty('windowsPrinterName');
    expect(payload).not.toHaveProperty('paperHeight');
  });

  it('keeps update payload for target binding and enablement without changing printer type', () => {
    const payload = printerMappingForTests.normalizeAgentPrinterUpdatePayload({
      displayName: 'Shared receipt',
      printerType: 'LABEL',
      protocol: 'WINDOWS',
      windowsPrinterName: 'Xprinter XP-80T [USB002]',
      address: null,
      paperWidth: 80,
      isEnabled: true,
    });

    expect(payload).toEqual({
      displayName: 'Shared receipt',
      protocol: 'WINDOWS',
      windowsPrinterName: 'Xprinter XP-80T [USB002]',
      address: null,
      paperWidth: 80,
      isEnabled: true,
    });
    expect(payload).not.toHaveProperty('printerType');
  });

  it('creates the row first, then updates target binding and enablement', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'printer-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'printer-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    await new ApiClient('https://api.test').createAgentPrinter('token-1', 'agent-1', {
      displayName: 'Shared receipt',
      printerType: 'RECEIPT',
      protocol: 'WINDOWS',
      windowsPrinterName: 'Xprinter XP-80T [USB002]',
      address: null,
      paperWidth: 80,
      charsPerLine: 48,
      supportsCut: true,
      supportsCashDrawer: true,
      isEnabled: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/api/v1/print-agent/agents/agent-1/printers');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.test/api/v1/print-agent/agents/agent-1/printers/printer-1');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      displayName: 'Shared receipt',
      printerType: 'RECEIPT',
      protocol: 'WINDOWS',
      paperWidth: 80,
      charsPerLine: 48,
      supportsCut: true,
      supportsCashDrawer: true,
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      displayName: 'Shared receipt',
      protocol: 'WINDOWS',
      windowsPrinterName: 'Xprinter XP-80T [USB002]',
      address: null,
      paperWidth: 80,
      charsPerLine: 48,
      supportsCut: true,
      supportsCashDrawer: true,
      isEnabled: true,
    });
  });
});

describe('ApiClient LAN_FIRST print-agent API-key methods', () => {
  const reserveBody = {
    jobId: 'job-1',
    idempotencyKey: 'idem-1',
    payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    dispatchMode: 'LAN_FIRST',
    sourceMachineId: 'pos-a',
    targetMachineId: 'pos-b',
    jobType: 'KITCHEN_TICKET',
    printerType: 'KITCHEN',
    printerId: 'printer-1',
    referenceType: 'KITCHEN_TICKET',
    referenceId: 'order-1',
    payload: { items: [] },
  };

  function mockJsonResponse(body: Record<string, unknown> = { ok: true }) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  it('reserves a LAN_FIRST job on the no-emit reserve endpoint with API-key machine auth', async () => {
    mockJsonResponse({ jobId: 'job-1', status: 'RESERVED' });

    await new ApiClient('https://api.test').reserveLanFirstPrintJobWithApiKey(
      'api-key-1',
      reserveBody,
      'machine-1',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/api/v1/print-agent/agent/jobs/reserve');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-print-agent-api-key': 'api-key-1',
        'x-print-agent-machine-id': 'machine-1',
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual(reserveBody);
  });

  it('dispatches a reserved LAN_FIRST job through backend fallback with API-key machine auth', async () => {
    const body = {
      idempotencyKey: reserveBody.idempotencyKey,
      payloadHash: reserveBody.payloadHash,
      dispatchMode: 'LAN_FIRST',
      sourceMachineId: 'pos-a',
      targetMachineId: 'pos-b',
      printerId: 'printer-1',
      reason: 'LAN_TIMEOUT',
    };
    mockJsonResponse({ jobId: 'job-1', status: 'QUEUED' });

    await new ApiClient('https://api.test').dispatchLanFirstPrintJobWithApiKey(
      'api-key-1',
      'job-1',
      body,
      'machine-1',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/api/v1/print-agent/agent/jobs/job-1/dispatch');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-print-agent-api-key': 'api-key-1',
        'x-print-agent-machine-id': 'machine-1',
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual(body);
  });

  it('reports LAN_DIRECT print result with API-key machine auth', async () => {
    const body = {
      status: 'FAILED',
      failureClass: 'SAFE_BEFORE_PRINT',
      errorMessage: 'printer offline',
      idempotencyKey: reserveBody.idempotencyKey,
      payloadHash: reserveBody.payloadHash,
      transport: 'LAN_DIRECT',
    };
    mockJsonResponse({ jobId: 'job-1', status: 'FAILED' });

    await new ApiClient('https://api.test').reportLanFirstPrintResultWithApiKey(
      'api-key-1',
      'job-1',
      body,
      'machine-1',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/api/v1/print-agent/agent/jobs/job-1/lan-result');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-print-agent-api-key': 'api-key-1',
        'x-print-agent-machine-id': 'machine-1',
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual(body);
  });

  it('calls the API-key safe-retry endpoint with machine auth and reason', async () => {
    mockJsonResponse({ jobId: 'job-1', status: 'SENT', retryAllowed: true, sent: true });

    await new ApiClient('https://api.test').safeRetryPrintJobWithApiKey(
      'api-key-1',
      'job-1',
      'machine-1',
      'POS fiscal auto-retry #1',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/api/v1/print-agent/agent/jobs/job-1/safe-retry');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-print-agent-api-key': 'api-key-1',
        'x-print-agent-machine-id': 'machine-1',
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ reason: 'POS fiscal auto-retry #1' });
  });

  it('fetches API-key print job status with machine auth', async () => {
    mockJsonResponse({ jobId: 'job-1', status: 'FAILED', failureClass: 'SAFE_BEFORE_PRINT' });

    await new ApiClient('https://api.test').getPrintJobStatusWithApiKey(
      'api-key-1',
      'job-1',
      'machine-1',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/api/v1/print-agent/agent/jobs/job-1');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-print-agent-api-key': 'api-key-1',
        'x-print-agent-machine-id': 'machine-1',
      },
    });
  });
});
