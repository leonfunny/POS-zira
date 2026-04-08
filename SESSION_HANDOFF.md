# Zira AI Print Agent — Session Handoff

> Last updated: 2026-04-08 (session 40 - printer regression fix + printer settings persistence, BUILT/TESTED, NOT COMMITTED) | Read this file at the start of every new session.

## Session 40 - printer regression fix + printer settings persistence

**User report (phase 1):**
- App started idle but burned CPU / made the machine lag
- Settings -> `Multi-printer` toggle immediately flipped itself back off
- `Detect Printers` returned no devices even with 2 printers connected

**Root causes found (phase 1):**
- `multiPrinter` mode was not persisted as its own flag; it was inferred from `printers/receiptPrinter/labelPrinter`, so enabling the toggle with an empty printer map got pulled back to `false` on the next config sync
- Printer fields were included in the generic Settings auto-save payload, so unrelated setting changes emitted printer-related `config:changed` events and reinitialized hardware
- Settings detection work was doing multiple heavy IPC calls per refresh / device-status event
- The new detection pipeline was over-filtering: it trusted strict COM filtering too much, trusted filtered-empty spooler results too much, and hid serial-only thermal devices that had no Windows spooler entry

**Main code changes (phase 1):**
- Added persisted `multiPrinterMode` to config types + store schema + migration
- `HardwareModule` now uses `multiPrinterMode` as the source of truth instead of inferring mode from whether `printers` is empty
- `listSerialPorts()` now falls back to raw registry COM ports when strict PnP/WMI filtering returns empty even though Windows still sees serial hardware
- `getPosnetDriverStatus()` now returns `serialPorts` + `windowsPrinters`, exposes serial-only devices as `Generic Serial`, and marks manual-only devices with `autoSetupEligible: false`
- `LIST_WINDOWS_PRINTERS` now returns the filtered detection snapshot, with raw spooler fallback only when the filtered path is unusable
- Health checks now use one cached detection snapshot per cycle instead of repeated per-printer PowerShell presence probes
- Settings printer detection was collapsed into one unified refresh path instead of separate `listPorts + listWindowsPrinters + getPosnetDriverStatus` bursts

**User report (phase 2, after phase-1 fix):**
- Detect printers and printer setup started working again
- But printer state was not persisted: leaving the Settings tab reset printer assignments, detected devices, and calibrated label size back to defaults

**Root cause found (phase 2):**
- The earlier Settings refactor removed printer state from the generic auto-save path but only left manual local state in `Settings.tsx`
- `Settings` unmounts when the user leaves the Settings tab, so unsaved printer state died with the component

**Main code changes (phase 2):**
- Replaced the manual "Apply printer changes" flow with a dedicated printer auto-save pipeline in `Settings.tsx`
- Printer config now auto-saves on its own debounce, separate from general settings auto-save
- Added final flush on `Settings` unmount so switching tabs does not lose pending printer edits
- Added in-flight / pending-save guards so printer saves do not race each other
- Added a failed-signature guard so a failed save does not loop forever on every render
- Updated the footer copy to reflect the real behavior: printer changes now save automatically

**Files changed in this session:**
- `src/shared/types.ts`
- `src/main/config/store.ts`
- `src/main/hardware/port-utils.ts`
- `src/main/hardware/driver-installer.ts`
- `src/main/hardware/thermal/thermal-driver.ts`
- `src/main/hardware/zebra/zebra-driver.ts`
- `src/main/modules/hardware.module.ts`
- `src/renderer/components/Settings.tsx`

**Verification run in this session:**
- `npm run build` -> passed
- `npx vitest run --exclude tests/e2e/**` -> passed (`98 passed`)

**User-confirmed runtime status at end of session:**
- Printer detection is working again
- Multi-printer behavior is stable
- Leaving the Settings tab no longer resets printer setup or label dimensions

**Git/process status:**
- NOT committed
- NOT pushed
- Keep changes local until the user explicitly asks for commit/push

**Dirty worktree note for next session:**
- There are unrelated existing changes outside the printer work:
  - `src/main/windows/window-manager.ts`
  - `src/renderer/windows/customer/views/CheckInView.tsx`
  - `tests/checkin-view.test.ts`
  - `tests/window-manager.test.ts`
- Do not casually revert those; they were not part of this printer session

## Session 39 - Display On concierge redesign + scoped cleanup

**User goal:** Redesign the full Display On flow inside POS after `Touch to explore`, keep the existing warm palette, add a Display On language switch matching POS, make the UI feel intentional rather than AI-generated, then clean up the project around the work.

**Important scope note:** Cleanup in this session was **not repo-wide cleanup**. It was a **scoped cleanup around the customer display / Display On flow only**. The rest of the repo was not audited for dead code in this pass.

### What was redesigned

`Touch to explore` was kept unchanged. Everything after that was rebuilt around a concierge-style arrival flow:

- `Check in with phone`
- `I have booking`
- `Walk in`
- `Browse services`

### Main behavior changes

