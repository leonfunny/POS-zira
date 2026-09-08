# Remote scale diagnostics and read budget

## Scope and evidence

Requested after remote weighing worked at Chesaigon but could not connect at Baohan with reportedly identical scale/setup. No on-site logs or hardware were available. This change addresses reproducible code weaknesses; it does not establish Baohan's root cause.

Base: POS `42dae0d47`. Development: GM, isolated worktree `D:\zira-pos-wt\remote-scale`, branch `fix/remote-scale-diagnostics-20260908`.

## Design

- Keep existing LAN-only address restrictions and pairing-token authentication. No backend, schema, production configuration, or device restart.
- Reuse `/scale/status` (also available on older sharing POS versions) as a hardware-free connection check with a 2-second deadline.
- Give `/scale/read` a separate minimum 10-second budget: one configured COM probe can take 4 seconds, with one unstable retry and 250ms settling. Legacy persisted 2-second settings also receive the minimum; larger configured values are capped at 30 seconds.
- Distinguish connection timeout from read timeout, preserve COM error codes, report invalid JSON separately, include target host/port and socket error codes. Never include the pairing code in generated diagnostics.
- Share an in-flight hardware read across simultaneous remote requests to the same physical scale; clear it after success or failure. Later requests get a fresh weight.
- Show all advertised IPv4 addresses in Settings, so users can select the appropriate local adapter rather than seeing only the heuristic suggestion.

A separate status request adds one LAN round trip to each remote weigh operation. This is intentional: it distinguishes an inaccessible service from a reachable POS whose hardware read is slow without requiring a new API on older hosts.

## Files

- `src/shared/scale-network-settings.ts`: shared default port and deadlines.
- `src/main/hardware/scale/scale-network-service.ts`: staged requests, diagnostic errors, concurrent read coalescing.
- `src/main/config/store.ts`: new-install/schema scale timeout defaults.
- `src/renderer/components/Settings.tsx`: shared defaults and address list.
- `tests/scale-network-service.test.ts`: regression cases.

## Validation

Main and renderer TypeScript checks and the complete `npm run build` passed on GM.

On GM: scale-network service tests (15) and Dibal parser/port selection tests (11) passed. Coverage includes an actual HTTP read delayed 2.2 seconds with a legacy 2-second setting, wrong pairing code, a disabled share, forbidden/unavailable service, invalid JSON, both timeout stages, COM errors, concurrent reads, and recovery after a hardware exception.

## Limits and follow-up

Automatic detection over many COM candidates can exceed 10 seconds. The read-timeout message directs the operator to test locally and select a COM port explicitly; this change does not promise a bound for exhaustive port discovery. A client abort does not cancel the host's already-running hardware probe. Coalescing prevents another remote probe from starting while it remains pending.

A working client version can use the existing status/read contract on an older host. Concurrent-read coalescing and the updated address display require updating the sharing POS itself.

At Baohan, verify the actual local IP/port, pairing code, local read, and remote read when hardware becomes available. Tailscale addresses remain intentionally blocked by the existing LAN policy.
