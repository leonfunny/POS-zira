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
  it('keeps sellBy, strips legacy retailPrice, and sends idempotency in the header', async () => {
    await new ApiClient('https://api.test').createProductVariant('token-1', {
      name: 'Bulk rice',
      priceGrossGrosze: 1299,
      vatRate: 23,
      retailPrice: 12.99,
      sellBy: 'WEIGHT',
      idempotencyKey: 'create-1',
    } as any);

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      name: 'Bulk rice',
      priceGrossGrosze: 1299,
      sellBy: 'WEIGHT',
    });
    expect(body).not.toHaveProperty('retailPrice');
    expect(request.headers).toMatchObject({
      'Idempotency-Key': 'create-1',
    });
  });

  it('keeps sellBy in product-admin update bodies', async () => {
    await new ApiClient('https://api.test').updateProductVariant('token-1', 'variant-1', {
      name: 'Bulk rice',
      priceGrossGrosze: 1299,
      vatRate: 23,
      sellBy: 'WEIGHT',
      saleUnit: 'kg',
      expectedUpdatedAt: '2026-06-30T10:00:00.000Z',
    });

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body));
    expect(url).toBe('https://api.test/api/v1/warehouse/product-admin/variants/variant-1');
    expect(request.method).toBe('PATCH');
    expect(body).toMatchObject({
      name: 'Bulk rice',
      priceGrossGrosze: 1299,
      sellBy: 'WEIGHT',
      saleUnit: 'kg',
      expectedUpdatedAt: '2026-06-30T10:00:00.000Z',
    });
  });

  it('sends the edit-session revision with a main-image multipart upload', async () => {
    await new ApiClient('https://api.test').uploadProductMainImage('token-1', 'variant-1', {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
      fileName: 'product.png',
      expectedUpdatedAt: '2026-07-13T10:00:00.000Z',
    });

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/v1/warehouse/product-admin/variants/variant-1/main-image');
    expect(request.headers).toMatchObject({
      'X-Expected-Updated-At': '2026-07-13T10:00:00.000Z',
    });
    expect(request.body).toBeInstanceOf(FormData);
  });

  it('maps legacy string error envelopes to machine-readable product-admin codes', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'DUPLICATE_PRODUCT',
      message: 'Barcode already exists',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(
      new ApiClient('https://api.test').createProductVariant('token-1', {
        name: 'Duplicate',
        barcode: '5901234567890',
        priceGrossGrosze: 1299,
        vatRate: 23,
        idempotencyKey: 'create-duplicate',
      }),
    ).rejects.toMatchObject({
      message: 'Barcode already exists',
      status: 409,
      code: 'DUPLICATE_PRODUCT',
    });
  });

  it('maps structured duplicate envelopes from product-admin create', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: 'DUPLICATE_BARCODE',
        message: 'Barcode already exists',
        field: 'barcode',
        details: { existingVariantId: 'variant-1' },
      },
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(
      new ApiClient('https://api.test').createProductVariant('token-1', {
        name: 'Duplicate',
        barcode: '5901234567890',
        priceGrossGrosze: 1299,
        vatRate: 23,
        idempotencyKey: 'create-duplicate-structured',
      }),
    ).rejects.toMatchObject({
      message: 'Barcode already exists',
      status: 409,
      code: 'DUPLICATE_BARCODE',
      field: 'barcode',
      details: { existingVariantId: 'variant-1' },
    });
  });
});
