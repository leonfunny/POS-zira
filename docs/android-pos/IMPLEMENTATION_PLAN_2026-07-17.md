# Zira POS Android + Windows shared-code implementation plan

Status: REVIEWED — CONDITIONAL GO FOR DISCOVERY/TEST-ONLY WORK; NO-GO FOR ANDROID SALES OR PRODUCTION
Date: 2026-07-17
POS source baseline: `leonfunny/POS-zira` commit `f0ee58bcd1e5217a4926353f0aff1fefd122941f`, app `1.0.23`
Related backend: `/var/www/www/enail/backend` on a session branch based on the current canonical trunk

## 0. Review verdict and mandatory corrections

This section supersedes any conflicting text later in the plan.

### 0.1 Verdict

- **Three initial P0 defects were verified.** The subsequent backend contract audit expanded the release register to eight P0 items: fiscal tenant isolation, uncertain fiscal outcomes, payment evidence, deny-by-default terminal gates, authoritative actor attribution, idempotent shift open, idempotent shift close, and offline stock/price acceptance.
- **NO-GO:** Android order writes, payments, offline sales, fiscal printing, backend migrations, release publication, and salon rollout.
- **CONDITIONAL GO:** read-only contract inventory, executable characterization tests, import-boundary checks, pure type/helper extraction, synthetic Android/toolchain spikes, and build-only CI.
- Production write/pilot work becomes eligible only after **all eight P0 items** in `OPEN_BACKEND_CONTRACT_DECISIONS.md` and every applicable P1 release blocker have committed evidence, guarded deployment proof, live artifact verification, and an owner-reviewed decision where required.

### 0.2 P0 production blockers

1. **Cross-tenant fiscal-receipt mutation exists in production.** `FiscalReceiptService.findExistingReceipt()` looks up an existing receipt by `printJobId` without `salonId`, after which `recordEvent()` overwrites the receipt's `salonId` and client-supplied order/printer links. Both staff-JWT and print-agent-key routes reach this service. Required fix: scope lookup and referenced print job/order/printer to the authenticated salon, never reassign tenant ownership, and add non-mutation cross-tenant tests. Android fiscal remains disabled until the corrected backend artifact is deployed and verified.
2. **Uncertain fiscal failures are flattened to `FAILED` in production.** Print jobs distinguish `SAFE_BEFORE_PRINT`, `UNCERTAIN_AFTER_PRINT`, and `FINAL`, but terminal fiscal receipt recording maps every failed job to receipt `FAILED`. Required mapping: completed to `PRINTED`; safe-before-print to `NOT_PRINTED`; uncertain/missing proof to `UNKNOWN`; `UNKNOWN` is never auto-retried. Android fiscal remains disabled until this is fixed and verified with late-success/timeout fixtures.
3. **Offline electronic tender would create false paid orders.** The backend marks every non-credit tender set `PAID` after checking only the amount sum; it does not prove CARD/BLIK authorization or capture. Android offline MVP must be CASH-only if offline selling is later approved. CARD, BLIK, transfer, or split containing electronic tender requires a durable provider authorization/reference and backend validation before finalizing paid state.

The remaining five P0 contract blockers are maintained in the single authoritative register `docs/android-pos/OPEN_BACKEND_CONTRACT_DECISIONS.md`: `P0-GATE-1`, `P0-AUDIT-1`, `P0-SHIFT-1`, `P0-SHIFT-2`, and `P0-ORDER-1`. The three items above are the initially verified defects, not the complete production release gate.

### 0.3 Source-of-truth warning

- Phase -1 selected the full-history checkout `/var/www/www/enail/POS-zira-android-dev-20260717` on feature branch `codex/android-pos-shared-runtime`, based on immutable upstream commit `f0ee58b`. The original shallow artifact remains evidence only.
- The installed `chesaigon` app was verified on 2026-07-17 as `Zira.exe` `1.0.23.0`, and its editable checkout was clean at `f0ee58b`.
- `/var/www/www/enail/POS-zira-latest` contains a divergent review branch with seven local-only safety fixes around fiscal failure, print polling, category sync, PIN fail-closed, daily report recovery, and DB migration recovery, while `origin/main` contains later product commits not on that branch.
- Source provenance/base selection is complete, but safety reconciliation is **not landed**. Follow `SOURCE_RECONCILIATION_2026-07-17.md`: port/harden only approved fixes with focused tests; do not cherry-pick the seven-commit branch wholesale.
- Never copy or rsync a Linux tree over `C:\Users\pc\POS-zira`. Windows validation and any installed-app replacement happen on `chesaigon` only after reviewed commits are ready.

### 0.4 P1 gates

| Gate | Trap in the original plan | Required correction before the affected phase |
|---|---|---|
| R1 Provenance | Phase 0 starts from the shallow download clone | Select a full-history canonical POS checkout and reconcile the divergent safety branch before runtime code work |
| R2 Shared architecture | `ZiraPlatformApi` mixes business operations with native ports, encouraging two order/outbox implementations | Separate shared `PosApplication` business state machines from narrow `PlatformPorts` for storage, HTTP, camera, lifecycle, and print transport |
| R3 Auth principal | “API-key pairing and/or staff login” implies an API key can sell or that Android is a printer host | Staff JWT + refresh token is mandatory for Android order, shift, printer discovery, print create/status, and fiscal routes; Android does not store the salon-wide print-agent `pa_` key by default |
| R4 Phase order | Orders are enabled before durable outbox/reconciliation exists | Build and test the durable order journal, idempotency and lost-response reconciliation before any Pay button can write |
| R5 Ledger ownership | Order queue, sync mirror, and ERP `pos_event_outbox` can be conflated | Specify three distinct ledgers, owners, transitions, and transaction boundaries; never upload an order through the ERP event outbox |
| R6 Toolchain | Repo/CI declares Node 20, while Capacitor 8 requires Node 22+ and a newer Android toolchain | Run a Node 22/JDK 21/SDK 36 clean spike and the full Windows regression suite before changing engines, lockfile, or CI |
| R7 Adaptive tablet UI | Landscape lock is treated as reliable | On Android 16 large screens orientation restrictions can be ignored; support rotation, portrait, split window, recreation, and state restore |
| R8 Device restore | Keystore is mentioned but Android backup/device-transfer behavior is not | Exclude tokens, installation ID, SQLite, outbox, and tenant data from cloud and device-transfer restore; test reinstall/restore |
| R9 Backend gate/model | Client capability is called a kill switch, and Android metadata is added to a print-agent entity by default | Add a server-side deny-by-default Android device/platform gate; decide a terminal-device model before any entity/migration change |
| R10 Payment/fiscal semantics | CARD/BLIK recording can be mistaken for captured payment; offline sale can be mistaken for fiscally complete | Separate tender recording from terminal capture; keep BLIK and offline fiscal disabled until business/legal/hardware approval |
| R11 Release promotion | Windows currently publishes to R2 inside its build job and is unsigned | Build immutable artifacts first, wait for Android processing, then promote manifests; define Windows Authenticode trust before automatic updates are considered production-safe |
| R12 Existing hidden artifact | Clean Windows packaging references an Android TV APK not built by CI | Prove a clean tag build and either remove the hidden resource or build an explicitly signed TV artifact as a separate dependency |

