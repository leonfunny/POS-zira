/**
 * agent-connect.ts — print-agent connection for the Android POS shim (E-PARITY-1).
 *
 * A FAITHFUL PORT of the Windows main-process connection flow so the Sunmi
 * terminal connects to the salon's print-agent exactly like the Windows counter:
 *
 *   1. fetch the salon-wide `pa_` key   — GET /print-agent/my-key (staff JWT)
 *      (Windows: ApiClient.getMyPrintAgentKey, api-client.ts:3222)
 *   2. register this terminal            — POST /print-agent/connect (pa_ key)
 *      (Windows: ApiClient.connectWithApiKey, api-client.ts:1331;
 *       AuthModule.connectWithAvailablePrintAgentKey, auth.module.ts:998)
 *   3. open the realtime socket          — io(`${url}/print-agent`, { auth:{apiKey} })
 *      (Windows: SocketClient.connectWithApiKey, socket-client.ts:30-92)
 *
 * ─── Trusted-terminal rationale ─────────────────────────────────────────────
 * The pre-E-PARITY shim was deliberately staff-JWT-only with NO pa_ key and NO
 * socket — the "lost-tablet" rail. Owner decision 2026-07-19: the target is a
 * DEDICATED, FIXED Sunmi POS terminal, trusted like the Windows counter, so it
 * may hold the pa_ key and connect over the socket. The cross-platform boundary
 * verifier is relaxed for the shim graph accordingly (socket.io-client vendor
 * chunk + the /print-agent/connect·my-key routes) — see
 * scripts/verify-cross-platform-boundaries.mjs and
 * docs/android-pos/PROMPT_E-PARITY_trusted-terminal.md.
 *
 * ─── What Android canNOT copy ───────────────────────────────────────────────
 * Windows' native serial/USB fiscal + card drivers are NOT ported here — those
 * stay on the salon's print-agent host and are reached over this same socket
 * (fiscal via E-FISCAL). This module only opens the connection; it drives no
 * hardware directly.
 *
 * ─── Logging ────────────────────────────────────────────────────────────────
 * The pa_ key VALUE is never logged (parity with the Windows "don't log the key,
 * even partial" rule).
 */

import { io } from 'socket.io-client';

import type { ShimConfigStore } from './config-store';
import type { AgentConfig } from '../../../shared/types';

/** Socket-client reconnect policy — mirrors socket-client.ts:23-24,48-49. */
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 5_000;
/** LRU bound on the pushed job-status cache (parity with the coordinator's KNOWN_JOBS_MAX). */
const PUSHED_STATUS_MAX = 100;

/** Minimal Socket.IO surface this module uses — kept loose so a fake socket can
 *  stand in for tests without a real network. */
export interface MinimalAgentSocket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  disconnect(): unknown;
  connected?: boolean;
}

/** io() factory. Defaults to the real socket.io-client; tests inject a fake. */
export type AgentIoFactory = (uri: string, opts: Record<string, any>) => MinimalAgentSocket;

const defaultIoFactory: AgentIoFactory = (uri, opts) =>
  io(uri, opts) as unknown as MinimalAgentSocket;

/** A print-job status pushed by the server over the socket (`job:new` /
 *  `job:updated`). Shape-compatible with the coordinator's poll result: it reads
 *  `.status` / `.jobId` / `.id`. */
export type PushedJobStatus = Record<string, any>;

export interface AgentConnectDeps {
  /** The staff-JWT api-client (its getMyPrintAgentKey + connectPrintAgent). */
  client: {
    getMyPrintAgentKey(): Promise<{ apiKey: string } | null>;
    connectPrintAgent(
      apiKey: string,
      meta?: { machineId?: string; appVersion?: string; osVersion?: string },
    ): Promise<Record<string, any>>;
  };
  /** Secure store for the pa_ key. */
  tokenStore: {
    getPrintAgentKey(): Promise<string | null>;
    setPrintAgentKey(key: string): Promise<void>;
    clearPrintAgentKey(): Promise<void>;
  };
  configStore: ShimConfigStore;
  /** Server origin (no trailing /api/v1) — the socket namespace host. */
  apiUrl: string;
  /** Injected io() for tests; defaults to the real socket.io-client. */
  ioFactory?: AgentIoFactory;
  /** Injected logger (no-op by default); NEVER receives the key value. */
  log?: (message: string) => void;
}

export interface AgentConnectResult {
  connected: boolean;
  /** Why the connection did not open, when connected === false.
   *  'superseded' = a logout / newer connect ran while this attempt was in flight. */
  reason?: 'no-key' | 'error' | 'superseded';
  error?: string;
}

export interface AgentConnection {
  /** Fetch key → register → open socket. Mirrors the Windows post-login sequence.
   *  Non-blocking on the socket handshake: it wires handlers and returns; the
   *  socket connects asynchronously so a slow server never stalls login. */
  connect(): Promise<AgentConnectResult>;
  /** Close the socket and drop the stored pa_ key (logout / unpair). */
  disconnect(): Promise<void>;
  /** True once the socket has fired 'connect'. */
  isConnected(): boolean;
  /** The most recent server-pushed status for a job, or null. Consumed by the
   *  remote-print coordinator as the PRIMARY signal (HTTP poll is the fallback). */
  getPushedJobStatus(jobId: string): PushedJobStatus | null;
  /** Subscribe to raw job-status pushes. Returns an unsubscribe fn. */
  onJobStatus(cb: (payload: PushedJobStatus) => void): () => void;
}

