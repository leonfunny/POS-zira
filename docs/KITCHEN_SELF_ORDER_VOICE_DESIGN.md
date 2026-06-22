# Kitchen Self-Order — Voice Announcement (Design Spec)

**Date:** 2026-06-19
**Branch:** `feat/kitchen-label-ticket`
**Status:** Approved design — ready for implementation plan
**Scope:** Mostly renderer. Touches `main/config/store.ts` + `shared/types.ts` for one
config flag (no new backend module, no IPC change, no DB migration). Because the main
config schema changes, verification requires **`npm run build`** (both `build:main` and
`build:renderer`), not renderer alone.

## 1. Goal

When a customer finishes ordering at the kitchen self-order kiosk and the order is
placed (step `done`), the kiosk speaks a short Polish confirmation that includes the
pickup order number, so the customer remembers the number they must show at the
counter.

Example spoken line (Polish): **"Dziękujemy. Numer zamówienia [N]. Prosimy zachować numer."**

Where `[N]` is the numeric part of the order number `K-001`…`K-999`
(`formatKitchenSelfOrderNumber` in `src/shared/kitchen-self-order.ts`), spoken as a
Polish cardinal (e.g. `K-042` → "czterdzieści dwa").

## 2. Decisions (locked)

| Question | Decision |
|----------|----------|
| What is spoken | Order number + thank-you ("Dziękujemy … Prosimy zachować numer") |
| Language | **Polish only**, regardless of the customer's UI language (pl/vi/en) |
| Playback | **Once**, on entering the `done` step. No replay button, no repeat. |
| Settings toggle | **Yes** — `kitchenSelfOrderVoiceEnabled`, default `true` |
| TTS engine | Reuse the existing self-checkout clip engine + Web Speech fallback |
| File organization | **Extract the shared engine** into `src/renderer/lib/`; amount and order-number announcements both build on it |

## 3. Why reuse, and what exactly is reused

The grocery self-checkout already speaks Polish amounts via
`src/renderer/windows/self-checkout/polish-amount-tts.ts` (used only by
`screens/PaymentScreen.tsx`). That module has two layers:

- **Engine (reusable):** `ClipPlayer` (plays a sequence of MP3 clips with cancel),
  `buildNumberSequence(n)` (Polish number 1–999 → clip list — this already speaks our
  order numbers), `clipUrl`, `polishUnit`, `ensurePolishVoice` + Web Speech fallback,
  warm-up.

  **During extraction, fix the cancel/fail conflation (P1).** The current
  `ClipPlayer.play(): Promise<boolean>` returns `false` for **both** a clip failure and a
  cancellation (generation mismatch). A consumer that falls back to Web Speech on `false`
  will speak the announcement even when playback was deliberately cancelled (customer taps
  "New order", auto-reset fires, or the window unmounts mid-playback). The engine must
  return a **tri-state**: `'played' | 'failed' | 'cancelled'`. Consumers fall back to Web
  Speech **only on `'failed'`**. This also hardens the existing amount path, which has the
  same latent bug today (`playAnnouncement` runs Web Speech whenever `play()` is falsy).
- **Content (not reusable):** `playAnnouncement(method, totalGrosze)` hardwires the
  payment-amount sentence ("Płatność kartą. Do zapłaty X złotych…").

We extract the engine to a shared module so both consumers build their own sentence on
top of one tested playback/fallback core. The amount path keeps its public API so the
payment screen does not change.

### Path resolution note (verified)

`clipUrl` resolves clips with `new URL('../../tts-pl/<file>', document.baseURI)`.
`document.baseURI` is the **HTML page** location, not the module location, so moving the
engine into `lib/` does not affect resolution. Both windows host their `index.html` at
`windows/<name>/index.html` (same depth), so `../../tts-pl/` resolves to
`dist/renderer/tts-pl/` for both self-checkout and kitchen-self-order.

## 4. File-by-file changes

### 4.1 `src/renderer/lib/pl-tts-engine.ts` (NEW)

Shared Polish TTS engine. Public surface (final names to be settled in the plan):

