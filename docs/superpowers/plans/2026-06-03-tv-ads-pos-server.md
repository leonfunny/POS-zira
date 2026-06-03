# TV Quảng Cáo — Plan 1: POS LAN Server + Settings (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** POS-zira phục vụ một playlist video quảng cáo qua HTTP LAN + quảng bá mDNS, điều khiển toàn bộ từ Settings, để một Google TV kéo về phát.

**Architecture:** Một module mới `AdDisplayModule` (theo `BaseModule`) chạy HTTP server nội bộ (style giống `ScaleNetworkService`) phục vụ `/playlist.json`, `/video/:id` (HTTP Range), `/events` (SSE), `/health`; quảng bá `_zira-ads._tcp` qua mDNS. Settings.tsx thêm section quản lý video + chế độ phát. Cấu hình lưu trong `AgentConfig`, video copy vào `userData/ad-videos/`.

**Tech Stack:** Electron + TypeScript, Node `http`, `bonjour-service` (mDNS, pure JS), vitest. Spec: `docs/superpowers/specs/2026-06-03-tv-ads-signage-design.md`.

**Scope:** CHỈ phía POS. App Android TV là **Plan 2** riêng (viết sau, dựa trên API contract chốt ở Task 5).

---

## File Structure

- Create `src/main/ad-display/ad-types.ts` — types nội bộ module (playlist payload, status).
- Create `src/main/ad-display/ad-playlist.ts` — pure: dựng payload `/playlist.json` + tính `version` hash.
- Create `src/main/ad-display/http-range.ts` — pure: parse `Range` header.
- Create `src/main/ad-display/ad-video-store.ts` — quản lý thư mục `ad-videos/` (add/remove/resolve).
- Create `src/main/ad-display/ad-net.ts` — pure: liệt kê IPv4 LAN.
- Create `src/main/ad-display/ad-mdns.ts` — wrapper mDNS advertise (`bonjour-service`).
- Create `src/main/ad-display/ad-display-server.ts` — HTTP server (routes + SSE + lifecycle).
- Create `src/main/modules/ad-display.module.ts` — `BaseModule` wiring server+mdns+IPC.
- Modify `src/shared/types.ts` — thêm field `AgentConfig` + `IPC_CHANNELS` mới.
- Modify `src/main/config/store.ts` — default cho field mới.
- Modify `src/main/index.ts` — `.use(new AdDisplayModule(container))`.
- Modify `src/preload/preload-pos.ts` + `src/preload/preload.ts` + `src/shared/electron.d.ts` — expose API renderer.
- Modify `src/renderer/components/Settings.tsx` + `src/renderer/i18n/translations.ts` — section UI.
- Tests: `tests/ad-display/*.spec.ts`.

---

## Task 1: Config schema + defaults

**Files:**
- Modify: `src/shared/types.ts` (interface `AgentConfig`)
- Modify: `src/main/config/store.ts` (defaults)
- Test: `tests/ad-display/config-defaults.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ad-display/config-defaults.spec.ts
import { describe, it, expect } from 'vitest';
import { AD_DISPLAY_DEFAULTS } from '../../src/main/ad-display/ad-types';

describe('ad-display config defaults', () => {
  it('defaults: disabled, port 17893, sequential, muted', () => {
    expect(AD_DISPLAY_DEFAULTS.tvAdEnabled).toBe(false);
    expect(AD_DISPLAY_DEFAULTS.tvAdPort).toBe(17893);
    expect(AD_DISPLAY_DEFAULTS.tvAdPlaybackMode).toBe('sequential');
    expect(AD_DISPLAY_DEFAULTS.tvAdMuted).toBe(true);
    expect(AD_DISPLAY_DEFAULTS.tvAdVolume).toBe(0);
    expect(AD_DISPLAY_DEFAULTS.tvAdPlaylist).toEqual([]);
    expect(AD_DISPLAY_DEFAULTS.tvAdRepeatVideoId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ad-display/config-defaults.spec.ts`
Expected: FAIL — cannot find module `ad-types` / `AD_DISPLAY_DEFAULTS`.

- [ ] **Step 3: Create types + defaults**

