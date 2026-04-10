# Zira AI Print Agent — Session Handoff

> Last updated: 2026-04-10 (session 45 — Phase 1 log-based sync: client-side check-in + customer sync, dark-launched) | Read this file at the start of every new session.

---

## Session 45 — Phase 1 log-based sync (client-side, dark launch)

**Status:** ✅ SHIPPED client-side, awaiting server endpoints. `npm run build:main` passes clean.

### What changed
- **Migration v13** (`checkin_sync_fields`): adds `synced/backend_id/synced_at` to `checkins`, `synced/synced_at` to `salon_customers` (reuses existing `backend_customer_id` col). Adds `idx_checkin_synced` + `idx_sc_synced`.
- **Repo helpers** on `checkin-repo.ts` + `salon-customer-repo.ts`: `getUnsynced() / markSyncing() / markSynced() / markSyncFailed()` — tri-state pattern (0 pending → 2 in-flight → 1 synced) mirroring `order-repo.ts`.
- **`api-client.ts`**: new `createCheckin()` + `createSalonCustomer()`. Both send `Idempotency-Key: <local_uuid>` and **return `null` on 404/501** (so the sync worker can pause cleanly when server endpoint is not yet deployed).
- **NEW `src/main/sync/checkin-sync.ts`**: `CheckinSync` class, 30 s periodic loop, customers synced before check-ins (FK dependency), endpoint-availability flag that resets on each `socket:connected`.
- **`sync.module.ts`**: instantiates `CheckinSync`, wires `pos:sync:checkins` IPC, adds to reconnect chain, stops on disconnect.
- **`core/tokens.ts`**: new `CHECKIN_SYNC` service token.

### Server contracts the backend team needs to implement
- `POST /api/v1/print-agent/checkins` — body shape: camelCase check-in with services[]. Headers: `Authorization: Bearer …`, `Idempotency-Key: <uuid>`. Response `{ checkinId }`.
- `POST /api/v1/print-agent/salon-customers` — body shape: camelCase customer. Same idempotency contract. Response `{ customerId }`.

### Why dark launch
No user-visible change until server ships the endpoints. Client tries once per reconnect, gets 404, logs a single warn line, pauses. Zero noise. Re-enables automatically when server rolls out.

### Full design context
All architecture decisions, gap analysis, and future phases live in `C:\Users\pc\.claude\plans\snuggly-exploring-wozniak.md` (the cross-session tracking file for the sync project). Read it at the start of any sync-related session.

### Still TODO
- Backend team: implement the two endpoints above (separate repo)
- Phase 2: `booking_number` collision fix for multi-device (currently generates `{count}/DDMM` purely local)
- Phase 3: server → client change feed / catch-up sync after offline window
- Pre-existing bug discovered: `database.clearSalonData()` does NOT clear `salon_customers`, `customer_service_history`, `service_popularity` — these survive salon switches today. Not fixed in this session (out of Phase 1 scope).

---

## Session 44 — Check-in receipt: 1 service per label + QR on last page

**Status:** ✅ SHIPPED (code + typecheck + visual verification done). Needs real-printer smoke test on Zebra hardware.

### What changed
- **Model A (linked multi-label set)**: each service now prints on its OWN 50×30mm label instead of packing up to 3/label.
- **QR code (10×10mm, bottom-right)** added to last label only. Payload = pipe-separated `ZIRA|<bookingNumber>|<phone>|<checkinTime>` — parse via `.split('|')`.
- **Single-service check-in** renders first+last on 1 label: header CHECK-IN + salon + customer + booking# + service + price + TOTAL + staff + 📝 notes + datetime footer + QR.
- **Middle labels** (page 2..N-1) show customer name (small) + page tag + service + "▶ continued... k/N" + NO QR.
- **Label height constraint**: 50×30mm is FIXED — máy in đang dùng giấy này, không đổi.
- **Notes truncation**: > 40 chars → `notes.slice(0,40)+'…'` để fit trên label 30mm.

