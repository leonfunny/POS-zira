# Android parity-port plan — continuous delivery

Status: ACTIVE — supersedes the phase ordering and abstraction strategy of
`IMPLEMENTATION_PLAN_2026-07-17.md` for development, by owner directive.
Date: 2026-07-18
Owner directive (Paul, 2026-07-18): *"Bản chất nó chỉ là làm lại 1 app
Windows đã hoạt động tốt rồi, không có cải tiến hoặc chức năng gì mới. Hoàn
thành nhanh nhất có thể, code liên tục, dùng claude-glm."*

## 1. What changes and what does not

**Changed by this directive:**

- Goal is **behavior parity with Windows Zira AI 1.0.23**, not a redesigned
  architecture. Android talks to the same backend routes, with the same DTOs
  and the same semantics the Windows app uses in production today.
- The `PosApplication`/`PlatformPorts` re-architecture (641 call-site
  migration) is **dropped** for the port. Instead the real POS renderer runs
  unmodified behind a **`window.electronAPI` shim** whose implementations are
  ported main-process modules made browser-safe.
- The eight backend P0 items in `OPEN_BACKEND_CONTRACT_DECISIONS.md` move to
  a **separate backend track**. They are real defects, but the Windows app
  already operates against them in production; parity means Android is no
  worse, not that Android waits for backend perfection.
- Native SQLite, the three-ledger redesign, chaos-test suites beyond the
  ported Windows retry logic, Play flavors, signing, and versionCode
  allocation are **deferred until the distribution stage** — they gate
  release, not development.
- Continuous coding: work is a conveyor of small packets executed by
  claude-glm headless runs, each reviewed, tested, and committed by the
  supervising Claude session before the next starts (see §4).

**Not changed (hard rails, still non-negotiable):**

1. Staff JWT only. Android never stores the salon-wide `pa_` key, never
   calls `/print-agent/connect`, never impersonates a print agent.
2. CASH-only order writes. Electronic tenders stay disabled.
3. All testing against a **test/sandbox salon** until Paul explicitly names a
   real salon for pilot. Chesaigon machines are never touched.
4. No publish: no Play upload, no R2 mutation, no tag. The production
   readiness gate and register (`PRODUCTION_READINESS_GATE_2026-07-18.md`)
   still gate *release*; this plan accelerates *development*.
5. Every GLM packet is reviewed (diff + tests) by the supervising session
   before commit; worktree stays clean between packets.
6. Direct Android fiscal printing stays out. Printing is remote jobs through
   the Windows agent, or absent at first (Windows counter keeps printing).

## 2. Why the shim port is the fastest correct path

- The Windows POS renderer is React/Vite and already builds for Android
  (Stage 2 proved the toolchain). What is missing is the main process.
- The main-process modules the POS flow needs are mostly plain TypeScript:
  `api-client.ts` (HTTP), `order-sync.ts` (retry/`orders.synced`), repos over
  **SQL.js — already WebAssembly**, which runs in the WebView as-is with
  persistence redirected from Node `fs` to Capacitor Filesystem.
- Therefore "porting" is: replace Node/Electron effects (fs, electron-store,
  safeStorage, ipcMain) with WebView/Capacitor equivalents behind the same
  `window.electronAPI` method signatures the renderer already calls.
- The existing cross-platform boundary verifier keeps guarding the bundle:
  no Electron/Node imports may reach the Android graph; ported modules must
  pass it.

Windows behavior stays the reference: ported logic is copied, not improved.
Where Windows is quirky, Android is identically quirky. Divergences are bugs.

## 3. Milestones — definition of "app hoạt động"

| Mốc | Nội dung | Bằng chứng hoàn thành |
|---|---|---|
| M1 | Real POS renderer boots on Android behind the shim; staff login (same auth flow as Windows); session survives restart | Login vào salon test trên emulator/tablet, `/auth/me` đúng salon |
| M2 | Real catalog (same endpoints Windows calls), search/browse, cart with ported pricing rules | Catalog salon test hiển thị, giỏ tính tiền khớp Windows với cùng fixture |
| M3 | CASH order lands in backend via the same route/DTO Windows sends, with ported `order-sync` retry; order history | Đơn tạo từ Android thấy được trong web dashboard/Windows |
| M4 | Shift open/close parity + diagnostics screen (version, SHA, sync state) | Shift mở/đóng từ Android, Windows/web thấy đúng |
| M5 | Remote receipt print via existing staff-JWT print routes with pending/confirmed/failed states (or explicitly skipped for pilot) | Job in từ Android ra máy in qua agent Windows tại salon test |
| M6 | Sideload APK on the named tablet; on-device smoke of M1–M4 | APK debug/sideload chạy toàn luồng trên tablet thật |