### 0.5 Corrected phase order

```text
-1 provenance/reconciliation
  -> 0 contracts, auth, hardware, toolchain, security decisions
  -> 1 executable characterization + pure domain extraction
  -> 2 shared PosApplication + PlatformPorts + Electron compatibility adapter
  -> 3 Android shell, online read-only catalog only
  -> 4 native SQLite/read model + three-ledger design
  -> 5 durable order journal/outbox/reconciliation with writes disabled
  -> 6 sandbox-only online cash/order/shift exercise behind server kill switch
  -> 7 guarded remote printing + fiscal/legal gate before any real-salon cash sale
  -> 8 build/sign/process/promote release pipeline
  -> 9 shadow pilot and owner-approved rollout
```

## 1. Outcome

Build a real Android tablet POS from the current React/TypeScript renderer while keeping the Windows Electron application stable. Shared product, cart, pricing, payment-contract, order/outbox, reconciliation, remote-print coordination, and UI changes must live in one `PosApplication` layer. Platform-specific storage, HTTP, secure-store, camera, lifecycle, and device integration remain behind narrow `PlatformPorts`.

The release pipeline builds immutable Windows and Android candidates from the same Git commit and product version, but records independent platform build numbers and promotion states. Windows may use its Electron updater only after its signing/trust workstream is approved. Android uses managed/private Google Play by default; a sideload build is a separate flavor/channel and is never bundled with Play self-update permissions.

## 2. Decisions made for this plan

1. **Android tablet first.** A 10-inch-or-larger tablet and `1280x800` landscape are the primary cashier target, not a safety boundary. Rotation, portrait fallback, split-window resizing, activity recreation, and state restoration must not lose cart/order state because Android 16 can ignore orientation restrictions on large screens.
2. **Capacitor shell, not React Native.** The existing React, Vite, Tailwind, translations, and POS components remain useful. React Native would require a UI rewrite.
3. **Separate Android renderer entry.** Do not boot the complete desktop `App.tsx` inside Android. The Android entry imports only supported POS features, preventing unsupported Electron modules from executing.
4. **One package initially.** Do not introduce npm workspaces or move the whole repository in the first phase. Add platform contracts and extract pure code incrementally.
5. **Two stable boundaries.** Renderer components call shared `PosApplication` use cases. `PosApplication` calls narrow `PlatformPorts`. Shared code must not call `window.electronAPI`, Capacitor, Node, or native APIs directly.
6. **Windows behavior remains the reference.** Every extraction starts with characterization tests. The Electron adapter delegates to the existing IPC handlers without changing their behavior.
7. **Native Android SQLite for durable POS data.** Do not rely on WebView local storage for orders, tokens, outbox, or catalog durability. Plugin/custom implementation, encryption, WAL, backup, corruption, and export behavior require an ADR plus a synthetic process-kill spike before production data is stored.
8. **Remote fiscal printing for Android MVP.** Android submits a guarded print job to the existing Windows Print Agent. Direct Android Posnet/ELZAB support is a separate hardware project.
9. **No silent sideload on ordinary devices.** Fully automatic silent APK installation is allowed only through managed Google Play or a company-owned fully managed Android device.
10. **Release, not live-code push.** Shared JavaScript is delivered inside signed Windows/Android releases. Do not hot-swap POS code from an unsigned web endpoint.
11. **Target API 36 for the first Play release.** This matches Capacitor 8 and the general Google Play requirement taking effect on 2026-08-31. Permanently private organization apps are currently exempt from that Play deadline, but the project still targets 36. Minimum Android remains provisionally Android 9/API 28 and must be confirmed against the real tablet fleet. Capacitor 8 also requires a Node 22+/AGP 8.13/Gradle 8.14.3 toolchain decision.

## 3. Current-state evidence

- The application is Electron 33 + React 18 + Vite and targets Windows.
- The renderer has 249 TypeScript/TSX files. Ninety-five files contain `electronAPI` calls, with 641 total references.
- Electron main owns networking, secure token storage, SQL.js persistence, sync workers, printing, scanners, Booksy, multi-window behavior, and auto-update.
- The local POS database has 56 migrations and multiple durability/outbox tables. It cannot be replaced with browser storage.
- Existing Android projects are `android-tv-ads` and `android-tv-remote`; neither is an Android POS.
- Windows release CI currently builds only the NSIS installer and uploads `latest.yml` plus the EXE to Cloudflare R2.
- The backend already exposes catalog, POS order, shift, product-admin, POS event, and print-job endpoints. An endpoint/auth contract audit is still required before Android writes are enabled.

## 4. Scope

### 4.1 Android MVP included

- Staff email/password login with rotating access/refresh JWT for all order and shift writes.
- Staff-JWT printer discovery, remote print request/status, fiscal event, and guarded retry. If a separate Android credential is later required, it must be terminal-scoped and must not reuse print-agent identity or the salon-wide `pa_` key.
- Stable Android device identity and salon binding.
- Native secure-session broker for staff tokens and terminal/device registration. Android WebView JavaScript receives only a session projection; raw refresh tokens remain in native Keystore-backed code. No salon-wide print-agent API key is stored.
- Entitlement and platform-capability gating.
- Retail catalog sync: categories, products, price, VAT, stock, images, barcode.
- Search, category browsing, barcode lookup, and camera barcode scan.
- Cart operations, weight/manual quantity, discounts, VAT, and price guards.
- Shift open/close.
- CASH only for Android order writes until the backend contract explicitly distinguishes recorded, authorized, captured, failed, and unknown electronic tender.
- CARD/BLIK/transfer/split containing electronic tender remain disabled compatibility types/fixtures until a real provider/business contract, durable authorization/reference, backend validation, and owner approval exist.
- Idempotent order creation.
- Native SQLite catalog/order/outbox persistence.
- Durable lost-response/outbox handling. Deliberately offline selling remains disabled by default and requires a later fiscal/payment decision.
- Remote receipt/fiscal print job through a Windows agent, with confirmed/pending/failed state.
- Order history sufficient to inspect and retry Android-originated orders.
- Android app update through managed/private Play; signed APK fallback for test devices.
- Vietnamese, Polish, and English UI at minimum; reuse all compatible existing translations.
- Diagnostics: app version, Git SHA, device ID suffix, salon/user/device-registration ID, target printer/agent only when attached to a specific print job, sync status, outbox count, last error.

### 4.2 Explicitly out of MVP