- Added independent Display On language persistence via `customerDisplayLanguage`
- Fallback order: `customerDisplayLanguage -> posLanguage -> language`
- Changing Display On language does **not** change POS language
- Added a persistent language dropdown in the Display On shell, styled to match POS
- Rebuilt the post-idle home screen so the primary hierarchy is now `Check in with phone` and `I have booking`, with `Walk in` and `Browse services` as secondary choices
- Reworked `Browse services` into a catalog + handoff flow instead of a second main selection engine
- Reworked `Walk in` into identity first, then service choice
- Reworked phone check-in for keypad input, live results, and clear walk-in fallback
- Reworked booking lookup for faster search and a shorter confirmation flow

### UX polish applied during follow-up iterations

- Fixed the Display On language dropdown being visually covered by content beneath it
- Added back navigation to `Browse services` so it behaves consistently with the booking flow
- Reworked ambiguous overview copy from compressed values like `10 / PLN 5.00` into explicit text such as `10 services` and `From PLN 5.00`
- Applied the clearer overview copy both in the browse screen and the welcome/check-in hub side panel
- Updated the phone keypad display so customers see grouped 9-digit formatting like `123 456 789`
- Replaced the old `---` placeholder with a phone-shaped numeric hint
- Capped phone input at 9 digits

### Files and architecture added for the redesign

- `src/renderer/windows/customer/customer-display-model.ts`
- `src/renderer/windows/customer/components/CustomerBookingCard.tsx`
- `src/renderer/windows/customer/components/CustomerDisplayPrimitives.tsx`
- `src/renderer/windows/customer/components/CustomerDisplayShell.tsx`
- `src/renderer/windows/customer/components/WalkInServicePicker.tsx`

### Major files changed in the redesign

- `src/renderer/windows/customer/CustomerApp.tsx`
- `src/renderer/windows/customer/views/CheckInView.tsx`
- `src/renderer/windows/customer/views/SalonInteractiveView.tsx`
- `src/renderer/i18n/translations.ts`
- `src/main/config/store.ts`
- `src/main/modules/pos.module.ts`
- `src/main/pos/pos-store.ts`
- `src/preload/preload-display.ts`
- `src/shared/electron.d.ts`
- `src/shared/types.ts`
- `tests/customer-display-model.test.ts`
- `docs/superpowers/specs/2026-04-07-display-on-concierge-design.md`
- `docs/superpowers/plans/2026-04-07-display-on-redesign.md`

### Scoped cleanup done in this session

Removed only code confirmed to be unused or temporary within the customer-display scope:

- Deleted dead legacy files `src/renderer/windows/customer/views/InteractiveView.tsx` and `src/renderer/windows/customer/views/UpsellStrip.tsx`
- Removed dead `maxDuration` from the browse summary model because no redesigned UI reads it
- Removed temporary debug bridge and instrumentation added during troubleshooting in preload/types, `pos.module.ts`, and `CustomerApp.tsx`
- Added `.superpowers/` to `.gitignore` so brainstorm artifacts stop polluting git status

### Verification run in this session

Before the final pushed state, the following were run and passed:

- `npm test -- tests/customer-display-model.test.ts`
- `npm test`
- `npm run typecheck:renderer`
- `npm run build`

At the end of cleanup, the full suite still passed:

- `Vitest: 106 passed`
- `Build: passed`

### Git and process status

This session was already merged to `main` before the user clarified a workflow preference.

- Redesign commit on `main`: `e247b61` - `feat: redesign customer display concierge flow`
- Cleanup commit on `main`: `8e425cf` - `chore: clean up customer display redesign`

**Process note for next session:** user explicitly said future work should **not** be committed or pushed automatically. Keep changes local until the user explicitly approves commit/push.

### Remaining work / next-session direction

- Continue visual polish on Display On screens based on live screenshots
- Manually verify language persistence by closing and reopening the customer display
- Manually verify `Touch to explore` still looks and behaves unchanged
- Reassess whether the interactive fallback block in `CustomerApp.tsx` is still needed once salon-only usage is certain


## Session 38 — Customer display: true kiosk + restored flow visibility

**User report:** "What is Display On for? Before, the customer display had phone entry / services / payment like check-in. Now it only shows payment. Also it isn't truly fullscreen — I can drag it with one finger and the taskbar is still visible."

**Diagnosis (with file refs):**
- The customer window was a fully-formed state machine (idle/promo/checkin/interactive/cart/thankyou) — see `src/renderer/windows/customer/CustomerApp.tsx` and `src/main/pos/pos-store.ts`. It is the **customer-facing twin** of the main check-in tab, intended for a second monitor.
- `pos-store.ts` `cart/addItem` reducer was forcing `display.mode = 'cart'` unconditionally — so the moment the operator added an item, the customer window jumped past idle/checkin/interactive into the cart view. The pre-cart flow was effectively unreachable in the operator's normal workflow.
- `window-manager.ts:147-189` had a deliberate single-monitor fallback that disabled `kiosk`, `fullscreen`, `alwaysOnTop`, and made the customer window movable+resizable. On the user's single-monitor dev box this matched the screenshot exactly.