Play distribution, signing, and the release register come after M6 and
consume the owner decisions already listed in the readiness register.

## 4. Continuous claude-glm conveyor

Protocol per packet:

1. Supervisor (Claude session) picks the next packet from §5, writes a
   self-contained prompt: exact scope files, the shim/port contract, tests to
   run, and the forbidden list (no Electron/Node imports in Android graph, no
   new features, no backend changes, no publish, no `pa_` key).
2. `glm-run.sh` executes it headless (`--model opus` → glm-5.2) in this
   worktree; long packets run in background while the supervisor reviews the
   previous one.
3. Supervisor reviews the diff, runs the packet's tests plus
   `npm run test:android:boundaries` and the readiness gate, fixes or bounces
   findings, then commits locally with a conventional message.
4. Push to the feature branch periodically for remote CI evidence (build-only
   pipeline; R12 exit-12 remains the expected steady state).

Packet sizing rule: one packet = one commit = reviewable in minutes, not
hours. Two GLM runs may go in parallel only when their file sets are
disjoint.

## 5. Packet backlog (S-series)

| # | Packet | Scope | Gate to start |
|---|---|---|---|
| S1 | electronAPI inventory | Read-only: list every `window.electronAPI.*` method the retail POS flow actually calls (login → catalog → cart → pay CASH → history → shift), with file:line and payload shapes. Output: `docs/android-pos/SHIM_CONTRACT_S1.md` | none — start now |
| S2 | Shim skeleton | `src/renderer/android-pos` mounts the real retail POS entry behind a typed shim implementing the S1 contract with in-memory fakes; app boots to POS UI | S1 |
| S3 | HTTP/api-client port | Browser-safe port of the API-client subset (staff login, refresh, `/auth/me`, catalog, orders, shifts, print) using fetch; same DTOs/headers as Windows | S1 |
| S4 | Token/config storage | Capacitor secure storage for tokens (Keystore-backed), preferences for config; same keys/semantics as electron-store where visible to renderer | S2 |
| S5 | SQL.js in WebView | Boot SQL.js WASM with persistence via Capacitor Filesystem (no-backup dir); port the product/category/settings repos the POS flow needs | S2 |
| S6 | Catalog sync port | Port the catalog sync worker (same endpoints/cursors Windows uses); offline catalog after first sync | S3+S5 |
| S7 | POS flow on real data | Wire shim methods to S3–S6; login → browse → cart works end-to-end read-only against the test salon | S3,S4,S5 |
| S8 | CASH order + order-sync port | Port order creation DTO builder and `order-sync` retry/`synced` semantics byte-compatibly; double-tap guard as on Windows | S7 |
| S9 | Shift + history | Port shift open/close calls and order-history views, Windows semantics as-is | S8 |
| S10 | Remote print | Staff-JWT print job create/status with pending/confirmed/failed UI states; no local drivers | S8 |
| S11 | Device polish | Landscape default + rotation survival, back button, soft keyboard, error/offline banners — parity level, no redesign | S7 |
| S12 | Sideload packaging | Debug/sideload APK build + install docs for the named tablet; on-device smoke checklist | S7 (device), S8 (full) |

Each packet lands with focused tests (ported-logic fixtures compared against
Windows behavior where practical) and must keep the boundary verifier and
readiness gate green (`NO-GO` with 0 hard failures).

## 6. Separate tracks (not blocking the port)

- **Backend P0 security track**: the eight P0 items remain in
  `OPEN_BACKEND_CONTRACT_DECISIONS.md` as an eNail backend workstream with
  its own guarded release process. Fixing them helps Windows and Android
  equally; the port neither waits for them nor makes them worse.
- **Distribution track**: applicationId, Play model, signers, versionCode
  allocator, R12, legacy `build.yml` migration — all still owner decisions in
  the readiness register, needed before any salon-wide rollout.
- **Hardware track**: Paul names two target tablets; until then, development
  uses emulator/desktop-Chromium at tablet viewport, and M6 waits for the
  device.

## 7. Risk acceptance recorded

By this directive the owner accepts, for the pilot phase, the same risk
posture the Windows app has today (non-idempotent shift commands, tender
handling, offline-window behavior of `order-sync`), on a test salon first.
Anything that would make Android *worse* than Windows (weaker token storage,
electronic tenders, fiscal claims without printer confirmation) remains
prohibited.