```ts
// src/main/ad-display/ad-types.ts
export type TvAdPlaybackMode = 'sequential' | 'repeat-one';

export interface TvAdVideo {
  id: string;        // stable id, e.g. 'ad_<timestamp>_<rand>'
  filename: string;  // file trong ad-videos/, vd 'ad_169..._a1.mp4'
  order: number;     // 0-based, thứ tự phát
  enabled: boolean;
}

export interface TvAdConfig {
  tvAdEnabled: boolean;
  tvAdPort: number;
  tvAdPlaybackMode: TvAdPlaybackMode;
  tvAdRepeatVideoId: string | null;
  tvAdMuted: boolean;
  tvAdVolume: number; // 0..100
  tvAdPlaylist: TvAdVideo[];
}

export const AD_DISPLAY_DEFAULTS: TvAdConfig = {
  tvAdEnabled: false,
  tvAdPort: 17893,
  tvAdPlaybackMode: 'sequential',
  tvAdRepeatVideoId: null,
  tvAdMuted: true,
  tvAdVolume: 0,
  tvAdPlaylist: [],
};

// Payload trả cho app TV qua GET /playlist.json
export interface AdPlaylistPayload {
  version: string;
  playbackMode: TvAdPlaybackMode;
  repeatVideoId: string | null;
  muted: boolean;
  volume: number;
  videos: Array<{ id: string; url: string; order: number }>;
}

export interface AdDisplayStatus {
  running: boolean;
  port: number | null;
  ips: string[];
  connectedClients: number;
  error?: string;
}
```

- [ ] **Step 4: Add fields to `AgentConfig` and defaults in store**

In `src/shared/types.ts`, inside `interface AgentConfig { ... }` add:

```ts
  // TV Ads (signage) — điều khiển màn hình quảng cáo Google TV qua LAN
  tvAdEnabled?: boolean;
  tvAdPort?: number;
  tvAdPlaybackMode?: 'sequential' | 'repeat-one';
  tvAdRepeatVideoId?: string | null;
  tvAdMuted?: boolean;
  tvAdVolume?: number;
  tvAdPlaylist?: Array<{ id: string; filename: string; order: number; enabled: boolean }>;
```

In `src/main/config/store.ts`, find the default config object (the literal merged inside `getConfig()`/store schema defaults) and add the same keys using `AD_DISPLAY_DEFAULTS`. Add import at top:

```ts
import { AD_DISPLAY_DEFAULTS } from '../ad-display/ad-types';
```

and spread into the defaults literal:

```ts
  ...AD_DISPLAY_DEFAULTS,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/ad-display/config-defaults.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/ad-display/ad-types.ts src/shared/types.ts src/main/config/store.ts tests/ad-display/config-defaults.spec.ts
git commit -m "feat(tv-ads): add config schema + defaults for TV signage"
```

---

## Task 2: Playlist payload + version hash (pure)

**Files:**
- Create: `src/main/ad-display/ad-playlist.ts`
- Test: `tests/ad-display/ad-playlist.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ad-display/ad-playlist.spec.ts
import { describe, it, expect } from 'vitest';
import { buildAdPlaylistPayload, computeAdVersion } from '../../src/main/ad-display/ad-playlist';
import { AD_DISPLAY_DEFAULTS } from '../../src/main/ad-display/ad-types';

const base = {
  ...AD_DISPLAY_DEFAULTS,
  tvAdPlaylist: [
    { id: 'b', filename: 'b.mp4', order: 1, enabled: true },
    { id: 'a', filename: 'a.mp4', order: 0, enabled: true },
    { id: 'c', filename: 'c.mp4', order: 2, enabled: false },
  ],
};

describe('buildAdPlaylistPayload', () => {
  it('returns only enabled videos, sorted by order, with /video/:id urls', () => {
    const p = buildAdPlaylistPayload(base);
    expect(p.videos.map(v => v.id)).toEqual(['a', 'b']);
    expect(p.videos[0].url).toBe('/video/a');
    expect(p.playbackMode).toBe('sequential');
    expect(p.muted).toBe(true);
  });

  it('version changes when playlist or settings change, stable otherwise', () => {
    const v1 = computeAdVersion(base);
    const v2 = computeAdVersion(base);
    expect(v1).toBe(v2);
    const v3 = computeAdVersion({ ...base, tvAdMuted: false });
    expect(v3).not.toBe(v1);
    const v4 = computeAdVersion({ ...base, tvAdPlaylist: [base.tvAdPlaylist[0]] });
    expect(v4).not.toBe(v1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ad-display/ad-playlist.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/main/ad-display/ad-playlist.ts
import { createHash } from 'crypto';
import type { AdPlaylistPayload, TvAdConfig } from './ad-types';

export function buildAdPlaylistPayload(config: TvAdConfig): AdPlaylistPayload {
  const videos = (config.tvAdPlaylist || [])
    .filter(v => v.enabled)
    .sort((a, b) => a.order - b.order)
    .map(v => ({ id: v.id, url: `/video/${v.id}`, order: v.order }));

  return {
    version: computeAdVersion(config),
    playbackMode: config.tvAdPlaybackMode,
    repeatVideoId: config.tvAdRepeatVideoId,
    muted: config.tvAdMuted,
    volume: config.tvAdVolume,
    videos,
  };
}

export function computeAdVersion(config: TvAdConfig): string {
  const signature = {
    mode: config.tvAdPlaybackMode,
    repeat: config.tvAdRepeatVideoId,
    muted: config.tvAdMuted,
    volume: config.tvAdVolume,
    videos: (config.tvAdPlaylist || [])
      .filter(v => v.enabled)
      .sort((a, b) => a.order - b.order)
      .map(v => `${v.id}:${v.order}`),
  };
  return createHash('sha1').update(JSON.stringify(signature)).digest('hex').slice(0, 12);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ad-display/ad-playlist.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ad-display/ad-playlist.ts tests/ad-display/ad-playlist.spec.ts
git commit -m "feat(tv-ads): playlist payload builder + version hash"
```

