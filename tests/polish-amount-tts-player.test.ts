// Player tests for the self-checkout amount announcer.
//
// We mock the browser Audio + speechSynthesis APIs so the player path
// can be exercised end-to-end in Node:
//   - playAnnouncement plays the full clip sequence when audio succeeds
//   - playAnnouncement falls back to Web Speech when a clip errors (e.g.
//     tts-pl/ folder empty in dev)
//   - cancelAnnouncement aborts the in-flight clip AND speechSynthesis
//   - a second playAnnouncement cancels the first mid-sequence

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Fake Audio implementation ─────────────────────────────────────────────
// Tracks every Audio created so tests can drive onended/onerror manually.
const audios: FakeAudio[] = [];

class FakeAudio {
  src = '';
  preload = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  // playResult lets a test pre-arrange "play() will reject" before construction.
  static nextPlayResult: 'resolve' | 'reject' = 'resolve';
  // autoEndAfterPlay: when true, audio.play() resolves and then immediately
  // fires onended (simulating an instant clip). Default true so a full
  // sequence plays through naturally inside the test.
  static autoEndAfterPlay = true;
  // autoErrorAfterPlay: when true, audio.play() resolves but onerror fires
  // (simulates the 404 path when clips aren't generated yet).
  static autoErrorAfterPlay = false;

  constructor(src: string) {
    this.src = src;
    audios.push(this);
  }

  play(): Promise<void> {
    if (FakeAudio.nextPlayResult === 'reject') {
      FakeAudio.nextPlayResult = 'resolve';
      return Promise.reject(new Error('blocked'));
    }
    if (FakeAudio.autoErrorAfterPlay) {
      queueMicrotask(() => this.onerror?.());
      return Promise.resolve();
    }
    if (FakeAudio.autoEndAfterPlay) {
      queueMicrotask(() => this.onended?.());
    }
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {
    /* noop in tests */
  }
}

// ─── Fake speechSynthesis ──────────────────────────────────────────────────
interface FakeVoice { lang: string; name: string }
const speech = {
  spoke: [] as Array<{ text: string; voice: FakeVoice | null; lang: string }>,
  cancels: 0,
  voices: [{ lang: 'pl-PL', name: 'Test Polish' }] as FakeVoice[],
  listeners: new Map<string, Set<() => void>>(),
  cancel: () => {
    speech.cancels += 1;
  },
  speak: (utter: { text: string; voice: FakeVoice | null; lang: string }) => {
    speech.spoke.push({ text: utter.text, voice: utter.voice, lang: utter.lang });
  },
  getVoices: () => speech.voices,
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
  constructor(text: string) {
    this.text = text;
  }
}

beforeEach(() => {
  audios.length = 0;
  speech.spoke = [];
  speech.cancels = 0;
  speech.voices = [{ lang: 'pl-PL', name: 'Test Polish' }];
  speech.listeners = new Map();
  FakeAudio.nextPlayResult = 'resolve';
  FakeAudio.autoEndAfterPlay = true;
  FakeAudio.autoErrorAfterPlay = false;
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  vi.stubGlobal('speechSynthesis', speech);
  vi.stubGlobal('document', { baseURI: 'http://test.local/windows/self-checkout/' });
  vi.stubGlobal('window', { speechSynthesis: speech });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('playAnnouncement — happy path (clips present)', () => {
  it('plays every clip in sequence when no audio errors', async () => {
    const { playAnnouncement, buildAnnouncementSequence } = await import(
      '../src/renderer/windows/self-checkout/polish-amount-tts'
    );
    await playAnnouncement('CARD', 12_34);

    const expected = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 1234 });
    // Every clip in the expected sequence got its own Audio instance.
    expect(audios.length).toBeGreaterThanOrEqual(expected.length);
    // Speech fallback was NOT used since playback succeeded.
    expect(speech.spoke.length).toBe(0);
  });
});

describe('playAnnouncement — clip missing (404)', () => {
  it('falls back to Web Speech when the first clip errors', async () => {
    FakeAudio.autoErrorAfterPlay = true;
    const { playAnnouncement } = await import(
      '../src/renderer/windows/self-checkout/polish-amount-tts'
    );
    await playAnnouncement('CARD', 100);

    expect(speech.spoke.length).toBe(1);
    expect(speech.spoke[0].text).toContain('Płatność kartą');
    expect(speech.spoke[0].text).toContain('1 złoty');
    expect(speech.spoke[0].lang).toBe('pl-PL');
    // Polish voice was resolved and attached to the utterance.
    expect(speech.spoke[0].voice?.lang).toBe('pl-PL');
  });

  it('falls back to Web Speech when audio.play() is blocked', async () => {
    FakeAudio.nextPlayResult = 'reject';
    const { playAnnouncement } = await import(
      '../src/renderer/windows/self-checkout/polish-amount-tts'
    );
    await playAnnouncement('CASH', 250);

    expect(speech.spoke.length).toBe(1);
    expect(speech.spoke[0].text).toContain('Płatność gotówką');
    expect(speech.spoke[0].text).toContain('2 złote');
    expect(speech.spoke[0].text).toContain('50 groszy');
  });
});

describe('Web Speech fallback — voice resolution', () => {
  it('waits for voiceschanged when voices are not loaded yet', async () => {
    FakeAudio.autoErrorAfterPlay = true;
    speech.voices = []; // Chromium first-call behavior

    const { playAnnouncement } = await import(
      '../src/renderer/windows/self-checkout/polish-amount-tts'
    );
    const announce = playAnnouncement('CARD', 100);

    // Voices arrive shortly after — simulate the browser populating them.
    await Promise.resolve();
    speech.voices = [{ lang: 'pl-PL', name: 'Microsoft Paulina' }];
    speech.fireVoicesChanged();

    await announce;
    expect(speech.spoke[0].voice?.lang).toBe('pl-PL');
    expect(speech.spoke[0].voice?.name).toBe('Microsoft Paulina');
  });

  it('falls through with utter.lang=pl-PL when no Polish voice is installed', async () => {
    FakeAudio.autoErrorAfterPlay = true;
    speech.voices = [{ lang: 'en-US', name: 'Microsoft Aria' }];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { playAnnouncement } = await import(
      '../src/renderer/windows/self-checkout/polish-amount-tts'
    );
    // No voiceschanged ever fires — wait for the 500ms timeout to settle.
    vi.useFakeTimers();
    const announce = playAnnouncement('CARD', 100);
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();
    await announce;

    expect(speech.spoke.length).toBe(1);
    expect(speech.spoke[0].voice).toBeNull();
    // Lang stays pl-PL so the synth at least flags the text as Polish.
    expect(speech.spoke[0].lang).toBe('pl-PL');
    // Operator-facing warning fired so the missing voice is diagnosable.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No Polish'),
    );
    warnSpy.mockRestore();
  });

  it('caches the resolved Polish voice across announcements', async () => {
    FakeAudio.autoErrorAfterPlay = true;
    const getVoicesSpy = vi.spyOn(speech, 'getVoices');

    const { playAnnouncement } = await import(
      '../src/renderer/windows/self-checkout/polish-amount-tts'
    );
    await playAnnouncement('CARD', 100);
    await playAnnouncement('CASH', 250);

    // Second announcement reuses the cached voice; no extra getVoices call.
    expect(getVoicesSpy).toHaveBeenCalledTimes(1);
    expect(speech.spoke[0].voice?.lang).toBe('pl-PL');
    expect(speech.spoke[1].voice?.lang).toBe('pl-PL');
    getVoicesSpy.mockRestore();
  });
});

