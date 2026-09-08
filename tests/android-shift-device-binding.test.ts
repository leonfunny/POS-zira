import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PosApiClient } from '../src/renderer/android-pos/port/api-client';
import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore } from '../src/renderer/android-pos/shim/token-store';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const apiUrl = 'https://shift-binding.invalid';
const userId = '11111111-1111-4111-8111-111111111111';
const salonId = '22222222-2222-4222-8222-222222222222';
const backendShiftId = '33333333-3333-4333-8333-333333333333';
const nextBackendShiftId = '44444444-4444-4444-8444-444444444444';
const knownDeviceId = '55555555-5555-4555-8555-555555555555';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup(persistence = new MemoryAndroidPersistence(), baseUrl = apiUrl) {
  const configStore = new ShimConfigStore({ storage: storage(), seed: { apiUrl: baseUrl, salonId,
    authUser: { id: userId, salonId, role: 'OWNER', email: 'owner@example.invalid' } } as any });
  const tokenStore = new TokenStore({ storage: storage(), allowInsecureFallback: true });
  await tokenStore.setTokens('original-token', 'original-refresh');
  const transport = createRealTransport({ configStore, tokenStore, dbInit: { locateFile: null, persistence }, agentConnection: {
    connect: async () => ({ connected: false, reason: 'no-key' as const }), disconnect: async () => {},
    isConnected: () => false, getPushedJobStatus: () => null, onJobStatus: () => () => {},
  } });
  const db = await transport.getRestaurantDatabase!();
  return { transport, db, persistence, configStore, tokenStore };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const open = (fixture: Fixture) => fixture.transport.openShift!({ staffId: userId, staffName: 'Owner', openingCash: 1234 });
function row(fixture: Fixture, localId: string) {
  return fixture.db.get<any>('SELECT backend_id, backend_binding_json FROM shifts WHERE id = ?', [localId]);
}
function replyWith(mutate: (body: any) => any = body => body) {
  const read = vi.fn();
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    return { ok: true, status: 200, json: async () => {
      read();
      return mutate({ id: backendShiftId, salonId, machineId: request.machineId, closedAt: null });
    } };
  });
  return read;
}

