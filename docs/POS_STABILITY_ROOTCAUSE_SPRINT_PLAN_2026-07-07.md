# POS Stability Root-Cause Sprint — Plan (2026-07-07)

Owner-approved follow-up to the 2026-07-06 incident fixes (`b074f0e` renderer watchdog + boot shield, `dc859e9` shared receipt resume). Those commits shipped shields and recovery; this sprint removes the underlying causes and closes one backend backlog ask. Work is split into independent steps — each lands, verifies, and can stop on its own.

Status legend: `[ ]` planned · `[x]` done · `[~]` in progress.

---

## Workstream A — DraftProductSync stuck cursor (backend eNail, CONFIRMED root cause)

**Symptom:** every POS till re-fetches and re-applies the same 20 drafts every 30-60 s, forever (`nextSince=2026-05-21T22:45:12.722Z` frozen since May). Constant CPU/IPC/DB churn on live tills; suspected contributor to the POS1 renderer OOM.

**Root cause (verified in DB 2026-07-07):** microsecond-vs-millisecond cursor truncation in
`backend/src/modules/master-catalog/services/draft-mirror.service.ts`:

- Line 113: `qb.where("d.updatedAt > :since", { since: new Date(opts.since) })`
- Line 141-142: `nextSince = lastUpdated?.toISOString()` — JS `Date` carries ms only.
- DB truth: exactly **20 rows**, all `updatedAt = 2026-05-21 22:45:12.722827+00` (one bulk update, same micro-instant). Cursor serializes to `.722` → `.722827 > .722000` matches forever.

**Fix:** ceil the returned cursor past the truncated tail — in `buildMirror`:

```ts
const nextSince = lastUpdated
  ? new Date(lastUpdated.getTime() + 1).toISOString()   // +1 ms: past any µs remainder
  : (opts.since ?? new Date(0).toISOString());
```

Client stores/passes the cursor opaquely (`draft-product-sync.ts` `sync_metadata`), so no app change is needed.

**Accepted trade-off:** a row updated later within the same millisecond as the page's max row would be skipped (sub-ms race, human/crawler-cadence writes — negligible; full sync fallback covers).

**Steps:**
- [x] A1. DONE 2026-07-07 — eNail trunk `b14272d6`: `nextDeltaCursor()` util + spec (3 tests) + draft-mirror ceil. Scoped to the draft mirror only; see A3 note (two-call loop test: second call with returned cursor yields 0 rows).
- [x] A2. DONE 2026-07-07 — dev e2e against real stuck data: `since=.722Z` → 20 drafts, `nextSince=.723Z`; `since=.723Z` → 0 drafts. (Gotcha reconfirmed: fast-build --backend restarted on a stale dist; manual `tsc + tsc-alias + pm2 restart` emitted.) Build + restart DEV backend (:3003), e2e verify with curl: `since=.722Z` → 20 drafts, `nextSince=.723Z`; `since=.723Z` → 0 drafts.
- [x] A3. DONE 2026-07-07 — same latent class CONFIRMED in `warehouse/services/product.service.ts` (categories reduce + products raw MAX). Fix deferred: a concurrent session owns that file mid-flight (new `findPublicCategories` + `pos-public-sync-cursor.spec.ts`); they should adopt `nextDeltaCursor` from `@/common/utils/delta-cursor.util`. Audit note on the sibling POS products delta endpoint for the same class (its cursor advanced in logs, but the boundary may be latent).
- [x] A4. DONE 2026-07-07 ~11:40 UTC — surgical dist+source ship to Contabo (delta-cursor.util + draft-mirror; backup `draft-mirror.service.js.bak-cursor-20260707`), pm2 restart, health 200 after ~80s, auth guard 401. PROD verified with live data: `since=.722Z` → 20 drafts + `nextSince=.723Z`; `.723Z` → 0. Tills exit the loop on their next 60s delta cycle. Original step: commit on eNail trunk; deploy Contabo (surgical dist patch + restart, ~90 s backend boot — needs an owner-approved window); verify prod: same two-call curl + POS log shows `Delta sync: 0/0` steady state.

**Rollback:** revert the one-line change; behavior returns to (bad) current state, nothing else depends on cursor shape.

---

## Workstream B — Boot time 40 s → target ~10 s (POS app)