- Direct Android Posnet or ELZAB fiscal printer driver.
- Windows Printer API, COM-port discovery, Windows DPAPI, cash-drawer pulse, printer-driver installation.
- Booksy CDP/desktop-browser automation.
- SSH tunnel and desktop remote-control tools.
- Windows backup-folder UI.
- Second-monitor customer display.
- Android TV Ads management.
- Security-camera module.
- Label designer and local Zebra/Windows label printing.
- Self-checkout and kitchen kiosk modes.
- Full product-admin/warehouse/forecast parity.
- Phone-optimized and full portrait product UX. Portrait/rotation safety fallback on tablets remains an MVP requirement.

Unsupported modules must be hidden by platform capabilities; they must not render disabled controls that call missing APIs.

## 5. Target architecture

```text
                         shared React POS UI
                                  |
                   shared PosApplication use cases
              cart / order / outbox / reconcile / print state
                                  |
                         PlatformPorts contract
                          /                       \
             ElectronPlatformPorts           AndroidPlatformPorts
                    |                               |
              existing IPC                   Capacitor plugins
                    |                               |
          Electron main process          Android native services
          SQL.js / Windows I/O            SQLite / Keystore / camera
                    \                               /
                     versioned eNail backend APIs
```

### 5.1 Proposed source layout

```text
src/
  core/
    pos/                         # pure cart, price, order and tender rules
    sync/                        # pure retry/idempotency/state-machine rules
  application/
    pos-application.ts           # shared use cases and state-machine orchestration
    order-journal.ts
    remote-print-coordinator.ts
  platform/
    contracts/
      platform-ports.ts
      platform-capabilities.ts
      storage-api.ts
      print-api.ts
      scanner-api.ts
    electron/
      electron-platform-ports.ts # delegates native effects to existing IPC
    android/
      android-platform-ports.ts  # Capacitor/native-effect adapter
  renderer/
    android-pos/
      index.html
      main.tsx
      AndroidPosApp.tsx
    components/pos/              # shared responsive POS components
android-pos/                     # generated/checked-in Capacitor Android project
capacitor.config.ts
vite.android.config.ts
scripts/
  derive-android-version-code.mjs
  verify-cross-platform-boundaries.mjs
tests/
  platform-contract.test.ts
  android-platform-boundary.test.ts
  android-pos-*.test.ts
```

### 5.2 Contract shape

Use feature-oriented application use cases plus narrow effect ports, not raw IPC names or generic SQL:

```ts
interface PlatformPorts {
  platform: {
    kind: 'windows' | 'android';
    version: string;
    capabilities(): Promise<PlatformCapabilities>;
  };
  secureStore: SecureStorePort;
  database: DatabasePort;
  http: HttpTransportPort;
  scanner: ScannerPort;
  lifecycle: LifecyclePort;
  backgroundSignal: BackgroundSignalPort;
  remotePrintTransport: RemotePrintTransportPort;
  diagnostics: DiagnosticsApi;
}

interface PosApplication {
  auth: AuthUseCases;
  catalog: CatalogUseCases;
  cart: CartUseCases;
  orders: OrderUseCases;
  shifts: ShiftUseCases;
  sync: SyncUseCases;
  printing: PrintUseCases;
}
```

Rules:

- No `ipcRenderer`, Electron, Node filesystem, Android, Capacitor imports, Node globals, or `window.electronAPI` references inside `src/core`, `src/application`, or shared renderer components.
- `PosApplication` exposes business operations such as `orders.create()` and `printing.requestReceipt()`. `PlatformPorts` exposes only effects; neither exposes `invoke(channel, payload)` or raw repository access to UI code.
- Subscriptions return an unsubscribe function.
- Every operation has typed success/failure states. Do not return unstructured `any` for new APIs.
- Capability checks are separate from salon entitlements. A feature renders only when both allow it.
- Boundary validation must inspect the transitive Android import graph. A simple “no Electron import” grep is insufficient because the current renderer accesses `window.electronAPI` as a global.

## 6. Platform capability matrix

| Capability | Windows | Android MVP | Later Android |
|---|---:|---:|---:|
| Catalog/cart/order | Yes | Yes | Yes |
| Native durable SQLite | SQL.js file | Native SQLite | Native SQLite |
| Camera barcode scan | Limited/current flow | Yes | Yes |
| USB HID scanner as keyboard | Yes | Yes, validate device | Yes |
| Network receipt print via Windows agent | Yes | Yes | Yes |
| Direct Bluetooth/USB thermal print | No/current drivers differ | No | Optional |
| Direct fiscal print | Yes | No | Separate certified project |
| Cash drawer | Yes | No | Only through remote printer |
| Product admin | Yes | Read-only catalog | Later |
| Booksy desktop sync | Yes | No | No |
| Customer second display | Yes | No | Separate tablet/display app |
| Auto-update | R2 + electron-updater | Managed Play | Managed Play |

## 7. Implementation sequence

Each phase must land as reviewable commits. Do not combine backend schema work, platform refactor, Android UI, and release automation in one commit.

### Phase -1 — Canonical source selection and safety-fix reconciliation

Goal: prevent Android work from branching off a convenient but incomplete source snapshot.

Tasks:

1. Create or select one full-history POS development checkout; record remote URL, branch, HEAD, and worktree status.
2. Treat the shallow `downloads/POS-zira-latest-20260716-f0ee58b` tree as read-only audit evidence only.
3. Compare `origin/main`, the `fix/review-blockers-20260712` branch, and the clean `chesaigon` checkout with `git log --left-right --cherry-pick` plus exact file diffs.
4. For every local-only safety commit, record: keep/drop decision, reason, applicable newer-code conflict, tests, and reviewer.
5. Create the Android feature branch only after the selected baseline has the approved safety fixes and clean Windows baseline evidence.
6. Do not modify, build, install, close, or restart the live counter app during this phase.

Exit gate:

- One canonical POS base SHA is named and has full history.
- Divergent fiscal, DB, sync, printing, and PIN safety fixes have an explicit disposition.
- The clean source baseline matches the intended Windows release lineage; the downloaded shallow artifact is not used as the implementation branch.

### Phase 0 — Baseline, device decisions, and contracts

Goal: produce evidence before changing runtime behavior.

Tasks:

1. Create a POS feature branch from the reconciled Phase -1 base, for example `codex/android-pos-shared-runtime`.
2. Record baseline results:
   - `npm ci`
   - `npm test`
   - `npm run typecheck:renderer`
   - `npm run build:main`
   - `npm run build:renderer`
   - Windows installer build in Windows CI.
3. Save a machine-readable baseline list of known test failures; do not hide new failures inside the baseline.
4. Confirm at least two target Android tablets:
   - Android version/API level
   - screen size and landscape resolution
   - RAM/storage
   - camera availability
   - USB host/Bluetooth/LAN
   - kiosk/managed-device ownership