- `buildNumberSequence(n: number): string[]` — clip filenames for a Polish cardinal 0–999999.
- `class ClipPlayer` (or a per-window singleton) with
  `play(filenames): Promise<'played' | 'failed' | 'cancelled'>` and `cancel()` — tri-state
  per P1 above.
- `clipUrl(filename: string): string`.
- `polishUnit<T>(n, one, few, many): T` — declension helper (kept for the amount path).
- `ensurePolishVoice(): Promise<SpeechSynthesisVoice | null>`.
- `speakPolishText(text: string, rate?: number): void` — generic Web Speech fallback (composes an utterance with `lang = 'pl-PL'`, picks the cached Polish voice).
- `warmUpClips(filenames: string[]): void` + kicks `ensurePolishVoice()`.

Each renderer window imports the engine into its own JS context (separate Electron
windows), so a module-level player singleton is per-window — no cross-window state.

### 4.2 `src/renderer/windows/self-checkout/polish-amount-tts.ts` (REFACTOR)

- Import engine pieces instead of defining them inline.
- Keep the exact public API: `playAnnouncement(method, totalGrosze)`,
  `warmUpClipCache()`, `cancelAnnouncement()`.
- The amount-specific sentence builder and its Web Speech fallback stay here (now calling
  `speakPolishText` from the engine, and falling back only when `play()` returns
  `'failed'`).
- `PaymentScreen.tsx` import is **unchanged** (same public API). This keeps the call site
  stable but is **not** proof the money path is safe: the refactor moves the exact playback
  logic the existing TTS tests cover, so those tests are a required gate (see §6). The cancel
  semantics change is observable behavior — re-verify the amount path under it.

### 4.3 `src/renderer/windows/kitchen-self-order/order-number-tts.ts` (NEW)

- `playOrderNumberAnnouncement(orderNumber: number): Promise<void>` — builds the clip
  sequence `[kso_dziekujemy, kso_numer_zamowienia, ...buildNumberSequence(N), kso_zachowaj_numer]`,
  plays via the engine; falls back to
  `speakPolishText('Dziękujemy. Numer zamówienia <N>. Prosimy zachować numer.')`
  **only when the engine returns `'failed'`** (not on `'cancelled'`).
- `warmUpOrderNumberClips()` — warm the 3 framing clips + voice (called when the kiosk
  mounts, mirroring the payment screen warm-up).
- `cancelOrderNumberAnnouncement()` — engine cancel + `speechSynthesis.cancel()`.

**Order-number parsing (strict).** `submitResult.orderNumber` is the formatted string
`K-001`. Parse it with a strict helper `parseKitchenOrderSequence(s): number | null`:
match `^K-(\d+)$`, return the integer only if it is in `1..999`, otherwise `null`. The
caller **skips the announcement when the result is `null`** (placeholder `K----`,
malformed, or out of clip range). Do not thread a raw sequence number through state — that
is extra scope.

### 4.4 New clips in `src/renderer/public/tts-pl/`

| Clip | Polish text |
|------|-------------|
| `kso_dziekujemy.mp3` | "Dziękujemy." |
| `kso_numer_zamowienia.mp3` | "Numer zamówienia" |
| `kso_zachowaj_numer.mp3` | "Prosimy zachować numer." |

Rendered with the existing generator `scripts/generate-google-tts-clips.mjs` (add the 3
phrases to its phrase→text map, run with `ONLY=kso_dziekujemy.mp3,...` and
`GOOGLE_TTS_API_KEY`). Committed as assets. **Number clips 1–999 already exist** and are
reused as-is.

> Operational note: rendering needs `GOOGLE_TTS_API_KEY` (or Azure creds for the Azure
> generator). If unavailable at implementation time, ship with the Web Speech fallback and
> render/commit the clips later — the feature works either way, clips only raise quality.

### 4.5 `src/shared/types.ts`

Add to the `kitchenSelfOrder*` config group (near line 639):

```ts
kitchenSelfOrderVoiceEnabled?: boolean;   // Speak the pickup number on the done screen (Polish).
```

### 4.6 `src/main/config/store.ts`

Add to the schema (near line 392):

```ts
kitchenSelfOrderVoiceEnabled: { type: 'boolean', default: true },
```

