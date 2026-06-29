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
  fetchMock.mockResolvedValue(new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  globalThis.fetch = fetchMock as any;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApiClient product-admin create', () => {
  it('keeps sellBy in the create body and sends idempotency in the header', async () => {
    await new ApiClient('https://api.test').createProductVariant('token-1', {
      name: 'Bulk rice',
      priceGrossGrosze: 1299,
      vatRate: 23,
      sellBy: 'WEIGHT',
      idempotencyKey: 'create-1',
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      name: 'Bulk rice',
      sellBy: 'WEIGHT',
    });
    expect(request.headers).toMatchObject({
      'Idempotency-Key': 'create-1',
    });
  });
});
