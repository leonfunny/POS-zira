import { vi } from 'vitest';

// logger imports electron; mock it out so tests run without Electron runtime
vi.mock('../../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

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
  writeFileSync(join(dir, 'ad_2.png'), Buffer.from('PNGDATA'));
  cfg = {
    ...AD_DISPLAY_DEFAULTS,
    tvAdEnabled: true,
    tvAdPort: 0, // ephemeral
    tvAdPlaylist: [
      { id: 'ad_1', filename: 'ad_1.mp4', order: 0, enabled: true },
      { id: 'ad_2', filename: 'ad_2.png', order: 1, enabled: true, type: 'image', durationMs: 7000 },
    ],
  };
  server = new AdDisplayServer(() => cfg, store);
  await server.applyConfig();
});
afterEach(async () => {
  await server.stop();
  delete process.env.ZIRA_TV_ADS_APK_PATH;
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
    expect(body.media.map((v: any) => v.id)).toEqual(['ad_1', 'ad_2']);
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

  it('GET /media/ad_2 image → 200 image content type', async () => {
    const r = await fetch(urlFor('/media/ad_2'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(await r.text()).toBe('PNGDATA');
  });

  it('GET /tv-app/update.json and APK download expose updater payload', async () => {
    const apk = join(dir, 'app-release.apk');
    writeFileSync(apk, 'APKDATA');
    process.env.ZIRA_TV_ADS_APK_PATH = apk;

    const meta = await (await fetch(urlFor('/tv-app/update.json'))).json();
    expect(meta.latestVersionCode).toBeGreaterThan(0);
    expect(meta.apkUrl).toBe('/tv-app/app-release.apk');
    expect(meta.apkSize).toBe(7);
    expect(meta.apkSha256).toMatch(/^[a-f0-9]{64}$/);

    const apkResp = await fetch(urlFor('/tv-app/app-release.apk'));
    expect(apkResp.status).toBe(200);
    expect(apkResp.headers.get('content-type')).toBe('application/vnd.android.package-archive');
    expect(await apkResp.text()).toBe('APKDATA');
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
