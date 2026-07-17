# Shared Core Boundary Audit — Windows Electron ↔ Android

Date: 2026-07-17
Audit base: `f0ee58bcd1e5217a4926353f0aff1fefd122941f` (`main`)
Scope: discovery / architecture boundary only. No runtime, package, CI, schema, or release change is included here.

## 1. Executive conclusion

The current repository does **not** have a portable POS application core yet. It has a useful set of pure helpers in `src/shared/`, but the business workflows that determine whether a sale, payment, shift, fiscal receipt, or sync fact is complete are still spread across:

- React components (`PaymentModal.tsx`),
- Electron IPC handlers (`pos.module.ts`),
- concrete sql.js repositories,
- Electron/Windows credential and filesystem APIs,
- Windows printer/COM-port drivers, and
- background upload services.

The smallest safe path is **not** to move `src/main/` into Android. It is to introduce a narrow, runtime-neutral `PosApplication` layer whose commands depend on explicit ports. Windows keeps its current Electron adapters; Android implements only the ports allowed for the first release.

Initial Android runtime boundary must be:

- Staff JWT authentication only;
- cash-only tender;
- local durable sale/shift command journal before acknowledging success;
- no print-agent API key, `/print-agent/connect`, or print-agent identity;
- no local/remote fiscal printing in the Android sales path;
- no CARD/BLIK/TRANSFER/INVOICE/split tender until a real capture/authorization contract exists;
- no direct import from `src/main/`, `src/preload/`, Electron, Node filesystem, Windows hardware, or Electron updater code.

This is a boundary audit, not a claim that Android sales are production-ready.

## 2. Evidence and source-of-truth notes

`AGENTS.md` requires the shared Obsidian wiki index and decisions to be read when present. No local vault containing the described wiki-maintainer `AGENTS.md`, `wiki/index.md`, or `wiki/decisions/` was found on this machine during this audit. The repository documentation was therefore read as secondary context, without editing any wiki.

Important documentation drift: `enaildesktopapp.md:388-406` says the database has 8 migrations, while the current source ends at migration 56 in `src/main/database/migrations.ts:1658-1680`. Architecture decisions must use live code and migration tests as source of truth, not that older inventory.

Existing repository principles that remain valid:

- The runtime is explicitly Electron main → preload IPC → React renderer (`enaildesktopapp.md:24-65`).
- The local database is sql.js in memory, exported to `%APPDATA%` (`enaildesktopapp.md:388-393`; live implementation at `src/main/database/database.ts:127-172`).
- Only a confirmed final fiscal completion is success; unknown is sticky and requires reconciliation (`docs/2026-05-20-remote-fiscal-printer-routing-scr.md:511-550`).

## 3. Boundary classification

### 3.1 Shared-domain candidates already portable

These files are pure TypeScript today or need only a very small injection seam. They are candidates to move under a future `src/application/` or `packages/pos-core/` boundary and be imported by both Windows and Android.

