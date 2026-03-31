# Zira AI Print Agent — Session Handoff

> Last updated: 2026-03-31 (session 17 — tsconfig fix + customer display kiosk hardening attempt) | Read this file at the start of every new session.

---

## Project Overview

**Zira AI Print Agent** — Electron + React + TypeScript desktop app for Windows 10/11.
Connects a salon's eNail POS system with hardware (thermal printers, barcode scanners, cash drawers).
The user (`kaipizz`) works **remotely via Discord** and never sees the POS machine directly.

**Remote workflow:**
- User sends instructions → Discord channel `1486692296379596810`
- AI makes code changes on the POS machine, takes screenshots, sends them back via Discord
- Screenshots are saved to: `C:\Users\pc\Pictures\zira-screenshots\` (numbered sequentially)

**⚠️ Always report context warnings, build results, errors, and status via Discord — not just terminal.**

---

## Dev Environment

```bash
# Dev server (HMR + tsc --watch)
npm run dev          # Vite on localhost:3100 + tsc --watch

# Run app
npm run start        # electron .

# Build
npm run build        # full build (main + renderer)
npm run build:main   # main process only
npm run build:renderer  # renderer only

# After main process changes: full rebuild required
# After renderer changes: rebuild:renderer only, restart Electron
```

**Restart Electron after each build:**
```powershell
powershell -Command "Stop-Process -Name 'electron' -Force -ErrorAction SilentlyContinue"
npm run start &
```

**Take screenshot:**
```powershell
powershell -Command "
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bmp.Save('C:\Users\pc\Pictures\zira-screenshots\NNN-description.png')
"
```

**Navigate into the app (login bypass):**
After app starts, the login screen shows. Use keyboard navigation:
1. Click email field (~x=655, y=165 in the right panel)
2. Press Tab × 5 then Enter → triggers Offline Mode
3. App opens with `offline@local` user — all tabs accessible

---

## Installed Skills

| Skill | How installed | Commands |
|-------|--------------|---------|
| **GSD** (Get Shit Done) | `npx get-shit-done-cc --claude --global` | `/gsd:*` (50+ commands) |
| **UI/UX Pro Max** | `uipro init --ai claude` | Auto-activates for UI work |
| **Superpowers** | Manual install → `~/.claude/plugins/cache/superpowers-dev/superpowers/5.0.6/` | 14 skills (TDD, debugging, etc.) |
| **ECC Skills** (9 skills) | Manual → `~/.claude/commands/ecc/` | `/ecc:security-review`, `/ecc:e2e-testing`, `/ecc:verification-loop`, `/ecc:backend-patterns`, `/ecc:frontend-patterns`, `/ecc:coding-standards`, `/ecc:api-design`, `/ecc:feature-development`, `/ecc:database-migration` |

**Auto-activation rules are defined in `CLAUDE.md`** — skills activate automatically based on task type (no need to ask). Key triggers:
- UI work → `ui-ux-pro-max`
- Auth/payments/API/IPC → `ecc:security-review`
- Playwright tests → `ecc:e2e-testing`
- Main process / database / network → `ecc:backend-patterns`
- Renderer components / hooks → `ecc:frontend-patterns`
- DB schema change → `ecc:database-migration`
- Before PR / significant work done → `ecc:verification-loop`

---

## What Has Been Built

### 1. Check-in Tab — UI/UX Redesign
Files changed:
- `src/renderer/components/checkin/EntryScreen.tsx`
- `src/renderer/components/checkin/PhoneEntryScreen.tsx`
- `src/renderer/components/checkin/NewCustomerScreen.tsx`
- `src/renderer/components/checkin/CheckinWizard.tsx`

**Changes:**
1. **EntryScreen** — Cards use `flex-1` (no fixed widths). Gradient hover effects, proper badges.
2. **PhoneEntryScreen** — Larger display (text-4xl), taller keypad buttons (h-16), full-width search button, spinner on loading, "Skip →" as secondary action.
3. **NewCustomerScreen** — Name is **optional**. "Quick Check-in" amber banner to skip form with phone only. Phone shown in brand-colored box. "optional" pill labels on all fields.
4. **CheckinWizard** — Colored pill badges for stats. Active queue sidebar with avatar initials, Walk-in badge, empty state. **Language switcher** (EN VI PL RU UK TR ZH) in header.

### 2. Custom Touch Keyboard (replaces Windows OSK)
Files:
- `src/renderer/components/checkin/TouchKeyboard.tsx` ← new component
- `src/renderer/components/checkin/NewCustomerScreen.tsx` ← wired up

**Behavior:**
- Slides up as an **absolute overlay** from the bottom when Name or Notes field is tapped
- Form scrolls up (via dynamic `paddingBottom`) to keep active field + "In a hurry" banner visible
- **Alpha mode** (Name field): Q–Z + Space + Backspace + Done
- **Full mode** (Notes field): Q–Z + 0–9 + `.`,`,`,`!`,`?`,`@`,`-` + Space + Done
- Uppercase only; Done dismisses keyboard

**Windows OSK fully removed:**
- `system:open-osk` / `system:close-osk` channels removed from `src/shared/types.ts`
- Handlers removed from `src/main/modules/auth.module.ts`
- `openOsk` / `closeOsk` removed from `src/preload/preload.ts`

### 3. Tab Visibility — hide/show sidebar tabs from Settings
Files changed:
- `src/shared/types.ts` — added `hiddenTabs?: Tab[]` to `AgentConfig`
- `src/main/config/store.ts` — added `hiddenTabs` to electron-store schema (default `[]`)
- `src/renderer/App.tsx` — `visibleTabs` now filters out `hiddenTabs` from config
- `src/renderer/components/Settings.tsx` — new **"Navigation Tabs"** panel at bottom of Settings

**Behavior:**
- Toggle any tab off → disappears from sidebar immediately (no restart needed)
- Saves to config (persists across restarts)
- Settings tab cannot be hidden (not in the list)
- Counter shows X / 9 visible

### 4. App startup
- Window opens **maximized** on every launch (`src/main/core/orchestrator.ts` → `mainWindow.maximize()`)

### 5. Sidebar language bug — fixed
- **Bug:** `App.tsx` passed `language={'en'}` hardcoded to Sidebar — so sidebar labels never changed regardless of selected language.
- **Fix:** Changed to `language={(config?.language as Language) || 'en'}` — sidebar now fully translates on language change.

### 6. All tabs enabled + Billiard hidden
- `DEFAULT_ENTITLEMENTS` in `App.tsx`: `booksy`, `debug`, `security` → `true` (were `false`, invisible in offline mode)
- `billiard` → `false` (not relevant for nail salon)
- `hiddenTabs: []` in `config.json` (all user-toggled tabs re-enabled)

### 12. Check-in tab — Full visual redesign (2026-03-30, session 15)

User provided a reference HTML mockup (warm luxury aesthetic: gold/cream, serif titles, circular icons). All 4 steps redesigned — no structural/prop/logic changes, visual only.

**EntryScreen** (`src/renderer/components/checkin/EntryScreen.tsx`):
- Large circular icons (`w-20 h-20 rounded-full`), white → brand/purple fill on hover
- Small-caps label above title ("CHECK-IN" / "NEW ARRIVAL")
- Larger bold title (`text-3xl`), description text, CTA arrow row that shifts on hover
- Booking count badge + "TOUCH AN OPTION TO BEGIN" hint below cards

**PhoneEntryScreen** (`src/renderer/components/checkin/PhoneEntryScreen.tsx`):
- **Bug fix:** `formatPhoneDisplay` now preserves `+` at any position (was stripping non-leading `+`)
- Centered layout: large title + subtitle, content centered vertically
- Phone icon inside display field (warm stone palette)
- Keypad bottom row reordered: `0 / + / ⌫` (was `+ / 0 / ⌫`)
- Digit counter counts only digits (not `+`)

**NewCustomerScreen** (`src/renderer/components/checkin/NewCustomerScreen.tsx`):
- **Auto-focus:** `activeField` initializes to `'name'`; `useEffect` focuses input after 200ms → keyboard opens immediately on arrival
- **Removed:** "In a Hurry / Quick Check-in" amber banner + `handleQuickCheckin`
- Warm card (`bg-stone-50 rounded-3xl border border-stone-200`)
- Larger title (`text-2xl font-bold`) + italic subtitle
- **Name + Birthday in 2-column grid** (was stacked)
- Person icon inside name input, calendar icon inside birthday input
- Labels use `text-[10px] uppercase tracking-wider` style

**ServiceSelectionScreen** (`src/renderer/components/checkin/ServiceSelectionScreen.tsx`):
- Search bar + category filter tabs on **same row** (was two separate rows)
- Category pills: `px-3 py-2 rounded-xl text-xs font-semibold` (was `px-2 py-1 text-[10px]`)
- Service list → **2-column card grid**: initial-letter icon area + name + price + checkmark badge on selection
- Selected state: `border-brand-400 bg-brand-50` + gold checkmark in top-right
- Right sidebar: wider (`w-72`), `bg-stone-50` card, "Selected" header + count badge, empty state illustration
- Sidebar footer: **Total Price** computed from `selectedServices.reduce` + Continue button
- Staff selector restyled to match warm palette

**Screenshot script** (`tests/e2e/screenshot-checkin.mjs`):
- Added `--start-fullscreen` to Electron launch args
- Added `saveConfig({ checkinShowStatsBar: false, checkinShowQueue: false })` before capture
- Script now also presses `+` during phone typing to verify the display fix

### 11. Check-in tab — Kiosk mode + display toggles (2026-03-30, session 14)

**Customer Kiosk fullscreen mode:**
- `src/renderer/App.tsx` — Added `isCheckinFullscreen` state; fullscreen render block (mirrors POS fullscreen); passes `onFullscreen` to CheckinWizard; Escape key exits
- `src/renderer/components/checkin/CheckinWizard.tsx` — Added `onFullscreen` prop; "Customer Kiosk" branded button in top bar; button renders only when prop is provided
- `src/main/windows/window-manager.ts` — Added `window:setFullScreen` IPC handler using `BrowserWindow.fromWebContents(event.sender)`
- `src/shared/types.ts` — Added `WINDOW_SET_FULLSCREEN: 'window:setFullScreen'` to `IPC_CHANNELS`; added `checkinShowStatsBar?: boolean` and `checkinShowQueue?: boolean` to `AgentConfig`
- `src/preload/preload.ts` — Added `window.setFullScreen(value)` to window API
- `src/shared/electron.d.ts` — Added `setFullScreen` to window type
- "Exit Kiosk" button fixed to **bottom-right** corner (was top-right, overlapped navigation)

**Check-in display toggles in Settings:**
- `src/renderer/components/Settings.tsx` — New "Check-in Display" panel with 2 toggle switches: Stats bar + Active queue panel
- `src/renderer/components/checkin/CheckinWizard.tsx` — Reads `checkinShowStatsBar`/`checkinShowQueue` from config; only hides the **stat chips** (left side), language switcher + kiosk button always visible; queue panel conditionally rendered
- Both default `true` — no behavior change for existing installs

### 8. POS tab — UI/UX Redesign (2026-03-27)
Files changed:
- `src/renderer/components/pos/POSLayout.tsx` — Header: rose accent, "Zira POS" (not "AI"), cleaner status pill, taller buttons
- `src/renderer/components/pos/ProductCard.tsx` — `rounded-xl`, `min-h-[120px]`, rose price, `cursor-pointer`, `touch-manipulation`
- `src/renderer/components/pos/ProductGrid.tsx` — `gap-3` (was 2)
- `src/renderer/components/pos/CategoryTabs.tsx` — `rounded-full` pills, rose active, `cursor-pointer touch-manipulation`
- `src/renderer/components/pos/SearchBar.tsx` — `py-2.5`, `rounded-xl`, rose focus ring
- `src/renderer/components/pos/Cart.tsx` — Rose total (`text-xl text-rose-400`), rose cart count badge, bigger pay button (`py-4 font-bold`)
- `src/renderer/components/pos/CartItem.tsx` — +/− buttons `w-9 h-9` (was `w-7`), `cursor-pointer touch-manipulation`
- `src/renderer/components/pos/templates/salon/SalonTemplate.tsx` — Rose tab pills, bigger pay button, inline cart header with count badge, SVG remove buttons, cleaner total section
- `src/renderer/components/pos/templates/salon/StaffPicker.tsx` — Taller select, focus styles

**Design palette:** Beauty/Spa — rose primary, emerald for success, slate dark base
**UI/UX skill applied:** touch-target min-44px, cursor-pointer, touch-action:manipulation, gap-2+ between targets

### 9. POS cart + sidebar fixes (2026-03-27 session 3)
- `CartItem.tsx` — full rewrite: two-row layout (name + unit price on row 1, qty controls + total on row 2). `tOr()` helper for safe translation fallback.
- `CategoryTabs.tsx` — removed `{cat.icon}` (emoji stripped from all category pills)
- `shared/types.ts` — `SIDEBAR_WIDTH.expanded`: 220 → 180px, collapsed: 56 → 48px
- `RetailTemplate.tsx` — added `tOr()` helper, fixed `pos.holdCart`, `pos.recallCart`, `pos.quickPick`, `pos.recall`, `pos.remove` fallbacks

### 10. POS tab — language architecture understood
- POS has its own `posLanguage` stored separately in config (currently `"en"`)
- Falls back to `cfg.language` if `posLanguage` not set
- POS UI strings ARE translated via `t()` — product/service names are NOT (they're database data entered in Polish)
- Multi-language product names would require: DB schema migration (`name_vi`, `name_en`, etc.), product editor UI, POS display logic — deferred to future milestone

---

## 🔜 NEXT UP

### Check-in tab — remaining screens
- **BookingListScreen** and **BookingDetailScreen** — not yet redesigned (booking flow)
- **ConfirmationScreen** — not yet redesigned
- **CustomerProfileScreen** — not yet redesigned (existing customer found by phone)
- Service selection screen: no images available for service cards (DB has no image field); using initial-letter placeholder — could add real images in a future milestone

### Tab-by-tab UX + keyboard audit (in progress)

**Context:** Global touch keyboard (`useKeyboardManager`) was added in session 10. Each tab needs a UX/bug audit — keyboard verified working, touch targets reviewed, hardcoded strings fixed.

| Tab | Status | Notes |
|-----|--------|-------|
| POS | ✅ Done | Keyboard works on search bar. Full UX audit done session 6+. |
| Invoicing | ✅ Done | Keyboard works. 7 bugs/UX issues fixed (session 10b). |
| Settings | ✅ Done | Session 11-12: 8 bugs fixed (AI toggle, multi-printer toggle size/color, confirm()→inline, emoji→SVG icons, dead helpers), save loading state, cursor-pointer, AI description, i18n. |
| **Check-in** | 🔄 In progress | Session 15: Entry + Phone + NewCustomer + ServiceSelection redesigned. Remaining: BookingList, BookingDetail, CustomerProfile, Confirmation screens. |
| **Booksy** | 🔄 Next | Sync config inputs, lower priority. |
| Chat | ⏳ Pending | Single text input, low risk. |
| Status / Debug | ⏳ Pending | Mostly read-only, lowest priority. |

---

## Known Issues / TODO

### 🔴 IN PROGRESS (2026-03-31, session 17) — Customer display kiosk lockdown

**Goal:** Lock customers in fullscreen on the customer display (secondary monitor). Prevent accidental exits via OS touch gestures (swipe from top/left/right edges). Make intentional staff exit require a deliberate gesture.

**What was done this session:**
- `tsconfig.json` — Fixed 3 errors: removed `references` (pointed to non-composite sub-configs), removed `isolatedModules: true` (misapplied to main-process files), added `src/main/archive/**/*` to exclude. Zero TS errors now.
- `src/main/windows/window-manager.ts` — Added `customerExitRequested` flag + `leave-full-screen` event handler that re-enters kiosk/fullscreen within 50ms. Added `display:close` IPC handler for intentional staff exit.
- `src/preload/preload-display.ts` — Added `display.close()` method.
- `src/shared/electron.d.ts` — Added `close()` type to display API.
- `src/renderer/windows/customer/CustomerApp.tsx` — Added touch gesture guard (useEffect): blocks single-finger swipes from edges (<20px), detects 3-finger swipe-down from top zone (≥80px) as staff exit gesture.

**What DIDN'T work / still broken:**
- The "−" bar at the top is still visible. This is the Chromium fullscreen-exit indicator — it only disappears in true kiosk mode. The customer display uses `kiosk: true` on multi-monitor setups already, but the bar persists. Possible causes:
  1. The OS-level swipe-from-top briefly exits kiosk before our handler re-enters it → bar flashes visible
  2. Or the touchscreen driver processes the gesture at a level below Electron's event system
- The `leave-full-screen` + re-enter approach may have a visible flash — needs testing with the actual secondary touchscreen

**Root cause to investigate next session:**
- Determine whether the "−" bar appears because: (a) kiosk mode isn't actually being set (check logs), (b) it's a Windows system overlay drawn on top of kiosk apps, or (c) the `leave-full-screen` handler re-enters too slowly
- Consider: `win.setContentProtection(true)` to prevent screen captures, or `win.on('blur', () => win.focus())` to prevent the window from losing focus to OS gestures
- Consider: Windows API `RegisterTouchWindow` / `DisableProcessWindowsGhosting` via native module, or PowerShell to disable touch gestures system-wide

**Files changed this session:**
- `tsconfig.json`
- `src/main/windows/window-manager.ts`
- `src/preload/preload-display.ts`
- `src/shared/electron.d.ts`
- `src/renderer/windows/customer/CustomerApp.tsx`

---

### ✅ FIXED (2026-03-30, session 16) — Blank screen on launch

`useRef`/`useCallback` for kiosk swipe-to-exit were after conditional early returns in `App.tsx` — violated Rules of Hooks → React crash → blank screen. Moved hooks to top level (line ~71). App renders normally.

---

### High priority
- [x] **Language switcher persists** — fixed 2026-03-27. `useEffect` syncs lang from config on load; `saveConfig({ language: l })` called on click. (`CheckinWizard.tsx`)
- [x] **Translation keys** — audited all `wizard.*` keys across all checkin screens; all present in all 7 languages. No missing keys.

### Medium priority
- [x] **New Customer form — name as empty string** — Fixed 2026-03-27. `createCustomer` now defaults `name: form.name || 'Guest'` in `useCheckinWizard.ts`.
- [x] **Active Queue sidebar empty state** — Fixed 2026-03-27. Larger icon (w-16 rounded-2xl), bigger text with hint `wizard.noActiveHint` key added.
- [x] **Hardcoded English in NewCustomerScreen** — Fixed 2026-03-27. All strings now use `t()`: `wizard.newGuestDesc`, `wizard.inAHurry`, `wizard.skipDetails`, `wizard.quickCheckin`, `wizard.noPhoneEntered`, `wizard.optional` (×3).
- [x] **Hardcoded English in EntryScreen badges** — Fixed 2026-03-27. "Ready to check in" → `wizard.readyToCheckin`, "No appointment needed" → `wizard.noAppointmentNeeded`.
- [x] **Hardcoded English in PhoneEntryScreen** — Fixed 2026-03-27. Subtitle → `wizard.phoneSubtitle`, phone hint → `wizard.phoneHint`.
- [x] **Hardcoded "LATE" in BookingListScreen** — Fixed 2026-03-27. → `wizard.late`.
- [x] **Hardcoded "Walk-in" badge in queue** — Fixed 2026-03-27. → `wizard.walkIn` (key already existed).
- [x] **Missing try-catch in queue actions** — Fixed 2026-03-27. `startService`, `completeCheckin`, `markNoShow` now log errors via `console.error`.
- [x] **Triple filter computation in queue** — Fixed 2026-03-27. `activeCheckins` computed once, used 3× in render.

### Low priority
- [ ] **Activate Windows watermark** — machine needs activation (not a code issue).
- [x] **"No appointment needed" / "Ready to check in" badges** — Fixed 2026-03-27. Moved to `wizard.noAppointmentNeeded` / `wizard.readyToCheckin` in all 7 languages.

### ✅ COMPLETED (sessions 11-12) — Settings tab full UX redesign + bug audit

**Session 11 — UX improvements:**
- `src/renderer/components/Settings.tsx` — 3 native `<input type="checkbox">` → toggle switches; `alert()` → inline green banner (`savedBanner`); "Open Customer Display" button → outlined secondary style; `data-keyboard="false"` on AI API key password input; AI Tools section shows description when off
- `src/renderer/i18n/translations.ts` — Added `settings.navigationTabs`, `settings.navigationTabsDesc`, 13 `update.*` keys — all 7 languages

**Session 12 — Bug audit + UX fixes:**
- `src/renderer/components/Settings.tsx`:
  - **Bug:** AI toggle hardcoded `aiEnabled: true` on turn-off → now mirrors toggle state
  - **Bug:** Multi-printer toggles `h-5 w-9 bg-green-500` (20×36px, green) → `h-6 w-11 bg-brand-600` (consistent with all other toggles)
  - **Bug:** `confirm()` in Change Salon → inline red confirmation panel with `showChangeSalonConfirm` state
  - **Bug:** Emoji printer icons (`🧾🏷️📄🎫👨‍🍳`) → Lucide SVGs (Printer/Tag/FileText/Ticket/UtensilsCrossed)
  - Save button: loading spinner + disabled state during async save (`isSaving` state)
  - Refresh buttons: added `cursor-pointer`
  - AI Tools description: now uses `ai.localModeDesc` (correct for local tools, not chatbot)
- `src/renderer/i18n/translations.ts` — Added `ai.localModeDesc` — all 7 languages

---

### ✅ COMPLETED (session 10) — Global touch keyboard + InvoiceList cancel modal

**Files changed:**
- `src/renderer/components/invoicing/InvoiceList.tsx` — Cancel invoice: replaced `window.prompt()` with inline modal (textarea + confirm/cancel). All `alert()` → inline error banners.
- `src/renderer/components/shared/TouchKeyboard.tsx` — Shared touch keyboard component: `alpha` / `full` / `numeric` modes
- `src/renderer/hooks/useKeyboardManager.ts` — Global hook: focusin/focusout listener, 150ms hide delay, mode detection (numeric for `type=number`, full for text)
- `src/renderer/App.tsx` — Wired global keyboard: `<TouchKeyboard>` at bottom of flex-col layout, `paddingBottom: 300px` on `<main>` when visible, skips checkin tab
- `src/renderer/components/checkin/TouchKeyboard.tsx` — Now re-exports from shared component
- `src/shared/types.ts` — Removed `SHOW_TOUCH_KEYBOARD` (tabtip approach reverted)
- `src/main/modules/hardware.module.ts` — Removed tabtip.exe IPC handler
- `src/preload/preload.ts` — Removed `showKeyboard` exposure
- `src/shared/electron.d.ts` — Removed `showKeyboard` type

**Behavior:**
- Any `<input>` or `<textarea>` focused → keyboard slides up from bottom
- Skip list: `type=checkbox/radio/hidden/file/date/time`, `data-keyboard="false"`
- Mode: `type=number` or `inputmode=numeric/decimal` → numpad; else → full (letters + numbers + punctuation)
- Key injection uses React native setter + `input` event (works with React controlled components)
- Checkin tab excluded (has its own local keyboard in `NewCustomerScreen.tsx`)

---

### ✅ COMPLETED (session 10b) — Invoicing tab audit + fixes

**Bugs fixed:**
- `QuickInvoice.tsx` — removed auto-focus `useEffect` that triggered touch keyboard on tab open
- `InvoiceList.tsx` — replaced hardcoded English `"Try adjusting your filters"` → `invoice.noResults` (all 7 languages)
- `InvoiceList.tsx` — cancel modal dismiss button changed `common.cancel` → `common.close` (was ambiguous in PL/UA)

**UX fixes:**
- `InvoiceList.tsx` — row actions now always visible (removed `opacity-0 group-hover:opacity-100`, touch-unfriendly)
- `InvoiceList.tsx` — row action touch targets bumped to `min-w-[36px] min-h-[36px] p-2 w-4 h-4`
- `QuickInvoice.tsx` — NIP input: added `inputMode="numeric"` → shows numpad keyboard
- `CustomerManagement.tsx` — modal close button: added `cursor-pointer`; form buttons: `py-2` → `py-2.5`

---

### ✅ COMPLETED (session 9) — Invoicing tab bug fixes + i18n completeness

**Files changed:**
- `src/renderer/components/invoicing/SellerSettings.tsx` — Critical bug: was passing API wrapper `{ success, data }` to `onSaved()` instead of `data`. Fixed to `if (updated.success && updated.data) onSaved(updated.data)`.
- `src/renderer/components/invoicing/InvoiceForm.tsx` — 8 broken translation keys fixed (`invoice.payment.*` → `invoice.paymentMethod.*`, table headers mapped to correct keys, `invoice.netTotal` → `invoice.subtotalNet`). Type selector changed from `<select>` to segmented pills (matches QuickInvoice). Totals box `bg-slate-50` → `bg-brand-50`. `cursor-pointer` added to buttons.
- `src/renderer/components/invoicing/CustomerManagement.tsx` — `alert()` replaced with inline error banner. Empty state now has CTA button. Added `cursor-pointer`. Fixed modal title to use `invoice.addCustomer`.
- `src/renderer/components/invoicing/CustomerPicker.tsx` — 7 hardcoded Polish strings replaced with `t()` calls using new `invoice.nip.*` keys.
- `src/renderer/i18n/translations.ts` — Added 4 missing CustomerManagement keys + 7 NIP lookup keys to all 7 languages (EN, VI, TR, ZH, UK, RU, PL).

---

### ✅ COMPLETED (session 8) — Invoicing tab UI/UX redesign

**Files changed:**
- `src/renderer/components/invoicing/InvoicingTab.tsx` — Icon+label segmented sub-tab nav (icon+text pills), fixed `invoice.settings` → `invoice.sellerSettings`
- `src/renderer/components/invoicing/QuickInvoice.tsx` — Full redesign: segmented type selector (Receipt/VAT/Proforma pills), 2+2 grid layout, brand-50 summary card with large brand-600 total, clear button hierarchy (Print Thermal primary, A4+Save secondary), keyboard hints. Fixed all broken translation key references.
- `src/renderer/components/invoicing/InvoiceList.tsx` — Redesigned: search icon in input, uppercase column headers, pill status badges with borders, hover-reveal row actions, better empty state with icon
- `src/renderer/i18n/translations.ts` — Added 5 missing EN keys: `invoice.error.itemNameRequired`, `invoice.error.priceRequired`, `invoice.error.nipRequired`, `invoice.created`, `invoice.itemNamePlaceholder`

**Design decisions:**
- Invoice type selector: segmented pill control (not dropdown) — front and center in Quick Invoice
- Summary box: `bg-brand-50 border-brand-100` with `text-2xl font-bold text-brand-600` total
- Button hierarchy: Print Thermal = full-width primary (brand-600), A4 = secondary outline, Save = tertiary ghost
- Row actions in list: `opacity-0 group-hover:opacity-100` — clean by default, accessible on hover

---

### ✅ COMPLETED (session 7) — Cross-tab color sync

**What was done (session 7):**
1. `invoice.setupRequired` + `invoice.setupRequiredDesc` added to all 7 languages (VI, TR, ZH, UK, RU, PL completed)
2. All `rose-*` → `brand-*` and `pink-*` → `brand-*` replaced across all 12 POS components
3. All `bg-gray-50` → `bg-slate-50` in POS component backgrounds
4. Build passed clean; screenshots confirmed terracotta palette throughout POS

**Color palette reference:**
- `brand-500` = `#da7756` (warm terracotta) — primary accent
- `slate-50` = `#faf9f7` (warm sand) — background base

