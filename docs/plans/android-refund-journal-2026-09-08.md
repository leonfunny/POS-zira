# Android durable refund journal — 2026-09-08

## Current result

Android schema **9**, synchronous immutable attempt repository and tenant-clear guard implemented. **84/84 tests passed across 5 suites**, including **24 journal tests**. The journal never sends a refund or auto-flushes; parent-owned transport must enforce authorization, validate exact server response and cross the durability barriers. No native build, installed database or production action performed.

## Design before implementation

Requirement: independently selling Android POS must preserve an immutable refund request and expected reconciliation facts across process restart. OWNER/MANAGER execution is owned by the transport/backend; this journal does not grant permission or send/refund/print anything. Unknown outcomes must prevent another request against the same order and must not disappear on tenant clear.

Add Android schema 9 table `pos_refund_attempts`: request_id primary key, scope_key (server/salon/user identity, never tokens), local_order_id, backend_order_id, nullable shift_id, payload_json, expected_json, status, response_json, error, created_at, updated_at. States are PREPARED/UNKNOWN/CONFIRMED/REJECTED. Immutable fields compare byte-for-byte on an existing request ID. No foreign-key cascade: order deletion must not erase unresolved evidence. Partial unique indexes lock both local_order_id and backend_order_id for unresolved states, including aliases. Old orders are unchanged and no attempts are fabricated.

Use existing synchronous SQL.js `AndroidDatabase.transaction` to make the local refund projection and journal confirmation one transaction. `confirmAndApply` invokes the caller's synchronous callback only once, then marks CONFIRMED; rollback restores both on callback failure. An already-confirmed identical response is a no-op; a different response is rejected, not overwritten. PREPARED/UNKNOWN can become REJECTED only when the caller has authoritative rejection evidence. Scope/auth/financial response validation and flush barriers remain parent-owned.

Tradeoffs: a journal plus partial unique index is stronger than in-memory locks and survives restart. Global local/backend order locks deliberately prevent a new user/scope from bypassing an unresolved attempt. Frozen JSON is opaque to this repository except syntactic object validation; the transport owns the exact totals/quantities/line IDs. No automatic retries, flushes, network, timestamps inferred from sale records, or cleanup of unresolved attempts.

## File impact

- `src/renderer/android-pos/shim/db/schema.ts`: additive journal table/indexes, version 9.
- New `src/renderer/android-pos/shim/db/refund-attempt-repo.ts`: typed synchronous transitions and immutable-request checks.
- `src/renderer/android-pos/shim/db/db.ts`: only tenant-clear precondition and terminal-journal cleanup alongside old tenant data.
- New `tests/android-refund-attempt-repo.test.ts`: synthetic persistence/transition/migration/clear tests.
- Schema-version expectations only in `tests/android-shim-db.test.ts`, `tests/android-order-repo-safety.test.ts`, `tests/restaurant-line-provenance-migration.test.ts`.
- This plan/result report. Parent owns real transport/API/stubs/refund order repository; client owns shared refund helpers/UI. Preserve all their edits.

## Repository API

`createRefundAttemptRepo(database)` returns `get(requestId)`, `findUnresolved(localOrderId)`, `prepare(record)`, `markUnknown(requestId,error?)`, `markRejected(requestId,error?,responseJson?)`, `confirmAndApply(requestId,responseJson,apply)`.

`record` has required request_id/scope_key/local_order_id/backend_order_id/payload_json/expected_json and shift_id:string|null. Prepare returns the stored row; confirmation returns `{applied:boolean}`. Missing IDs, immutable mismatch, different unresolved request and invalid transition fail explicitly. No method auto-flushes. Parent must flush PREPARED before dispatch and confirmed mutation afterward; a failed durability barrier is not permission to send/reapply.

## Safety acceptance / execution order

Add focused tests first; implement additive schema/repo/clear guard; verify fresh v9, v8 upgrade and reopen, exact existing fields preserved, prepare idempotency/mismatch on every frozen field, unresolved request/alias lock, terminal transitions, callback once and rollback, failed flush/reload recovery, unresolved tenant-clear refusal and terminal cleanup. Read-only graph discovery and coverage plus direct source fallback precede edits. No installed database, native build/APK, production operation, real payment/printing/network write or commit.

Tier 2 graph supplied generation `2026-09-08T08:50:16Z`; source schema/database metadata changed, test coverage excluded/new. Current direct reads of schema/apply and DB transaction/flush/clear provide evidence. This journal alone is not full refund financial parity or native-device acceptance.

## Implemented details and checks

- Global unresolved unique indexes on local and backend order IDs prevent user/scope or local-alias bypass. `findUnresolved` takes the local ID; `prepare` additionally checks either ID, then the SQL unique constraints enforce it. Existing terminal attempts can be read/prepared identically but cannot be reopened.
- `markUnknown` and `markRejected` accept only PREPARED/UNKNOWN. `confirmAndApply` uses one existing DB transaction for callback plus CONFIRMED; the callback must not start a nested transaction. Async functions/thenable returns are rejected. Identical repeated confirmation returns `{applied:false}`, and changed response bytes fail explicitly. This is local exactly-once projection, not proof of server exactly-once execution.
- JSON objects are validated syntactically but preserved byte-for-byte. No matching by name/variant/quantity and no mutable reconstruction of expected financial facts occurs in this repo. All seven immutable fields compare exactly on repeated request ID.
- `clearSalonData` checks unresolved rows inside its transaction before any deletion, then removes only an all-terminal journal alongside old tenant rows. No FK cascade can remove attempts with an order delete. Ordinary logout is not modified here and retains the DB; parent controls logout execution policy.
- Test command: `npx vitest run tests/android-refund-attempt-repo.test.ts tests/android-shim-db.test.ts tests/android-order-repo-safety.test.ts tests/restaurant-line-provenance-migration.test.ts tests/android-real-transport.test.ts` — **84/84**, 5/5 suites (24+20+4+4+32).
- Tests cover fresh schema/reapply, an isolated v8 image upgrade preserving all original order/item columns and snapshot JSON, UNKNOWN persistence/reopen, immutable field and byte mismatch, two repository callers and raw SQL duplicate constraints, terminal transition rejection, callback once, callback rollback, async callback refusal, failed confirmation flush followed by reopening the durable PREPARED image and applying once, unresolved clear refusal and terminal cleanup.
- Initial red gate failed because the new repository module did not exist. All test network is mocked and SQL.js persistence is in memory. Failed flush retains an uncertain durability outcome: callers must not dispatch or claim persisted success until their explicit barrier completes. Native storage guarantees require later device acceptance.
- `npm run typecheck:renderer` — PASS; owned existing-file `git diff --check` — PASS; Android source boundary — PASS (153 entry-reachable files). The new repository is pending parent transport wiring at this point, so repeat the boundary check after integration rather than assuming the earlier traversal included it.
