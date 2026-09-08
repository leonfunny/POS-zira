# Design: shared refund response authority validation

## Requirements and boundary

Pure response validator for Windows/Android refund callers; protects owners/managers from accepting a wrong order, line, amount, or fabricated success. Backend authorization, durable replay journal, scope fencing, payout and printing remain caller responsibilities. No endpoint, database, migration, dependency, UI or translation change. This validator does not enable Android refunds.

## Contract and trade-offs

`validateAuthoritativeRefundResult(raw, expected)` returns either validated minor-unit delta/cumulative/status/lines or `{ok:false,error}`. Expected context supplies backend order ID, immutable request ID, integer-grosze totals and exact server item IDs/quantity/restock. Returned lines may be reversed or share product IDs: only exact server item ID associates them.

Fail closed instead of filling missing response values from the request. Accept strict decimal PLN strings as well as numbers (database decimal serialization), reject junk/coercions/sub-cent amounts. Positive delta only; zero-delta replay handling belongs to the journal. Cumulative amount must equal previous cumulative plus delta and remain within order total. FULL must equal total, PARTIAL must remain below it. Expected delta and line sum allow one grosz rounding residual. Do not require stock movement IDs without inventory-tracking context.

Normalized audit lines contain exact server orderItemId, immutable request ID, quantity, canonical unit, minor-unit price/amount and restock; optional audit fields are preserved only after validation. No name/product/order-position fallback. Optional echoed request IDs must match; absent request ID is bound to the immutable expected context, not newly generated.

## File ownership

- Create `src/shared/refund-authority.ts` (pure validator/types, no main-process dependencies).
- Create `tests/refund-authority.test.ts` (positive/rejection matrix).
- Create this plan/report.

Other agents own integration/payload/history. Preserve their edits; no server or production writes.

## Risks and verification

Wrong identity/money: strict expected context plus exact line set and quantities. Duplicate replay: caller journal required; this validator alone cannot establish that a locally confirmed operation has not already been applied. Tenant leakage: caller binds verified backend order to captured salon/session; POST contract has no salon field. Compatibility risk: fail closed on missing canonical fields rather than silently guessing.

Order: document design, implement focused fixtures and validator, run focused tests and isolated TypeScript check, hand off API. Tier2 prior graph generation 08:50:16Z is stale; exact refund helper/DTO source was inspected in the preceding audit. New paths are not graph-covered yet.

## Results

Implemented the proposed API in the owned shared file only. Canonical zero-value lines are retained (nonnegative price/amount); the overall refund delta must remain positive. This avoids blocking FULL refunds containing a free line. Quantities must be positive at milligram/piece-thousandth representation (minimum 0.001); tiny values rounding to zero are rejected. Money fields permit no sub-cent precision; one-grosz tolerance applies only to expected-delta comparison and the sum of normalized line amounts.

Verification:

- `npx vitest run tests/refund-authority.test.ts`: 71 tests PASS.
- `npx tsc --noEmit --skipLibCheck --strict --target ES2022 --module commonjs src/shared/refund-authority.ts`: PASS.
- Coverage recheck: new source/test are `not_tracked`; existing main helper is `metadata_changed`. Direct authored/read source plus executable tests are the evidence, not graph completeness.

No server calls/writes, production changes, commits, payments or receipt operations. No claim of integrated Android release readiness: parent owns scope validation, durable attempts, replay/local application, permission and UI gates. Expected context must be the immutable PRE-attempt state on replay; substituting latest cumulative state intentionally fails validation rather than double-applying the refund.

## Follow-up: raw detail identity gate

Add `validateRefundDetailIdentity(raw, {backendOrderId,salonId})` in the same pure module before Windows/Android adapter invocation. Require exact raw order ID and a nonempty set of unique, nonblank canonical item IDs. Validate every declared tenant and item-parent identity, including nested salon/order IDs; absent legacy fields are permitted because the authenticated caller binds scope. Declared null, blank or conflicting identities fail. The helper never generates IDs or adapts/mutates data. Parent owns handler integration; no new file/dependency/schema impact. Add focused wrong-order/tenant/parent/missing/duplicate-ID tests before handoff.

Follow-up implemented and frozen: focused suite now **98 tests PASS**; isolated strict TypeScript command above also PASS. Tenant aliases `salonId`/`salon_id`/`salon.id`, item parent aliases `orderId`/`order_id`/`b2bOrderId`/`b2b_order_id`/`order.id`, and a nested parent's declared tenant are checked independently. Any conflicting alias fails; no preferred-field fallback can hide a mismatch. Legacy relation fields may be absent; an explicitly null/malformed declared relation fails closed. Scope/auth generation must still be checked by the caller after asynchronous detail fetch.

## Compatibility correction: canonical unit-price precision

Exact backend `b2b-pos.service.ts::resolveRefundLineMoney` (mirror of the previously verified c6576a51 contract, lines637–667) returns `unitPrice` at FOUR decimal PLN, while refund amount remains two-decimal PLN. Parent authorized a unit-price-only correction: accept strict numeric/decimal-string 4dp PLN and preserve its fractional-grosze equivalent (e.g.13.3333 PLN→1333.33 grosze). Do not round an authoritative weighted/remainder unit price down to integer grosze. Delta, cumulative and each line refundAmount remain integer grosze; strict junk/nonfinite/negative checks unchanged. This supersedes earlier plan wording that all prices must be integer grosze. No other validator behavior changed.

Verification after precision correction: **108 authority tests PASS**, together with **20 refund HTTP-boundary +30 existing API tests PASS** (158 total). Strict standalone TypeScript check of shared/refund-authority.ts and Android api-client.ts PASS.
