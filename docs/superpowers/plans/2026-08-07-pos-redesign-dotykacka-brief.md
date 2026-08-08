# POS Cashier UI Redesign — Dotykačka visual language

> **Status:** DRAFT — measured constraints section is final; visual direction and file map land after research.
> **Date:** 2026-08-07
> **Owner directive:** Paul — "tôi cần làm giống dotykacka".

---

## 0. Hard device facts — MEASURED, not assumed

Every number below was measured on the real target device (SUNMI `D2s_LITE_d_2nd_STGL`, Tailscale `100.92.1.41`) by evaluating JS inside the live WebView over CDP on 2026-08-07. Do not re-derive these; do not design against different numbers.

### 0.1 The canvas

| Property | Value |
|---|---|
| Physical screen | 1920 × 1080 |
| Physical density | 230 dpi |
| **CSS viewport** | **1336 × 736 px** |
| devicePixelRatio | 1.4375 |
| Orientation | landscape-primary (fixed) |

**The design canvas is 1336 × 736 CSS px.** Height is the scarce resource, not width. The Android shell already spends part of it on chrome (storage banner when at risk + POS/Bi-a tab bar), so the cashier screen gets roughly **1336 × 660–700**. Any design that assumes ~900px of height will push the pay button below the fold.

### 0.2 The rendering engine — Chromium 83

The device's WebView is `com.android.webview` **83.0.4103.120** and **cannot be updated**: the system's provider allowlist contains only that one AOSP package, `com.google.android.webview` is not installed, and the on-device Chrome is 56.0.2924.87 with targetSdk 25 (below the required 30), so it cannot serve as a provider either. Treat Chromium 83 as a permanent constraint for this hardware.

Feature probe run in that WebView:

| Feature | Supported | Consequence |
|---|---|---|
| `gap` in **flexbox** | ❌ **NO** | measured 0px where 40px was asked |
| `gap` in **CSS Grid** | ✅ **YES** | measured exactly 40px |
| `margin` spacing | ✅ YES | measured exactly 40px |
| `aspect-ratio` | ❌ NO | tiles collapse / take wrong height |
| `inset:` shorthand | ❌ NO | absolutely-positioned overlays land wrong |
| `:where()` / `:is()` | ❌ NO | **the entire CSS rule is discarded**, not just the selector |
| `backdrop-filter` | ✅ YES | blur/scrim effects are safe |

### 0.3 The rule this produces

> **Use CSS Grid for anything that needs spacing. Never rely on `gap` inside a flex container.**

This is the single most important authoring rule in this redesign, and it is cheap: `grid` + `gap-*` is fully supported, so the new components can be written with modern, readable Tailwind and still render correctly on the old engine. There is no need to litter the code with margin hacks.

Concretely, for every container in the new design:

