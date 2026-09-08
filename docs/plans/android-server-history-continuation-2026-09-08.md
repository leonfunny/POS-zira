# Android server history continuation

## Requirements and scope

User requested continuing Android/Windows parity. Staff must see authenticated server order history and explicitly cache an order for later detail, without changing this independent register's current sale, shift, stock, pending uploads or local order identity. Preserve restaurant exact-line provenance from the preceding slice. No backend deploy, native install, real refund/payment or print.

## Design and trade-offs

- Extract the existing Windows server adapter into a portable shared module; keep Windows logging through a compatibility wrapper. Do not duplicate or redesign money conversion for Android. Shared code must import no Electron/Node module.
- Reuse GET POS orders and existing cash/invoiced detail routes. List remains read-only/transient; only explicit mirror persists to Android SQLite. This avoids copying another register's active state and avoids an unbounded history sync.
- Mirror rows are SERVER, synced, with backend identity and original dates, but no local shift. Existing local orders matched by local ID or backend ID win unchanged. Validate item ownership/provenance, use one transaction, await durable flush and surface failures. No new schema needed beyond schema 8.
- Capture user, salon, server and auth context for asynchronous operations; reject stale results after logout/context changes before returning data or writing. Distinguish empty success from network failure/unconfigured session.
- Do not enable authoritative refund UI while Android refund execution still passes unconverted renderer amounts and lacks financial response/replay safeguards. Review that path separately before connecting getRefundDetail. Keeping it unavailable is a temporary safety gate, not completed parity.
- Parent fixes shared UI selection races for mirror/refund-detail: response for an old selection must neither replace the current detail nor open the wrong refund dialog. Existing i18n labels suffice; no theme redesign.

## Ownership / file map

1. Client agent: shared adapter + Windows wrapper, Android order-repo upsert and dedicated import tests/report.
2. Native agent: Android API detail method, history transport, namespace/interface wiring and history tests/report. No refund execution changes.
3. Backend agent: read-only refund authority/contract review and report, no runtime changes.
4. Parent: this plan, OrderHistoryModal, restaurant-history-ui tests, independent integration/build gates and final report.

## Risks and verification

- HIGH wrong tenant or stale staff response: switch auth during list/detail/flush; no stale return or write.
- HIGH local data overwritten/re-uploaded: local ID/backend-ID collision, pending/frozen local rows, SERVER synced flags, unchanged stock/shift/sequence.
- HIGH financial regression: shared adapter equivalence, existing Windows refund/money tests; do not infer fiscal evidence or unlock unsafe Android refund.
- MEDIUM missing metadata/duplicates: exact item IDs, repeated products/reversed order, malformed batch, SQLite export/reopen, transaction/flush failure.
- MEDIUM UI race: defer mirror/refund response while switching selected order; no wrong detail/dialog/error.

Build Windows and Android web/sync/boundary after agents freeze. Unit and SQL.js tests are not native device acceptance; existing APK is stale. Previous backend full typecheck was independently rerun and passed, alongside 147 backend tests and 476 POS tests for the preceding line-identity slice.

## Completed implementation and parent gate

- Shared `pos-order-adapter.ts` is now the single money/history mapper for both platforms; Windows wrapper retains platform logging and existing exports. No financial algorithm rewrite.
- Android list/mirror namespace delegates to real authenticated transport. Validates order/item ownership and requested ID; 404-only alternate detail lookup; explicit empty/network/unconfigured outcomes. Config snapshot identity plus user/salon/server/token fences reject stale and switch-away/back responses. Token refresh invalidates the old read; a fresh read succeeds with refreshed credentials. This conservative behavior also rejects an unrelated config edit during the request.
- Explicit SQLite history mirror preserves local/pending/frozen rows found by ID or backend ID. New SERVER rows are synced and detached from local shifts; no upload, stock, check or sequence effects. Exact line metadata survives export/reopen. Existing SERVER imports repair metadata only; they do not reconcile remote financial/refund changes. Billiard import is explicitly unsupported with current schema, rather than discarding required policy fields.
- Shared UI now ignores stale mirror/refund-detail responses, errors and old selection closures. Mirroring into a preserved local ID or a different refund state displays fresh detail first and does not continue a stale print/refund action. Local history failure without a server result is displayed as an error, not “no orders”.
- Parent added a safety gate after source assessment: `getHistory({fiscalOnly:true})` explicitly throws an unsupported error with guidance to enable non-fiscal history in Settings. Android schema8 has no durable confirmed fiscal-attempt journal. No prefix/payment/source is treated as proof and no user config is auto-changed. With default `showNonFiscalOrders:false`, history therefore shows this explanation until all-order history is enabled; fiscal-only parity remains open. The separate INVOICE filter contract is also still incomplete.
- Parent independently ran 42 suites: 544 PASS / 1 temporarily skipped while the Android build output was being replaced. After both final builds completed, reran `android-stage2-catalog` with all 3 tests PASS, including the skipped bundle check: **545 distinct tests verified**. Agent test totals overlap and are not added. Shared history UI now has 28 tests, new history transport31, repo18, shared adapter5, fiscal filter1. UI stale success/failure/mirror and preserved-order action regressions, plus the fiscal-filter regression, were observed failing before fixes.
- Final `npm run build` PASS (renderer typecheck/main compile/Windows renderer). Final `npm run android:sync` PASS (153 source files, 5 built bundle files, 7 copied native-asset files). `git diff --check` PASS. Existing bundle-size/Browserslist/sql.js browser warnings remain. No native APK build or live endpoint/device acceptance in this continuation.

## Next financial slice and release boundary

Read-only audit in `android-refund-authority-review-2026-09-08.md` found Android refund amounts forwarded in grosze instead of PLN, guessed success/cumulative amounts, missing durable retry/context protection and overwritten partial-refund lines. Shared Windows/UI also loses exact item IDs for duplicate products. Existing backend supports exact `items[].orderItemId` and payload-checked idempotency; a new endpoint is not needed.

Do NOT unlock Android getRefundDetail/execute path merely because history loading now works. Next implementation should retain exact server IDs end-to-end, normalize units once, persist immutable refund attempts/reconciliation, validate responses and merge audit idempotently before enabling mutation. Unsupported refund printing remains blocked, not redirected to sale printing. Existing direct Android refund tests encode old behavior and their PASS is NOT evidence those financial blockers are fixed.

No commit, land, production deployment, real payment/print, installed DB mutation, signing or device installation. Backend line-identity change remains unlanded in the DEV worktree; old canonical release manifest and APK do not contain this continuation. Overall Android/Windows parity and production readiness remain incomplete.