| Current module | Classification | Evidence | Required change |
|---|---|---|---|
| `src/shared/pos-sale.ts` | shared-domain now | Pure quantity/unit/money rules at lines 1-74; integer grosze calculations at lines 58-65 | Keep pure. Add invariant/property tests for integer pieces and 3-decimal weight. |
| `src/shared/product-money.ts` | shared-domain now | Safe integer/range parsing at lines 1-27 | Keep pure; no platform adapter. |
| `src/shared/pos-price-guard.ts` | shared-domain now | Pure anomaly detection at lines 1-41 | Keep pure; UI chooses localized presentation later. |
| `src/shared/product-sale-classifier.ts` | shared-domain now | Depends only on `pos-sale`; lines 1-60 | Keep pure. Scale access stays behind a port. |
| `src/shared/catalog-names.ts` | shared-domain now | Pure translation parsing and fallback at lines 15-90 | Keep pure. Receipt locale is policy and should be injected/configured rather than hard-coded globally for all platforms. |
| `src/shared/internal-ean.ts` | shared candidate | Check digit is pure at lines 13-23, but minting uses `Math.random()` at lines 25-33 | Inject `RandomPort`/digit source; do not rely on `Math.random()` for a replayable command. |
| `src/main/pos/order-line-contract.ts` | shared candidate | Only imports `src/shared/pos-sale`; pure mapping at lines 1-67 | Move without the `main` path; replace `Record<string, any>` with an explicit backend DTO. |
| `src/renderer/components/pos/payment-fiscal-prompt-mode.ts` | shared policy candidate, not Android-enabled behavior | Pure decision at lines 1-20 | Move only as a Windows fiscal policy. Android first release must return `unsupported`, not call this policy. |
| `src/renderer/windows/self-checkout/build-sale.ts` | shared candidate after cleanup | Pure sale shape and integer totals at lines 1-148; runtime default uses global `crypto.randomUUID()` at lines 75-98 | Inject `ClockPort` and `IdGeneratorPort`; do not share the kiosk-specific `COMPLETED` assumption as the universal sale command. |
| cart reducer portion of `src/main/pos/pos-store.ts` | shared candidate after extraction | Cart/session types at lines 18-47; pure quantity transitions at lines 278-420 | Extract reducer/state only. Current file imports `BrowserWindow`, config, DB/product repo, promo loader at lines 1-14 and is therefore not portable as a module. |
| pure portions of `src/main/sync/pos-order-adapter.ts` | shared candidate after split | Money/tender/VAT normalization at lines 27-132 and server mapping at lines 135-256 | Split logging from mapping; inject warning sink or return warnings instead of importing main logger at lines 8-20. |

### 3.2 Windows/Electron-only modules

These modules are valid Windows adapters and should remain outside shared core.

| Area | Windows/Electron-only evidence |
|---|---|
| Electron IPC composition | `src/main/modules/pos.module.ts:3053-3209`, `3628-3705`, `4650-4705`; `src/preload/preload-pos.ts:1-190` |
| Electron auth/config composition | `src/main/modules/auth.module.ts:8-52`, `591-828`; renderer config sanitization and IPC are Electron responsibilities |
| DPAPI/electron-store credential adapter | `src/main/config/store.ts:583-701` rejects plaintext and uses Electron `safeStorage` |
| sql.js file adapter and Windows lifecycle | `src/main/database/database.ts:1-8`, `127-172`, `189-285`, `353-361`; depends on Electron `app`, Node fs/path, whole-file export |
| preload bridges | all `src/preload/*.ts`; `contextBridge`/`ipcRenderer` are transport adapters, not application API |
| local printer/fiscal drivers | `src/main/hardware/**`; POSNET transaction at `posnet-driver.ts:446-554`, ELZAB transaction at `elzab-driver.ts:200-241` |
| receipt/cash-drawer routing | `src/main/pos/payment-controller.ts:253-352`, `472-552`, `561-649` |
| printer ownership and print-agent socket connection | `src/main/modules/auth.module.ts:914-995`; `src/main/network/api-client.ts:720-748`, `1329-1346`, `1412-1460` |
| Electron updater / Windows installer | `src/main/updates/auto-updater.ts`; `package.json` Electron builder configuration |
| Windows automation, PowerShell, serial/USB, COM ports | `src/main/windows/**`, `src/main/system/**`, `src/main/hardware/**`, `src/main/remote/**` |

The shared application layer must not make Electron IPC names its public API. `pos:orders:create`, `pos:shift:open`, etc. are Windows adapter details.

### 3.3 Required platform ports

The following ports are the minimum seams needed to share behavior without copying Windows infrastructure into Android.