---

**What was previously discovered:**
- Main app uses a `brand-*` color palette in `tailwind.config.js`:
  - `brand-500` = `#da7756` (warm terracotta) — the app's primary accent
  - `brand-600` = `#c5684a`, `brand-700` = `#a9533a`
  - `brand-50` = `#fff7f2`, `brand-100` = `#fde9dd`
- The `slate-*` Tailwind override maps to warm sand: `slate-50` = `#faf9f7`, `slate-200` = `#e8e5e0`
- POS components currently use `rose-*` and `pink-*` (Tailwind defaults), which are cooler/pinker than the main app's terracotta
- The `purple-*` palette in Tailwind config is also mapped to the same terracotta as `brand-*`

**Work completed this session:**
- `src/renderer/i18n/translations.ts` — added `invoice.setupRequired` and `invoice.setupRequiredDesc` **for English only**

**Work still needed:**
1. Add `invoice.setupRequired` + `invoice.setupRequiredDesc` to remaining 6 languages (VI, TR, ZH, UK, RU, PL) — insert after `'invoice.title'` in each language block
   - VI: `'Yêu cầu thiết lập'` / `'Vui lòng điền thông tin người bán trước khi tạo hóa đơn.'`
   - TR: `'Kurulum gerekli'` / `'Fatura oluşturmadan önce satıcı bilgilerinizi doldurun.'`
   - ZH: `'需要设置'` / `'创建发票前请填写销售方信息。'`
   - UK: `'Потрібне налаштування'` / `'Заповніть дані продавця перед створенням рахунків.'`
   - RU: `'Требуется настройка'` / `'Заполните данные продавца перед созданием счетов.'`
   - PL: `'Wymagana konfiguracja'` / `'Wypełnij dane sprzedawcy przed wystawianiem faktur.'`