export function createAgentConnection(deps: AgentConnectDeps): AgentConnection {
  const ioFactory = deps.ioFactory ?? defaultIoFactory;
  const log = deps.log ?? (() => {});

  let socket: MinimalAgentSocket | null = null;
  let connected = false;
  // Race epoch: connect() is fired non-blocking on login, so a fast logout (or a
  // second login) can run disconnect()/connect() WHILE the first connect() is
  // still awaiting my-key/connect. Both disconnect() and a new connect() bump
  // this; an in-flight connect() aborts before opening a zombie socket that
  // would outlive the session and re-hold a just-cleared key.
  let epoch = 0;
  const pushedStatuses = new Map<string, PushedJobStatus>();
  const jobStatusListeners = new Set<(payload: PushedJobStatus) => void>();

  const machineId = (): string | undefined => {
    const raw = String(
      (deps.configStore.getRawConfig() as AgentConfig & { machineId?: string | null }).machineId ?? '',
    ).trim();
    return raw || undefined;
  };

  const recordJobStatus = (payload: PushedJobStatus | undefined): void => {
    if (!payload || typeof payload !== 'object') return;
    const jobId = payload.jobId || payload.id;
    if (!jobId) return;
    // LRU: refresh insertion order so the newest jobs survive the bound.
    if (pushedStatuses.has(jobId)) pushedStatuses.delete(jobId);
    pushedStatuses.set(jobId, payload);
    while (pushedStatuses.size > PUSHED_STATUS_MAX) {
      const oldest = pushedStatuses.keys().next().value;
      if (oldest === undefined) break;
      pushedStatuses.delete(oldest);
    }
    for (const cb of [...jobStatusListeners]) {
      try { cb(payload); } catch { /* listener isolation */ }
    }
  };

  return {
    async connect(): Promise<AgentConnectResult> {
      // Claim this epoch (also supersedes any older in-flight connect). If it
      // changes across an await, a disconnect() or newer connect() has run and
      // this attempt must abort WITHOUT opening a socket or persisting a key.
      const myEpoch = ++epoch;
      const superseded = (): boolean => myEpoch !== epoch;

      // 1) Resolve the pa_ key: stored first, else fetch-or-create via my-key.
      let key = await deps.tokenStore.getPrintAgentKey();
      if (superseded()) return { connected: false, reason: 'superseded' };
      if (!key) {
        const fetched = await deps.client.getMyPrintAgentKey();
        if (superseded()) return { connected: false, reason: 'superseded' };
        if (fetched?.apiKey) {
          key = fetched.apiKey;
          await deps.tokenStore.setPrintAgentKey(key);
          if (superseded()) return { connected: false, reason: 'superseded' };
        }
      }
      if (!key) {
        // No agent key for this salon yet — not an error; the terminal simply
        // stays REST-only until an agent key exists (graceful, like Windows'
        // "No print-agent API key available" soft path).
        log('[agent-connect] no print-agent key available; staying REST-only');
        return { connected: false, reason: 'no-key' };
      }

      // 2) Register this terminal. A REST failure is non-fatal — Windows proceeds
      //    socket-only (auth.module.ts:949-955).
      try {
        await deps.client.connectPrintAgent(key, { machineId: machineId() });
      } catch (e: any) {
        log(`[agent-connect] /print-agent/connect failed, socket-only: ${e?.message || e}`);
      }
      // A logout/re-login during the await above must not now open a zombie socket.
      if (superseded()) return { connected: false, reason: 'superseded' };

      // 3) Open the realtime socket (socket-client.ts:41-50). Non-blocking.
      try {
        const mid = machineId();
        socket = ioFactory(`${deps.apiUrl}/print-agent`, {
          auth: { apiKey: key, ...(mid ? { machineId: mid } : {}) },
          transports: ['websocket'],
          reconnection: true,
          reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
          reconnectionDelay: RECONNECT_DELAY_MS,
        });
        socket.on('connect', () => { connected = true; log('[agent-connect] socket connected'); });
        socket.on('connected', () => { connected = true; });
        socket.on('disconnect', () => { connected = false; });
        socket.on('connect_error', (err: any) => {
          connected = false;
          log(`[agent-connect] socket connect_error: ${err?.message || err}`);
        });
        // Print-job status pushes — the primary print-completion signal
        // (socket-client.ts:425-433 job:new / job:updated).
        socket.on('job:new', recordJobStatus);
        socket.on('job:updated', recordJobStatus);
        return { connected: true };
      } catch (e: any) {
        log(`[agent-connect] socket open failed: ${e?.message || e}`);
        return { connected: false, reason: 'error', error: e?.message || String(e) };
      }
    },

    async disconnect(): Promise<void> {
      // Invalidate any in-flight connect() so it aborts before opening a socket.
      epoch++;
      try { socket?.disconnect(); } catch { /* best-effort */ }
      socket = null;
      connected = false;
      pushedStatuses.clear();
      await deps.tokenStore.clearPrintAgentKey();
    },

    isConnected(): boolean {
      return connected || socket?.connected === true;
    },

    getPushedJobStatus(jobId: string): PushedJobStatus | null {
      return pushedStatuses.get(jobId) ?? null;
    },

    onJobStatus(cb: (payload: PushedJobStatus) => void): () => void {
      jobStatusListeners.add(cb);
      return () => jobStatusListeners.delete(cb);
    },
  };
}
