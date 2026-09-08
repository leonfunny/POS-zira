# Server change request: refund-event shift and tender accounting

Status: V1 BACKEND IMPLEMENTED AND TESTED IN DEV WORKTREE. Not committed/landed/deployed, not enabled in Android. Keep Android same-shift/single-tender restrictions until its canonical-event projection/migration and device binding are implemented. Historical design/review notes below record the preceding blocked stage.

## DEV implementation result

- Existing `GET /api/v1/b2b/pos/capabilities` now advertises additive `refundEventVersion: 1`, retaining restaurantMetadataVersion1. Existing refund POST accepts explicit opt-in; legacy clients/replays are not upgraded implicitly.
- V1 requires OWNER/MANAGER token role, original operator for replay, a stable request UUID, exact item IDs and a same-salon open refund shift bound to declared machineId. Sale must be PAID and DELIVERED/APPROVED/PARTIAL_REFUND. Ordinary PLN only, no tip/header/item discounts/manual adjustment; canonical original gross line sum must equal order total EXACTLY in grosze (even an unexplained one-grosz difference is refused).
- Canonical event is saved in the existing refund response JSON in the same transaction as the financial change. Exact per-method cents must sum to authoritative delta and fit remaining original tender capacity. Ambiguous duplicate tender rows or prior legacy refunds without canonical attribution fail closed. No migration/backfill/dependency added.
- New request locks order then shift. Shift close uses an explicit READ COMMITTED transaction, takes the same shift lock, reads stats and saves using that transaction's manager; event emitted after commit. Confirmed same-ID replay validates original scope and returns before open-shift checks, including an in-transaction concurrent-replay branch.
- Shared shift/day/sales-report SQL consumes complete canonical allocations without proportional recalculation; malformed canonical evidence fails the whole report, never silently drops a line or enters legacy fallback. Date reports retain their prior date semantics; shift reports use canonical refund-shift identity independent of ledger timestamp. Legacy reports retain their existing explicitly noncanonical behavior.

### Parent verification (final frozen source)

- One independent run: **16 suites / 284 tests PASS**, including **24 PostgreSQL tests** executing all three report callers against synthetic session-local fixtures and both two-session row-lock orderings. This is real PostgreSQL SQL/protocol testing plus service unit tests, NOT full live Nest HTTP refund/close E2E or hardware acceptance.
- Independent in-memory mutation probe detected removal of each of three financial guards: allocation sum, per-tender capacity, closed shift. Valid event/history and role boundary checks passed. Probe never edits runtime files; initial probe fixture needed its missing status field corrected to match the canonical response contract.
- Full backend baseline typecheck passed; current code compiled with TypeScript and alias resolution to isolated `/var/tmp/zira-refund-parent-verify-20260908.kjriXl/dist`, not live dist. The output is compiler evidence, not a complete deploy package with runtime assets.
- Parent checked `git diff --check` and independently queried scratch schema count: **0**. The PostgreSQL tests removed only their own synthetic schemas/tables; no business rows were changed. No live payment/refund, PM2 restart, production operation or APK build.
- Main/worker source hashes independently checked: service `766451bfc4ef704d9798c57e1f7ab7ae4939026b79cf0bc1e3b4c9105152a509`; helper `b7941218b02848928690a76f8bb9f1b27c666ab95d0a45348773e8af34f5e93d`; controller `0925a717203bf7294453c7e95991ff3397ebb84126af4c815fef7482829372e1`; shift `042f8f1ddbd4becf1f08f411df06629e6b3b716247300d5d8462c46dd5cf79ca`; SQL `6b309ad32c4354208cecc220e4af84f9ae4b4676ad076ab434580c1fd647c5f0`.

### Exact backend scope

Modified: `src/modules/b2b/services/b2b-pos.service.ts`, `src/modules/b2b/dto/refund-pos-order.dto.ts`, `src/modules/b2b/controllers/b2b-pos.controller.ts`, `src/modules/b2b/services/pos-shift.service.ts`, `src/modules/b2b/sql/pos-refund-accounting.sql.ts`, exact response projections/predicates in `src/modules/reports/reports.service.ts` and `src/modules/analytics/analytics.service.ts`, and `test/unit/pos-shift-refund-accounting.service.spec.ts`.

