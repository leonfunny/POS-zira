# POS2 -> POS1 Safe Print Retry Plan

Status: reviewed safety plan; backend-gated; not implemented
Date: 2026-06-29
Repo: POS-zira on Chesaigon POS1 (`C:\Users\pc\POS-zira`, branch `main`, observed commit `5dc92d2`)
Live app: `C:\Program Files\Zira AI`
Scope: POS2 shared receipt/order-copy and shared ELZAB fiscal route to POS1
Server prerequisite request: `docs/server-change-requests/2026-06-29-safe-print-retry-backend-contract.md`

> For agentic workers: this plan is a safety plan. Do not implement in the live
> counter app until the owner explicitly approves the code change and release.
> Build/test on POS source first. Close/restart `Zira AI.exe` only when ready to
> install a verified build.

## 0. Review Verdict And Safety Gates

Review result: the idea is sound, but POS2 auto retry is not safe to implement
until the backend contract is deployed and verified. This repo is the Electron
client; server-side print job idempotency, final status, and guarded retry must
come from the eNail backend, not a client workaround.

Safe to do now:

- Add client-only contract types/tests that remain backward-compatible.
- Add future-compatible POS1 status emission fields, as long as old backend
  behavior still works.
- Keep all POS2 automatic retry behavior disabled until the gates below pass.

Blocked until server support exists:

- POS2 automatic retry after `/print-agent/jobs` request timeout.
- POS2 automatic retry based only on text like "owner offline" from a create-job
  error.
- Any fiscal retry through the current broad retry endpoint.

Required safety gates before enabling auto retry:

- Gate S1 - backend idempotency: print jobs accept a stable idempotency key,
  store a payload hash, return the existing job for duplicates, and never emit a
  second fiscal command for the same key.
- Gate S2 - final failure class: normal `job:status` updates persist
  `failureClass` and waiting create/status responses return it.
- Gate S3 - guarded retry: retry is atomic and allowed only from
  `FAILED + SAFE_BEFORE_PRINT`; in-flight, completed, final, unknown, and
  uncertain jobs are rejected with `retryBlockedReason`.
- Gate S4 - client rollout guard: POS-zira detects or is configured for the
  deployed server contract before enabling retry. Default behavior stays manual
  fallback when the server capability is absent.

## 1. Executive Decision

We should implement safe auto retry after the gates above, but only for failures
that are proven to be before any physical printer/fiscal command.

Do not auto retry every `FAILED`, and do not auto retry unknown client/network
errors.

The core rule:

- Receipt/order copy: auto retry is allowed for `SAFE_BEFORE_PRINT` and
  pre-job failures. For ambiguous failures, stop and show manual retry.
- Fiscal ELZAB: auto retry is allowed only for `SAFE_BEFORE_PRINT` or pre-job
  failures. If a job may have reached POS1/ELZAB, do not retry automatically.
  Use Order History / reconcile.

## 1.1 Active Checkout Retry Timing Decision

User constraint from 2026-06-29: allow up to 3 automatic retries, guard
carefully, cancel retry if a print succeeds, and do not block checkout long
enough to slow the next customer.

Decision for the active POS checkout screen:

- `maxAutoRetries = 3` means at most 3 automatic retry attempts after the first
  retryable failure. This is not a license to retry ambiguous fiscal jobs.
- Retry delay schedule: retry #1 after 2s, retry #2 after 4s, retry #3 after
  6s.
- Hard UI cap: manual controls must appear no later than 15s after the first
  retryable failure, and no later than 20s after the original print action
  started.
- If any attempt returns `COMPLETED`, `PRINTED`, or `receiptPrinted=true`,
  cancel all pending retry timers immediately.
- If the current/latest observable state is `SENT`, `PRINTING`, `TIMEOUT` with
  a `jobId`, `UNKNOWN`, `UNKNOWN_NEEDS_RECONCILIATION`,
  `UNCERTAIN_AFTER_PRINT`, `APP_RESTART_AFTER_SENT`, or
  `FISCAL_ATTEMPT_RETRY_BLOCKED`, cancel auto retry and show
  manual/reconcile UI. These states mean the printer may already have received
  the job.
