# POS source integration — 2026-09-08

## Summary

- Unify restaurant POS presentation and shared Windows/standalone Android workflows, including category-colored dark product cards and responsive layouts.
- Preserve upstream canonical payment-method correction and scale diagnostics by merging main before validation.
- Add durable Android refund validation/storage foundations, immutable local shift-close snapshots, tenant/register guards, and Android manifest/network policy checks.
- Fix Windows persisted restaurant-check recovery protection and retain receipt/auth barriers around payment correction.

## Validation on integrated source

- `npm test -- --maxWorkers 4`: 396 files passed, 1 skipped; 4,317 tests passed, 13 opt-in browser tests skipped. Electron smoke tests included and passed.
- Opt-in Chromium restaurant theme suite: all 13 tests passed separately, including built Windows/Android styles and responsive viewports.
- `npm run build`: passed (renderer typecheck, main TypeScript, Windows renderer build).
- Android web build and boundary checks: passed; 160 source modules and 5 built bundles checked.
- Bounded parallel reviews covered backend/client contracts, native/renderer readiness, and Windows recovery/payment guards. Findings were fixed and covered by regression tests. These reviews are not a native hardware certification.

## Migration and runtime impact

- Additive Android local schema stages 11–13 cover device identity, immutable shift-close snapshots, and refund event storage/context. No production database migration is performed by this source integration.
- V1 refund events remain staged, not enabled for live HTTP dispatch. Existing capability and safety gates remain in place.
- No new production environment variables or credentials are introduced by this ship operation.

## Release boundary

This is a source-only integration, not a production release. Version remains 1.0.26; no release tag, published APK/installer, backend deployment, or live POS restart is authorized by this operation.

Event-aware shift reporting is now implemented in the follow-up branch: canonical deltas are attributed to their refund shift, converted cumulative refunds are excluded, full frozen journal evidence and tender/audit chains are revalidated, and finalized reports remain immutable. Local follow-up evidence: 111 focused tests; 396 non-browser test files passed with 1 skipped (4,316 tests passed, 13 skipped); Electron smoke 13/13; full build; Android boundary scan 162 source files / 5 bundles; production-readiness and build-only CI policy checks passed.

Production remains NO-GO pending capability negotiation and guarded V1 dispatch, recoverable remote close acknowledgement, native device/offline/restart/printer tests, signed artifact validation, and separate backend completion. Backend work in its separate checkout is not included in this repository's commits.

See `docs/plans/SESSION_HANDOFF_ANDROID_POS.md` for continuation context. CI must pass on the pushed head before merge; local results above do not substitute for that gate.
