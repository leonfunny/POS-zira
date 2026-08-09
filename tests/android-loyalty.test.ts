import { afterEach, describe, expect, test, vi } from 'vitest';

import { PosApiClient, type TokenProvider } from '../src/renderer/android-pos/port/api-client';
import { buildExcludedPosNamespaces } from '../src/renderer/android-pos/shim/stubs';

afterEach(() => vi.unstubAllGlobals());

function client(tokenProvider: TokenProvider) {
  return new PosApiClient({ baseUrl: 'https://api.example.test', tokenProvider });
}

describe('Android loyalty lookup', () => {
  test('uses the staff JWT endpoint and returns the typed found/not-found response', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ found: false, phone: '+48123456789' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const result = await client({ getAccessToken: async () => 'staff-jwt', refresh: async () => false, onExpired: () => {} })
      .getPosCustomerLoyalty(' +48123456789 ');
    expect(result).toEqual({ found: false, phone: '+48123456789' });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/loyalty/pos/customer?phone=%2B48123456789',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer staff-jwt' }) }),
    );
  });

  test('refreshes once after a 401 and retries with the rotated staff JWT', async () => {
    let token = 'old-staff-jwt';
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ found: true, phone: '123' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const refresh = vi.fn(async () => { token = 'new-staff-jwt'; return true; });
    await expect(client({ getAccessToken: async () => token, refresh, onExpired: () => {} }).getPosCustomerLoyalty('123'))
      .resolves.toMatchObject({ found: true });
    expect(refresh).toHaveBeenCalledOnce();
    expect((fetch.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer new-staff-jwt' });
  });

  test.each([403, 404])('keeps %s as an unavailable transport error', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: `HTTP ${status}` }), { status })));
    await expect(client({ getAccessToken: async () => 'staff-jwt', refresh: async () => false, onExpired: () => {} }).getPosCustomerLoyalty('123'))
      .rejects.toMatchObject({ status });
  });

  test('does not cache a result across a user or tenant boundary', async () => {
    let token = 'staff-a';
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ found: true, phone: '123', owner: { fullName: 'Salon A' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ found: false, phone: '123' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const api = client({ getAccessToken: async () => token, refresh: async () => false, onExpired: () => {} });
    await expect(api.getPosCustomerLoyalty('123')).resolves.toMatchObject({ found: true });
    token = 'staff-b';
    await expect(api.getPosCustomerLoyalty('123')).resolves.toMatchObject({ found: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer staff-b' });
  });

  test('keeps a network failure unavailable rather than manufacturing a result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(client({ getAccessToken: async () => 'staff-jwt', refresh: async () => false, onExpired: () => {} }).getPosCustomerLoyalty('123'))
      .rejects.toThrow('network down');
  });

  test('synthetic transport stays explicitly unavailable', async () => {
    await expect(buildExcludedPosNamespaces().loyalty.lookupCustomer('123'))
      .resolves.toMatchObject({ success: false, unavailable: true });
  });
});