- A final `FAILED + SAFE_BEFORE_PRINT` from POS1/backend remains retryable even
  if an earlier intermediate update was `SENT` or `PRINTING`. Historical
  in-flight states are not a retry blocker when the final failure class proves
  no device command was sent.
- Fiscal must never become `3 * 60s`. The current shared fiscal path can wait up
  to 60s for a final backend result. Auto retry is allowed only when the failure
  happens before a job is created or is explicitly classified as
  `SAFE_BEFORE_PRINT`. A `TIMEOUT` response is ambiguous and is not retryable.
- Receipt/order-copy should retry only pre-job failures and final
  `SAFE_BEFORE_PRINT` failures. If the shared receipt route waits for POS1's
  terminal status, that wait must use a short cap, 8-10s, because POS1 already
  does its own 3-attempt printer loop with 2s gaps.
- Manual fallback stays as it is today: `PaymentModal` shows `Retry order print`
  / `Continue without print` for order-copy failures, and `OrderHistoryModal`
  has `Print order`, `Print fiscal receipt`, and fiscal reconcile controls.
- Retry timers and long waits must not monopolize the active checkout modal.
  Manual controls must appear at the UI cap even if a background-safe retry was
  scheduled; retry work after the cap must be cancelled or moved to explicit
  manual action.

## 1.2 Flow Impact Guard

This change does touch the active print flow, but it must not touch the working
order/payment flow.

Allowed implementation surface:

- POS shared print routing:
  - `src/main/printing/shared-receipt-printer.ts`
  - `src/main/printing/shared-fiscal-printer.ts`
- POS printer status reporting:
  - `src/main/network/socket-client.ts`
  - `src/main/modules/hardware.module.ts`
- POS payment UI status only:
  - `src/renderer/components/pos/PaymentModal.tsx`
  - `src/renderer/components/pos/OrderHistoryModal.tsx`

External server prerequisite, not code to edit in this repo:

- Backend print job safety:
  - `backend/src/modules/print-agent/services/print-job.service.ts`
  - `backend/src/modules/print-agent/controllers/print-agent.controller.ts`
  - `backend/src/modules/print-agent/dto/print-job.dto.ts`
  - tracked by
    `docs/server-change-requests/2026-06-29-safe-print-retry-backend-contract.md`

Forbidden implementation surface unless separately approved:

- No changes to order creation, cart totals, payment amount calculation, stock,
  customer debt, order sync semantics, or fiscal driver receipt command sequence.
- No copying or changing Chesaigon `machineId`, local `pos.db`, printer
  assignments, fiscal history, API keys, or secure token storage.
- No live counter app restart until code is built and verified.
- No client-only emulation of backend idempotency, final status, or retry
  authorization.

Successful path behavior must remain one attempt with no artificial sleep. The
2s/4s/6s timers run only after a retryable failure class is known.

## 2. Confirmed Current Behavior

POS2 currently routes to POS1 through backend print jobs.

Relevant POS files:

- `src/main/printing/shared-receipt-printer.ts`
- `src/main/printing/shared-fiscal-printer.ts`
- `src/main/pos/payment-controller.ts`
- `src/main/modules/hardware.module.ts`
- `src/main/network/socket-client.ts`
- `src/main/hardware/elzab/elzab-driver.ts`
- `src/main/database/repos/fiscal-attempt-repo.ts`
- `src/renderer/components/pos/PaymentModal.tsx`
- `src/renderer/components/pos/OrderHistoryModal.tsx`

Relevant backend files in eNail:

- `backend/src/modules/print-agent/services/print-job.service.ts`
- `backend/src/modules/print-agent/controllers/print-agent.controller.ts`
- `backend/src/modules/print-agent/gateways/print-agent.gateway.ts`
- `backend/src/modules/print-agent/dto/print-job.dto.ts`
- `backend/src/modules/print-agent/entities/print-job.entity.ts`

