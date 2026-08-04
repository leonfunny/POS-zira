# First real device run — evidence (2026-08-04)

Emulator: Android 16 x86_64, KVM-accelerated, on `komputerai-wsl` (24 cores,
`/dev/kvm`). Boots in <30s. Driven entirely over SSH+adb from Netcup, which has
no CPU virtualization and could not finish a boot in 21 minutes.

This is the FIRST time the APK has ever run against a real backend. Every
earlier gate ran the web bundle in a desktop browser or asserted "no external
requests".

## Bugs it found (both fixed, commit 715837b)

1. **No `android.permission.INTERNET`.** Both permission gates actively
   FORBADE it (diagnostics-era policy). Every fetch died as a bare
   "Failed to fetch". Gates now REQUIRE it.
2. **Staff sync wiped its own roster.** Real `GET /staff` nests the person
   under `user`; the mapper read only flat fields, normalized every row to
   null, and `bulkUpsertStaff([])` (DELETE-ALL + insert) erased the table
   including the login-seeded cashier — so the open-shift dialog said "no
   active staff", which blocks every payment. Ported the Windows mapper +
   its zero-usable-rows guard.

## What the run PROVED works on a device

- login against production, catalog + categories + staff sync
- Task 3 storage-at-risk banner renders (storage is not persistent on this AVD)
- L6: the POS/Bi-a tab nav, the floor plan (15 tables), start session, live
  per-minute charge, add F&B from the LOCAL catalog (759b0d2 — the list is no
  longer empty), running total 21,74 zł = 1,74 time + 20,00 F&B
- **the settle button is enabled and fires** — it was permanently disabled
  before L6 (`disabled={... || !onPayInPos}`)
- **`preflight()` PASSES on a real device** — D1 (fiscal) and D2 (register
  identity) both satisfied, i.e. the tablet is print-agent paired
- the session ENDS on the server (table returns to Wolny, 15 free)

## Where it stops, and why it is NOT an Android bug

`PaymentDialog` then throws *"The final POS checkout is not ready yet"*
because `snapshot.posCheckout` is null.

Root cause is salon configuration, traced through the backend:

- `billiard-session.service.ts:266` — a session's `settlementChannel` is copied
  from `salon.billiardCheckoutMode` at start, defaulting to `WEB`.
- `ensureFrozenPOSCheckout` (`:185-193`) throws
  `BILLIARD_SETTLEMENT_CHANNEL_MISMATCH` unless the session is POS-routed, so
  `posCheckoutId` / `posCheckoutSnapshot` are never created.
- `attachBilliardPOSCheckout` therefore attaches `null`.

Verified against production: the demo salon's last three sessions all report
`settlementChannel: WEB`, `posCheckoutId: null`. The start-session DTO has no
channel override — `billiardCheckoutMode` is the only source.

**The Windows counter would fail identically on this salon**: the gate is
server-side and `PaymentDialog` is the shared renderer. This is a salon that is
not configured for POS-routed billiard settlement, not a tablet defect.

## To finish the checklist

Switch the demo salon to `billiardCheckoutMode = POS` (a production config
write, owner decision), then re-run: settle → cart clears → table free, and the
kill-mid-tender → OWNER-resolve path.