Created: `src/modules/b2b/services/pos-refund-event.ts`, `src/modules/b2b/__tests__/pos-refund-event.spec.ts`, `src/modules/b2b/__tests__/refund-event.service.spec.ts`, `test/unit/pos-refund-accounting-postgres.spec.ts`. Paths in this paragraph are relative to backend. Prior restaurant line-identity WIP is preserved, not counted as this refund-event implementation.

### Next gate

Android still calls the legacy protocol. Implement explicit server capability validation, durable machine/shift binding and immutable local event accounting before opting in or removing existing restrictions. Decide the v10 legacy baseline/report snapshot migration without guessed history. A new read-only server event-history surface is not included here; known requests recover through existing cached replay. Native integration, DEV preview acceptance, landing and guarded production promotion remain separate unfinished gates. V1 does not retroactively cure legacy-client financial weaknesses.

## Approved DEV implementation — subsequent turn

User approved backend work. Resume existing Netcup worktree `android-pos-restaurant-parity-20260908` at c6576a51; preserve unrelated/previous restaurant identity WIP. No production, PM2 or payment requests. Parent read design-reasoning, netcup, backend AGENTS, codemap and schema-introspect; MCP transport unavailable and graft has no graph for this worktree, so current source is required.

- Versioned opt-in: `refundEventVersion: 1`. Existing requests and replay payloads retain legacy behavior; this does not retroactively fix legacy accounting and must not be presented as a global safety guarantee.
- V1 requires stable UUID, exact ordinary item IDs, authenticated OWNER/MANAGER, declared machine identity matching a same-salon open shift. Machine ID is a binding check, not cryptographic device authentication. No staff ownership inference from sale/shift staffId.
- Persist/return `refundEvent` in existing response_payload JSON: schemaVersion, refundRequestId, orderId, salonId, shiftId, machineId, operatorId, occurredAt, deltaAmountMinor and exact tenderAllocations(method, amountMinor). No migration or historical backfill.
- V1 rejects legacy prior refunds without canonical tender attribution, mixed pricing/fees/tips/discounts/Billiard, unbalanced original tenders, and invalid or excessive per-tender allocations. Replay comparison includes new version/machine fields; committed replay precedes new-open-shift validation.
- Order lock then refund-shift lock; shift closure takes the same shift-row lock and calculates/saves its snapshot in one transaction. Canonical report attribution uses event.shiftId; legacy records remain in disclosed fallback.
- Backend agent owns service, DTO/controller, pure helper and focused tests. Native-readiness agent owns shift closure/report SQL and all three report callers/tests after explicit coordination. Parent owns design notes, independent review/test verification. No Android gate removal in this backend-only slice.
- File impact: b2b-pos.service.ts, refund-pos-order.dto.ts, b2b-pos.controller.ts, new canonical-event helper/tests, pos-shift.service.ts, pos-refund-accounting.sql.ts, reports.service.ts, analytics.service.ts and focused refund/shift/report tests. Exact helper/test names recorded in final evidence.

Acceptance and risks below still apply; actual PostgreSQL race tests are needed beyond mocked transaction order before claiming race acceptance. Legacy compatibility and opt-in failures must be tested independently.

### Independent baseline and build safety

Parent ran five existing backend suites before refund-event transfer: refund-order.service, pos-refund-accounting-sql, pos-shift-refund-accounting.service, reports-refund-accounting.service and analytics-daily-close-refund.service. 42 tests passed. Default Node 4GB test run exhausted heap; retry with task-local NODE_OPTIONS=--max-old-space-size=12288 passed (no system setting change). Full backend `npm run typecheck` also passed at this baseline.

Do not use `fast-build.sh --no-stop` here: inspection shows its backend path still stops the local backend and later restarts it. This slice uses worktree-only typecheck/isolated compilation to avoid disturbing another task's DEV preview. No change to build scripts or PM2.