5. Decide distribution:
   - preferred: private/managed Google Play;
   - pilot: Play internal testing;
   - fallback: signed APK sideload with user confirmation.
6. Write an API contract inventory mapping every Android MVP operation to the existing backend route, auth mode, idempotency field, retry semantics, and response type.
7. Produce a backend change request for any missing contract. Do not add client-only workarounds.
8. Decide fiscal behavior with the owner/accounting operator. Until approved, Android must not claim that a fiscal receipt printed without a confirmed print-job result.
   - First prepare a separate backend security/reliability fix for tenant-scoped receipt lookup and failure-class-to-receipt-status mapping.
   - This is an independent production release with its own tests, guarded lane, rollback/recovery plan, and verification; this Android plan does not authorize that deploy.
9. Fix the auth decision: staff JWT is mandatory for Android sales, shifts, printer discovery, print create/status, and fiscal event routes. Android does not store the salon-wide print-agent `pa_` key or call `/print-agent/connect`. If a separate credential is required later, design a terminal-scoped credential. Document token refresh, logout, expiry, revocation, and device-loss behavior.
10. Produce a state-ownership table for `orders` upload state, `local_sync_log`, and `pos_event_outbox`, including transaction boundaries and idempotency identifiers.
11. Decide whether Android is a separately registered POS terminal or merely an authenticated staff client. Do not add `clientPlatform` to `print_agents` until this ADR is accepted.
12. Specify server-side deny-by-default Android gates for device/session access, catalog, sales, offline sales, and remote fiscal printing. Client capability flags are not kill switches.
13. Run the Capacitor 8 toolchain spike with exact Node 22, npm 10, JDK 21, AGP 8.13, Gradle 8.14.3, compile/target SDK 36. Re-run the full Windows build/test baseline under Node 22 before changing repository engines or CI.
14. Decide Android backup/device-transfer policy. Default for POS secrets, installation ID, tenant data, SQLite, and outbox is exclusion from cloud and device-to-device restore.
15. Define payment semantics per tender: recorded, externally authorized, captured, failed, unknown. Keep BLIK disabled and do not map an offline CARD/BLIK choice directly to backend `PAID`.
16. Prove a clean Windows tag build does not depend on an ignored/stale Android TV APK. Split or explicitly build/sign that dependency.

Exit gate:

- Baseline builds are recorded.
- Real target hardware and update channel are named.
- Every MVP write has an existing endpoint or an approved server change request.
- Fiscal offline behavior is explicitly accepted or disabled.
- The two production fiscal P0s are fixed in canonical backend source, landed through the guarded backend lane, and verified in the built production artifact before any Android fiscal test uses real jobs.
- Staff-JWT responsibilities and the prohibition on Android print-agent identity/`pa_` storage are unambiguous.
- Toolchain spike passes without new Windows regression.
- Server kill-switch design, ledger ownership, terminal-device model, backup policy, and tender semantics are approved before any Android write work.

### Phase 1 — Pure core extraction with zero Windows behavior change

Goal: isolate portable business logic before Android uses it.

Tasks:

1. Move or re-export pure money/sale/stock helpers from `src/shared` into a platform-neutral core boundary without breaking imports.
2. Split `src/main/pos/pos-store.ts` into:
   - pure state/types/reducer/cart calculations;
   - Electron host effects such as product-repository lookup, logger, customer display, and BrowserWindow notification.
3. Extract pure order payload construction, idempotency-key creation, tender normalization, and VAT/rounding rules from Electron/database orchestration.
4. Add characterization tests before each extraction. The same fixtures must produce byte-equivalent backend payloads before and after.
5. Add a boundary test that fails if `src/core` imports `electron`, `@capacitor/*`, `fs`, `path`, `child_process`, or main-process repositories.

Likely touched files:

- `src/main/pos/pos-store.ts`
- `src/main/pos/payment-controller.ts`
- `src/shared/pos-sale.ts`
- `src/shared/product-money.ts`
- `src/shared/pos-price-guard.ts`
- `src/shared/product-sale-classifier.ts`
- new `src/core/pos/*`
- existing POS/payment/order tests plus new core tests

Exit gate:

- Windows test/build baseline is green or unchanged.
- Pure core has no platform imports.
- Cart totals, VAT, weighted products, discounts, payment tenders, and order payload fixtures match the original behavior.

Rollback:

- Revert the extraction commit only; no database or backend contract changes exist yet.

### Phase 2 — Shared application layer, platform ports, and Electron compatibility adapter

Goal: introduce one shared business/application layer and narrow native ports while keeping Electron as the only runtime.

Tasks:

1. Define `PlatformPorts` and `PlatformCapabilities` in `src/platform/contracts`.
2. Define shared `PosApplication` use cases and state ownership in `src/application`; keep cart/order/outbox/reconciliation/remote-print decisions out of platform adapters.
3. Implement `ElectronPlatformPorts` by delegating only native effects to existing IPC/repositories.
4. Add a React provider/hook for `PosApplication`, for example `PosApplicationProvider` and `usePosApplication()`.
5. Migrate only a read-only slice in this phase:
   - authentication/config reads used by POS;
   - categories/products/search/barcode reads.
   Runtime cart, shifts, order creation/history, outbox, sync, payment, and print coordination wait for their Phase 4/5 state ownership and durability gates. Their interfaces may exist as non-wired types only.
6. Leave non-MVP desktop modules on existing APIs temporarily, but prevent new direct calls with a transitive import/AST boundary test.
7. Preserve the preload API until all desktop consumers are migrated. Do not perform a 641-call global rename in one commit.

Exit gate:

- Windows UI behavior and tests remain unchanged.
- Migrated read-only catalog components run through `PosApplication`; no order/shift/payment/print write is wired, and business state machines do not live in `ElectronPlatformPorts` or `AndroidPlatformPorts`.
- Contract tests can execute against a fake in-memory adapter.

### Phase 3 — Android shell and read-only POS

Goal: install a sandbox/dev APK that authenticates against a sandbox, downloads an online catalog, and renders the shared POS UI without writes.

Tasks:

1. Pin Capacitor and related packages to one reviewed major/minor version in `package-lock.json`.
2. Add `vite.android.config.ts` with a dedicated output directory such as `dist/android-web`; configure Capacitor's Android project path explicitly as `android-pos/` so `cap sync android` and the documented Gradle path agree.
3. Add `src/renderer/android-pos` and mount only the supported Android POS route.
4. Add the checked-in `android-pos/` project only after the Node 22/toolchain gate passes, with:
   - unique application ID, for example `pl.zira.pos`;
   - release signing separated from debug signing;
   - `compileSdk`/`targetSdk` 36;
   - provisional `minSdk` 28;
   - HTTPS-only production network policy;
   - WebView debugging disabled in release;
   - landscape as the preferred cashier viewport, with adaptive portrait/split-window/activity-recreation behavior;
   - correct status/navigation-bar insets.
