// Shared Polish text-to-speech engine for kiosk windows.
// Plays a sequence of pre-rendered MP3 clips from dist/renderer/tts-pl/, with a
// Web Speech API fallback when clips are missing or fail. clipUrl resolves
// relative to document.baseURI (the HTML page), so both the self-checkout and
// kitchen-self-order windows (each at windows/<name>/index.html) resolve to
// dist/renderer/tts-pl/.

const CLIP_DIR = 'tts-pl';
const CLIP_TIMEOUT_MS = 4000;
const CLIP_PLAYBACK_RATE = 1.12;
const VOICE_WAIT_MS = 500;

export type PlayResult = 'played' | 'failed' | 'cancelled';

export function polishUnit<T>(n: number, one: T, few: T, many: T): T {
  const abs = Math.abs(Math.floor(n));
  if (abs === 1) return one;
  const lastTwo = abs % 100;
  if (lastTwo >= 12 && lastTwo <= 14) return many;
  const lastOne = abs % 10;
  if (lastOne >= 2 && lastOne <= 4) return few;
  return many;
}

function numberClip(n: number): string { return `${n}.mp3`; }
function thousandClip(count: number): string {
  if (count === 1) return 'thousand_1.mp3';
  return polishUnit(count, 'thousand_1.mp3', 'thousand_few.mp3', 'thousand_many.mp3');
}

export function buildNumberSequence(n: number): string[] {
  if (n < 0) return [];
  if (n <= 999) return [numberClip(n)];
  const clips: string[] = [];
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  if (thousands === 1) {
    clips.push('thousand_1.mp3');
  } else if (thousands >= 2 && thousands <= 999) {
    clips.push(numberClip(thousands));
    clips.push(thousandClip(thousands));
  } else if (thousands > 999) {
    return buildNumberSequence(thousands).concat(thousandClip(thousands));
  }
  if (rest > 0) clips.push(numberClip(rest));
  return clips;
}

export function clipUrl(filename: string): string {
  return new URL(`../../${CLIP_DIR}/${filename}`, document.baseURI).href;
}

export class ClipPlayer {
  private current: HTMLAudioElement | null = null;
  private generation = 0;

  cancel(): void {
    this.generation += 1;
    if (this.current) {
      this.current.pause();
      this.current.src = '';
      this.current = null;
    }
  }

  async play(filenames: string[]): Promise<PlayResult> {
    this.cancel();
    const myGen = ++this.generation;
    for (const filename of filenames) {
      if (myGen !== this.generation) return 'cancelled';
      const ok = await this.playOne(filename, myGen);
      if (!ok) return myGen !== this.generation ? 'cancelled' : 'failed';
    }
    return myGen !== this.generation ? 'cancelled' : 'played';
  }

  private playOne(filename: string, myGen: number): Promise<boolean> {
    return new Promise((resolve) => {
      const audio = new Audio(clipUrl(filename));
      audio.preload = 'auto';
      audio.playbackRate = CLIP_PLAYBACK_RATE;
      audio.preservesPitch = true;
      this.current = audio;
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        clearTimeout(timeoutId);
        resolve(success);
      };
      const timeoutId = setTimeout(() => finish(false), CLIP_TIMEOUT_MS);
      audio.onended = () => finish(myGen === this.generation);
      audio.onerror = () => finish(false);
      audio.play().catch(() => finish(false));
    });
  }
}

let cachedPolishVoice: SpeechSynthesisVoice | null = null;
let polishVoiceMissingWarned = false;

function pickPolishVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  return voices.find((v) => v.lang.toLowerCase().startsWith('pl')) ?? null;
}

export async function ensurePolishVoice(): Promise<SpeechSynthesisVoice | null> {
  if (cachedPolishVoice) return cachedPolishVoice;
  if (typeof window === 'undefined' || !window.speechSynthesis) return null;
  const synth = window.speechSynthesis;
  const immediate = pickPolishVoice(synth.getVoices());
  if (immediate) { cachedPolishVoice = immediate; return immediate; }
  return new Promise<SpeechSynthesisVoice | null>((resolve) => {
    let settled = false;
    const finish = (voice: SpeechSynthesisVoice | null) => {
      if (settled) return;
      settled = true;
      synth.removeEventListener?.('voiceschanged', onChange);
      clearTimeout(timer);
      if (voice) cachedPolishVoice = voice;
      else if (!polishVoiceMissingWarned) {
        polishVoiceMissingWarned = true;
        // eslint-disable-next-line no-console
        console.warn(
          '[pl-tts] No Polish (pl-*) voice installed. The kiosk will speak Polish '
          + 'text with the default system voice. Install a Polish language pack or '
          + 'render tts-pl/*.mp3 via scripts/generate-google-tts-clips.mjs.',
        );
      }
      resolve(voice);
    };
    const onChange = () => finish(pickPolishVoice(synth.getVoices()));
    synth.addEventListener?.('voiceschanged', onChange);
    const timer = setTimeout(() => finish(pickPolishVoice(synth.getVoices())), VOICE_WAIT_MS);
  });
}

let polishSpeechGeneration = 0;

// Cancel any in-flight or pending Polish speech. Bumps the generation so a
// speakPolishText() call whose voice lookup is still pending will not speak
// after this returns.
export function cancelPolishSpeech(): void {
  polishSpeechGeneration += 1;
  if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
}

export function speakPolishText(text: string, rate = 1.08): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const myGen = polishSpeechGeneration;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'pl-PL';
  utter.rate = rate;
  utter.volume = 1;
  void ensurePolishVoice().then((voice) => {
    if (myGen !== polishSpeechGeneration) return; // cancelled while the voice resolved
    if (voice) utter.voice = voice;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  });
}

export function warmUpClips(filenames: string[]): void {
  if (typeof window === 'undefined') return;
  for (const filename of filenames) {
    const a = new Audio(clipUrl(filename));
    a.preload = 'auto';
    a.load();
  }
  void ensurePolishVoice();
}
