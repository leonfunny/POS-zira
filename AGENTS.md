# Repository Guidelines

## Project Structure & Module Organization
This repository is a Windows-focused Electron desktop app with a React renderer. Key paths:
- `src/main/`: Electron main process entry (`index.ts`).
- `src/renderer/`: React UI (e.g., `App.tsx`, `components/`).
- `src/preload/`: Electron preload script.
- `src/shared/`: Shared types and utilities.
- `assets/`: App icons and build resources.
- `dist/`: Compiled output for main/renderer builds.
- `docs/`: Supporting documentation.

## Build, Test, and Development Commands
Common workflows (from repo root):
- `npm install`: Install dependencies.
- `npm run dev`: Run main process TypeScript watch + Vite dev server.
- `npm run dev:main`: Compile `src/main` with `tsc --watch`.
- `npm run dev:renderer`: Start Vite for the React UI.
- `npm run build`: Build main + renderer into `dist/`.
- `npm run start`: Launch Electron using `dist/`.
- `npm run dist:win`: Create a Windows installer via `electron-builder`.

## Coding Style & Naming Conventions
- Language: TypeScript across main, renderer, and preload.
- Naming: files follow feature or role-based names like `tray.ts`, `updater.ts`, `posnet/`, and `scanner/`.
- Keep imports tidy and match existing patterns in neighboring files.
- No explicit lint/format scripts are defined in `package.json`; keep formatting consistent with nearby code.

## Testing Guidelines
No automated test scripts are configured in `package.json` currently. If tests are added, document the command and naming convention here (e.g., `*.spec.ts`).

## Commit & Pull Request Guidelines
- Follow the conventional commit prefixes used in the repo (e.g., `feat:`, `fix:`, `chore:`).
- PRs should include a short summary, a test plan (even if manual), screenshots for renderer UI changes, and notes on installer or build output changes when relevant.

## Security & Configuration Tips
- Configuration is stored under `%APPDATA%/Zira AI/config.json` on Windows.
- If you touch hardware or network integration, note protocol or device impact in the PR description.