5. Implement a native Android session broker using Keystore-backed encrypted storage. It owns refresh rotation and authenticated transport; raw refresh tokens never enter WebView JavaScript, localStorage, or plain SQLite.
6. Store secrets and installation identity in no-backup storage and add explicit cloud/device-transfer exclusions for SQLite, outbox, tenant data, and preferences.
7. Generate and persist a random installation ID on first launch. Use it as the device identity; do not use IMEI, serial number, or other restricted identifiers. A restored/reinstalled app must receive a deliberate new identity unless an approved terminal re-enrollment flow says otherwise.
8. Implement staff auth/token refresh through the native session broker. Use authenticated staff routes for printer discovery/create/status/fiscal; do not add print-agent API-key pairing to Android MVP.
9. If the Phase 0 ADR requires platform/app-version reporting, add it to the actual connect/login/device-registration DTO selected by that ADR. Do not default to a `print_agents` entity migration and do not make the Android app open a printer-host WebSocket.
9. Implement catalog read/sync and a read-only POS screen.
10. Add responsive changes for fixed desktop widths, touch targets, safe areas, system back button, and soft keyboard.

Possible backend work only after the terminal-device and kill-switch ADRs are approved:

- device/login/connect DTO actually used by the chosen flow;
- server-side deny-by-default Android guard and audit tests;
- a separate terminal-device entity only if the ADR proves persistence is required;
- backward-compatibility tests proving Windows 1.0.23 remains accepted.

Exit gate:

- Signed debug/pilot APK installs on both target tablets.
- Login/device-registration/catalog testing is sandbox-only until the server-side deny-by-default Android device gate is implemented, deployed through the guarded backend lane, and verified. Without that gate, no production credential or salon is used.
- Staff session/device registration behaves according to the Phase 0 policy across restart. Logout revokes/removes staff tokens; device unpair/revoke is a separate audited action and removes terminal enrollment.
- Online catalog reload works after app restart. Offline catalog cold start is a Phase 4 gate and must not be faked with WebView storage.
- Android bundle contains no Electron import.
- Transitive Android graph contains no `window.electronAPI`, Node globals/modules, or top-level Windows-only side effects.
- No order or stock write is enabled yet.

Rollback:

- Before the server gate exists: revoke sandbox sessions and uninstall the dev build; there is no production Android access to disable.
- After the gate is implemented/deployed/verified: disable Android access server-side and revoke device sessions; Windows is unaffected.

### Phase 4 — Native SQLite, migrations, and offline read model

Goal: make catalog and POS state durable enough for a cashier device.

Tasks:

1. Define repository contracts for the MVP tables only:
   - products/categories;
   - orders/order_items;
   - shifts plus a separate durable shift-command journal;
   - catalog cursor/read-model sync log;
   - durable order upload journal/outbox;
   - ERP/financial `pos_event_outbox` as a separate downstream ledger;
   - print request journal.
2. Complete an ADR and synthetic spike comparing a reviewed community SQLite plugin with a feature-oriented custom Capacitor plugin. Evaluate Java/JDK, SQLCipher/export implications, deprecated dependencies, WAL/checkpoint, corruption, backup, and recovery before selecting one.
3. Implement Android native SQLite behind the selected feature-oriented port. UI code never receives generic raw SQL access.
4. Reuse compatible SQLite schema semantics, but do not blindly run the entire 56-migration Windows database on Android. Create an Android schema starting at version 1 containing only MVP tables.
5. Add deterministic migrations with transaction, encrypted/exportable diagnostics, and failure handling.
6. Implement atomic order + items + order-journal insertion in one transaction. ERP/financial events are separately derived and deduped; they are never the order transport.
7. Implement app lifecycle flush and process-death recovery.
8. Add catalog cursor persistence, paged/category/barcode queries, image-cache policy, cold-start SLA, and full-sync fallback. Do not serialize the full catalog through the Capacitor bridge on every refresh.
9. Add per-salon partition protection. A salon switch must never display or upload the previous salon's local data.
10. Add storage-pressure and corrupt-database behavior. Preserve the bad file for diagnostics; do not silently delete unsynced orders.
11. Add manifest backup exclusions plus reinstall, cloud-restore, and device-to-device transfer tests for installation ID, credentials, SQLite, and pending work.

Exit gate:

- Catalog works offline after a successful sync.
- Killing the app during save cannot produce a half-order.
- Reopening after process death restores the cart/order/outbox state defined by the product decision.
- Salon A data cannot appear in Salon B.
- Order journal, read-model sync log, and ERP event outbox have separate schemas and executable transition tests.

### Phase 5 — Durable order journal, outbox, and reconciliation with writes disabled

Goal: prove durable order and shift-command safety state machines before a cashier can submit a real write.

Tasks:

1. Implement one shared `PosApplication` order-journal state machine:
   - `LOCAL_DRAFT`
   - `PENDING`
   - `SENDING`
   - `ACKED`
   - `RETRY_WAIT`
   - `DEAD_LETTER`
   - `RECONCILIATION_REQUIRED`
2. Freeze local order ID, backend DTO, idempotency header/body fields, payload hash, device ID, salon ID, and creation time before the first send.
3. Recover stale `SENDING` rows after process death without creating a replacement ID.
4. Add server reconciliation by idempotency key/backend order ID before any resend can create a replacement.
5. Add bounded exponential backoff with jitter and a guarded manual action. Unknown outcome is not a normal failure.
6. Run the state machine against a fake transport and sandbox backend while the real Pay write remains disabled by the server gate.
7. Keep the ERP/financial event ledger downstream and independently idempotent; it does not own order upload.
8. Add an operator-visible unresolved-order counter/detail model and an encrypted diagnostic export.
9. Choose background semantics explicitly:
   - MVP default: foreground launch/resume/network-online drain; WorkManager may only signal “sync due”; or
   - native Kotlin worker: reads the same SQLite/token/idempotency contract and passes the same fixtures.
   A WorkManager declaration alone cannot execute the shared WebView TypeScript state machine.
10. Never clear or reinstall over unsynced orders without an export and owner decision.
11. Define a separate durable shift-command journal for open/close with stable command ID, target machine/shift, request payload/hash, response, stale-send recovery, and authoritative server reconciliation. If the backend cannot guarantee idempotent/reconcilable open/close, Android shift writes remain disabled and the server shift is read-only.

Mandatory chaos tests:

- connection lost during request;
- backend accepts but response is lost;
- process killed between local commit and request;
- process killed after backend acceptance but before local ACK;
- repeated manual retry;
- device reboot;
- clock skew;
- access-token expiry and refresh failure during drain;
- salon logout/switch while unresolved work exists.
- shift open response lost, repeated open, close response lost, repeated close, and app death between local shift command commit and server ACK.