### Files touched
- `src/main/hardware/pdf/pdf-printer.ts` — imported `qrcode`, added `buildQrPayload` + `generateQrDataUrl`, `buildLabelHtml` is now `async`, new `.qr` CSS (absolute bottom-right), new `.staff-line`, `.has-qr` class reserves right-padding. Removed `getMaxServicesPerLabel` (dead). Exported `buildLabelHtml` so the verify script can call it without Electron.
- `src/main/modules/hardware.module.ts` — `maxPerLabel = 1` hardcoded, removed `getMaxServicesPerLabel` import.
- `src/main/hardware/zebra/zpl-formatter.ts` — `formatCheckinConfirmation` splits 1 service/label, added `buildQrPayload` private helper, added ZPL `^BQN,2,4` QR command + TOTAL row + price per service on last label. Removed `getMaxServicesPerLabel` method.
- `tests/e2e/verify-checkin-label.mjs` — NEW headless Chromium renderer that generates 4 test scenarios (single / first-of-3 / middle / last) and saves PNG previews under `tests/e2e/screenshots/checkin-label-*.png`.

### Verification done
- `npm run build:main` passes (no TS errors).
- `node tests/e2e/verify-checkin-label.mjs` renders 4 labels in Playwright; all 4 PNGs visually correct:
  - Single: full header + service + total + staff + notes + QR ✓
  - Page 1/3: CHECK-IN header + service 1 + "continued 1/3" + no QR ✓
  - Page 2/3: customer (small) + 2/3 + service 2 + "continued 2/3" + no QR ✓
  - Page 3/3: customer + 3/3 + service 3 + TOTAL 260 zł (= 80+120+60 ✓) + staff + notes + QR ✓

### Still TODO
- **Real printer smoke test**: trigger a check-in on the actual Zebra hardware and verify labels physically print + stack correctly (reverse print order means page 1 lands on top).
- **QR scan test**: phone camera scan of printed QR → verify payload format `ZIRA|001/0410|+48...|2026-04-10T...`. Camera shows raw text (not URL) by design (per user choice: structured context not URL).
- **ZPL fallback**: only triggered when HTML print fails. Not exercised in this session's verification. Code-reviewed but not runtime-tested.

### Rollback
- Revert 3 files: `pdf-printer.ts`, `hardware.module.ts`, `zpl-formatter.ts`. No DB migration, no schema change, no new deps (`qrcode` was already in package.json:35).

---

## Session 43 — Investigations (NO CODE CHANGES, decisions pending)

Pure investigation session. No files edited. Two independent items explored and documented so future sessions can act once user decides direction.

### Investigation A — Xprinter XP-80T not detected

**User report:** Plugged in new Xprinter XP-80T thermal printer. App doesn't detect it. Windows Device Manager also seems to not show it.

**Root cause is split into two independent layers. Layer 1 must be fixed by the user before Layer 2 code work is useful.**

#### Layer 1 — Windows itself doesn't see the device (gating)
The entire detection pipeline in `src/main/hardware/driver-installer.ts:getPosnetDriverStatus()` relies on `Win32_Printer` + `Get-PnpDevice -PresentOnly`. If Device Manager is blind to the device, code changes can't help.

Likely causes for XP-80T:
1. **No driver installed** → device shows as "Unknown device" under "Other devices" (yellow `!`) in `devmgmt.msc`, not under "Printers". Install driver from xprintertech.com or rely on Windows generic USB Printing Support.
2. **Interface mode wrong** → XP-80T has USB/Serial/LAN modes. Self-test (hold FEED while powering on) prints current mode. If not USB, the USB cable won't enumerate.
3. **No mains power** → thermal printers sometimes refuse USB enumeration without the power adapter.
4. **Old conflicting driver** → leftover thermal driver from a previous printer. Clean with `printui /s /t2`.

**User action needed:** run self-test, open `devmgmt.msc`, look for XP-80T under Printers OR Other devices. If present, open Properties → Details → "Hardware IDs" and share the `VID_xxxx&PID_xxxx` string. That's the only unknown for Layer 2.

#### Layer 2 — Code gap: Xprinter not in `BRAND_PATTERNS`
`src/main/hardware/detection/types.ts:111` — current brand list: POSNET, Zebra, Epson, Star Micronics, Citizen, Bixolon, DYMO, Brother, HP, Canon, Samsung. **Xprinter is absent.**

Consequences traced through the pipeline:
- **Section 1 (Win32_Printer)** at `driver-installer.ts:118-142` does NOT filter by brand. Any installed Xprinter spooler entry is still caught. `detectBrand()` at `driver-installer.ts:629` returns `'Unknown'` (via fallthrough), device gets registered. Works but no auto-assign to RECEIPT slot and no branded recovery.
- **Section 2 (USB PnP VID scan)** at `driver-installer.ts:159-186` iterates ONLY VIDs from `ALL_PRINTER_VIDS = BRAND_PATTERNS.flatMap(bp => bp.vids)`. Xprinter VID not in list → CDC / serial-only Xprinter models are **invisible** to this scan.
- **Recovery flow** at `universal-detection-service.ts:237` does `BRAND_PATTERNS.find(bp => bp.brand === device.brand)`. Returns null for Xprinter → device cannot recover after unplug/replug.

