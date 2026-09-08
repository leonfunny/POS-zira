# Android server history import

## Requirements and architecture

Explicitly requested server history must be readable on an independent Android register without creating a sale, altering stock, opening/closing a shift/check, incrementing document counters or entering the upload queue. Windows remains the source of truth for adaptation of prices, taxes, refunds, tenders and restaurant identity links.

Move existing pure adapter logic without financial changes into `src/shared/pos-order-adapter.ts`. Its optional warning callback accepts missing-field notifications without importing Node/Electron. Keep the Windows path as a backward-compatible logger wrapper and named re-exports; its per-field warnOnce behavior remains unchanged.

Add synchronous `createOrderRepo(db).upsertFromServer(adaptedOrder, items): {inserted, localOrderId}`. Parent/native task validates auth/tenant/server context and raw response identity/date before calling it and awaits db.flush afterward. No async gaps occur within repository mutation. Existing local, pending or frozen rows found by ID **or backend_id** are returned untouched. Ambiguous ownership is rejected, never overwritten.

New imports: source SERVER, synced 1, backend_id set, shift_id NULL, original creation date and validated shared-adapter money/refund fields. Do not call create(), stock mutation, counter, shift, check, kitchen or upload paths. Same-ID existing SERVER mirrors receive proven header/line repair only, preserving existing monetary/refund data against stale history responses. SourceSERVER shift_id is cleared to keep foreign sales out of the local register's shift report.

Every item must have explicit unique ID, matching order ID, finite validated money/quantity and no ownership collision with another order. Inserts/repair run in one SQLite transaction. Proven restaurant lines require the shared identity-checked adapter plus a full revalidated adapted batch; unmatched/legacy data acquires no marker. Conflicting existing localLineId provenance is not rebound.

## Trade-offs and risks

- Reuse a single pure adapter instead of copying financial normalization into Android. Windows logging stays platform-specific.
- Preserve existing local/pending/frozen records even when backend has a different snapshot; history import is not reconciliation or a payment command.
- Schema8 has no Billiard origin/refund-policy columns. Imports containing that unsupported metadata must fail explicitly rather than erase safeguards; shared adapter still preserves full Windows Billiard behavior. No schema changes in this task.
- HTTP missing timestamp must be rejected before adaptation because Windows legacy adapter deliberately supplies a fallback date. Repo independently checks final timestamp validity.
- HIGH tenant/state risk: authenticated scope checked in transport; repository never queries network or claims tenant authorization.
- HIGH financial corruption: validate finite integer monetary rows; rollback all partial writes; no foreign item-ID overwrite.
- HIGH duplicate accounting: imported shift always NULL; synced1/sourceSERVER excludes upload/sale creation.

## File impact and verification

- CREATE shared adapter, `tests/shared-pos-order-adapter.test.ts`, `tests/android-server-history-repo.test.ts`.
- MODIFY Windows adapter wrapper and Android order repo only.
- Native agent owns real transport/API/interface and related tests; parent owns refund followup. No migrations, signing, deployment, APK or hardware actions.
- Test shared/Windows equivalence (retail net/gross/weighted/refund/Billiard/restaurant), actual SQLite import/export/reopen, current-shift isolation, ownership collision, local ID/backend-ID protection, pending protection, malformed data, linked provenance repair and transaction rollback. Run Windows adapter/regression suites and main/renderer typechecks.

Evidence tier2 graph generation08:50:16 marks source metadata_changed; new shared file untracked and tests excluded. Exact adapter source and repository create/get/mark/history/schema boundaries were read directly before changes.

## Verification result (2026-09-08)

Source extraction/import frozen for parent integration. Seven focused suites pass, 103 tests: Android server cache18, shared adapter5, existing Windows adapter18, Windows upsert17, restaurant parser35, actual Windows roundtrip6, Android repository safety4. Main and renderer no-emit typechecks pass; Android source boundary scan passes153 files; git diff check passes.

The new real SQLite tests verify duplicate-product exact links after export/reopen, local ID/backend alias and pending/frozen preservation, foreign item rejection, malformed batch fail-closed, immutable accounting/refund snapshots during metadata repair, conflicting-provenance preservation, transaction rollback and failed persistence/retry. A successful synchronous upsert is explicitly not durable success until transport flush resolves.

Fiscal filtering followup is parent-owned: schema8 has no durable fiscal/invoice evidence, and the previous getHistory ignores fiscalOnly and treats INVOICE as a payment method. Neither POS number prefix nor customer NIP proves a fiscal receipt/invoice. Parent will surface unsupported fiscal-only filtering rather than expose non-fiscal cache rows or invent fiscal provenance. No fiscal schema, remote printing or markRefunded change is included here.

Remaining limits: Billiard import is explicitly unsupported; old server mirrors keep their accounting/refund facts rather than reconciling newer remote refunds; missing raw server IDs/timestamps must be rejected by transport before legacy adapter fallbacks. No production, device or hardware verification is claimed.
