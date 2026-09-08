# Android canonical refund intent

## Requirements

Prepare a pure, deterministic normal-product refund command and its expected authoritative response. The caller owns authentication, fresh server fetch, active shift authorization, durable request storage/replay and all effects. This helper must never turn renderer amounts, product names or restaurant local IDs into financial authority.

## Design

prepareAndroidRefundIntent(rawServerDetail,dto,{backendOrderId,salonId,backendShiftId}) returns payload, RefundAuthorityExpected and priorRefundLines normalized to integer grosze, or throws an explicit validation/unsupported error. Reuse raw identity validator before any permissive adapter. UUID request/shift required; accept ordinary PIECE/WEIGHT with exact IDs and canonical units only. FULL includes all remaining lines, PARTIAL a unique valid subset. Reject Billiard, manual adjustment, unknown/refunded identities, invalid quantities, malformed prior audit and ambiguous discounts.

Validate raw canonical monetary strings/numbers strictly before shared adapter. Determine remaining payable and quantity per exact server item from verified historical audit. Backend-confirmed intermediate partials use original gross line total times selected/original quantity, rounded to grosze; the final remaining quantity takes the exact residual amount. This intentionally does not substitute remaining-amount ratio. Compare renderer total/line amounts against canonical values; discrepancies (including a renderer rounding discrepancy) fail closed. Original canonical sale tenders determine payout allocation; never accept a renderer-directed tender change. Shared payload mapper converts grosze to PLN once.

## Trade-offs and risks

- Prefer an explicit unsupported error over inferred legacy/discount pricing. Backend exact monetary algorithm must be source-confirmed; never guess from UI display.
- HIGH over-refund risk: reconcile all prior line money with order cumulative amount; unknown item audits block; validate remaining money/quantity and FULL completeness.
- HIGH tenant risk: raw validator rejects declared tenant/order mismatches; transport still owns authorization even for legacy detail without a declared salon field.
- Preserve raw input; no migrations, API changes, UI changes, ledger writes, printing or network activity.

## Impact and tests

Create only src/shared/android-refund-intent.ts, tests/android-refund-intent.test.ts and this plan. Verify duplicate products/reversed IDs, full/partial/repeated/weighted refunds, malformed pricing/history/scope, renderer tampering, canonical tender allocation and deterministic output. Run focused shared refund tests and typechecks. Integration is parent-owned and remains gated pending broader durability verification.

Evidence: parent Tier2 graph generation08:50 stale/untracked shared helpers; exact current refund-authority, payload and adapter source read directly. Backend source contract requested from reviewer before pricing claims.

## Source confirmation and verification

Reviewer confirmed mirror c6576a51; direct read of local b2b-pos.service.ts613–727 verifies getRefundItemGrossTotal, resolveRefundLineMoney and applyItemPriceContract. Explicit grossUnitPrice (up to4dp PLN) and grossTotalPrice (2dp PLN) are the required input contract here; no net/gross inference. Canonical totalUnits is required; WEIGHT additionally requires saleQuantity agree and saleUnit kg. Missing or ambiguous legacy fields reject. Prior audit unitPrice retains fractional grosze precision; refundAmount is integer grosze. Prior missing VAT is not invented.

45 new intent tests PASS; five focused suites197 tests PASS (intent, response authority, shared payload and Windows/shared adapters). Main no-emit typecheck PASS and diffcheck PASS. Renderer check found only contemporaneous coordinator/Modal typing errors in other agents' files; parent and owner notified. No diagnostic pointed to intent implementation. Parent owns final integrated renderer/build gate.

Scope remains three newly created files only. No runtime integration, ledger changes, UI edits, backend changes, network calls or real refunds performed. Source frozen for parent integration. Unsupported: discounted/tipped/fee orders, noncanonical legacy pricing/quantity, Billiard/special item policies, malformed/unidentified audit, redirected payout and any renderer/canonical money discrepancy. Parent restricts initial operational integration to same-open-shift local sales with verified backend shift mapping.