**Changes:**
- `src/main/config/store.ts:178` — added `customerDisplayForceKiosk: boolean` config (default `true`)
- `src/shared/types.ts:218` — added the field to `AgentConfig`
- `src/main/windows/window-manager.ts:147-189` — replaced `hasMultipleDisplays` gating with `useKiosk = isCustomer && (hasMultipleDisplays || forceKiosk)`. Customer display is now true kiosk + fullscreen + alwaysOnTop + frameless + non-movable + non-resizable on single monitor when the flag is on. Esc and 3-finger swipe-down still exit (existing handlers in `CustomerApp.tsx:69-104` and `window-manager.ts:225-246`).
- `src/main/pos/pos-store.ts:193` — `cart/addItem` no longer yanks the customer display out of `checkin`/`interactive`. Cart view only auto-shows from `idle`/`promo`/`cart`.
- `src/main/pos/pos-store.ts:381-389` — `handleTouch` now logs `salonName` and `serviceCategories.length` so we can see at runtime whether salon-mode data is being synced (when both are empty, the customer falls back to the static welcome card instead of the check-in flow).
- `src/renderer/components/Settings.tsx:1620+` — added "Force fullscreen kiosk" toggle in the Customer Display section (state, load, save, dependency wire-up).
- `src/renderer/i18n/translations.ts` — added `settings.customerDisplayForceKiosk` + description in all 7 languages (en/vi/tr/zh/uk/ru/pl).
- `src/renderer/windows/customer/CustomerApp.tsx:1-15` — added a 14-line header comment explaining the state machine and dual-screen intent.

**Build status:** `npm run build:main` clean, `npx tsc -p tsconfig.renderer.json --noEmit` clean.

**Pending verification (user must run live):**
1. Settings → "Force fullscreen kiosk" ON (default) → click Open Customer Display → expect window covers entire screen, taskbar hidden, can't drag with one finger
2. Press Esc → window closes (escape hatch works)
3. Reopen → 3-finger swipe-down from top → window closes (staff exit gesture works)
4. Toggle "Force kiosk" OFF → reopen → expect old windowed (legacy fallback still works for dev machines)
5. With salon-mode synced (salonName + service categories), tap idle screen → expect CheckInView; tap "Browse services" → expect SalonInteractiveView; ring up an item from POS while customer is in interactive → customer should stay in interactive (not jump to cart)
6. Tail combined.log on touch → see new diagnostic log showing salon-data values



---

## Project Overview

**Zira AI Print Agent** — Electron + React + TypeScript desktop app for Windows 10/11. Connects a salon's eNail POS with hardware (thermal printers, barcode scanners, cash drawers).

**Workflow:** User (`kaipizz`) often works remotely via Discord channel `1488850360742182922`. AI makes code changes, screenshots, posts back. Screenshots → `C:\Users\pc\Pictures\zira-screenshots\`.

**Repo:** `https://github.com/KaiPizz/zira-pos.git` — `git pull origin main` at start of each main-machine session if user says to. SESSION_HANDOFF.md is the canonical context file — read first, update at end.

**Key rule:** Don't trust anything blindly. Verify paths, references, config, and test infrastructure against reality.

---

## Dev Environment

```bash
npm run dev          # Vite on localhost:3100 + tsc --watch (run first)
npm run start        # electron . (run after dev is ready)
npm run build        # full build (main + renderer)
npm run build:main   # main process only (tsc)
```

**Restart electron:** `powershell -ExecutionPolicy Bypass -File scripts/kill-electron.ps1` then `npm run dev` then `npm run start`. User shortcut: "chạy lại app".

**Screenshot:**
```powershell
powershell -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $b=New-Object System.Drawing.Bitmap($s.Width,$s.Height); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size); $b.Save('C:\Users\pc\Pictures\zira-screenshots\NNN-desc.png')"
```

**Login bypass (offline mode):** Click email field (~x=655, y=165) → Tab×5 → Enter → Offline Mode → all tabs accessible.

---

## Installed Skills

| Skill | Commands |
|-------|---------|
| **Audit System** | `/audit-app` (master), `/audit-code`, `/audit-architecture`, `/audit-security`, `/audit-ui`, `/audit-functional` |
| **GSD** | `/gsd:*` (50+ commands) |
| **UI/UX Pro Max** | Auto-activates for UI work |
| **ECC Skills (9)** | `/ecc:security-review`, `ecc:e2e-testing`, `ecc:verification-loop`, `ecc:backend-patterns`, `ecc:frontend-patterns`, `ecc:coding-standards`, `ecc:api-design`, `ecc:feature-development`, `ecc:database-migration` |

Auto-activation rules in `CLAUDE.md`. Key triggers: UI → `ui-ux-pro-max` | Auth/IPC → `ecc:security-review` | Main process/DB → `ecc:backend-patterns` | Renderer → `ecc:frontend-patterns`.

---

## Build History (compacted, sessions 1–35)

