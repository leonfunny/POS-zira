import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createReadStream, statSync } from 'fs';
import type { AddressInfo } from 'net';
import logger from '../logger';
import { buildAdPlaylistPayload } from './ad-playlist';
import { parseRangeHeader } from './http-range';
import { getLanIpv4List, pickPrimaryLanIp } from './ad-net';
import { getTvAppUpdateAsset, TV_APP_APK_ROUTE, TV_APP_LATEST_VERSION_CODE, TV_APP_LATEST_VERSION_NAME } from './tv-app-update';
import type { AdDisplayStatus, TvAdConfig } from './ad-types';
import type { AdVideoStore } from './ad-video-store';

type TvAdConfigPatch = Partial<Pick<TvAdConfig,
  'tvAdEnabled' | 'tvAdPlaybackMode' | 'tvAdRepeatVideoId' | 'tvAdMuted' | 'tvAdVolume' | 'tvAdPlaylist'
>>;

export class AdDisplayServer {
  private server: Server | null = null;
  private activePort: number | null = null;
  private sseClients = new Set<ServerResponse>();
  private lastError: string | undefined;

  constructor(
    private readonly getConfig: () => TvAdConfig,
    private readonly store: AdVideoStore,
    private readonly applyConfigPatch: (patch: TvAdConfigPatch) => Promise<void>,
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
    const primaryIp = pickPrimaryLanIp(ips);
    const port = this.activePort;
    return {
      running: !!this.server,
      port,
      ips,
      primaryIp,
      connectedClients: this.sseClients.size,
      remoteUrl: this.server && primaryIp && port
        ? `http://${primaryIp}:${port}/remote?token=${encodeURIComponent(this.getConfig().tvAdControlToken || '')}`
        : undefined,
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
    void this.handleAsync(req, res).catch((e) => {
      logger.error('[AdDisplay] request failed:', (e as Error)?.message || e);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      }
      res.end(JSON.stringify({ ok: false, error: (e as Error)?.message || 'request failed' }));
    });
  }

