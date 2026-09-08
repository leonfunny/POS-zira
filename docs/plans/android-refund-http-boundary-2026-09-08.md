# Design: Android refund HTTP boundary

## Scope and requirements

Prevent automatic authentication refresh/replay of a monetary POST and prevent accepting responses after the coordinator's captured context changes. OWNER/MANAGER refund orchestration remains with the parent agent. HTTP client preserves the already prepared PLN payload; it does not calculate money, persist attempts, authorize payout, print, or validate financial response semantics.

## Design / trade-offs

Extend `refundOrder(orderId, dto, assertContext?)`: dto accepts an immutable JSON string or an object serialized once before awaits. Coordinator must supply the context assertion; optional parameter preserves existing call-site compilation during integration. Use existing `rawFetchWithTimeout` rather than changing the shared auto-refresh behavior used by unrelated routes. Exactly one POST, no refresh or hidden second POST. Assert context before submission and after awaited token/fetch/body work. Capture URL/body once to avoid accidental retargeting.

All HTTP errors (including 404/501) throw status and server code; no null-success ambiguity. Malformed success JSON is an explicit invalid-response error. Network/timeout errors remain errors and do not imply rollback: caller's durable pending-attempt journal owns unknown-outcome reconciliation. No server/native calls in tests, no database/API contract migration.

## Owned files and order

1. This plan.
2. Only `refundOrder` in `src/renderer/android-pos/port/api-client.ts`; existing private raw-fetch helper reused unchanged.
3. New `tests/android-refund-api-boundary.test.ts` for no-refresh, context races, HTTP/JSON errors and byte-preserved PLN payload.

Other agents own intent preparation, validator and coordinator; do not alter them. Prior Tier2 graph 08:50:16Z is stale and api-client coverage metadata_changed; current method/helper source read directly before patching.

## Verification

Implemented refund-only raw-fetch path; existing shared auto-refresh helper unchanged. Guards run before token lookup, after token/before send, after fetch (including rejected fetch), and after parsed or malformed response JSON. The caller must treat context errors after dispatch as unknown outcome, not cancellation proof.

- `npx vitest run tests/android-refund-api-boundary.test.ts tests/android-port-api-client.test.ts`: **50 PASS** (20 new refund-boundary tests +30 existing API tests).
- `npx tsc --noEmit --skipLibCheck --strict --target ES2022 --module commonjs src/renderer/android-pos/port/api-client.ts`: PASS.
- `git diff --check -- src/renderer/android-pos/port/api-client.ts`: PASS.

Tests use mocked fetch/token providers only. No real payment, network, production or backend writes performed. No commits. Coordinator integration remains parent-owned. API signature: `refundOrder(orderId: string, dto: Record<string, any> | string, assertContext?: () => Promise<void>): Promise<any>`.