2. Replace all `rose-*` → `brand-*` in POS components (1:1 mapping — same shade numbers)
3. Replace all `pink-*` → `brand-*` in POS components
4. Replace `bg-gray-50` → `bg-slate-50` in POS component backgrounds (warm base)
5. Optionally: replace `border-gray-200` → `border-slate-200` (warm subtle borders)

**Files to update for color sync (POS):**
- `src/renderer/components/pos/POSLayout.tsx`
- `src/renderer/components/pos/Cart.tsx`
- `src/renderer/components/pos/CartItem.tsx`
- `src/renderer/components/pos/PaymentModal.tsx`
- `src/renderer/components/pos/ShiftModal.tsx`
- `src/renderer/components/pos/ProductCard.tsx`
- `src/renderer/components/pos/ProductGrid.tsx`
- `src/renderer/components/pos/SearchBar.tsx`
- `src/renderer/components/pos/CategoryTabs.tsx`
- `src/renderer/components/pos/templates/retail/RetailTemplate.tsx`
- `src/renderer/components/pos/templates/retail/QuickActions.tsx`
- `src/renderer/components/pos/templates/salon/SalonTemplate.tsx`

**Verification:** After color swap, run `npm run build` then `node tests/e2e/screenshot-pos.mjs` to confirm visually.