```ts
interface ClockPort {
  now(): Date;
}

interface IdGeneratorPort {
  newId(): string;
}

interface SecureSessionBrokerPort {
  login(input: StaffLoginInput): Promise<SessionProjection>;
  current(): Promise<SessionProjection | null>;
  refreshIfNeeded(): Promise<SessionProjection>;
  logout(): Promise<void>;
}

interface PosBackendPort {
  getCurrentUser(): Promise<AuthUser>;
  submitSale(command: SaleSyncCommand): Promise<SaleSyncResult>;
  openShift(command: ShiftOpenSyncCommand): Promise<ShiftSyncResult>;
  closeShift(command: ShiftCloseSyncCommand): Promise<ShiftSyncResult>;
}

interface PosTransactionPort {
  transaction<T>(fn: (tx: PosTransaction) => Promise<T>): Promise<T>;
  flushDurably(): Promise<void>;
}

interface SaleJournalPort {
  stage(command: FinalizeCashSaleCommand): StagedSale;
  markApplied(commandId: string, localOrderId: string): void;
  markSyncAccepted(commandId: string, serverOrderId: string): void;
  listReady(limit: number, now: Date): StagedSale[];
}

interface ShiftCommandJournalPort {
  stageOpen(command: OpenShiftCommand): StagedShiftCommand;
  stageClose(command: CloseShiftCommand): StagedShiftCommand;
  markLocallyApplied(commandId: string): void;
  markSyncAccepted(commandId: string, backendShiftId?: string): void;
  listReady(limit: number, now: Date): StagedShiftCommand[];
}

interface NetworkStatusPort {
  isOnline(): boolean;
  onChange(listener: (online: boolean) => void): () => void;
}

interface FiscalReceiptPort {
  capability(): 'unsupported' | 'local-owner' | 'server-mediated';
  print(command: FiscalReceiptCommand): Promise<FiscalReceiptOutcome>;
}

interface ReceiptPrinterPort {
  capability(): 'unsupported' | 'available';
  print(command: ReceiptPrintCommand): Promise<ReceiptPrintOutcome>;
}

interface CashDrawerPort {
  capability(): 'unsupported' | 'available';
  open(reason: string): Promise<{ opened: boolean; error?: string }>;
}

interface ScalePort {
  capability(): 'unsupported' | 'available';
  readStableWeight(): Promise<ScaleReadResult>;
}
```

Android first release adapters deliberately implement `FiscalReceiptPort`, `ReceiptPrinterPort`, `CashDrawerPort`, and `ScalePort` as `unsupported` unless a separately reviewed Android hardware contract is added. A no-op adapter must never return a false success.

On Android, `SecureSessionBrokerPort` is a native token broker: the refresh token, rotation, and authenticated transport remain outside WebView JavaScript. Shared JS receives only a non-secret session projection and typed request results. Keystore encryption alone is only at-rest protection and does not make a raw bearer token safe from XSS or a compromised bridge. The Windows adapter may initially wrap its current token flow behind the same interface, but that compatibility path is not permission to expose Android refresh tokens.

## 4. Domain-by-domain audit

### 4.1 Authentication

#### Current behavior

- Email/staff login calls `POST /api/v1/auth/login` and sends `{ emailOrPhone, password }` (`src/main/network/api-client.ts:3366-3388`).
- Access and refresh tokens are stored via Electron DPAPI (`src/main/config/store.ts:583-701`).
- Refresh is single-flight because the backend rotates refresh tokens (`src/main/network/auth-refresh.ts:16-21`, `73-90`) and classifies 401 separately from network failures (`125-165`).
- Startup can use a cached user during backend/network failure (`src/main/network/auth-get-user.ts:63-109`).
- After login, the Electron module also tries to acquire/use a print-agent key and connect its socket (`src/main/modules/auth.module.ts:810-822`, `914-995`).

#### Boundary decision

Share the **session state machine**, not `AuthModule`, `ApiClient`, or `config/store`.

Smallest seam:

1. Extract `AuthRefreshNetworkError` or, better, replace exception-type inspection with an explicit `AuthVerificationResult` union in a pure module.
2. Move the startup decision from `auth-get-user.ts` into the application layer. It currently imports `AuthRefreshNetworkError` from a module that imports main config/logger (`auth-get-user.ts:26-27`; `auth-refresh.ts:24-32`), so it is not transitively portable yet.
3. Inject `SecureSessionBrokerPort`:
   - Windows adapter: compatibility wrapper around existing Electron `safeStorage`/DPAPI and refresh flow.
   - Android adapter: native Keystore-backed token broker that owns refresh rotation and authenticated transport; raw refresh tokens never cross into WebView JS and all token material is excluded from backup/restore.
4. Inject `PosBackendPort` as typed authenticated operations backed by the session broker. Do not pass access/refresh tokens through shared use cases and do not share the 3,000+ line concrete `ApiClient`, which imports Electron `app`, Node `os`, config, local printer repo, and logger (`api-client.ts:1-64`).

#### Android-forbidden auth paths

- Any `pa_` credential.
- `/api/v1/print-agent/connect`.
- `x-print-agent-api-key` and `x-print-agent-machine-id` headers.
- `socket.connectWithApiKey`.
- printer inventory synchronization during login.

Android identity is a Staff JWT session plus a separate non-secret installation/device identifier if the backend needs one. It is not a print agent.

#### Boundary tests

Status note: the current A3 verifier scans the reviewed TypeScript source graph only. There is no Android entry or compiled Android bundle in this branch, so the compiled-bundle assertions below are future release gates, not evidence already produced by A3. Once the Capacitor shell exists, CI must scan both its resolved source graph and its final packaged web bundle; source-only success cannot satisfy the release gate.

- Same auth-state contract suite runs against Windows and Android token adapters.
- Concurrent 401s cause exactly one refresh network call and one token rotation.
- 401 refresh rejection clears only user tokens; network/5xx/429 preserves them.
- salon/account change cannot upload old-tenant outbox rows under the new JWT.
- Android compiled bundle contains no `pa_` credential, `/print-agent/` route, or `x-print-agent-*` header.
- Android backup/restore cannot restore access/refresh tokens onto another device.

### 4.2 Payment and sale finalization

#### Current behavior and production trap

The cashier UI builds a `COMPLETED` order with a payment method before the main process persists it (`src/renderer/components/pos/PaymentModal.tsx:430-503`). The completion path directly calls this save for all methods (`PaymentModal.tsx:703-733`). For CARD, the UI explicitly asks the cashier to enter the amount on a separate terminal and press “Card payment received” after approval (`PaymentModal.tsx:777-779`, `1684-1705`). The actual Elavon socket capture IPC exists (`src/main/modules/pos.module.ts:4130-4157`) but the ordinary POS `PaymentModal` does not call it; only the billiard dialog references `cardPayment`.

This means the current desktop CARD flow is manual attestation, not a machine-verifiable capture. Copying it to Android would allow an offline electronic tender to become a completed/paid sale without capture. That is a production blocker.

The event emitter then creates `PaymentCaptured` with `status: 'captured'` from the persisted tender (`src/main/events/pos-event-emitter.ts:157-182`), so a UI assertion can become a financial event assertion.

#### Boundary decision

The shared command must distinguish tender intent from captured payment:

```ts
type TenderKind = 'CASH' | 'CARD' | 'BLIK' | 'BANK_TRANSFER' | 'INVOICE';

type PaymentEvidence =
  | { kind: 'cash_received'; receivedMinor: number; changeMinor: number }
  | { kind: 'provider_capture'; provider: string; captureId: string; capturedMinor: number }
  | { kind: 'manual_attestation'; operatorId: string }; // Windows legacy only

type FinalizeSaleResult =
  | { ok: true; localOrderId: string; durability: 'flushed' }
  | { ok: false; code: 'UNSUPPORTED_TENDER' | 'PAYMENT_NOT_CAPTURED' | 'NO_ACTIVE_SHIFT' | 'DURABILITY_FAILED' };
```

