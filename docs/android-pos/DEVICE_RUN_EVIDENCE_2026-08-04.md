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

## Settle verified end to end (after the salon switch)

Paul authorised the config write; `Klub Bilardowy Home` went `WEB` → `POS`
(original value recorded for rollback). The run then exposed three real defects
in a row, each only visible against a live backend:

| # | Symptom on device | Root cause | Fix |
|---|---|---|---|
| 1 | Cash taken, cart cleared, table still "running". Session `ce99bb35` COMPLETED/**UNPAID**, `posOrderId` null; server booked a plain sale `POS260804-0001`. | Android's order DTO omitted `billiardOrigin` + `clientAttemptId`, so the backend had no session to settle. | `6caadf6` + parity guard 3/3 |
| 2 | Every later table refused: *"Another Billiard checkout is still unresolved on this register."* No cashier action could clear it. | A handoff can sit in `POS_PAID_SYNC_PENDING` with its order already synced; sync only marks `SETTLED` while handing an order over, and a synced order is never handed over again. | `7e12768` |
| 3 | Settle rejected by the server: *"Every Billiard POS item requires billiard metadata."* | The Android order repo held a hand copy of `buildBackendOrderItem` that had dropped the per-line `billiard` block. | `37d19fa` — contract moved to `src/shared/pos/`, copy deleted |

Final run, session `e3afc6f7` (Bàn #2, 2,41 zł, cash):

```
e3afc6f7 | COMPLETED | PAID | POS | checkout 0304f5f3 | pos_order 5877f882 | settled 2026-08-04 07:12:28
POS260804-0002 | 2.41 | DELIVERED | PAID
```

The tablet ends a table, hands the frozen bill to POS, takes the money, and the
server records the session as settled and linked. Defect #2's fix was confirmed
in situ: the wedged record closed itself at boot and the register came back.

### Diagnosis harness worth keeping

The device logs nothing useful to logcat (the app logs to the WebView console).
What worked: forward the WebView DevTools socket
(`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`), tunnel it
to the build box, and drive `Runtime.evaluate` over CDP. That made
`pos.orders.getHistory()` readable and surfaced defect #3's `sync_error`
verbatim — after two rounds of guessing from the UI alone had produced nothing.

## Still open

- `ce99bb35` (0,97 zł) stays unlinked on the demo salon: its money IS recorded
  (`POS260804-0001`, PAID) but the session shows as unsettled. It is the
  artefact of defect #1 and needs a one-row link or a write-off — an owner call,
  not a silent production write.
- Kill mid-tender → uncertain lane → OWNER resolve, on device.
- v4→v8 schema upgrade over a real installed image.
- `beginRestoredTender` + auto-restore of the parked cart is still unported;
  both transports refuse it with a pointer to the Windows counter.