| Sessions | Area | Summary |
|----------|------|---------|
| 1, 10, 14, 15 | Check-in UI | Full redesign (7 screens), custom touch keyboard, kiosk mode, stats bar/queue toggles |
| 3 | Misc | Tab visibility toggle, app starts maximized, sidebar lang fix, tsconfig fix |
| 6–8 | POS UI | Rose palette, touch targets, cart layout, sidebar width |
| 8–9 | Invoicing | i18n, inline modals replacing native dialogs |
| 11–12, 27–28 | Settings | Toggle switches, save state, SVG icons, 9 security/UX fixes |
| 18, 24–27 | Hardware/Print | Posnet fiscal detection (4-service arch), Zebra calibrate, ESC/POS binary test print, HTML label printing via hidden BrowserWindow, multi-page labels with booking numbers |
| 19–20 | Bug fixes | Codex audit → 9 bugs fixed |
| 21–22 | Audit | Full app audit (`AUDIT_REPORT.md`); see Carried Forward Issues |
| 28 | Security | DPAPI encryption for credentials via safeStorage; dedicated IPC handlers; SET_CONFIG blocks sensitive fields |
| 29 | POS rework | Pill-button category nav, live clock + lang picker in POS header, hidden HID barcode capture, Z-report blik/transfer totals |
| 30 | Universal detection | New `src/main/hardware/detection/` module — UniversalDeviceRegistry (11 brands), UniversalDetectionService, per-driver recovery, health-check, 4 IPC channels |
| 31 | Detection optimization | Dynamic VID list, shared `probeEscPosPort()`, exponential health-check backoff, `classifyPrinterCategory()`, `RecoverableDriver` interface |
| 32–34 | Ghost-printer filter v1→v4 | Iterative fix: true presence via `Get-PnpDevice -PresentOnly`, `ALLOWED_PROTOCOLS_BY_TYPE` matrix, per-device Refresh, Section 2 class allowlist, ghost-name memory, dropdown sources from filtered query, `listSerialPorts()` PnP+Service+WMI intersection |
| 35 | Detection hardening | ACPI COM1 motherboard filter, `LIST_WINDOWS_PRINTERS` no-fallthrough on empty, `reinitializePrinter()` always-register (fix check-in print regression), `onDeviceStatus` auto-refresh listener |

### Session 36 — printer system audit + settings auto-save (2026-04-07)

**1. Printer bug verification:** All 12 bugs from `printerbug.md` verified against codebase — 11/12 confirmed fixed in sessions 32–35. Bug #12 (duplicate Zebra printer names from driver reinstall) was partially unfixed.

**2. Dedup fix for variant printer names (driver-installer.ts):**
- Initial attempt keyed on `(brand, port)` — wrong, because "ZDesigner GK420d (1)" on LPT1: has a different port than "ZDesigner GK420d" on USB001
- Second attempt keyed on `(brand, baseName)` — wrong, would falsely dedup two identical-model printers on different COM ports
- Final fix: only dedup when at least one entry has a `(N)` suffix (Windows reinstall artifact). Two identical-model printers on different ports are preserved. Prefers USB > SERIAL > NETWORK > LPT port quality.

**3. Deep audit (3 parallel agents, ~63 issues found):** Fixed the 6 real bugs:

| Fix | File | Issue |
|-----|------|-------|
| `flushStuckPrintJobs()` removed "Spooling" from stuck-status regex | port-utils.ts | Was deleting active in-progress print jobs |
| `reconnect()` now verifies hardware presence | zebra-driver.ts, thermal-driver.ts | Was blindly setting `connected=true` without checking |
| `RecoverableDriver` interface updated | detection/types.ts | `reconnect()` signature: `void → void \| Promise<void>` |
| React `key={i}` → stable identity key | Settings.tsx | Ghost renders on device list reorder |
| Null-safe `dev.brand`/`dev.model` | Settings.tsx | Prevented "null — undefined" display |
| try-catch on `handleRefreshPorts/Printers` | Settings.tsx | Unhandled IPC errors crashed component |

**4. Auto-rescan on port change (hardware.module.ts):**
- `LIST_PORTS` handler now compares with `lastKnownPorts` and triggers background `rescanKnown()` when ports change (USB plug/unplug)

**5. Settings auto-save (Settings.tsx):**
- Removed Save button and "Settings saved!" banner
- Added debounced auto-save (600ms) via `useEffect` + `useCallback` watching all config state
- Uses `configSyncedRef` to skip initial config→state hydration (prevents save-on-mount)
- Settings that already auto-saved (SSH, remote access, AI, tabs) are unchanged — they fire immediately via inline `onConfigChange()`
- Added `settings.autoSaveHint` translation ("Changes are saved automatically") in all 7 languages
- Subtle footer text replaces the Save button

**Files changed in s36:**
- `src/main/hardware/driver-installer.ts` — dedup variant printer names
- `src/main/hardware/port-utils.ts` — remove "Spooling" from flush regex
- `src/main/hardware/zebra/zebra-driver.ts` — `reconnect()` verifies presence
- `src/main/hardware/thermal/thermal-driver.ts` — `reconnect()` verifies presence
- `src/main/hardware/detection/types.ts` — `RecoverableDriver.reconnect()` signature
- `src/main/modules/hardware.module.ts` — `lastKnownPorts` + auto-rescan
- `src/renderer/components/Settings.tsx` — auto-save, React keys, null safety, error handling
- `src/renderer/i18n/translations.ts` — `settings.autoSaveHint` (7 languages)