**Fix plan (execute after Layer 1 is resolved and VID is known):**

1. Add entry to `BRAND_PATTERNS` in `src/main/hardware/detection/types.ts:111`:
   ```ts
   {
     brand: 'Xprinter',
     namePatterns: ['xprinter', 'xp-', 'xp_', 'pos-80', 'pos80', 'xp80'],
     vids: [/* fill from Device Manager — common XP-80T candidates:
             '0483' (STMicro), '1A86' (CH340), '28E9' (GD32),
             '0416' (Winbond), '6868', '0519' */],
     defaultProtocol: 'THERMAL',
     defaultType: 'RECEIPT',
   },
   ```
2. Rebuild main: `npm run build:main`.
3. Verify flow in Settings → Detect Printers → expect XP-80T with brand=`Xprinter`, protocol=`THERMAL`, slot=`RECEIPT`, `autoSetupEligible=true`.
4. Test ESC/POS print via `thermal-driver.ts` — XP-80T is standard ESC/POS so no custom protocol needed, only the Windows printer name.
5. Screenshot Settings printer list + print test result.

**Related prior context (carried from memory):** Dynamic Printer Detection UI WIP — per-device actions in Settings instead of hardcoded POSNET buttons. The Xprinter addition should fit into that model cleanly.

**Status:** BLOCKED on user diagnosing Layer 1. No code changes until user confirms Windows sees the device and shares VID/PID.

---

### Investigation B — "POS display on" vs "Check-in (external)" overlap

**User confusion:** Two customer-display flows appear to do the same thing — both let the customer enter name + phone and pick services. Why are there two?

**Finding — not two tabs, two modes of one window.**
`CustomerApp.tsx` (`src/renderer/windows/customer/CustomerApp.tsx`) is a single state machine. Mode is driven by `PosStore` in `src/main/pos/pos-store.ts`:
- `idle` / `promo` — salon branding / promo slideshow
- `checkin` — `CheckInView`
- `interactive` — `SalonInteractiveView`
- `cart` — `CartView`
- `thankyou` — `ThankYouView`

Transition rules (from `pos-store.ts`):
- `handleTouch()` at line 387 — when customer taps `idle`/`promo`: chooses `checkin` if `salonName || serviceCategories.length > 0`, else `interactive`.
- `handleBrowseFromCheckin()` at line 460 — from `checkin`, "Browse services" button → `interactive`.
- `handleBackToCheckin()` at line 447 — from `interactive`, back button → `checkin`.

The two modes link bidirectionally.

**The overlap is real.** Both views independently implement a walk-in entry flow. Comparison:

| Feature | `CheckInView` (checkin mode) | `SalonInteractiveView` (interactive mode) |
|---|---|---|
| Walk-in name entry | ✅ `walkInName` input | ✅ `walkInName` input in `handoff` step |
| Phone entry (optional) | ✅ | ❌ |
| Service selection | ✅ `WalkInServicePicker` | ✅ via catalog browse |
| Confirm → create check-in record | ✅ | ✅ |
| Upsell step | ✅ | ❌ |
| Existing booking lookup (by phone) | ✅ | ❌ |
| Menu / category browse | ❌ | ✅ catalog → category |

`SalonInteractiveView` is effectively a stripped-down `CheckInView`: same walk-in outcome, minus phone/upsell/booking-lookup, plus catalog browse.

**Historical explanation from code archaeology:**
1. Originally `SalonInteractiveView` was a pure menu browser — no check-in.
2. Dead-end UX problem: "customer browses, then what?" Team added a `handoff` step so the customer could check in directly from the catalog.
3. Result: both views now independently implement walk-in name entry → service → confirm → check-in. Duplicated logic, duplicated i18n, duplicated validation, duplicated keyboard handling.

**Two refactor directions — DECISION PENDING (user will pick after team meeting):**

**Option A — Merge (recommended):** Remove the `handoff` step from `SalonInteractiveView`; it becomes browse-only. When customer wants to check in from the catalog, bounce back to `CheckInView` walkin step with pre-selected services carried through `pos-store`. Single walk-in flow, single source of truth.
- Pros: ~150 lines of duplicated logic removed, single place to maintain walk-in UX + i18n + analytics + validation
- Cons: ~1 day refactor, requires state handoff between modes (pass `selectedServices` through `pos-store`)