Exit gate:

- Every chaos case ends in exactly one sandbox/backend order or an explicit unresolved state.
- There is no silent data loss, replacement ID, automatic duplicate creation, or cross-salon drain.
- Real order writes are still denied until Phase 6 approval.
- Real shift writes are still denied unless the shift-command journal and server idempotency/reconciliation contract pass the same lost-response gates.

### Phase 6 — Adaptive cart, shifts, and sandbox-only online cash exercise

Goal: exercise a controlled online cash command using only a sandbox/test tenant and synthetic money/stock, through the shared Phase 5 journal and the same executable business fixtures as Windows. This phase does **not** authorize a real salon sale, real cash collection, accounting stock mutation, invoice, or fiscal obligation.

Tasks:

1. Migrate the retail template and shared cart/payment components to `PosApplication` without importing the complete Windows `POSLayout` graph.
2. Fix desktop assumptions:
   - fixed cart widths;
   - hover-only actions;
   - keyboard shortcuts without touch equivalents;
   - modals that exceed rotated, split-window, or soft-keyboard space;
   - activity recreation/state restoration.
3. Implement camera barcode scanning and keep USB HID keyboard scanning as a separate input path. Test focus, IME, suffix key, rotation/resume, and duplicate scan behavior on real hardware.
4. Reuse pure shared rules for weighted quantities, VAT, rounding, price guards, discounts, and tenders.
5. Submit through `/api/v1/b2b/pos/orders` only with staff JWT and the Phase 5 stable identifiers. Persist backend ID/status before presenting completion.
6. Implement shifts using `/api/v1/pos/shifts` only after the Phase 5 shift-command contract proves idempotent lost-response recovery. Refuse close when local unresolved orders or fiscal `UNKNOWN` exist even if the backend does not know them. Otherwise keep shift state read-only on Android and use Windows for open/close.
7. Add order history states that distinguish local save, backend sync, tender record/authorization, and print state.
8. Enable only CASH for runtime order writes. CARD/BLIK/transfer/split electronic-tender shapes may remain in disabled legacy characterization fixtures but must not be submitted to the current order route as paid.
9. Keep “offline before Pay” disabled. The durable journal handles lost responses; deliberate offline selling is a separate owner/legal/fiscal gate after Phase 7.
10. Enforce sandbox/test tenant and server capability at the backend. A client-visible flag or hidden UI is insufficient. If the backend cannot guarantee non-production accounting/stock effects, keep submission mocked and do not call the order route.

Exit gate:

- CASH runtime fixtures and disabled legacy electronic-tender characterization match the documented Windows/backend semantics without enabling electronic payment.
- Double tapping Pay produces one backend order through the durable journal.
- A lost response replays/reconciles with the same ID, header/body idempotency values, and payload hash.
- Shift close refuses or clearly reports local and backend unresolved orders.
- Server-side Android sales allowlist can disable the flow without a client update.
- No real customer, real cash, production salon, accounting stock, invoice, or fiscal receipt is touched. A real-salon cash pilot remains blocked until Phase 7 printing/fiscal reconciliation, legal applicability, and explicit owner approval are complete.

### Phase 7 — Guarded remote printing

Goal: allow Android to request printing without pretending to be a local fiscal driver.

Tasks:

1. Use the existing backend print-agent job endpoints and salon printer assignments.
2. Extract/reuse one shared remote-print coordinator for idempotency, wait timeout, authoritative status polling, failure classification, and safe retry. Platform adapters provide transport only.
3. Before payment completion UI claims print success, resolve:
   - assigned printer role;
   - Windows agent online/offline status;
   - job reservation/dispatch result;
   - terminal print status.
4. Authenticate Android remote print with staff-JWT routes. Do not store a salon-wide print-agent `pa_` key, call `/print-agent/connect`, fork an agent row, impersonate an online printer host, or open the agent WebSocket. A future terminal-scoped credential requires its own ADR.
5. Journal Android print requests locally with order ID, backend order ID, idempotency key, payload hash, job ID, target agent/printer ID, attempt, status, failure class, error, and timestamps.
6. Expose safe retry only when the authoritative backend classification is `SAFE_BEFORE_PRINT`. Timeout, in-flight, or uncertain-after-print outcomes require operator reconciliation, not automatic retry.
7. Show separate states:
   - order saved;
   - backend order synced;
   - print requested;
   - print confirmed;
   - print unknown/failed.
8. Keep direct Bluetooth/USB thermal and fiscal printer plugins disabled in MVP.
9. Require the backend order to be accepted/reconciled before fiscal print unless an owner/legal-approved offline fiscal protocol explicitly replaces this rule.
10. After real printer tests, make a separate go/no-go decision for deliberate offline selling. The initial production pilot may remain online-only.

Exit gate:

- An offline Windows print agent cannot result in a false `PRINTED` status.
- Repeated Android taps cannot create duplicate fiscal print jobs.
- Unknown outcomes force a visible reconciliation path.
- A real printer/agent test is completed; unit tests alone are insufficient.

### Phase 8 — Dual-platform release and update pipeline

Goal: build immutable candidates from one tag/SHA, prove identity, and promote each platform only after its own processing/signing gates.

Tasks:

1. Keep `package.json.version` as the shared semantic version.
2. Use a monotonic Android `versionCode` release ledger/CI allocator that increases across every Play track and remains `<= 2,100,000,000`. A semver formula may seed the value but must also handle rebuilds, prereleases, and platform-only hotfixes without collision.
3. Add CI jobs:
   - `test-shared`
   - `build-windows`
   - `build-android`
   - `release-manifest`
   - `upload-android-play-internal`
   - `verify-android-processed`
   - `promote-windows-r2`
   - `promote-android-track`
4. Enforce that tag `vX.Y.Z` equals `package.json` version.
5. Build the Windows EXE and Android AAB/APK from the same checkout SHA.
6. Generate an immutable release manifest containing product version, per-platform build number, Git SHA, build time, artifact names, SHA-256, separate signing-certificate fingerprints, compatibility range, channel, and states `built/uploaded/processed/approved/promoted`.
7. Keep three Android identities separate:
   - CI upload key used to sign the AAB submitted to Play;
   - Play app-signing certificate that signs the APK delivered to devices;
   - optional enterprise-sideload signer.
   CI holds only the protected upload key and, if approved, the separate sideload key. It does not hold the Play app-signing key. Never use debug signing for production.