For Android phase 1, `FinalizeSale` accepts only one `CASH` tender with `cash_received` evidence. CARD/BLIK/TRANSFER/INVOICE and any split tender return `UNSUPPORTED_TENDER` before any order, stock, outbox, or shift total is mutated.

Smallest extraction:

1. Move cart/order line calculations and tender validation into pure application functions.
2. Add `FinalizeCashSaleCommand` with stable `commandId`, `localOrderId`, `occurredAt`, `staffId`, `shiftId`, line snapshot, totals, and cash evidence.
3. Persist the command, order/items, stock effect, sync entry, and financial-event rows in one local transaction where supported.
4. Flush durably before returning success to UI.
5. Printing occurs after durable sale completion as a separate side effect; a printer failure cannot rewrite payment truth.

#### Boundary tests

- Android cash sale totals exactly in integer grosze; received cash must cover total; change is derived, not trusted input.
- Every non-cash or split tender is rejected before persistence on Android.
- No `PaymentCaptured` event exists without matching allowed payment evidence.
- Duplicate `commandId`/`localOrderId` returns the same sale and does not decrement stock twice.
- Crash at each checkpoint (staged, order inserted, stock changed, events inserted, file flush, network dispatched, response lost) recovers to one sale and one sync command.
- Windows legacy manual-card policy stays in a Windows adapter and is not imported by Android.

### 4.3 Outbox and idempotency

#### Current behavior and gap

The financial event outbox has good local dedupe (`dedupe_key UNIQUE`) and stable event ids (`src/main/database/migrations.ts:1465-1500`; `src/main/database/repos/pos-event-outbox-repo.ts:80-123`). Upload treats accepted and duplicate backend responses as ack (`src/main/sync/pos-event-uploader.ts:76-133`). Tenant scope is derived by the backend JWT rather than sending local `salonId` (`pos-event-outbox-repo.ts:221-238`).

However, order creation commits the order/items first (`src/main/database/repos/order-repo.ts:202-247`) and emits outbox facts only afterward (`249-264`). The emitter intentionally swallows exceptions (`src/main/events/pos-event-emitter.ts:99-105`). Therefore “durable order” and “durable financial event” are not atomic. The comment in migration 47 says facts are written before network, which is true, but not before/with the local sale mutation.

There is also a second order sync log (`src/main/sync/sync-log-repo.ts:45-139`) written from `pos.module.ts:3145-3178`, outside `orderRepo.create`'s transaction. A crash can leave an order without either/both outbound representations.

#### Boundary decision

Do not make `pos_event_outbox` itself the universal command journal. Add one shared **sale command journal** as the source for replaying local effects, and derive transport/event rows transactionally. Required invariants:

- stable command id is generated before the first write;
- intent hash binds command id to exact immutable payload;
- same id + same hash resumes/returns prior result;
- same id + different hash fails closed;
- transport dispatch never invents a new id on retry;
- tenant key is stored on every pending command and dispatch verifies it matches the active JWT tenant;
- pending/dead-letter financial commands are never silently pruned.

Android must use a native SQLite transaction/commit durability primitive. Windows can initially adapt its current database transaction, but should not claim the same crash guarantees until its whole-file `sql.js` export is flushed successfully.

#### Boundary tests

- command-id same payload is idempotent; same id/different payload is rejected;
- power-loss simulation before/after every local write boundary;
- response-lost retry gets server duplicate/accepted and marks the same command acked;
- logout/salon switch blocks dispatch until tenant ownership is reconciled;
- dead-letter critical financial commands remain visible and recoverable;
- queue backoff uses injected clock/random jitter for deterministic tests.

### 4.4 SQLite and migrations

#### Current behavior

