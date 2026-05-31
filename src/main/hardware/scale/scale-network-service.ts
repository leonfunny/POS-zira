import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { networkInterfaces } from 'os';
import type { AgentConfig, ScaleConnectionMode, ScaleReadResult } from '../../../shared/types';
import logger from '../../logger';

export const DEFAULT_SCALE_SHARE_PORT = 17891;
export const DEFAULT_REMOTE_SCALE_TIMEOUT_MS = 2000;

type ScaleReadLocal = () => Promise<ScaleReadResult>;

export interface ScaleNetworkInfo {
  ips: string[];
  suggestedHost: string;
  defaultPort: number;
}

export interface ScaleShareStatus extends ScaleNetworkInfo {
  running: boolean;
  port: number | null;
  error?: string;
}

export function resolveScaleConnection(config: AgentConfig): ScaleConnectionMode {
  const scale = config.scale;
  if (!scale?.enabled) return 'none';
  if (scale.connection === 'remote') return 'remote';
  if (scale.connection === 'none') return 'none';
  return 'local';
}

export function coerceScaleNetworkPort(value: unknown, fallback = DEFAULT_SCALE_SHARE_PORT): number {
  const port = Number(value);
  if (Number.isInteger(port) && port >= 0 && port <= 65535) return port;
  return fallback;
}

export function getScaleNetworkInfo(): ScaleNetworkInfo {
  const ips: string[] = [];
  const interfaces = networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      ips.push(entry.address);
    }
  }

  return {
    ips,
    suggestedHost: ips.find((ip) => ip.startsWith('192.168.')) || ips[0] || '127.0.0.1',
    defaultPort: DEFAULT_SCALE_SHARE_PORT,
  };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function normalizeRemoteAddress(address?: string): string {
  const raw = String(address || '').trim();
  if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length);
  if (raw === '::1') return '127.0.0.1';
  return raw;
}

function isLanOrLoopbackAddress(address?: string): boolean {
  const ip = normalizeRemoteAddress(address);
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === 'localhost') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^(fc|fd|fe80):/i.test(ip)) return true;
  return false;
}

function requestToken(req: IncomingMessage, url: URL): string {
  const header = req.headers['x-zira-scale-token'];
  const value = Array.isArray(header) ? header[0] : header;
  return String(value || url.searchParams.get('token') || '').trim();
}

function parseRemoteScaleTarget(hostInput: string, configuredPort: number): { host: string; port: number } | null {
  const raw = hostInput.trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const port = parsed.port ? coerceScaleNetworkPort(parsed.port, configuredPort) : configuredPort;
    return { host: parsed.hostname, port };
  } catch {
    return { host: raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''), port: configuredPort };
  }
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function remoteScaleFailure(code: string, error: string, host?: string): ScaleReadResult {
  return {
    success: false,
    protocol: 'DIBAL_GDPOS',
    code,
    error,
    source: 'remote',
    remoteHost: host,
  };
}

function normalizeRemoteScalePayload(payload: any, host: string): ScaleReadResult {
  const data = payload?.result ?? payload;
  if (data?.success === true && Number.isFinite(Number(data.weightKg))) {
    return {
      success: true,
      protocol: 'DIBAL_GDPOS',
      port: String(data.port || `remote:${host}`),
      weightKg: Number(data.weightKg),
      stable: data.stable !== false,
      status: String(data.status || ''),
      rawAscii: typeof data.rawAscii === 'string' ? data.rawAscii : undefined,
      rawHex: typeof data.rawHex === 'string' ? data.rawHex : undefined,
      source: 'remote',
      remoteHost: host,
    };
  }

  if (data?.success === false) {
    return {
      success: false,
      protocol: 'DIBAL_GDPOS',
      port: typeof data.port === 'string' ? data.port : undefined,
      error: String(data.error || 'Remote scale did not return a weight'),
      code: String(data.code || 'REMOTE_SCALE_FAILED'),
      rawAscii: typeof data.rawAscii === 'string' ? data.rawAscii : undefined,
      rawHex: typeof data.rawHex === 'string' ? data.rawHex : undefined,
      status: typeof data.status === 'string' ? data.status : undefined,
      source: 'remote',
      remoteHost: host,
    };
  }

  return remoteScaleFailure('REMOTE_PARSE_FAILED', 'Remote scale returned an invalid response', host);
}