**Option B — Separate roles clearly:** Define `checkin` = structured entry (booking lookup OR walk-in with staff assign), `interactive` = self-serve catalog preview ONLY, no check-in capability. Drop the `handoff` step entirely.
- Pros: minimal refactor, clearer mental model
- Cons: loses the "browse → check in directly" UX; customer must backtrack to `checkin` hub to actually commit

**Files that would change either way:**
- `src/renderer/windows/customer/views/SalonInteractiveView.tsx` — remove or reshape `handoff` logic
- `src/renderer/windows/customer/views/CheckInView.tsx` — Option A only: accept pre-selected services prop
- `src/main/pos/pos-store.ts:460` — Option A only: `handleBrowseFromCheckin` signature carries services
- `src/renderer/i18n/translations.ts` — remove `handoff`-only strings
- `src/renderer/windows/customer/components/WalkInServicePicker.tsx` — may need to accept initial selection (Option A)

**Shared refactor prerequisites (both options):**
- Confirm no deep links to `interactive` mode from outside the customer display that rely on the current handoff behavior
- Check analytics events for `display/interactive/handoff` — need to update if renamed

**Status:** AWAITING USER DECISION. Do not touch either view until user picks A or B. When fix starts, create a `.planning/` phase doc via `/gsd:plan-phase` first.

---

## Session 42 — Customer display: ConfirmedReceiptView refactor + UX polish + idle timer fix

### 1. Extract shared `ConfirmedReceiptView`
- New `src/renderer/windows/customer/components/ConfirmedReceiptView.tsx` — handles both walk-in (services[]) and booking (detail fallback) cases.
- Swapped into `CheckInView.tsx` and `SalonInteractiveView.tsx`, removed duplicate `ConfirmedIcon`/`ReceiptMetric`/`StatusCard` helpers.

### 2. Redesign confirmed receipt layout
- Old layout repeated `t('checkin.pleaseWait')` 4× + metrics 3× + redundant sidebar.
- New 2-column: **left** = badge + name + 3 metrics + "next step" banner, **right** = scrollable services list (or booking detail fallback). Each fact exactly once. Deleted `StatusCard`.

### 3. Fix booking step duplicate UI
- `CheckInView.tsx` booking step — removed duplicate "Search by name..." subtitle (already in input placeholder), removed duplicate "No bookings found" + "Continue as walk-in" from empty state. Right panel now 3 clean states: walk-in CTA (no results) / "Select a booking" prompt (results exist) / detail+check-in (selected).

### 4. Scroll-to-top on category change
- `WalkInServicePicker.tsx` + `SalonInteractiveView.tsx` — `serviceListRef` + `useEffect` resets scroll when `selectedCategoryId` changes.

### 5. Idle timer bug — auto-jump to idle while actively using
- `SalonInteractiveView.tsx:32` still had stale `INTERACTION_TIMEOUT_MS = 30_000` (s41 only updated CheckInView + backend to 90s). Bumped to 90s.
- `CustomerDisplayShell.tsx` only had `onPointerDown` — long scrolls without lifting finger never reset timer. Added throttled `onPointerMove` (5s interval).

**Files:** `ConfirmedReceiptView.tsx` (new), `WalkInServicePicker.tsx`, `CustomerDisplayShell.tsx`, `CheckInView.tsx`, `SalonInteractiveView.tsx`.
**Verify:** `npm run build:renderer` ✅ (1866 modules), `npm run build:main` ✅. Operator confirmed visually.
**Git:** NOT committed, NOT pushed.

---

## Session 41 — Customer Display Select Services: idle timeout + cramped basket

**User report:** Customer display auto-jumps to idle while customer still choosing services; "Selected Services" box cramped, showing ~1 row with 2 services.

**Root causes:**
1. **Idle timeout too short** — 30s in both `CheckInView.tsx:66` and `pos-store.ts:535`. Not enough time to read service names/prices across categories. Bumped to 90s both ends.
2. **Cramped summary box** — 340px column, `min-h-0 flex-1` with no min-height, duplicate DetailRow.

**Fixes applied:**
- `CheckInView.tsx` — timeout 30s → 90s, right column 340px → 400px, removed duplicate DetailRow, enlarged rows (`p-5 → p-6`, `text-base → text-lg`, `text-sm → text-base`).
- `pos-store.ts:535` — `resetInteractionTimer()` hardcoded 30000 → 90000 with sync comment.

