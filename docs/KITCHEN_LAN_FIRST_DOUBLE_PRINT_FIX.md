# Kitchen LAN-first double-print fix (timeout-uncertain → no fallback)

**Date:** 2026-06-19
**Area:** `src/main/printing/shared-kitchen-printer.ts`, `src/main/modules/pos.module.ts`
**Scope:** client-side (POS-zira). No backend change.

## Bug

Self-order K-002 printed its **kitchen ticket twice** on the remote printer
(192.168.3.10). Backend had exactly ONE job (idempotency held), but the job's
`sent_at` was populated — i.e. it was ALSO dispatched through the backend socket,
on top of the POS's LAN-direct print.

## Root cause

`postLanFirstKitchenTicket` uses `LAN_FIRST_DEFAULT_TIMEOUT_MS = 2000` (2s). A
thermal kitchen-ticket print over LAN takes longer than 2s, so the client's
`fetch` aborts (timeout) **after the receiver already printed**. The `catch`
branch returned `FALLBACK: 'LAN_NETWORK_ERROR'`, which makes the orchestrator call
the backend `dispatch` fallback → backend emits `job:new` → the agent prints the
SAME ticket a second time.

Timeline for K-002 confirms it: reserve `14:58:39` → dispatch `14:58:41` = exactly
the 2000ms timeout.

The design already distinguishes `UNCERTAIN_AFTER_PRINT` (→ no fallback) from
`SAFE_BEFORE_PRINT` (→ fallback) **when the receiver replies**. The gap: a
timeout / lost response / HTTP error is treated as a *safe* fallback, when it is
actually *uncertain* (the print may have happened).

## Fix (A + B + slip-on-uncertain)

**A — Only fall back when we are confident the receiver did NOT print.**
Reclassify `postLanFirstKitchenTicket` so ambiguous outcomes are
`FAILED_NO_FALLBACK` (no dispatch, no double) instead of `FALLBACK`:

| Receiver outcome | action | dispatch? | uncertain? |
|---|---|---|---|
| status COMPLETED / PRINTING | ACCEPTED | no | — (printed) |
| failureClass SAFE_BEFORE_PRINT | FALLBACK | yes | — |
| error LEDGER_NOT_DURABLE | FALLBACK | yes | — |
| failureClass UNCERTAIN_AFTER_PRINT | FAILED_NO_FALLBACK | no | **yes** |
| failureClass FINAL | FAILED_NO_FALLBACK | no | no |
| `!response.ok` (no failureClass) | FAILED_NO_FALLBACK | no | **yes** |
| unexpected response shape | FAILED_NO_FALLBACK | no | **yes** |
| catch: AbortError (timeout) | FAILED_NO_FALLBACK | no | **yes** |
| catch: ECONNREFUSED/ENOTFOUND/EHOSTUNREACH | FALLBACK | yes | — |
| catch: other | FAILED_NO_FALLBACK | no | **yes** |

Only `SAFE_BEFORE_PRINT`, `LEDGER_NOT_DURABLE`, and a true connection-refused
(receiver never reached) are safe to dispatch. Everything else → no dispatch.

**B — Raise the LAN timeout 2000 → 6000ms.** Covers a normal thermal LAN print
(~2–4s) so it returns a clean `ACCEPTED` instead of timing out. 6000 (not 8000) so
the worst-case customer wait stays bounded. Normal prints return as soon as the
receiver replies — the timeout is only a ceiling, it does not slow the happy path.

**slip-on-uncertain — the customer always gets the pickup slip.**
The customer slip is printed *sequentially after* the kitchen ticket and only when
`kitchenPrint.printed` is true (pos.module). With A, a timeout makes
`printed=false`, which would SKIP the slip → the customer gets no pickup number.
So: when the kitchen result is **uncertain** (timed out / lost response — the
ticket most likely printed), still print the slip and treat the kitchen as
released. Genuine `FINAL` failures stay `uncertain=false` → no slip (the kitchen
really did not get it; staff handles it).

### Trade-off (rare slow-print case only)
- Normal (<6s print): unchanged — slip prints right after, no double.
- Slow/hung (>6s): customer waits ≤6s, **no double**, **slip still prints** (uncertain).
- Genuine receiver-down (ECONNREFUSED): safe fallback → backend dispatch prints once.

## Files changed

### `src/main/printing/shared-kitchen-printer.ts`
- `LAN_FIRST_DEFAULT_TIMEOUT_MS = 2000` → `6000`.
- `SharedKitchenPrintResult`: add `uncertain?: boolean`.
- Extract two pure classifiers (testable without `fetch`):
  - `classifyLanPrintResponse({ status, failureClass, error, responseOk })`
  - `classifyLanPrintError(err)` (AbortError/timeout → uncertain; connection-refused → safe fallback)
- `postLanFirstKitchenTicket` delegates its decision to the classifiers; the
  `FAILED_NO_FALLBACK` variant carries `uncertain`.
- The orchestrator's `FAILED_NO_FALLBACK` return threads `uncertain` into
  `SharedKitchenPrintResult`.

### `src/main/modules/pos.module.ts`
- `printKitchenSelfOrderTicket`: propagate `uncertain` on the not-printed return.
- Self-order submit flow: `kitchenReleased = kitchenPrint.printed || kitchenPrint.uncertain`;
  use it for the slip gate and the QR `kitchenAlreadyReleased`. `kitchenPrinted`
  recorded in the DB stays `kitchenPrint.printed` (confirmed only).

## Tests (TDD)
New `tests/lan-first-print-classifier.test.ts`:
- `classifyLanPrintResponse`: COMPLETED→ACCEPTED; SAFE_BEFORE_PRINT→FALLBACK;
  UNCERTAIN_AFTER_PRINT→FAILED_NO_FALLBACK+uncertain; FINAL→FAILED_NO_FALLBACK no-uncertain;
  !ok→FAILED_NO_FALLBACK+uncertain; unexpected→FAILED_NO_FALLBACK+uncertain.
- `classifyLanPrintError`: AbortError→FAILED_NO_FALLBACK+uncertain;
  ECONNREFUSED→FALLBACK; generic→FAILED_NO_FALLBACK+uncertain.
- Assert `LAN_FIRST_DEFAULT_TIMEOUT_MS === 6000`.

## Verify
- `npm run build:main` passes.
- `npx vitest run tests/lan-first-print-classifier.test.ts` green.
- On-machine: place a self-order; kitchen ticket prints **once** via LAN; customer
  slip still prints; no `LAN_FIRST reserve failed` and no second `job:new` dispatch
  (backend `sent_at` stays null for LAN-accepted jobs).

## Out of scope
- Cross-channel dedup on the agent socket-print path (option C) — deferred; A+B
  removes the timeout-induced double which is the observed cause.