**Build:** `tsc main` ✅, `tsc renderer` ✅, `vite build:renderer` ✅
**Status:** NOT COMMITTED. Ready for user testing.

### Session 37 — Customer Display sync fix + light theme redesign (2026-04-07, IN PROGRESS, NOT TESTED, NOT COMMITTED) [updated: CheckInView + SalonInteractiveView redesigned, builds clean] [REOPENED: race fixes were NOT root cause — see "Debug findings" below]

**User report:** POS tab (Retail mode) → click **Display On** → customer window opens but stuck at Welcome/Idle. Adding a product does NOT switch it to Cart. Previously worked, broke recently. Also wants UI redesigned to light/rose/pastel matching POS main.

**Setup:** 1 monitor (dev), Retail mode. Main window renders POSLayout inside POS tab (App.tsx:386), uses preload.ts (not preload-pos.ts).

**Plan file:** `C:\Users\pc\.claude\plans\quizzical-spinning-newell.md`

**Investigation summary:** IPC chain looks correct on paper — POSLayout dispatch → `window.electronAPI.pos.dispatch` → `ipcMain.handle('pos:dispatch')` → `posStore.dispatch(action)` → reducer sets `display.mode='cart'` → `broadcast()` → `webContents.send('pos:state-changed')` to both main window and customer window. All channel strings match. Main window registered in orchestrator.ts:408, customer in window-manager.ts:222. Single posStore instance in container.

**Two real races identified and fixed:**

1. **`dispatch()` clobbered by in-flight `transitionToPromoOrIdle()`** — `pos-store.ts:321-338`. The idle timer (120s default) fires `transitionToPromoOrIdle()` which is async (awaits `promoLoader.getImages()`). If a user-dispatch fires during that await, reducer sets `display.mode='cart'`, broadcasts, BUT the in-flight promise then resolves, sees `token === this.transitionVersion` (nothing bumped it), and overwrites state to `{ mode: 'idle' }` — clobbering the cart. Fix: `dispatch()` now does `this.transitionVersion++` at the top, invalidating any in-flight async transitions.

2. **CustomerApp initial state overwrites fresher broadcast** — `CustomerApp.tsx:125-135`. Original code called `getState().then(setState)` BEFORE `onStateChanged(setState)`. If broadcast arrives between the two, listener fires setState(new), then getState's promise resolves and calls setState(initial) — stale initial wins. **This is the most likely root cause of "stuck at welcome" because it matches the exact symptom: first broadcast after mount gets lost.** Fix: attach listener FIRST, then getState uses functional setState (`prev ?? s`) so it only applies if nothing newer already arrived.

**Diagnostic logs added (still in place, remove after verification):**
- `pos-store.ts` `broadcast()` → logs window count + mode + cart items
- `pos-store.ts` `registerWindow()` → logs window title
- `pos-store.ts` `dispatch()` → promoted from `logger.debug` to `logger.info` so it appears in combined.log regardless of NODE_ENV
- `CustomerApp.tsx` useEffect → logs mount, initial state, each state change

**Important log config finding:** Logger is `level: 'debug'` only when `NODE_ENV === 'development'`. `npm run start` doesn't set NODE_ENV, so production logger filters debug. That's why combined.log never shows Dispatch lines. Anything you want to see during runtime must be `logger.info` or higher.

**UI redesign — Light/rose/pastel (partial):**

| File | Status | Notes |
|---|---|---|
| `IdleView.tsx` | ✅ DONE | `bg-gradient-to-br from-rose-50 via-white to-amber-50`, pastel floating shapes (rose/amber/pink), salon name `text-brand-600`, clock tabular-nums slate-400, subtle divider accent |
| `CartView.tsx` | ✅ DONE | White bg inherited, item rows `border-b border-slate-100`, prices `text-slate-900`, total `text-brand-600 text-6xl`, upsell cards white with brand-500 buttons, `text-brand-500` header label uppercase tracking |
| `ThankYouView.tsx` | ✅ DONE | Emerald check circle (was `✓` text), total `text-brand-600`, QR code in white rounded card with shadow |
| `PromoView.tsx` | ✅ DONE | Bg gradient; dot indicators `bg-brand-500`/`bg-slate-300` |
| `CustomerApp.tsx` | ✅ DONE | Root `bg-gradient-to-br from-white via-rose-50 to-amber-50`, payment status bar `bg-brand-50 border-t border-brand-200 text-brand-700`, ErrorBoundary fallback light theme, interactive fallback light theme |
| `CheckInView.tsx` | ✅ DONE | All 6 steps repainted: welcome (3 white-card action buttons — brand/sky/emerald accents, pastel shapes + brand-400 divider), phone-search (white keypad buttons, brand-400 focus, white result cards), booking-search (white input, brand focus, white result cards), walkin (white input, emerald-400 focus, emerald-500 submit), upsell (white cards with brand-500 selected state + brand-50 bg), confirmed (rose-amber bg, emerald-50 check circle, emerald-600 heading). Back buttons all white/border-slate-200/shadow-sm. |
| `SalonInteractiveView.tsx` | ✅ DONE | Category grid: white cards `bg-white border-slate-200 hover:border-brand-300`, heading `text-brand-600`, arrow slate-300 → brand-500 on hover. Service list: white cards with `bg-rose-50` image placeholder, price `text-brand-600`, "Requested!" state emerald-50/emerald-600/border-emerald-200, active buttons brand-500. Header has white/70 backdrop-blur. |

