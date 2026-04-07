# Zira AI Print Agent — Session Handoff

> Last updated: 2026-04-07 (session 35 — printer detection hardening + health-check UI + reinit resilience) | Read this file at the start of every new session.

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

## Build History (compacted, sessions 1–32)

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
| 30 | Universal printer detection | New `src/main/hardware/detection/` module — `UniversalDeviceRegistry` (11 brands, persists to `printer-registry.json`), `UniversalDetectionService` (`detectAll/rescanKnown/recoverDevice`), per-driver `recoverPrinter()`, `runHealthCheck()`, 4 IPC channels |
| 31 | Detection optimization | Dynamic VID list from BRAND_PATTERNS, shared `probeEscPosPort()` in port-utils, exponential health-check backoff, backend `classifyPrinterCategory()` for UI, batched PowerShell, stable `usb:VID_PID` IDs, `RecoverableDriver` interface, recovery race-condition + dead-code fixes |
| 32 | 11-bug printer fix pass | True presence detection (`Get-PnpDevice -PresentOnly`), driver `connect()` requires hardware verify, `printRaw()` pre/post-flight queue check, `ALLOWED_PROTOCOLS_BY_TYPE` matrix, A4 path uses `Out-Printer` instead of ESC/POS, per-device "Refresh" button. NOT shipped — ghost printers still appeared in test |
| 33 | Ghost filter v3 | Switched Section 1 from CSV to PRT/PNP line-prefix parser; added `PNPDeviceID` lookup against `Get-PnpDevice -PresentOnly` hashset. Caught most ghosts but Section 2 still resurrected dropped names via HP USB hub PnP hits, and the dropdown bypassed the filter entirely |

### Session 35 — printer detection hardening + health-check UI + reinit resilience (2026-04-07)

**User tested all 5 printers through full plug/unplug/swap cycle. Phases 1–4 passed. Phase 5 (health-check auto-recovery) and a check-in print regression found.**

**Three bugs fixed:**

1. **`LIST_WINDOWS_PRINTERS` fallthrough to ghosts (hardware.module.ts)** — When `getPosnetDriverStatus()` returned 0 present devices (correct — nothing plugged in), the IPC handler fell through to the legacy unfiltered `listWindowsPrintersDetailed()`, resurrecting ghost printers in the dropdown. **Fix:** Return empty list directly when the filtered query succeeds but finds 0 devices. Legacy fallback only triggers if `getPosnetDriverStatus()` throws.

2. **COM1 motherboard phantom (port-utils.ts)** — `listSerialPorts()` v2's PnP+Service+WMI intersection still passed COM1 because it's a real ACPI motherboard serial header (`ACPI\PNP0501\1`) with `Service=Serial` and a `Win32_SerialPort` row. The port appears "present" even with nothing connected. **Fix:** PowerShell now also emits each port's `InstanceId`. JS filter drops any port whose InstanceId starts with `ACPI\` (motherboard headers). Only USB-connected ports are kept. Log: `Dropped phantom COM port(s): COM1(acpi-motherboard)`.

3. **`reinitializePrinter()` silently lost drivers on transient connect failure (hardware.module.ts)** — When a config save (e.g., changing label dimensions) triggered `reinitializePrinter()`, if `connect()` failed (printer briefly unavailable, PowerShell timeout, etc.), the driver was never added to `this.printers`. The health check couldn't recover it since it only monitors registered drivers. Test print still worked because `testPrinterByConfig` creates a fresh driver. **Root cause of "check-in print stopped after label size change".** **Fix:** Driver is now always registered in `this.printers` regardless of `connect()` result. Health check (30s) detects when the printer becomes available and marks it connected.

4. **Settings UI didn't reflect health-check changes (Settings.tsx)** — Health check ran correctly in backend, sent `DEVICE_STATUS` events, but Settings.tsx never listened. Printer lists only refreshed on manual "Detect Printers" click. **Fix:** Added `onDeviceStatus` listener that auto-refreshes COM ports, Windows printers, and detection status whenever the health check detects a change.

**Files changed:**
- `src/main/modules/hardware.module.ts` — `LIST_WINDOWS_PRINTERS` no-fallthrough + `reinitializePrinter()` always-register
- `src/main/hardware/port-utils.ts` — `listSerialPorts()` v3: ACPI filter via InstanceId
- `src/renderer/components/Settings.tsx` — `onDeviceStatus` auto-refresh listener

**Build:** `npx tsc -p tsconfig.main.json` ✅, `npx tsc -p tsconfig.renderer.json --noEmit` ✅
**Status:** NOT COMMITTED. User confirmed all features working after restart.

### Session 34 — ghost-printer filter v4 + dropdown filter + COM phantom guard (2026-04-07)

**User reported after rebooting + testing v3:**
- Detect Printers card still showed `HP — USB2.1 Hub` with Windows name `HP LaserJet Pro MFP M426-M427 PCL 6` (a ghost reanimated as a USB hub)
- Labels/A4 Windows Printer dropdown still listed `ZDesigner GK420d`, `OneNote`, `HP M426`, `HP M402d`, `Fax` — none physically attached
- COM Port dropdown still defaulted/listed `COM1`

**Three root causes found in v3:**

