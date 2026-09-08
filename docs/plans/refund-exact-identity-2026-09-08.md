# Exact refund line identity

## Requirements and architecture

Preserve the authoritative server order-item ID selected by staff through FULL/PARTIAL UI requests and Windows/Android backend payloads. Duplicate products must not collapse or be matched by name, product, restaurant localLineId or array position. Reuse one browser-safe helper module; keep the main-process import path as compatibility re-exports. No network, auth, payment, printer or database behavior changes in this slice.

Add optional orderItemId to refund line types. UI supplies the selected item's id; the existing authoritative-detail boundary must provide server items before the refund panel opens. Exact ordinary lines become items[{orderItemId,quantity,restock,unit?}] with no legacy lines field. Billiard retains stable billiardLineKey identity/no-restock mapping. Reject mixed identified/unidentified ordinary batches, blank/duplicate IDs and mixed Billiard/ordinary batches. Legacy callers with no IDs retain their old mapping. Convert monetary minor units to PLN once, only at the backend boundary.

Journal retries deduplicate ordinary lines only by request ID plus exact orderItemId; independent requests and unidentifiable historical lines remain distinct. Billiard stable-key behavior stays unchanged and uses a separate namespace.

Tracing the actual UI exposed two additional authority gaps: Refund Next reopened after a local-detail refresh, and sync listeners could replace the visible detail during a refund. Parent approved a separate authoritative refund-detail snapshot populated only by getRefundDetail. RefundPanel consumes this snapshot, not ordinary history detail; Refund Next reloads it before reopening. Changing selection/cancelling clears it, and stale local refreshes are focus-guarded. Add actual UI regressions for both gaps.

The new Refund Next runtime test also exposed refund-quantities matching explicit audit lines by product, consuming both identical products. Parent approved exact orderItemId matching in refund-quantities and refund-breakdown, with legacy product/name matching only when no explicit orderItemId exists. Unknown explicit IDs stay unassigned rather than being relabelled as another local row.

## Trade-offs and safety

- Optional identity preserves legacy Windows callers; fail-closed mixed batches prevent a partial rollout from silently reverting to product matching.
- Shared pure code avoids divergent Windows/Android money conversions. Existing Windows tests remain compatibility evidence.
- UI identity is not authorization: parent/coordinator must validate ownership against fresh server detail and tenant/auth state before any refund command.
- No migration or backend workaround. Authoritative-detail/backend validation changes belong to parent/other agent.

## File impact and verification

Create src/shared/refund-backend-payload.ts; keep src/main/pos/refund-backend-payload.ts as re-export. Modify refund-request.ts, shared/electron.d.ts and only refund line selection in OrderHistoryModal.tsx. Add dedicated refund-backend-payload and UI identity tests; don't modify parent restaurant-history UI tests.

Verify duplicate products/reversed server IDs, full/partial selection, monetary and weighted units, partial/invalid IDs, legacy/Billiard compatibility and journal retry dedup. Run existing IPC/Billiard/refund tests and typechecks. No deploy or live refund tests.

## Verified result

Source frozen for integration. 12 suites336 tests pass, including dedicated payload/identity21 and actual UI5 tests (FULL, PARTIAL, both sync listeners, Refund Next). Existing IPC229, Billiard policies/allocation, history UI, refund breakdown, inbound refunds, outbox retention and Android refund tests pass. Main and renderer no-emit typechecks pass. Updated three stale IPC source assertions and the old breakdown assertion that explicitly expected an unknown server ID to bind to the first same-product row.

Additional approved files: refund-quantities.ts and refund-breakdown.ts identity matchers; tests/refund-breakdown.test.ts and tests/ipc-contracts.test.ts. No parent restaurant-history UI test modifications.

Integration risk reported to parent: Windows getRefundDetail verifies order identity and nonempty items, but legacy adapter can synthesize an absent raw item ID. Parent owns explicit raw-ID validation before that response is considered authoritative. Android refund detail remains gated until its durable coordinator/reconciliation flow is verified. No production rollout or actual refund execution claimed.

Evidence: Tier2 parent graph generation08:50:16 with stale/excluded coverage; confirmed correct project and directly read mapper, request type, IPC declaration and actual UI selection paths before editing.