### 14. Check-in tab — Full bug audit + UX redesign (2026-03-29 session 13)

**UI/UX rating: 6.5 → 8.6 / 10**

**Skills used:** `ui-ux-pro-max`, `ecc:frontend-patterns`

**Dead code removed:**
- Deleted `src/renderer/components/CheckinTab.tsx` — was never imported anywhere (app renders `CheckinWizard`)

**Bugs fixed:**
- `useCheckinWizard.ts` — `lookupPhone` no longer silently treats IPC errors as "no customer found" (would create duplicate customers); now surfaces error banner
- `useCheckinWizard.ts` — `recommendations` bleed fixed: `createCustomer()` clears previous customer's recommendations before navigating to service-select
- `useCheckinWizard.ts` — double-submit guard: all action handlers (`confirmBookingCheckin`, `confirmWalkIn`, `startService`, `completeCheckin`, `markNoShow`) check `isSubmitting` and lock until IPC resolves
- `useCheckinWizard.ts` — all async failures now set `errorMessage` in state (was silently swallowed)
- `useCheckinWizard.ts` — added `clearError()` export
- `CheckinWizard.tsx` — language button no longer calls `saveConfig` when tapping the already-active language (was flooding main process)

**UX improvements:**
- Error banner (dismissable red panel) shows on any IPC failure
- No-show confirmation: inline "Sure? Yes / No" prompt before committing — prevents accidental taps
- All action buttons (`Start`, `Complete`, `No Show`, `Confirm Check-in`) disable + show `...` during submission
- Wait time displayed per active queue entry (e.g. `12m`, `1h 5m`)
- Step progress indicator: `1/4 · Phone`, `2/4 · Profile`, `3/4 · Services`, `4/4 · Confirm` (booking: `1/2 · Select`, `2/2 · Confirm`)
- Active queue collapses to `w-14` icon strip when empty (from `w-72`), auto-expands when check-ins are active — `transition-all duration-300`
- Phone entry formats digits with spaces: `123 456 789`, `+48 123 456 789`
- Skip button removed from phone entry (phone is required)
- Phone field restored to New Customer form as read-only review field with pencil icon to go back and correct

