# Zira AI Print Agent

Electron + React + TypeScript desktop app that bridges the **eNail ERP / POS** backend with shop-floor hardware (thermal receipt printers, fiscal printers, label printers, barcode scanners, cash drawers) and runs the in-store point-of-sale UI.

Targets **Windows 10/11 64-bit**.

---

## What this app does

- **Point of Sale** — Retail, restaurant and salon modes. Runs fully offline; orders sync to the eNail server in the background.
- **Receipt / fiscal printing** — ESC/POS thermal, Posnet fiscal (THERMAL & POSNET protocols), Windows printer API.
- **Label printing** — Zebra (ZPL) via Windows printer API.
- **Customer-facing display** — Second-monitor kiosk window for promos, check-in, and live cart preview.
- **Check-in** — Salon queue management with Telegram notifications.
- **Booksy sync** — Calendar/customer sync with Booksy via Chrome DevTools Protocol.
- **Local SQLite** — All POS data stored locally (SQL.js/WASM), auto-saved, synced to server via outbox pattern.
- **Remote control** — Operators / support can drive the agent from the eNail dashboard via Socket.IO.
- **AI chat** — Built-in Zira AI assistant (OpenRouter / local models).

---

## Quick start (new machine)

### 1. Prerequisites

Install these first:

- **[Node.js 18+ LTS](https://nodejs.org/)** (ships with npm)
- **[Git](https://git-scm.com/)**
- **[Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/downloads/)** — required for native modules (`node-gyp`). Pick the *"Desktop development with C++"* workload.
- **Python 3.10+** — also required by `node-gyp`.

Optional but recommended:
- VSCode, Claude Code CLI, Codex CLI.

### 2. Clone + install

```powershell
git clone https://github.com/KaiPizz/zira-pos.git C:\print-agent-master
cd C:\print-agent-master
npm install          # installs deps + runs postinstall (electron-builder rebuild)
```

Native modules (`better-sqlite3`, `sql.js`, `serialport`, `node-hid`) are rebuilt against Electron's ABI automatically via `postinstall`. If a rebuild fails, re-run:

```powershell
npm run postinstall
```

### 3. Run in dev

```powershell
npm run dev
```

This starts, in parallel:
- `tsc --watch` for the main process (outputs to `dist/main/`)
- Vite dev server on `http://localhost:3100` for the renderer
- Electron, auto-reloading on changes

### 4. Build for production

```powershell
npm run build        # tsc + vite build
npm run start        # launch the built app
npm run dist:win     # create Windows NSIS installer in release/
```

### 5. Pair with the eNail server

On first launch:

1. Open the **Settings** tab in the agent.
2. Enter the **API key** issued by the eNail dashboard (format `pa_xxxxxxxxxxxxxxxx`).
3. Click **Connect** — the agent pairs, gets its `agentId`, and begins syncing.

Alternative: **Telegram login** — generate a login token in the agent, send it to the eNail Telegram bot.

Config is written to `%APPDATA%\zira-ai\config.json`; the JWT auth token is encrypted with Windows DPAPI (`safeStorage`) and **cannot be copied to another machine** — you must re-pair on each device.

---

## Project structure

```
print-agent-master/
├── src/
│   ├── main/                   # Electron main process (Node.js)
│   │   ├── index.ts            # Entry point, owns the module registry
│   │   ├── core/               # ServiceContainer, modules, tools registry
│   │   ├── modules/            # POS, Hardware, Sync, Invoice, Booksy, AI, Telegram...
│   │   ├── hardware/           # posnet/ thermal/ zebra/ scanner/ drivers
│   │   ├── database/           # SQL.js + migrations + 28 repositories
│   │   ├── network/            # api-client.ts (REST) + socket-client.ts (Socket.IO)
│   │   ├── sync/               # Outbox syncers: orders, check-ins, invoices, ...
│   │   ├── pos/                # PosStore, PaymentController, ShiftController
│   │   ├── booksy/             # Booksy CDP sync worker
│   │   ├── telegram/           # Telegram bot integration
│   │   ├── ai/                 # Zira AI chat
│   │   ├── invoice/            # KSeF / fiscal invoice generation
│   │   └── config/             # electron-store + safeStorage
│   ├── renderer/               # React UI
│   │   ├── App.tsx             # Main window (Settings, Status, Chat, Booksy…)
│   │   ├── windows/pos/        # POS window
│   │   ├── windows/customer/   # Customer-facing display
│   │   ├── components/         # Shared components
│   │   ├── hooks/
│   │   └── i18n/translations.ts  # 7 languages: en, vi, tr, zh, uk, ru, pl
│   ├── preload/                # contextBridge scripts (one per window)
│   └── shared/                 # types.ts (IPC_CHANNELS, DTOs), electron.d.ts
├── scripts/                    # Dev helpers (kill-electron, screenshot, backup)
├── tests/e2e/                  # Playwright smoke tests + screenshot scripts
├── assets/icons/
├── docs/                       # Design docs, release guide
├── CLAUDE.md                   # Project instructions for Claude Code agents
├── SESSION_HANDOFF.md          # Cross-session handoff log — READ FIRST
└── package.json
```

---

## Architecture (3-process Electron)

```
Main Process (Node)            Preload (contextBridge)      Renderer (React)
─────────────────────           ────────────────────         ──────────────────────
src/main/                       src/preload/*.ts             src/renderer/
  • ServiceContainer              exposes window.electronAPI   • Uses electronAPI
  • ~60 IPC handlers              via ipcRenderer.invoke       • No Node access
  • Hardware drivers                                           • No fs/network
  • Local SQLite
  • Socket.IO to server
```

All IPC channel names live in `src/shared/types.ts` (`IPC_CHANNELS`). The `window.electronAPI` surface is typed in `src/shared/electron.d.ts`.

Three renderer entry points (multi-window, built by Vite):
- `main` — Settings, status, chat, Booksy, invoicing
- `pos` — Point-of-sale window
- `customer` — Customer-facing display (second monitor)

---

## Scripts

Defined in `package.json`:

| Command | What it does |
|---|---|
| `npm run dev` | `tsc --watch` (main) + Vite dev server (renderer) + Electron |
| `npm run build` | Production build of main + renderer |
| `npm run build:main` | tsc only |
| `npm run build:renderer` | Vite only |
| `npm run start` | Run the built app (`electron .`) |
| `npm run dist:win` | NSIS installer in `release/` |
| `npm run postinstall` | electron-builder native rebuild |

Helpers in `scripts/`:

| Script | Use |
|---|---|
| `scripts/kill-electron.ps1` | Force-kill stuck Electron processes |
| `scripts/screenshot.ps1` | Capture the active Zira window |
| `scripts/backup-machine.ps1` | **Create migration bundle (see below)** |
| `scripts/package-project.ps1` | Zip the project (excluding node_modules) |
| `scripts/check-sizes.ps1` | Report folder sizes |
| `scripts/bump-version.sh` / `scripts/build-and-upload.sh` | Release pipeline |

---

## Local data locations (Windows)

| Path | Contents |
|---|---|
| `%APPDATA%\zira-ai\config.json` | Config; `apiKey` plaintext, `authToken` DPAPI-encrypted |
| `%APPDATA%\zira-ai\pos.db` | Local SQLite — orders, products, customers, check-ins, invoices |
| `%APPDATA%\zira-ai\logs\` | Rotating combined / error logs |
| `%APPDATA%\zira-ai\printer-registry.json` | Detected printer cache |
| `%APPDATA%\zira-ai\labels\` | Label templates |
| `%APPDATA%\zira-ai\security\` | Security camera evidence |

All prices in the database are stored as **integers in grosze / cents**.

---

## Migrating to a new machine

The automated backup script captures everything you need to resume on a fresh install.

**On the OLD machine:**

```powershell
cd C:\print-agent-master
powershell -ExecutionPolicy Bypass -File scripts\backup-machine.ps1 -Out "D:\zira-backup"
```

This creates a folder containing:

- `claude.zip` — `~/.claude/` (Claude Code memories, skills, agents, plugins, project history)
- `codex.zip` — `~/.codex/` if present
- `ssh.zip` — `~/.ssh/` (back up before resetting keys)
- `zira-ai.zip` — `%APPDATA%\zira-ai\` minus browser caches (keeps `pos.db`, printer registry, labels — auth token won't decrypt on the new machine, you'll re-pair)
- `vscode-extensions.txt` — list of installed VSCode extensions
- `env-user.txt` — user-scope environment variables (**review and redact secrets before sharing**)
- `gitconfig-global.txt`
- `MANIFEST.txt` — step-by-step restore instructions

Copy the folder to USB / external drive.

**On the NEW machine:**

1. Install Node 18+, Git, VSCode, VS Build Tools, Python, Claude Code CLI, Codex CLI
2. Extract each archive to its target path (see `MANIFEST.txt`)
3. `git clone https://github.com/KaiPizz/zira-pos.git C:\print-agent-master`
4. `cd C:\print-agent-master && npm install`
5. Install VSCode extensions:
   ```powershell
   Get-Content D:\zira-backup\vscode-extensions.txt | ForEach-Object { code --install-extension $_ }
   ```
6. Read `SESSION_HANDOFF.md` — the most recent session entry has current WIP and "next steps".
7. Launch the app, open Settings, paste your API key from the old `config.json`, click Connect.

---

## Remotes

```
origin   https://github.com/KaiPizz/zira-pos.git
public   https://github.com/leonfunny/POS-zira.git
```

Push to both:

```bash
git push origin main
git push public main
```

---

## Further reading

- [`CLAUDE.md`](./CLAUDE.md) — Guidance for Claude Code agents contributing to this repo (client/server boundary, skill auto-activation, coding principles).
- [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md) — Cross-session handoff log. Read first on a fresh session.
- [`DESIGN.md`](./DESIGN.md) — Visual design direction.
- [`PRINT_AGENT_API_GUIDE.md`](./PRINT_AGENT_API_GUIDE.md) — eNail server endpoints consumed by this client.
- [`docs/RELEASE_GUIDE.md`](./docs/RELEASE_GUIDE.md) — Publishing new versions.

---

## Supported hardware

| Device type | Tested | Protocol |
|---|---|---|
| Receipt printer (thermal) | Xprinter XP-80T, generic ESC/POS | ESC/POS over USB / serial / Windows printer |
| Fiscal printer | Posnet Thermal HS FV, HD, XL | POSNET or THERMAL over serial (COM) |
| Label printer | Zebra GK420d and compatible | ZPL via Windows printer API |
| Barcode scanner | Any HID keyboard-wedge | Keyboard event capture |
| Cash drawer | Via receipt printer DK pulse | ESC/POS `ESC p 0 50 50` |
| Customer display | Any second monitor | Electron BrowserWindow |

### Protocol references

- [Posnet THERMAL protocol (PDF)](https://www.soft-bit.pl/downloads/all/Posnet/pliki/THS-I-DEV-02-006_specyfikacja_protokolu_Thermal_w_Thermal_HS_FV.pdf)
- [Posnet POSNET protocol (PDF)](https://4programmers.net/assets/20277/DBC-I-DEV-45-021_specyfikacja_protokolu_Posnet_w_drukarkach.pdf)

---

## License

MIT
