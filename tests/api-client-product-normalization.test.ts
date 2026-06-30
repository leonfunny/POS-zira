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
  globalThis.fetch = fetchMock as any;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApiClient product normalization', () => {
  it('keeps snake_case price fields instead of dropping them to zero', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{
        id: 'variant-1',
        template_id: 'template-1',
        name: 'Tea',
        sku: 'TEA-1',
        barcode: '5901234567001',
        retail_price: '12.34',
        price_gross: '12.34',
        price_net: '10.03',
        vat_amount: '2.31',
        in_stock: 4,
        available_qty: 3,
        is_active: true,
        updated_at: '2026-05-20T12:00:00.000Z',
        template: {
          category_id: 'cat-1',
          category: { id: 'cat-1', name: 'Drinks' },
          tax_rate: '23',
        },
      }],
      nextSince: '2026-05-20T12:00:00.000Z',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await new ApiClient('https://api.test').getPosProducts('token-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/api/v1/warehouse/public/products?limit=100&page=1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          'X-Salon-Slug': 'test-salon',
        }),
      }),
    );
    expect(result.products[0]).toMatchObject({
      id: 'variant-1',
      template_id: 'template-1',
      retail_price: 1234,
      price_gross: 1234,
      price_net: 1003,
      vat_amount: 231,
      in_stock: 4,
      available_qty: 3,
      category_id: 'cat-1',
      vat_rate: 23,
      is_active: 1,
      updated_at: '2026-05-20T12:00:00.000Z',
    });
  });

  it('does not multiply stored grosze fields by 100 again', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{
        id: 'variant-2',
        name: 'Stored price item',
        retail_price: 1299,
        price_gross: 1299,
        price_net: 1203,
        vat_amount: 96,
        is_active: true,
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await new ApiClient('https://api.test').getPosProducts('token-1');

    expect(result.products[0]).toMatchObject({
      retail_price: 1299,
      price_gross: 1299,
      price_net: 1203,
      vat_amount: 96,
    });
  });

  it('treats small integer snake_case prices as PLN, not grosze', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{
        id: 'variant-small-integer',
        name: 'Integer PLN price item',
        retail_price: 12,
        price_gross: 12,
        price_net: 10,
        vat_amount: 2,
        is_active: true,
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await new ApiClient('https://api.test').getPosProducts('token-1');

    expect(result.products[0]).toMatchObject({
      retail_price: 1200,
      price_gross: 1200,
      price_net: 1000,
      vat_amount: 2,
    });
  });

  it('falls back to template price when the variant price is missing or zero', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{
        id: 'variant-3',
        name: 'Template priced item',
        retailPrice: 0,
        priceGross: 0,
        template: {
          id: 'template-3',
          retailPrice: '7.50',
        },
        isActive: true,
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await new ApiClient('https://api.test').getPosProducts('token-1');

    expect(result.products[0]).toMatchObject({
      retail_price: 750,
      price_gross: 750,
    });
  });

  it('merges public categories that have no products into the POS sync payload', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: 'cat-empty',
          name: 'test',
          color: '#d97706',
          imageUrl: 'https://img.test/cat.png',
          displayOrder: 7,
          updatedAt: '2026-06-30T10:00:00.000Z',
          nameTranslations: { vi: 'test' },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await new ApiClient('https://api.test').getPosProducts('token-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/api/v1/warehouse/public/categories',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          'X-Salon-Slug': 'test-salon',
        }),
      }),
    );
    expect(result.categories).toEqual([expect.objectContaining({
      id: 'cat-empty',
      name: 'test',
      icon: 'https://img.test/cat.png',
      color: '#d97706',
      sort_order: 7,
      updated_at: '2026-06-30T10:00:00.000Z',
      name_translations: JSON.stringify({ vi: 'test' }),
    })]);
  });
});