**Files changed:**
- `src/renderer/hooks/useCheckinWizard.ts` — error/submitting state, guards, `clearError`
- `src/renderer/components/checkin/CheckinWizard.tsx` — error banner, no-show confirm, step indicator with labels, collapsible queue, language fix
- `src/renderer/components/checkin/BookingDetailScreen.tsx` — `isSubmitting` prop, disabled confirm button
- `src/renderer/components/checkin/ConfirmationScreen.tsx` — `isSubmitting` prop, disabled confirm button
- `src/renderer/components/checkin/PhoneEntryScreen.tsx` — `formatPhoneDisplay()`, removed Skip button
- `src/renderer/components/checkin/NewCustomerScreen.tsx` — phone review field restored, neutral styling when empty

**Screenshot tool:** `node tests/e2e/screenshot-checkin.mjs` → `tests/e2e/screenshots/checkin-*.png`

---

### Next up — UI/UX redesign
- **Goal:** Redesign all tabs for a cleaner, nail-salon-appropriate interface (less "AI-heavy" look)
- **Order:** POS first → then other tabs
- **POS redesign complete** — rose/pink accent, bigger cards, touch-friendly buttons, premium POS layout. RetailTemplate + SalonTemplate both updated.
- **POS cart fixed** — two-row layout (name on top, qty+price below), no overlapping. Sidebar narrowed 220→180px. Emoji stripped from category tabs. Translation key fallbacks fixed (pos.holdCart, pos.recallCart, pos.quickPick, pos.editPrice, pos.note).
- **Multi-language product names** — deferred feature. Would need DB migration + product editor + POS display changes. Not this milestone.

