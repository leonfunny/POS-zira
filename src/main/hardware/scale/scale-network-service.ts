import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { networkInterfaces } from 'os';
import type { AgentConfig, ScaleConnectionMode, ScaleReadResult } from '../../../shared/types';
import logger from '../../logger';

import { DEFAULT_SCALE_SHARE_PORT, DEFAULT_REMOTE_SCALE_TIMEOUT_MS, SCALE_CONNECT_TIMEOUT_MS } from '../../../shared/scale-network-settings';
export { DEFAULT_SCALE_SHARE_PORT, DEFAULT_REMOTE_SCALE_TIMEOUT_MS } from '../../../shared/scale-network-settings';

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

function remoteScaleTargetLabel(host: string, port: number): string {
  return `${hostForUrl(host)}:${port}`;
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

  // Older installations persist 2000ms. Apply the read budget there as well.
  const timeoutMs = Math.max(DEFAULT_REMOTE_SCALE_TIMEOUT_MS, Math.min(Number(remote?.timeoutMs) || DEFAULT_REMOTE_SCALE_TIMEOUT_MS, 30_000));
  const targetLabel = remoteScaleTargetLabel(target.host, target.port);
  const controller = new AbortController();
  let stage: 'connection' | 'read' = 'connection';
  let timer = setTimeout(() => controller.abort(), SCALE_CONNECT_TIMEOUT_MS);

  try {
    // This endpoint exists on older sharing POS versions and never touches COM.
    const statusResponse = await fetch(`http://${targetLabel}/scale/status`, { signal: controller.signal });
    if (!statusResponse.ok) {
      return remoteScaleFailure(
        statusResponse.status === 403 ? 'REMOTE_FORBIDDEN' : 'REMOTE_HTTP_ERROR',
        `${targetLabel}: scale service check returned HTTP ${statusResponse.status}. ${statusResponse.status === 403 ? 'Use the sharing POS local network IP.' : 'Check the sharing POS address and port.'}`,
        target.host,
      );
    }
    const status = await statusResponse.json();
    if (status?.running !== true) {
      return remoteScaleFailure('REMOTE_NOT_SHARING', `${targetLabel}: scale sharing is not running. Enable sharing on the POS connected to the scale.`, target.host);
    }

    clearTimeout(timer);
    stage = 'read';
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://${targetLabel}/scale/read`, {
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
      const message = text
        ? `${targetLabel}: ${text.slice(0, 200)}`
        : `Remote scale at ${targetLabel} returned HTTP ${response.status}`;
      return remoteScaleFailure(
        response.status === 401 ? 'REMOTE_UNAUTHORIZED' : response.status === 403 ? 'REMOTE_FORBIDDEN' : 'REMOTE_HTTP_ERROR',
        message,
        target.host,
      );
    }

    const result = normalizeRemoteScalePayload(await response.json(), target.host);
    if (!result.success) {
      result.error = `${targetLabel}: scale service connected; ${result.port ? `${result.port}: ` : ''}${result.error}`;
    }
    return result;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      return remoteScaleFailure(
        stage === 'connection' ? 'REMOTE_TIMEOUT' : 'REMOTE_READ_TIMEOUT',
        stage === 'connection'
          ? `${targetLabel}: scale service did not answer within ${SCALE_CONNECT_TIMEOUT_MS} ms. Check the host IP, scale sharing, and Windows Firewall.`
          : `${targetLabel}: scale service connected, but no weight arrived within ${timeoutMs} ms. Test the scale on the sharing POS and select its COM port explicitly.`,
        target.host,
      );
    }
    if (error instanceof SyntaxError) {
      return remoteScaleFailure('REMOTE_PARSE_FAILED', `${targetLabel}: invalid scale service response during ${stage}. Check the host IP and port.`, target.host);
    }
    return remoteScaleFailure(
      'REMOTE_NETWORK_ERROR',
      `${targetLabel}: ${stage === 'read' ? 'connection lost while reading the scale' : 'scale service is unreachable'} (${error?.cause?.code || error?.message || 'network error'}). Check the host IP, scale sharing, and Windows Firewall.`,
      target.host,
    );
  } finally {
    clearTimeout(timer);
  }
}

export class ScaleNetworkService {
  private server: Server | null = null;
  private activePort: number | null = null;
  private activeToken = '';
  private lastError: string | undefined;
  private pendingRead: Promise<ScaleReadResult> | null = null;

  constructor(
    private readonly getConfig: () => AgentConfig,
    private readonly readLocal: ScaleReadLocal,
  ) {}

  async applyConfig(): Promise<void> {
    const config = this.getConfig();
    const scale = config.scale;
    const connection = resolveScaleConnection(config);
    const shareRequested = scale?.share?.enabled === true;
    const shouldShare = connection === 'local' && shareRequested;
    const token = String(scale?.share?.token || '').trim();
    const port = coerceScaleNetworkPort(scale?.share?.port, DEFAULT_SCALE_SHARE_PORT);

    if (!shouldShare || !token) {
      if (shareRequested && connection !== 'local') {
        this.lastError = 'Wi-Fi scale sharing only runs when Scale mode is "This POS has scale".';
        logger.warn(`[ScaleNetwork] Share requested while scale connection is ${connection}; not starting server`);
      } else if (shouldShare && !token) {
        this.lastError = 'Pairing code is required before Wi-Fi scale sharing can start.';
        logger.warn('[ScaleNetwork] Share requested without a pairing token; not starting server');
      } else {
        this.lastError = undefined;
      }
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

    // Concurrent POS requests share one physical reading instead of competing for COM.
    if (!this.pendingRead) {
      this.pendingRead = Promise.resolve().then(() => this.readLocal()).finally(() => {
        this.pendingRead = null;
      });
    }
    const result = await this.pendingRead;
    sendJson(res, 200, result);
  }
}