- `Database` uses in-memory sql.js and periodically exports the whole DB to a file (`src/main/database/database.ts:127-172`, `189-238`).
- Financial order handler calls `database.save()` after local changes, but logs and still returns success when disk flush fails (`src/main/modules/pos.module.ts:3184-3194`).
- The migration runner is better than a naive version counter: it tracks `(version, name)`, repairs divergent lineage, and wraps each migration in a transaction (`database.ts:499-570`; regression tests in `tests/migration-runner.test.ts:121-234`).
- Migrations are a single Windows schema through version 56. Android does not need every printer, Booksy, Telegram, browser, or invoice table.

#### Boundary decision

Do not run sql.js filesystem code on Android and do not fork two independent copies of sale/shift migration history.

Use two layers:

1. `core_migrations`: minimal tables shared by Windows and Android (catalog subset, orders/items, shifts, command journals, sync state), expressed against a small `MigrationExecutorPort` and tested on both SQLite engines.
2. `windows_migrations`: the existing full schema and Windows-only tables; keep current version history intact.

Do not renumber or rewrite the existing 1-56 Windows lineage. The Android database can have its own schema namespace/version table, but shared table definitions and upgrade fixtures must be generated/verified from the core contract to prevent drift.

Native Android storage must explicitly configure:

- transactions and foreign keys;
- WAL/synchronous policy appropriate for financial writes;
- app backup exclusions for DB, tokens, and pending financial commands unless an encrypted, tenant-bound restore design is approved;
- database encryption decision and key loss/recovery behavior;
- background/termination flush semantics (no dependence on a 5-second timer).

#### Boundary tests

- fresh install reaches latest core schema on both engines;
- every supported prior core schema fixture upgrades to the same logical schema;
- a failing migration rolls back fully and can be retried;
- version/name lineage collision is detected, not skipped;
- foreign key and unique idempotency constraints are enabled;
- kill-after-commit fixtures reopen with the sale and its journal/outbox together;
- Android backup/restore test proves no tenant DB or pending command migrates to another installation by default.

### 4.5 Shift

#### Current behavior and gap

Shift open writes a local row, emits an event, then fire-and-forgets backend open (`src/main/pos/shift-controller.ts:72-90`). Shift close calculates totals, updates the local row, emits an event, then fire-and-forgets backend close (`shift-controller.ts:93-215`). Retry state exists and caps attempts (`shift-controller.ts:252-349`; migration 52 at `migrations.ts:1571-1581`).

But open/close intents are not staged before local mutation, do not carry a durable command id/idempotency key through `openPosShift`/`closePosShift`, and event emission is outside the shift write. A process kill between those steps can produce a local shift without a replayable command/event. The renderer also dispatches session state only after the controller call (`pos.module.ts:4650-4656`, `4701-4704`), so DB and in-memory state are separate authorities.

#### Boundary decision

Extract a pure shift state machine:

```text
CLOSED --OpenShift(commandId)--> OPEN_LOCAL_PENDING_SYNC
OPEN_LOCAL_PENDING_SYNC --server ack--> OPEN_SYNCED
OPEN_* --CloseShift(commandId)--> CLOSED_LOCAL_PENDING_SYNC
CLOSED_LOCAL_PENDING_SYNC --server ack/duplicate--> CLOSED_SYNCED
```

Every transition is stored with a deterministic command id and payload hash before/with the shift mutation. Backend open/close calls must accept an idempotency key or a client command id before Android sales are enabled. If the backend contract does not support it, create a server change request; do not add a client heuristic that guesses whether an open/close succeeded.

The local database, not React state, is the authority after restart. UI session state is a projection of the active local shift.

#### Boundary tests

- duplicate open/close command produces one transition and one backend effect;
- close cannot target a different staff/device/tenant shift;
- app kill after local close but before network ack resumes the same close command;
- backend “already closed” for the same command becomes accepted terminal state; an unrelated 404/409 is not silently accepted;
- close report totals are deterministic for cash, refunds, discounts, and supported tender set;
- Android phase 1 reports card/BLIK/transfer totals as impossible states, not zeroed valid data.