- **Needs spacing between children** → `grid` (`grid grid-flow-col`, `grid-cols-*`, `grid-flow-row`) + `gap-*`. ✅
- **Needs flex behaviour** (`flex-1`, `items-center`, `justify-between`, wrapping toolbars) **and** spacing → use `flex` for the alignment but space the children with `space-x-*` / `space-y-*` (margin-based) or explicit margins, **not** `gap-*`.
- **Never** `flex ... gap-*`. A reviewer should treat that combination as a defect.
- **Never** `aspect-*` — set explicit heights, or use the padding-top percentage trick.
- **Never** `inset-0` shorthand alone — write `top-0 right-0 bottom-0 left-0`. (Tailwind's `inset-0` compiles to the shorthand; check the built CSS.)
- **Never** author raw CSS containing `:where()` or `:is()`. Tailwind 3.4 emits `:where()` in a handful of places — those rules are silently dead on this device; if one of them matters, restate it without `:where()`.

### 0.4 A guard so this cannot regress

The rule above is invisible at review time and will rot. The redesign must ship with an automated check, in the same spirit as the existing cross-platform boundary verifier:

- A script that scans the built Android CSS (`dist/android-web/assets/*.css`) and the renderer sources for the forbidden combinations, and fails the build. At minimum: any class list containing both a flex display utility and a `gap-*` utility on the same element, plus any occurrence of `:where(`, `:is(`, `aspect-ratio`, or `inset:` in the emitted CSS.
- Wire it next to `npm run test:android:boundaries:source` so it runs in the same gate.

Current debt for reference: the existing renderer has **1195 `gap-*` usages across 145 files**, of which **426** are in the POS + billiard screens the Android app actually shows. The redesign is the natural moment to retire that debt in the screens being rewritten; files outside the redesign scope keep their debt until touched.

---

## 1. What is being redesigned, and on which platforms

The cashier UI is **shared code**. `src/renderer/components/pos/POSLayout.tsx` (2060 lines) is rendered by both the Windows POS window (`<POSLayout />`) and the Android shell (`<POSLayout embedded … />`). Even the Vietnamese-without-diacritics labels "Ban hang" / "Lich tho" that look like an Android quirk are hardcoded in the shared `SalonTemplate.tsx` — Windows shows them too.

**Therefore: a redesign of the cashier screen changes Windows and Android simultaneously.**

### Decision D1 — RESOLVED (Paul, 2026-08-07): convert BOTH platforms

> "Chuyển cả 2 về giống dotykacka."

Both the Windows POS window and the Android app adopt the Dotykačka visual language in the same change. No feature flag, no per-platform fork of the cashier screen — the shared components are redesigned once and both hosts get the new look. This keeps `POSLayout` and the templates single-source, which is the property that made the Android port cheap in the first place; forking them would quietly double the maintenance cost of every future POS change.

The consequence to plan for: **the redesign ships to live salon counters on Windows at the same time as to tablets.** Rollout therefore needs the Windows lane treated as a production release, not as a side effect of an Android packet.

### 1.1 The responsive range this forces

Because one component tree serves both hosts, it must hold up across a genuinely awkward range — Windows is narrow-and-tall, Android is wide-and-short:

| Host | Size | Notes |
|---|---|---|
| Windows POS window — minimum | **800 × 600** | `minWidth`/`minHeight` in `src/main/windows/window-manager.ts:67-68`. The layout must not break here. |
| Windows POS window — default | **1024 × 768** | `window-manager.ts:65-66`. The most common real Windows size. |
| **Android SUNMI** | **1336 × 736** | Fixed landscape. Wider than Windows default, but ~30px shorter than 768. |
| Windows maximised | up to 1920 × 1080 | Common on newer counters. Design must not just stretch into emptiness. |

Two anchor points to design against explicitly: **1024 × 768** and **1336 × 736**. A layout tuned only for the wide Android canvas will crowd at 1024; one tuned only for 1024 will waste the Android width. The 800 × 600 floor is the stress case — decide there whether the cart panel collapses, narrows, or overlays.

### 1.2 Engine floor is set by Android, not Windows

Windows runs Electron `^33.2.1` (Chromium ~130) and supports everything. Android is pinned at Chromium 83. Since the code is shared, **Chromium 83 is the compatibility floor for both** — all of §0.3 applies to the Windows build too, even though Windows would tolerate more. Authors must not "fix" a layout using flex `gap` because it looks right on their Windows dev machine.

---

## 2. Current state — measured inventory

### 2.1 A second reason the two platforms already look different: the typeface

There is **no webfont on the cashier screen**. `tailwind.config.js` sets `fontFamily.sans` to `"Bahnschrift", "Segoe UI Variable Text", "Segoe UI", Tahoma, sans-serif` and `index.css:218-220` repeats it on `body`.

**Every one of those faces is Windows-only.** On the Android WebView they all miss and the text falls through to the generic `sans-serif` — Roboto/Noto. Bahnschrift is a condensed, technical grotesque; Roboto is wider and rounder. So the same markup renders with different letterforms, different widths, and therefore different line wrapping and button sizes on the two platforms, before any layout bug is considered.

**The redesign must ship a self-hosted webfont** so both platforms render identically. The repo already proves the pattern: `index.css:6-173` self-hosts Fraunces + Plus Jakarta Sans as 21 `@font-face` blocks for the kitchen self-order kiosk, scoped behind `.kso-shell`. Copy that mechanism for the POS, but apply it globally rather than scoped.

### 2.2 What actually breaks on Chromium 83, by count

Measured across `components/pos/**` + `components/billiard/**`:

| Pattern | Count | Verdict |
|---|---|---|
| `flex … gap-*` on one element | **343** | ❌ collapses to 0 spacing on the tablet |
| `grid … gap-*` | 75 | ✅ safe |
| `aspect-*` | **14** | ❌ all at risk (needs Chromium 88) |
| `inset-0` | 40 | ✅ safe (Tailwind emits longhand for `inset-0`) |
| `divide-*` | 10 | ✅ safe |
| `space-x/y-*` | 66 | ✅ safe |

So the cashier-path debt is **343 flex-gap sites, not the 1195 repo-wide figure** quoted earlier. The worst offenders: `OrderHistoryModal` 50, `PaymentModal` 35, `POSLayout` 20, `Cart` 19, `SalonTemplate` 16, `RetailTemplate` 10, `CartItem` 10.

The 14 `aspect-*` sites matter more than their count suggests — they include the **product image well** (`ProductCard.tsx:180` `aspect-[3/2]`), the retail category tiles (`RetailTemplate.tsx:1434` `aspect-[4/3]`) and the salon service cards (`SalonTemplate.tsx:817`). On the tablet these have no intrinsic height, which is a large part of why the grid looks wrong.

**Latent JS risk to verify before shipping:** there is no `browserslist` in `package.json` and no `build.target` in `vite.android.config.ts`, so Vite's default target is `modules` (≈ Chrome 87) — *above* the Chromium 83 floor. The app does boot today, so nothing fatal is emitted, but the redesign should pin `build.target` explicitly (e.g. `chrome83`) so a future dependency cannot silently ship syntax the tablet cannot parse.

### 2.3 The salon screen does not use the shared cart or product card

This is the single most important structural fact for scoping, and it is easy to get wrong.

`posMode` for the live salon (`queen`) is **`salon`**, which renders `templates/salon/SalonTemplate.tsx`. That template has its **own hand-rolled cart** (`SalonTemplate.tsx:860-1020`) and its **own bespoke service cards** (`SalonTemplate.tsx:802-830`). It does **not** import `Cart.tsx`, `CartItem.tsx`, or `ProductCard.tsx`.

Consequence: **redesigning `Cart.tsx` and `ProductCard.tsx` alone would not change what the salon actually sees.** Retail and salon must both be redesigned, or the redesign must first unify them onto shared components. That choice is Decision D2 below.

### 2.4 Palette and type tokens as they stand

- `tailwind.config.js` is the only palette source: `brand.50–900` centred on **`#da7756`** (warm terracotta, `brand-600 = #c5684a`), and **`slate` is overridden** to a warm sand/greige ramp (`50 #faf9f7` → `900 #1a1915`). So today's app is already warm-neutral, not blue-grey — worth knowing before declaring a new palette.
- Colour usage in the cashier path: slate 1790, white 491, brand 434, red 326, amber 290, emerald 228, blue 70. Blue appears essentially only in the billiard hand-off banner and the Android tab bar.
- Radius: `rounded-lg` (8px) 375 uses, `rounded-md` (6px) 162 — the de-facto system.
- **Three competing "primary button" treatments** exist: `shared/Button.tsx` primary (`bg-brand-600`), the Cart PAY button (`bg-slate-950`, near-black, `Cart.tsx:1045`), and the PaymentModal complete button (`bg-brand-600`, `PaymentModal.tsx:2163`). The redesign must collapse these to one.
- **`DESIGN.md`** (28 lines) already states a written direction — "IBM-like operational light interface", 6–8px radius, subtle shadows, ≥44px touch targets, explicit *Avoid* list (no gradients, no glassmorphism, no dark cinematic surfaces, no bento). A Dotykačka-style redesign must either reconcile with this file or explicitly supersede it; leaving both in the repo guarantees future drift.

### 2.5 There is no theming system to hang a new look on

No `data-theme`, no `ThemeProvider`, no CSS-variable-driven Tailwind anywhere in `src/renderer`. `tailwind.config.js` hard-codes hex values. `index.css:175-201` *does* define a `:root` token vocabulary (`--primary`, `--sand-*`, `--ink`, …) but it is **disconnected from Tailwind and unused by every POS component**.

The redesign should close that gap: make the Tailwind palette read from CSS variables, and adopt the existing `.kso-shell` class-scoped pattern (`index.css:401-419`) as the model. This is also what any future eNail-vs-Zira brand switch would need.

### 2.6 Dead code the redesign can ignore or delete

Zero importers: `pos/HoldOrdersModal.tsx`, `pos/ShortcutsOverlay.tsx`, `pos/QuickKeys.tsx`, `pos/QuickKeysLayoutManager.tsx`, `billiard/SessionHistory.tsx`, `billiard/DailyReport.tsx`, `billiard/KitchenDisplay.tsx`, `billiard/StockManager.tsx`, `billiard/HappyHourConfig.tsx`, `billiard/SessionDetailModal.tsx`. Do not spend redesign effort on these; propose deletion in a separate cleanup commit.

Also stale: `templates/b2b/**` and `templates/restaurant/**` still carry a pre-redesign **dark** palette and reference `bg-slate-850`, a class that does not exist in the config and is therefore a silent no-op (`B2BTemplate.tsx:220`, `RestaurantTemplate.tsx:282`). They are Windows-only (Android allows only `retail`/`salon`), so they can be handled in a later pass.

---

## 3. Decision D2 — unify salon + retail, or redesign both separately?

**Option A — redesign both templates in place.** Retail and salon each get the new visual language, keeping their separate carts and card components.
- Faster to start; no behavioural risk to the salon flow.
- Locks in the duplication permanently: two carts, two card styles, every future change done twice.

**Option B — unify first, then redesign once.** Move `SalonTemplate` onto the shared `Cart`/`CartItem` and a shared product-card primitive, then apply the new design to the shared components.
- One implementation, one set of Chromium-83 fixes, one place to change later.
- Higher risk: the salon cart has salon-specific behaviour (staff assignment per line, turn board) that must survive the move; needs its own test pass.

**Recommendation: Option B, staged.** Do the unification as its own reviewed change with the current look intact, verify the salon flow is unchanged, and only then apply the new design to the shared components. That keeps the risky refactor and the visual change in separate, separately-revertable commits — the same discipline that made the 2026-08-06 packet wave safe.

---

## 4. The Dotykačka visual language — observed, not remembered

Evidence base: official manual screenshots downloaded and **pixel-sampled**, plus the Dotypos 2018 Corporate Identity PDF. A 2026 marketing render shows the same layout and palette, so this is current, not historical. Sources are listed in §11.

### 4.1 The seven traits that make it recognisable

1. **Zero corner radius. Flat colour rectangles. No shadows, no gradients, no borders.** Tiles are butted together with a uniform ~6–8px gutter. This is the single most identifying trait.
2. **Colour is the identifier, never imagery.** There is **no product photo anywhere**, and the display-settings screen has no image toggle — strong negative evidence, not an oversight. Merchants memorise colour and position.
3. **Green category bar with white-underlined UPPERCASE tabs.**
4. **The top bar changes colour per screen** — green on sale, dark blue on history, brown on cash payment, green on the table map.
5. **The left pane swaps** between a coloured launcher grid (cart empty) and the receipt (cart has items). There is no permanently visible empty cart.
6. **Two-tier colour system:** stock Material 500/700 for *function* tiles, merchant-chosen colour for *product* tiles, with label text auto-flipping black/white for contrast.
7. **The table map is the one dark surface in the app** — `#212E32` with furniture pictograms and per-table minute counters.

### 4.2 Layout skeleton (landscape tablet)

```
┌──────────────────────────┬──────────────────────────────────────────────┐
│ LEFT PANE  ~37%  white   │ RIGHT PANE  ~63%                             │
│ ┌──────────────────────┐ │ ┌──[green bar #2BA037]───────────────────┐   │
│ │ ☰   user name    ☁  │ │ │ [⠿kbd] [★] CATEGORY  CATEGORY  CATEGORY│   │
│ └──────────────────────┘ │ │              ‾‾‾‾‾‾‾‾ (white underline) │   │
│                          │ └────────────────────────────────────────┘   │
│  EITHER launcher tiles   │  product grid on #E8E8E8                     │
│  (4 cols, Material       │  ┌────────┬────────┬────────┬────────┐       │
│   colours, UPPERCASE)    │  │name    │name    │name    │name    │       │
│  OR receipt lines        │  │        │        │        │        │       │
│                          │  │   price│   price│   price│   price│       │
│  ┌──────────────────────┐│  └────────┴────────┴────────┴────────┘       │
│  │Sleva│Daň│Celkem(grn)││  ┌──[white action bar]─────────────────────┐  │
│  └──────────────────────┘│  │🔍Hledat ⠿ 🖨            Vystavit účet │  │
└──────────────────────────┴──┴────────────────────────────────────────┴──┘
```

### 4.3 Measured palette

| Role | Hex | Evidence |
|---|---|---|
| Brand green (Pantone 361) | `#43B02A` | CI PDF + most-used hex on dotypos.com |
| Sale-screen category bar | `#2BA037` | pixel-sampled, stable 2017→2022 |
| Dark green status bar | `#1A6021` | pixel-sampled |
| Table-map top bar | `#4CAF50` | Material Green 500 |
| Product-grid canvas | `#E8E8E8` / `#F5F5F5` | pixel-sampled — **light, not dark** |
| Panes and bars | `#FFFFFF` | |
| History top bar | `#0D3C61` | contextual colour |
| Cash payment header + confirm | `#795548` | Material Brown 500 = the cash method's colour |
| Table map canvas | `#212E32` | the only dark surface |
| Table occupied / free / reserved | `#F44336` / grey / purple `#961CAB` badge | |

Function tiles use stock Material 500/700: Blue `#2196F3`, Blue Grey `#607D8B`, Teal `#009688`, Brown `#795548`, Grey `#757575`, Orange `#FF9800`, Purple `#9C27B0`, Red `#D32F2F`, Pink `#E91E63`.

**Nuance worth copying:** the payment confirm button is **not** a fixed green — it takes the colour of the selected payment method (brown for cash). Only `Vystavit účet` and generic confirms are green.

### 4.4 Typography

- Brand face is **Gotham** (CI PDF, Thin/Regular/Black; Arial as the specified fallback). The **in-app** face is a neo-grotesque consistent with **Roboto** — flagged as inference, not observed fact.
- **Case is a load-bearing rule**: UPPERCASE for category tabs, function-tile labels, toolbar text actions and the primary confirm. **Sentence case** for product names, cart lines and drawer items. Getting this wrong is the fastest way to look "not quite Dotykačka".
- Two weights only: regular for names, semibold/bold for prices and totals. No light weights.
- Tile font size auto-shrinks to fit the product name (a documented merchant setting).

### 4.5 Component anatomy

**Product tile** — hard rectangle, no radius, landscape ≈ 4:2.2. Product name **top-left**, wraps to 2 lines then ellipsis. Price **bottom-right**, bold, with currency. Optional small badge bottom-left. Grid left-aligns and does **not** stretch a partial last row. Column count is a merchant setting (`Automaticky` picks 4–6).

**Cart line** — name bold black left; modifiers/EAN small grey beneath; **quantity in green** on the right; price bold far right; unit price small grey below. **Tapping a line expands it inline** to reveal flat square trash / edit / takeaway buttons and a `−`/`+` stepper. Quantity is never edited in a modal.

**Cart footer** — grey summary strip `Sleva | Daň | Celkem`, with *Celkem* label and value in green and the largest type in the pane. Three round FABs bottom-left: green (park), blue (split), purple (more).

**Payment dialog** — full-screen two-pane. Left = the account. Right = method-coloured header, a three-column summary `K platbě / Zaplaceno / Zbývá` with **Zbývá in red**, keypad, and a full-width method-coloured confirm with the icon above the label.

**Table map** — dark `#212E32` canvas with a dotted grid; tables drawn as rounded bodies with **chair stubs**; grey minute badge per table; zoom pill bottom-left; room tabs bottom-right.

---

## 5. Decisions this forces on us — Dotykačka is not our app

Copying the look wholesale would break things our POS does that Dotykačka does not. Four decisions need Paul's answer; my recommendation is given for each.

### D3 — Do we take their **green**, or their **system** with our colour? ⚠️ needs a decision

Our brand is terracotta `#da7756`; theirs is green `#43B02A`.

- **Option A — adopt their green literally.** Maximum resemblance. But it makes our product visually a Dotykačka clone in the same CZ/SK/PL market where they operate, which is a passing-off risk and throws away the Zira/eNail brand.
- **Option B — adopt their *system*, keep our colour.** Zero radius, flat colour blocks, uppercase rules, two-tier colour, contextual top bars, colour-coded tiles — all of it — but the primary hue stays terracotta and the Material function palette stays as-is.

**Recommendation: B.** Everything that makes Dotykačka *feel* like Dotykačka is structural, not the specific green. B gets the recognisable operator experience without the legal and brand cost. If Paul wants A, say so explicitly and I will switch the token and nothing else changes.

### D4 — Product images: remove them?

Dotykačka has none, by design. We have them in retail (`ProductCard`) and salon (service cards).

**Recommendation: make images a per-salon setting, default OFF for retail, default ON for salon services.** A nail salon genuinely benefits from service photos; a grocery does not. This also **deletes the `aspect-ratio` bug class entirely** for retail — the 14 broken `aspect-*` sites are mostly image wells, and a colour-block tile needs no intrinsic ratio.

### D5 — Does the cart swap with a launcher grid?

Theirs swaps; ours is permanently visible.

**Recommendation: keep our permanent cart.** The swap is a behaviour change that retrains every cashier, and our cart carries state (billiard hand-off, restored-cart notices, shift warnings) that must stay visible. Adopt the *look* of their cart, not its disappearing act. Put the launcher tiles behind the existing overflow menu instead.

### D6 — Where does the primary action live?

Theirs (`Vystavit účet`) sits bottom-right of the **product** pane, diagonally opposite the cart. Ours is the PAY button at the bottom of the cart.

**Recommendation: keep ours in the cart.** It is beside the total the cashier just read, and moving it is muscle-memory churn with no benefit. This is the one place I would deliberately not copy them.

### D7 — Our billiard floor vs their table map

Their map is dark `#212E32` with chair-stub pictograms and per-table minute badges. Our `BilliardFloorPlan` already has a felt surface with a user-toggled theme.

**Recommendation: adopt the minute badge and the red/grey/green status colours** (genuinely useful, and we already track session duration), keep our felt surface. Do not repaint the floor to `#212E32` — our billiard identity is already established and users have a theme toggle.

### 5.1 A happy convergence worth stating

Dotykačka's flat, zero-radius, image-free aesthetic is **exactly what a Chromium 83 device renders reliably**. No `aspect-ratio` (tiles get explicit heights), no shadows to soften, no rounded overlapping surfaces. Adopting this direction removes most of the §0.2 hazard class as a side effect rather than requiring a separate compatibility pass. The design the client asked for happens to be the design the hardware wants.

---

## 6. Token system for the new look

Derived from §4, adjusted by D3 (our colour) and D4.

**Colour** — six named tokens, wired as CSS variables so a brand switch is one file (§2.5):

| Token | Value (Option B) | Use |
|---|---|---|
| `--pos-primary` | `#c5684a` (brand-600) | category bar, active tab, totals, primary confirm |
| `--pos-primary-dark` | `#a8543a` | status/top-bar dark variant |
| `--pos-canvas` | `#E8E8E8` | product-grid background |
| `--pos-surface` | `#FFFFFF` | panes, bars, cart |
| `--pos-ink` | `#1a1915` (slate-900) | primary text |
| `--pos-ink-muted` | `#6b6a63` | unit prices, EAN, secondary |

Function-tile palette stays stock Material 500/700 exactly as observed — it is a deliberate two-tier system, not a brand surface.

**Type** — two roles, both self-hosted so Windows and Android match (§2.1):
- **UI/body:** Inter or Roboto, self-hosted `.woff2`, weights 400 + 600 only.
- **Numerals:** the same family with `font-variant-numeric: tabular-nums` on every price, quantity and total, so columns align — a POS-specific requirement Dotykačka gets for free from Roboto.
- Case rules from §4.4 are **normative**, not stylistic.

**Geometry** — `border-radius: 0` everywhere on the cashier surface; 6–8px gutters; no `box-shadow` except the existing cart-lip hairline; `1px` hairline dividers instead of shadows.

**Layout** — every spaced container is `grid` (§0.3). Panes: left cart `37%` on ≥1280px, fixed `320px` at 1024×768, and at the 800×600 floor the cart collapses to a bottom summary bar with a `Show cart` toggle.

**Signature** — the one memorable element: **the colour-block tile wall**, where every product and function is a flat rectangle of merchant-chosen colour with the name top-left and the price bottom-right, and the grid never stretches to fill.

---

## 7. File impact map

**Create**
- `src/renderer/styles/pos-tokens.css` — the `--pos-*` variables from §6, plus `@font-face` blocks for the self-hosted UI face.
- `src/renderer/fonts/pos/*.woff2` — the self-hosted family (400 + 600, latin + latin-ext + vietnamese subsets; the repo already ships subsetted fonts for the kiosk).
- `src/renderer/components/pos/primitives/Tile.tsx` — the flat colour-block tile used by products, categories and function launchers. One component, three consumers.
- `scripts/verify-css-baseline.mjs` — the Chromium-83 guard from §0.4.

**Modify — shared, changes BOTH platforms**
- `tailwind.config.js` — palette reads `var(--pos-*)`; add `borderRadius.none` as the POS default; register the new font family.
- `src/renderer/index.css` — import the token sheet; retire the disconnected `:root` block (§2.5).
- `src/renderer/components/pos/POSLayout.tsx` — header → contextual coloured top bar; 20 flex-gap fixes.
- `src/renderer/components/pos/templates/retail/RetailTemplate.tsx` + `QuickActions.tsx` — tile wall, category bar, action bar; 10 flex-gap fixes.
- `src/renderer/components/pos/templates/salon/SalonTemplate.tsx` — same, plus the D2 unification; 16 flex-gap fixes.
- `src/renderer/components/pos/Cart.tsx`, `CartItem.tsx` — line anatomy, inline expand, green quantity, summary strip; 29 flex-gap fixes.
- `src/renderer/components/pos/ProductGrid.tsx`, `ProductCard.tsx` — colour-block tile, remove `aspect-[3/2]`, name top-left / price bottom-right.
- `src/renderer/components/pos/PaymentModal.tsx` — method-coloured header and confirm; 35 flex-gap fixes.
- `src/renderer/components/pos/OrderHistoryModal.tsx` — dark-blue contextual top bar; **50 flex-gap fixes** (largest single file).
- `src/renderer/components/shared/Modal.tsx`, `Button.tsx` — zero radius, collapse the three competing primary buttons into one.
- `src/renderer/components/pos/SearchBar.tsx`, `ShiftModal.tsx`, `POSNumpad.tsx` — token pass.
- `vite.android.config.ts` — pin `build.target: 'chrome83'` (§2.2).
- `DESIGN.md` — supersede with the new direction, or delete and point at this file. Do not leave both.

**Modify — Windows-only, later pass**
- `templates/b2b/**`, `templates/restaurant/**` — still carry the stale dark palette and the non-existent `bg-slate-850`.

**Delete — separate cleanup commit**
- The ten zero-importer files listed in §2.6.

## 7a. Correction to step 2 (2026-08-08, after reading the code)

The step order below originally said: *"D2 unification, look unchanged — move `SalonTemplate` onto shared `Cart`/`CartItem`… **No visual change in this commit.**"*

**That is not achievable, and the plan was wrong to promise it.** Reading both implementations:

- The shared `Cart.tsx` and the bespoke salon cart (`SalonTemplate.tsx:860-1020`) have genuinely different anatomy — different header, line layout, an order-action chip rail, a `POSNumpad` slot, and a near-black full-width PAY button that the salon cart does not have.
- Swapping the component therefore *necessarily* changes how the salon screen looks. "Unify with no visual change" would require making the shared cart reproduce the salon look through props first, which is work spent reproducing a look we are about to discard.

The salon-specific behaviour itself is small and already accommodated: the only thing the salon cart does that the shared one does not is a **per-line staff `<select>`** dispatching `cart/setItemStaff` (`SalonTemplate.tsx:908-930`). The shared cart already exposes exactly the right seam for it — `renderItemExtra?: (item) => ReactNode` (`Cart.tsx:16`, rendered at `:874`).

**Revised approach:** unification and restyle happen in the *same* step, not in two. There is no value in preserving a look that the next commit replaces. The risk is managed instead by scope: the cart step lands on its own, with the salon flow (per-line staff assignment, turn board, shift gating) exercised before and after.

**Revised order:** guard → tokens+font → cart (unify + restyle together) → tile wall → chrome+modals → cleanup.

### Font decision (resolved)

No new assets needed. The repo already self-hosts **Plus Jakarta Sans** at `src/renderer/fonts/kso/` in weights 500/600/700/800 across **latin, latin-ext and vietnamese** subsets — 132 KB total, OFL, with `LICENSE-OFL.txt` and `SOURCE.txt` already in place. latin-ext covers Polish; the vietnamese subset covers the salon names that motivated the earlier diacritics work.

Today those faces are scoped behind `.kso-shell` and unreachable from the cashier screen, while the POS itself asks for `Bahnschrift, Segoe UI…` — Windows-only faces that fall back to Roboto/Noto on the tablet (§2.1). Promoting Plus Jakarta Sans to the POS surface fixes the cross-platform divergence with assets already in the tree. Weight 500 serves body, 700 serves prices and totals; the two-weight rule from §4.4 holds.

## 8. Implementation order

Each step is one reviewable commit with its own gates. Steps 1–2 carry no visual change, which is what makes the risky parts revertible on their own.

1. **Guard first.** Add `verify-css-baseline.mjs` and wire it into the boundary gate. It will fail on the current 343 sites — start it in report-only mode, flip to failing at the end of step 5.
2. **D2 unification, look unchanged.** Move `SalonTemplate` onto shared `Cart`/`CartItem` and a shared card. Prove the salon flow is byte-identical in behaviour. **No visual change in this commit.**
3. **Tokens + font.** Land `pos-tokens.css`, self-hosted font, Tailwind wiring. Both platforms now render the same typeface — a visible change, but a small, isolated one.
4. **The tile wall.** `Tile.tsx`, `ProductGrid`, `ProductCard`, category bar. Fixes the `aspect-*` class as a side effect (D4).
5. **Cart + payment.** Line anatomy, summary strip, method-coloured payment.
6. **Chrome + modals.** Contextual top bars, `Modal`/`Button` unification, `OrderHistoryModal`.
7. **Cleanup.** Delete dead files, retire `DESIGN.md`, flip the guard to failing.

Verify every step at **both** anchors — 1024×768 and 1336×736 — and on the real tablet, not just a resized desktop browser. A Windows dev machine will render `flex gap` correctly and hide the exact bug this redesign exists to remove.

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Redesign ships to live Windows counters mid-service | **HIGH** | Windows gets its own release window; do not bundle with an Android packet. Salon owners warned in advance. |
| D2 unification changes salon behaviour (per-line staff, turn board) | **HIGH** | Step 2 is behaviour-only with no visual change, reviewed and tested on its own before anything else lands. |
| A flex-gap regression slips in via a Windows dev machine | MED | `verify-css-baseline.mjs` in the gate; failing by step 7. |
| Self-hosted font misses Vietnamese/Polish glyphs | MED | Subset must cover latin + latin-ext + vietnamese; the repo has prior art from the kiosk fonts. Verify on the tablet with a Vietnamese salon name. |
| Removing product images upsets salon owners | MED | D4 makes it a per-salon setting, default ON for salon. |
| Colour-block tiles need merchant colours that do not exist yet | MED | Categories already carry `cat.color`; products fall back to category colour, then to a neutral. Auto-flip label to black/white by luminance. |
| Passing off as Dotykačka | MED | D3 Option B keeps our brand hue. Do not copy their wordmark or the watermark. |
| The tablet still cannot sell (WASM/sql.js) | **HIGH** | Unrelated to this work but blocks acceptance testing. Fix `sql.js → asm.js` first or the redesign cannot be verified on device. |

## 10. Open decisions blocking a start

D3 (their green vs our colour) is the only one that changes the token file; the rest change scope, not direction. D4–D7 have recommendations that can be taken as defaults if Paul does not object.

## 11. Sources

Official manual (pixel-sampled): `manual.dotykacka.cz` pages `pruvodcehlavniobrazovkou`, `hlavniobrazovkaauctovani`, `mod-pokladny`, `mapastolu-dlazdice`, `nastaveni-zobrazeni-prodejni-obrazovka`, `mobilni-zobrazeni`, `rozdelitplatbu`. Brand: `dotypos.com/wp-content/uploads/2019/01/Dotypos_CI_2018_en.pdf`. Currency check: `dotykacka.cz/wp-content/uploads/2026/02/dtk_mapa_stolu_2026.png`. Local screenshot copies were kept in the session scratchpad.

- Dotykačka visual language: layout zones, palette, typography, tile and cart anatomy, navigation model. *(research in flight)*
- Current-state inventory with exact files and class strings. *(research in flight)*
- Design tokens for the new system.
- Component-by-component redesign spec.
- File impact map, implementation order, risks.
- Decision D1: apply to both platforms, or gate the new look behind a flag.
