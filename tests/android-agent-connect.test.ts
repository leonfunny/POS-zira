/**
 * E-PARITY-1 — print-agent connection (pa_ key + /print-agent/connect + socket).
 *
 * Proves the Android shim connects to the salon's print-agent exactly like the
 * Windows counter (trusted-terminal parity): it fetches + stores the pa_ key,
 * registers via /print-agent/connect, opens the Socket.IO `/print-agent`
 * namespace with the pa_ auth, treats socket job-status pushes as the PRIMARY
 * print-completion signal (HTTP poll is the fallback), and disconnects + drops
 * the key on logout. A fake io() + fake client keep it network-free.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createAgentConnection,
  type AgentConnectDeps,
} from '../src/renderer/android-pos/shim/agent-connect';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore, type TokenStoreStorage } from '../src/renderer/android-pos/shim/token-store';
import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { PosApiClient } from '../src/renderer/android-pos/port/api-client';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';
import { createRemotePrintCoordinator } from '../src/renderer/android-pos/shim/remote-print';

const NODE_LOCATE_FILE = null;
const API_URL = 'https://api.enail.pro';

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

/** A controllable fake Socket.IO socket (structurally a MinimalAgentSocket). */
function fakeSocket() {
  const handlers = new Map<string, (...args: any[]) => void>();
  const disconnect = vi.fn();
  const socket = {
    connected: false,
    on(ev: string, cb: (...args: any[]) => void) { handlers.set(ev, cb); return socket; },
    disconnect,
    emit(ev: string, ...args: any[]) { handlers.get(ev)?.(...args); },
  };
  return socket;
}

/** A fake api-client exposing only the two methods agent-connect calls. */
function fakeClient(opts: {
  key?: string | null;
  connectImpl?: () => Promise<Record<string, any>>;
} = {}) {
  const key = opts.key === undefined ? 'pa_test_key_123' : opts.key;
  return {
    getMyPrintAgentKey: vi.fn(async () => (key ? { apiKey: key } : null)),
    connectPrintAgent: vi.fn(
      opts.connectImpl ?? (async () => ({ agentId: 'agent-1', salonId: 'salon-1' })),
    ),
  };
}

function buildAgent(over: Partial<AgentConnectDeps> & {
  client?: ReturnType<typeof fakeClient>;
  socket?: ReturnType<typeof fakeSocket>;
} = {}) {
  const client = over.client ?? fakeClient();
  const socket = over.socket ?? fakeSocket();
  const tokenStore = (over.tokenStore as TokenStore) ?? new TokenStore({ storage: memoryStorage() });
  const configStore = over.configStore ?? new ShimConfigStore({ storage: memoryStorage() });
  let capturedUri = '';
  let capturedOpts: Record<string, any> = {};
  const agent = createAgentConnection({
    client,
    tokenStore,
    configStore,
    apiUrl: over.apiUrl ?? API_URL,
    ioFactory: (uri, o) => { capturedUri = uri; capturedOpts = o; return socket; },
  });
  return { agent, client, socket, tokenStore, configStore, io: () => ({ capturedUri, capturedOpts }) };
}