### 4.6 Fiscal print and ordinary printing

#### Current behavior

Windows fiscal safety is materially stronger than ordinary printing:

- local statuses include `SUCCESS_CONFIRMED`, `FAILED_CONFIRMED`, and `UNKNOWN_NEEDS_RECONCILIATION` (`src/main/database/repos/fiscal-attempt-repo.ts:4-58`);
- a prior success/unknown blocks automatic retry (`fiscal-attempt-repo.ts:163-181`);
- POSNET marks errors after possible byte send as unknown (`src/main/hardware/posnet/posnet-driver.ts:483-506`);
- ELZAB does the same after dispatch (`src/main/hardware/elzab/elzab-driver.ts:214-240`);
- remote fiscal success is only accepted from a blocking confirmed outcome in the payment controller (`src/main/pos/payment-controller.ts:606-643`).

Those drivers and their journal are Windows hardware ownership code, not shared Android code.

#### Boundary decision

Android phase 1 must not:

- open COM/USB printer devices;
- emulate POSNET/ELZAB;
- call print-agent job creation with a print-agent credential;
- claim `PRINTED`, `FAILED_CONFIRMED`, or fiscal success from a timeout/delivery acknowledgement;
- automatically retry any unknown fiscal outcome;
- mark a sale unpaid/failed solely because an optional non-fiscal receipt did not print.

The shared core may define fiscal outcome vocabulary so UI/reporting can display server facts, but execution stays behind `FiscalReceiptPort`. Android adapter returns `unsupported` and the Android feature set must hide/disable fiscal actions. A later server-mediated Staff-JWT endpoint requires a separate threat model, same-tenant authorization, stable idempotency key + payload hash, final-state wait, sticky unknown state, and a deployed server kill switch before enablement.

#### Boundary tests

- Android cannot resolve/register a real fiscal port in production DI.
- `SENT`, socket delivery, HTTP timeout, `FAILED`, and `UNKNOWN` never map to success.
- retry with same fiscal key cannot enqueue a second physical print.
- unknown remains sticky until explicit authorized reconciliation.
- no printer credential/hardware path appears in Android bundle.

## 5. Proposed minimum shared application seam

Avoid a broad repository refactor. Introduce the seam in four small slices:

```text
src/application/
  contracts/
    auth.ts
    sale.ts
    shift.ts
    sync.ts
    printing.ts
  policies/
    cart.ts
    tender-policy.ts
    auth-session-policy.ts
  services/
    pos-application.ts
    sale-service.ts
    shift-service.ts
  ports/
    backend-port.ts
    local-store-port.ts
    secure-session-port.ts
    platform-capabilities-port.ts

src/platform/windows/
  electron-pos-adapter.ts
  electron-secure-session-adapter.ts
  sqljs-local-store-adapter.ts
  windows-printing-adapter.ts

android/ (or the chosen Capacitor app)
  adapters/
    android-secure-session-adapter.ts
    android-sqlite-adapter.ts
    android-backend-adapter.ts
    android-capabilities-adapter.ts
```

`PosApplication` should expose intent-level commands, not CRUD or IPC:

```ts
interface PosApplication {
  restoreSession(): Promise<SessionProjection>;
  login(input: StaffLoginInput): Promise<SessionProjection>;
  openShift(command: OpenShiftCommand): Promise<ShiftProjection>;
  finalizeCashSale(command: FinalizeCashSaleCommand): Promise<FinalizedSale>;
  closeShift(command: CloseShiftCommand): Promise<ShiftCloseProjection>;
  syncNow(): Promise<SyncProjection>;
}
```

Do not expose generic `request(method, path, token, body)` or generic database SQL through this boundary. Those recreate the monolith on both platforms and make security review impossible.

