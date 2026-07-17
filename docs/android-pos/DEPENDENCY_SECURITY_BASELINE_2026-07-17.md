# Dependency security baseline

Date: 2026-07-17
POS source: `f0ee58bcd1e5217a4926353f0aff1fefd122941f`
Runtime used for audit: Node `22.22.2`, npm `10.8.2`

## Result

`npm ci` completed from the committed lockfile, with the expected engine warning because the current project declares Node `20.x` while the planned Capacitor 8 lane requires Node 22.

The current lockfile is **not an acceptable production baseline for a new Android release**:

- full dependency graph: 43 advisories (`2 low`, `15 moderate`, `22 high`, `4 critical`);
- production dependency graph (`npm audit --omit=dev`): 15 advisories (`11 moderate`, `4 high`, `0 critical`);
- direct production concern: `ws` is in an affected range and has an available fix;
- other production-path findings include `fast-uri`, `form-data`, and `socket.io-parser` through transitive dependencies;
- the four critical full-graph findings are in the build/test toolchain: direct `concurrently`, direct `vitest`, and transitive `fast-xml-parser` and `shell-quote`;
- Electron/electron-builder remediation includes major-version upgrades and cannot be applied blindly without Windows installer, native module, updater, and signing regression tests.

This file records a point-in-time npm advisory result. The release gate must rerun the commands below because advisory data changes.

## Production trap

Do not run `npm audit fix --force` on the shared branch. A forced lockfile rewrite can silently change Electron, electron-builder, native dependencies, updater behavior, and the Windows installer while Android work is still being separated.

The safe sequence is:

1. create a dedicated dependency-remediation branch;
2. update direct low-risk packages first and explain every remaining transitive path;
3. run the complete Windows Node 22 dependency/test/build baseline;
4. build and smoke-test the Windows installer on Windows, including update from 1.0.23;
5. run Android boundary, web, Gradle, and physical-device tests;
6. require zero critical advisories and an owner-reviewed disposition for every high advisory reachable in a shipped runtime or build/publish path.

## Reproduction

```bash
npm ci
npm audit --json
npm audit --omit=dev --json
```

No dependency or lockfile was changed as part of this audit.

## Windows toolchain drift and isolated baseline

The clean live-source checkout on `chesaigon` at `f0ee58b` reports Node `24.14.1` and npm `11.18.0`, while the repository declares Node 20/npm 10 and the Capacitor 8 plan requires an intentional Node 22/npm 10 lane. It was not changed or used as the release gate.

An isolated checkout was created at `C:\Users\pc\POS-zira-node22-baseline-20260717` and tested with a reversible `npx`-provided Node `22.23.1`/npm `10.9.8` toolchain:

- `npm ci` completed from the committed lockfile and reproduced the same 43-advisory result;
- `npm run build` passed renderer typecheck, main TypeScript compilation, and the Vite production build;
- the test run passed 237 test files and 2059 tests, with 13 skips;
- one E2E suite failed before Electron launch because its helper shells out to `npx tsc -p tsconfig.main.json`, and nested npm `10.9.8` returned `EUSAGE` on Windows.

The isolated Node 22 compile gate is therefore green, but the complete Windows release gate is not. Fix or replace the E2E helper invocation, rerun that suite, then build and smoke-test the Windows installer and the update path from 1.0.23. Do not reinterpret the successful source build as installer/update proof. The installed counter app, its database, device identity, printer/fiscal assignments, and running process were not changed or restarted by this baseline.
