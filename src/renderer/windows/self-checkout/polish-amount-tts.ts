// Polish currency-amount text-to-speech for the self-checkout kiosk.
//
// Plays a sequence of pre-rendered MP3 clips (one per number 0-999 + 3 thousand
// forms + 6 currency unit forms + 4 framing clips = 1013 clips total). When a
// clip is missing or fails to load, falls back to the browser's Web Speech API
// so dev environments without rendered clips still work.
//
// Clips live in `src/renderer/public/tts-pl/` and ship as `dist/renderer/tts-pl/`.
// Render them with `node scripts/generate-tts-clips.mjs` (needs Azure Speech
// credentials in env: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION).

export type Method = 'CARD' | 'CASH' | 'BLIK';

const CLIP_DIR = 'tts-pl';
const CLIP_TIMEOUT_MS = 4000;

// Polish noun declension: 1 → singular, last digit 2-4 (but not lastTwo 12-14) → few,
// everything else → genitive plural ("many").
function polishUnit<T>(n: number, one: T, few: T, many: T): T {
  const abs = Math.abs(Math.floor(n));
  if (abs === 1) return one;
  const lastTwo = abs % 100;
  if (lastTwo >= 12 && lastTwo <= 14) return many;
  const lastOne = abs % 10;
  if (lastOne >= 2 && lastOne <= 4) return few;
  return many;
}

// Filename for a 0-999 number clip. Generator uses the same convention.
function numberClip(n: number): string {
  return `${n}.mp3`;
}

function thousandClip(count: number): string {
  // Generator stores 3 plural forms; count==1 always uses "tysiąc" alone.
  if (count === 1) return 'thousand_1.mp3';
  return polishUnit(count, 'thousand_1.mp3', 'thousand_few.mp3', 'thousand_many.mp3');
}

function zlotyUnitClip(count: number): string {
  return polishUnit(count, 'zloty_1.mp3', 'zloty_few.mp3', 'zloty_many.mp3');
}

function groszUnitClip(count: number): string {
  return polishUnit(count, 'grosz_1.mp3', 'grosz_few.mp3', 'grosz_many.mp3');
}

// Build the clip sequence for an integer 0..999999 spoken as a Polish number.
function buildNumberSequence(n: number): string[] {
  if (n < 0) return [];
  if (n <= 999) return [numberClip(n)];

  const clips: string[] = [];
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;

  if (thousands === 1) {
    clips.push('thousand_1.mp3'); // "tysiąc" stands alone, no "jeden" prefix.
  } else if (thousands >= 2 && thousands <= 999) {
    clips.push(numberClip(thousands));
    clips.push(thousandClip(thousands));
  } else if (thousands > 999) {
    // Beyond 999_999 we can't represent with this clip set; just emit thousands
    // recursively. Realistically a kiosk transaction won't hit this.
    return buildNumberSequence(thousands).concat(thousandClip(thousands));
  }

  if (rest > 0) clips.push(numberClip(rest));
  return clips;
}

export interface AnnouncementOptions {
  method: Method;
  totalGrosze: number;
}

export function buildAnnouncementSequence({ method, totalGrosze }: AnnouncementOptions): string[] {
  const zl = Math.floor(Math.max(0, totalGrosze) / 100);
  const gr = Math.floor(Math.max(0, totalGrosze)) % 100;

  const clips: string[] = [];
  const prefix =
    method === 'CARD' ? 'prefix_card.mp3'
    : method === 'BLIK' ? 'prefix_blik.mp3'
    : 'prefix_cash.mp3';
  clips.push(prefix);
  clips.push('do_zaplaty.mp3');

  if (zl > 0) {
    clips.push(...buildNumberSequence(zl));
    clips.push(zlotyUnitClip(zl));
  }

  if (gr > 0) {
    clips.push(...buildNumberSequence(gr));
    clips.push(groszUnitClip(gr));
  }

  // Defensive: empty cart shouldn't reach here, but if both are 0 say "zero złotych".
  if (zl === 0 && gr === 0) {
    clips.push(numberClip(0));
    clips.push('zloty_many.mp3');
  }

  return clips;
}

// Resolve a clip filename to an absolute URL relative to the current HTML.
// Works in Vite dev (http://localhost:3100/...) and Electron file:// builds.
function clipUrl(filename: string): string {
  return new URL(`../../${CLIP_DIR}/${filename}`, document.baseURI).href;
}

class ClipPlayer {
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

  async play(filenames: string[]): Promise<boolean> {
    this.cancel();
    const myGen = ++this.generation;
    for (const filename of filenames) {
      if (myGen !== this.generation) return false; // cancelled
      const ok = await this.playOne(filename, myGen);
      if (!ok) return false;
    }
    return true;
  }