**Then 4 follow-up fixes after operator feedback:**
- **Fix 3** — Selected Services box overflowed Panel border when keyboard open. Rewrote to match Browse services pattern exactly (no nested card, `text-sm font-medium`, `px-4 py-3 bg-slate-50/80`, 340px column).
- **Fix 4** — Walk-in services list didn't scroll. Root cause: `WalkInServicePicker` was wrapped in plain `<div>` breaking flex chain. Removed wrapper so picker sits directly in grid.
- **Fix 5** — Keyboard open pushed total price outside Panel. Added `overflow-hidden` to Panel, wrapped header+details+list into single scroll container, `shrink-0` on total/button row. Applied to both `CheckInView.tsx` walkin AND `SalonInteractiveView.tsx` browse.
- **Fix 6** — Click-through bug: tap on idle/promo `onPointerDown` triggered backend mode change, then the same physical tap's `pointerup`/`click` landed on "I have booking" in the newly-rendered hub. Fix: `CustomerApp.tsx:195,206` — `onPointerDown` → `onClick` (fires after `pointerup` completes, no ghost click).

**Also attempted (reverted):** Started extracting `ConfirmedReceiptView` shared component, ran out of context, reverted. → Done in s42.

**Files:** `CheckInView.tsx`, `SalonInteractiveView.tsx`, `CustomerApp.tsx`, `pos-store.ts`.
**Verify:** builds ✅, operator confirmed visually.

---

## Session 40 — Printer regression fix + printer settings persistence

**Phase 1 issues:** App burned CPU while idle; `Multi-printer` toggle flipped itself back off; `Detect Printers` returned no devices with 2 printers connected.

**Phase 1 root causes:**
- `multiPrinter` mode wasn't persisted as its own flag — inferred from printer map. Empty map + toggle ON → sync pulled it back to OFF.
- Printer fields were in the generic Settings auto-save payload → unrelated setting changes emitted `config:changed` → reinitialized hardware.
- Detection was over-filtering: trusted strict COM filtering too much, hid serial-only thermal devices with no spooler entry.

**Phase 1 fixes:**
- Added persisted `multiPrinterMode` to config types + store + migration. `HardwareModule` uses it as source of truth.
- `listSerialPorts()` falls back to raw registry COM ports when strict PnP/WMI filter returns empty.
- `getPosnetDriverStatus()` returns `serialPorts` + `windowsPrinters`, exposes serial-only devices as `Generic Serial`, marks manual-only with `autoSetupEligible: false`.
- `LIST_WINDOWS_PRINTERS` returns filtered detection snapshot with raw spooler fallback.
- Health checks use one cached snapshot per cycle.
- Settings detection unified to one refresh path.

**Phase 2 issue:** Leaving Settings tab reset printer assignments / detected devices / label size to defaults.

**Phase 2 root cause:** Earlier refactor removed printer state from generic auto-save, but only left manual local state in `Settings.tsx`. Settings unmounts on tab switch → pending edits lost.

**Phase 2 fixes:**
- Dedicated printer auto-save pipeline with its own debounce, separate from general auto-save.
- Final flush on `Settings` unmount.
- In-flight / pending-save guards, failed-signature guard (stops retry loop).

**Files:** `types.ts`, `store.ts`, `port-utils.ts`, `driver-installer.ts`, `thermal-driver.ts`, `zebra-driver.ts`, `hardware.module.ts`, `Settings.tsx`.
**Verify:** `npm run build` ✅, vitest `98 passed`. User-confirmed: detection working, multi-printer stable, tab switch no longer resets.
**Git:** NOT committed.

**Dirty worktree note carried forward:** Unrelated changes in `window-manager.ts`, `CheckInView.tsx`, `checkin-view.test.ts`, `window-manager.test.ts` — don't revert.

---

## Session 39 — Display On concierge redesign + scoped cleanup

**Goal:** Redesign post-`Touch to explore` customer display flow as a concierge arrival (Check in with phone / I have booking / Walk in / Browse services), add Display On language switch independent of POS, clean up dead code in customer-display scope only (NOT repo-wide).

**Behavior changes:**
- Independent `customerDisplayLanguage` config; fallback order `customerDisplayLanguage → posLanguage → language`. Changing Display On language doesn't affect POS.
- Persistent language dropdown in Display On shell matching POS style.
- Post-idle home: primary = Check in with phone / I have booking, secondary = Walk in / Browse services.
- Browse services = catalog + handoff (not a second main selection engine). ← **this created the overlap investigated in s43**
- Walk in = identity first, then service choice.
- Phone check-in: keypad, live results, walk-in fallback.
- Booking lookup: faster search, shorter confirmation.