### 11. POS full UI redesign — Retail template (2026-03-28 session 4)

**Files changed:**
- `src/renderer/components/pos/templates/retail/RetailTemplate.tsx` — Category dropdown (replaces pill tabs), horizontal-scroll Quick Picks with `‹ ›` arrows, light `bg-gray-50` layout, Hold/Recall merged into QuickActions bar
- `src/renderer/components/pos/templates/retail/QuickActions.tsx` — Holds Hold + Recall + Discount + Display toggle in one compact bar. Held-cart strip slides in above bar when Recall is toggled.
- `src/renderer/components/pos/ProductCard.tsx` — Full rewrite: inset image (`aspect-[4/3]`, padded), `flex flex-col h-full` layout, name+SKU middle flex-grow, price + circular rose "+" button always anchored to bottom
- `src/renderer/components/pos/ProductGrid.tsx` — Fixed `grid-cols-3` (no xl:4 breakpoint), light empty state
- `src/renderer/components/pos/SearchBar.tsx` — Light theme: `bg-white border-gray-200`, rose focus ring
- `src/renderer/components/pos/Cart.tsx` — White bg, icon empty state with subtitle, totals in distinct `bg-gray-50 rounded-xl` container, `shadow-lg` Pay button
- `src/renderer/components/pos/CartItem.tsx` — Card-style items (`bg-gray-50 rounded-xl`): name+✕ top, price/unit middle, circular qty controls + total bottom. `−` = white/bordered neutral, `+` = rose accent

