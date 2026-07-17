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
      image_url: 'https://img.test/cat.png',
      icon: null,
      color: '#d97706',
      sort_order: 7,
      updated_at: '2026-06-30T10:00:00.000Z',
      name_translations: JSON.stringify({ vi: 'test' }),
    })]);
    expect(result.categoriesComplete).toBe(true);
  });

  it('marks categories incomplete when the public category request fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: 'variant-embedded',
          name: 'Embedded product',
          template: { category: { id: 'cat-embedded', name: 'Embedded category' } },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'temporary failure' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }));

    const result = await new ApiClient('https://api.test').getPosProducts('token-1');

    expect(result.categoriesComplete).toBe(false);
    expect(result.categories).toEqual([expect.objectContaining({ id: 'cat-embedded' })]);
  });

  it('uses the canonical cursor-v2 page contract and only returns the final snapshot cursor', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: 'variant-page-1',
          name: 'Page one',
          retailPrice: '10.00',
          updatedAt: '2026-07-14T09:00:00.000Z',
          canonicalUpdatedAt: '2026-07-14T09:05:00.000Z',
        }],
        deletedIds: ['deleted-1'],
        events: [{
          operation: 'TOMBSTONE',
          id: 'deleted-1',
          tombstoneReason: 'PRODUCT_DELETED',
          canonicalUpdatedAt: '2026-07-14T09:06:00.000Z',
        }],
        hasMore: true,
        nextPageCursor: 'page-cursor-2',
        serverTime: '2026-07-14T10:00:00.000Z',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: 'variant-page-2',
          name: 'Page two',
          retailPrice: '20.00',
          updatedAt: '2026-07-14T09:10:00.000Z',
        }],
        deletedIds: ['deleted-1', 'deleted-2'],
        events: [{
          operation: 'TOMBSTONE',
          id: 'deleted-2',
          tombstoneReason: 'VARIANT_INACTIVE',
          canonicalUpdatedAt: '2026-07-14T09:11:00.000Z',
        }],
        hasMore: false,
        nextSyncCursor: 'snapshot-cursor-next',
        serverTime: '2026-07-14T10:00:01.000Z',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const result = await new ApiClient('https://api.test').getPosProducts(
      'token-1',
      'snapshot-cursor-old',
      { cursorV2: true },
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.test/api/v1/warehouse/public/products/sync-v2?limit=100&syncCursor=snapshot-cursor-old',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.test/api/v1/warehouse/public/products/sync-v2?limit=100&pageCursor=page-cursor-2',
    );
    expect(result).toMatchObject({
      nextSyncCursor: 'snapshot-cursor-next',
      serverTime: '2026-07-14T10:00:01.000Z',
      deletedIds: ['deleted-1', 'deleted-2'],
      tombstones: [
        {
          id: 'deleted-1',
          reason: 'PRODUCT_DELETED',
          canonicalUpdatedAt: '2026-07-14T09:06:00.000Z',
        },
        {
          id: 'deleted-2',
          reason: 'VARIANT_INACTIVE',
          canonicalUpdatedAt: '2026-07-14T09:11:00.000Z',
        },
      ],
    });
    expect(result.products.map((product) => product.id)).toEqual([
      'variant-page-1',
      'variant-page-2',
    ]);
    expect(result.products[0].updated_at).toBe('2026-07-14T09:05:00.000Z');
  });

  it('rejects an incomplete cursor-v2 page chain instead of advancing a partial cursor', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{ id: 'variant-partial', name: 'Partial' }],
      hasMore: true,
      nextSyncCursor: 'must-not-be-used',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(new ApiClient('https://api.test').getPosProducts(
      'token-1',
      'snapshot-cursor-old',
      { cursorV2: true },
    )).rejects.toThrow('missing nextPageCursor');
  });

  it('preserves the exact unsafe-cursor Nest envelope as a typed 409 error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'PRODUCT_SYNC_CURSOR_UNSAFE',
      message: 'Cursor exceeds the safe watermark',
      resetRequired: true,
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }));

    await expect(new ApiClient('https://api.test').getPosProducts(
      'token-1',
      'unsafe-cursor',
      { cursorV2: true },
    )).rejects.toMatchObject({
      status: 409,
      code: 'PRODUCT_SYNC_CURSOR_UNSAFE',
      resetRequired: true,
      serverBody: {
        error: 'PRODUCT_SYNC_CURSOR_UNSAFE',
        resetRequired: true,
      },
    });
  });

  it('normalizes both legacy items and canonical categories response envelopes', async () => {
    const api = new ApiClient('https://api.test');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: 'legacy-cat',
          name: 'Legacy',
          icon: 'https://img.test/legacy.jpg',
          updated_at: '2026-07-14T09:00:00.000Z',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        categories: [{
          id: 'canonical-cat',
          name: 'Canonical',
          image_url: 'https://img.test/canonical.jpg',
          product_count: 12,
          sort_order: 3,
          is_active: true,
          updated_at: '2026-07-14T09:30:00.000Z',
        }],
        total: 1,
        serverTime: '2026-07-14T10:00:00.000Z',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(api.listProductAdminCategories('token-1')).resolves.toEqual({
      categories: [expect.objectContaining({
        id: 'legacy-cat',
        name: 'Legacy',
        imageUrl: 'https://img.test/legacy.jpg',
        icon: null,
        updatedAt: '2026-07-14T09:00:00.000Z',
      })],
      total: 1,
      serverTime: undefined,
    });
    await expect(api.listProductAdminCategories('token-1')).resolves.toEqual({
      categories: [expect.objectContaining({
        id: 'canonical-cat',
        name: 'Canonical',
        imageUrl: 'https://img.test/canonical.jpg',
        productCount: 12,
        sortOrder: 3,
        updatedAt: '2026-07-14T09:30:00.000Z',
      })],
      total: 1,
      serverTime: '2026-07-14T10:00:00.000Z',
    });
  });

  it('preserves an explicit category image removal instead of reviving a legacy icon URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      categories: [{
        id: 'cat-removed-image',
        name: 'No image',
        imageUrl: null,
        icon: 'https://img.test/legacy-should-not-return.jpg',
        updatedAt: '2026-07-14T10:00:00.000Z',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(new ApiClient('https://api.test').listProductAdminCategories('token-1'))
      .resolves.toMatchObject({
        categories: [{
          id: 'cat-removed-image',
          imageUrl: null,
          icon: null,
        }],
      });
  });

  it('maps the capabilities-v4 cursor fields explicitly', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      version: 4,
      supportsProductSyncV2: true,
      productSyncVersion: 2,
      canReorderCategory: true,
      supportsCategoryBatchUpdate: true,
      supportsCategoryKitchenPrint: true,
      supportsCategoryDelta: true,
      supportsCategoryImageUpload: true,
      canReplaceCategoryImage: true,
      canDeleteCategory: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(new ApiClient('https://api.test').getProductAdminCapabilities('token-1'))
      .resolves.toMatchObject({
        version: 4,
        supportsProductSyncV2: true,
        productSyncVersion: 2,
        canReorderCategory: true,
        supportsCategoryBatchUpdate: true,
        supportsCategoryKitchenPrint: true,
        supportsCategoryDelta: true,
        supportsCategoryImageUpload: true,
        canReplaceCategoryImage: true,
        canDeleteCategory: true,
      });
  });
  it('sends category reorders through the atomic batch endpoint with each OCC revision', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      categories: [{
        id: 'cat-1',
        name: 'Tea',
        sortOrder: 0,
        isActive: true,
        updatedAt: '2026-07-14T10:00:00.000Z',
      }],
      updated: 1,
      serverTime: '2026-07-14T10:00:00.000Z',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const updates = [{
      id: 'cat-1',
      sortOrder: 0,
      expectedUpdatedAt: '2026-07-14T09:00:00.000Z',
    }];

    await expect(new ApiClient('https://api.test').updateProductAdminCategoryOrder(
      'token-1',
      updates,
    )).resolves.toMatchObject({ updated: 1 });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/api/v1/warehouse/product-admin/categories/order',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ updates }),
      }),
    );
  });

  it('uploads a category image as multipart with the OCC header', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      category: {
        id: 'cat-1',
        name: 'Tea',
        is_active: true,
        updated_at: '2026-07-14T10:00:01.000Z',
      },
      image: { url: 'https://img.test/categories/tea.webp' },
      serverTime: '2026-07-14T10:00:01.000Z',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(new ApiClient('https://api.test').uploadProductAdminCategoryImage(
      'token-1',
      'cat-1',
      {
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        mimeType: 'image/png',
        fileName: 'tea.png',
        expectedUpdatedAt: '2026-07-14T10:00:00.000Z',
      },
    )).resolves.toMatchObject({
      category: {
        id: 'cat-1',
        imageUrl: 'https://img.test/categories/tea.webp',
      },
      image: { url: 'https://img.test/categories/tea.webp' },
    });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(request).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'X-Expected-Updated-At': '2026-07-14T10:00:00.000Z',
      }),
    });
    expect(request.body).toBeInstanceOf(FormData);
    expect((request.body as FormData).get('image')).toBeInstanceOf(Blob);
  });

  it('deletes a category with OCC and normalizes affected-product aliases', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      deletedId: 'cat-1',
      affectedProductCount: 24,
      serverTime: '2026-07-14T10:00:01.000Z',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(new ApiClient('https://api.test').deleteProductAdminCategory(
      'token-1',
      'cat-1',
      '2026-07-14T10:00:00.000Z',
    )).resolves.toEqual({
      deletedId: 'cat-1',
      categoryId: 'cat-1',
      affectedProductCount: 24,
      reassignedProducts: 24,
      serverTime: '2026-07-14T10:00:01.000Z',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/api/v1/warehouse/product-admin/categories/cat-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          'X-Expected-Updated-At': '2026-07-14T10:00:00.000Z',
        }),
        body: undefined,
      }),
    );
  });

  it.each([
    [404, { message: 'Category not found' }],
    [409, { error: { code: 'CATEGORY_NOT_FOUND', message: 'Category not found' } }],
  ])(
    'reconciles an already-missing category delete as idempotent success (HTTP %s)',
    async (status, body) => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }));

      await expect(new ApiClient('https://api.test').deleteProductAdminCategory(
        'token-1',
        'cat-already-gone',
        '2026-07-14T10:00:00.000Z',
      )).resolves.toEqual({
        deletedId: 'cat-already-gone',
        categoryId: 'cat-already-gone',
        affectedProductCount: 0,
        reassignedProducts: 0,
      });
    },
  );
});
