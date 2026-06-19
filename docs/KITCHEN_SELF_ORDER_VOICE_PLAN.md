# Kitchen Self-Order Voice Announcement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a kitchen self-order is placed, the PC-YURI kiosk speaks a short Polish line with the pickup number ("Dziękujemy. Numer zamówienia [N]. Prosimy zachować numer."), once, with a Settings toggle.

**Architecture:** Extract the existing self-checkout Polish TTS into a shared engine in `src/renderer/lib/`, fixing its cancel/fail conflation. Build a kitchen-specific announcer on top that reuses the engine's number clips. Gate playback behind a new `kitchenSelfOrderVoiceEnabled` config flag, trigger it on the `done` step.

**Tech Stack:** Electron 33 renderer (React + TypeScript), Vitest, pre-rendered MP3 clips in `src/renderer/public/tts-pl/`, Web Speech API fallback.

**Source spec:** `docs/KITCHEN_SELF_ORDER_VOICE_DESIGN.md` (commit `bd902a7`).

## Global Constraints

- **Branch:** `feat/kitchen-label-ticket`. Do not switch branches, do not push.
- **Language spoken:** Polish only, regardless of the kiosk UI language (pl/vi/en).
- **Playback:** exactly once on entering the `done` step. No replay, no repeat.
- **Spoken line (Polish):** `Dziękujemy. Numer zamówienia [N]. Prosimy zachować numer.`
- **Clip filenames (new):** `kso_dziekujemy.mp3`, `kso_numer_zamowienia.mp3`, `kso_zachowaj_numer.mp3`. Number clips `1.mp3`..`999.mp3` already exist — reuse, do not regenerate.
- **Config flag:** `kitchenSelfOrderVoiceEnabled`, boolean, default `true`.
- **Tri-state cancel:** the clip player returns `'played' | 'failed' | 'cancelled'`. Web Speech fallback fires **only on `'failed'`**.
- **Order-number parse:** strict `^K-(\d+)$`, accept `1..999`, else skip the announcement.
- **Verification:** `npm run build` (BOTH `build:main` and `build:renderer`) + `npx vitest run` must pass. Audio audibility is a manual on-PC gate (SSH cannot hear).
- **Run commands over SSH** (`ssh winpc`, cmd.exe) from `C:\POS-zira`. Renderer/main builds may fail with `EBUSY` if a dev server is running — report, don't retry blindly.

---

### Task 1: Extract shared Polish TTS engine with tri-state cancel

Move the reusable playback/number/voice logic out of `polish-amount-tts.ts` into a shared engine, fixing the cancel-vs-fail conflation (spec P1). The amount module keeps its public API so `PaymentScreen.tsx` is untouched; existing TTS tests must stay green.

**Files:**
- Create: `src/renderer/lib/pl-tts-engine.ts`
- Modify: `src/renderer/windows/self-checkout/polish-amount-tts.ts`
- Test (new): `tests/pl-tts-engine.test.ts`
- Test (existing, must stay green): `tests/polish-amount-tts.test.ts`, `tests/polish-amount-tts-player.test.ts`

**Interfaces:**
- Produces (engine public API):
  - `type PlayResult = 'played' | 'failed' | 'cancelled'`
  - `polishUnit<T>(n: number, one: T, few: T, many: T): T`
  - `buildNumberSequence(n: number): string[]`
  - `clipUrl(filename: string): string`
  - `class ClipPlayer { play(filenames: string[]): Promise<PlayResult>; cancel(): void }`
  - `ensurePolishVoice(): Promise<SpeechSynthesisVoice | null>`
  - `speakPolishText(text: string, rate?: number): void`
  - `warmUpClips(filenames: string[]): void`
- `polish-amount-tts.ts` keeps exporting (unchanged signatures): `buildAnnouncementSequence`, `playAnnouncement`, `cancelAnnouncement`, `warmUpClipCache`, `type Method`, `type AnnouncementOptions`.

- [ ] **Step 1: Write the engine's failing test**

