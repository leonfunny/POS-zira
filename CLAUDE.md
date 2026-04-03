# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Remote Operation Mode

When running via Discord channel (`--channels plugin:discord@claude-plugins-official`), the operator is remote and may not respond immediately. In this mode:

- **Never pause to ask for confirmation** — make the safest, most reasonable decision autonomously and proceed.
- **Never ask "should I continue?"** — just continue.
- When there are multiple options, pick the most conservative/safe one and report what you chose via Discord.
- After completing a task, always send a summary to Discord so the operator knows the outcome.
- If something is genuinely ambiguous and risky, state your assumption, proceed with it, and report.

### Thinking Keywords from Discord

Discord messages bypass CLI keyword detection, so thinking-level triggers like `ultrathink` won't automatically activate. When you see these keywords in a Discord message, manually adjust your behavior:

| Keyword in message | Behavior |
|---|---|
| `ultrathink` | Maximum depth: research extensively, read all relevant files, consider every edge case, plan before acting, verify assumptions, use Agent tool for parallel deep research. Treat this as the hardest problem — no shortcuts. |
| `think hard` / `think harder` | Deep analysis: read related code thoroughly, consider multiple approaches, pick the best one with reasoning. |
| `think` | Standard careful analysis (default for complex tasks). |

When you detect any of these keywords at the start of a Discord message, strip the keyword from the task description and apply the corresponding thinking level to the actual task that follows.

## Project Overview

**Zira AI Print Agent** — Electron + React + TypeScript desktop app that connects the eNail POS system with hardware devices (thermal printers, barcode scanners, cash drawers). Targets **Windows 10/11 64-bit only**.

## Commands

```bash
# Development (hot-reload: tsc --watch + Vite dev server on port 3100)
npm run dev

# Build (main → dist/main/, renderer → dist/renderer/)
npm run build
npm run build:main        # Main process only (tsc)
npm run build:renderer    # Renderer only (Vite)

# Run built app
npm run start             # electron .

# Build Windows NSIS installer → release/Zira AI Setup X.X.X.exe
npm run dist:win

# Release workflow
./scripts/bump-version.sh patch   # Bump version in package.json
./scripts/build-and-upload.sh     # Build + upload to Cloudflare R2
```

No linting or test configuration exists in this project.

## Architecture

Three-process Electron model:

```
Main Process (Node.js)          Preload (contextBridge)       Renderer (React + Vite)
─────────────────────           ────────────────────          ──────────────────────
src/main/                       src/preload/preload.ts        src/renderer/
├── index.ts (entry)            Exposes window.electronAPI    ├── App.tsx (main window)
├── core/orchestrator.ts        via ipcRenderer.invoke/on     ├── windows/pos/POS.tsx
├── hardware/ (drivers)                                       ├── windows/customer/
├── database/ (SQL.js)                                        ├── components/
├── network/ (Socket.IO)                                      ├── hooks/
├── invoice/                                                  └── i18n/translations.ts
├── pos/
├── booksy/
├── telegram/
├── ai/
└── config/store.ts
```

### TypeScript Configuration

| Config | Target | Module | Scope |
|--------|--------|--------|-------|
| `tsconfig.main.json` | ES2022 | **CommonJS** | `src/main/`, `src/shared/`, `src/preload/` → emits to `dist/` |
| `tsconfig.renderer.json` | ES2022 | ESNext | `src/renderer/` → noEmit (Vite handles build) |
| `tsconfig.json` | — | — | Root references both, path aliases |

**Path aliases:** `@/*` → `src/*`, `@main/*`, `@renderer/*`, `@shared/*`

### IPC Communication

All IPC channels defined in `src/shared/types.ts` as `IPC_CHANNELS` const object (~60 channels). The preload script maps these to `window.electronAPI.*` methods. Type definitions for the full API surface are in `src/shared/electron.d.ts`.

Pattern:
- **Main → Renderer:** `mainWindow.webContents.send(channel, data)`
- **Renderer → Main:** `window.electronAPI.someMethod()` → `ipcMain.handle(channel, handler)`

### Database

**SQL.js** (SQLite compiled to WASM, in-memory with disk persistence).

- DB file: `%APPDATA%/Zira AI/pos.db`
- Schema: `src/main/database/migrations.ts` — versioned migration array
- Repos: `src/main/database/repos/` — 13 repository files (products, orders, invoices, customers, staff, etc.)
- Auto-saves every 5 seconds when dirty
- Multi-tenant: `clearSalonData()` wipes salon-specific tables on account switch
- All prices stored as **integers** (grosze/cents)

### Networking

- **REST API:** `src/main/network/api-client.ts` — connects to eNail backend (`/api/v1/print-agent/*`)
- **WebSocket:** `src/main/network/socket-client.ts` — Socket.IO for real-time print jobs, remote sessions, config updates
- Auth: API Key (`pa_xxx` format) or Telegram login

### Hardware Drivers

| Driver | Location | Protocol |
|--------|----------|----------|
| Posnet (fiscal) | `src/main/hardware/posnet/` | POSNET or THERMAL over serial COM |
| Thermal (ESC/POS) | `src/main/hardware/thermal/` | ESC/POS over USB/serial |
| Zebra (labels) | `src/main/hardware/zebra/` | Windows printer API |
| Scanner | `src/main/hardware/scanner/` | HID keyboard wedge |

### Multi-Window