8. Add an owner-reviewed Windows Authenticode workstream: certificate custody, timestamping, publisher verification, rotation, revocation, and updater trust. `latest.yml` checksum alone is not a signing boundary when the installer and manifest share R2 credentials.
9. Build jobs upload CI artifacts only. They must never mutate R2 `latest.yml` or a Play production track.
10. Upload Android to Play internal, wait for processing, verify signer/package/version, and require protected-environment approval before any promotion.
11. Promote Windows `latest.yml` only after required shared/Windows/Android candidate gates pass. Play availability is asynchronous; record platform states instead of claiming a cross-store atomic transaction.
12. Keep a documented platform-only emergency lane for critical Windows fiscal fixes. It may promote Windows alone only when the shared compatibility manifest proves the Android build remains compatible and an owner approves the exception.
13. Use separate Android flavors/channels:
    - `play`: no `REQUEST_INSTALL_PACKAGES`, no self-updater, managed Play updates only;
    - optional `enterpriseSideload`: separate distribution policy and stable signer. If its signer differs from Play App Signing, use a separate application ID or accept that in-place migration is impossible.
14. If APK sideload is retained, require HTTPS, APK signature continuity, checksum, and a verified signed manifest. Ordinary unmanaged devices still show Android installation confirmation.
15. Add CI/static gates for backup exclusions, cleartext/debuggable settings, exported components, Capacitor navigation/bridge allowlists, CSP, forbidden installer permission in Play flavor, exact displayed version/SHA, upload certificate fingerprint, processed Play app-signing fingerprint, and optional sideload fingerprint.
16. This POS artifact workflow is not an eNail backend/frontend production deployment lane and must never invoke Contabo deployment or migration steps.

Exit gate:

- One test tag produces both installable artifacts from one Git SHA.
- Windows update test passes on a non-production workstation with the approved publisher/trust checks.
- Android update from version N to N+1 preserves database, token, pending outbox, and the signing identity actually installed for that channel.
- Installed Play update tests verify the certificate of the processed/delivered APK, not merely the AAB upload key.
- Failed required platform build prevents normal-channel promotion. Platform-specific exceptions require the compatibility manifest and explicit approval.
- Play flavor contains no sideload installer permission/self-updater; no publish job can run from an unprotected build job.

### Phase 9 — Pilot and controlled rollout

Goal: prove operational safety before broad installation.

Pilot order:

1. Developer tablet, sandbox salon, no real fiscal printing.
2. One internal tablet with test catalog and test print agent.
3. One real salon in shadow mode: browse/cart only; Windows remains the sale source.
4. One Android register enabled for limited sales with owner present.
5. Expand only after reconciliation metrics stay clean.

Monitor:

- crash-free sessions;
- auth refresh failures;
- catalog sync age;
- outbox pending/dead-letter count and oldest age;
- duplicate-idempotency conflicts;
- local/backend total mismatch;
- print pending/unknown/failed rate;
- app version and Git SHA by device;
- update adoption.

Kill switches:

- Android device/session access enabled;
- Android catalog enabled;
- Android sales enabled;
- Android offline sales enabled;
- Android remote fiscal printing enabled.

Exit gate:

- Zero unexplained duplicate/missing orders in pilot reconciliation.
- No unknown fiscal result left without an operator action.
- Update N to N+1 succeeds on every pilot device.
- Owner gives an explicit go-live confirmation.

## 8. Testing strategy

### Shared/unit

- Vitest for pure cart, VAT, rounding, weight, discount, tender, payload, retry, and state-machine logic.
- Contract fixtures executed against Electron and Android adapters.
- Import-boundary tests for platform purity.

### Web renderer

- Playwright against the Android Vite build with a fake `PosApplication` and fake `PlatformPorts`.
- Viewports: `1280x800`, `1024x600`, and target physical tablet resolution.
- Touch-only navigation, soft keyboard, offline banner, double-tap protection, and accessibility labels.

### Android native

- Gradle unit tests for device identity, secure storage wrapper, SQLite migrations, update metadata, and plugin input validation.
- Instrumentation/UI Automator for staff login, printer discovery, relaunch, camera permission, scanning, rotation, portrait, split window, activity recreation, offline/online, process kill, backup/restore exclusion, and update preservation.
- Physical-device validation for camera, USB HID scanner, managed update, sleep/wake, reboot, rotation, multi-window, WebView version, and LAN behavior.

### Backend

- Old Windows connect payload remains accepted.
- Android platform/device metadata is authenticated, tenant-scoped, backward compatible, and cannot be self-asserted to bypass a gate.
- Order idempotency and lost-response replay.
- Print-job dedupe and unknown-result handling.
- Feature flags deny Android writes by default until enabled.
- Cross-tenant fiscal receipt references return 403/404 and cannot mutate an existing row.
- `UNCERTAIN_AFTER_PRINT` is persisted/displayed as `UNKNOWN`, never ordinary failed/not-printed.

### Release acceptance commands

Exact commands may change after Capacitor is pinned, but CI must cover at least:

```bash
npm ci
npm test
npm run typecheck:renderer
npm run build:main
npm run build:renderer
npm run build:android-web
npx cap sync android
cd android-pos && ./gradlew test assembleDebug bundleRelease
```

Windows installer validation remains on a Windows runner.

The Capacitor 8 lane uses Node 22/JDK 21/SDK 36. The Windows runner must first pass the same Node 22 dependency/test/build baseline; do not silently leave Windows on an untested Node 20 lockfile path.

## 9. Database compatibility and rollback rules

1. Backend changes must be additive while Windows 1.0.23 remains deployed.
2. Android database migrations are forward-only and transactional.
3. Version N+1 must open version N data. A rollback to N is not assumed safe after an N+1 schema migration.
4. Rollback normally means disabling the feature flag and releasing N+2 with a fix, not installing an older binary over a newer database.
5. Never delete pending/dead-letter outbox rows automatically.
6. Provide an encrypted/exportable diagnostic bundle before any destructive database recovery.
7. Backend production migrations require the separate eNail backup/rollback/deploy approval workflow. This plan does not authorize a production migration or deploy.

## 10. Security requirements

- API keys, access tokens, and refresh tokens: native Keystore-backed broker only. Raw refresh tokens and generic bearer-token request APIs must not cross into WebView JavaScript.
- Keystore ciphertext, installation identity, preferences, SQLite, outbox, and tenant files must be excluded from Android cloud backup and device-to-device transfer using both legacy and Android 12+ rules; default POS policy is `allowBackup=false` unless an ADR proves a safe selective backup.
- Logs and analytics must redact credentials, customer phone/email, receipt contents where not required, and full device identifiers.
- Production Android WebView must disable debugging and cleartext traffic.
- Production Capacitor config and WebView must use a strict CSP, no production `server.url`, empty/allowlisted navigation, no mixed content, reviewed native-bridge mode, a minimal plugin allowlist, and a minimum supported WebView/update policy.
- Play AAB uses a stable upload key, delivered Play APK uses the registered Play app-signing certificate, and enterprise sideload uses its separately documented stable signer. Their fingerprints and rotation procedures must not be conflated.
- Deep links and exported Android components must be allowlisted and tested.
- File sharing uses Android `FileProvider`, never `file://` exposure.
- Runtime camera/Bluetooth permissions require a refusal-safe UX.
- Multi-tenant storage keys, queries, sync payloads, and diagnostics must always include/verify salon identity.
- Use a physical database or equally strong cryptographic/transactional partition per salon. Pending work drains only with a staff session whose tenant matches the immutable row tenant; logout/switch fails closed.
- Do not reuse the Android TV debug signing configuration for the POS app.
- Play flavor must not declare `REQUEST_INSTALL_PACKAGES` or contain a self-updater.

