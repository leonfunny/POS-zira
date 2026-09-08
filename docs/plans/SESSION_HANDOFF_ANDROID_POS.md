# POS Android parity: next-session handoff

## Objective and checkout

Continue making Android a standalone selling POS with Windows functional parity. Do not describe it as a companion display or claim production acceptance from web tests.

Working checkout: `C:/Users/maxis/enail/POS-zira-release-foundation`, repository `leonfunny/POS-zira`. PR #2 merged at `ce19a83d29516ba2b1ac18ae4b33900c3555526a`; event-aware reporting PR #3 merged at `e38f5213e4ee12796ae620262dca5c93880be97d`. Guarded V1 coordinator work continues on `codex/android-refund-v1-coordinator`. The user authorized source commit/push/merge, not production release or activation without acceptance. Preserve dirty work. The clone fetch refspec originally included only a feature branch; fetch `main` explicitly when needed.

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
- Legacy paths reject event-bearing orders and preserve original UNKNOWN bytes. New close reports validate the complete canonical request/authority/response/event chain, subtract exact event deltas in the refund shift and exclude converted cumulative order refunds. Invalid or incomplete evidence fails closed; existing finalized snapshots stay readable without recalculation.
- Guarded V1 coordinator wiring now selects V1 only from an exact capability in the frozen auth context, preserves the original protocol/bytes for every existing attempt, verifies device/shift/history/tender evidence before dispatch and confirms event/order/journal atomically. A converted order cannot downgrade. Same-shift, split and OTHER restrictions remain.

## Next implementation order

1. Recoverable remote-close acknowledgement/outbox; current remote close remains best-effort.
2. Land and verify the separate backend V1 work in its DEV checkout before any environment can advertise the capability.
3. Full Windows/Android regression checks plus real Android restart, offline, tenant switch, payment/refund and printer acceptance. Only then prepare production artifacts and rollout.

No guessing missing canonical history, no silently mapping OTHER to cash, no disabling split/cross-shift gates early. Missing server behavior requires a server change request, not a brittle client workaround.

## Evidence and release limits

For guarded V1 coordination, the full serial suite passed 398 files with 1 skipped (4,378 tests passed, 13 skipped), including Electron smoke 13/13. The final focused refund run passed 193/193. Renderer/main/Windows build, Android web build, production-readiness policy, build-only CI policy and boundary checks passed (162 reachable source files / 5 bundle files). The production gate remains NO-GO with 22 blockers. These are not native Android, real backend or printer acceptance. Inspect fresh PR CI before merge. Old APKs do not represent this source. Do not publish a release tag, auto-update artifact or production APK just because a source PR merged.

Separate backend DEV work was reported in `/var/www/www/enail/.worktrees/android-pos-restaurant-parity-20260908` on netcup, branch `feat/android-pos-restaurant-parity-20260908-20260908`, base HEAD `c6576a518311b81171d566c4c919f7e2355bce85`, with uncommitted changes. Verify separately; POS repository commit/merge does not save or deploy that work. Do not build on live Contabo or run real financial mutations as tests.

## Merge integration warning

Upstream `main` added canonical payment-method correction and remote-scale diagnostics while this branch was developed. Preserve those changes when integrating, especially `PaymentMethodCorrectionPanel`, `OrderHistoryModal`, `pos.module.ts`, API payment read/update methods, `entity-applicators.ts` and scale timeout defaults. Do not resolve by choosing the entire older feature-branch file.
