# Zira AI Print Agent — Session Handoff

> Last updated: 2026-04-06 (session 31 — Printer auto-detection optimization) | Read this file at the start of every new session.

---

## Project Overview

**Zira AI Print Agent** — Electron + React + TypeScript desktop app for Windows 10/11.
Connects a salon's eNail POS system with hardware (thermal printers, barcode scanners, cash drawers).
The user (`kaipizz`) works **remotely via Discord** and never sees the POS machine directly.

**Remote workflow:**
- User sends instructions via Discord channel `1488850360742182922`
- AI makes code changes on the POS machine, takes screenshots, sends them back via Discord
- Screenshots saved to: `C:\Users\pc\Pictures\zira-screenshots\` (numbered sequentially)

**Key rule: Don't trust anything too much.** Always verify paths, references, config, and test infrastructure against reality before assuming they're correct. If already verified this session, skip.

---

## GitHub / Multi-Computer Workflow

- Repo: `https://github.com/KaiPizz/zira-pos.git` (pushed 2026-03-31)
- **Start of every session on the main machine:** only run `git pull origin main` before touching any code when the user told — changes may have arrived from another computer
- The user sometimes continues work on a separate machine using Codex or another AI; those sessions commit and push to `main`
- SESSION_HANDOFF.md is the canonical context file — always read it first, always update it at the end

---

## Dev Environment

```bash
npm run dev          # Vite on localhost:3100 + tsc --watch (run first)
npm run start        # electron . (run after dev is ready)
npm run build        # full build (main + renderer)
npm run build:main   # main process only (tsc)
npm run build:renderer  # renderer only (vite build)
```

**Kill + restart Electron:**
```powershell
powershell -Command "Stop-Process -Name 'electron' -Force -ErrorAction SilentlyContinue"
```

**Kill stale Vite processes (if port 3100 is taken):**
```powershell
# Find PID: netstat -ano | grep ":3100 "
powershell -Command "Stop-Process -Id <PID> -Force"
```

**Take screenshot:**
```powershell
powershell -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $b=New-Object System.Drawing.Bitmap($s.Width,$s.Height); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size); $b.Save('C:\Users\pc\Pictures\zira-screenshots\NNN-desc.png')"
```

**Login bypass (offline mode):**
1. Click email field (~x=655, y=165)
2. Tab x 5 -> Enter -> Offline Mode -> all tabs accessible

---

## Installed Skills

| Skill | Commands |
|-------|---------|
| **Audit System** | `/audit-app` (master), `/audit-code`, `/audit-architecture`, `/audit-security`, `/audit-ui`, `/audit-functional` |
| **GSD** | `/gsd:*` (50+ commands) |
| **UI/UX Pro Max** | Auto-activates for UI work |
| **ECC Skills (9)** | `/ecc:security-review`, `ecc:e2e-testing`, `ecc:verification-loop`, `ecc:backend-patterns`, `ecc:frontend-patterns`, `ecc:coding-standards`, `ecc:api-design`, `ecc:feature-development`, `ecc:database-migration` |

Auto-activation rules in `CLAUDE.md` — no need to ask. Key triggers: UI work -> `ui-ux-pro-max` | Auth/IPC -> `ecc:security-review` | Main process/DB -> `ecc:backend-patterns` | Renderer -> `ecc:frontend-patterns`

---

## What Has Been Built

### Sessions 1–28 (compacted)

| Area | Sessions | Summary |
|------|----------|---------|
| **Check-in UI** | s1, 10, 14, 15 | Full redesign (7 screens), custom touch keyboard, kiosk mode, stats bar/queue toggles |
| **POS UI** | s6-8 | Rose palette, touch targets, cart layout, sidebar width |
| **Invoicing** | s8-9 | i18n, inline modals replacing native dialogs |
| **Settings** | s11-12, 27-28 | Toggle switches, save state, SVG icons, 9 security/UX fixes |
| **Hardware / Printing** | s18, 24-27 | Posnet fiscal detection (4-service arch), Zebra calibrate, ESC/POS binary test print, HTML label printing via hidden BrowserWindow, multi-page labels with booking numbers |
| **Security** | s28 | DPAPI encryption for all credentials via safeStorage; dedicated IPC handlers; SET_CONFIG blocks sensitive fields |
| **Bug fixes** | s19-20 | Codex audit → 9 bugs fixed |
| **Misc** | s3 | Tab visibility toggle, app starts maximized, sidebar language fix, tsconfig fix |

