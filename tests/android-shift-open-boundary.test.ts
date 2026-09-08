import { afterEach, describe, expect, it, vi } from 'vitest';
import { PosApiClient } from '../src/renderer/android-pos/port/api-client';

afterEach(() => vi.unstubAllGlobals());
function setup() {
  const provider = { getAccessToken: vi.fn(async () => 'token'), refresh: vi.fn(async () => true), onExpired: vi.fn() };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ shiftId: 'server-shift' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const client = new PosApiClient({ baseUrl: 'https://shift.invalid', tokenProvider: provider });
  return { client, provider, fetchMock };
}
const request = () => ({ staffId: 'staff', openingCash: 100, machineId: 'persistent-device' });

describe('guarded Android shift open boundary', () => {
  it('does not fetch when the context changes during token lookup', async () => {
    const { client, provider, fetchMock } = setup();
    let current = true;
    provider.getAccessToken.mockImplementation(async () => { current = false; return 'other-token'; });
    const guard = async () => { if (!current) throw new Error('changed'); };
    await expect(client.openPosShift(request(), guard)).rejects.toThrow('changed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('freezes the requested device and amounts before awaiting context', async () => {
    const { client, fetchMock } = setup();
    const data = request();
    await client.openPosShift(data, async () => { data.machineId = 'changed'; data.openingCash = 999; });
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body)).toEqual(request());
  });
  it('never refreshes or replays a guarded POST on 401', async () => {
    const { client, provider, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(client.openPosShift(request(), async () => {})).rejects.toThrow('401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(provider.onExpired).not.toHaveBeenCalled();
  });
  it('rejects a response received after the original context changed', async () => {
    const { client, fetchMock } = setup();
    let current = true;
    fetchMock.mockImplementation(async () => { current = false; return new Response('{}'); });
    await expect(client.openPosShift(request(), async () => { if (!current) throw new Error('changed'); })).rejects.toThrow('changed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects context changes during response JSON decoding', async () => {
    const { client, fetchMock } = setup();
    let current = true;
    fetchMock.mockResolvedValue({ ok: true, json: async () => { current = false; return { shiftId: 'server' }; } } as Response);
    await expect(client.openPosShift(request(), async () => { if (!current) throw new Error('changed'); })).rejects.toThrow('changed');
  });
});