---

## Task 3: HTTP Range parser (pure)

**Files:**
- Create: `src/main/ad-display/http-range.ts`
- Test: `tests/ad-display/http-range.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ad-display/http-range.spec.ts
import { describe, it, expect } from 'vitest';
import { parseRangeHeader } from '../../src/main/ad-display/http-range';

describe('parseRangeHeader', () => {
  const size = 1000;
  it('returns null when no range header', () => {
    expect(parseRangeHeader(undefined, size)).toBeNull();
    expect(parseRangeHeader('', size)).toBeNull();
  });
  it('parses bytes=0-499', () => {
    expect(parseRangeHeader('bytes=0-499', size)).toEqual({ start: 0, end: 499 });
  });
  it('open-ended bytes=500- goes to last byte', () => {
    expect(parseRangeHeader('bytes=500-', size)).toEqual({ start: 500, end: 999 });
  });
  it('suffix bytes=-200 returns last 200 bytes', () => {
    expect(parseRangeHeader('bytes=-200', size)).toEqual({ start: 800, end: 999 });
  });
  it('returns "unsatisfiable" when start >= size', () => {
    expect(parseRangeHeader('bytes=2000-3000', size)).toBe('unsatisfiable');
  });
  it('clamps end to size-1', () => {
    expect(parseRangeHeader('bytes=0-99999', size)).toEqual({ start: 0, end: 999 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ad-display/http-range.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/main/ad-display/http-range.ts
export type ParsedRange = { start: number; end: number } | 'unsatisfiable' | null;

export function parseRangeHeader(header: string | undefined, size: number): ParsedRange {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;

  if (rawStart === '' && rawEnd === '') return null;

  // suffix: bytes=-N (last N bytes)
  if (rawStart === '') {
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return null;
    const start = Math.max(0, size - n);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isInteger(start) || start < 0) return null;
  if (start >= size) return 'unsatisfiable';

  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isInteger(end) || end < start) return null;
  return { start, end };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ad-display/http-range.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ad-display/http-range.ts tests/ad-display/http-range.spec.ts
git commit -m "feat(tv-ads): HTTP Range header parser"
```

---

## Task 4: Video file store

**Files:**
- Create: `src/main/ad-display/ad-video-store.ts`
- Test: `tests/ad-display/ad-video-store.spec.ts`

`AdVideoStore` nhận `baseDir` qua constructor (tiêm được để test với temp dir; runtime truyền `path.join(app.getPath('userData'), 'ad-videos')`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/ad-display/ad-video-store.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AdVideoStore } from '../../src/main/ad-display/ad-video-store';