### Session 29 — POS UI rework + barcode + shift fix
- Pill-button category nav replacing dropdowns in `RetailTemplate` / `SalonTemplate`; removed Quick Picks
- POS header: live clock, fullscreen button, language picker; kiosk exit (3-finger swipe / Ctrl+Shift+Q)
- Compact 4-per-row `ProductGrid`; fixed i18n key `pos.currentTime`
- Hidden barcode capture input for USB HID scanners (`inputMode="none"`)
- Shift report: added `blikTotal` / `transferTotal` to interface, controller, modal, and Z-report

### Session 30 — Universal printer detection & auto-recovery
- New `src/main/hardware/detection/` module (4 files): types, device registry, detection service, barrel index
- `UniversalDeviceRegistry` — persists to `%APPDATA%/Zira AI/printer-registry.json`; 11 brands; stable IDs; port/name migration history
- `UniversalDetectionService` — `detectAll()`, `rescanKnown()`, `recoverDevice()` with ESC/POS serial probe + Windows brand-match
- `ThermalDriver.recoverPrinter()` — USB brand scan + serial DLE EOT probe
- `ZebraDriver.recoverPrinter()` — zebra/zdesigner pattern match + paper size verify
- `HardwareModule.runHealthCheck()` — recovery for all driver types; auto-updates config
- 4 new IPC channels (`universal-scan/list/rescan/recover`); backward compatible with POSNET channels

### Session 31 — Printer auto-detection optimization
Full optimization pass over the printer detection/recovery architecture. All changes verified with `npm run build`.

**Phase 1 — Quick fixes (high priority):**
- **1A:** Dynamic VID list from `BRAND_PATTERNS` (11 brands) instead of 3 hardcoded VIDs in PnP scan
- **1B:** Extracted shared `probeEscPosPort()` into `port-utils.ts`, used by ThermalDriver + UniversalDetectionService
- **1C:** Health check exponential backoff (30s → 60s → 120s → 300s) for offline printers — reduces log spam

**Phase 2 — Backend classification for UI:**
- **2A:** `DetectedDevice` extended with `targetType` + `recommendedProtocol`, populated by backend `classifyPrinterCategory()`
- **2B:** Renderer `Settings.tsx` uses backend classification instead of duplicating brand heuristics

**Phase 3 — PowerShell overhead reduction:**
- **3A:** Batched Get-Printer + PnP VID scan + COM port lookup into 1 PS script (was 3+ separate PS spawns)
- **3B:** Health check fetches printer/port lists once per cycle, passes cached lists to all drivers

**Phase 4 — Stability & architecture:**
- **4A:** `generateDeviceId()` prefers `usb:VID_PID` for stable IDs across driver reinstalls
- **4B:** Centralized `attemptDriverRecovery()` + `RecoverableDriver` interface with `reconnect()` on all drivers

**Bug fix round (correctness):**
- **Fix 7:** Race condition — `rescanKnown()` now checks `scanning` flag before starting
- **Fix 3:** `driverInstalled` false positive — COM port alone no longer counts as "driver installed"
- **Fix 4+5:** Deleted dead `getWindowsPrinters()` + `getComPortForVid()` (replaced by batch script)
- **Fix 1:** Recovery methods (`recoverPrinter()`/`recoverPort()`) made pure — `reconnect()` is single state mutation point
- **Fix 2:** Cached printer/port lists passed through to recovery methods (zero redundant PS calls)
- **Fix 6:** Legacy drivers now get recovery too (was silently skipped)
- **Zebra paper size:** `reconnect()` re-detects paper size after recovery (lost during pure refactor)
- **POSNET auto-setup:** UI allows auto-setup for devices with COM port even without Windows driver
- **detectBrand():** Unified with `BRAND_PATTERNS` (was hardcoded duplicate)

**Key architectural decisions:**
- `RecoverableDriver` interface in `detection/types.ts` — all drivers implement `reconnect()`
- Recovery methods are pure (return result, don't mutate) → orchestrator calls `reconnect()` → single state mutation point
- `attemptDriverRecovery()` in `hardware.module.ts` centralizes recovery + config update for all driver types

**Files changed:** `driver-installer.ts`, `port-utils.ts`, `detection/types.ts`, `universal-detection-service.ts`, `thermal-driver.ts`, `zebra-driver.ts`, `posnet-driver.ts`, `hardware.module.ts`, `Settings.tsx`, `electron.d.ts`

### Test scripts
- `scripts/test-print-label-electron.js` — real print test: `npx electron scripts/test-print-label-electron.js`

---

## Carried Forward Issues

### Settings — unfixed
- **Inconsistent save behavior** — some settings instant-save (tab visibility, check-in toggles, AI, remote access, SSH), others require Save button (language, printer config, POS). UX inconsistency, needs design decision.

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

### Environment issues (not code fixes)
- Python security deps not installed
- Windows activation watermark
