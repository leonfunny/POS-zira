# Zira AI Print Agent — Session Handoff

> Last updated: 2026-04-03 (session 28 — Settings audit: 9 of 10 bugs fixed) | Read this file at the start of every new session.

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

## What Has Been Built (sessions 1–28)

- **Check-in tab full UI redesign** (s1, 15) — EntryScreen, PhoneEntryScreen, NewCustomerScreen, ServiceSelectionScreen; warm luxury aesthetic; all 7 languages
- **Custom touch keyboard** (s2, 10) — local keyboard in check-in, global `useKeyboardManager` hook for all other tabs
- **Tab visibility toggle** (s3) — hide/show sidebar tabs from Settings; persists to config
- **POS tab UI/UX redesign** (s6-8) — rose palette, touch targets, cart layout, sidebar width
- **Invoicing tab redesign + bug fixes** (s8-9) — i18n, inline modals replacing native dialogs
- **Settings tab redesign + deep audit + 9 fixes** (s11-12, 27-28) — toggle switches, save state, SVG icons, security/UX bugs fixed
- **Check-in kiosk mode + display toggles** (s14) — fullscreen, stats bar + queue visibility
- **Posnet fiscal printer detection** (s18) — 4-service architecture, test print confirmed on Posnet Temo HS COM5
- **Codex bug audit + fixes** (s19-20) — 9 bugs fixed from comprehensive scan
- **Printer bug fixes + Zebra calibrate** (s24) — removed auto-calibrate on startup, ESC/POS binary test print, Zebra Calibrate button
- **HTML label printing + booking numbers** (s25-26) — hidden BrowserWindow → `webContents.print()` to Zebra, `NNN/DDMM` booking numbers, price support in labels
- **Multi-page label print fix** (s27) — grand total on all pages, correct print order, no blank pages
- **Security hardening** (s28) — all credentials (API key, AI key, remote PIN) use DPAPI encryption via safeStorage; dedicated IPC handlers (`AUTH_CHANGE_SALON`, `AUTH_SET_AI_API_KEY`, `AUTH_SET_REMOTE_PIN`); SET_CONFIG blocks all sensitive fields
- **Misc:** app starts maximized, sidebar language fix, all tabs enabled (Billiard hidden), tsconfig fix

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
- Customer display "-" bar + swipe gestures can exit fullscreen
- Python security deps not installed
- Windows activation watermark
