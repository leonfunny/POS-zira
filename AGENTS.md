# Repository Guidelines

## Agent Operating Discipline
Treat these as always-on defaults for coding, review, refactor, and debugging work in this repo:
- Apply the behavior of the `karpathy-guidelines` skill by default; the user should not need to name it.
- Be direct when assumptions, designs, or requests are weak. Explain the flaw and suggest a better alternative.
- Surface important assumptions before acting. Ask only when ambiguity would make the implementation risky.
- Prefer the smallest change that satisfies the goal. Do not add speculative features, flexibility, or abstractions.
- Make surgical edits. Do not refactor, reformat, delete, or "improve" unrelated code.
- Clean up only artifacts introduced by the current change, such as unused imports or dead branches created by your edit.
- Define success criteria for non-trivial work and verify with the most relevant command or manual check before claiming completion.
- If a task requires server-side behavior outside this repo, stop coding and draft a server change request instead of adding brittle client workarounds.

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

## Second Brain Wiki

A shared Obsidian wiki (repo: github.com/KaiPizz/kaipizz-second-brain). It uses the Karpathy LLM Wiki pattern. Multiple AI models (Claude Code, Codex) share this wiki. Find the vault by searching for a local directory containing `AGENTS.md` with the text "wiki maintainer for this Obsidian vault", or clone from the repo above. Default location: `~/Desktop/kaipizz-second-brain/second-brain/`.

**When to read from wiki** (do this yourself, no need to ask):
- Start of session: read `wiki/index.md` to see what knowledge exists for this project
- Before making architecture decisions: check `wiki/decisions/` for prior ADRs
- When debugging: check `wiki/troubleshooting/` for known issues
- When unsure about a technology: check `wiki/tech/` pages

**When to suggest a wiki update** (do NOT auto-update — always ask first):
- Architecture decisions (ADRs) — e.g., choosing a library, changing sync strategy
- Hard-won debugging insights — bugs that took >1 hour to solve
- New patterns or conventions established in this project
- Integration knowledge — how Zira connects to eNail, hardware protocols

**How to read or update** (reading is autonomous, updating needs user confirmation):
1. Locate the vault (see path above), then read files from its `wiki/` directory
2. **Before ANY write to the vault**: read the vault's `AGENTS.md` first — it contains all naming, frontmatter, and log conventions. Never guess the format.
3. Update wiki pages, index.md, and log.md per those conventions. Identify yourself as `codex` in log entries and commit messages.
4. Git commit changes in the vault repo, then return to this project directory