## 6. Android-forbidden import and feature list

### Compile-time forbidden imports

- `electron`, `electron-store`, `electron-updater`;
- `src/main/**`, `src/preload/**`;
- Node `fs`, `path`, `os`, `child_process`, `events`, `Buffer`-dependent crypto/storage;
- Windows/PowerShell, serial/USB/COM, native printer and desktop automation modules;
- Electron IPC channel declarations as application contracts.

### Runtime forbidden capabilities for initial Android release

- print-agent registration, pairing, API keys, socket ownership;
- fiscal receipt execution/reconciliation;
- receipt printer and cash drawer assumptions;
- scale-required products unless a reviewed Android scale adapter exists (fail closed, do not default weighted quantity to 1);
- CARD, BLIK, TRANSFER, INVOICE, split tender, refunds, voids, and order mutation unless separately enabled by server-backed contracts;
- background sync that depends on an unrestricted long-running JS timer;
- automatic application update outside Play/managed-device release controls.

## 7. Boundary test gate

Before an Android shell can save even test sales, add these gates.

### 7.1 Static import boundary

Add a test/script that walks the transitive import graph from `src/application/**` and fails on:

```text
electron | electron-* | src/main | src/preload |
node:* | fs | path | os | child_process | serialport | usb | electron-updater
```

Also build application core with a dedicated TypeScript config that does not include Electron or Node types. Any accidental `Buffer`, `process`, `require`, or Node `EventEmitter` use must fail compilation.

### 7.2 Shared contract suites

The same behavior suite must be run against both platform adapters for:

- secure-session storage semantics;
- SQLite transactions, migrations, and unique idempotency constraints;
- sale command replay and tenant ownership;
- shift command replay;
- backend accepted/duplicate/rejected responses;
- network loss and response loss.

### 7.3 Android capability gate

Production Android DI must assert at startup:

```text
auth = staff_jwt
tenders = [CASH]
fiscal = unsupported
print_agent_identity = absent
receipt_printer = unsupported
cash_drawer = unsupported
scale = unsupported (unless separately shipped)
```

Tests must fail if an unsupported adapter returns success or if UI exposes a command outside the capability set.

### 7.4 Financial/durability acceptance

- one user action → one immutable command id;
- one command id → one local order and at most one backend order;
- UI success only after durable local commit/flush;
- no captured-payment fact without valid payment evidence;
- no cross-tenant dispatch after logout/account switch;
- every critical pending/dead-letter command is observable to staff/support;
- kill/restart at every checkpoint converges without duplicate sale, stock decrement, shift transition, or fiscal command.

## 8. Recommended first implementation order

1. Add static shared-core import gate; it prevents accidental Electron leakage from the first extraction.
2. Extract current pure helpers without behavior changes: sale math, line contract, cart reducer, DTO normalization.
3. Define explicit command/port types and cash-only Android tender policy.
4. Add transactional sale command journal and shift command journal with crash/replay tests.
5. Adapt Windows Electron handlers to call `PosApplication` while preserving existing Windows behavior behind Windows-only policy/adapters.
6. Add Android secure-session, native SQLite, network-status, and Staff-JWT backend adapters.
7. Build Android read-only catalog/cart UI first; enable sandbox cash sale only after all boundary/durability tests pass.
8. Keep Android production sales disabled until backend production blockers and kill switch are verified separately.

## 9. Audit verdict

**Conditional GO for extraction and sandbox discovery. NO-GO for Android production sales.**

The reusable foundation is real, especially integer-money/quantity rules and several mapper/policy helpers. The production traps are also real: manual electronic tender can be represented as captured, outbox/event writes are not atomic with local sale/shift mutations, concrete auth/database layers are Electron-bound, and fiscal execution belongs to the Windows device owner. The proposed seam is intentionally small so these truths become enforceable without rewriting the entire Windows app.
