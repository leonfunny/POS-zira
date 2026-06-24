# Kitchen Self-Order Display Redesign (Phase 2) Implementation Plan

> **For Codex workers:** REQUIRED SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Claude/Superpowers equivalent: `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the kitchen self-order kiosk into a warm, appetizing, editorial look (self-hosted serif+sans, warm tokens, themeable accent) — CSS-first, **zero behavior/layout-structure change**.

**Architecture:** Almost entirely `src/renderer/index.css` (self-hosted `@font-face` + a warm token block scoped to `.kso-shell` + restyled `kso-*` rules). `KitchenSelfOrderApp.tsx` gets only targeted `className` tweaks (serif headings, price affordance) — no logic, no markup restructure. The accent stays driven by `menu.brand.accentColor` (already inline on `.kso-shell`); warm neutrals are fixed.

**Tech Stack:** Electron 33 (Chromium ~modern → `color-mix` OK), React, Vite (resolves+fingerprints relative `url()` font assets in CSS), vitest. Repo: `C:\POS-zira`, branch off current `main`.

**Spec (source of truth):** `docs/KITCHEN_SELF_ORDER_DISPLAY_REDESIGN_DESIGN.md`. Visual reference: mockup `kitchen-kiosk-warm-editorial.html` (Desktop; if absent, spec governs).

## Global Constraints

- **Do NOT touch chesaigon.** Dev + test on `winpc` against `owner+salon-test-kuchnia@test.local`. **No production deploy.** Branch off **current `main`** (Phase 2a already merged at `d04c0c0`).
- **Aesthetic only — keep Phase 1/2a layout, flow, logic 100% intact.** **No behavior edits:** do not change `submitOrder`, `retryPrint`, `orderLockedForRetry`, `onStartOver`, modifier validation, cart math, QR/print IPC, menu filtering, or i18n keys. If a behavior line moves for markup cleanup, keep a before/after grep proof in the handoff.
- **Fonts self-hosted only:** files under `src/renderer/fonts/kso/`, `@font-face` in `index.css`. **No `fonts.googleapis.com`, `@import`, remote URL, or CDN.** SIL OFL license note in the font folder. **Verify PL+VI glyph coverage** — `ą ć ę ł ń ó ś ź ż` and `Đ đ ă â ê ô ơ ư` must render in both display and body roles.
- **Keep the layout contract / test-pinned values:** `grid-cols-[minmax(0,1fr)_320px]`, `kso-product-grid` (2/3/4-col breakpoints), `kso-product-media` (216px / 230px heights), `kso-product-card` heights (324px / 340px), `object-contain`. Card radius stays **~8px** (repo contract, not the mockup's larger radius); chips/pills may be fully rounded. Touch targets ≥ 44×44px, ≥ 8px apart.
- Baseline-diff discipline: no *new* full-suite failures vs the Task 0 baseline. Do not commit temp test logs.

---

## Task 0: Baseline (no code change)

- [ ] **Step 1: Record the test + visual baseline**

Run: `cd C:\POS-zira; npx vitest run 2>&1 | Tee-Object "$env:TEMP\pos-zira-phase2-baseline.txt"`
Record the exact pre-existing failing files and test count from this run. Do **not** rely on the old "same 5" shorthand; if the baseline changed, the after-run must be compared against the new explicit list. Open the running kiosk on `salon-test-kuchnia` and note the current "system-font + cool-grey" look for before/after comparison.

- [ ] **Step 2: Commit nothing (baseline is a reference only).**

---

## Task 1: Self-host the fonts (Fraunces + Plus Jakarta Sans)

**Files:**
- Create: `src/renderer/fonts/kso/` (woff2 files + `LICENSE-OFL.txt` + `SOURCE.txt`)
- Modify: `src/renderer/index.css` (add `@font-face` block at the top, before any rule)
- Test: `tests/kitchen-self-order-fonts.test.ts` (new, static)

**Interfaces:**
- Produces: CSS `font-family` families `Fraunces` (serif, weights 500/600/700) and `Plus Jakarta Sans` (sans, weights 500/600/700/800), loaded from `./fonts/kso/*.woff2`.

- [ ] **Step 1: Write the failing test**

Create `tests/kitchen-self-order-fonts.test.ts`:
```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/renderer/index.css', import.meta.url), 'utf8');
const fontDir = new URL('../src/renderer/fonts/kso/', import.meta.url);
const fontFiles = [
  'fraunces-500.woff2',
  'fraunces-600.woff2',
  'fraunces-700.woff2',
  'plus-jakarta-sans-500.woff2',
  'plus-jakarta-sans-600.woff2',
  'plus-jakarta-sans-700.woff2',
  'plus-jakarta-sans-800.woff2',
];

describe('kitchen kiosk fonts are self-hosted', () => {
  it('declares Fraunces and Plus Jakarta Sans via @font-face', () => {
    expect(css).toContain('@font-face');
    expect(css).toMatch(/font-family:\s*['"]Fraunces['"]/);
    expect(css).toMatch(/font-family:\s*['"]Plus Jakarta Sans['"]/);
  });
  it('loads fonts from local fonts/kso assets only — no CDN/@import/remote', () => {
    expect(css).toMatch(/url\(['"]?\.\/fonts\/kso\/[^)]+\.woff2/);
    expect(css).not.toContain('fonts.googleapis.com');
    expect(css).not.toContain('fonts.gstatic.com');
    expect(css).not.toMatch(/@import\s+url\(/);
    expect(css).not.toMatch(/url\(['"]?https?:/);
  });
  it('commits the referenced font binaries and license/source notes', () => {
    for (const file of fontFiles) {
      const url = new URL(file, fontDir);
      expect(existsSync(url), `${file} should exist`).toBe(true);
      expect(statSync(url).size, `${file} should be a real font file`).toBeGreaterThan(10_000);
      expect(css).toContain(`./fonts/kso/${file}`);
    }
    expect(existsSync(new URL('LICENSE-OFL.txt', fontDir))).toBe(true);
    expect(existsSync(new URL('SOURCE.txt', fontDir))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/kitchen-self-order-fonts.test.ts`
Expected: FAIL — no `@font-face` in `index.css` yet.

- [ ] **Step 3: Obtain the woff2 files (with Vietnamese subset)**

Get woff2 covering `latin`, `latin-ext`, **and `vietnamese`** subsets for each needed weight. Use a trusted build-time source only: temporary extraction from `@fontsource/fraunces` / `@fontsource/plus-jakarta-sans` packages is acceptable, and Google Fonts CSS2 download URLs are acceptable only as a source-fetch step. **Do not add runtime npm font imports, do not add font packages to app dependencies, and do not commit package/package-lock changes for font acquisition.** Copy the final files into `src/renderer/fonts/kso/`, e.g.:
```
fraunces-500.woff2  fraunces-600.woff2  fraunces-700.woff2
plus-jakarta-sans-500.woff2  -600.woff2  -700.woff2  -800.woff2
LICENSE-OFL.txt   (both fonts are SIL OFL)
SOURCE.txt        (source package/URL, version/date, exact copied files)
```
Prefer a single per-weight woff2 that includes the vietnamese glyphs (avoids unicode-range juggling). If the source only provides separate unicode-range subset files, either deliberately add the complete set of needed subset files and update the test list, or choose a different source; do **not** ship CSS references to missing subsets. Verify each file is woff2 and non-empty.

- [ ] **Step 4: Add `@font-face` at the top of `src/renderer/index.css`**

```css
/* Kitchen self-order kiosk fonts — self-hosted, offline (SIL OFL). PL + VI glyph coverage required. */
@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 500; font-display: swap; src: url('./fonts/kso/fraunces-500.woff2') format('woff2'); }
@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 600; font-display: swap; src: url('./fonts/kso/fraunces-600.woff2') format('woff2'); }
@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 700; font-display: swap; src: url('./fonts/kso/fraunces-700.woff2') format('woff2'); }
@font-face { font-family: 'Plus Jakarta Sans'; font-style: normal; font-weight: 500; font-display: swap; src: url('./fonts/kso/plus-jakarta-sans-500.woff2') format('woff2'); }
@font-face { font-family: 'Plus Jakarta Sans'; font-style: normal; font-weight: 600; font-display: swap; src: url('./fonts/kso/plus-jakarta-sans-600.woff2') format('woff2'); }
@font-face { font-family: 'Plus Jakarta Sans'; font-style: normal; font-weight: 700; font-display: swap; src: url('./fonts/kso/plus-jakarta-sans-700.woff2') format('woff2'); }
@font-face { font-family: 'Plus Jakarta Sans'; font-style: normal; font-weight: 800; font-display: swap; src: url('./fonts/kso/plus-jakarta-sans-800.woff2') format('woff2'); }
```

- [ ] **Step 5: Run test + build to verify**

Run: `npx vitest run tests/kitchen-self-order-fonts.test.ts` -> PASS.
Run: `npm run build:renderer` to confirm Vite resolves and fingerprints the font assets. For visual glyph smoke, run `npm run dev:renderer` or the kiosk app and confirm VI/PL sample text from the spec renders in both families with no tofu boxes.

- [ ] **Step 6: Commit**
```bash
git add src/renderer/fonts/kso src/renderer/index.css tests/kitchen-self-order-fonts.test.ts
git commit -m "feat(kitchen-kiosk): self-host Fraunces + Plus Jakarta Sans (offline, PL/VI coverage)"
```

---

## Task 2: Warm token block + typography base on `.kso-shell`

**Files:**
- Modify: `src/renderer/index.css` (expand `.kso-shell` tokens + set base font + serif utility)
- Test: `tests/kitchen-self-order-theme.test.ts` (new, static)

**Interfaces:**
- Produces tokens on `.kso-shell`: `--kso-canvas`, `--kso-surface`, `--kso-ink`, `--kso-muted`, `--kso-line`, `--kso-accent` (from config), `--kso-accent-deep`, `--kso-accent-soft`, `--kso-serif`, `--kso-sans`, `--kso-shadow`. A `.kso-serif` utility class.

- [ ] **Step 1: Write the failing test**

Create `tests/kitchen-self-order-theme.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/renderer/index.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx', import.meta.url), 'utf8');