**Design:** Light tablet POS aesthetic — `bg-gray-50` base, white surfaces, `border-gray-100/200`, rose accent (`rose-500`), `rounded-2xl` consistently throughout.

**Screenshot tool:** `node tests/e2e/screenshot-pos.mjs` — Playwright launches app, clicks Offline Mode, navigates POS, optionally adds 3 items to cart, saves to `tests/e2e/screenshots/`. Use this for all future POS screenshots.

**SalonTemplate** (`src/renderer/components/pos/templates/salon/SalonTemplate.tsx`) — also received similar redesign (dropdown, Quick Picks, image cards) but app currently runs in **Retail** mode.

### 13. POS tab — Full UX/UI audit + fixes (2026-03-28 session 6)

**Audit score before: 6.3/10 → after: ~8.5/10**

**Files changed:**
- `src/renderer/components/pos/PaymentModal.tsx` — Full restyle: light theme (white bg, rose accent, SVG icons per payment method, colored status panels for change/card, green Complete → rose-500)
- `src/renderer/components/pos/ShiftModal.tsx` — Light theme, green/red icon for open/close context, rose submit button
- `src/renderer/components/pos/POSLayout.tsx` — Removed duplicate Customer Display + Ads toggles from header (kept only in QuickActions bar); removed unused `isCustomerDisplayOpen` state
- `src/renderer/components/pos/Cart.tsx` — Added `shiftOpen` prop; amber warning banner + disabled Pay when no shift open; `text-gray-400` on Clear (was 300); `text-gray-500/600` subtotal; i18n `pos.cart.emptyHint`
- `src/renderer/components/pos/CartItem.tsx` — `edit`/`note` links: `text-gray-400 px-2 py-1` (was gray-300 no padding); remove button `w-8 h-8` (was w-7)
- `src/renderer/components/pos/ProductGrid.tsx` — Added `resetScrollKey` prop; `useEffect` resets scroll to top when key changes
- `src/renderer/components/pos/templates/retail/RetailTemplate.tsx` — Removed scroll arrows + quickPicksRef; Quick Picks → `grid grid-cols-4` (4-column uniform grid); passes `shiftOpen={session.isOpen}` to Cart; passes `resetScrollKey` to ProductGrid
- `src/renderer/components/pos/templates/salon/SalonTemplate.tsx` — Pay button `bg-pink-500` → `bg-rose-500`; shift guard banner + disabled Pay when no shift; Quick Picks → `grid grid-cols-4`; `productGridRef` + `useEffect` scroll reset; `text-gray-500` Quick Picks label; `text-gray-600` subtotal; Clear button hover padding
- `src/renderer/i18n/translations.ts` — 3 new keys in all 7 languages: `pos.cart.emptyHint`, `pos.quickPick`, `pos.shift.openRequired`