## 11. Delivery estimate

ROM estimate for one experienced full-time engineer, assuming the P0 backend fixes are separately completed, backend contracts mostly exist, Play/EMM access is ready, and two real Android test tablets are available. Treat this as **±50% until Phase 0 closes**; it excludes production backend migration/release, signing-key procurement, Play/EMM enrollment, direct payment-provider integration, and fiscal certification:

| Workstream | Estimate |
|---|---:|
| Phase 0 contract/hardware audit | 3-5 engineer-days |
| Pure core + platform abstraction | 7-12 engineer-days |
| Android shell/auth/catalog/read-only | 7-10 engineer-days |
| Native SQLite/cart/order/outbox | 12-18 engineer-days |
| Remote print + reconciliation | 5-8 engineer-days |
| CI/update/security hardening | 5-8 engineer-days |
| Pilot fixes and monitoring | 1-2 calendar weeks |

The original **39-61 engineer-day** figure is optimistic for production readiness because it omitted toolchain migration, server kill switches, auth/device registration, native test infrastructure, signing, Play/EMM setup, hardware QA, and P0 fiscal remediation. Re-estimate after Phase 0 with 30-50% contingency. Direct Bluetooth/USB printers, payment-provider capture, or direct fiscal support are separate projects after hardware/protocol/legal discovery.

## 12. First implementation batches

### 12.1 First Phase 1 PR

The first runtime PR starts only after Phase -1/0 source and baseline gates. It must be intentionally small and must not create an APK or introduce platform ports yet.

Deliverables:

1. Canonical type-only cart/order/tender/shift definitions with compatibility re-exports and an exact file allowlist.
2. Executable characterization for already-exported pure money, weighted quantity, VAT, rounding, discount, and price-guard behavior.
3. A frozen synthetic fixture corpus and seam inventory for current order payload/idempotency behavior. If the current behavior is not callable without runtime extraction, stop and propose the exact extraction packet; do not use source-string assertions or widen this PR.
4. Synthetic positive/negative fixtures for the cross-platform boundary verifier.
5. Full existing test/typecheck/build evidence.

Acceptance criteria:

- No Windows UI or behavior change.
- No backend/database migration.
- No production deploy.
- No APK, order write, payment, fiscal call, signing secret, R2 mutation, or Play upload.
- Type-only extraction produces zero runtime diff; characterization tests execute real exported behavior.

### 12.2 First Phase 2 PR, only after Phase 1 exit

Deliverables:

1. `PlatformPorts`, read-only `PosApplication` facade, and `PlatformCapabilities` types without stateful write wiring.
2. `ElectronPlatformPorts` delegating platform info, config read, current-user read, and catalog read/search/barcode effects.
3. Fake read-only adapter for tests.
4. One catalog hook/component migrated from direct `electronAPI` to `usePosApplication()` through a compatibility facade.
5. Transitive boundary checks against the real migrated graph.

Acceptance criteria:

- No cart, shift, order, outbox, payment, sync-write, or print-write path is migrated.
- Windows behavior remains unchanged and the read-only vertical slice passes adapter conformance tests.

## 13. Definition of done

The project is not complete merely because an APK opens. It is complete when:

- Windows and Android candidates are built from the same tagged commit/product version, with recorded per-platform build and promotion state.
- Shared POS business logic has one implementation and cross-platform fixtures.
- Android survives restart, lost response, process death, and update without losing or duplicating an order. If deliberate offline selling is later approved, the same must be proven for offline-before-Pay.
- Tenant boundaries are verified.
- Android reports print success only after confirmation.
- Fiscal `UNKNOWN` remains unknown and cross-tenant receipt mutation is impossible.
- Windows Authenticode, Android upload, Play app-signing, and optional sideload identities are recorded separately; update preservation is tested against the signer actually installed on the device.
- Pilot reconciliation finds no unexplained order, payment, tax, or print mismatch.
- Unsupported Windows-only modules are capability-gated.
- The owner has approved production rollout after pilot evidence.

## 14. References

Repository evidence:

- `package.json`: Electron/React/Vite versions, Windows builder config, R2 publish URL.
- `src/preload/preload-pos.ts`: current POS IPC surface.
- `src/shared/electron.d.ts`: current renderer bridge types.
- `src/main/database/database.ts` and `src/main/database/migrations.ts`: SQL.js durability and schema history.
- `src/main/updates/auto-updater.ts`: Windows update check/download/install flow.
- `.github/workflows/build.yml`: existing Windows build and R2 release workflow.
- `android-tv-ads/.../TvAppUpdater.kt`: existing APK download/checksum/user-installer pattern; this is evidence, not the new POS update architecture.
- `/var/www/www/enail/backend/src/modules/print-agent/services/fiscal-receipt.service.ts`: current tenant-scope and failure-class P0 evidence; the same logic was verified in the Contabo built artifact on 2026-07-17.
- `/var/www/www/enail/backend/src/modules/b2b/services/b2b-pos.service.ts`: current tender-to-`PAID` behavior.

External primary documentation:

- Capacitor documentation: <https://capacitorjs.com/docs>
- Capacitor 8 upgrade/toolchain requirements: <https://capacitorjs.com/docs/updating/8-0>
- Android 16 adaptive large-screen behavior: <https://developer.android.com/about/versions/16/behavior-changes-16#adaptive-layouts>
- Android backup security guidance: <https://developer.android.com/privacy-and-security/risks/backup-best-practices>
- Android Play in-app updates: <https://developer.android.com/guide/playcore/in-app-updates/kotlin-java>
- Android dedicated-device package installation: <https://developer.android.com/work/dpc/dedicated-devices/cookbook>
- Google Play target API requirements: <https://developer.android.com/google/play/requirements/target-sdk>

> **NOTE 2026-07-25 (consolidation):** the checkouts named above (`POS-zira-android-dev-20260717`, `POS-zira-latest`, …) no longer exist. All POS-zira work now happens in the single clone `/var/www/pos-zira`. Every commit they held was verified present on `origin`, except `0cf8784` (hotfix/pos1-fiscal-sync-20260716) which is preserved as a git bundle in `/home/paul/archive/pos-zira-20260725/`. The seven local-only review fixes referenced below live on `origin/fix/review-blockers-20260712` (`b081d55`) and their patch files in `/home/paul/archive/pos-zira-20260725/review-patches/`.