describe('createAgentConnection (E-PARITY-1)', () => {
  test('fetches + stores the pa_ key, registers, and opens the /print-agent socket', async () => {
    const { agent, client, tokenStore, io } = buildAgent();

    const result = await agent.connect();

    expect(result).toEqual({ connected: true });
    expect(client.getMyPrintAgentKey).toHaveBeenCalledTimes(1);
    // key persisted for the next boot (mirror Windows setSecureApiKey).
    expect(await tokenStore.getPrintAgentKey()).toBe('pa_test_key_123');
    // registered via /print-agent/connect with the fetched key.
    expect(client.connectPrintAgent).toHaveBeenCalledWith('pa_test_key_123', expect.any(Object));
    // socket opened to the /print-agent namespace with the pa_ auth.
    const { capturedUri, capturedOpts } = io();
    expect(capturedUri).toBe(`${API_URL}/print-agent`);
    expect(capturedOpts.auth.apiKey).toBe('pa_test_key_123');
    expect(capturedOpts.transports).toEqual(['websocket']);
    expect(capturedOpts.reconnection).toBe(true);
  });

  test('persists the connect-response identity (agentId/salonCode) to config', async () => {
    const client = fakeClient();
    client.connectPrintAgent = vi.fn(async () => ({
      agentId: 'agent-77', salonCode: '6535', salonName: 'Smile', salonSlug: 'smile',
    }));
    const { agent, configStore } = buildAgent({ client });

    await agent.connect();

    const cfg = configStore.getRawConfig() as any;
    // So downstream product-admin sends X-Agent-Id / X-Salon-Code (like Windows).
    expect(cfg.agentId).toBe('agent-77');
    expect(cfg.salonCode).toBe('6535');
  });

  test('reuses a stored pa_ key without re-fetching from /my-key', async () => {
    const tokenStore = new TokenStore({ storage: memoryStorage() });
    await tokenStore.setPrintAgentKey('pa_already_stored');
    const { agent, client } = buildAgent({ tokenStore });

    await agent.connect();

    expect(client.getMyPrintAgentKey).not.toHaveBeenCalled();
    expect(client.connectPrintAgent).toHaveBeenCalledWith('pa_already_stored', expect.any(Object));
  });

  test('a job-status push updates the pushed-status cache and notifies listeners', async () => {
    const { agent, socket } = buildAgent();
    await agent.connect();
    const seen: any[] = [];
    agent.onJobStatus((p) => seen.push(p));

    socket.emit('connect');
    expect(agent.isConnected()).toBe(true);

    socket.emit('job:updated', { jobId: 'job-9', status: 'COMPLETED' });
    expect(agent.getPushedJobStatus('job-9')).toMatchObject({ jobId: 'job-9', status: 'COMPLETED' });
    expect(seen).toHaveLength(1);

    // job:new is a DISPATCH (work order) to a printing agent, NOT a status —
    // a submitter terminal must NOT cache it as a job status.
    socket.emit('job:new', { id: 'job-10', status: 'SENT' });
    expect(agent.getPushedJobStatus('job-10')).toBeNull();
    expect(agent.getPushedJobStatus('missing')).toBeNull();
  });

  test('no salon agent key → graceful REST-only, no socket, no register', async () => {
    const client = fakeClient({ key: null });
    const { agent, io } = buildAgent({ client });

    const result = await agent.connect();

    expect(result).toEqual({ connected: false, reason: 'no-key' });
    expect(client.connectPrintAgent).not.toHaveBeenCalled();
    expect(io().capturedUri).toBe(''); // ioFactory never called
  });

  test('a /print-agent/connect REST failure is non-fatal — the socket still opens', async () => {
    const client = fakeClient({ connectImpl: async () => { throw new Error('connect 503'); } });
    const { agent, io } = buildAgent({ client });

    const result = await agent.connect();

    expect(result).toEqual({ connected: true });
    expect(io().capturedUri).toBe(`${API_URL}/print-agent`);
  });

  test('a logout during an in-flight connect aborts before opening a zombie socket', async () => {
    // getMyPrintAgentKey stays pending until we release it — the race window.
    let releaseKey: (v: { apiKey: string } | null) => void = () => {};
    const keyPromise = new Promise<{ apiKey: string } | null>((r) => { releaseKey = r; });
    const client = {
      getMyPrintAgentKey: vi.fn(() => keyPromise),
      connectPrintAgent: vi.fn(async () => ({})),
    };
    const { agent, io, socket, tokenStore } = buildAgent({ client });

    const inFlight = agent.connect();     // starts, parks on getMyPrintAgentKey
    await agent.disconnect();             // logout supersedes the in-flight connect
    releaseKey({ apiKey: 'pa_late_key' }); // key resolves AFTER the logout
    const result = await inFlight;

    expect(result).toEqual({ connected: false, reason: 'superseded' });
    expect(io().capturedUri).toBe('');                 // NO socket opened
    expect(client.connectPrintAgent).not.toHaveBeenCalled();
    expect(socket.disconnect).not.toHaveBeenCalled();  // there was no socket to close
    expect(await tokenStore.getPrintAgentKey()).toBeNull(); // no late key persisted
  });

  test('logout disconnects the socket and clears the stored pa_ key', async () => {
    const { agent, socket, tokenStore } = buildAgent();
    await agent.connect();
    socket.emit('connect');
    socket.emit('job:updated', { jobId: 'job-1', status: 'PRINTING' });

    await agent.disconnect();

    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(await tokenStore.getPrintAgentKey()).toBeNull();
    expect(agent.isConnected()).toBe(false);
    expect(agent.getPushedJobStatus('job-1')).toBeNull(); // cache cleared
  });
});