Current important facts:

- POS1 retries inside `HardwareModule.handlePrintJob()` 3 total attempts
  (`PRINT_JOB_MAX_RETRIES = 2`, delay 2s).
- POS2 shared fiscal already uses `waitForCompletion: true`.
- POS2 shared receipt currently treats backend `sent !== false` as success. It
  does not wait for POS1's final printer result, so POS2 may mark a receipt as
  printed even if POS1 later reports job failed.
- POS1 socket status API currently sends only `jobId`, `status`,
  `errorMessage`. Backend DTO supports `failureClass`, but the normal socket
  helper does not send it for normal backend jobs.
- Backend has `PrintJobFailureClass`:
  - `SAFE_BEFORE_PRINT`
  - `UNCERTAIN_AFTER_PRINT`
  - `FINAL`
- Backend `retryJob(jobId)` exists, but it blindly resets any failed job to
  `PENDING`. POS UI does not currently use it for this POS2->POS1 flow.
- Shared receipt/fiscal requests do not currently send `idempotencyKey`.
- Backend current behavior was researched for this plan, but server code is not
  in this repo. Re-verify with the server owner or deployed contract before
  enabling retry behavior.

## 3. Production Evidence From Chesaigon

Read-only DB snapshots were checked on POS1 and POS2.

POS2 receipt/order-copy failed groups:

- `Printer owner agent is offline`: 25
- `Printer is offline`: 6
- `NO_PRINTER`: 4
- `Request timeout to backend`: 2

POS2 fiscal failed groups:

- `request timeout to backend`: 4
- `fiscal safety gate/retry blocked`: 3
- `route not ready fiscal printer`: 2
- `pos1 fiscal printer not connected`: 1

POS1 fiscal attempt groups:

- `SUCCESS_CONFIRMED`: 1542
- `FAILED_CONFIRMED`: examples include `ELZAB_LOCAL_MENU_MODE`,
  `ELZAB_HARDWARE_NOT_FOUND`, `ReceiptBegin failed: paper missing`
- `UNKNOWN_NEEDS_RECONCILIATION`: examples include PowerShell/sidecar timeout,
  process failure after `SENT`, app restart after `SENT`

Interpretation:

- There are real safe retry candidates.
- There are also real ambiguous fiscal outcomes, so a broad auto retry is unsafe.

## 4. Safety Classification

### 4.1 Safe To Auto Retry

These are safe because no physical print command should have reached POS1/ELZAB,
or POS1 can prove it failed before sending to the device.

Important: "safe" is based on the source of the evidence, not only the error
text. Acceptable proof is either a local pre-job assignment/readiness check, or
a backend final status carrying `failureClass === SAFE_BEFORE_PRINT`. A string
inside a failed create-job request is not proof if a job may already exist.

Pre-job / no backend job created:

- Shared route not configured.
- `FISCAL_RECEIPT printer ... is not a ready FISCAL printer`.
- `Printer owner agent is offline`, only when returned by readiness lookup or a
  server pre-dispatch rejection that proves no job was emitted.
- `Printer is offline`, only when returned by readiness lookup or a server
  pre-dispatch rejection that proves no job was emitted.
- No local/shared printer configured.
- Assignment/readiness lookup fails before `createPrintJob`.

POS1 received job but did not call the printer driver:

- `Printer RECEIPT not connected`.
- `FISCAL PRINTER FISCAL NOT CONNECTED`.
- Missing local driver for the target printer id.

ELZAB confirmed before-start failures:

- `ELZAB_HARDWARE_NOT_FOUND` / COM port missing before receipt command.
- `ReceiptBegin failed`.
- `ReceiptConditions failed`.
- `REAL_FISCAL_PRINT_DISABLED` in non-production/test contexts.

These may still require operator action, so retry must be bounded and visible,
not infinite.

### 4.2 Not Safe To Auto Retry

These are not safe because the print command may have been sent or may still be
in flight.

- POS2 HTTP `Request timeout` while calling `/print-agent/jobs` without a stable
  idempotency key.
