# Android explicit refund reconciliation UI — 2026-09-08

## Current result

Optional reconciliation types, Android namespace delegation and history UI implemented. **80 tests passed across 5 suites**, including **13 mocked reconciliation/stock-warning UI tests**. No refund execution, payout or printing is implemented by this UI action. Coordinator integration/production acceptance is parent-owned; no native build, APK, real API mutation or deploy performed here.

## Design before code

Expose an unresolved original refund request in order history without treating reconciliation as a new refund, cash payout or receipt action. This is UI wiring for the parent-owned coordinator; only the existing same-open-shift local ordinary-sale scope will be supported. Windows has no optional reconciliation method and keeps its current behavior.

Contract: `getRefundDetail(orderId)` may carry `reconciliation:{requestId,status}`; refund failure may carry `requiresReconciliation:true,refundRequestId,error`; optional `reconcileRefund(orderId,requestId)` returns `success,reconciled?,error?,requiresReconciliation?,refundRequestId?`. The UI passes only the stored original ID, never generates one for reconciliation, and never calls refund/print from that action. Read-only detail refresh does not POST or auto-reconcile.

When a refund reports uncertainty, close the RefundPanel and reload authoritative detail, retaining the original request marker while refresh is pending. Show an explicit warning card and button; warn the operator to verify whether cash was already returned before paying again. On reconcile success refresh history/detail but do not open the refund success/payment/printing dialog. On failure retain the original request and show the error. Protect async results with current order/selection sequence, and disable duplicate clicks. On order change clear state so one order's request cannot be applied to another.

Optional Android support is detected from `orders.reconcileRefund`; only that surface performs a read-only check for pending reconciliation when selecting an order. The existing refund-detail authority flow remains unchanged for Windows. Unknown result without an original ID does not invent an actionable ID; authoritative reload must supply it.

File impact: modify `src/shared/electron.d.ts` (actual declaration path), `shim/transport.ts`, `shim/stubs.ts`, `components/pos/OrderHistoryModal.tsx`; add `tests/android-refund-reconciliation-ui.test.tsx` with mocked APIs; this report. Runtime shim/component paths are under `src/renderer/`. No coordinator/repository/shared-money edits, schema migration, live network/payout/printing, APK/build/deploy or commit. Parent owns coordinator; client confirmed prior Modal/identity changes frozen.

Use existing `tOr` fallback convention for bounded new explanatory strings; full locale completion is explicitly separate if translation edits exceed this owned scope. Safety preference is a visible explicit reconciliation state rather than a misleading success or a fresh retry button. Integration tests cover pending-on-read, exact ID explicit action, no payout/print, uncertainty closing the refund form, failed reconciliation retry using same ID, stale order-switch result and absent Windows method.

Skill: design-reasoning applied to optional API/UI state contract and race/financial-risk analysis. Graph unavailable (`Transport closed`); current direct source inspection of declarations, namespace, RefundPanel and history selection/authoritative-detail handlers used instead.

## Verification and remaining limits

Follow-up scope before editing: parent coordinator may return `stockRefreshRequired:true` after a confirmed refund/reconciliation when authoritative stock refresh fails. Add only optional return flags and a non-blocking warning to the existing success/reconciliation state. Copy must distinguish confirmed refund from stale stock, advise stock sync before trusting counts, and explicitly say not to retry the refund. No automatic stock/refund/print action or new monetary state. Extend the same mocked UI test file; preserve parent-owned SPLIT rejection policy.

- Gate: `npx vitest run tests/android-refund-reconciliation-ui.test.tsx tests/refund-request-ui-identity.test.tsx tests/restaurant-history-ui.test.tsx tests/android-shim.test.ts tests/order-history-refund-ui.test.ts` — **80/80**, 5/5 suites (13+5+28+29+5).
- `stockRefreshRequired:true` now shows a separate non-blocking amber warning on initial refund success and reconciliation success: refund confirmed, stock not refreshed, sync stock before trusting counts, do not retry refund. Optional return types added in shared Electron declaration and ShimTransport. Three focused tests cover true/false initial results, reconciliation warning and absence of automatic refund/print calls. Parent-owned initial SPLIT restriction is unchanged.
- Cases include readonly pending detection, original-ID retry, no refund/print calls on reconciliation, refresh without payout/success dialog, uncertainty closing the form, success/failure discarded after changing order, Windows optional-method absence, shim delegation, rapid double-click suppression and uncertainty without an ID blocking a fresh refund without inventing an actionable ID.
- New state uses both order identity and the existing selection sequence; readonly recovery queries have a separate monotonically increasing read sequence. RefundPanel ignores a response after unmount. A synchronous busy ref prevents duplicate clicks before React rerenders.
- New explanatory strings use `tOr` English fallbacks within this bounded scope; seven-locale translation completion is not claimed. Existing Windows behavior remains behind the optional reconciliation-method boundary.
- Owned-file `git diff --check` passes. A renderer typecheck initially found an implicit callback parameter in this new UI (corrected) and a concurrently edited parent coordinator nullable-line-name mismatch (parent fixed). The repeat `npm run typecheck:renderer` **passes**. No unrelated type/source patch was made here.