**Symptom (POS1 logs 2026-07-06):** `Init Step 13 (hardware)` holds boot ~30 s (12 s Zebra connect timeout even when USBPRINT reports present, plus serial port/WMI scans), RemoteModule SSH probing ~9 s; IPC registers at Step 31 and the window shows at Step 35 — 40+ s with nothing on screen. This is the soil the boot IPC race grew from; the preload shield (`b074f0e`) makes early windows safe, so boot can now be re-ordered without risk.

**App-code investigation corrections (2026-07-07):**

- The first B plan was too loose. Current orchestrator order is `all module init()` → `register IPC` → `event/socket handlers` → `showWindow()` → `start()`. Therefore "show window before module init" is not a safe B3 step; it would require a lifecycle redesign. The safe target is: make slow `init()` work cheap first, then move `showWindow()` earlier **after IPC handlers and EventBus handlers are ready**.
- `ensurePrinterReady()` is only in `PaymentController`; backend/shared `HardwareModule.handlePrintJob()` does not call `driver.connect()` on demand. It only checks `isConnected()`, waits/retries, and runs health recovery. B2 must add a HardwareModule readiness/single-flight connect path or early backend jobs can false-fail while startup connect is still running.
- `connectPrinterWithTimeout()` uses one 12 s constant today. A naive B1 change to `3_000` would silently weaken runtime config reinitialize, label reconnect, and manual/on-demand reconnect behavior. Boot timeout must be explicit and scoped.
- `RemoteModule.setupSocketHandlers()` captures `MAIN_WINDOW` once. If the window is created later, remote status/dialog events can keep a stale `null`. B3/B4 must use lazy window lookup or ensure the window exists before those closures are created.
- `SshTunnelManager.initialize()` and `autoStart()` use synchronous shell probes (`where ssh`, `sc query sshd`, `Start-Service sshd`). Calling an async function without `await` is not enough if it executes `execSync` before its first await; B4 must make the probes truly off the main boot path.

**Corrected design intent:** boot critical path = app ready + config + DB + cheap module construction + IPC/event handler registration + first window. Hardware/remote capability checks are eventual state: drivers/managers are registered quickly, then external I/O runs in background. Print safety remains conservative: fiscal and shared jobs must not pretend success if the assigned printer is truly unavailable, and ambiguous print outcomes stay fail-closed.

**Success criteria:** after B2+B3+B4, `Zira starting...` → `[Window] Page loaded successfully` should be <5 s on dev/source and materially below the old 40 s on POS1-class hardware. `Zira starting...` → `Initialization complete` should target ~10 s, excluding optional slow background hardware/SSH completion logs.

**Steps (each independently shippable):**

- [x] B1. Make printer connect timeout explicit and boot-safe. `connectPrinterWithTimeout(driver, label, timeoutMs = PRINTER_CONNECT_TIMEOUT_MS)` now accepts an explicit timeout and is single-flight per driver. The final implementation does not spend even 3 s on printer connect during `init()`; startup driver connect tasks are registered after the driver maps are populated, then executed in parallel outside the boot-critical init path. Runtime config reinitialize, label reconnect, and print-time reconnect keep the full 12 s default.
- [x] B2. Split `HardwareModule.init()` into cheap driver registration and background startup connect. `init()` marks orphan fiscal attempts, creates/registers printer drivers and supporting hardware services, exposes container entries, and starts health checks without waiting for printer connect probes. `start()` fire-and-forgets full-timeout parallel startup connects. `handlePrintJob()` and `printLanFirstKitchenTicket()` now use a HardwareModule single-flight readiness helper so early backend jobs connect once before declaring `SAFE_BEFORE_PRINT`.
- [x] B3. Move main window creation earlier, but not before IPC exists. `AgentOrchestrator.initialize()` now calls `showWindow()` after module `init()` and IPC/event-handler registration, before socket-handler wiring, tool collection, tray creation, and module `start()`. The preload boot-invoke shield stays in place.
- [x] B4. Move RemoteModule slow capability probes off the boot path. `RemoteModule.init()` constructs/registers `RemoteSessionManager` and `SshTunnelManager` without awaiting SSH probes. SSH client/sshd discovery is lazy async capability hydration using `execFile`/Promise wrappers instead of startup-path `execSync`. RemoteModule window sends/dialog parents resolve `MAIN_WINDOW` lazily inside handlers, and auto/manual SSH tunnel start awaits async setup instead of blocking main-process startup.

**Verification commands:**