describe('kitchen kiosk warm theme tokens', () => {
  it('defines warm tokens and derives accent shades from the brand accent', () => {
    expect(css).toContain('--kso-canvas');
    expect(css).toContain('--kso-surface');
    expect(css).toContain('--kso-serif');
    expect(css).toMatch(/--kso-accent-deep:\s*color-mix\(in srgb, var\(--kso-accent\)/);
    expect(css).toMatch(/--kso-accent-soft:\s*color-mix\(in srgb, var\(--kso-accent\)/);
    const shellBlock = css.match(/\.kso-shell\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(shellBlock).not.toContain('radial-gradient');
  });
  it('keeps the accent driven by brand config (inline --kso-accent), not hardcoded', () => {
    expect(app).toMatch(/--kso-accent['"]?\s*:\s*[^,]*brand[^,]*accentColor/);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/kitchen-self-order-theme.test.ts` → FAIL (tokens absent).

- [ ] **Step 3: Replace the `.kso-shell` block in `index.css`**

```css
.kso-shell {
  --kso-accent: #da7756;                       /* overridden inline from brand.accentColor */
  --kso-accent-deep: color-mix(in srgb, var(--kso-accent), black 22%);
  --kso-accent-soft: color-mix(in srgb, var(--kso-accent), white 84%);
  --kso-canvas: #f6efe6;                        /* warm cream — fixed, not brand-derived */
  --kso-surface: #fffdfa;
  --kso-ink: #2a231e;
  --kso-muted: #8a7e72;
  --kso-line: #e7ddcd;
  --kso-shadow: 0 10px 30px -12px rgba(120, 80, 50, 0.28);
  --kso-serif: 'Fraunces', Georgia, 'Times New Roman', serif;
  --kso-sans: 'Plus Jakarta Sans', 'Bahnschrift', system-ui, sans-serif;
  background: var(--kso-canvas);
  color: var(--kso-ink);
  font-family: var(--kso-sans);
}
.kso-serif { font-family: var(--kso-serif); }
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/kitchen-self-order-theme.test.ts` → PASS (the second test passes only after the JSX already carries `--kso-accent: ...brand...accentColor`, which it does today — confirm unchanged).

- [ ] **Step 5: Commit**
```bash
git add src/renderer/index.css tests/kitchen-self-order-theme.test.ts
git commit -m "feat(kitchen-kiosk): warm editorial token system on .kso-shell (themeable accent, fixed warm neutrals)"
```

---

## Task 3: Re-skin the components (CSS rules + targeted serif classNames)

**Files:**
- Modify: `src/renderer/index.css` (`kso-*` component rules: card, media, buttons; add chip/header/cart/price helpers)
- Modify: `src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx` (add `kso-serif` to brand name, product name, cart total, done order number, section headings; price affordance class — **no logic/structure change**)
- Test: extend `tests/kitchen-self-order.test.ts`. Do not touch self-checkout model tests for this display-only kitchen kiosk skin.

- [ ] **Step 1: Write the failing static test**

Add to `tests/kitchen-self-order.test.ts`:
```ts
  it('applies the warm-editorial skin without touching layout or Phase 2a behavior', () => {
    const appSource = readSource('src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx');
    const css = readSource('src/renderer/index.css');
    // serif display applied to brand/menu headings + order number
    expect(appSource).toContain('kso-serif');
    // layout contract preserved
    expect(appSource).toContain('grid-cols-[minmax(0,1fr)_320px]');
    expect(appSource).toContain('className="kso-product-grid"');
    expect(css).toContain('.kso-product-media');
    const productCardBlock = css.match(/\.kso-product-card\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(productCardBlock).toContain('height: 324px');
    expect(productCardBlock).toContain('border-radius: 8px');
    expect(css).toContain('.kso-product-card:focus-visible');
    expect(css).toContain('.kso-primary-button:focus-visible');
    // Phase 2a recovery affordances untouched
    expect(appSource).toContain('orderLockedForRetry');
    expect(appSource).toContain('kitchenSelfOrder?.retryPrint?.(');
    expect(appSource).toContain('onStartOver');
  });
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/kitchen-self-order.test.ts -t "warm-editorial skin"` → FAIL (`kso-serif` not yet in the app).

- [ ] **Step 3: Update the `kso-*` component CSS in `index.css`**

Swap `--sc-*` references inside the kiosk rules to the warm `--kso-*` tokens, keep all heights/grid/radius. Key rules:
```css
.kso-product-card {
  display: flex; height: 324px; min-width: 0; flex-direction: column; overflow: hidden;
  border: 1px solid var(--kso-line); border-radius: 8px; background: var(--kso-surface);
  text-align: left; box-shadow: var(--kso-shadow);
  transition: border-color 150ms ease, box-shadow 150ms ease, transform 120ms ease;
}
.kso-product-card:hover,
.kso-product-card:focus-visible { transform: translateY(-2px); border-color: var(--kso-accent); outline: none; }
.kso-product-card:active { transform: scale(0.99); border-color: var(--kso-accent); }
.kso-product-media { height: 216px; flex: 0 0 216px; background: var(--kso-accent-soft); }
.kso-primary-button { background: var(--kso-accent-deep); color: #fff; }
.kso-primary-button:focus-visible { outline: 3px solid var(--kso-accent-soft); outline-offset: 2px; }
.kso-secondary-button { border: 1px solid var(--kso-line); background: var(--kso-surface); color: var(--kso-ink); }
/* price pill + chip helpers */
.kso-price { font-weight: 800; color: var(--kso-ink); }
.kso-chip { border: 1px solid var(--kso-line); background: var(--kso-surface); color: var(--kso-ink); border-radius: 999px; }
.kso-chip[data-active="true"] { background: var(--kso-accent-soft); color: var(--kso-ink); border-color: var(--kso-accent); }
```
(Keep the `@media (min-width: 1280px/1600px)` blocks and the 230px/340px values exactly. Hover polish is allowed, but touchscreen/keyboard feedback must not rely on hover only. If a pale brand accent makes `accent-deep + #fff` fail visual contrast, deepen the derived token or switch filled controls to `accent-soft + ink` before committing; do not ship white text on low-contrast raw accent.)

- [ ] **Step 4: Apply serif + tokens in `KitchenSelfOrderApp.tsx` (className-only)**

- `BrandHeader`: add `kso-serif` to the brand name element; restyle eyebrow with `--kso-muted`.
- `CategoryButton`: render as `kso-chip` with `data-active`.
- `ProductCard`: add `kso-serif` to the product name (`h3`/name element); wrap price with `kso-price`; the existing `kso-product-media` keeps `object-contain`.
- `CartPanel`: cart total element gets `kso-serif`; primary CTA stays `kso-primary-button` (now accent-deep).
- Done screen: the big order-number element gets `kso-serif`.
- **Do not** alter any handler, `submitOrder`/`retryPrint`/`orderLockedForRetry`/`onStartOver`, the cart/menu data, or the grid/column structure.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/kitchen-self-order.test.ts` → PASS (new + existing layout tests green).
Run: `npm run typecheck:renderer` → 0.

- [ ] **Step 6: Commit**
```bash
git add src/renderer/index.css src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx tests/kitchen-self-order.test.ts
git commit -m "feat(kitchen-kiosk): warm-editorial re-skin of cards, chips, header, cart, done (no behavior/layout change)"
```

---

## Task 4: Full verification + visual QA

- [ ] **Step 1: Full suite vs baseline**
Run: `npx vitest run 2>&1 | Tee-Object "$env:TEMP\pos-zira-phase2-after.txt"`
Expected: failing files are a subset of the Task 0 baseline — **no new failures**. (Do not commit temp logs.)

- [ ] **Step 2: Typecheck** — `npm run typecheck:renderer` → 0.

- [ ] **Step 3: Behavior-untouched proof**
Run a diff of behavior anchors vs `main`: `git diff main -- src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx` and confirm no change to lines containing `submitOrder`, `retryPrint`, `orderLockedForRetry`, `onStartOver`, `electronAPI?.kitchenSelfOrder`, cart math, or the menu filter — only `className`/markup-presentation lines moved. Paste the anchor lines in the handoff.

- [ ] **Step 4: Manual visual QA on `salon-test-kuchnia` (record results)**
- Resolutions: **1366x768** and the actual kiosk resolution. No text overflow in product cards, modifier tiles, review rows, or buttons.
- All three languages (pl / vi / en) incl. long product/category names; VI + PL diacritics render in Fraunces and Plus Jakarta Sans (no tofu/fallback).
- A **non-default brand accent** (e.g. set `kitchenSelfOrderAccentColor` to a pale color) -> primary controls stay legible (accent-deep / soft+ink), UI is not a one-note beige.
- Touch/keyboard feedback is visible without hover: product cards, category chips, primary CTA, Retry, and Start over all have active/focus states and remain >= 44x44px with >= 8px spacing.
- **Offline** (disable network) -> fonts still render (self-hosted), no FOUT to a system font for normal copy.
- Menu / review / done / configurator all consistent; Phase 2a **Retry** + **Start over** still work and are styled.

- [ ] **Step 5: Record the verification summary in the handoff/PR only.**

Do not commit temp logs or a one-off verification note. Only update a repo doc if a durable implementation decision changes.

## Self-Review (spec coverage)
- §3 fonts self-hosted, no CDN, PL/VI coverage, license/source trace -> Task 1.
- §3 warm tokens, accent derive + contrast guard, no orbs, fixed neutrals -> Task 2 + Task 3.
- §3 radius ~8px, chips pill, touch targets, non-hover focus/active states -> Task 3 CSS + Task 4 visual QA.
- §4 components re-skin, no emoji/desc invented, keep layout hooks -> Task 3.
- §2/§6 no behavior edits -> Task 3 discipline + Task 4 Step 3 proof.
- §7 tests (local fonts, no @import, Phase 2a affordances, visual QA 1366x768 + kiosk) -> Tasks 1, 2, 3 + Task 4.
- §8 branch off current main, no chesaigon/deploy -> Global Constraints.