Client compatibility audit: Windows already sends items/shiftId/tenderAllocations but remains legacy; these fields cannot identify v1. Android does not yet bind machineId at client construction/openShift. Keep both callers unchanged until explicit capability/version integration. Existing tiny split-refund rounding can exceed the requested total (four equal tenders, two-grosz refund); v1 must reject such input, never silently rescale it. Canonical validation does not fix legacy clients automatically.

## 1. Requirements

- What: eventually refund an ordinary sale from an older shift and support split payment without corrupting current-shift cash reconciliation.
- Why: Android currently subtracts cumulative order refunds from the sale's shift. A refund is a separate event belonging to the shift in which it is processed, not necessarily the sale shift.
- Who: OWNER/MANAGER, always scoped to authenticated salon; STAFF remains read-only for refunds.
- Where: backend authoritative refund ledger and shift reporting first; Android journal/accounting second. Audit Windows against the same contract; parity must not reproduce accounting bugs.
- Scope excludes discounts/tips/fees, Billiard, external payment execution, printing and production promotion.

## 2. Evidence and decision

Tier 2 intent; graph list_projects failed with `Transport closed`. Exact local source fallback used: Android `shim/db/order-repo.ts::closeShift`, `shim/db/refund-attempt-repo.ts::confirmAndApply`, `shim/refund-coordinator.ts::supportedOrder/run`, shared `shift-accounting.ts` and `refund-backend-payload.ts`.

Android closeShift reads orders by sale shift, sums cumulative refund_amount, and proportionally subtracts that cumulative amount from original tenders. It does not read refund journal shift_id. Proportional rounding of a cumulative amount can differ from the sum of individually rounded partial-refund events.

Backend subagent's bounded read-only review of DEV source at c6576a518311b81171d566c4c919f7e2355bce85 found refund request shift/tender metadata is persisted and consumed by server shift reporting, but lacks the required authoritative shift/allocation validation and response fields. This is not a claim about current deployed production bytes.

Pinned backend evidence (paths relative to `backend/src/modules/b2b/`):

- `services/b2b-pos.service.ts`: refundOrder2637, raw tender logging2653–2659, response3230–3240 omits canonical shift/tenders, ledger3246–3252 persists raw request and response, post-commit event3277–3293 echoes requested metadata.
- `dto/refund-pos-order.dto.ts`: tender method is arbitrary string and positive amount73–80; shiftId is UUID-only140–143; response198–208 has no canonical shift/tenders.
- `services/pos-shift.service.ts`: close99–125 has no shared refund-shift lock; stats248–278 combines event creation window and requested shift attribution. A request for an already closed known shift can be omitted from both old and current reports.
- `sql/pos-refund-accounting.sql.ts`: requested weights63–82 are rescaled to the authoritative delta102, with original-tender fallback112 and UNKNOWN122. This is not validation of exact per-event cent allocations or remaining refundable tender balance.
- `entities/b2b-pos-refund-request.entity.ts`: existing request_payload/response_payload JSON can potentially carry a versioned event; choosing typed columns/indexes would require a separately designed migration.

Per repository instruction, stop runtime coding when completion requires server behavior outside this repository. Do not construct a client-only ledger from unverified request metadata and advertise it as canonical.

## 3. Requested backend contract

1. Before a NEW refund commits, verify the requested refund shift belongs to authenticated salon, is open, and is permitted for this operator/device under explicit business policy. The original sale may belong to an older shift. Lock/serialize refund and shift closure so closure cannot race validation.
2. Compute canonical refund delta from exact order-item identities as today. Validate allocation methods, nonnegative exact currency amounts, allocation sum equals canonical delta, and prior per-tender refunds cannot exceed refundable original allocations. Define deterministic residual rounding for successive partial refunds. Never treat renderer totals as authority.
3. Atomically persist a versioned immutable refund event: request/order/salon identity, refund shift, delta, exact tender allocations and canonical response. Replay the SAME request from the original authenticated scope without creating a second event. A confirmed cached replay must remain retrievable after its shift closes; a new request for that closed shift must fail. Changed payload under the same key must still fail.
4. Return canonical event identity, refund shift and tender allocations in addition to current delta/cumulative/line fields. Extend capabilities or version the response so Android refuses unsupported contracts rather than inferring support from HTTP 200.
5. Shift reports must aggregate canonical events by REFUND shift, not raw request JSON or sale cumulative amounts. Define treatment of legacy records that lack validated attribution; do not silently invent historical shift/tender facts. Keep finalized reports stable or expose explicit audited corrections.