**Brand color tokens:** Verified `brand-*` palette is rose-tone in `tailwind.config.js` / `index.css`. Safe to use `brand-500/600/700` + `rose-50` + `amber-50` + `slate-*` without introducing new palette.

**Builds:** `npm run build:main` ✅, `npm run build:renderer` ✅. 1859 modules, 6.54s. No TS errors after CheckInView + SalonInteractiveView rewrites.

**Not done / next session TODO:**
1. **TEST the fix** — `scripts/kill-electron.ps1` → `npm run dev` → `npm run start` → login → POS tab → Retail mode → Display On → add product → customer window MUST switch to CartView. Watch logs for `[PosStore] broadcast() → 2 windows, mode=cart` and `[CustomerApp] state changed mode= cart items= 1`.
2. If test confirms fix, **remove all diagnostic logs** added this session:
   - `pos-store.ts` `broadcast()` — the `logger.info('[PosStore] broadcast() → ...')` line
   - `pos-store.ts` `registerWindow()` — the `logger.info('[PosStore] registerWindow: ...')` line
   - `pos-store.ts` `dispatch()` — revert `logger.info` → `logger.debug` on the Dispatch line
   - `CustomerApp.tsx` useEffect — 3 `rlog.info('[CustomerApp] ...')` lines (mount, initial state, state changed)
