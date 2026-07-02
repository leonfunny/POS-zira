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

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
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