**UX polish during follow-up iterations:** language dropdown z-index fix, back navigation on Browse services, clearer copy ("10 services" / "From PLN 5.00" instead of "10 / PLN 5.00"), grouped 9-digit phone display, 9-digit cap.

**Files added:** `customer-display-model.ts`, `CustomerBookingCard.tsx`, `CustomerDisplayPrimitives.tsx`, `CustomerDisplayShell.tsx`, `WalkInServicePicker.tsx` (all in `src/renderer/windows/customer/`).

**Scoped cleanup:**
- Deleted dead `InteractiveView.tsx` and `UpsellStrip.tsx`.
- Removed dead `maxDuration` from browse summary model.
- Removed temporary debug bridge/instrumentation from preload/types/pos.module.ts/CustomerApp.tsx.
- Added `.superpowers/` to `.gitignore`.

**Verify:** vitest `106 passed`, `npm run build` ✅.
**Git:** Merged to main before user's no-auto-commit preference — `e247b61` + `8e425cf`. Future work stays local until user approves.

---

## Session 38 — Customer display: true kiosk + restored flow visibility

**User report:** "What is Display On for? Before it had phone/services/payment like check-in. Now only payment. Also not fullscreen — I can drag with one finger."

**Diagnosis:**
- Customer window is a state machine (idle/promo/checkin/interactive/cart/thankyou) in `CustomerApp.tsx` — customer-facing twin of check-in tab.
- `pos-store.ts` `cart/addItem` reducer was forcing `display.mode = 'cart'` unconditionally → every POS item add jumped past idle/checkin/interactive into cart. Pre-cart flow unreachable.
- `window-manager.ts:147-189` had single-monitor fallback disabling kiosk/fullscreen/alwaysOnTop + making window movable+resizable. On 1-monitor dev machines this matched the reported symptom exactly.

**Changes:**
- `store.ts:178` — new `customerDisplayForceKiosk: boolean` config, default `true`.
- `types.ts:218` — added to `AgentConfig`.
- `window-manager.ts:147-189` — replaced `hasMultipleDisplays` gating with `useKiosk = isCustomer && (hasMultipleDisplays || forceKiosk)`. Customer window now true kiosk + fullscreen + alwaysOnTop + frameless + non-movable on single monitor when flag is on. Esc + 3-finger swipe-down still exit.
- `pos-store.ts:193` — `cart/addItem` only auto-shows cart from `idle`/`promo`/`cart`, never yanks out of `checkin`/`interactive`.
- `pos-store.ts:381-389` — `handleTouch` logs `salonName` + `serviceCategories.length` so runtime shows whether salon-mode data is synced.
- `Settings.tsx:1620+` — "Force fullscreen kiosk" toggle in Customer Display section.
- `translations.ts` — `settings.customerDisplayForceKiosk` + description, all 7 languages.
- `CustomerApp.tsx:1-15` — 14-line header comment explaining state machine.

**Build:** ✅ both sides. Resolves the s37 "stuck at welcome" debugging effort.

---

## Session 37 — Customer Display sync fix (RESOLVED in s38)

**Issue:** POS tab → Display On → customer window stuck at Welcome/Idle. Adding POS product didn't switch to Cart. Light-theme redesign requested alongside.

**Full-light-theme repaint across customer display** — DONE:
- `IdleView.tsx`, `CartView.tsx`, `ThankYouView.tsx`, `PromoView.tsx`, `CustomerApp.tsx`, `CheckInView.tsx` (all 6 steps), `SalonInteractiveView.tsx` (category grid + service list).
- Design tokens established: root `bg-gradient-to-br from-rose-50 via-white to-amber-50`; cards `bg-white border-slate-200 hover:border-brand-300 rounded-xl shadow-sm`; primary buttons `bg-brand-500 hover:bg-brand-600`; inputs focus `border-brand-400`; headings `text-brand-600 tracking-tight`; semantic colors emerald=success, sky=phone hover, rose-50=image placeholders.
- **Brand palette finding:** `brand-*` is terracotta `#da7756` (NOT rose/pink despite name). `purple-*` in Tailwind config is the SAME palette.