3. Screenshot all customer display modes (idle, checkin welcome/phone/walkin/upsell/confirmed, interactive category grid + service list, cart, thankyou, promo). **User said NO Discord send this session** — local save only to `C:\Users\pc\Pictures\zira-screenshots\`.
4. Commit everything as one atomic feat commit referencing s37.

**Design tokens used in s37 redesign (reference for future customer-display work):**
- Root bg: `bg-gradient-to-br from-rose-50 via-white to-amber-50` (amber/rose pastel, matches POS tab)
- Cards: `bg-white border border-slate-200 hover:border-brand-300 rounded-xl shadow-sm`
- Primary buttons: `bg-brand-500 hover:bg-brand-600 text-white shadow-sm`
- Inputs: `bg-white border-2 border-slate-200 focus:border-brand-400 placeholder-slate-400`
- Headings: `text-brand-600 tracking-tight` (brand is terracotta #da7756 — NOT pink/rose despite name in prior handoff)
- Dividers/accent: `bg-gradient-to-r from-transparent via-brand-400 to-transparent` (hairline w-20 h-1)
- Semantic colors kept: emerald for success/walk-in, sky for phone (hover accent only), rose-50 for image placeholders
- Spinners: `border-brand-300 border-t-brand-600` (replaces `border-slate-500 border-t-transparent`)
- Header bars: `border-b border-slate-200 bg-white/70 backdrop-blur-sm`

**Brand palette finding:** `tailwind.config.js` defines `brand-*` AND `purple-*` as the SAME terracotta palette (#da7756 base). So class names like `text-purple-400` in legacy code would also render terracotta. Custom `slate-*` is a warm stone-gray, not the default Tailwind blue-gray.

**Known side-finding (out of scope):** Only RetailTemplate has Customer Display button via `<QuickActions>`. SalonTemplate / B2BTemplate / RestaurantTemplate do NOT. This is a real regression but user didn't ask to fix it this session — ask before touching.

**Files modified s37 (uncommitted):**
- `src/main/pos/pos-store.ts` — transitionVersion++ in dispatch, diagnostic logs in broadcast/registerWindow, dispatch log bumped to INFO
- `src/main/modules/pos.module.ts` — IPC trace logs on `pos:get-state` and `display:touch` handlers + new `display:debug-log` ipcMain.on listener (renderer→main log forwarder). **BUILT.**
- `src/preload/preload-display.ts` — added `display.debugLog(msg)` fire-and-forget forwarder via `ipcRenderer.send('display:debug-log', ...)`. **BUILT → dist/preload/preload-display.js is 2132 bytes, verified contains `debugLog`.**
- `src/shared/electron.d.ts` — added optional `display.debugLog?(msg)` type declaration.
- `src/renderer/windows/customer/CustomerApp.tsx` — listener-before-getState race fix, functional setState, light theme root + error boundary + interactive fallback. Added `debugLog` calls on mount (reports electronAPI + display keys), on every state change, on initial getState, and on handleScreenTouch (with typeof(display.touch) + promise resolve/reject logging). **BUILT.**
- `src/renderer/windows/customer/views/IdleView.tsx` — full light repaint
- `src/renderer/windows/customer/views/CartView.tsx` — full light repaint
- `src/renderer/windows/customer/views/ThankYouView.tsx` — full light repaint
- `src/renderer/windows/customer/views/PromoView.tsx` — bg + dot indicator colors
- `src/renderer/windows/customer/views/CheckInView.tsx` — full light repaint across all 6 steps (welcome, phone-search, booking-search, walkin, upsell, confirmed)
- `src/renderer/windows/customer/views/SalonInteractiveView.tsx` — full light repaint (category grid + service list)

---

#### s37 REOPENED — Debug findings after user test (2026-04-07 ~16:30)

User tested s37 build, sent screenshot: customer window opens, shows light-theme IdleView correctly (redesign confirmed working), BUT tapping the customer display does NOT promote out of idle, and adding products in POS tab does NOT switch the customer display to cart. The two "race fixes" were NOT the root cause.

**Evidence read from `%APPDATA%/zira-ai/logs/combined.log`:**

```
16:27:25 Window registered: Customer Display (total: 2)
16:27:31 Escape pressed — window unregistered (total: 1)
16:27:40 Dispatch: display/setMode   ← Display On button works
16:27:40 broadcast → 1 windows, mode=promo
16:27:40 broadcast → 1 windows, mode=idle   ← transitionToPromoOrIdle fallback
...
16:29:05 Customer Display registered (total: 2)   ← window opens
16:29:26 unregistered (total: 1)                  ← user escaped
16:29:30 Dispatch: display/setMode ×3 (3 rapid clicks of Display On)
16:29:36 Customer Display registered (total: 2)   ← reopens 6s later
16:29:46 unregistered                             ← user closed
```

**Finding #1 — `display:touch` IPC is NEVER reaching main:**
No `[PosStore] Customer touch detected` entries appear in combined.log at any time — that log line lives inside `PosStore.handleTouch()` (pos-store.ts:385). This means either:
  (a) the renderer's `onPointerDown={handleScreenTouch}` never fires, OR
  (b) `window.electronAPI.display?.touch?.()` is undefined / no-op on the customer window, OR
  (c) IPC invoke is reaching main but hitting an early return.
We cannot tell (a) vs (b) vs (c) without main-side logging on the handler itself — which is why IPC trace logs were added to pos.module.ts (see next finding).

**Finding #2 — Renderer logger does NOT forward to combined.log:**
`src/renderer/utils/logger.ts` is a plain `console.info/debug/warn/error` wrapper. It has NO IPC bridge to main. So all `rlog.info('[CustomerApp] ...')` lines in CustomerApp.tsx only appear in the customer window's DevTools console — which is invisible to remote debugging. Those diagnostic lines were dead code for our purposes. Either (a) rewrite rlog to forward via `ipcRenderer.send('renderer-log', ...)` + add a main listener that appends to combined.log, or (b) do all cross-process debugging from main-side logs only. **Chose (b) for this investigation** via the new IPC trace logs.

**Finding #3 — Preload IS built correctly:**
Checked `dist/preload/preload-display.js` (1812 bytes, built 16:21) exists. `window-manager.ts:41` loads `preload-display.js` for the customer window. `preload-display.ts:24` exposes `display.touch: () => ipcRenderer.invoke('display:touch')`. Channel strings match. On paper, the chain should work. So the failure is either in the renderer click path or in the IPC invoke failing silently.

**Finding #4 — `cart/addItem` dispatch never fires (secondary mystery):**
Between 16:21:57 and 16:31:36 (the full app run), the ONLY Dispatch entries are `display/setMode` (from the Display On button). NOT ONE `cart/addItem` dispatch. Yet user claimed to "add products". Possible explanations:
- User was in Salon mode, not Retail — Salon product click might go through a different path (e.g. requires staff selection first) and never reach the store dispatch
- User didn't actually add products during testing (just opened Display On and tapped the customer screen)
- Product clicks in the active template are bound to a local handler that was recently refactored and lost the `dispatch` prop
- Worth checking `SalonTemplate.tsx:110` (has `cart/addItem`), `RetailTemplate.tsx:106` (has it), `RestaurantTemplate.tsx:99`, `B2BTemplate.tsx:99` — verify the onClick path actually reaches `handleAddProduct` and that `handleAddProduct` actually calls the `dispatch` prop from POSLayout's `usePosStore()` hook.

**Finding #5 — PosStore is NOT being instantiated twice:**
Only one `[PosStore] Initialized` log entry per app start. Single store, single state. Not a container / DI issue.

**IPC trace logs added (pos.module.ts:80-88, NOT REBUILT):**
```ts
ipcMain.handle('pos:get-state', (e) => {
  const state = this.posStore?.getState();
  logger.info(`[PosModule] IPC pos:get-state from window="${e.sender.getTitle?.() ?? 'unknown'}" → mode=${state?.display?.mode}`);
  return state;
});
...
ipcMain.handle('display:touch', (e) => {
  logger.info(`[PosModule] IPC display:touch from window="${e.sender.getTitle?.() ?? 'unknown'}"`);
  this.posStore?.handleTouch();
  return { success: true };
});
```

**Next-session TODO (DO NOT SKIP — this is the active debug flow):**

0. **ALREADY DONE (mid-session):** `npm run build:main` ✅, `npm run build:renderer` ✅ — both the IPC trace logs and the renderer→main debug forwarder are compiled into dist/. No rebuild needed unless you change code.
1. `scripts/kill-electron.ps1` → `npm run dev` → `npm run start` (or just `npm run start` if dev is running)
2. User test steps:
   a. Login → POS tab → Retail mode (or whichever they tested last time — confirm via Settings)
   b. Click Display On → customer window opens
   c. **Tap the customer display screen (click anywhere on "Welcome!" area)** — this is the failing interaction
   d. Go to POS tab → click any product to add to cart — this is the secondary failing interaction
   e. Close app or Escape customer window
3. Read `%APPDATA%/zira-ai/logs/combined.log` — look for these lines (new log prefixes this round):
   - `[CustomerDisplay-Renderer] (Customer Display) mount — electronAPI keys=[...] display keys=[...]` → proves preload loaded AND lists every exposed method. If `display keys` doesn't contain `touch` → preload bug. If entire line missing → preload didn't load at all.
   - `[CustomerDisplay-Renderer] (Customer Display) state changed mode=... items=...` → proves onStateChanged listener is firing in the customer window.
   - `[CustomerDisplay-Renderer] (Customer Display) handleScreenTouch fired mode=idle typeof(display.touch)=function` → proves the pointerdown event fired AND display.touch is a function (not undefined).
   - `[PosModule] IPC display:touch from window="Customer Display"` → proves the IPC reached the main process.
   - `[CustomerDisplay-Renderer] (Customer Display) display.touch() invoke resolved` → proves the invoke completed.
   - `[PosStore] Customer touch detected, entering checkin/interactive mode` → proves handleTouch did NOT early-return on the mode guard.
   - `[PosStore] Dispatch: cart/addItem` → proves POS tab product click reaches the store (only appears if user clicked a product in POS tab).
4. Diagnose based on which logs appear / don't appear (decision tree, top to bottom):
   - NO `mount — electronAPI keys` line at all → preload-display.js not loaded. Check dist/preload/preload-display.js exists, check window-manager.ts preload path.
   - `mount` line appears BUT `display keys` doesn't contain `touch` → preload export mismatch. Grep preload-display.ts for `touch:`.
   - `mount` line OK but NO `handleScreenTouch fired` when user taps → React pointer handler not bound. Check z-index / pointer-events on IdleView. Maybe the wrap div collapses to 0 size.
   - `handleScreenTouch fired` but `typeof(display.touch)=undefined` → preload contextBridge truncated the object; somehow display.touch got stripped.
   - `handleScreenTouch fired typeof=function` but NO `IPC display:touch` reaches main → sandbox error, contextIsolation issue, or main IPC handler not registered. Check for `invoke rejected` log.
   - `IPC display:touch` reaches main but NO `Customer touch detected` → handleTouch early-returned on mode guard. State mode is NOT idle/promo when tap arrives. Check logged mode in preceding broadcast.
   - `Customer touch detected` appears but customer window still shows idle → onStateChanged listener not firing. Check for `state changed mode=` log with new mode after the touch.
   - No `cart/addItem` ever appears → user didn't actually click a product in POS tab during test, OR they were in Salon mode (click path also dispatches, just verify they tested this).
6. **Do NOT revert the two race fixes** (transitionVersion++ in pos-store.ts, listener-before-getState in CustomerApp.tsx) — they are defensive against a real but rare race and don't cause harm. Leave them.
7. **Do NOT remove the IPC trace logs until the bug is understood.** They are cheap (info level, one line per IPC call) and essential for remote debugging.

**Reminder for next session:** Discord-only operator, so all status must be sent via `mcp__plugin_discord_discord__reply` (chat_id `1488850360742182922`). No terminal output reaches the user.

### Test scripts
- `scripts/test-print-label-electron.js` — real print test: `npx electron scripts/test-print-label-electron.js`

---

## Carried Forward Issues

### From AUDIT_REPORT.md (sessions 21-22)
- **Remove/redesign `run_command` AI tool** — `zira-ai.ts:1131` — Full RCE
- **Fix `open_application` shell injection** — `zira-ai.ts:910`
- **Fix non-null assertions in sync.module** — 4 handlers crash if billiardSync not initialized
- **Split zira-ai.ts** (4,075 lines) into focused modules
- **Add `npm run test`** to CI pipeline

### From earlier sessions
- **P2 #7:** Missing display API methods in preload
- **P2 #8:** Missing billiard feature APIs in preload
- **P2 #9:** Payment timeout race condition
- **P2 #10:** Auto-updater missing error handling
- **P3 #12:** Hooks returning unvalidated `unsub`
- **P4:** No linting, `asar: false`, no code signing, stale files in repo

### From session 36 audit (not fixed — low priority)
- **Dedup edge case:** If user connects two physically identical printers (same brand, same model, neither has `(N)` suffix), dedup won't catch them — but they're genuinely separate devices, so this is correct
- **`detectPaperSize()` reads DEVMODE** — Returns Windows driver cached value, not actual calibration result. Needs ZPL status query to fix properly.
- **No offline/ghost badge in UI** — Backend tracks device status but Settings doesn't render visual indicator. Moot since ghosts are now filtered out entirely.

### Environment issues (not code fixes)
- Python security deps not installed
- Windows activation watermark