describe('cross-tenant pa_ key guard on login (E-PARITY-1)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  test('logging into a DIFFERENT salon drops the previous salon pa_ key', async () => {
    // Device was paired to salon-A and holds salon-A's pa_ key.
    const storage = memoryStorage();
    const tokenStore = new TokenStore({ storage: memoryStorage() });
    await tokenStore.setPrintAgentKey('pa_salonA_secret');
    const configStore = new ShimConfigStore({ storage });
    configStore.setConfig({ salonId: 'salon-A', salonName: 'Salon A' } as never);

    const transport = createRealTransport({ configStore, tokenStore, dbInit: { locateFile: NODE_LOCATE_FILE } });

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/auth/login')) {
        return jsonResponse({
          access_token: 'jwt-B', refresh_token: 'ref-B',
          user: {
            id: 'staff-B', email: 'b@salon.pl', firstName: 'Bea', lastName: 'Kowalska',
            role: 'STAFF', salonId: 'salon-B', // switched from salon-A
            salon: { id: 'salon-B', name: 'Salon B', slug: 'salon-b' },
          },
        });
      }
      // my-key returns no key for salon-B → connect() stays REST-only, opens no socket.
      if (u.includes('/print-agent/my-key')) return jsonResponse({});
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await transport.loginWithEmail!('b@salon.pl', 'pw');
    expect(result.success).toBe(true);

    // The stale salon-A key MUST be gone — it can never connect salon-B's
    // terminal to salon-A's print-agent (cross-tenant leak).
    expect(await tokenStore.getPrintAgentKey()).toBeNull();
  });
});

describe('socket-push is the PRIMARY print signal (E-PARITY-1 ↔ remote-print)', () => {
  const ORDER = {
    id: 'order-1', order_number: 'POS-1', status: 'COMPLETED',
    subtotal: 4900, discount: 0, tax: 0, total: 4900,
    payment_method: 'CASH', payment_amount: 5000, change_amount: 100,
    staff_name: 'Ala', source: 'POS', mode: 'retail',
  };
  const ITEMS = [{
    id: 'l1', order_id: 'order-1', variant_id: 'p1', name: 'Gel Polish',
    sku: 'SKU-1', price: 4900, quantity: 1, sell_by: 'PIECE', total: 4900, vat_rate: 23,
  }];
  const ASSIGNED = {
    assignments: [{ id: 'a1', salonId: 'salon-1', role: 'SELF_CHECKOUT_RECEIPT', printerId: 'printer-1' }],
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  test('a pushed terminal status resolves the print WITHOUT an HTTP getPrintJobStatus poll', async () => {
    // Agent (fake socket) that has already been pushed a COMPLETED status for job-1.
    const { agent, socket } = buildAgent();
    await agent.connect();
    socket.emit('job:updated', { jobId: 'job-1', status: 'COMPLETED' });

    // Coordinator over a real db + api-client; fetch is stubbed. getPrintJobStatus
    // THROWS so the test fails loudly if the poll path is ever taken.
    const db = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    createOrderRepo(db).create(ORDER, ITEMS);
    const configStore = new ShimConfigStore({ storage: memoryStorage() });
    const client = new PosApiClient({
      baseUrl: API_URL,
      tokenProvider: { getAccessToken: async () => 'jwt-staff', refresh: async () => false, onExpired: () => undefined },
      salonSlug: 'test-salon',
    });

    let statusPolls = 0;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const m = String(init?.method ?? 'GET');
      if (u.includes('/print-agent/salons/me/printer-assignments')) return jsonResponse(ASSIGNED);
      if (m === 'POST' && /\/print-agent\/jobs$/.test(u)) return jsonResponse({ jobId: 'job-1', status: 'SENT' });
      if (/\/print-agent\/jobs\/job-1$/.test(u)) { statusPolls += 1; throw new Error('getPrintJobStatus MUST NOT be polled when the socket already pushed a terminal status'); }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const coordinator = createRemotePrintCoordinator({
      client,
      db: async () => db,
      configStore,
      machineId: 'device-1',
      pollIntervalMs: 5,
      totalWaitMs: 200,
      assignmentCacheTtlMs: 1000,
      getPushedJobStatus: (jobId) => agent.getPushedJobStatus(jobId),
    });

    const result = await coordinator.requestReceiptPrint('order-1');

    expect(result.receiptPrinted).toBe(true);
    expect(statusPolls).toBe(0); // the socket push replaced the HTTP poll entirely
  });
});
