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

// ─── Fake speechSynthesis (for speakPolishText / cancelPolishSpeech tests) ──
interface FakeVoice { lang: string; name: string }
const speech = {
  spoke: [] as SpeechSynthesisUtterance[],
  cancels: 0,
  voices: [] as FakeVoice[],
  listeners: new Map<string, Set<() => void>>(),
  cancel: () => { speech.cancels += 1; },
  speak: (utter: SpeechSynthesisUtterance) => { speech.spoke.push(utter); },
  getVoices: (): FakeVoice[] => speech.voices,
  addEventListener: (event: string, cb: () => void) => {
    if (!speech.listeners.has(event)) speech.listeners.set(event, new Set());
    speech.listeners.get(event)!.add(cb);
  },
  removeEventListener: (event: string, cb: () => void) => {
    speech.listeners.get(event)?.delete(cb);
  },
  fireVoicesChanged: () => {
    speech.listeners.get('voiceschanged')?.forEach((cb) => cb());
  },
};

class FakeUtterance {
  text: string;
  lang = '';
  rate = 1;
  volume = 1;
  voice: unknown = null;
  constructor(text: string) { this.text = text; }
}

beforeEach(() => {
  audios.length = 0;
  speech.spoke = [];
  speech.cancels = 0;
  speech.voices = [];
  speech.listeners = new Map();
  FakeAudio.autoEndAfterPlay = true;
  FakeAudio.autoErrorAfterPlay = false;
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  vi.stubGlobal('speechSynthesis', speech);
  vi.stubGlobal('document', { baseURI: 'http://test.local/windows/self-checkout/' });
  vi.stubGlobal('window', { speechSynthesis: speech });
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
    // Release the second clip so it resolves promptly (no 4s CLIP_TIMEOUT_MS wait).
    audios[audios.length - 1]?.onended?.();
    const [r1] = await Promise.all([first, second]);
    expect(r1).toBe('cancelled');
  });
});

describe('speakPolishText / cancelPolishSpeech generation guard', () => {
  it('speakPolishText does not speak when cancelPolishSpeech fires before the voice resolves', async () => {
    // voices starts empty so ensurePolishVoice waits for voiceschanged
    speech.voices = [];
    const { speakPolishText, cancelPolishSpeech } = await import('../src/renderer/lib/pl-tts-engine');

    speakPolishText('Test');
    // Cancel BEFORE voiceschanged fires — should bump generation and prevent speak
    cancelPolishSpeech();

    // Now populate voices and fire the event (the pending voice lookup resolves here)
    speech.voices = [{ lang: 'pl-PL', name: 'Test Polish' }];
    speech.fireVoicesChanged();

    // Let all microtasks/promises drain
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // speak must NOT have been called
    expect(speech.spoke).toHaveLength(0);
    // cancel() must have been called at least once (by cancelPolishSpeech)
    expect(speech.cancels).toBeGreaterThanOrEqual(1);
  });

  it('speakPolishText DOES speak when no cancel fires before the voice resolves', async () => {
    speech.voices = [];
    const { speakPolishText } = await import('../src/renderer/lib/pl-tts-engine');

    speakPolishText('Test');

    speech.voices = [{ lang: 'pl-PL', name: 'Test Polish' }];
    speech.fireVoicesChanged();

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(speech.spoke).toHaveLength(1);
  });
});