- POS2 HTTP/network failure while creating a job when the backend idempotency
  gate has not been verified.
- Fiscal backend response `TIMEOUT` with a `jobId`.
- Any job status `SENT` or `PRINTING`.
- `FISCAL_RESULT_UNKNOWN`.
- `UNKNOWN_NEEDS_RECONCILIATION`.
- `APP_RESTART_AFTER_SENT`.
- `FISCAL_ATTEMPT_RETRY_BLOCKED`.
- `UNCERTAIN_AFTER_PRINT`.
- Any fiscal error after item/payment commands started.

Required behavior for these:

- Stop auto retry.
- Show manual action in Order History.
- For fiscal unknown, force reconcile: cashier must check the physical ELZAB
  printer before allowing any new fiscal print.

## 5. Root Causes Blocking Safe Auto Retry Today

1. Shared receipt/fiscal jobs are not idempotent.

   If POS2 times out while creating a job, a second request may create a second
   backend print job. This is especially dangerous for fiscal.

2. Normal POS1 backend jobs do not transmit `failureClass`.

   The backend DTO already supports it, but `SocketClient.sendJobStatus()`
   does not include it, and `HardwareModule.handlePrintJob()` only records
   `failureClass` internally for LAN-first kitchen paths.

3. Shared receipt does not wait for final printer result.

   POS2 sees `sent=true` as `PRINTED`, so it cannot auto retry if POS1 later
   fails before printing.

4. Backend retry endpoint is too broad for fiscal.

   `POST /print-agent/jobs/:jobId/retry` currently retries any failed job. For
   fiscal it must be blocked unless `failureClass === SAFE_BEFORE_PRINT`.

5. POS2 does not have a local durable print retry queue.

   Current retry is a UI action in `PaymentModal` / Order History. If we add
   background retry, it must be persisted or explicitly limited to the active
   payment flow.

## 6. Proposed Design

Implementation order is server-first. POS-zira may add compatible types, tests,
logging, and status emission, but it must not enable automatic retry until the
server change request is accepted, deployed, and verified against this client.

### 6.1 Shared Job Idempotency

Add idempotency to shared printer jobs.

POS shared type changes:

- `src/shared/types.ts`
  - Add optional `idempotencyKey?: string` to `CreatePrintJobRequest`.
  - Add response fields used by retry logic if missing:
    `status`, `failureClass`, `errorMessage`, `timedOut`.

Key format:

- Initial order copy:
  - `pos-receipt:${machineId}:${orderId}:order:v1`
- Receipt reprint:
  - do not reuse the initial key; manual reprint should be allowed to print a
    new copy.
- Fiscal receipt:
  - `pos-fiscal:${machineId}:${orderId}:default:v1`

Expected backend behavior:

- If the same key arrives again with the same payload, return the existing job.
- If the same key arrives again with a different payload hash, return `409` and
  do not emit a print job.
- Never emit an already `SENT`/`PRINTING` fiscal job again.
- If an existing job is `COMPLETED`, return completed.
- If an existing job is `FAILED` with `SAFE_BEFORE_PRINT`, allow retry through
  a guarded endpoint, not by creating a duplicate job.
- If an existing job is `FAILED` with `UNCERTAIN_AFTER_PRINT` or `FINAL`, do
  not retry automatically.

### 6.2 Failure Class From POS1 To Backend

Change POS1 status reporting:

- `src/main/network/socket-client.ts`
  - Extend `sendJobStatus(jobId, status, errorMessage?, failureClass?)`.

- `src/main/modules/hardware.module.ts`
  - When target driver is missing/not connected before print command:
    `FAILED + SAFE_BEFORE_PRINT`.
  - When print function throws before a fiscal start condition:
    `FAILED + SAFE_BEFORE_PRINT`.
  - When ELZAB says `FISCAL_RESULT_UNKNOWN`:
    `FAILED + UNCERTAIN_AFTER_PRINT`.
  - When fiscal retry is blocked by existing success/unknown:
    `FAILED + FINAL`.
  - For generic receipt driver throws after `printReceipt()` was called:
    `FAILED + UNCERTAIN_AFTER_PRINT` unless we can prove before-print.