describe('Android shift declared device binding (real transport + SQL.js + fake HTTP)', () => {
  it('persists the device before HTTP and durably restores explicit server binding on restart', async () => {
    const fixture = await setup(undefined, `${apiUrl}/`);
    let savedDevice: string | undefined;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${apiUrl}/api/v1/pos/shifts/open`);
      const request = JSON.parse(init.body as string);
      expect(request).toMatchObject({ staffId: userId, openingCash: 1234, machineId: expect.any(String) });
      const durable = await initAndroidDb({ locateFile: null, persistence: fixture.persistence });
      savedDevice = durable.get<{ id: string }>('SELECT id FROM pos_device_identity WHERE singleton = 1')?.id;
      expect(request.machineId).toBe(savedDevice);
      expect(savedDevice).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      return json({ id: backendShiftId, salonId, machineId: request.machineId, closedAt: null });
    });
    const opened = await open(fixture);
    expect(opened.success).toBe(true);
    await vi.waitFor(() => expect(row(fixture, opened.shiftId!).backend_binding_json).not.toBeNull());
    await fixture.db.flush();
    const binding = { serverUrl: apiUrl, salonId, machineId: savedDevice, backendShiftId };
    expect(JSON.parse(row(fixture, opened.shiftId!).backend_binding_json)).toEqual(binding);
    const restored = await initAndroidDb({ locateFile: null, persistence: fixture.persistence });
    expect(restored.get<any>('SELECT backend_id, backend_binding_json FROM shifts WHERE id = ?', [opened.shiftId]))
      .toEqual({ backend_id: backendShiftId, backend_binding_json: JSON.stringify(binding) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['salonId', 'machineId', 'closedAt', 'id'])('keeps legacy mapping but no verified binding when %s evidence is omitted', async missing => {
    const fixture = await setup();
    const read = replyWith(body => { delete body[missing]; if (missing === 'id') body.shiftId = backendShiftId; return body; });
    const opened = await open(fixture);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1)); await settle();
    expect(row(fixture, opened.shiftId!)).toEqual({ backend_id: backendShiftId, backend_binding_json: null });
    await fixture.db.flush();
    const restored = await initAndroidDb({ locateFile: null, persistence: fixture.persistence });
    expect(restored.get<any>('SELECT backend_binding_json FROM shifts WHERE id = ?', [opened.shiftId])?.backend_binding_json).toBeNull();
  });

  it.each([
    ['wrong machine', (body: any) => { body.machineId = knownDeviceId; }],
    ['null machine', (body: any) => { body.machineId = null; }],
    ['blank machine', (body: any) => { body.machineId = ''; }],
    ['closed shift', (body: any) => { body.closedAt = '2026-09-08T12:00:00.000Z'; }],
    ['false closed value', (body: any) => { body.closedAt = false; }],
    ['empty closed value', (body: any) => { body.closedAt = ''; }],
    ['wrong salon', (body: any) => { body.salonId = knownDeviceId; }],
    ['null salon', (body: any) => { body.salonId = null; }],
    ['contradictory IDs', (body: any) => { body.shiftId = nextBackendShiftId; }],
    ['empty conflicting alias', (body: any) => { body.shiftId = ''; }],
    ['null conflicting alias', (body: any) => { body.shiftId = null; }],
    ['empty primary with valid alias', (body: any) => { body.id = ''; body.shiftId = backendShiftId; }],
    ['null primary with valid alias', (body: any) => { body.id = null; body.shiftId = backendShiftId; }],
  ] as const)('rejects entire mapping for declared %s', async (_name, mutate) => {
    const fixture = await setup(); const read = replyWith(body => { mutate(body); return body; });
    const opened = await open(fixture);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1)); await settle();
    expect(row(fixture, opened.shiftId!)).toEqual({ backend_id: null, backend_binding_json: null });
    await fixture.db.flush();
    const restored = await initAndroidDb({ locateFile: null, persistence: fixture.persistence });
    expect(restored.get<any>('SELECT backend_id, backend_binding_json FROM shifts WHERE id = ?', [opened.shiftId]))
      .toEqual({ backend_id: null, backend_binding_json: null });
  });

  it.each(['config', 'token', 'server'] as const)('does not dispatch under a new %s after waiting for device/shift storage', async change => {
    const fixture = await setup();
    const saveImage = fixture.persistence.saveImage.bind(fixture.persistence);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const save = vi.spyOn(fixture.persistence, 'saveImage').mockImplementationOnce(async image => { await barrier; await saveImage(image); });
    const opening = open(fixture);
    try {
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(fetchMock).not.toHaveBeenCalled();
      if (change === 'token') await fixture.tokenStore.setTokens('different-token', 'different-refresh');
      else fixture.configStore.setConfig(change === 'server' ? { apiUrl: 'https://different-server.invalid' } : { salonId: knownDeviceId });
    } finally { release(); }
    await opening; await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fixture.db.all<any>('SELECT backend_id, backend_binding_json FROM shifts')
      .every(shift => shift.backend_id === null && shift.backend_binding_json === null)).toBe(true);
    await fixture.db.flush();
  });

  it.each(['token', 'config'] as const)('rejects explicit late binding after %s changes', async change => {
    const fixture = await setup(); let finish!: (value: Response) => void; let machineId = '';
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      machineId = JSON.parse(init.body as string).machineId;
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    const opened = await open(fixture);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (change === 'token') await fixture.tokenStore.setTokens('new-token', 'new-refresh');
    else fixture.configStore.setConfig({ salonId: knownDeviceId });
    finish(json({ id: backendShiftId, salonId, machineId, closedAt: null })); await settle();
    expect(row(fixture, opened.shiftId!)).toEqual({ backend_id: null, backend_binding_json: null });
    await fixture.db.flush();
  });

  it('freezes staff and opening cash before an awaited save so caller mutation cannot split local/server amounts', async () => {
    const fixture = await setup(); replyWith();
    const original = { staffId: userId, staffName: 'Original Owner', openingCash: 1234 };
    const mutable = { ...original };
    const saveImage = fixture.persistence.saveImage.bind(fixture.persistence);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const save = vi.spyOn(fixture.persistence, 'saveImage').mockImplementationOnce(async image => { await barrier; await saveImage(image); });
    const opening = fixture.transport.openShift!(mutable);
    try {
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      Object.assign(mutable, { staffId: knownDeviceId, staffName: 'Replacement User', openingCash: 9999 });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { release(); }
    const opened = await opening;
    expect(opened.success).toBe(true);
    await vi.waitFor(() => expect(row(fixture, opened.shiftId!).backend_binding_json).not.toBeNull());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ staffId: original.staffId, openingCash: original.openingCash });
    expect(fixture.db.get<any>('SELECT staff_id, staff_name, opening_cash FROM shifts WHERE id = ?', [opened.shiftId]))
      .toEqual({ staff_id: original.staffId, staff_name: original.staffName, opening_cash: original.openingCash });
    await fixture.db.flush();
    const restored = await initAndroidDb({ locateFile: null, persistence: fixture.persistence });
    expect(restored.get<any>('SELECT staff_id, staff_name, opening_cash FROM shifts WHERE id = ?', [opened.shiftId]))
      .toEqual({ staff_id: original.staffId, staff_name: original.staffName, opening_cash: original.openingCash });
  });

  it('uses the same persisted device for a second shift after transport restart', async () => {
    const fixture = await setup(); replyWith();
    const first = await open(fixture);
    await vi.waitFor(() => expect(row(fixture, first.shiftId!).backend_id).toBe(backendShiftId));
    const firstDevice = JSON.parse(fetchMock.mock.calls[0][1].body).machineId;
    fetchMock.mockResolvedValue(json({ success: true }));
    expect(await fixture.transport.closeShift!({ shiftId: first.shiftId!, closingCash: 1234 })).toMatchObject({ success: true });
    await settle(); await fixture.db.flush();
    const restarted = await setup(fixture.persistence);
    fetchMock.mockReset(); replyWith(body => ({ ...body, id: nextBackendShiftId }));
    const second = await open(restarted);
    await vi.waitFor(() => expect(row(restarted, second.shiftId!).backend_id).toBe(nextBackendShiftId));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).machineId).toBe(firstDevice);
    expect(restarted.db.all('SELECT id FROM pos_device_identity')).toHaveLength(1);
    expect(JSON.parse(row(restarted, second.shiftId!).backend_binding_json)).toMatchObject({ machineId: firstDevice, backendShiftId: nextBackendShiftId });
    await restarted.db.flush();
  });

  it('does not invent verified evidence for a preexisting legacy shift on reopen', async () => {
    const fixture = await setup();
    fixture.db.run('INSERT INTO shifts (id, staff_id, staff_name, opening_cash, opened_at, backend_id) VALUES (?, ?, ?, 0, ?, ?)',
      [knownDeviceId, userId, 'Owner', '2026-09-08T09:00:00Z', backendShiftId]);
    await fixture.db.flush();
    const restarted = await setup(fixture.persistence);
    expect(row(restarted, knownDeviceId)).toEqual({ backend_id: backendShiftId, backend_binding_json: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('guarded Android shift-open HTTP context', () => {
  const data = () => ({ staffId: userId, openingCash: 1234, machineId: knownDeviceId });
  function clientSetup() {
    const provider = { getAccessToken: vi.fn(async () => 'original-token'), refresh: vi.fn(async () => true), onExpired: vi.fn() };
    return { provider, client: new PosApiClient({ baseUrl: apiUrl, tokenProvider: provider }) };
  }
  it('does not refresh or send a second shift-open POST after 401', async () => {
    const { client, provider } = clientSetup(); fetchMock.mockResolvedValue(json({ message: 'expired' }, 401));
    await expect(client.openPosShift(data(), async () => {})).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.refresh).not.toHaveBeenCalled(); expect(provider.onExpired).not.toHaveBeenCalled();
  });
  it('checks context before token lookup', async () => {
    const { client, provider } = clientSetup();
    await expect(client.openPosShift(data(), async () => { throw new Error('CONTEXT_CHANGED'); })).rejects.toThrow('CONTEXT_CHANGED');
    expect(provider.getAccessToken).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('checks context after token await and does not send old shift data with new credentials', async () => {
    const { client, provider } = clientSetup(); let current = true;
    provider.getAccessToken.mockImplementation(async () => { current = false; return 'replacement-token'; });
    await expect(client.openPosShift(data(), async () => { if (!current) throw new Error('CONTEXT_CHANGED'); })).rejects.toThrow('CONTEXT_CHANGED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects a late HTTP response before parsing its body', async () => {
    const { client } = clientSetup(); let current = true; const read = vi.fn(async () => ({ id: backendShiftId }));
    fetchMock.mockImplementation(async () => { current = false; return { ok: true, status: 200, json: read }; });
    await expect(client.openPosShift(data(), async () => { if (!current) throw new Error('CONTEXT_CHANGED'); })).rejects.toThrow('CONTEXT_CHANGED');
    expect(read).not.toHaveBeenCalled();
  });
  it.each([200, 409])('checks context after response JSON (HTTP %i)', async status => {
    const { client } = clientSetup(); let current = true;
    fetchMock.mockResolvedValue({ ok: status === 200, status, json: async () => { current = false; return { id: backendShiftId }; } });
    await expect(client.openPosShift(data(), async () => { if (!current) throw new Error('CONTEXT_CHANGED'); })).rejects.toThrow('CONTEXT_CHANGED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