**Race / sync fixes attempted:**
1. `pos-store.ts:321-338` — `dispatch()` now does `transitionVersion++` at top to invalidate in-flight async `transitionToPromoOrIdle()` promises that would otherwise clobber state after their await resolved.
2. `CustomerApp.tsx:125-135` — listener-before-getState race: original attached `onStateChanged` AFTER `getState().then(setState)`, so a broadcast arriving between calls could be clobbered by the stale initial `getState` result. Fixed: attach listener first, `getState` uses functional setState `prev ?? s`.

**Neither race was actually the root cause** — turned out to be the reducer in `pos-store.ts` unconditionally forcing `mode='cart'` on `cart/addItem` (fixed in s38). Race fixes were kept anyway as defensive: they protect against a real but rare scenario.

**Dead-code investigation dead-end:** Discovered `src/renderer/utils/logger.ts` is just `console.*`, has no IPC bridge to main → `rlog.info` calls in CustomerApp.tsx are invisible to combined.log and to remote debugging. All cross-process debug must use `logger.info` on main side.

**Known side-finding (carried forward, out of scope):** Only `RetailTemplate` has Customer Display button via `<QuickActions>`. `SalonTemplate` / `B2BTemplate` / `RestaurantTemplate` do NOT. Real regression but user hasn't asked to fix it.

---

## Session 36 — Printer system audit + settings auto-save

**1. Printer bug verification.** All 12 bugs from `printerbug.md` verified against codebase; 11/12 confirmed fixed in s32–s35. Bug #12 (duplicate Zebra printer names from driver reinstall) partially unfixed → addressed below.

**2. Dedup variant printer names (`driver-installer.ts`):** Only dedup when at least one entry has a `(N)` suffix (Windows reinstall artifact). Two identical-model printers on different COM ports are preserved. Port-quality priority USB > SERIAL > NETWORK > LPT.

**3. Deep audit (3 parallel agents, ~63 issues), 6 real bugs fixed:**

| Fix | File | Issue |
|-----|------|-------|
| `flushStuckPrintJobs()` removed "Spooling" from regex | `port-utils.ts` | Was deleting active print jobs |
| `reconnect()` verifies hardware presence | `zebra-driver.ts`, `thermal-driver.ts` | Was blindly setting `connected=true` |
| `RecoverableDriver.reconnect()` sig: `void → void\|Promise<void>` | `detection/types.ts` | Allow async verify |
| React `key={i}` → stable identity | `Settings.tsx` | Ghost renders on device list reorder |
| Null-safe `dev.brand`/`dev.model` | `Settings.tsx` | "null — undefined" display |
| try-catch on `handleRefreshPorts/Printers` | `Settings.tsx` | IPC errors crashed component |

**4. Auto-rescan on port change:** `LIST_PORTS` compares with `lastKnownPorts`, triggers background `rescanKnown()` on USB plug/unplug.

**5. Settings auto-save:** Removed Save button + "Settings saved!" banner. Added 600ms debounced auto-save via `useEffect`. `configSyncedRef` skips initial hydration. SSH/remote/AI/tab settings already auto-save inline. `settings.autoSaveHint` translation in 7 languages.

---

## Project Overview

**Zira AI Print Agent** — Electron + React + TypeScript for Windows 10/11. Connects salon eNail POS with hardware (thermal printers, barcode scanners, cash drawers).

**Workflow:** User (`kaipizz`) works remotely via Discord channel `1488850360742182922`. AI edits code, screenshots, posts back. Screenshots → `C:\Users\pc\Pictures\zira-screenshots\`.

**Repo:** `https://github.com/KaiPizz/zira-pos.git`. SESSION_HANDOFF.md is canonical — read first, update at end.

**Key rule:** Don't trust blindly. Verify paths, references, config, test infrastructure against reality.

---

## Dev Environment

```bash
npm run dev          # Vite on localhost:3100 + tsc --watch (run first)
npm run start        # electron . (run after dev is ready)
npm run build        # full build (main + renderer)
npm run build:main   # main process only (tsc)
```

**Restart electron:** `powershell -ExecutionPolicy Bypass -File scripts/kill-electron.ps1` then `npm run dev` then `npm run start`. User shortcut: "chạy lại app".

**Screenshot (main screen):**
```powershell
powershell -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $b=New-Object System.Drawing.Bitmap($s.Width,$s.Height); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size); $b.Save('C:\Users\pc\Pictures\zira-screenshots\NNN-desc.png')"
```

