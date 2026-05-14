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
