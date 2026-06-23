# Kitchen Self-Order Display Redesign (Phase 2) — Design

Status: approved design (mockup signed off), not yet implemented
Date: 2026-06-23
Repo: **POS-zira** desktop app (Electron) — renderer only, no backend.
Related: `KITCHEN_SELF_ORDER_KIOSK_RESTRUCTURE_DESIGN.md` (Phase 1), `KITCHEN_SELF_ORDER_PRINT_RETRY_FIX.md` (Phase 2a).
Visual source of truth: approved mockup `kitchen-kiosk-warm-editorial.html` (warm appetizing editorial).
Implementation source of truth: this document. If the mockup file is not present in the repo/worktree, do not block implementation; use the tokens and constraints below.

> **Scope guard:** forward feature, **do NOT touch chesaigon** (POS tab only). Dev + test on `winpc` against test salon `owner+salon-test-kuchnia@test.local`. No production deploy. **Aesthetic polish only** — keep the Phase 1/2a layout, flow, and logic 100% intact.

---

## 1. Goal

Re-skin the kitchen self-order kiosk (`src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx` + `src/renderer/index.css`) into a **warm, appetizing, editorial** look — from "clean SaaS" to "premium food kiosk" — **without changing any layout structure, flow, IPC, or data**. Owner directive: *"đang khá ổn, chỉ cần chuốt lại UX UI."* Approved direction: the mockup above.

## 2. Non-goals

- **No** layout/flow restructure (two-column menu + cart, category chips, product grid, modifier modal, review/terminal/done steps all stay).
- **No** change to Phase 1 (`kitchen_print` / `menuSource`), Phase 2a (retry/Start-over), submit/print IPC, cart logic, i18n keys, or scanner/voice behavior.
- **No** new screens, no backend, no new dependencies beyond bundled fonts.

## 3. Design system (warm-editorial tokens)

