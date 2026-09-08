# R2: Android/Windows restaurant metadata upload

## Requirements and design

Staff/owners using either independent register must upload table/covers and each line's immutable local identity, notes and course with the same v1 contract. Financial DTO mapping stays unchanged. Backend work is owned by the separate backend task.

Both platforms use a browser-safe shared mapper and snapshot preparer. Before the first HTTP POST, serialize the complete DTO into `orders.sync_payload_json` together with salon ID and server URL, and await durable persistence. Retries use that exact snapshot, including after process restart, manual retry, or capability changes. Snapshot corruption or scope mismatch blocks sending. Session identity is rechecked after every preparation await and before POST.

GET `/api/v1/b2b/pos/capabilities`: only explicit v1 enables metadata; 404 means legacy server. Auth/network/malformed responses block, not downgrade. No cross-session capability cache. Migration adds `sync_metadata_eligible INTEGER NOT NULL DEFAULT 0`; locally created orders set 1. Old rows keep legacy DTO shape even if their attempt counter was reset. Existing snapshots are never enriched or replaced.

Trade-off: old pending orders lose no locally retained metadata but cannot retrospectively add it to a possibly accepted remote request. This conservative migration avoids idempotency conflicts. Optional tableName is omitted unless a historical immutable name is already available; never look up a possibly renamed table during retry.

## File impact

- Create `src/shared/restaurant-order-upload.ts`, shared strict mapper/snapshot preparation and additive column SQL.
- Modify Windows `src/main/database/migrations.ts`, `repos/order-repo.ts`, `src/main/network/api-client.ts`, `src/main/sync/order-sync.ts`.
- Modify Android `src/renderer/android-pos/shim/db/schema.ts`, `db/order-repo.ts`, `shim/real-transport.ts`, `port/api-client.ts`.
- Add `tests/restaurant-order-upload.test.ts`; extend Windows/Android sync and migration tests.

## Risks and gates

- HIGH duplicate acceptance/changed hash: persist before POST, never recreate existing snapshot.
- HIGH disk failure: no POST before durability; poison current uploader until restart after uncertain disk write; no success notification before durable accepted-state write.
- HIGH tenant leak: snapshot bound to salon/server, session checked across awaits. Backend still owns authorization.
- MED legacy API: explicit 404 only; no automatic retry with reduced payload after a rejection.
- LOW migration: additive columns only, old orders/items/shifts unchanged, eligibility default 0.

Implementation order: shared mapper tests → migrations/repos → platform capability ports and upload adapters → negative tests/typechecks. No commit/deploy/package/hardware actions in this subtask.

## Implementation and verification, 08/09/2026

- Windows migration 68 / Android schema 7 implemented additively; local creation opts into metadata; migrated rows remain legacy.
- Full DTO snapshot is bound to actual server URL + salon. Windows refuses stale config URL versus its API singleton; Android also rechecks active user. A late response after identity change aborts without catch-path writes/events.
- Each batch row is reread immediately before preparation. Existing `synced=2` edit/delete guard is acquired before capability I/O. Frozen uncertain rows reject local edits/deletions rather than diverging from the remotely accepted request.
- Capability ports are explicit on both API clients. v1 metadata mapping is shared; no changes to financial conversion or tax/discount/tender algorithms.
- Added shared mapper tests, real Android SQL.js/persistence/HTTP tests, Windows upload tests and mutation guards. New tests cover lost replies/reload, v1→legacy downgrade between retries, legacy migration, storage failure before and after POST, late tenant reply, stale API destination, concurrent local edits/deletes and later-batch stale rows.
- Validation: main and renderer TypeScript checks pass. Six focused suites passed 76 tests before the final Windows later-batch regression addition; eleven adjacent suites passed 137 tests. Final rerun count is recorded in task handoff.
- Graph generation `2026-09-08T08:26:32Z`: modified/new paths stale or untracked, tests excluded by fast-pattern; implementation verified against exact current source and direct tests rather than claiming complete graph coverage.

Remaining release limits: this is upload metadata parity, not kitchen/pickup/native hardware acceptance. tableName is optional and omitted because legacy local order rows have no immutable historical name. Pre-upgrade attempts have no recoverable exact historical wire snapshot; their legacy shape is frozen on first upload by this version without adding metadata. No production calls, commits, deploys or APK installs were performed by this subtask.