### 4.7 `src/renderer/components/SelfCheckoutTab.tsx`

In the kitchen self-order settings block (alongside language/fulfillment around lines
136/213/407): add a toggle "Odczytaj numer zamówienia głosowo" / localized label, wired to
`kitchenSelfOrderVoiceEnabled`, persisted like the other flags.

### 4.8 `src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx`

- Read `kitchenSelfOrderVoiceEnabled` in the existing config-loading `useEffect`
  (where `kitchenSelfOrderLanguage`/`DefaultFulfillment` are already read) into state,
  default `true`.
- On mount: call `warmUpOrderNumberClips()` (best-effort).
- Add a `useEffect` keyed on `step` (and order number): when `step === 'done'` and the
  voice flag is on and we have a real `submitResult.orderNumber`, call
  `playOrderNumberAnnouncement(N)` **once**. Use a ref to guard against React
  StrictMode double-invocation and against re-firing on countdown re-renders.
- On `resetSession` / unmount: `cancelOrderNumberAnnouncement()`.

**Autoplay risk (P2b) — do not assume it just works.** Unlike the payment screen (which
plays synchronously inside a click handler), this announcement fires **after** the async
`submitOrder` IPC resolves (`KitchenSelfOrderApp.tsx:447`). By then Chromium's transient
user activation may have lapsed, so a bare `audio.play()` can be rejected by the autoplay
policy. Mitigation, both required:
  1. **Prime audio inside the submit tap.** In the "Place order" click handler —
     synchronously, before the `await` — perform a one-time audio unlock (play a short
     silent/again-paused `HTMLAudioElement`, or resume a shared `AudioContext`). This
     converts the tap's activation into sticky permission the later announcement rides on.
  2. **Hard release gate:** real-kiosk audio verification (announcement actually audible on
     the done screen after a live submit) is a **blocking** acceptance criterion — it cannot
     be signed off from SSH.
If `play()` is still rejected, the Web Speech fallback (also gesture-gated) may be silent
too; that is acceptable degradation (the number is shown large on screen regardless).

## 5. Error handling / degradation

- Engine returns `'failed'` (missing/failing clip) → consumer speaks the full Polish
  sentence via Web Speech (`pl-PL`). If no Polish system voice is installed, it speaks with
  the default voice and logs a one-time warning (existing engine behavior).
- Engine returns `'cancelled'` (new order / reset / unmount mid-playback) → **stay silent**,
  no Web Speech (P1).
- Voice flag off → no audio, no warm-up.
- `parseKitchenOrderSequence` returns `null` (missing/placeholder `K----`, malformed, or
  >999) → skip the announcement entirely.

## 6. Testing

- **Unit (new):**
  - clip-sequence builder for `playOrderNumberAnnouncement` (input `N` → expected clip list).
  - `parseKitchenOrderSequence`: `K-001`→1, `K-042`→42, `K-999`→999, `K----`→null,
    `K-1000`→null, `''`/garbage→null.
  - tri-state `ClipPlayer.play`: resolves `'cancelled'` when `cancel()` is called
    mid-sequence; `'failed'` on a missing clip; `'played'` on success.
- **Unit (existing — must stay green, P3):** the engine refactor moves code these cover, so
  they are a required gate, not optional:
  - `tests/polish-amount-tts.test.ts`
  - `tests/polish-amount-tts-player.test.ts`
  (adjust for the tri-state return where they assert the boolean.)
- **Build:** **`npm run build`** must pass — both `build:main` (config schema + shared types)
  and `build:renderer`. (P2a — the earlier "renderer-only" claim was wrong.)
- **Manual on PC (blocking, P2b):** place a test self-order; confirm the Polish line is
  **audible** once on the done screen after a live submit (autoplay survived); confirm the
  Settings toggle silences it; confirm tapping "New order" mid-playback stops audio and does
  **not** trigger Web Speech. SSH cannot verify audio — this is a human release gate.

## 7. Out of scope (YAGNI)

- VI/EN voice, multi-language announcement.
- Replay button, repeated readout, chime.
- Announcing anything on the menu/review/terminal screens.
- Backend or order-number-format changes.
