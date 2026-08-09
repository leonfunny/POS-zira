/**
 * E-PARITY-3 — product/stock/category admin surface (owner-only).
 *
 * Verifies the shim ports the Windows product-admin REST flow faithfully: staff
 * JWT (NOT the pa_ key) + salon-context headers (X-Salon-Slug/Code/Agent-Id) +
 * Idempotency-Key / X-Expected-Updated-At, hitting /warehouse/product-admin/*,
 * and mapping a thrown request envelope into { ok:false, error, code }.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PosApiClient } from '../src/renderer/android-pos/port/api-client';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { createProductAdminSurface } from '../src/renderer/android-pos/shim/product-admin';
import type { TokenStoreStorage } from '../src/renderer/android-pos/shim/token-store';

function memoryStorage(): TokenStoreStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const STAFF_TOKEN_PROVIDER = {
  getAccessToken: async () => 'jwt-staff-1',
  refresh: async () => false,
  onExpired: () => undefined,
};

interface RoutedCall { url: string; method: string; body: any; headers: Record<string, string>; }
function callsOf(mock: ReturnType<typeof vi.fn>): RoutedCall[] {
  return mock.mock.calls.map((call: unknown[]) => {
    const [url, init] = call as [unknown, RequestInit | undefined];
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = v;
    let body: any;
    if (init?.body) { try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); } }
    return { url: String(url), method: String(init?.method ?? 'GET'), body, headers };
  });
}

function build(tokenProvider = STAFF_TOKEN_PROVIDER) {
  const configStore = new ShimConfigStore({
    storage: memoryStorage(),
    seed: { salonCode: '6535', agentId: 'agent-9' } as never,
  });
  const client = new PosApiClient({ baseUrl: 'https://api.enail.pro', tokenProvider, salonSlug: 'test-salon' });
  const surface = createProductAdminSurface({ client, configStore });
  return { surface, configStore, client };
}

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

const BASE = 'https://api.enail.pro/api/v1/warehouse/product-admin';

describe('product-admin surface (E-PARITY-3)', () => {
  test('getCapabilities hits /capabilities with the staff JWT + salon-context headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ version: 3, canCreateProduct: true }));
    const { surface } = build();
    const res = await surface.getCapabilities();
    expect(res).toMatchObject({ ok: true, capabilities: { version: 3, canCreateProduct: true } });

    const [c] = callsOf(fetchMock);
    expect(c.url).toBe(`${BASE}/capabilities`);
    expect(c.method).toBe('GET');
    expect(c.headers.Authorization).toBe('Bearer jwt-staff-1');
    expect(c.headers['X-Salon-Slug']).toBe('test-salon');
    expect(c.headers['X-Salon-Code']).toBe('6535');
    expect(c.headers['X-Agent-Id']).toBe('agent-9');
  });

  test('never reuses capability answers across a changed staff context and retries after 403', async () => {
    const getAccessToken = vi.fn()
      .mockResolvedValueOnce('jwt-staff-1')
      .mockResolvedValueOnce('jwt-staff-2')
      .mockResolvedValueOnce('jwt-staff-2');
    const { surface, configStore } = build({ getAccessToken, refresh: async () => false, onExpired: () => undefined });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ canCreateProduct: true }))
      .mockResolvedValueOnce(jsonResponse({ message: 'forbidden', code: 'UNAUTHORIZED_PRODUCT_ADMIN' }, 403))
      .mockResolvedValueOnce(jsonResponse({ canCreateProduct: false }));

    expect(await surface.getCapabilities()).toMatchObject({ ok: true, capabilities: { canCreateProduct: true } });
    configStore.saveConfig({ salonCode: '7777', agentId: 'agent-2' } as never);
    expect(await surface.getCapabilities()).toMatchObject({ ok: false, error: 'capabilities-unavailable' });
    expect(await surface.getCapabilities()).toMatchObject({ ok: true, capabilities: { canCreateProduct: false } });

    const calls = callsOf(fetchMock);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.headers.Authorization)).toEqual(['Bearer jwt-staff-1', 'Bearer jwt-staff-2', 'Bearer jwt-staff-2']);
    expect(calls[1].headers['X-Salon-Code']).toBe('7777');
    expect(calls[2].headers['X-Agent-Id']).toBe('agent-2');
  });

  test('createProduct POSTs /products with an Idempotency-Key and drops the retailPrice alias', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'v1', ok: true }));
    const { surface } = build();
    const res = await surface.createProduct({ name: 'Gel', price: 8000, retailPrice: 8000, idempotencyKey: 'idem-1' });
    expect(res.ok).toBe(true);

    const [c] = callsOf(fetchMock);
    expect(c.url).toBe(`${BASE}/products`);
    expect(c.method).toBe('POST');
    expect(c.headers['Idempotency-Key']).toBe('idem-1');
    // idempotencyKey + retailPrice are stripped from the body.
    expect(c.body).toEqual({ name: 'Gel', price: 8000 });
  });

  test('adjustStock POSTs /variants/:id/stock-adjustments with the idempotency key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, newQty: 12 }));
    const { surface } = build();
    const res = await surface.adjustStock('var 1/x', { delta: 5, reason: 'RECOUNT', idempotencyKey: 'idem-2' });
    expect(res.ok).toBe(true);

    const [c] = callsOf(fetchMock);
    expect(c.url).toBe(`${BASE}/variants/var%201%2Fx/stock-adjustments`); // path-encoded
    expect(c.method).toBe('POST');
    expect(c.headers['Idempotency-Key']).toBe('idem-2');
    expect(c.body).toEqual({ delta: 5, reason: 'RECOUNT' });
  });

  test('updateVariant PATCHes with the X-Expected-Updated-At optimistic-concurrency header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { surface } = build();
    await surface.updateVariant('v1', { name: 'New', expectedUpdatedAt: '2026-07-20T00:00:00Z' });

    const [c] = callsOf(fetchMock);
    expect(c.url).toBe(`${BASE}/variants/v1`);
    expect(c.method).toBe('PATCH');
    expect(c.headers['X-Expected-Updated-At']).toBe('2026-07-20T00:00:00Z');
    expect(c.body).toEqual({ name: 'New' });
  });

  test('deleteCategory DELETEs /categories/:id with the expected-updated-at guard', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { surface } = build();
    await surface.deleteCategory('c1', { expectedUpdatedAt: '2026-07-20T01:00:00Z' });

    const [c] = callsOf(fetchMock);
    expect(c.url).toBe(`${BASE}/categories/c1`);
    expect(c.method).toBe('DELETE');
    expect(c.headers['X-Expected-Updated-At']).toBe('2026-07-20T01:00:00Z');
  });

  test('a server rejection maps to { ok:false, error, code } from the error envelope', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Stock locked', code: 'STOCK_LOCKED' }, 409));
    const { surface } = build();
    const res = await surface.adjustStock('v1', { delta: -1 });
    expect(res).toEqual({ ok: false, error: 'Stock locked', code: 'STOCK_LOCKED' });
  });

  test('uploadMainImage decodes the data URL to a multipart image POST', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, image: { url: 'x' } }));
    const { surface } = build();
    // A base64 PNG data URL — the shape the renderer (ProductAdminMainImageUploadInput) sends.
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAAA';
    const res = await surface.uploadMainImage('v1', { dataUrl, fileName: 'photo.png', mimeType: 'image/png', expectedUpdatedAt: '2026-07-20T02:00:00Z' });
    expect(res.ok).toBe(true);

    const [c] = callsOf(fetchMock);
    expect(c.url).toBe(`${BASE}/variants/v1/main-image`);
    expect(c.method).toBe('POST');
    expect(c.headers.Authorization).toBe('Bearer jwt-staff-1');
    expect(c.headers['X-Expected-Updated-At']).toBe('2026-07-20T02:00:00Z');
    // Multipart: NO explicit Content-Type header (the runtime sets the boundary).
    expect(c.headers['Content-Type']).toBeUndefined();
    // The body is a FormData carrying the 'image' field.
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).has('image')).toBe(true);
  });

  test('uploadCategoryImage posts to /categories/:id/image', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { surface } = build();
    await surface.uploadCategoryImage('c1', { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAAA', fileName: 'c.png' });
    const [c] = callsOf(fetchMock);
    expect(c.url).toBe(`${BASE}/categories/c1/image`);
    expect(c.method).toBe('POST');
  });

  test('redacts purchase cost when the token lacks canViewPurchasePrice', async () => {
    const { surface } = build();
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/capabilities')) return jsonResponse({ supportsPurchasePrice: true, canViewPurchasePrice: false });
      if (u.includes('/variants/v1')) return jsonResponse({ variant: { id: 'v1', retailPrice: 8000, purchasePrice: 3000, purchase_price_grosze: 300000 } });
      return jsonResponse({});
    });
    const res = await surface.getVariant('v1');
    expect(res.ok).toBe(true);
    const variant = (res as any).data.variant;
    expect(variant).toMatchObject({ id: 'v1', retailPrice: 8000 }); // retail kept
    expect(variant.purchasePrice).toBeUndefined();                  // cost stripped
    expect(variant.purchase_price_grosze).toBeUndefined();
  });

  test('preserves purchase cost when the token may view it', async () => {
    const { surface } = build();
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/capabilities')) return jsonResponse({ supportsPurchasePrice: true, canViewPurchasePrice: true });
      if (u.includes('/variants/v1')) return jsonResponse({ variant: { id: 'v1', purchasePrice: 3000 } });
      return jsonResponse({});
    });
    const res = await surface.getVariant('v1');
    expect((res as any).data.variant.purchasePrice).toBe(3000);
  });

  test('fail-safe: redacts cost when the capabilities probe is unavailable', async () => {
    const { surface } = build();
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/capabilities')) return jsonResponse({ message: 'nope' }, 500); // probe fails
      if (u.includes('/variants/v1')) return jsonResponse({ variant: { id: 'v1', purchasePrice: 3000 } });
      return jsonResponse({});
    });
    const res = await surface.getVariant('v1');
    expect(res.ok).toBe(true);
    expect((res as any).data.variant.purchasePrice).toBeUndefined(); // redacted on unknown
  });

  test('a non-data-URL image payload is rejected locally with no HTTP call', async () => {
    const { surface } = build();
    const res = await surface.uploadMainImage('v1', { dataUrl: 'https://example.invalid/not-a-data-url.png' });
    expect(res).toMatchObject({ ok: false, code: 'INVALID_IMAGE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
