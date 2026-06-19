import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audios: FakeAudio[] = [];
class FakeAudio {
  src = ''; preload = ''; muted = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  playbackRate = 1; preservesPitch = true;
  static autoEndAfterPlay = true;
  static autoErrorAfterPlay = false;
  constructor(src = '') { this.src = src; audios.push(this); }
  play(): Promise<void> {
    if (FakeAudio.autoErrorAfterPlay) { queueMicrotask(() => this.onerror?.()); return Promise.resolve(); }
    if (FakeAudio.autoEndAfterPlay) queueMicrotask(() => this.onended?.());
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  load() {}
}

beforeEach(() => {
  audios.length = 0;
  FakeAudio.autoEndAfterPlay = true;
  FakeAudio.autoErrorAfterPlay = false;
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('document', { baseURI: 'http://test.local/windows/self-checkout/' });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('buildNumberSequence', () => {
  it('maps 1..999 to a single clip', async () => {
    const { buildNumberSequence } = await import('../src/renderer/lib/pl-tts-engine');
    expect(buildNumberSequence(1)).toEqual(['1.mp3']);
    expect(buildNumberSequence(42)).toEqual(['42.mp3']);
    expect(buildNumberSequence(999)).toEqual(['999.mp3']);
  });
});

describe('clipUrl', () => {
  it('resolves relative to the page, into tts-pl/', async () => {
    const { clipUrl } = await import('../src/renderer/lib/pl-tts-engine');
    expect(clipUrl('1.mp3')).toBe('http://test.local/tts-pl/1.mp3');
  });
});

describe('ClipPlayer tri-state', () => {
  it('returns "played" when every clip ends', async () => {
    const { ClipPlayer } = await import('../src/renderer/lib/pl-tts-engine');
    const p = new ClipPlayer();
    expect(await p.play(['1.mp3', '2.mp3'])).toBe('played');
  });

  it('returns "failed" when a clip errors', async () => {
    FakeAudio.autoErrorAfterPlay = true;
    const { ClipPlayer } = await import('../src/renderer/lib/pl-tts-engine');
    const p = new ClipPlayer();
    expect(await p.play(['1.mp3'])).toBe('failed');
  });

  it('returns "cancelled" when cancel() interrupts mid-sequence', async () => {
    FakeAudio.autoEndAfterPlay = false; // hold the clip open
    const { ClipPlayer } = await import('../src/renderer/lib/pl-tts-engine');
    const p = new ClipPlayer();
    const promise = p.play(['1.mp3', '2.mp3']);
    await Promise.resolve();
    p.cancel();
    audios[0]?.onerror?.(); // src cleared → error resolves the in-flight clip
    expect(await promise).toBe('cancelled');
  });
});

describe('cancel does not look like failure', () => {
  it('a second play() cancels the first and reports "cancelled" to it', async () => {
    FakeAudio.autoEndAfterPlay = false;
    const { ClipPlayer } = await import('../src/renderer/lib/pl-tts-engine');
    const p = new ClipPlayer();
    const first = p.play(['1.mp3', '2.mp3']);
    await Promise.resolve();
    const firstAudio = audios[0];
    const second = p.play(['5.mp3']); // cancels first
    firstAudio?.onerror?.();
    const [r1] = await Promise.all([first, second]);
    expect(r1).toBe('cancelled');
  });
});
