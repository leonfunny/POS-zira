import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/main/network/auth-refresh', () => ({
  refreshAccessToken: vi.fn(),
  AuthRefreshNetworkError: class AuthRefreshNetworkError extends Error {},
}));

vi.mock('../src/main/config/store', () => ({
  getConfig: vi.fn(() => ({})),
  setConfig: vi.fn(),
  getConfigValue: vi.fn((key: string) => key === 'salonSlug' ? 'test-salon' : undefined),
}));

import { ApiClient } from '../src/main/network/api-client';
import { getConfigValue } from '../src/main/config/store';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(getConfigValue).mockImplementation((key: string) => key === 'salonSlug' ? 'test-salon' : undefined);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({
    outcome: 'IMPORT_DRAFT',
    variantId: 'server-variant-1',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  globalThis.fetch = fetchMock as any;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApiClient master-catalog scan-create categoryId', () => {
  it('posts categoryId when a scan-import category is selected', async () => {
    await new ApiClient('https://api.test').scanCreate('token-1', {
      ean: '5901234567890',
      purchasePrice: 0,
      retailPrice: 12.99,
      stockQty: 3,
      taxRate: 23,
      categoryId: 'cat-drinks',
      idempotencyKey: 'local-import-1',
    });

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body));
    expect(url).toBe('https://api.test/api/v1/master-catalog/scan-create');
    expect(request.method).toBe('POST');
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer token-1',
      'Idempotency-Key': 'local-import-1',
    });
    expect(body).toMatchObject({
      ean: '5901234567890',
      purchasePrice: 0,
      retailPrice: 12.99,
      stockQty: 3,
      taxRate: 23,
      categoryId: 'cat-drinks',
    });
  });

  it('omits categoryId when no category is selected', async () => {
    await new ApiClient('https://api.test').scanCreate(null, {
      ean: '5901234567890',
      purchasePrice: 0,
      retailPrice: 12.99,
      stockQty: 3,
      taxRate: 23,
      categoryId: null,
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      ean: '5901234567890',
      purchasePrice: 0,
      retailPrice: 12.99,
      stockQty: 3,
      taxRate: 23,
    });
    expect(body).not.toHaveProperty('categoryId');
  });
});

describe('ApiClient POS shift machineId', () => {
  it('adds the configured machineId when opening a shift', async () => {
    vi.mocked(getConfigValue).mockImplementation((key: string) => {
      if (key === 'machineId') return 'POS-2';
      if (key === 'salonSlug') return 'test-salon';
      return undefined;
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ shiftId: 'server-shift-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await new ApiClient('https://api.test').openPosShift('token-1', {
      staffId: 'staff-1',
      openingCash: 12345,
    });

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body));
    expect(url).toBe('https://api.test/api/v1/pos/shifts/open');
    expect(body).toMatchObject({
      staffId: 'staff-1',
      openingCash: 12345,
      machineId: 'POS-2',
    });
  });

  it('scopes active shift lookup by the configured machineId', async () => {
    vi.mocked(getConfigValue).mockImplementation((key: string) => {
      if (key === 'machineId') return 'POS 2';
      if (key === 'salonSlug') return 'test-salon';
      return undefined;
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'server-shift-1',
      staffId: 'staff-1',
      staffName: 'Cashier',
      openingCash: 100,
      openedAt: '2026-07-04T08:00:00.000Z',
      status: 'OPEN',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await new ApiClient('https://api.test').getActiveShift('token-1');

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/v1/pos/shifts/active?machineId=POS%202');
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer token-1',
      'Content-Type': 'application/json',
    });
  });

  it('returns no active shift only from an explicit successful server response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ active: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(new ApiClient('https://api.test').getActiveShift('token-1')).resolves.toBeNull();
  });

  it('does not treat HTTP failure or a malformed body as proof that no shift is active', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'service unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(new ApiClient('https://api.test').getActiveShift('token-1'))
      .rejects.toThrow('service unavailable');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ active: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(new ApiClient('https://api.test').getActiveShift('token-1'))
      .rejects.toThrow(/malformed.*missing id/i);
  });
});