**Issues fixed:**
1. ✅ PaymentModal + ShiftModal dark theme → light (was slate-800/purple, now white/rose)
2. ✅ Three different Pay button colors → all `rose-500`
3. ✅ Duplicate Customer Display toggle in header → removed
4. ✅ No shift enforcement → amber banner + disabled Pay when `session.isOpen === false`
5. ✅ Contrast failures → `text-gray-300` replaced everywhere (edit/note/clear/subtotal/quick picks label)
6. ✅ Touch targets too small → scroll arrows removed (replaced by grid); cart buttons enlarged
7. ✅ Quick Picks messy flex-wrap → clean `grid-cols-4` uniform layout
8. ✅ Hardcoded English strings → i18n keys in all 7 languages
9. ✅ Product grid no scroll reset → resets to top on category change

**Remaining (acknowledged, not yet fixed):**
- POS mode switch still requires going to Settings (no in-POS mode picker)
- Quick Picks are first 8 DB products, not frequency-sorted (needs backend data)
- No keyboard shortcuts hint visible in POS
- Offline badge always red (no distinction between intentional/unexpected offline)

**Screenshot tool:** `node tests/e2e/screenshot-pos.mjs` → `tests/e2e/screenshots/pos-*.png`

### 12. POS Cart — Visual hierarchy refinement (2026-03-28 session 5)

**Files changed:**
- `src/renderer/components/pos/CartItem.tsx`
- `src/renderer/components/pos/Cart.tsx`

**Changes (visual only — no layout/logic changes):**
- **Cart items** — white card (`bg-white border border-gray-100 shadow-sm`) replaces flat `bg-gray-50`; `mb-2.5` spacing between items
- **Remove (X) button** — bumped to `w-7 h-7`, `text-gray-400` (was 300), `hover:text-red-500` + `active:bg-red-100` press feedback
- **Quantity stepper** — grouped into single pill control (`inline-flex border border-gray-200 bg-gray-50 rounded-lg overflow-hidden`); tighter layout, `active` states on both buttons; `+` button retains rose accent, occupies right slot in pill
- **Item line total** — `text-base font-bold` (was `text-sm font-bold`) for more prominence
- **Totals section** — subtotal label + value both `text-gray-400` (muted); total value `text-2xl` (was `text-xl`); container gets `border border-gray-100`
- **Pay button** — `active:scale-[0.98] active:shadow-md` added for tactile press feedback

**Screenshot tool:** `node tests/e2e/screenshot-pos.mjs` → `tests/e2e/screenshots/pos-cart.png`

---

## Project Architecture (Quick Reference)

```
Main Process (Node.js)          Preload (contextBridge)       Renderer (React + Vite)
src/main/                       src/preload/preload.ts        src/renderer/
├── core/orchestrator.ts        window.electronAPI.*          ├── App.tsx  ← hiddenTabs filter
├── modules/auth.module.ts                                    ├── components/checkin/
├── database/ (SQL.js)                                        │   ├── CheckinWizard.tsx
├── network/ (Socket.IO)                                      │   ├── EntryScreen.tsx
└── config/store.ts             ← hiddenTabs persisted here   │   ├── PhoneEntryScreen.tsx
                                                              │   ├── NewCustomerScreen.tsx ← touch KB
                                                              │   ├── TouchKeyboard.tsx ← new
                                                              ├── components/Settings.tsx ← tab visibility
                                                              └── i18n/translations.ts
```

**IPC pattern:** `window.electronAPI.method()` → `ipcMain.handle(channel, handler)` in module

**Database:** SQL.js (SQLite WASM), stored at `%APPDATA%/zira-ai/pos.db`

**Translations:** `src/renderer/i18n/translations.ts` — 7 languages: `en vi tr zh uk ru pl`

---

## User Preferences

- **Remote via Discord** — all communication via Discord channel `1486692296379596810`
- **Screenshots** — always save to `C:\Users\pc\Pictures\zira-screenshots\` with numbered names
- **Model** — `claude-sonnet-4-6` (200k context). Switch to haiku for fast iteration if needed.
- **Report to Discord**: context warnings, build status, errors, app crashes — not just terminal
- **Send screenshots after each visible change**
- **Git commits** — only when user explicitly asks