Vite builds 3 entry points (`vite.config.ts` rollupOptions.input):
- `main` — Settings, status, chat, Booksy, invoicing tabs
- `pos` — Point of sale window
- `customer` — Customer-facing display

**Critical Vite plugin:** `removeCrossOrigin()` strips `crossorigin` attributes from HTML — required for Electron's `file://` protocol.

## i18n

Translations in `src/renderer/i18n/translations.ts` — flat key-value objects per language.

**Languages:** `en`, `vi`, `tr`, `zh`, `uk`, `ru`, `pl`

**Hook:** `src/renderer/hooks/useTranslation.ts`

## Key Types

All shared types live in `src/shared/types.ts` (~1500 lines):
- `IPC_CHANNELS` — all channel names
- `AgentConfig`, `AgentStatus`
- `PrinterType`, `PrinterProtocol`, `PrintJobType`, `PrintJobStatus`
- Invoice types (`InvoiceRow`, `InvoiceCreateDTO`, etc.)
- Booksy sync types
- Remote control types
- Telegram/AI types

The `src/shared/electron.d.ts` file declares the full `window.electronAPI` interface.

## Release

1. `./scripts/bump-version.sh patch` — bumps version in `package.json`
2. `./scripts/build-and-upload.sh` — builds Windows installer, uploads to Cloudflare R2 (`https://img.zira.pl/downloads/`)
3. Update download link in `frontend/src/app/app/settings/print-agent/page.tsx`
4. Rebuild frontend dashboard

See `docs/RELEASE_GUIDE.md` for full details.

## Config Storage

`electron-store` with encrypted secrets via Electron's `safeStorage`. Config stored at `%APPDATA%/Zira AI/config.json`.

---

## Skill Auto-Activation Rules

The following skills are installed globally (`~/.claude/commands/`). Activate them automatically based on the task at hand — do not wait to be asked.

### Always activate proactively

| Trigger | Skill(s) to invoke |
|---|---|
| Building or redesigning any UI component | `ui-ux-pro-max` |
| Task involves auth, API keys, payments, user input validation, IPC handlers | `ecc:security-review` |
| Writing or improving Playwright tests | `ecc:e2e-testing` |
| Work touches `src/main/network/`, `src/main/database/`, or any IPC handler | `ecc:backend-patterns` |
| Work touches `src/renderer/` components or hooks | `ecc:frontend-patterns` |
| Adding a new DB column, table, or migration | `ecc:database-migration` |
| Implementing a new feature end-to-end | `ecc:feature-development` |
| Before creating a PR or finishing a significant chunk of work | `ecc:verification-loop` |

### Skill combinations for common workflows

| Task | Skill sequence |
|---|---|
| New UI tab or screen | `ui-ux-pro-max` → build → `ecc:verification-loop` |
| New API endpoint or IPC channel | `ecc:api-design` → `ecc:backend-patterns` → `ecc:security-review` |
| New feature with tests | `ecc:feature-development` → build → `ecc:e2e-testing` → `ecc:verification-loop` |
| DB schema change | `ecc:database-migration` → `ecc:backend-patterns` |
| Bug in renderer | `gsd:debug` → fix → `ecc:verification-loop` |
| Complex multi-phase work | `gsd:plan-phase` → `gsd:execute-phase` → `gsd:verify-work` |
| Full app assessment | `/audit-app` (orchestrates all 5 sub-audits below) |
| Targeted audit | `/audit-code`, `/audit-security`, `/audit-ui`, `/audit-architecture`, `/audit-functional` |

### Installed skill index

| Skill | Description |
|---|---|
| **Audit System** | |
| `/audit-app` | Master orchestrator — runs all 5 sub-audits in parallel, synthesizes `AUDIT_REPORT.md` |
| `/audit-code` | Code quality — dead code, type safety, error handling, code smells (calls `ecc:coding-standards` + `ecc:backend-patterns` + `ecc:frontend-patterns`) |
| `/audit-architecture` | Architecture — module coupling, IPC integrity, DB design, state management (calls `gsd:map-codebase`) |
| `/audit-security` | Security — Electron config, OWASP, auth, IPC validation, secrets (calls `ecc:security-review`) |
| `/audit-ui` | UX/UI — visual consistency, accessibility, touch, user flows, i18n (calls `ui-ux-pro-max` + `gsd:ui-review`) |
| `/audit-functional` | Testing — E2E smoke tests, critical path coverage, test gaps (calls `test-print-agent` + `ecc:e2e-testing`) |
| **Design & Quality** | |
| `ui-ux-pro-max` | UI/UX design — 67 styles, 96 palettes, touch-friendly patterns |
| `ecc:security-review` | Security checklist for auth, payments, API, secrets |
| `ecc:e2e-testing` | Playwright Page Object Model, CI/CD, artifact management |
| `ecc:verification-loop` | 6-stage pre-PR quality gate (build→types→lint→tests→security→diff) |
| `ecc:backend-patterns` | Node.js architecture — caching, JWT, error handling, queues |
| `ecc:frontend-patterns` | React hooks, state management, memoization, error boundaries |
| `ecc:coding-standards` | TypeScript/React naming, immutability, type safety standards |
| `ecc:api-design` | REST resource naming, status codes, pagination, versioning |
| `ecc:feature-development` | End-to-end feature workflow scaffold |
| `ecc:database-migration` | Safe DB schema change workflow |
| `gsd:*` | Planning, execution, debugging, verification (50+ commands) |
| `test-print-agent` | E2E smoke test for this app specifically |