describe('cancelAnnouncement', () => {
  it('pauses the in-flight clip and cancels speechSynthesis', async () => {
    // Hold the first clip open so cancel can intercept mid-play.
    FakeAudio.autoEndAfterPlay = false;
    const { playAnnouncement, cancelAnnouncement } = await import(
      '../src/renderer/windows/self-checkout/polish-amount-tts'
    );
    const promise = playAnnouncement('CARD', 100);
    await Promise.resolve();
    await Promise.resolve();

    cancelAnnouncement();
    // Cancel pauses + clears src; the empty src triggers onerror, which
    // resolves the in-flight playOne promise without waiting for the
    // 4s CLIP_TIMEOUT_MS guard.
    audios[0]?.onerror?.();

    expect(audios[0]?.paused).toBe(true);
    expect(speech.cancels).toBeGreaterThanOrEqual(1);
    await promise;
  });

  it('a second playAnnouncement cancels the first', async () => {
    FakeAudio.autoEndAfterPlay = false;
    const { playAnnouncement } = await import(
      '../src/renderer/windows/self-checkout/polish-amount-tts'
    );
    const first = playAnnouncement('CARD', 100);
    await Promise.resolve();
    await Promise.resolve();
    const firstAudio = audios[0];
    const firstAudioCount = audios.length;

    const second = playAnnouncement('CASH', 200);
    // Release the first clip the same way real cancel would (src='' → error).
    firstAudio?.onerror?.();
    await Promise.resolve();
    await Promise.resolve();
    // Release the second clip too so the second sequence's playOne resolves.
    for (let i = firstAudioCount; i < audios.length; i++) {
      audios[i]?.onerror?.();
    }

    expect(firstAudio?.paused).toBe(true);
    expect(audios.length).toBeGreaterThan(firstAudioCount);

    await Promise.all([first, second]);
  });
});