export async function readRemoteScaleWeight(config: AgentConfig): Promise<ScaleReadResult> {
  const remote = config.scale?.remote;
  const configuredPort = coerceScaleNetworkPort(remote?.port, DEFAULT_SCALE_SHARE_PORT);
  const target = parseRemoteScaleTarget(String(remote?.host || ''), configuredPort);
  if (!target?.host) return remoteScaleFailure('REMOTE_NOT_CONFIGURED', 'Remote scale host is not configured');

  const token = String(remote?.token || '').trim();
  if (!token) return remoteScaleFailure('REMOTE_TOKEN_MISSING', 'Remote scale pairing code is not configured', target.host);

  const timeoutMs = Math.max(500, Math.min(Number(remote?.timeoutMs) || DEFAULT_REMOTE_SCALE_TIMEOUT_MS, 10_000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`http://${hostForUrl(target.host)}:${target.port}/scale/read`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zira-scale-token': token,
      },
      body: '{}',
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const message = text ? text.slice(0, 200) : `Remote scale returned HTTP ${response.status}`;
      return remoteScaleFailure(
        response.status === 401 ? 'REMOTE_UNAUTHORIZED' : 'REMOTE_HTTP_ERROR',
        message,
        target.host,
      );
    }

    return normalizeRemoteScalePayload(await response.json(), target.host);
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      return remoteScaleFailure('REMOTE_TIMEOUT', `Remote scale timed out after ${timeoutMs} ms`, target.host);
    }
    return remoteScaleFailure('REMOTE_NETWORK_ERROR', error?.message || 'Remote scale network error', target.host);
  } finally {
    clearTimeout(timer);
  }
}

export class ScaleNetworkService {
  private server: Server | null = null;
  private activePort: number | null = null;
  private activeToken = '';
  private lastError: string | undefined;

  constructor(
    private readonly getConfig: () => AgentConfig,
    private readonly readLocal: ScaleReadLocal,
  ) {}

  async applyConfig(): Promise<void> {
    const config = this.getConfig();
    const scale = config.scale;
    const shouldShare =
      resolveScaleConnection(config) === 'local' &&
      scale?.share?.enabled === true;
    const token = String(scale?.share?.token || '').trim();
    const port = coerceScaleNetworkPort(scale?.share?.port, DEFAULT_SCALE_SHARE_PORT);

    if (!shouldShare || !token) {
      if (shouldShare && !token) logger.warn('[ScaleNetwork] Share requested without a pairing token; not starting server');
      await this.stop();
      return;
    }

    if (this.server && this.activePort === port && this.activeToken === token) return;

    await this.stop();
    await this.start(port, token);
  }

  getStatus(): ScaleShareStatus {
    const info = getScaleNetworkInfo();
    return {
      ...info,
      running: !!this.server,
      port: this.activePort,
      error: this.lastError,
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.activePort = null;
    this.activeToken = '';
    if (!server) return;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    logger.info('[ScaleNetwork] Stopped remote scale share server');
  }

  private async start(port: number, token: string): Promise<void> {
    this.lastError = undefined;
    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error: any) => {
        logger.error('[ScaleNetwork] Request failed:', error);
        sendJson(res, 500, { success: false, error: error?.message || 'Remote scale server error' });
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', onError);
        resolve();
      });
    }).catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    });

    this.server = server;
    this.activeToken = token;
    const address = server.address() as AddressInfo | null;
    this.activePort = address?.port ?? port;
    logger.info(`[ScaleNetwork] Sharing scale on 0.0.0.0:${this.activePort}`);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://scale.local');
    const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress);

    if (!isLanOrLoopbackAddress(remoteAddress)) {
      logger.warn(`[ScaleNetwork] Blocked non-LAN scale request from ${remoteAddress || 'unknown'}`);
      sendJson(res, 403, { success: false, error: 'Remote scale is only available on the local network' });
      return;
    }

    if (url.pathname === '/scale/status') {
      sendJson(res, 200, this.getStatus());
      return;
    }

    if (url.pathname !== '/scale/read') {
      sendJson(res, 404, { success: false, error: 'Not found' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { success: false, error: 'Method not allowed' });
      return;
    }

    if (!this.activeToken || requestToken(req, url) !== this.activeToken) {
      sendJson(res, 401, { success: false, error: 'Invalid remote scale pairing code' });
      return;
    }

    const result = await this.readLocal();
    sendJson(res, 200, result);
  }
}