- Focused B1/B2: `npx vitest run tests/hardware-print-job-runtime.test.ts tests/lan-first-kitchen-ticket-receiver.test.ts`
- Focused B3: `npx vitest run tests/orchestrator-startup-order.test.ts tests/preload-boot-invoke-retry.test.ts tests/renderer-health.test.ts`
- Focused B4: `npx vitest run tests/remote-module-startup.test.ts tests/ssh-tunnel-startup.test.ts`
- Build gate for each commit: `npm run build:main`; final gate: `npm run build && npm test`
- Existing Electron smoke command is not in `package.json`; run directly if needed: `npx vitest run --config vitest.e2e.config.ts tests/e2e/smoke.test.ts`
- Manual timing: start from source/packaged build, measure log deltas `Zira starting...` → `[Window] Page loaded successfully` and `Zira starting...` → `Initialization complete`; repeat with a double-click during boot.

**Risks and guards:**

- Early window can expose "printer disconnected" before background connect finishes. Acceptable if status later updates; not acceptable if print jobs false-fail while connect is in flight, hence B2 readiness helper.
- Parallel printer probes can increase PnP/serial pressure. Guard with existing POSNET port mutex, shared detection snapshots, and focused tests around routed print jobs.
- Fiscal safety must not be relaxed. If a fiscal driver cannot be proven connected before send, fail before print with `SAFE_BEFORE_PRINT`; never retry or mark success after an uncertain send boundary.
- Optional modules outside the observed root cause (for example enabled Telegram polling) may still add boot latency later. Do not broaden this workstream unless fresh timing shows they are on the critical path.

---

## Workstream C — POS1 remote-support SSH tunnel dead (infra, 5 min)

**Symptom:** every boot logs `[SSH Tunnel] Auto-start failed: paul@37.60.231.45: Permission denied (publickey)` (109 occurrences) — the reverse tunnel `-R 10677:localhost:22` to Contabo never comes up, so remote support into POS1 is broken.

**Root cause (verified 2026-07-07):** Contabo has user `paul` and sshd on :2222, but `/home/paul/.ssh/authorized_keys` **does not exist**. POS1's key (`zira-print-agent@DESKTOP-AK6GJ4Q`, ed25519) was simply never installed.

**Steps:**
- [x] C1. DONE 2026-07-07 — On Contabo: create `/home/paul/.ssh/authorized_keys` (700/600, owner paul) with POS1's pubkey, restricted to tunnel use: `restrict,port-forwarding <key>`.
- [x] C2. Auth path verified end-to-end 2026-07-07 (`TUNNEL-AUTH-OK` from POS1 with the agent key); the listening tunnel binds on POS1's next auto-start/retry. Verify: POS1's tunnel retry (or next app start) binds `127.0.0.1:10677` on Contabo (`ss -tlnp | grep 10677`).

**Note:** other tills' keys can be appended the same way when their tunnels are wanted.

---

## Workstream D — Split-refund `tenderAllocations` backend proof (backend eNail)

**Context:** POS `b29695b` already sends refund `tenderAllocations[]` computed from `payment_tenders`; eNail trunk has `61b14847 feat(b2b-pos): accept tenderAllocations + manualAdjustmentAmount on POS refund`. The vault backlog asks for **proof**, not code: acceptance, validation, persistence, reporting, audit.

**Steps:**
- [ ] D1. Verify Contabo deploy state of `61b14847` (the 2026-07-07 staff-403 deploy was surgical; this commit may not be live).
- [ ] D2. Code-verify: refund endpoint validates allocation sums vs refund total and rejects inconsistent payloads with a clear error.
- [ ] D3. Trace persistence → shift reports / accounting exports: do allocated tender amounts appear, or does the refund collapse to one tender?
- [ ] D4. DEV e2e: split cash/card order → partial refund with allocations → assert response + shift report numbers.
- [ ] D5. Write the proof document, deliver to `wiki/ops/scr/` custody page, tick the backlog item. Live-salon smoke stays an owner gate.

---

## Sequencing

1. **C** (minutes, unblocks remote support for every future incident).
2. **A1-A3** on DEV same day; **A4** Contabo deploy in an owner-approved ~2-minute window.
3. **B1 → B2 → B3/B4** as separate commits/builds, each with boot-time measurements; owner rebuilds tills at leisure (rides along with the already-pending POS2/POS1 manual builds).
4. **D** after A ships, same backend working set.

## Standing constraints

- No restarts/installs on live tills during trading hours; POS1 rebuild remains owner-scheduled.
- eNail backend deploys to Contabo follow the surgical-artifact flow with ~140 s health polling; never ad-hoc restarts.
- Wiki vault gets a session note + dashboard refresh when each workstream lands.