**Customer display screenshot:** `tests/e2e/screenshot-pos.mjs` (Playwright).

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
| 18, 24–27 | Hardware/Print | Posnet fiscal detection (4-service arch), Zebra calibrate, ESC/POS binary test, HTML label via hidden BrowserWindow, multi-page labels with booking numbers |
| 19–20 | Bug fixes | Codex audit → 9 bugs fixed |
| 21–22 | Audit | Full app audit (`AUDIT_REPORT.md`); see Carried Forward Issues |
| 28 | Security | DPAPI encryption via safeStorage; dedicated IPC handlers; SET_CONFIG blocks sensitive fields |
| 29 | POS rework | Pill-button category nav, live clock + lang picker in POS header, hidden HID barcode capture, Z-report blik/transfer totals |
| 30 | Universal detection | New `src/main/hardware/detection/` module — UniversalDeviceRegistry (11 brands), UniversalDetectionService, per-driver recovery, health-check, 4 IPC channels |
| 31 | Detection optimization | Dynamic VID list, shared `probeEscPosPort()`, exponential health-check backoff, `classifyPrinterCategory()`, `RecoverableDriver` interface |
| 32–34 | Ghost-printer filter v1→v4 | Iterative fix: true presence via `Get-PnpDevice -PresentOnly`, `ALLOWED_PROTOCOLS_BY_TYPE` matrix, per-device Refresh, Section 2 class allowlist, ghost-name memory, dropdown sources from filtered query, `listSerialPorts()` PnP+Service+WMI intersection |
| 35 | Detection hardening | ACPI COM1 motherboard filter, `LIST_WINDOWS_PRINTERS` no-fallthrough on empty, `reinitializePrinter()` always-register (fix check-in print regression), `onDeviceStatus` auto-refresh listener |

---

## Active Decisions Pending

| Item | Source | Blocked on |
|---|---|---|
| **Xprinter XP-80T support** | s43 Investigation A | User runs Device Manager, shares VID/PID, confirms Layer 1 resolved |
| **Customer display walk-in flow unify vs separate** | s43 Investigation B | User team meeting decision (Option A merge vs Option B separate) |

---

## Carried Forward Issues

### From AUDIT_REPORT.md (sessions 21–22)
- **Remove/redesign `run_command` AI tool** — `zira-ai.ts:1131` — Full RCE risk
- **Fix `open_application` shell injection** — `zira-ai.ts:910`
- **Fix non-null assertions in `sync.module`** — 4 handlers crash if billiardSync not initialized
- **Split `zira-ai.ts`** (4,075 lines) into focused modules
- **Add `npm run test`** to CI pipeline

### From earlier sessions
- **P2 #7:** Missing display API methods in preload
- **P2 #8:** Missing billiard feature APIs in preload
- **P2 #9:** Payment timeout race condition
- **P2 #10:** Auto-updater missing error handling
- **P3 #12:** Hooks returning unvalidated `unsub`
- **P4:** No linting, `asar: false`, no code signing, stale files in repo

### From session 36 audit (not fixed — low priority)
- **Dedup edge case:** Two physically identical printers (same brand/model, neither has `(N)` suffix) won't be deduped — but they're genuinely separate devices, so correct behavior.
- **`detectPaperSize()` reads DEVMODE** — Returns Windows driver cached value, not actual calibration result. Needs ZPL status query.
- **No offline/ghost badge in UI** — Backend tracks device status but Settings doesn't render visual indicator. Moot since ghosts are now filtered out entirely.

### From s37 (carried forward)
- **Customer Display button only in `RetailTemplate`** — `SalonTemplate` / `B2BTemplate` / `RestaurantTemplate` don't have `<QuickActions>` with Customer Display button. Real regression, user hasn't approved fix.

### Environment issues (not code fixes)
- Python security deps not installed
- Windows activation watermark

### Test scripts
- `scripts/test-print-label-electron.js` — real print test: `npx electron scripts/test-print-label-electron.js`
- `tests/e2e/screenshot-pos.mjs` — Playwright screenshot for customer display

---

## Dirty worktree on main (carry forward to next session)

Files with uncommitted changes per current `git status`:
- `src/main/modules/auth.module.ts`
- `src/main/modules/hardware.module.ts`
- `src/main/modules/pos.module.ts`
- `src/main/pos/pos-store.ts`
- `src/preload/preload-display.ts`
- `src/renderer/hooks/usePosStore.ts`
- `src/renderer/windows/customer/CustomerApp.tsx`
- `src/renderer/windows/customer/views/CheckInView.tsx`
- `src/renderer/windows/customer/views/SalonInteractiveView.tsx`
- `src/shared/electron.d.ts`

These span s40/s41/s42 work. Do not casually revert.
