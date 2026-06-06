import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createReadStream, statSync } from 'fs';
import type { AddressInfo } from 'net';
import logger from '../logger';
import { buildAdPlaylistPayload } from './ad-playlist';
import { parseRangeHeader } from './http-range';
import { getLanIpv4List, pickPrimaryLanIp } from './ad-net';
import type { AdDisplayStatus, TvAdConfig } from './ad-types';
import type { AdVideoStore } from './ad-video-store';

export class AdDisplayServer {
  private server: Server | null = null;
  private activePort: number | null = null;
  private sseClients = new Set<ServerResponse>();
  private lastError: string | undefined;

  constructor(
    private readonly getConfig: () => TvAdConfig,
    private readonly store: AdVideoStore,
  ) {}

  async applyConfig(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.tvAdEnabled) {
      await this.stop();
      return;
    }
    if (this.server && this.activePort !== null) {
      // running already; nothing structural changed (port handled on restart only)
      return;
    }
    await this.start(cfg.tvAdPort ?? 17893);
  }

  private start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.on('error', (err) => {
        this.lastError = err.message;
        logger.error('[AdDisplay] server error:', err);
        reject(err);
      });
      server.listen(port, () => {
        this.server = server;
        this.activePort = (server.address() as AddressInfo).port;
        this.lastError = undefined;
        logger.info(`[AdDisplay] LAN server listening on ${this.activePort}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const c of this.sseClients) { try { c.end(); } catch { /* ignore */ } }
    this.sseClients.clear();
    const server = this.server;
    this.server = null;
    this.activePort = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  getStatus(): AdDisplayStatus {
    const ips = getLanIpv4List();
    return {
      running: !!this.server,
      port: this.activePort,
      ips,
      primaryIp: pickPrimaryLanIp(ips),
      connectedClients: this.sseClients.size,
      error: this.lastError,
    };
  }

  /** Gọi khi config/playlist đổi → đẩy SSE để TV reload. */
  broadcastChanged(): void {
    const version = buildAdPlaylistPayload(this.getConfig()).version;
    const frame = `event: playlist-changed\ndata: ${JSON.stringify({ version })}\n\n`;
    for (const c of this.sseClients) { try { c.write(frame); } catch { /* ignore */ } }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*' };

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: true, app: 'zira-ads' }));
      return;
    }

    if (url.pathname === '/playlist.json') {
      const payload = buildAdPlaylistPayload(this.getConfig());
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors });
      res.end(JSON.stringify(payload));
      return;
    }

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...cors,
      });
      res.write(': connected\n\n');
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }

    if (url.pathname.startsWith('/video/')) {
      this.serveVideo(url.pathname.slice('/video/'.length), req, res, cors);
      return;
    }

    res.writeHead(404, cors);
    res.end();
  }

  private serveVideo(id: string, req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): void {
    const cfg = this.getConfig();
    const item = (cfg.tvAdPlaylist || []).find(v => v.id === id);
    if (!item || !this.store.exists(item.filename)) {
      res.writeHead(404, cors);
      res.end();
      return;
    }
    const full = this.store.resolvePath(item.id, item.filename);
    let size: number;
    try {
      size = statSync(full).size;
    } catch (e) {
      // File vanished between exists() and statSync (e.g. concurrent remove).
      logger.error('[AdDisplay] stat video failed:', (e as Error)?.message || e);
      res.writeHead(404, cors);
      res.end();
      return;
    }
    const range = parseRangeHeader(req.headers.range, size);

    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'content-range': `bytes */${size}`, ...cors });
      res.end();
      return;
    }
    // Single stream with error handling: a read error AFTER the stream opens
    // (file removed mid-stream, IO error, or the TV aborting the socket) must
    // NOT bubble up as an uncaughtException — that would pop a modal on the POS.
    const stream = range
      ? createReadStream(full, { start: range.start, end: range.end })
      : createReadStream(full);
    stream.on('error', (e) => {
      logger.error('[AdDisplay] video stream error:', (e as Error)?.message || e);
      if (!res.headersSent) res.writeHead(404, cors);
      res.destroy();
    });
    res.on('close', () => stream.destroy());

    if (range) {
      const { start, end } = range;
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        ...cors,
      });
    } else {
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-length': String(size),
        ...cors,
      });
    }
    stream.pipe(res);
  }
}