1. **Section 2 ghost resurrection (driver-installer.ts)** — `getPosnetDriverStatus()` Section 2 scans `Get-PnpDevice -PresentOnly` for any device whose VID matches a printer brand. HP's VID `03F0` covers HP keyboards, USB hubs, composite devices — NOT just printers. The PowerShell scan emitted every match (including a HP USB hub with bus desc `USB2.1 Hub`), then `findPrinterForVid` happily attached it to the still-listed-but-just-filtered HP LaserJet spooler ghost, creating a "real" device card with `model="USB2.1 Hub"` and `windowsPrinterName="HP LaserJet Pro MFP M426-M427 PCL 6"`. **Fix:**
   - PowerShell now restricts Section 2 to `Class -in (Ports, Printer, USBPRINT)` plus `Class=USB` ONLY when bus desc matches printer keywords. HP keyboards/hubs are dropped at the source.
   - JS now tracks every spooler printer name in `allSpoolerNames`, and every dropped one in `ghostSpoolerNames`. Section 2 refuses any PnP hit whose `findPrinterForVid` match is in `ghostSpoolerNames` (resurrection guard) and refuses any non-POSNET PnP hit that has no spooler match at all.

2. **`LIST_WINDOWS_PRINTERS` IPC bypassed the filter (hardware.module.ts)** — the dropdown was hitting raw `listWindowsPrintersDetailed()`, which is an unfiltered `Get-Printer` dump. Now the IPC handler calls `getPosnetDriverStatus()` first and returns only `windowsPrinterName` values from devices it kept (i.e. v4-filtered). Falls back to the legacy raw list (with extra virtual-name regex) only if the filtered query returns 0.

3. **`listSerialPorts()` could leak phantom COM1 (port-utils.ts)** — `Get-PnpDevice -PresentOnly -Class Ports` on some Win10 installs returns the legacy COM1 entry as "present" even when no hardware backs it (Service field empty). v2 of the function now requires BOTH (a) the PnP entry has a non-empty `Service` field AND (b) the port also appears in `Get-CimInstance Win32_SerialPort` (sourced from the live hardware tree, not the SERIALCOMM registry). Phantoms drop out of the intersection. Loud log line `Dropped phantom COM port(s): COM1(svc=none,wmi=false)` so we can confirm what was filtered.

**Files changed in s34:**
- `src/main/hardware/driver-installer.ts` — PS Section 2 class allowlist + ghost-name memory + 3 resurrection guards in JS Section 2 (`KEEPING/FILTERED/REFUSING/dropping` log markers)
- `src/main/modules/hardware.module.ts` — `LIST_WINDOWS_PRINTERS` handler now sources from `getPosnetDriverStatus()` first
- `src/main/hardware/port-utils.ts` — `listSerialPorts()` v2: PnP+Service intersected with `Win32_SerialPort`

**Build status:** `npx tsc -p tsconfig.main.json` ✅. Verified in `dist/main/...`:
- `filter v4` marker ✅
- `REFUSING PnP hit` / `Section 2: dropping` guards ✅
- `Dropped phantom COM` ✅
- `filtered via getPosnetDriverStatus` ✅

**Status:** NOT COMMITTED. User to restart Electron and re-test. Discord screenshots requested after.

**If anything still leaks:**
- Look for log line `Result: N real device(s); M ghost(s) filtered out of K spooler entries` — confirms s34 code path is hit
- Look for `Section 2: REFUSING PnP hit` lines — confirms resurrection guard fired
- Look for `Dropped phantom COM port(s)` — confirms intersection guard fired
- If COM1 STILL appears: PnP+WMI both return COM1, meaning the user's machine genuinely has a real COM1 (probably motherboard built-in or virtual COM driver service like vSPE/com0com). Not a code bug.

### Sessions 32–34 — ghost-printer filter v1→v4 (compacted, 2026-04-07)

Iterative fix for ghost/phantom printers appearing in Settings. Key milestones:
- **v1 (s32):** True presence detection via `Get-PnpDevice -PresentOnly`, `ALLOWED_PROTOCOLS_BY_TYPE` matrix, per-device Refresh button. Ghosts still leaked.
- **v2 (s33):** Rewrote filter decision tree by port type. CSV header bug found. HP VID too coarse.
- **v3 (s33):** Eliminated CSV → line-prefix parser. PNPDeviceID lookup against `Get-PnpDevice -PresentOnly` hashset. Dropdown and Section 2 resurrection still leaked.
- **v4 (s34):** Section 2 class allowlist (`Ports,Printer,USBPRINT`), ghost-name memory, `LIST_WINDOWS_PRINTERS` IPC sources from `getPosnetDriverStatus()`, `listSerialPorts()` v2 (PnP+Service+WMI intersection).

All superseded by s35 fixes (ACPI COM1 filter, no-fallthrough empty list, reinit resilience).

### Test scripts
- `scripts/test-print-label-electron.js` — real print test: `npx electron scripts/test-print-label-electron.js`

---

## Carried Forward Issues

### Settings — unfixed
- **Inconsistent save behavior** — some settings instant-save (tab visibility, check-in toggles, AI, remote, SSH), others require Save button (language, printer config, POS). UX inconsistency, needs design decision.

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