Replace the current cool/neutral `--sc-*` palette usage in the kiosk with a warm token set (extend, don't break other windows that share `--sc-*`). Scope new tokens under the kiosk shell (`.kso-shell`) so only this window changes. `DESIGN.md` remains authoritative for cashier/operator POS screens; this document is a narrow customer-kiosk exception.

**Color (CSS vars on `.kso-shell`):**
- `--kso-canvas: #F6EFE6` (warm cream). Do **not** add discrete gradient orbs/blobs; if depth is needed, use a very subtle full-surface linear warmth/noise-free gradient that cannot read as an orb.
- `--kso-surface: #FFFDFA`, `--kso-ink: #2A231E` (warm near-black), `--kso-muted: #8A7E72`, `--kso-line: #E7DDCD`.
- `--kso-accent` (**themeable — driven by `kitchenSelfOrderAccentColor`, default `#DA7756`**); derive `--kso-accent-deep` / `--kso-accent-soft` via `color-mix(in srgb, var(--kso-accent), black 22%)` and `... white 84%`. Warm neutrals stay fixed (food-warm); only the accent follows the brand.
- Avoid a one-note beige/cream UI: product imagery, ink, border hierarchy, and brand accent must create clear contrast. The fixed warm neutral canvas is intentional; do **not** derive the whole warmth from brand color.
- Do not place white text directly on arbitrary raw `--kso-accent` unless contrast is verified. Prefer `--kso-accent-deep` for filled primary controls, or `--kso-accent-soft` with `--kso-ink` text for pale/light brand accents.
- Soft, warm shadows: `0 10px 30px -12px rgba(120,80,50,.28)`.

**Typography (self-hosted, NOT CDN — kiosk must work offline):**
- Display serif **Fraunces** (SIL OFL) → brand name, product names, cart total, the big done-screen order number, section headings.
- Body sans **Plus Jakarta Sans** (SIL OFL) → labels, descriptions, prices, buttons, chips. (Satisfies the "no Inter/Roboto/Arial/system" guideline.)
- Bundle both as local `woff2` under `src/renderer/fonts/kso/` + `@font-face` in `index.css`. **No `fonts.googleapis.com`, `@import`, remote URL, or CDN at runtime.**
- Add/keep license/source notes for the font files in the same font folder (SIL OFL). Use only the weights/styles actually needed by the kiosk to avoid bloating the renderer bundle.
- Verify Polish + Vietnamese glyph coverage before committing typography: `ą ć ę ł ń ó ś ź ż` and `Đ đ ă â ê ô ơ ư` must render in both display/body roles. If a font subset lacks these glyphs, replace the subset; do not rely on silent system fallback for normal kiosk copy.
- Font fallback stacks are allowed only as a last-resort browser fallback after the bundled families; the primary rendered fonts must be local/offline.

**Shape/spacing:** keep cards/panels aligned with repo operational geometry (8px radius target; media/logo tiles may use slightly more if already local style supports it). Chips/pills may be fully rounded. Touch targets must stay at least 44x44px with at least 8px between adjacent controls.

## 4. Components to re-skin (same JSX structure, new classes/styles)

- **BrandHeader** — logo tile (accent treatment) + brand name in Fraunces + a small localized kiosk eyebrow; keep `menu?.brand.name/logoUrl`.
- **CategoryButton (chips)** — rounded pill, warm surface + line, active = accent-aware state. Do **not** invent emoji/category icons; current menu category model has no icon field. Add an icon slot only if backend/menu data later exposes one.
- **FulfillmentToggle / LanguageToggle** — segmented, warm surface, active = ink (fulfillment) / accent-soft (language).
- **ProductCard** — warm-tinted media area (keep `object-contain` image when present), serif name, bold price + accent "+" affordance, subtle active/touch feedback. Do not invent product descriptions; current kitchen menu product model has no description field. Keep `kso-product-grid` / `kso-product-media` hooks the tests rely on.
- **CartPanel / CartLine / QuantityControl** — warm card, thumbnail per line, serif total, restyled existing CTA copy (`t.placeOrder` / `t.retry`). Do not add new submit wording unless the i18n table is intentionally updated and tested.
- **ReviewScreen / terminal / done** — same vocabulary; done-screen order number in big Fraunces on an ink chip. **Keep Phase 2a's Retry + Start-over buttons** (only restyle, do not remove/relogic).
- **ProductConfigurator (modifier modal)** — warm surface, serif group titles, accent selection states.

## 5. Theming & i18n constraints

- `--kso-accent` reads from `kitchenSelfOrderAccentColor` (already wired into `.kso-shell` via `themeStyle`); the redesign must keep deriving deep/soft so any brand accent looks intentional (mockup shows terracotta/matcha/berry/blue).
- Text lengths differ across pl/vi/en — serif headings must wrap/`line-clamp` gracefully, never overflow the card/cart. Verify all three languages plus long product/category names.
- Logo: use `menu.brand.logoUrl` when set, else the accent letter tile.

## 6. Implementation approach

- **CSS-first:** most of the change lives in `index.css` (token block on `.kso-shell` + `kso-*` component styles + `@font-face`). JSX changes in `KitchenSelfOrderApp.tsx` are targeted `className`/small-markup tweaks (serif headings, price affordance, CTA styling), **not** structural rewrites.
- **Keep the layout contract:** preserve `grid-cols-[minmax(0,1fr)_320px]`, `kso-product-grid`, `kso-product-media`, responsive 3/4-col breakpoints, `object-contain`. If a redesign detail changes a test-pinned value, update that test deliberately in the same commit (don't silently break the baseline).
- **Fonts task is self-contained:** add woff2 + @font-face first, verify they load offline, before applying typography.
- **No behavior edits:** do not change `submitOrder`, `retryPrint`, `orderLockedForRetry`, `onStartOver`, modifier validation, QR/print IPC, menu filtering, or cart math. If a behavior line must move for markup cleanup, keep a before/after grep proof in the implementation handoff.

## 7. Testing

- Keep the existing `kitchen-self-order` layout/static tests green; update deliberately where a pinned class/value changes, asserting the new structure.
- Add static assertions: `@font-face` for Fraunces + Plus Jakarta Sans present in `index.css`, no `fonts.googleapis.com` reference in the kiosk window/CSS (offline guarantee), `--kso-accent` still derives from config.
- Add static assertions that the font URLs point at local `src/renderer/fonts/kso/*.woff2` assets and no `@import url(` appears in the kiosk CSS path.
- Add/keep static assertions for Phase 2a recovery affordances: `orderLockedForRetry`, `retryPrint`, and `onStartOver` still exist after restyling.
- Visual QA must include 1366x768 and the target kiosk resolution used on `salon-test-kuchnia`; no text may overflow product cards, modifier option tiles, review rows, or primary/secondary buttons.
- Baseline-diff discipline: no *new* full-suite failures vs baseline.
- **Manual visual smoke on `salon-test-kuchnia`:** menu / review / done / configurator; all three languages (pl/vi/en) with long names; a non-default brand accent; offline (no-network) load of fonts; touch targets.

## 8. Rollout constraints

- **Do NOT** build into or release onto chesaigon. Dev + test on `winpc` / `salon-test-kuchnia`. No production deploy.
- Phase 2a is already merged to `main` (`d04c0c0`). Branch this work from current `main`; do not branch from pre-Phase-2a history.
- Pure renderer/CSS; no backend, no migration.