No new automatic payout, drawer operation or refund receipt is authorized by ledger confirmation.

## 4. Client architecture after server acceptance

- Separate sale identity/fingerprint from current refund-shift identity; freeze the latter with original request bytes in the existing durable journal.
- Add a local immutable per-event accounting projection only from validated canonical server results, atomically with journal CONFIRMED and cumulative order audit. Unique scope/request identity prevents replay application twice.
- Persist exact tender amounts per event; do not recalculate allocation from cumulative order refund totals.
- Before migration, decide legacy baseline representation and report snapshot policy using real schema audit. Existing v10 data and UNKNOWN payloads must survive untouched. No guessed backfill from sale shift; no blanket deletion or remapping.
- During mixed-version transition, never subtract both legacy cumulative refund and the corresponding event. Enable cross-shift and split support separately only after their tests and migration pass.
- Keep current context fences, explicit reconciliation, durability barriers and permission checks. Existing UNKNOWN attempts must replay their exact old payload; no request version rewrite.
- Shared UI continues explicit reconciliation and truthful unsupported messages. Add locale keys through the existing POS translation system only when these capabilities are implemented.

## 5. Trade-offs and risks

- Client-only event ledger is smaller but cannot establish server-authoritative tender/shift accounting; rejected.
- Server-first versioned event contract is more work but gives Windows and Android the same verifiable source of truth; selected.
- Inferring historical event attribution from sale.shift_id is convenient but can silently rewrite old/current cash reports; rejected. Explicit legacy compatibility policy is required.
- High risks: cross-tenant shift references, close/refund races, cumulative rounding drift, duplicate event application, legacy double subtraction, cached replay rejection after close. Mitigations are transaction validation, immutable canonical events and the acceptance tests below.

## 6. File impact and implementation order

No runtime file is approved for editing by this request document alone. Proposed backend impact: refund DTO/controller, b2b-pos.service refund validation/persistence/response, shift reporting and ledger allocation SQL, capabilities, and focused service/transaction tests. Exact additional paths and a migration decision must be confirmed in the backend worktree before implementation.

Then Android: `shim/db/schema.ts` (additive migration only after legacy policy), `shim/db/refund-attempt-repo.ts`, `shim/db/order-repo.ts`, `shim/refund-coordinator.ts`, shared refund authority/intent types and focused database/coordinator/lifecycle tests. Optional history UI and translations only if capability presentation changes. Do not change Windows financial behavior incidentally.

Order: backend policy/contract and migration design → backend implementation/tests in DEV → client projection/migration → independently gated cross-shift and split support → Windows contract regression → Android web/native build and device acceptance → separately approved production promotion. Backend complexity high; client moderate/high; migration unresolved and must not be improvised.

## 7. Acceptance criteria

- Sale in shift A, refund in B: B contains actual cash/card refund, A's finalized report unchanged.
- Another salon's shift/order rejected; closed/nonexistent shift and unauthorized operator rejected without mutations.
- Shift-close/refund race results in one consistent ordering, never an unreported committed refund.
- Multiple partial refunds of very small split amounts sum exactly to canonical per-tender totals; final refund consumes residual; no over-refund per tender.
- Same-ID retry, timeout after commit, restart and confirmed replay after shift close produce exactly one event and no automatic payout/print.
- Invalid/missing canonical shift/tenders cannot yield local success or unlock a new request.
- Upgrade preserves v10 orders, confirmed/UNKNOWN journal entries and existing reports; legacy/current accounting never double subtracts.
- Windows and Android fixture totals agree for the same canonical events. Native device, offline recovery and hardware tests remain separate release gates.

## Verification in this continuation

48 existing tests passed across android-refund-coordinator, android-refund-lifecycle and android-order-repo-safety. These verify the current narrow safety gates, NOT the proposed cross-shift/split implementation. No new APK, build, backend writes or production deployment.