  private async handleAsync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, x-zira-filename, authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: true, app: 'zira-ads' }));
      return;
    }

    if (url.pathname === '/remote') {
      this.serveRemoteApp(res, cors);
      return;
    }

    if (url.pathname === '/control/status') {
      if (!this.authorize(url, req)) return this.unauthorized(res, cors);
      this.json(res, {
        ok: true,
        status: this.getStatus(),
        config: this.publicControlConfig(),
        playlist: buildAdPlaylistPayload(this.getConfig()),
      }, cors);
      return;
    }

    if (url.pathname === '/control/media' && req.method === 'POST') {
      if (!this.authorize(url, req)) return this.unauthorized(res, cors);
      const filename = this.uploadFilename(req, url);
      if (!filename) {
        this.json(res, { ok: false, error: 'missing filename' }, cors, 400);
        return;
      }
      const added = await this.store.addUpload(filename, req);
      const cfg = this.getConfig();
      const playlist = [...(cfg.tvAdPlaylist || []), {
        ...added,
        order: (cfg.tvAdPlaylist || []).length,
        enabled: true,
      }];
      await this.applyConfigPatch({ tvAdEnabled: true, tvAdPlaylist: playlist });
      this.broadcastChanged();
      this.json(res, { ok: true, item: added, config: this.publicControlConfig() }, cors);
      return;
    }

    if (url.pathname === '/control/config' && (req.method === 'POST' || req.method === 'PATCH')) {
      if (!this.authorize(url, req)) return this.unauthorized(res, cors);
      const body = await this.readJson(req, 1024 * 256);
      const patch = this.sanitizeControlPatch(body);
      await this.applyConfigPatch(patch);
      this.broadcastChanged();
      this.json(res, { ok: true, config: this.publicControlConfig() }, cors);
      return;
    }

    if (url.pathname.startsWith('/control/media/') && req.method === 'DELETE') {
      if (!this.authorize(url, req)) return this.unauthorized(res, cors);
      const id = decodeURIComponent(url.pathname.slice('/control/media/'.length));
      const cfg = this.getConfig();
      const item = (cfg.tvAdPlaylist || []).find(v => v.id === id);
      if (!item) {
        this.json(res, { ok: false, error: 'media not found' }, cors, 404);
        return;
      }
      const playlist = (cfg.tvAdPlaylist || [])
        .filter(v => v.id !== id)
        .map((v, order) => ({ ...v, order }));
      this.store.removeVideo(item.filename);
      await this.applyConfigPatch({ tvAdPlaylist: playlist });
      this.broadcastChanged();
      this.json(res, { ok: true, config: this.publicControlConfig() }, cors);
      return;
    }

    if (url.pathname === '/playlist.json') {
      const payload = buildAdPlaylistPayload(this.getConfig());
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors });
      res.end(JSON.stringify(payload));
      return;
    }

    if (url.pathname === '/tv-app/update.json') {
      const asset = getTvAppUpdateAsset();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors });
      res.end(JSON.stringify({
        app: 'zira-tv-ads',
        latestVersionCode: TV_APP_LATEST_VERSION_CODE,
        latestVersionName: TV_APP_LATEST_VERSION_NAME,
        apkUrl: asset ? TV_APP_APK_ROUTE : null,
        apkSize: asset?.size ?? null,
        apkSha256: asset?.sha256 ?? null,
      }));
      return;
    }

    if (url.pathname === TV_APP_APK_ROUTE) {
      this.serveTvAppApk(req, res, cors);
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

    if (url.pathname.startsWith('/media/')) {
      this.serveMedia(url.pathname.slice('/media/'.length), req, res, cors);
      return;
    }

    if (url.pathname.startsWith('/video/')) {
      this.serveMedia(url.pathname.slice('/video/'.length), req, res, cors);
      return;
    }

    res.writeHead(404, cors);
    res.end();
  }

  private authorize(url: URL, req: IncomingMessage): boolean {
    const token = this.getConfig().tvAdControlToken;
    if (!token) return false;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    return url.searchParams.get('token') === token || bearer === token;
  }

  private unauthorized(res: ServerResponse, cors: Record<string, string>): void {
    this.json(res, { ok: false, error: 'unauthorized' }, cors, 401);
  }

  private publicControlConfig() {
    const cfg = this.getConfig();
    return {
      tvAdEnabled: cfg.tvAdEnabled,
      tvAdPlaybackMode: cfg.tvAdPlaybackMode,
      tvAdRepeatVideoId: cfg.tvAdRepeatVideoId,
      tvAdMuted: cfg.tvAdMuted,
      tvAdVolume: cfg.tvAdVolume,
      tvAdPlaylist: cfg.tvAdPlaylist || [],
    };
  }

  private uploadFilename(req: IncomingMessage, url: URL): string | null {
    const fromHeader = req.headers['x-zira-filename'];
    const raw = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
    const value = raw || url.searchParams.get('filename') || '';
    try {
      return decodeURIComponent(value).trim() || null;
    } catch {
      return value.trim() || null;
    }
  }

  private async readJson(req: IncomingMessage, maxBytes: number): Promise<any> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) throw new Error('request body too large');
      chunks.push(buf);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  private sanitizeControlPatch(input: any): TvAdConfigPatch {
    const patch: TvAdConfigPatch = {};
    if (typeof input?.tvAdEnabled === 'boolean') patch.tvAdEnabled = input.tvAdEnabled;
    if (input?.tvAdPlaybackMode === 'sequential' || input?.tvAdPlaybackMode === 'repeat-one') {
      patch.tvAdPlaybackMode = input.tvAdPlaybackMode;
    }
    if (typeof input?.tvAdRepeatVideoId === 'string' || input?.tvAdRepeatVideoId === null) {
      patch.tvAdRepeatVideoId = input.tvAdRepeatVideoId;
    }
    if (typeof input?.tvAdMuted === 'boolean') patch.tvAdMuted = input.tvAdMuted;
    if (input?.tvAdVolume !== undefined) {
      const volume = Number(input.tvAdVolume);
      if (Number.isFinite(volume)) patch.tvAdVolume = Math.max(0, Math.min(100, Math.round(volume)));
    }
    if (Array.isArray(input?.tvAdPlaylist)) {
      const existing = new Map((this.getConfig().tvAdPlaylist || []).map(v => [v.id, v]));
      patch.tvAdPlaylist = input.tvAdPlaylist
        .map((raw: any, order: number) => {
          const current = existing.get(String(raw?.id));
          if (!current) return null;
          return {
            ...current,
            order,
            enabled: typeof raw.enabled === 'boolean' ? raw.enabled : current.enabled,
            durationMs: raw.durationMs !== undefined ? Number(raw.durationMs) : current.durationMs,
          };
        })
        .filter(Boolean);
    }
    return patch;
  }

  private json(res: ServerResponse, payload: unknown, cors: Record<string, string>, status = 200): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors });
    res.end(JSON.stringify(payload));
  }

  private serveRemoteApp(res: ServerResponse, cors: Record<string, string>): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...cors });
    res.end(`<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Zira TV Remote</title>
  <style>
    :root { color-scheme: light; --bg:#f7f8fa; --panel:#fff; --text:#151922; --muted:#667085; --line:#d9dee8; --brand:#14532d; --danger:#b42318; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
    header { position:sticky; top:0; z-index:2; padding:14px 16px; background:rgba(247,248,250,.92); backdrop-filter: blur(12px); border-bottom:1px solid var(--line); }
    h1 { margin:0; font-size:20px; line-height:1.2; }
    main { padding:16px; display:grid; gap:14px; max-width:720px; margin:0 auto; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
    .row { display:flex; gap:10px; align-items:center; justify-content:space-between; }
    .stack { display:grid; gap:10px; }
    .muted { color:var(--muted); font-size:13px; }
    button, .fileBtn { border:1px solid var(--line); border-radius:8px; background:#fff; min-height:42px; padding:0 14px; font-weight:650; color:var(--text); }
    button.primary, .fileBtn { background:var(--brand); border-color:var(--brand); color:#fff; }
    button.danger { color:var(--danger); }
    button:disabled { opacity:.55; }
    input[type=file] { display:none; }
    input[type=range] { width:100%; accent-color:var(--brand); }
    .item { display:grid; grid-template-columns: 1fr auto; gap:10px; align-items:center; border-top:1px solid var(--line); padding-top:10px; }
    .item:first-child { border-top:0; padding-top:0; }
    .name { font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pill { display:inline-flex; align-items:center; height:24px; padding:0 8px; border-radius:999px; background:#eef2f7; color:#344054; font-size:12px; }
    .progress { height:8px; background:#e7ebf2; border-radius:99px; overflow:hidden; }
    .bar { height:100%; width:0; background:var(--brand); transition:width .2s; }
    .toast { position:fixed; left:16px; right:16px; bottom:16px; padding:12px 14px; background:#151922; color:#fff; border-radius:8px; font-size:14px; display:none; }
  </style>
</head>
<body>
  <header>
    <h1>Zira TV Remote</h1>
    <div id="subtitle" class="muted">Dang ket noi POS...</div>
  </header>
  <main>
    <section class="panel stack">
      <label class="fileBtn row" for="mediaInput"><span>Chon anh / video</span><span>Upload</span></label>
      <input id="mediaInput" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" multiple />
      <div class="progress"><div id="uploadBar" class="bar"></div></div>
      <div id="uploadText" class="muted">Chon 1 hoac nhieu file tu dien thoai. TV se cap nhat sau khi upload xong.</div>
    </section>

    <section class="panel stack">
      <div class="row">
        <div>
          <div class="name">Playback</div>
          <div id="modeText" class="muted">Sequential</div>
        </div>
        <button id="modeBtn">Repeat</button>
      </div>
      <div class="row">
        <button id="muteBtn">Mute</button>
        <div class="muted" id="volumeText">Volume 0%</div>
      </div>
      <input id="volume" type="range" min="0" max="100" value="0" />
    </section>

    <section class="panel stack">
      <div class="row">
        <div>
          <div class="name">Playlist</div>
          <div id="countText" class="muted">0 media</div>
        </div>
        <button id="refreshBtn">Refresh</button>
      </div>
      <div id="items" class="stack"></div>
    </section>
  </main>
  <div id="toast" class="toast"></div>
  <script>
    const params = new URLSearchParams(location.search);
    const token = params.get('token') || localStorage.getItem('ziraTvToken') || '';
    if (token) localStorage.setItem('ziraTvToken', token);
    let cfg = null;

    const el = (id) => document.getElementById(id);
    const api = (path) => path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    const toast = (msg) => { el('toast').textContent = msg; el('toast').style.display = 'block'; setTimeout(() => el('toast').style.display = 'none', 2600); };

    async function request(path, opts = {}) {
      const res = await fetch(api(path), opts);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || 'Request failed');
      return json;
    }

    async function load() {
      try {
        const data = await request('/control/status');
        cfg = data.config;
        render();
      } catch (e) {
        el('subtitle').textContent = 'Khong dieu khien duoc POS. Quet lai QR tren POS.';
        toast(e.message || 'Connection failed');
      }
    }

    function render() {
      const list = cfg?.tvAdPlaylist || [];
      el('subtitle').textContent = 'Da ket noi POS - TV se tu cap nhat';
      el('modeText').textContent = cfg.tvAdPlaybackMode === 'repeat-one' ? 'Repeat one' : 'Sequential';
      el('modeBtn').textContent = cfg.tvAdPlaybackMode === 'repeat-one' ? 'Sequential' : 'Repeat';
      el('muteBtn').textContent = cfg.tvAdMuted ? 'Unmute' : 'Mute';
      el('volume').value = String(cfg.tvAdVolume || 0);
      el('volumeText').textContent = 'Volume ' + (cfg.tvAdVolume || 0) + '%';
      el('countText').textContent = list.length + ' media';
      el('items').innerHTML = list.length ? '' : '<div class="muted">Chua co anh/video nao.</div>';
      list.slice().sort((a,b) => a.order - b.order).forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'item';
        row.innerHTML =
          '<div><div class="name">' + escapeHtml(item.filename) + '</div>' +
          '<div class="muted"><span class="pill">' + (item.type || 'video') + '</span> ' +
          (item.enabled ? 'dang phat' : 'dang tat') + '</div></div>' +
          '<div class="stack">' +
          '<button data-act="toggle" data-id="' + item.id + '">' + (item.enabled ? 'Tat' : 'Bat') + '</button>' +
          '<button class="danger" data-act="delete" data-id="' + item.id + '">Xoa</button>' +
          '</div>';
        el('items').appendChild(row);
      });
    }

    async function save(patch) {
      const data = await request('/control/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      cfg = data.config;
      render();
    }

    async function uploadFiles(files) {
      const all = Array.from(files || []);
      if (!all.length) return;
      for (let i = 0; i < all.length; i++) {
        const file = all[i];
        el('uploadText').textContent = 'Dang upload ' + file.name + ' (' + (i + 1) + '/' + all.length + ')';
        el('uploadBar').style.width = Math.round((i / all.length) * 100) + '%';
        await fetch(api('/control/media'), {
          method: 'POST',
          headers: { 'x-zira-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' },
          body: file,
        }).then(async (res) => {
          const json = await res.json().catch(() => ({}));
          if (!res.ok || json.ok === false) throw new Error(json.error || 'Upload failed');
          cfg = json.config;
        });
      }
      el('uploadBar').style.width = '100%';
      el('uploadText').textContent = 'Upload xong. TV dang cap nhat playlist.';
      render();
      toast('Da dua len TV playlist');
      setTimeout(() => { el('uploadBar').style.width = '0'; }, 1200);
    }

    function escapeHtml(s) {
      return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
    }

    el('mediaInput').addEventListener('change', (e) => uploadFiles(e.target.files).catch(err => toast(err.message)));
    el('refreshBtn').addEventListener('click', () => load());
    el('modeBtn').addEventListener('click', () => save({ tvAdPlaybackMode: cfg.tvAdPlaybackMode === 'repeat-one' ? 'sequential' : 'repeat-one' }).catch(err => toast(err.message)));
    el('muteBtn').addEventListener('click', () => save({ tvAdMuted: !cfg.tvAdMuted }).catch(err => toast(err.message)));
    el('volume').addEventListener('change', (e) => save({ tvAdVolume: Number(e.target.value), tvAdMuted: false }).catch(err => toast(err.message)));
    el('items').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.act === 'toggle') {
        const next = (cfg.tvAdPlaylist || []).map(x => x.id === id ? { ...x, enabled: !x.enabled } : x);
        await save({ tvAdPlaylist: next });
      }
      if (btn.dataset.act === 'delete') {
        if (!confirm('Xoa media nay?')) return;
        const data = await request('/control/media/' + encodeURIComponent(id), { method: 'DELETE' });
        cfg = data.config;
        render();
      }
    });
    load();
  </script>
</body>
</html>`);
  }

  private serveMedia(id: string, req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): void {
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
      logger.error('[AdDisplay] stat media failed:', (e as Error)?.message || e);
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
      logger.error('[AdDisplay] media stream error:', (e as Error)?.message || e);
      if (!res.headersSent) res.writeHead(404, cors);
      res.destroy();
    });
    res.on('close', () => stream.destroy());

    if (range) {
      const { start, end } = range;
      res.writeHead(206, {
        'content-type': this.store.getContentType(item.filename),
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        ...cors,
      });
    } else {
      res.writeHead(200, {
        'content-type': this.store.getContentType(item.filename),
        'accept-ranges': 'bytes',
        'content-length': String(size),
        ...cors,
      });
    }
    stream.pipe(res);
  }

  private serveTvAppApk(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): void {
    const asset = getTvAppUpdateAsset();
    if (!asset) {
      res.writeHead(404, cors);
      res.end();
      return;
    }
    this.serveFile(asset.path, 'application/vnd.android.package-archive', req, res, cors);
  }

  private serveFile(full: string, contentType: string, req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): void {
    let size: number;
    try {
      size = statSync(full).size;
    } catch (e) {
      logger.error('[AdDisplay] stat file failed:', (e as Error)?.message || e);
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
    const stream = range
      ? createReadStream(full, { start: range.start, end: range.end })
      : createReadStream(full);
    stream.on('error', (e) => {
      logger.error('[AdDisplay] file stream error:', (e as Error)?.message || e);
      if (!res.headersSent) res.writeHead(404, cors);
      res.destroy();
    });
    res.on('close', () => stream.destroy());

    if (range) {
      const { start, end } = range;
      res.writeHead(206, {
        'content-type': contentType,
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        ...cors,
      });
    } else {
      res.writeHead(200, {
        'content-type': contentType,
        'accept-ranges': 'bytes',
        'content-length': String(size),
        ...cors,
      });
    }
    stream.pipe(res);
  }
}
