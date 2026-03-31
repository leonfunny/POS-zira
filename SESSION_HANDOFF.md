# Zira AI Print Agent — Session Handoff

> Last updated: 2026-03-31 (session 17 — tsconfig fix + kiosk lockdown attempt) | Read this file at the start of every new session.

---

## Project Overview

**Zira AI Print Agent** — Electron + React + TypeScript desktop app for Windows 10/11.
Connects a salon's eNail POS system with hardware (thermal printers, barcode scanners, cash drawers).
The user (`kaipizz`) works **remotely via Discord** and never sees the POS machine directly.

**Remote workflow:**
- User sends instructions → Discord channel `1486692296379596810`
- AI makes code changes on the POS machine, takes screenshots, sends them back via Discord
- Screenshots saved to: `C:\Users\pc\Pictures\zira-screenshots\` (numbered sequentially)

**⚠️ Always report context warnings, build results, errors, and status via Discord — not just terminal.**

---

## GitHub / Multi-Computer Workflow

- Repo: `https://github.com/KaiPizz/zira-pos.git` (pushed 2026-03-31)
- **Start of every session on the main machine:** run `git pull origin main` before touching any code — changes may have arrived from another computer
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
2. Tab × 5 → Enter → Offline Mode → all tabs accessible

---

## Installed Skills

| Skill | Commands |
|-------|---------|
| **GSD** | `/gsd:*` (50+ commands) |
| **UI/UX Pro Max** | Auto-activates for UI work |
| **ECC Skills** (9) | `/ecc:security-review`, `ecc:e2e-testing`, `ecc:verification-loop`, `ecc:backend-patterns`, `ecc:frontend-patterns`, `ecc:coding-standards`, `ecc:api-design`, `ecc:feature-development`, `ecc:database-migration` |

Auto-activation rules in `CLAUDE.md` — no need to ask. Key triggers: UI work → `ui-ux-pro-max` | Auth/IPC → `ecc:security-review` | Main process/DB → `ecc:backend-patterns` | Renderer → `ecc:frontend-patterns`

---

## What Has Been Built (summary — details in git log)

- **Check-in tab full UI redesign** (sessions 1, 15) — EntryScreen, PhoneEntryScreen, NewCustomerScreen, ServiceSelectionScreen; warm luxury aesthetic; all 7 languages
- **Custom touch keyboard** (sessions 2, 10) — local keyboard in check-in, global `useKeyboardManager` hook for all other tabs; replaced Windows OSK
- **Tab visibility toggle** (session 3) — hide/show sidebar tabs from Settings; persists to config
- **POS tab UI/UX redesign** (sessions 6-8) — rose palette, touch targets, cart layout, sidebar width
- **Invoicing tab redesign + bug fixes** (sessions 8-9) — i18n completeness, inline modals replacing `alert()`/`prompt()`/`confirm()`
- **Settings tab redesign + bug audit** (sessions 11-12) — toggle switches, save state, SVG icons, 8 bugs fixed
- **Check-in kiosk mode + display toggles** (session 14) — fullscreen mode from main window, stats bar + queue visibility toggles
- **App starts maximized** — `mainWindow.maximize()` in orchestrator
- **Sidebar language bug fixed** — was hardcoded `'en'`, now reads from config
- **All tabs enabled, Billiard hidden** — `DEFAULT_ENTITLEMENTS` set for offline/nail salon use
- **tsconfig.json fixed** (session 17) — removed invalid `references`, `isolatedModules`, excluded archive; zero errors

---

## 🔜 NEXT UP

### 1. Customer display kiosk lockdown (🔴 BROKEN — top priority)
See Known Issues below. The "−" bar and swipe-based fullscreen exits still not fixed.

### 2. Check-in tab — remaining screens
- **BookingListScreen**, **BookingDetailScreen**, **ConfirmationScreen**, **CustomerProfileScreen** — not yet redesigned

### 3. Tab-by-tab audit status

| Tab | Status |
|-----|--------|
| POS | ✅ Done |
| Invoicing | ✅ Done |
| Settings | ✅ Done |
| **Check-in** | 🔄 In progress — 4 screens remaining |
| Booksy | ⏳ Next after check-in |
| Chat / Status / Debug | ⏳ Low priority |

---

## Known Issues

### 🔴 IN PROGRESS (session 17) — Customer display kiosk lockdown

**Goal:** Lock the customer display (secondary touchscreen monitor) in fullscreen. Prevent OS touch gestures from exiting. Make staff exit require a deliberate 3-finger gesture.

**What was done:**
- `tsconfig.json` — zero TS errors now (see "What Has Been Built")
- `src/main/windows/window-manager.ts` — `customerExitRequested` flag + `leave-full-screen` handler that re-enters kiosk within 50ms + `display:close` IPC for intentional exit
- `src/preload/preload-display.ts` — exposed `display.close()`
- `src/shared/electron.d.ts` — typed `display.close()`
- `src/renderer/windows/customer/CustomerApp.tsx` — touch guard: blocks single-finger edge swipes (<20px from edge), 3-finger swipe-down from top zone (≥80px) triggers `display.close()`

**Still broken:**
- "−" bar at top of customer display still visible
- Swipe gestures can still exit fullscreen

**Root cause to investigate:**
- Confirm kiosk mode IS being applied: add log `[WindowManager] kiosk=true` when creating customer window, check it appears on startup
- Check if `win.on('blur', () => win.focus())` prevents OS from stealing focus via swipe gestures
- The "−" bar may be a Windows system overlay rendered *above* kiosk apps — not something Electron can suppress. If so, the correct fix is disabling Windows edge-swipe gestures system-wide via registry or PowerShell on first launch

**Key files:** `src/main/windows/window-manager.ts` (lines ~114–145 for kiosk setup, ~191–210 for leave-full-screen handler)

---

### ✅ FIXED (session 16) — Blank screen on launch
`useRef`/`useCallback` hooks were after conditional early returns in `App.tsx` → Rules of Hooks violation → React crash. Moved to top level.

---

### Low priority
- [ ] Windows activation watermark — not a code issue
