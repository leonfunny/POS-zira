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
