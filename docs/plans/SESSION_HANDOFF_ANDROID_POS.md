# POS Android parity: next-session handoff

## Objective and checkout

Continue making Android a standalone selling POS with Windows functional parity. Do not describe it as a companion display or claim production acceptance from web tests.

Working checkout: `C:/Users/maxis/enail/POS-zira-release-foundation`, repository `leonfunny/POS-zira`, branch `codex/pos-ui-release-foundation`, PR https://github.com/leonfunny/POS-zira/pull/2 targeting `main`. At handoff preparation the user authorized source commit/push/merge, not activation of unfinished production features. Verify actual Git/PR status before continuing; this document does not assert merge completion. Preserve dirty work. The clone fetch refspec originally included only the feature branch; fetch `main` explicitly when needed.

## Read first

- Repository AGENTS.md and CLAUDE.md.
- `android-windows-pos-parity-master-2026-09-08.md` and `android-windows-production-rollout-2026-09-08.md` in this directory.
- `android-refund-event-client-2026-09-08.md` for current Stage 4 contracts and restrictions.
- `android-refund-event-accounting-server-request-2026-09-08.md` for separate backend evidence.

Use graph discovery and path coverage first. The previously available graph generation was `2026-09-08T08:50:16Z`, stale for this work; read current source for changed/untracked paths. Subagent use is authorized, with disjoint ownership and independent review.

## Completed implementation, not production activation

- Shared restaurant UI, counter fallback, restaurant check workflow, metadata/history work and local safety gates are documented in the master plan.
- Durable device UUID and verified server/salon/machine/shift evidence.
- Schema12 immutable close-report snapshots; repeat close reads saved evidence without duplicate close POST or recalculation.
- Schema13 nullable order event context and canonical refund-event ledger. The storage-only repository validates exact money, frozen request/response, full audit chain, original/remaining tenders and scope; event/order/journal update atomically. Confirmed replay does not apply money again.
- Original settlement must retain exactly the order total, zero tip/discount, exact tender/header consistency and unique local backend mapping. First conversion requires zero prior refunds; no invented historical baseline.
- Legacy paths reject event-bearing orders and preserve original UNKNOWN bytes. New close reports with event data stay blocked pending event accounting. Existing snapshots stay readable.

## Next implementation order

1. Event-aware shift aggregation: subtract event deltas once in the proper refund shift, excluding converted order cumulative refunds; preserve unconverted legacy behavior and finalized snapshots. Design and tests before relaxing current same-sale-shift restriction.
2. Explicit capability negotiation and guarded V1 coordinator integration. Preserve original request ID, payload, protocol, auth context and durable flush barriers. The new repository currently has no runtime caller.
3. Recoverable remote-close acknowledgement/outbox; current remote close remains best-effort.
4. Full Windows/Android regression checks plus real Android restart, offline, tenant switch, payment/refund and printer acceptance. Only then prepare production artifacts and rollout.

No guessing missing canonical history, no silently mapping OTHER to cash, no disabling split/cross-shift gates early. Missing server behavior requires a server change request, not a brittle client workaround.

## Evidence and release limits

Before source shipping, the focused run passed 1,087 tests across 49 suites, renderer typecheck, Android web build and boundary checks (159 reachable source files / 5 bundle files). These counts are not full-repository or native acceptance. Re-run full tests/build on the merged state and inspect current CI. Old APKs do not represent this source. Do not publish a release tag, auto-update artifact or production APK just because a source PR merged.

Separate backend DEV work was reported in `/var/www/www/enail/.worktrees/android-pos-restaurant-parity-20260908` on netcup, branch `feat/android-pos-restaurant-parity-20260908-20260908`, base HEAD `c6576a518311b81171d566c4c919f7e2355bce85`, with uncommitted changes. Verify separately; POS repository commit/merge does not save or deploy that work. Do not build on live Contabo or run real financial mutations as tests.

## Merge integration warning

Upstream `main` added canonical payment-method correction and remote-scale diagnostics while this branch was developed. Preserve those changes when integrating, especially `PaymentMethodCorrectionPanel`, `OrderHistoryModal`, `pos.module.ts`, API payment read/update methods, `entity-applicators.ts` and scale timeout defaults. Do not resolve by choosing the entire older feature-branch file.