Backend already has DTO support for `failureClass`, but tests should prove the
normal socket path stores it.

Status semantics:

- POS1 currently emits `PRINTING` before the driver call in
  `HardwareModule.handlePrintJob()`. Do not use an intermediate `PRINTING`
  update as permanent proof that printing began if the final update is
  `FAILED + SAFE_BEFORE_PRINT`.
- If the latest/current state is still `SENT` or `PRINTING` and no final
  `SAFE_BEFORE_PRINT` failure exists, treat it as in-flight/ambiguous and stop
  auto retry.

### 6.3 Backend Retry Guard

Change backend retry behavior:

- For fiscal jobs:
  - Allow retry only when current status is `FAILED` and
    `failureClass === SAFE_BEFORE_PRINT`.
  - Reject `UNCERTAIN_AFTER_PRINT`, `FINAL`, `SENT`, `PRINTING`, `COMPLETED`.

- For receipt/order-copy jobs:
  - Allow retry for `SAFE_BEFORE_PRINT`.
  - Do not auto retry `UNCERTAIN_AFTER_PRINT`; manual `Print order` is enough.

Hard backend requirements:

- Retry transition must be atomic, using a transaction/row lock or equivalent
  compare-and-set from `FAILED + SAFE_BEFORE_PRINT` into an in-flight retry
  state.
- Concurrent retry requests for the same job/idempotency key must not emit two
  socket jobs.
- Server must enforce max retry attempts and persist attempt count/audit data.
- Retry must target the same owner agent/printer as the original job unless a
  human explicitly changes the assignment and starts a new manual print.

Add a safer response to `retryJob()`:

```ts
{
  jobId,
  status,
  sent,
  failureClass,
  retryAllowed,
  retryBlockedReason
}
```

### 6.4 POS2 Retry Engine

Add a small classifier, not ad-hoc string checks in UI:

- New helper candidate:
  - `src/main/printing/shared-print-retry-policy.ts`

Inputs:

- operation: `RECEIPT_ORDER_COPY | FISCAL_RECEIPT`
- phase: `ASSIGNMENT_LOOKUP | READINESS_LOOKUP | CREATE_JOB | WAIT_RESULT | JOB_STATUS`
- error/status
- `jobId`
- `failureClass`
- `timedOut`

Output:

- `AUTO_RETRY_SAFE`
- `STOP_MANUAL_RETRY`
- `STOP_RECONCILE_REQUIRED`
- `ALREADY_IN_FLIGHT`
- `SUCCESS`

Constraints:

- No UI component should parse printer error strings to decide fiscal retry.
- `AUTO_RETRY_SAFE` requires either local pre-job evidence or final
  `SAFE_BEFORE_PRINT` from the verified backend contract.
- `retryPrintJob(jobId)` must not be called unless Gate S3 is verified.

Bounded retry:

- Max 3 automatic retries after the first retryable failure.
- Backoff: 2s, 4s, 6s.
- Hard UI cap: expose manual action by 15s after the first retryable failure,
  and by 20s after the original print action started.
- Stop immediately on `UNCERTAIN_AFTER_PRINT`, `FINAL`, current/in-flight
  `SENT`, current/in-flight `PRINTING`, `COMPLETED`, or `TIMEOUT` with
  `jobId`.
- Fiscal never retries while the current status is `PRINTING`; a later final
  `FAILED + SAFE_BEFORE_PRINT` can still be retryable if the owner POS proves no
  fiscal command was sent.

### 6.5 Receipt Final Result

For initial POS order-copy prints from POS2 to POS1, change shared receipt to
use backend final status for the initial payment flow.

Prerequisite: backend must support a bounded final wait/status response with
`failureClass`; otherwise keep today's manual fallback and do not enable
background retry.

Proposed:

- `referenceType === POS_RECEIPT`:
  - set `waitForCompletion: true`
  - timeout around 8-10s in the active checkout flow
  - if final `COMPLETED`, mark local print attempt `PRINTED`
  - if Gates S2-S3 are verified and final status is
    `FAILED + SAFE_BEFORE_PRINT`, retry bounded
  - if timeout/unknown, show manual retry, not background retry

Do not use a 30s receipt wait in the active payment modal. POS1 already has an
internal 3-attempt printer loop with 2s gaps; if POS2 cannot get a safe final
answer inside the short cap, the cashier should see manual controls.

Keep manual reprints simpler:

- Manual `Print order` from Order History can still send a fresh copy and show
  the immediate result.

Reason:

- Today POS2 records `PRINTED` once backend says sent. That hides POS1 failure.
  Waiting for final status lets POS2 make a real safe retry decision.

### 6.6 Fiscal Flow

Fiscal already waits for completion. Keep that, but harden:

- Add idempotency key.
- After Gate S1 is verified, if POS2 HTTP request times out without `jobId`,
  retry the same create request with the same idempotency key. If the first
  request reached backend, backend returns existing job instead of creating a
  second fiscal command.
- If Gate S1 is not verified, do not retry the HTTP timeout. Show manual state
  and require Order History/reconcile.
- If response is `TIMEOUT` with `jobId`, do not auto retry. Poll job status once
  or twice, then show reconcile/manual state.
- If Gates S2-S3 are verified and final status is
  `FAILED + SAFE_BEFORE_PRINT`, retry bounded.
- If final `FAILED + UNCERTAIN_AFTER_PRINT`, do not retry. Require reconcile.
- If final `FAILED + FINAL`, do not retry.

Do not wrap the existing 60s wait in three more 60s retries. Fiscal retry is for
fast pre-job or explicit `SAFE_BEFORE_PRINT` failures only. If the first fiscal
job is in flight, auto retry is finished.

## 7. Implementation Plan

### Task 0 - Baseline and Tests

- [ ] Record current POS1 source commit and clean status.
- [ ] Run lightweight type checks/tests available in POS-zira.
- [ ] Add unit tests for retry policy helper first.
- [ ] Add backend unit tests for `failureClass` storage and guarded retry.
- [ ] Confirm server change request
      `docs/server-change-requests/2026-06-29-safe-print-retry-backend-contract.md`
      is accepted/deployed before enabling POS2 retry behavior.

### Task 1 - POS Shared Types and API Client

Files:

- `src/shared/types.ts`
- `src/main/network/api-client.ts`

Work:

- [ ] Add `idempotencyKey` to `CreatePrintJobRequest`.
- [ ] Add response fields needed by retry logic if absent.
- [ ] Add `getPrintJobStatus(jobId)` client method.
- [ ] Add guarded `retryPrintJob(jobId)` client method.
- [ ] Add a capability check/config gate so retry defaults off when the server
      contract is absent.

Acceptance:

- TypeScript accepts shared receipt/fiscal callers passing idempotency.
- Existing print paths compile unchanged if they omit idempotency.

### Task 2 - POS1 Failure Class Reporting

Files:

- `src/main/network/socket-client.ts`
- `src/main/modules/hardware.module.ts`
- possible helper: `src/main/printing/print-failure-classifier.ts`

Work:

- [ ] Extend `sendJobStatus()` to include optional `failureClass`.
- [ ] Add pure helper to classify errors.
- [ ] Mark not-connected/no-driver failures as `SAFE_BEFORE_PRINT`.
- [ ] Mark `FISCAL_RESULT_UNKNOWN` as `UNCERTAIN_AFTER_PRINT`.
- [ ] Mark retry-blocked/safety-gate as `FINAL`.
- [ ] Keep current internal 3-attempt POS1 retry before sending final failure.

Acceptance:

- Unit tests cover:
  - not connected -> `SAFE_BEFORE_PRINT`
  - ELZAB unknown -> `UNCERTAIN_AFTER_PRINT`
  - retry blocked -> `FINAL`
  - generic after driver call -> not auto retry