let dir: string;
let srcDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'advids-'));
  srcDir = mkdtempSync(join(tmpdir(), 'adsrc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

describe('AdVideoStore', () => {
  it('addVideo copies file in and returns id+filename', () => {
    const src = join(srcDir, 'promo.mp4');
    writeFileSync(src, 'FAKEMP4');
    const store = new AdVideoStore(dir);
    const rec = store.addVideo(src);
    expect(rec.id).toMatch(/^ad_/);
    expect(rec.filename.endsWith('.mp4')).toBe(true);
    expect(existsSync(store.resolvePath(rec.id, rec.filename))).toBe(true);
  });

  it('rejects non-mp4 extension', () => {
    const src = join(srcDir, 'note.txt');
    writeFileSync(src, 'x');
    const store = new AdVideoStore(dir);
    expect(() => store.addVideo(src)).toThrow(/mp4/i);
  });

  it('removeVideo deletes the file', () => {
    const src = join(srcDir, 'a.mp4');
    writeFileSync(src, 'x');
    const store = new AdVideoStore(dir);
    const rec = store.addVideo(src);
    store.removeVideo(rec.filename);
    expect(existsSync(store.resolvePath(rec.id, rec.filename))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ad-display/ad-video-store.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/main/ad-display/ad-video-store.ts
import { mkdirSync, copyFileSync, rmSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';

const ALLOWED = new Set(['.mp4', '.m4v', '.mov']);

export interface AddedVideo { id: string; filename: string; }

export class AdVideoStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(this.baseDir, { recursive: true });
  }

  addVideo(srcPath: string): AddedVideo {
    const ext = extname(srcPath).toLowerCase();
    if (!ALLOWED.has(ext)) {
      throw new Error(`Unsupported video type "${ext}". Use mp4 (H.264).`);
    }
    const id = `ad_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const filename = `${id}${ext}`;
    copyFileSync(srcPath, join(this.baseDir, filename));
    return { id, filename };
  }

  removeVideo(filename: string): void {
    // chỉ cho phép xoá file trong baseDir (chống path traversal)
    const safe = basename(filename);
    const full = join(this.baseDir, safe);
    if (existsSync(full)) rmSync(full, { force: true });
  }

  resolvePath(_id: string, filename: string): string {
    return join(this.baseDir, basename(filename));
  }

  exists(filename: string): boolean {
    return existsSync(join(this.baseDir, basename(filename)));
  }
}
```

> Lưu ý: `Math.random()`/`Date.now()` chạy trong app runtime/test thường — KHÔNG phải trong Workflow script — nên dùng bình thường.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ad-display/ad-video-store.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ad-display/ad-video-store.ts tests/ad-display/ad-video-store.spec.ts
git commit -m "feat(tv-ads): ad-videos file store (copy/remove/resolve)"
```

---

## Task 5: AdDisplayServer (HTTP LAN + SSE)

**Files:**
- Create: `src/main/ad-display/ad-net.ts`
- Create: `src/main/ad-display/ad-display-server.ts`
- Test: `tests/ad-display/ad-display-server.spec.ts`

- [ ] **Step 1: Implement LAN IP helper (no separate test — covered by server test)**

```ts
// src/main/ad-display/ad-net.ts
import { networkInterfaces } from 'os';

export function getLanIpv4List(): string[] {
  const ips: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const e of entries || []) {
      if (e.family === 'IPv4' && !e.internal) ips.push(e.address);
    }
  }
  return ips;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/ad-display/ad-display-server.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AdDisplayServer } from '../../src/main/ad-display/ad-display-server';
import { AD_DISPLAY_DEFAULTS } from '../../src/main/ad-display/ad-types';
import { AdVideoStore } from '../../src/main/ad-display/ad-video-store';

let dir: string;
let store: AdVideoStore;
let server: AdDisplayServer;
let cfg: any;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'adsrv-'));
  store = new AdVideoStore(dir);
  writeFileSync(join(dir, 'ad_1.mp4'), Buffer.from('0123456789')); // 10 bytes
  cfg = {
    ...AD_DISPLAY_DEFAULTS,
    tvAdEnabled: true,
    tvAdPort: 0, // ephemeral
    tvAdPlaylist: [{ id: 'ad_1', filename: 'ad_1.mp4', order: 0, enabled: true }],
  };
  server = new AdDisplayServer(() => cfg, store);
  await server.applyConfig();
});
afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

function urlFor(path: string) {
  const port = server.getStatus().port;
  return `http://127.0.0.1:${port}${path}`;
}

describe('AdDisplayServer', () => {
  it('GET /health → 200 ok', async () => {
    const r = await fetch(urlFor('/health'));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  it('GET /playlist.json → enabled videos + version', async () => {
    const r = await fetch(urlFor('/playlist.json'));
    const body = await r.json();
    expect(body.videos.map((v: any) => v.id)).toEqual(['ad_1']);
    expect(typeof body.version).toBe('string');
  });

  it('GET /video/ad_1 with Range → 206 + Content-Range', async () => {
    const r = await fetch(urlFor('/video/ad_1'), { headers: { Range: 'bytes=2-5' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await r.text()).toBe('2345');
  });

  it('GET /video/ad_1 no Range → 200 full body', async () => {
    const r = await fetch(urlFor('/video/ad_1'));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('0123456789');
  });

  it('GET /video/unknown → 404', async () => {
    const r = await fetch(urlFor('/video/nope'));
    expect(r.status).toBe(404);
  });

  it('version changes after config change', async () => {
    const v1 = (await (await fetch(urlFor('/playlist.json'))).json()).version;
    cfg.tvAdMuted = false;
    const v2 = (await (await fetch(urlFor('/playlist.json'))).json()).version;
    expect(v2).not.toBe(v1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/ad-display/ad-display-server.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement server**

```ts
// src/main/ad-display/ad-display-server.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createReadStream, statSync } from 'fs';
import type { AddressInfo } from 'net';
import logger from '../logger';
import { buildAdPlaylistPayload } from './ad-playlist';
import { parseRangeHeader } from './http-range';
import { getLanIpv4List } from './ad-net';
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
    return {
      running: !!this.server,
      port: this.activePort,
      ips: getLanIpv4List(),
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
    const size = statSync(full).size;
    const range = parseRangeHeader(req.headers.range, size);

    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'content-range': `bytes */${size}`, ...cors });
      res.end();
      return;
    }
    if (range) {
      const { start, end } = range;
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        ...cors,
      });
      createReadStream(full, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'content-length': String(size),
      ...cors,
    });
    createReadStream(full).pipe(res);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/ad-display/ad-display-server.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/ad-display/ad-net.ts src/main/ad-display/ad-display-server.ts tests/ad-display/ad-display-server.spec.ts
git commit -m "feat(tv-ads): LAN HTTP server (playlist, ranged video, SSE)"
```

> **API CONTRACT (khoá cho Plan 2 / Android):** mDNS `_zira-ads._tcp`; `GET /health`,
> `GET /playlist.json` (shape `AdPlaylistPayload`), `GET /video/:id` (Range), `GET /events` (SSE `playlist-changed`).

---

## Task 6: mDNS advertiser

**Files:**
- Modify: `package.json` (thêm dep `bonjour-service`)
- Create: `src/main/ad-display/ad-mdns.ts`
- Test: `tests/ad-display/ad-mdns.spec.ts`

- [ ] **Step 1: Add dependency**

Run: `npm install bonjour-service`
Expected: thêm vào `dependencies`. (Pure JS, không native build → an toàn cho POS1 Windows.)

- [ ] **Step 2: Write the failing test (construct + lifecycle, không publish thật)**

```ts
// tests/ad-display/ad-mdns.spec.ts
import { describe, it, expect } from 'vitest';
import { AdMdnsAdvertiser } from '../../src/main/ad-display/ad-mdns';

describe('AdMdnsAdvertiser', () => {
  it('start then stop without throwing, reports running state', () => {
    const adv = new AdMdnsAdvertiser();
    adv.start(17893, 'Test POS');
    expect(adv.isRunning()).toBe(true);
    adv.stop();
    expect(adv.isRunning()).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/ad-display/ad-mdns.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// src/main/ad-display/ad-mdns.ts
import { Bonjour, type Service } from 'bonjour-service';
import logger from '../logger';

export class AdMdnsAdvertiser {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;

  start(port: number, name: string): void {
    this.stop();
    try {
      this.bonjour = new Bonjour();
      this.service = this.bonjour.publish({
        name: `Zira Ads – ${name}`.slice(0, 60),
        type: 'zira-ads',
        protocol: 'tcp',
        port,
        txt: { name },
      });
      logger.info(`[AdDisplay] mDNS advertising _zira-ads._tcp on ${port}`);
    } catch (e: any) {
      logger.error('[AdDisplay] mDNS publish failed:', e?.message || e);
      this.stop();
    }
  }

  isRunning(): boolean {
    return !!this.service;
  }

  stop(): void {
    try { this.service?.stop?.(); } catch { /* ignore */ }
    try { this.bonjour?.destroy(); } catch { /* ignore */ }
    this.service = null;
    this.bonjour = null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/ad-display/ad-mdns.spec.ts`
Expected: PASS. (Nếu môi trường CI chặn multicast, test vẫn pass vì publish bọc try/catch và `isRunning` phản ánh việc tạo service.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main/ad-display/ad-mdns.ts tests/ad-display/ad-mdns.spec.ts
git commit -m "feat(tv-ads): mDNS advertiser for _zira-ads._tcp"
```

---

## Task 7: IPC channels + preload + typings

**Files:**
- Modify: `src/shared/types.ts` (`IPC_CHANNELS`)
- Modify: `src/preload/preload-pos.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/shared/electron.d.ts`

- [ ] **Step 1: Add IPC channel constants**

In `src/shared/types.ts`, inside the `IPC_CHANNELS` object add:

```ts
  TV_AD_GET_STATUS: 'tvAd:getStatus',
  TV_AD_PICK_VIDEO: 'tvAd:pickVideo',
  TV_AD_SAVE: 'tvAd:save',
```

- [ ] **Step 2: Expose in preload (both preload files that POS uses)**

In `src/preload/preload-pos.ts` and `src/preload/preload.ts`, inside the exposed `electronAPI` object add (use `IPC_CHANNELS` import already present, else string literals matching above):

```ts
  tvAdGetStatus: () => ipcRenderer.invoke('tvAd:getStatus'),
  tvAdPickVideo: () => ipcRenderer.invoke('tvAd:pickVideo'),
  tvAdSave: (cfg: Partial<import('../shared/types').AgentConfig>) => ipcRenderer.invoke('tvAd:save', cfg),
```

- [ ] **Step 3: Add typings**

In `src/shared/electron.d.ts`, inside the `electronAPI` interface add:

```ts
  tvAdGetStatus: () => Promise<import('./types').AdDisplayStatusLike>;
  tvAdPickVideo: () => Promise<{ id: string; filename: string } | null>;
  tvAdSave: (cfg: Partial<AgentConfig>) => Promise<{ ok: boolean }>;
```

And add near other shared types in `src/shared/types.ts`:

```ts
export interface AdDisplayStatusLike {
  running: boolean;
  port: number | null;
  ips: string[];
  connectedClients: number;
  error?: string;
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p tsconfig.main.json --noEmit && npm run typecheck:renderer`
Expected: No new errors from these files.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/preload/preload-pos.ts src/preload/preload.ts src/shared/electron.d.ts
git commit -m "feat(tv-ads): IPC channels + preload bridge + typings"
```

---

## Task 8: AdDisplayModule (wire server + mDNS + IPC) and register

**Files:**
- Create: `src/main/modules/ad-display.module.ts`
- Modify: `src/main/index.ts` (register)

- [ ] **Step 1: Implement module**

```ts
// src/main/modules/ad-display.module.ts
import { ipcMain, dialog, app } from 'electron';
import { join } from 'path';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import { getConfig, setConfig } from '../config/store';
import { IPC_CHANNELS, type AgentConfig } from '../../shared/types';
import { AdVideoStore } from '../ad-display/ad-video-store';
import { AdDisplayServer } from '../ad-display/ad-display-server';
import { AdMdnsAdvertiser } from '../ad-display/ad-mdns';
import { AD_DISPLAY_DEFAULTS, type TvAdConfig } from '../ad-display/ad-types';
import logger from '../logger';

export class AdDisplayModule extends BaseModule {
  readonly name = 'ad-display';
  private store: AdVideoStore;
  private server: AdDisplayServer;
  private mdns = new AdMdnsAdvertiser();

  constructor(private readonly container: ServiceContainer) {
    super();
    this.store = new AdVideoStore(join(app.getPath('userData'), 'ad-videos'));
    this.server = new AdDisplayServer(() => this.tvConfig(), this.store);
  }

  private tvConfig(): TvAdConfig {
    const c = getConfig() as Partial<TvAdConfig>;
    return { ...AD_DISPLAY_DEFAULTS, ...c } as TvAdConfig;
  }

  async start(): Promise<void> {
    await this.applyAll();
    this.setState(ModuleState.RUNNING);
  }

  async stop(): Promise<void> {
    await this.server.stop();
    this.mdns.stop();
    this.setState(ModuleState.STOPPED);
  }

  private async applyAll(): Promise<void> {
    const cfg = this.tvConfig();
    await this.server.applyConfig();
    const status = this.server.getStatus();
    if (cfg.tvAdEnabled && status.running && status.port) {
      const name = (getConfig() as any).salonName || (getConfig() as any).deviceName || 'POS';
      this.mdns.start(status.port, String(name));
    } else {
      this.mdns.stop();
    }
  }

  registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.TV_AD_GET_STATUS, () => this.server.getStatus());

    ipcMain.handle(IPC_CHANNELS.TV_AD_PICK_VIDEO, async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Video', extensions: ['mp4', 'm4v', 'mov'] }],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      try {
        return this.store.addVideo(result.filePaths[0]);
      } catch (e: any) {
        logger.error('[AdDisplay] addVideo failed:', e?.message || e);
        throw e;
      }
    });

    ipcMain.handle(IPC_CHANNELS.TV_AD_SAVE, async (_e, partial: Partial<AgentConfig>) => {
      // remove file của các video bị xoá khỏi playlist
      const before = this.tvConfig().tvAdPlaylist || [];
      setConfig(partial);
      const after = this.tvConfig().tvAdPlaylist || [];
      const afterIds = new Set(after.map(v => v.id));
      for (const v of before) {
        if (!afterIds.has(v.id)) this.store.removeVideo(v.filename);
      }
      const portChanged = partial.tvAdPort !== undefined;
      const enableChanged = partial.tvAdEnabled !== undefined;
      if (portChanged || enableChanged) {
        await this.server.stop();
        this.mdns.stop();
      }
      await this.applyAll();
      this.server.broadcastChanged();
      return { ok: true };
    });
  }
}
```

- [ ] **Step 2: Register in index.ts**

In `src/main/index.ts`, add import near other module imports:

```ts
import { AdDisplayModule } from './modules/ad-display.module';
```

and add to the `.use(...)` chain (after `CheckinModule`):

```ts
      .use(new AdDisplayModule(container));
```

(Move the trailing `;` so the new `.use(...)` is last.)

- [ ] **Step 3: Typecheck + run full ad-display test suite**

Run: `npx tsc -p tsconfig.main.json --noEmit && npx vitest run tests/ad-display/`
Expected: typecheck clean; all ad-display tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/modules/ad-display.module.ts src/main/index.ts
git commit -m "feat(tv-ads): AdDisplayModule wiring server+mDNS+IPC, registered in bootstrap"
```

---

## Task 9: Settings UI — "TV Quảng cáo"

**Files:**
- Modify: `src/renderer/components/Settings.tsx`
- Modify: `src/renderer/i18n/translations.ts`

- [ ] **Step 1: Add i18n keys**

In `src/renderer/i18n/translations.ts`, add to each locale block (pl/en/vi at minimum) under a new `tvAd` group, mirroring existing key style. Vietnamese example:

```ts
    tvAd: {
      title: 'TV Quảng cáo',
      enable: 'Bật màn hình quảng cáo TV',
      addVideo: 'Thêm video',
      playbackMode: 'Chế độ phát',
      sequential: 'Phát lần lượt (playlist)',
      repeatOne: 'Lặp 1 video',
      muted: 'Tắt tiếng',
      volume: 'Âm lượng',
      status: 'Trạng thái server',
      running: 'Đang chạy',
      stopped: 'Đã dừng',
      connectedTvs: 'TV đang kết nối',
      remove: 'Xoá',
      enabledCol: 'Bật',
    },
```

(Repeat with translated strings for pl/en; reuse English text for other locales as fallback — matches existing partial-locale pattern in this file.)

- [ ] **Step 2: Add state + load near existing promo state (around Settings.tsx:605)**

```tsx
  const [tvAdEnabled, setTvAdEnabled] = useState<boolean>((config as any)?.tvAdEnabled ?? false);
  const [tvAdPlaylist, setTvAdPlaylist] = useState<any[]>((config as any)?.tvAdPlaylist ?? []);
  const [tvAdMode, setTvAdMode] = useState<'sequential' | 'repeat-one'>((config as any)?.tvAdPlaybackMode ?? 'sequential');
  const [tvAdRepeatId, setTvAdRepeatId] = useState<string | null>((config as any)?.tvAdRepeatVideoId ?? null);
  const [tvAdMuted, setTvAdMuted] = useState<boolean>((config as any)?.tvAdMuted ?? true);
  const [tvAdVolume, setTvAdVolume] = useState<number>((config as any)?.tvAdVolume ?? 0);
  const [tvAdStatus, setTvAdStatus] = useState<{ running: boolean; port: number | null; ips: string[]; connectedClients: number } | null>(null);
```

Re-sync on config change (near the existing `useEffect` at ~Settings.tsx:1055):

```tsx
    setTvAdEnabled((config as any).tvAdEnabled ?? false);
    setTvAdPlaylist((config as any).tvAdPlaylist ?? []);
    setTvAdMode((config as any).tvAdPlaybackMode ?? 'sequential');
    setTvAdRepeatId((config as any).tvAdRepeatVideoId ?? null);
    setTvAdMuted((config as any).tvAdMuted ?? true);
    setTvAdVolume((config as any).tvAdVolume ?? 0);
```

Poll status while the section is open:

```tsx
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await window.electronAPI.tvAdGetStatus().catch(() => null);
      if (alive) setTvAdStatus(s as any);
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);
```

- [ ] **Step 2b: Save handler**

```tsx
  const persistTvAd = async (overrides: Record<string, any> = {}) => {
    const payload = {
      tvAdEnabled, tvAdPlaybackMode: tvAdMode, tvAdRepeatVideoId: tvAdRepeatId,
      tvAdMuted, tvAdVolume, tvAdPlaylist, ...overrides,
    };
    await window.electronAPI.tvAdSave(payload as any);
  };

  const handleAddTvAdVideo = async () => {
    const rec = await window.electronAPI.tvAdPickVideo().catch(() => null);
    if (!rec) return;
    const next = [...tvAdPlaylist, { ...rec, order: tvAdPlaylist.length, enabled: true }];
    setTvAdPlaylist(next);
    await persistTvAd({ tvAdPlaylist: next });
  };

  const handleRemoveTvAdVideo = async (id: string) => {
    const next = tvAdPlaylist.filter(v => v.id !== id).map((v, i) => ({ ...v, order: i }));
    setTvAdPlaylist(next);
    await persistTvAd({ tvAdPlaylist: next });
  };

  const handleToggleTvAdVideo = async (id: string) => {
    const next = tvAdPlaylist.map(v => v.id === id ? { ...v, enabled: !v.enabled } : v);
    setTvAdPlaylist(next);
    await persistTvAd({ tvAdPlaylist: next });
  };
```

- [ ] **Step 3: Render section** (place near the promo folder block ~Settings.tsx:4524, follow the surrounding card/markup style)

```tsx
  {/* TV Quảng cáo */}
  <div className="settings-section">
    <h3>{t('settings.tvAd.title')}</h3>

    <label className="flex items-center gap-2">
      <input type="checkbox" checked={tvAdEnabled}
        onChange={async (e) => { setTvAdEnabled(e.target.checked); await persistTvAd({ tvAdEnabled: e.target.checked }); }} />
      {t('settings.tvAd.enable')}
    </label>

    <button type="button" onClick={handleAddTvAdVideo}>{t('settings.tvAd.addVideo')}</button>

    <ul>
      {tvAdPlaylist.sort((a, b) => a.order - b.order).map(v => (
        <li key={v.id} className="flex items-center gap-2">
          <input type="checkbox" checked={v.enabled} onChange={() => handleToggleTvAdVideo(v.id)} />
          <span>{v.filename}</span>
          {tvAdMode === 'repeat-one' && (
            <input type="radio" name="tvAdRepeat" checked={tvAdRepeatId === v.id}
              onChange={async () => { setTvAdRepeatId(v.id); await persistTvAd({ tvAdRepeatVideoId: v.id }); }} />
          )}
          <button type="button" onClick={() => handleRemoveTvAdVideo(v.id)}>{t('settings.tvAd.remove')}</button>
        </li>
      ))}
    </ul>

    <div>
      <label>{t('settings.tvAd.playbackMode')}</label>
      <select value={tvAdMode}
        onChange={async (e) => { const m = e.target.value as any; setTvAdMode(m); await persistTvAd({ tvAdPlaybackMode: m }); }}>
        <option value="sequential">{t('settings.tvAd.sequential')}</option>
        <option value="repeat-one">{t('settings.tvAd.repeatOne')}</option>
      </select>
    </div>

    <label className="flex items-center gap-2">
      <input type="checkbox" checked={tvAdMuted}
        onChange={async (e) => { setTvAdMuted(e.target.checked); await persistTvAd({ tvAdMuted: e.target.checked }); }} />
      {t('settings.tvAd.muted')}
    </label>
    {!tvAdMuted && (
      <input type="range" min={0} max={100} value={tvAdVolume}
        onChange={(e) => setTvAdVolume(parseInt(e.target.value))}
        onMouseUp={() => persistTvAd({ tvAdVolume })} />
    )}

    <div className="text-sm opacity-80">
      {t('settings.tvAd.status')}: {tvAdStatus?.running ? t('settings.tvAd.running') : t('settings.tvAd.stopped')}
      {tvAdStatus?.running && tvAdStatus.ips[0] && <> — {tvAdStatus.ips[0]}:{tvAdStatus.port}</>}
      {tvAdStatus?.running && <> — {t('settings.tvAd.connectedTvs')}: {tvAdStatus.connectedClients}</>}
    </div>
  </div>
```

- [ ] **Step 4: Typecheck renderer**

Run: `npm run typecheck:renderer`
Expected: No new errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Settings.tsx src/renderer/i18n/translations.ts
git commit -m "feat(tv-ads): Settings section to manage TV ad playlist + mode"
```

---

## Task 10: Manual end-to-end verification (POS only)

**Files:** none (manual)

- [ ] **Step 1: Build + run app on a dev box** (Alienware per workflow), open Settings → "TV Quảng cáo", bật tính năng, thêm 1 video mp4.

- [ ] **Step 2: From another machine on the same LAN, verify endpoints**

Run (thay `<POS_IP>` bằng IP hiển thị trong Settings):

```bash
curl -s http://<POS_IP>:17893/health
curl -s http://<POS_IP>:17893/playlist.json
curl -s -D- -o /dev/null -H 'Range: bytes=0-1023' http://<POS_IP>:17893/video/<id>
```

Expected: `/health` → `{"ok":true,...}`; `/playlist.json` → có video vừa thêm + `version`; video request → `HTTP/1.1 206` + `Content-Range`.

- [ ] **Step 3: Verify mDNS advertised**

Run (Linux): `avahi-browse -rt _zira-ads._tcp`  (macOS: `dns-sd -B _zira-ads._tcp`)
Expected: thấy service `Zira Ads – <name>` với IP\:port của POS.

- [ ] **Step 4: Verify SSE push** — mở `curl -N http://<POS_IP>:17893/events` ở một terminal, đổi chế độ phát trong Settings → terminal nhận `event: playlist-changed`.

- [ ] **Step 5: Run full suite once more**

Run: `npx vitest run tests/ad-display/ && npx tsc -p tsconfig.main.json --noEmit`
Expected: all PASS, typecheck clean.

---

## Self-Review notes (đã rà)

- **Spec coverage:** server LAN (T5), playlist/2 chế độ (T2,T9), mDNS (T6), SSE update tức thì (T5,T8), upload/quản lý video trong Settings (T4,T9), điều khiển toàn bộ từ POS (T8,T9), config muted/volume/port (T1). App Android = Plan 2 (ngoài phạm vi, có chủ đích).
- **Placeholder scan:** không có TODO/“handle edge cases” trống — mọi step có code/lệnh cụ thể.
- **Type consistency:** `TvAdConfig`/`AdPlaylistPayload`/`AdDisplayStatus` dùng nhất quán qua T1→T8; tên hàm `buildAdPlaylistPayload`/`computeAdVersion`/`parseRangeHeader`/`AdVideoStore.resolvePath`/`broadcastChanged` khớp giữa các task.
- **Lưu ý khi execute:** xác minh đúng vị trí object `IPC_CHANNELS`, default-config literal trong `store.ts`, và 2 file preload (POS dùng preload nào) trước khi chèn — pattern đã dẫn chứng ở phần khảo sát.
