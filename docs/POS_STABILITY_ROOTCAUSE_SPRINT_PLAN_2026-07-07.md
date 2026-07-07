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
- [ ] A4. Commit on eNail trunk; deploy Contabo (surgical dist patch + restart, ~90 s backend boot — needs an owner-approved window); verify prod: same two-call curl + POS log shows `Delta sync: 0/0` steady state.

**Rollback:** revert the one-line change; behavior returns to (bad) current state, nothing else depends on cursor shape.

---

## Workstream B — Boot time 40 s → target ~10 s (POS app)

**Symptom (POS1 logs 2026-07-06):** `Init Step 13 (hardware)` holds boot ~30 s (12 s Zebra connect timeout even when USBPRINT reports present, plus serial port/WMI scans), RemoteModule SSH probing ~9 s; IPC registers at Step 31 and the window shows at Step 35 — 40+ s with nothing on screen. This is the soil the boot IPC race grew from; the preload shield (`b074f0e`) makes early windows safe, so boot can now be re-ordered without risk.

**Design intent:** boot critical path = config + DB + IPC + window. Hardware talks to the world in the background; the 90 s health check and connect-on-demand (`ensurePrinterReady`) already recover printers that come up late.

**Steps (each independently shippable):**
- [ ] B1. Cap per-printer connect wait at boot to 3 s (from 12 s) and run printer connects **in parallel**, not serially. Keep full timeout for on-demand/reconnect paths.
- [ ] B2. Move printer connects out of `HardwareModule.init()` into `start()` as fire-and-forget with health-check registration; `init()` keeps only cheap config/driver construction. Verify: a print job arriving before connects finish still prints (connect-on-demand path).
- [ ] B3. Orchestrator: show the main window right after IPC registration (move Step 35 before module `init()` loop, or split init into pre-window/post-window phases). Preload shield covers any residual gap. Target: window in <5 s, spinner while modules finish.
- [ ] B4. RemoteModule: make SSH client/sshd detection async off the init path (~9 s today).

**Verification per step:** boot POS-zira from source, measure `Zira starting...` → `Page loaded successfully` and → `Initialization complete`; full suite + e2e smoke; manual double-click-during-boot smoke.

**Risks:** hidden dependencies on "hardware ready before X" — mitigated by shipping B1 (pure timing) before B2/B3 (ordering), and by the existing health-check/on-demand recovery.

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
