import { afterEach, describe, expect, it, vi } from 'vitest';
import { PosApiClient } from '../src/renderer/android-pos/port/api-client';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const provider = { getAccessToken: vi.fn(async () => 'token-original'), refresh: vi.fn(async () => true), onExpired: vi.fn() };
  const client = new PosApiClient({ baseUrl: 'https://refund.test', tokenProvider: provider });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const guard = vi.fn(async () => undefined);
  return { client, provider, fetch, guard };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const payload = () => ({ type: 'PARTIAL', amount: 20.25, refundRequestId: 'immutable-request', items: [{ orderItemId: 'item-a', quantity: 0.5, restock: false }] });

describe('Android monetary refund HTTP boundary', () => {
  it('preserves saved JSON byte-for-byte without rewriting PLN or request IDs', async () => {
    const { client, fetch, guard } = setup();
    const saved = ' {"amount":20.25,"refundRequestId":"saved-id","items":[]} ';
    const result = { success: true, refundAmount: 20.25 };
    fetch.mockResolvedValue(json(result));
    await expect(client.refundOrder('order/a', saved, guard)).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toMatchObject(['https://refund.test/api/v1/b2b/pos/orders/order%2Fa/refund', {
      method: 'POST', body: saved, headers: { Authorization: 'Bearer token-original' },
    }]);
    expect(guard).toHaveBeenCalledTimes(4);
  });

  it('snapshots an object exactly once before token await, preserving canonical PLN', async () => {
    const { client, provider, fetch, guard } = setup();
    const dto = payload(); const original = JSON.stringify(dto);
    provider.getAccessToken.mockImplementation(async () => { dto.amount = 999; return 'token-original'; });
    fetch.mockResolvedValue(json({ success: true }));
    await client.refundOrder('order-a', dto, guard);
    expect(fetch.mock.calls[0][1].body).toBe(original);
  });

  it('never refreshes/replays a 401 monetary POST or expires the active session implicitly', async () => {
    const { client, provider, fetch, guard } = setup();
    fetch.mockResolvedValue(json({ code: 'EXPIRED', message: 'expired' }, 401));
    await expect(client.refundOrder('order-a', payload(), guard)).rejects.toMatchObject({ status: 401, code: 'EXPIRED' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(provider.onExpired).not.toHaveBeenCalled();
    expect(provider.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 409, 501, 500])('throws HTTP %i with preserved backend code, never null', async status => {
    const { client, fetch, guard } = setup();
    fetch.mockResolvedValue(json({ error: 'REFUND_SPECIFIC_ERROR', message: 'server rejection' }, status));
    await expect(client.refundOrder('order-a', payload(), guard)).rejects.toMatchObject({ status, code: 'REFUND_SPECIFIC_ERROR', message: 'server rejection' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('supplies HTTP status/code even when error JSON is malformed', async () => {
    const { client, fetch, guard } = setup();
    fetch.mockResolvedValue(new Response('gateway error', { status: 500 }));
    await expect(client.refundOrder('order-a', payload(), guard)).rejects.toMatchObject({ status: 500, code: 'HTTP_500' });
  });

  it('rejects malformed success JSON as unknown authoritative response, not success', async () => {
    const { client, fetch, guard } = setup();
    fetch.mockResolvedValue(new Response('not-json', { status: 200 }));
    await expect(client.refundOrder('order-a', payload(), guard)).rejects.toMatchObject({ status: 200, code: 'REFUND_INVALID_RESPONSE' });
    expect(guard).toHaveBeenCalledTimes(4);
  });

  it('checks context before token lookup and dispatch', async () => {
    const { client, provider, fetch, guard } = setup();
    guard.mockRejectedValue(new Error('CONTEXT_CHANGED'));
    await expect(client.refundOrder('order-a', payload(), guard)).rejects.toThrow('CONTEXT_CHANGED');
    expect(provider.getAccessToken).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('checks context after request serialization before dispatch', async () => {
    const { client, fetch } = setup(); let current = true;
    const dto = { toJSON() { current = false; return payload(); } };
    const guard = async () => { if (!current) throw new Error('CONTEXT_CHANGED'); };
    await expect(client.refundOrder('order-a', dto, guard)).rejects.toThrow('CONTEXT_CHANGED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks context after awaiting token, preventing a stale-context dispatch', async () => {
    const { client, provider, fetch } = setup(); let current = true;
    provider.getAccessToken.mockImplementation(async () => { current = false; return 'new-token'; });
    const guard = async () => { if (!current) throw new Error('CONTEXT_CHANGED'); };
    await expect(client.refundOrder('order-a', payload(), guard)).rejects.toThrow('CONTEXT_CHANGED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks context after response before consuming its body', async () => {
    const { client, fetch } = setup(); let current = true;
    const read = vi.fn(async () => ({ success: true }));
    fetch.mockImplementation(async () => { current = false; return { ok: true, status: 200, json: read }; });
    const guard = async () => { if (!current) throw new Error('CONTEXT_CHANGED'); };
    await expect(client.refundOrder('order-a', payload(), guard)).rejects.toThrow('CONTEXT_CHANGED');
    expect(read).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([200, 409])('checks context after reading response body (HTTP%i)', async status => {
    const { client, fetch } = setup(); let current = true;
    fetch.mockResolvedValue({ ok: status === 200, status, json: async () => { current = false; return { success: true }; } });
    const guard = async () => { if (!current) throw new Error('CONTEXT_CHANGED'); };
    await expect(client.refundOrder('order-a', payload(), guard)).rejects.toThrow('CONTEXT_CHANGED');
  });

  it('checks context after a malformed JSON body too', async () => {
    const { client, fetch } = setup(); let current = true;
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => { current = false; throw new Error('bad JSON'); } });
    const guard = async () => { if (!current) throw new Error('CONTEXT_CHANGED'); };
    await expect(client.refundOrder('order-a', payload(), guard)).rejects.toThrow('CONTEXT_CHANGED');
  });

  it('does not replay a network/unknown outcome', async () => {
    const { client, provider, fetch, guard } = setup(); const error = new Error('network lost after send');
    fetch.mockRejectedValue(error);
    await expect(client.refundOrder('order-a', payload(), guard)).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1); expect(provider.refresh).not.toHaveBeenCalled();
  });

  it('also fences context when fetch rejects after dispatch', async () => {
    const { client, fetch } = setup(); let current = true;
    fetch.mockImplementation(async () => { current = false; throw new Error('network lost'); });
    const guard = async () => { if (!current) throw new Error('CONTEXT_CHANGED'); };
    await expect(client.refundOrder('order-a', payload(), guard)).rejects.toThrow('CONTEXT_CHANGED');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