### Task 3 - Backend Guardrails

This is external server work. Do not implement client workarounds in POS-zira if
these server changes are missing.

Files:

- `backend/src/modules/print-agent/services/print-job.service.ts`
- `backend/src/modules/print-agent/controllers/print-agent.controller.ts`
- related DTO/tests

Work:

- [ ] Ensure normal socket `job:status` persists `failureClass`.
- [ ] Ensure create-job idempotency returns existing job and does not re-emit
      `SENT`/`PRINTING`.
- [ ] Make `retryJob()` guarded:
  - fiscal requires `SAFE_BEFORE_PRINT`
  - receipt auto retry uses only `SAFE_BEFORE_PRINT`
  - reject unknown/final/in-flight/completed
- [ ] Return useful retry block reason.

Acceptance:

- Tests prove fiscal `UNCERTAIN_AFTER_PRINT` cannot be retried.
- Tests prove fiscal `SAFE_BEFORE_PRINT` can be retried once and re-sent.
- Tests prove idempotent duplicate create does not duplicate fiscal job.

### Task 4 - Shared Receipt Retry Path

Files:

- `src/main/printing/shared-receipt-printer.ts`
- `src/main/pos/payment-controller.ts`
- `src/renderer/components/pos/PaymentModal.tsx` if UI status copy changes

Work:

- [ ] Add idempotency key for initial POS receipt/order-copy.
- [ ] For initial shared `POS_RECEIPT`, use `waitForCompletion` only with an
      8-10s active-checkout timeout.
- [ ] If backend Gates S2-S3 are verified and final status is
      `FAILED + SAFE_BEFORE_PRINT`, retry bounded with 2s/4s/6s delays.
- [ ] If timeout/unknown, stop and show current `Retry order print` UI.
- [ ] Preserve manual `Print order` behavior in Order History.

Acceptance:

- If POS1 owner agent is offline, POS2 retries a few times then shows button.
- If POS1 reports not connected before print, POS2 retries safely.
- If POS1 reports ambiguous/timeout, POS2 does not background retry.
- If backend capability probe fails, POS2 keeps current manual fallback.

### Task 5 - Shared Fiscal Retry Path

Files:

- `src/main/printing/shared-fiscal-printer.ts`
- `src/main/pos/payment-controller.ts`
- possibly `src/renderer/components/pos/OrderHistoryModal.tsx`

Work:

- [ ] Add fiscal idempotency key.
- [ ] On POS2 HTTP timeout without jobId, retry same idempotency key only after
      Gate S1 is verified.
- [ ] If backend Gates S2-S3 are verified and final status is
      `FAILED + SAFE_BEFORE_PRINT`, retry bounded with 2s/4s/6s delays.
- [ ] Do not multiply the current 60s fiscal wait by retry count.
- [ ] On `TIMEOUT` with jobId, poll status briefly; if unresolved, stop.
- [ ] On `UNCERTAIN_AFTER_PRINT`, show reconcile/manual only.
- [ ] On `FINAL`, show manual error only.

Acceptance:

- Safe cases retry without creating duplicate fiscal jobs.
- Unknown/reconcile cases never auto retry.
- Existing Order History reconcile UI remains the only path for unknown fiscal
  outcomes.
- Without verified backend idempotency, fiscal HTTP timeout does not retry.

### Task 6 - Local Journaling and Observability

Files:

- `src/main/database/repos/print-attempt-repo.ts`
- `src/main/database/repos/fiscal-receipt-sync-repo.ts`
- `src/main/events/pos-event-emitter.ts` if needed

Work:

- [ ] Store retry attempt count and last retry reason in print/fiscal journal
      where useful.
- [ ] Include `jobId`, `idempotencyKey`, `failureClass`, and `retryDecision`
      in logs.
- [ ] Do not log secrets/API keys/tokens.

Acceptance:

- Support can answer why a print did or did not auto retry from logs/DB.

### Task 7 - UI Behavior

Files:

- `src/renderer/components/pos/PaymentModal.tsx`
- `src/renderer/components/pos/OrderHistoryModal.tsx`

Work:

- [ ] During bounded retry show simple status:
  - "Printer reconnecting, retry 2/3..."
- [ ] Show manual controls by 15s after the first retryable failure, or 20s
      after the original print action started, whichever comes first.
- [ ] After retries exhausted keep existing manual buttons:
  - `Retry order print`
  - `Print fiscal receipt`
  - reconcile controls for unknown fiscal
- [ ] Never hide the fact that order was saved.

Acceptance:

- Cashier sees order saved even if print fails.
- Fiscal unknown clearly asks cashier to check ELZAB paper before doing
  anything else.

## 8. Test Plan

Backend:

- [ ] Server contract smoke test proves Gates S1-S3 before client retry is
      enabled.
- [ ] Unit tests for print job idempotency.
- [ ] Unit tests for guarded retry by `failureClass`.
- [ ] Unit tests for normal socket status update storing `failureClass`.

POS main:

- [ ] Unit tests for retry policy helper.
- [ ] Unit tests/static tests for `sendJobStatus(..., failureClass)`.
- [ ] Unit tests for shared fiscal timeout/idempotency behavior.

Manual Chesaigon staging checks before live install:

- [ ] POS1 online + printer online: POS2 receipt prints once.
- [ ] POS1 app closed: POS2 retries bounded, then shows manual retry.
- [ ] POS1 printer disabled/offline before print: safe retry then manual.
- [ ] Fiscal route not ready: safe retry then manual.
- [ ] Simulated fiscal unknown: no auto retry, reconcile required.
- [ ] Network timeout simulation with idempotency: no duplicate backend job.

Live deploy checks only after approval:

- [ ] Build POS-zira on Chesaigon source checkout.
- [ ] Stop `Zira AI.exe` only when installer/app artifact is ready.
- [ ] Update POS1 first, then POS2 if needed.
- [ ] Verify both machine IDs/configs remain unique.
- [ ] Verify POS2 fiscal route still points to POS1 fiscal printer.
- [ ] Do one non-fiscal receipt test.
- [ ] Do fiscal test only with owner approval beside printer.

## 9. Non-Goals

- Do not make fiscal printing "exactly once" across power loss; impossible
  without hardware confirmation and operator reconciliation.
- Do not auto retry unknown fiscal outcomes.
- Do not copy POS1 local DB/API keys/machine identity to POS2.
- Do not change normal order sync semantics.
- Do not deploy to Contabo as part of POS-only work.

## 10. Resolved Decisions Before Coding

1. Initial shared receipt/order-copy final wait applies only when POS2 routes to
   POS1 through the shared printer path. Do not add this wait to local receipt
   printing or unrelated manual print flows.

2. Safe fiscal auto retry starts inside the active payment/manual print flow
   only. Durable background retry is a later phase after idempotency, failure
   classification, and operator UI are proven.

3. For receipt/order-copy ambiguous failures, duplicate paper is acceptable only
   if the cashier presses manual retry. Do not background retry ambiguous
   receipt failures.

4. Backend retry must be guarded before any POS UI uses it. Either restrict
   `retryJob()` by `failureClass` or add a dedicated `safe-retry` endpoint; in
   both cases, return a clear `retryBlockedReason`.

## 11. Recommended Rollout

Phase A - Code contracts, no behavior change:

- Add idempotency fields.
- Add failureClass transport from POS1 to backend.
- Add tests and logs.

Phase B - Receipt safe retry:

- Enable bounded safe retry for shared receipt/order-copy.
- Verify on POS2/POS1 with printer offline and owner offline cases.

Phase C - Fiscal safe retry:

- Enable only `SAFE_BEFORE_PRINT` fiscal retry.
- Keep timeout/unknown/retry-blocked manual.
- Verify with controlled tests, not during busy counter hours.

Phase D - Optional durable retry queue:

- Only if active-flow retry is insufficient.
- Requires a local DB queue with strict idempotency and visible operator state.
