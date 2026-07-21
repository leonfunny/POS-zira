# Capacitor Android B1 Stage 2 synthetic catalog

Date: 2026-07-17
Status: accepted for development-only read-only UI; all production lanes remain locked

## Scope

Stage 2 replaces the static diagnostic card with a tablet POS catalog layout containing exactly six embedded `DEMO-*` records. It is deliberately not a functional POS:

- no backend URL, request, authentication, token, salon ID, or production product ID;
- no cart mutation, order, payment, inventory, fiscal, printer, updater, or publication path;
- the order panel and checkout control are visibly and semantically disabled;
- category filtering is CSS-only and cannot trigger application code or a network request;
- the application ID remains `com.ziraai.posdiagnostics.dev` with the local debug signer.

## Design and responsive behavior

The UI uses the transactional light-canvas direction from the bundled Shopify-inspired design reference: cream canvas, white commerce cards, black pill filters, and restrained aloe/pistachio safety accents. It adapts from a three-column catalog with a fixed order preview at `1280x800`, to two columns, then a single-column mobile catalog with the locked order preview below. Touch targets are at least 44 px and filter overflow is horizontally scrollable.

No third-party font, logo, image, analytics, CDN, or remote design asset is used.

## Fail-closed build correction

During Stage 2 verification, the native build command was found capable of packaging previously synced web assets if a caller forgot `android:sync`. `android:build:verify` now invokes the complete fail-closed sync first. The sync rebuilds and scans the Vite bundle, copies it to the native project, deterministically normalizes generated Cordova XML, scans the exact copied native assets, and only then starts the scoped Gradle build.

## Verification

Linux build host:

- Stage 2 catalog tests: `2/2`;
- Stage 1 native security policy tests: `3/3`;
- A3b source graph scan: pass;
- final Vite bundle scan: pass;
- exact copied native-assets scan: pass;
- scoped Gradle build: `196` tasks, pass;
- merged debug/release manifest gate: pass;
- `git diff --check`: pass after deterministic generated-XML normalization;
- desktop Electron typecheck and build: pass.

Visual inspection passed at `1280x800` and `412x915`: product cards remain readable, order controls remain locked, and the narrow layout collapses without horizontal page overflow. An executable Playwright gate also covers `915x412` rotation/split height, requires checkout and the safety note to be reachable after scrolling, verifies no horizontal page overflow at all three viewports, and exercises the CSS-only category filter.

Hardware-accelerated API 36 validation used a cold `-wipe-data` AVD on Alienware. The exact transferred APK hashes were:

- app: `69467381636ffeeb29e21394945bd7557b6986f004c3dd741d96a98abe405fc3`;
- AndroidTest: `f08a71d9144cc1f3c7bf0b24b7cc13de4872c07c43b63ca74c535bf0b509a0ce`.

Fresh installation of both APKs passed `OK (2 tests)` with `INSTRUMENTATION_CODE: -1`. The recreation test verifies before and after `ActivityScenario.recreate()` that:

- title is `Danh mục mẫu`;
- body mode is `synthetic-read-only`;
- exactly six synthetic records exist;
- checkout remains disabled.

The emulator and persistent ADB server were stopped after validation. Chesaigon POS, live source, machine identity, local database, credentials, printer, fiscal configuration, and installed counter app were not touched.

## Still locked

This packet does not authorize Stage 3 backend reads, real staff authentication, local persistence, carts, orders, payments, printer/fiscal work, production signing, Play distribution, Windows/Android auto-update, or deployment. Any next packet must rerun A3b against its final transitive graph and obtain an independent review of the new data boundary.