  private playOne(filename: string, myGen: number): Promise<boolean> {
    return new Promise((resolve) => {
      const audio = new Audio(clipUrl(filename));
      audio.preload = 'auto';
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
      audio.onended = () => {
        if (myGen !== this.generation) finish(false);
        else finish(true);
      };
      audio.onerror = () => finish(false);
      audio.play().catch(() => finish(false));
    });
  }
}

const player = new ClipPlayer();

// Fallback: Web Speech API. Used when any clip fails (404 in dev before
// running the generator, or asset loading errors). Sounds robotic but at
// least the announcement gets through.
//
// `speechSynthesis.getVoices()` is async-populated on Chromium: first call
// returns [] until the `voiceschanged` event fires. If the kiosk plays its
// first announcement before voices load, a synchronous `getVoices()` finds
// no Polish voice and the system speaks Polish text with the default
// (English) voice — sounds awful. We cache the resolved voice and wait
// briefly for `voiceschanged` if the list is still empty.
const VOICE_WAIT_MS = 500;
let cachedPolishVoice: SpeechSynthesisVoice | null = null;
let polishVoiceMissingWarned = false;

function pickPolishVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  return voices.find((v) => v.lang.toLowerCase().startsWith('pl')) ?? null;
}

async function ensurePolishVoice(): Promise<SpeechSynthesisVoice | null> {
  if (cachedPolishVoice) return cachedPolishVoice;
  if (typeof window === 'undefined' || !window.speechSynthesis) return null;
  const synth = window.speechSynthesis;
  const immediate = pickPolishVoice(synth.getVoices());
  if (immediate) {
    cachedPolishVoice = immediate;
    return immediate;
  }
  // Voices not loaded yet — wait for the event with a short timeout so we
  // never block the announcement indefinitely.
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
          '[self-checkout TTS] No Polish (pl-*) voice installed. The kiosk '
          + 'will speak Polish text with the default system voice. Install a '
          + 'Polish language pack or render tts-pl/*.mp3 via scripts/generate-tts-clips.mjs.',
        );
      }
      resolve(voice);
    };
    const onChange = () => finish(pickPolishVoice(synth.getVoices()));
    synth.addEventListener?.('voiceschanged', onChange);
    const timer = setTimeout(() => finish(pickPolishVoice(synth.getVoices())), VOICE_WAIT_MS);
  });
}

async function speakViaWebSpeech(method: Method, totalGrosze: number): Promise<void> {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const zl = Math.floor(totalGrosze / 100);
  const gr = totalGrosze % 100;
  const methodWord =
    method === 'CARD' ? 'kartą'
    : method === 'BLIK' ? 'BLIK-iem'
    : 'gotówką';
  const zlUnit = polishUnit(zl, 'złoty', 'złote', 'złotych');
  const grUnit = polishUnit(gr, 'grosz', 'grosze', 'groszy');
  const amount =
    zl === 0 && gr > 0
      ? `${gr} ${grUnit}`
      : gr === 0
        ? `${zl} ${zlUnit}`
        : `${zl} ${zlUnit} ${gr} ${grUnit}`;
  const utter = new SpeechSynthesisUtterance(`Płatność ${methodWord}. Do zapłaty ${amount}.`);
  utter.lang = 'pl-PL';
  utter.rate = 0.95;
  utter.volume = 1;
  const polish = await ensurePolishVoice();
  if (polish) utter.voice = polish;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

export async function playAnnouncement(method: Method, totalGrosze: number): Promise<void> {
  if (typeof window === 'undefined') return;
  const sequence = buildAnnouncementSequence({ method, totalGrosze });
  const ok = await player.play(sequence);
  if (!ok) await speakViaWebSpeech(method, totalGrosze);
}

export function cancelAnnouncement(): void {
  player.cancel();
  if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
}

// Best-effort warm-up: trigger HTTP/file cache for the framing + unit clips so
// the first announcement starts without a fetch delay. Number clips are loaded
// lazily on first use.
export function warmUpClipCache(): void {
  if (typeof window === 'undefined') return;
  const eager = [
    'prefix_card.mp3',
    'prefix_blik.mp3',
    'prefix_cash.mp3',
    'do_zaplaty.mp3',
    'zloty_1.mp3',
    'zloty_few.mp3',
    'zloty_many.mp3',
    'grosz_1.mp3',
    'grosz_few.mp3',
    'grosz_many.mp3',
    'thousand_1.mp3',
    'thousand_few.mp3',
    'thousand_many.mp3',
  ];
  for (const filename of eager) {
    const a = new Audio(clipUrl(filename));
    a.preload = 'auto';
    // No play; just letting the browser fetch into cache.
    a.load();
  }
  // Kick the speechSynthesis voice list early so the fallback path has a
  // resolved Polish voice ready by the time the customer picks a method.
  void ensurePolishVoice();
}