Create `tests/pl-tts-engine.test.ts`. (Audio/speech fakes mirror the existing player test.)

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ssh winpc "cd C:\POS-zira && npx vitest run tests/pl-tts-engine.test.ts"`
Expected: FAIL — `Cannot find module '../src/renderer/lib/pl-tts-engine'`.

- [ ] **Step 3: Create the engine**

Create `src/renderer/lib/pl-tts-engine.ts` (lift the logic from `polish-amount-tts.ts`, change `ClipPlayer.play` to tri-state):

```ts
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

export function speakPolishText(text: string, rate = 1.08): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'pl-PL';
  utter.rate = rate;
  utter.volume = 1;
  void ensurePolishVoice().then((voice) => {
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
```

> Note: `speakPolishText` resolves the voice asynchronously, then speaks. The existing
> amount tests fire `voiceschanged` after calling `playAnnouncement` and `await` the
> returned promise; keep `playAnnouncement` awaiting its fallback (Step 5) so that timing
> is preserved.

- [ ] **Step 4: Run the engine test to verify it passes**

Run: `ssh winpc "cd C:\POS-zira && npx vitest run tests/pl-tts-engine.test.ts"`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor `polish-amount-tts.ts` onto the engine**

Replace the file's inline engine with imports; keep the amount-specific parts and the public API. Fallback fires **only on `'failed'`**:

```ts
// Polish currency-amount text-to-speech for the self-checkout kiosk.
// Builds the amount sentence and plays it through the shared pl-tts-engine,
// falling back to Web Speech only when clip playback actually fails.
import {
  ClipPlayer,
  buildNumberSequence,
  ensurePolishVoice,
  polishUnit,
  speakPolishText,
  warmUpClips,
} from '../../lib/pl-tts-engine';

export type Method = 'CARD' | 'CASH' | 'BLIK';

const WEB_SPEECH_RATE = 1.08;

function zlotyUnitClip(count: number): string {
  return polishUnit(count, 'zloty_1.mp3', 'zloty_few.mp3', 'zloty_many.mp3');
}
function groszUnitClip(count: number): string {
  return polishUnit(count, 'grosz_1.mp3', 'grosz_few.mp3', 'grosz_many.mp3');
}

export interface AnnouncementOptions { method: Method; totalGrosze: number; }

export function buildAnnouncementSequence({ method, totalGrosze }: AnnouncementOptions): string[] {
  const zl = Math.floor(Math.max(0, totalGrosze) / 100);
  const gr = Math.floor(Math.max(0, totalGrosze)) % 100;
  const clips: string[] = [];
  const prefix = method === 'CARD' ? 'prefix_card.mp3'
    : method === 'BLIK' ? 'prefix_blik.mp3'
    : 'prefix_cash.mp3';
  clips.push(prefix);
  clips.push('do_zaplaty.mp3');
  if (zl > 0) { clips.push(...buildNumberSequence(zl)); clips.push(zlotyUnitClip(zl)); }
  if (gr > 0) { clips.push(...buildNumberSequence(gr)); clips.push(groszUnitClip(gr)); }
  if (zl === 0 && gr === 0) { clips.push('0.mp3'); clips.push('zloty_many.mp3'); }
  return clips;
}

const player = new ClipPlayer();

function amountText(method: Method, totalGrosze: number): string {
  const zl = Math.floor(totalGrosze / 100);
  const gr = totalGrosze % 100;
  const methodWord = method === 'CARD' ? 'kartą' : method === 'BLIK' ? 'BLIK-iem' : 'gotówką';
  const zlUnit = polishUnit(zl, 'złoty', 'złote', 'złotych');
  const grUnit = polishUnit(gr, 'grosz', 'grosze', 'groszy');
  const amount = zl === 0 && gr > 0 ? `${gr} ${grUnit}`
    : gr === 0 ? `${zl} ${zlUnit}`
    : `${zl} ${zlUnit} ${gr} ${grUnit}`;
  return `Płatność ${methodWord}. Do zapłaty ${amount}.`;
}

export async function playAnnouncement(method: Method, totalGrosze: number): Promise<void> {
  if (typeof window === 'undefined') return;
  const result = await player.play(buildAnnouncementSequence({ method, totalGrosze }));
  if (result === 'failed') {
    speakPolishText(amountText(method, totalGrosze), WEB_SPEECH_RATE);
    // Ensure the voice resolves before returning so tests can await it.
    await ensurePolishVoice();
  }
}

export function cancelAnnouncement(): void {
  player.cancel();
  if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
}

export function warmUpClipCache(): void {
  warmUpClips([
    'prefix_card.mp3', 'prefix_blik.mp3', 'prefix_cash.mp3', 'do_zaplaty.mp3',
    'zloty_1.mp3', 'zloty_few.mp3', 'zloty_many.mp3',
    'grosz_1.mp3', 'grosz_few.mp3', 'grosz_many.mp3',
    'thousand_1.mp3', 'thousand_few.mp3', 'thousand_many.mp3',
  ]);
}
```

> The existing player test `'falls through with utter.lang=pl-PL when no Polish voice is
> installed'` advances fake timers and awaits the announce promise; the trailing
> `await ensurePolishVoice()` keeps that resolution inside the awaited promise. If the
> existing test asserts on `speech.spoke[0].voice` synchronously after `await announce`,
> it still holds because `speakPolishText` schedules the `speak` inside the awaited
> `ensurePolishVoice().then(...)` — confirm in Step 7 and adjust the await placement if a
> race appears.

- [ ] **Step 6: Add a cancellation-silence regression test**

Append to `tests/pl-tts-engine.test.ts` (proves the spec P1 contract at engine level — cancel does not surface as failure):

```ts
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
```

- [ ] **Step 7: Run the full TTS suite — engine + both existing files must pass**

Run: `ssh winpc "cd C:\POS-zira && npx vitest run tests/pl-tts-engine.test.ts tests/polish-amount-tts.test.ts tests/polish-amount-tts-player.test.ts"`
Expected: PASS (all). If `polish-amount-tts-player` fails on a voice-resolution timing assertion, move the `await ensurePolishVoice()` so the `speak` call happens before `playAnnouncement` resolves (the fallback must complete within the awaited promise). Do not weaken the existing assertions.

- [ ] **Step 8: Type-check renderer**

Run: `ssh winpc "cd C:\POS-zira && npm run build:renderer"`
Expected: build succeeds (no TS errors from the moved symbols).

- [ ] **Step 9: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/lib/pl-tts-engine.ts src/renderer/windows/self-checkout/polish-amount-tts.ts tests/pl-tts-engine.test.ts && git commit -m \"refactor(tts): extract shared pl-tts-engine with tri-state cancel\""
```

---

### Task 2: Add the three Polish framing clips to the generator

Teach the clip generator the three new phrases so they can be rendered. Rendering itself needs `GOOGLE_TTS_API_KEY`; if absent, ship without the mp3s (the Web Speech fallback covers it) and render later.

**Files:**
- Modify: `scripts/generate-google-tts-clips.mjs`
- Assets (when rendered): `src/renderer/public/tts-pl/kso_dziekujemy.mp3`, `kso_numer_zamowienia.mp3`, `kso_zachowaj_numer.mp3`

**Interfaces:**
- Produces: the three clip files named exactly as in Global Constraints (consumed by Task 3).

- [ ] **Step 1: Inspect the generator's phrase map**

Run: `ssh winpc "cd C:\POS-zira && type scripts\generate-google-tts-clips.mjs"`
Locate the object/array mapping clip filename → Polish source text (e.g. `do_zaplaty.mp3` → "do zapłaty").

- [ ] **Step 2: Add the three phrases**

Add to that map (exact Polish text):

```js
'kso_dziekujemy.mp3': 'Dziękujemy.',
'kso_numer_zamowienia.mp3': 'Numer zamówienia',
'kso_zachowaj_numer.mp3': 'Prosimy zachować numer.',
```

(If the generator derives phrases differently, follow its existing structure — the goal is these three filenames render with this text.)

- [ ] **Step 3: Render the three clips (operational — needs API key)**

Run (PowerShell, with the key set):
```
ssh winpc "cd C:\POS-zira && set GOOGLE_TTS_API_KEY=<KEY>&& set ONLY=kso_dziekujemy.mp3,kso_numer_zamowienia.mp3,kso_zachowaj_numer.mp3&& node scripts\generate-google-tts-clips.mjs"
```
Expected: three files written to `src/renderer/public/tts-pl/`.
If no API key is available, **skip rendering** — note it in the commit message and the handoff; the feature still works via Web Speech. Do not block the plan on this.

- [ ] **Step 4: Verify the files exist (if rendered)**

Run: `ssh winpc "cd C:\POS-zira && dir src\renderer\public\tts-pl\kso_*.mp3"`
Expected: three files listed (or "File Not Found" if rendering was skipped).

- [ ] **Step 5: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add scripts/generate-google-tts-clips.mjs src/renderer/public/tts-pl/kso_*.mp3 && git commit -m \"feat(tts): add kitchen order-number framing clips to generator\""
```
(If rendering was skipped, `git add` only the script; the `kso_*.mp3` glob will match nothing and is harmless.)

---

### Task 3: Kitchen order-number announcer module

Build the kitchen-specific announcer on the engine: strict order-number parse, clip sequence, play-with-fallback, warm-up, cancel, and an audio-unlock primer.

**Files:**
- Create: `src/renderer/windows/kitchen-self-order/order-number-tts.ts`
- Test: `tests/kitchen-order-number-tts.test.ts`

**Interfaces:**
- Consumes (from Task 1): `ClipPlayer`, `buildNumberSequence`, `speakPolishText`, `warmUpClips` from `../../lib/pl-tts-engine`.
- Produces (consumed by Task 6):
  - `parseKitchenOrderSequence(orderNumber: string | null | undefined): number | null`
  - `buildOrderNumberSequence(n: number): string[]`
  - `shouldAnnounceOrderNumber(step: string, voiceEnabled: boolean, orderNumber: string | null | undefined): number | null`
  - `playOrderNumberAnnouncement(n: number): Promise<void>`
  - `warmUpOrderNumberClips(): void`
  - `primeOrderNumberAudio(): void`
  - `cancelOrderNumberAnnouncement(): void`

- [ ] **Step 1: Write the failing test**

Create `tests/kitchen-order-number-tts.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('parseKitchenOrderSequence', () => {
  it('accepts K-001..K-999', async () => {
    const { parseKitchenOrderSequence } = await import(
      '../src/renderer/windows/kitchen-self-order/order-number-tts'
    );
    expect(parseKitchenOrderSequence('K-001')).toBe(1);
    expect(parseKitchenOrderSequence('K-042')).toBe(42);
    expect(parseKitchenOrderSequence('K-999')).toBe(999);
  });

  it('rejects placeholder, malformed, and out-of-range', async () => {
    const { parseKitchenOrderSequence } = await import(
      '../src/renderer/windows/kitchen-self-order/order-number-tts'
    );
    for (const bad of ['K----', 'K-1000', 'K-0', '', 'X-1', '001', null, undefined]) {
      expect(parseKitchenOrderSequence(bad as any)).toBeNull();
    }
  });
});

describe('buildOrderNumberSequence', () => {
  it('frames the number clips with thanks/label/keep', async () => {
    const { buildOrderNumberSequence } = await import(
      '../src/renderer/windows/kitchen-self-order/order-number-tts'
    );
    expect(buildOrderNumberSequence(42)).toEqual([
      'kso_dziekujemy.mp3', 'kso_numer_zamowienia.mp3', '42.mp3', 'kso_zachowaj_numer.mp3',
    ]);
  });
});

describe('shouldAnnounceOrderNumber', () => {
  it('returns the number only on done + flag on + valid number', async () => {
    const { shouldAnnounceOrderNumber } = await import(
      '../src/renderer/windows/kitchen-self-order/order-number-tts'
    );
    expect(shouldAnnounceOrderNumber('done', true, 'K-007')).toBe(7);
    expect(shouldAnnounceOrderNumber('review', true, 'K-007')).toBeNull();
    expect(shouldAnnounceOrderNumber('done', false, 'K-007')).toBeNull();
    expect(shouldAnnounceOrderNumber('done', true, 'K----')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ssh winpc "cd C:\POS-zira && npx vitest run tests/kitchen-order-number-tts.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `src/renderer/windows/kitchen-self-order/order-number-tts.ts`:

```ts
// Polish voice announcement of the kitchen self-order pickup number, played once
// on the done screen. Reuses the shared pl-tts-engine number clips and Web Speech
// fallback. Polish only, by product decision.
import {
  ClipPlayer,
  buildNumberSequence,
  speakPolishText,
  warmUpClips,
} from '../../lib/pl-tts-engine';

const FRAMING = {
  thanks: 'kso_dziekujemy.mp3',
  label: 'kso_numer_zamowienia.mp3',
  keep: 'kso_zachowaj_numer.mp3',
};

export function parseKitchenOrderSequence(orderNumber: string | null | undefined): number | null {
  if (!orderNumber) return null;
  const match = /^K-(\d+)$/.exec(orderNumber.trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 1 || n > 999) return null;
  return n;
}

export function buildOrderNumberSequence(n: number): string[] {
  return [FRAMING.thanks, FRAMING.label, ...buildNumberSequence(n), FRAMING.keep];
}

export function shouldAnnounceOrderNumber(
  step: string,
  voiceEnabled: boolean,
  orderNumber: string | null | undefined,
): number | null {
  if (step !== 'done' || !voiceEnabled) return null;
  return parseKitchenOrderSequence(orderNumber);
}

function spokenText(n: number): string {
  return `Dziękujemy. Numer zamówienia ${n}. Prosimy zachować numer.`;
}

const player = new ClipPlayer();

export async function playOrderNumberAnnouncement(n: number): Promise<void> {
  if (typeof window === 'undefined') return;
  const result = await player.play(buildOrderNumberSequence(n));
  if (result === 'failed') speakPolishText(spokenText(n));
}

export function cancelOrderNumberAnnouncement(): void {
  player.cancel();
  if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
}

export function warmUpOrderNumberClips(): void {
  warmUpClips([FRAMING.thanks, FRAMING.label, FRAMING.keep]);
}

// Best-effort audio unlock. Call synchronously inside the submit tap so the later
// (post-await) announcement rides the page's user activation. Failures are ignored.
let audioPrimed = false;
export function primeOrderNumberAudio(): void {
  if (audioPrimed || typeof window === 'undefined') return;
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx) { const ctx = new Ctx(); void ctx.resume().catch(() => undefined); }
    audioPrimed = true;
  } catch {
    /* best-effort */
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `ssh winpc "cd C:\POS-zira && npx vitest run tests/kitchen-order-number-tts.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/windows/kitchen-self-order/order-number-tts.ts tests/kitchen-order-number-tts.test.ts && git commit -m \"feat(kitchen): order-number voice announcer module\""
```

---

### Task 4: Config flag `kitchenSelfOrderVoiceEnabled`

Add the boolean flag to the shared config type and the main-process store schema (default `true`).

**Files:**
- Modify: `src/shared/types.ts` (kitchenSelfOrder group, ~line 639)
- Modify: `src/main/config/store.ts` (schema, ~line 392)
- Test: `tests/kitchen-self-order-voice-config-static.test.ts`

**Interfaces:**
- Produces: config key `kitchenSelfOrderVoiceEnabled?: boolean` (read by Tasks 5 and 6).

- [ ] **Step 1: Write the failing static test**

Create `tests/kitchen-self-order-voice-config-static.test.ts` (mirrors the repo's `*-static.test.ts` source-assertion pattern):

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const types = readFileSync(resolve(__dirname, '../src/shared/types.ts'), 'utf-8');
const store = readFileSync(resolve(__dirname, '../src/main/config/store.ts'), 'utf-8');

describe('kitchenSelfOrderVoiceEnabled config', () => {
  it('is declared on the config type', () => {
    expect(types).toMatch(/kitchenSelfOrderVoiceEnabled\?\s*:\s*boolean/);
  });
  it('is in the store schema with default true', () => {
    expect(store).toMatch(/kitchenSelfOrderVoiceEnabled:\s*\{\s*type:\s*'boolean',\s*default:\s*true\s*\}/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ssh winpc "cd C:\POS-zira && npx vitest run tests/kitchen-self-order-voice-config-static.test.ts"`
Expected: FAIL (key not present yet).

- [ ] **Step 3: Add the type field**

In `src/shared/types.ts`, after the `kitchenSelfOrderReleasePolicy?...` line (~640), add:

```ts
  kitchenSelfOrderVoiceEnabled?: boolean;   // Speak the pickup number (Polish) on the done screen.
```

- [ ] **Step 4: Add the store default**

In `src/main/config/store.ts`, after the `kitchenSelfOrderReleasePolicy` schema entry (~398), add:

```ts
    kitchenSelfOrderVoiceEnabled: { type: 'boolean', default: true },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `ssh winpc "cd C:\POS-zira && npx vitest run tests/kitchen-self-order-voice-config-static.test.ts"`
Expected: PASS.

- [ ] **Step 6: Type-check main**

Run: `ssh winpc "cd C:\POS-zira && npm run build:main"`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/shared/types.ts src/main/config/store.ts tests/kitchen-self-order-voice-config-static.test.ts && git commit -m \"feat(config): kitchenSelfOrderVoiceEnabled flag (default on)\""
```

---

### Task 5: Settings toggle in SelfCheckoutTab

Expose the flag as an on/off control in the kitchen kiosk settings block, loaded and persisted like the neighbouring fields.

**Files:**
- Modify: `src/renderer/components/SelfCheckoutTab.tsx`
- Test: `tests/kitchen-self-order-voice-toggle-static.test.ts`

**Interfaces:**
- Consumes: config key `kitchenSelfOrderVoiceEnabled` (Task 4).

- [ ] **Step 1: Write the failing static test**

Create `tests/kitchen-self-order-voice-toggle-static.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const source = readFileSync(
  resolve(__dirname, '../src/renderer/components/SelfCheckoutTab.tsx'),
  'utf-8',
);

describe('kitchen voice toggle in SelfCheckoutTab', () => {
  it('has state initialised from config (default true)', () => {
    expect(source).toContain('const [kitchenVoiceEnabled, setKitchenVoiceEnabled] = useState<boolean>(true)');
    expect(source).toContain('setKitchenVoiceEnabled(c.kitchenSelfOrderVoiceEnabled !== false)');
  });
  it('persists the flag on change', () => {
    expect(source).toContain('persist({ kitchenSelfOrderVoiceEnabled:');
  });
  it('labels the control in all three copy branches', () => {
    expect(source.match(/voiceLabel:/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ssh winpc "cd C:\POS-zira && npx vitest run tests/kitchen-self-order-voice-toggle-static.test.ts"`
Expected: FAIL.

- [ ] **Step 3: Add the copy key to all three branches**

In `getKitchenSelfOrderCopy`, add a `voiceLabel` to the `vi`, `pl`, and default (en) returned objects:

```ts
// vi branch:
      voiceLabel: 'Đọc số đơn bằng giọng nói',
// pl branch:
      voiceLabel: 'Odczytaj numer zamówienia głosowo',
// en (default) branch:
    voiceLabel: 'Speak the order number',
```

- [ ] **Step 4: Add state + load**

Add the state declaration near the other kitchen states (~line 122):

```ts
  const [kitchenVoiceEnabled, setKitchenVoiceEnabled] = useState<boolean>(true);
```

Inside the config-loading `useEffect` (after `setKitchenSlipPrinterType(...)`, ~line 139):

```ts
    setKitchenVoiceEnabled(c.kitchenSelfOrderVoiceEnabled !== false);
```

- [ ] **Step 5: Add the toggle control**

After the slip-printer `SettingField` (closes at ~line 483, before the closing `</div>` of the grid), add (uses `Volume2` from lucide-react — add it to the existing `lucide-react` import):

```tsx
            <SettingField
              icon={<Volume2 size={17} />}
              label={kitchenCopy.voiceLabel}
              help="Polish voice reads the pickup number once on the done screen."
            >
              <select
                value={kitchenVoiceEnabled ? 'on' : 'off'}
                onChange={(e) => {
                  const v = e.target.value === 'on';
                  setKitchenVoiceEnabled(v);
                  persist({ kitchenSelfOrderVoiceEnabled: v });
                }}
                className="h-11 w-full rounded-lg border border-[var(--sand-300)] bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
              >
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </SettingField>
```

Also persist it when the kiosk opens — add to the `persist({...})` object in `openKitchenSelfOrder` (~line 217):

```ts
        kitchenSelfOrderVoiceEnabled: kitchenVoiceEnabled,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `ssh winpc "cd C:\POS-zira && npx vitest run tests/kitchen-self-order-voice-toggle-static.test.ts"`
Expected: PASS. Also run `npx vitest run tests/self-checkout-tab-i18n.test.ts` — Expected: PASS (no required-key regression).

- [ ] **Step 7: Type-check renderer**

Run: `ssh winpc "cd C:\POS-zira && npm run build:renderer"`
Expected: build succeeds (Volume2 imported, `voiceLabel` present in all branches so the union type is consistent).

- [ ] **Step 8: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/components/SelfCheckoutTab.tsx tests/kitchen-self-order-voice-toggle-static.test.ts && git commit -m \"feat(settings): kitchen self-order voice toggle\""
```

---

### Task 6: Trigger the announcement on the done screen

Wire the announcer into `KitchenSelfOrderApp`: read the flag, warm up, prime audio on the submit tap, play once on `done`, cancel on reset/unmount.

**Files:**
- Modify: `src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx`
- Test: `tests/kitchen-self-order-voice-wiring-static.test.ts`

**Interfaces:**
- Consumes (from Task 3): `playOrderNumberAnnouncement`, `warmUpOrderNumberClips`, `primeOrderNumberAudio`, `cancelOrderNumberAnnouncement`, `shouldAnnounceOrderNumber`.

- [ ] **Step 1: Write the failing static test**

Create `tests/kitchen-self-order-voice-wiring-static.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const source = readFileSync(
  resolve(__dirname, '../src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx'),
  'utf-8',
);

describe('KitchenSelfOrderApp voice wiring', () => {
  it('imports the announcer', () => {
    expect(source).toContain("from './order-number-tts'");
    expect(source).toContain('playOrderNumberAnnouncement');
    expect(source).toContain('shouldAnnounceOrderNumber');
  });
  it('reads the voice flag from config', () => {
    expect(source).toContain('kitchenSelfOrderVoiceEnabled');
  });
  it('primes audio inside the submit handler before awaiting', () => {
    expect(source).toContain('primeOrderNumberAudio()');
  });
  it('guards single playback with a ref', () => {
    expect(source).toContain('announcedRef');
  });
  it('cancels the announcement on reset', () => {
    expect(source).toContain('cancelOrderNumberAnnouncement()');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ssh winpc "cd C:\POS-zira && npx vitest run tests/kitchen-self-order-voice-wiring-static.test.ts"`
Expected: FAIL.

- [ ] **Step 3: Import the announcer**

At the top of `KitchenSelfOrderApp.tsx`, add after the existing relative imports (near line 33):

```ts
import {
  cancelOrderNumberAnnouncement,
  playOrderNumberAnnouncement,
  primeOrderNumberAudio,
  shouldAnnounceOrderNumber,
  warmUpOrderNumberClips,
} from './order-number-tts';
```

Add `useRef` to the React import on line 1:

```ts
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
```

- [ ] **Step 4: Add voice state + the playback ref**

Next to the other `useState` hooks (~line 243), add:

```ts
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const announcedRef = useRef<string | null>(null);
```

- [ ] **Step 5: Read the flag + warm up**

In the config-loading `useEffect` (the one that sets `setLanguage`/`setFulfillment`, ~line 279), add inside the `try` after `setFulfillment(...)`:

```ts
        setVoiceEnabled(config.kitchenSelfOrderVoiceEnabled !== false);
```

Add a mount warm-up effect (after that effect, ~line 290):

```ts
  useEffect(() => {
    warmUpOrderNumberClips();
  }, []);
```

- [ ] **Step 6: Prime audio on the submit tap**

At the very top of `submitOrder` (before any `await`/branch, ~line 430), and likewise at the top of `retryCustomerSlip` (~line 410), add:

```ts
    primeOrderNumberAudio();
```

(Both are invoked directly from button `onClick` handlers, so this runs inside the user gesture.)

- [ ] **Step 7: Play once on `done`, cancel on reset**

Add an announcement effect (after the existing `done` auto-reset effect, ~line 318):

```ts
  useEffect(() => {
    const n = shouldAnnounceOrderNumber(step, voiceEnabled, submitResult?.orderNumber);
    if (n == null) return;
    const key = submitResult?.orderNumber ?? String(n);
    if (announcedRef.current === key) return;   // guard StrictMode / re-renders
    announcedRef.current = key;
    void playOrderNumberAnnouncement(n);
  }, [step, voiceEnabled, submitResult?.orderNumber]);
```

In `resetSession` (~line 292), add as the first line:

```ts
    cancelOrderNumberAnnouncement();
    announcedRef.current = null;
```

Add an unmount cancel (one-time effect):

```ts
  useEffect(() => () => cancelOrderNumberAnnouncement(), []);
```

- [ ] **Step 8: Run the wiring test to verify it passes**

Run: `ssh winpc "cd C:\POS-zira && npx vitest run tests/kitchen-self-order-voice-wiring-static.test.ts"`
Expected: PASS.

- [ ] **Step 9: Type-check renderer**

Run: `ssh winpc "cd C:\POS-zira && npm run build:renderer"`
Expected: build succeeds.

- [ ] **Step 10: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx tests/kitchen-self-order-voice-wiring-static.test.ts && git commit -m \"feat(kitchen): announce pickup number once on done screen\""
```

---

### Task 7: Full verification + manual release gate

**Files:** none (verification only).

- [ ] **Step 1: Full build (both targets — spec P2a)**

Run: `ssh winpc "cd C:\POS-zira && npm run build"`
Expected: `build:main` and `build:renderer` both succeed.

- [ ] **Step 2: Full test suite**

Run: `ssh winpc "cd C:\POS-zira && npx vitest run"`
Expected: PASS, including `pl-tts-engine`, `polish-amount-tts`, `polish-amount-tts-player`, `kitchen-order-number-tts`, and the three static tests. No regressions in the existing self-checkout / kitchen suites.

- [ ] **Step 3: Report the manual release gate (cannot be done over SSH — spec P2b)**

Hand these to the user to verify on PC-YURI with a built app:
1. Place a test kitchen self-order → on the done screen the Polish line is **audible** once (autoplay survived the async submit).
2. Toggle **Off** in Settings → next order is silent.
3. Tap **New order** mid-announcement → audio stops and Web Speech does **not** start.
4. If the `kso_*.mp3` clips were not rendered (Task 2 skipped), confirm the Web Speech fallback voices the same line (robotic but present), and schedule clip rendering.

- [ ] **Step 4: Report completion**

Summarize commits, test results, build status, and the open manual gate / clip-render status to the user via the print-agent report format. Do not push.

---

## Self-Review

**Spec coverage:**
- Reuse engine / tri-state cancel (P1) → Task 1. ✓
- 3 framing clips + generator (§4.4) → Task 2. ✓
- Order-number announcer + strict parse (§4.3) → Task 3. ✓
- Config flag default true (§4.5/4.6) → Task 4. ✓
- Settings toggle (§4.7) → Task 5. ✓
- Done-screen trigger, ref guard, audio prime, cancel (§4.8, P2b) → Task 6. ✓
- `npm run build` both targets (P2a) + existing TTS tests green (P3) → Tasks 1, 7. ✓
- Polish-only / once / spoken line → Global Constraints + Tasks 3, 6. ✓
- Degradation: failed→speak, cancelled→silent, null→skip (§5) → Tasks 1, 3, 6. ✓
- Manual audio gate (§6) → Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. Task 2 render is explicitly optional with a documented fallback (not a placeholder).

**Type consistency:** `PlayResult` and engine names defined in Task 1 are consumed verbatim in Task 3. `shouldAnnounceOrderNumber`/`playOrderNumberAnnouncement`/`primeOrderNumberAudio`/`cancelOrderNumberAnnouncement`/`warmUpOrderNumberClips` defined in Task 3, imported identically in Task 6. Config key `kitchenSelfOrderVoiceEnabled` identical across Tasks 4/5/6. `voiceLabel` added to all three copy branches (Task 5) so the union type stays consistent.
