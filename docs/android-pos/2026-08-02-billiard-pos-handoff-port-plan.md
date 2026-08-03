# Android POS — Billiard POS-handoff port (design + plan)

**Goal:** the Android tablet can END and SETTLE a billiard session, exactly like
the Windows counter. Today it cannot: `AndroidBootApp` mounts
`BilliardFloorPlan` without `onPayInPos`/`onPreflightPos`, so the only primary
action of `PaymentDialog` is permanently disabled
(`PaymentDialog.tsx:361`), and reaching it would throw
*"Pay in POS is available in the Windows counter app. This session remains
unpaid."* (`PaymentDialog.tsx:229-231`).

**Cause:** the shared renderer moved to a POS-handoff-only settle flow (the
dialog no longer has its own tender UI). Windows backs that flow with
`pos.billiardCheckout.*` in the main process; the Android shim never grew that
namespace.

**Owner decision 2026-08-02:** port it in full — the tablet must be able to take
the money.

---

## 1. Requirements

- **What:** port the 9-method `pos.billiardCheckout` surface into the Android
  shim, with the same durability and the same refusals.
- **Why:** a billiard salon running a tablet beside (or instead of) the Windows
  till cannot close a table at all today.
- **Who:** cashier (STAFF/MANAGER) settles; OWNER additionally resolves an
  uncertain tender.
- **Where:** `src/renderer/android-pos/**` (shim + schema), `src/shared/**`
  (pure logic promoted from `src/main/pos/**`), `AndroidBootApp.tsx` (mount).
- **Scope:** port / parity — no new product behaviour, no backend change.

## 2. Surface to satisfy (exact renderer callers)

| Method | Caller |
|---|---|
| `preflight()` | `App.tsx:180` → `PaymentDialog` via `onPreflightPos` |
| `prepare(input)` | `App.tsx:165` via `onPayInPos` |
| `recover()` | `App.tsx:196`, `RetailTemplate.tsx:292` |
| `markPaymentOpened(checkoutId)` | `POSLayout.tsx:494` |
| `beginTender(checkoutId, token)` | `PaymentModal.tsx:313` |
| `beginRestoredTender(holdId, token)` | `PaymentModal.tsx:317` |
| `resolveUncertainTender(input)` | `POSLayout.tsx:547` |
| `complete(checkoutId, orderId)` | `POSLayout.tsx:2020` |

## 3. Architecture — what already exists vs what is missing

The Windows implementation is layered, and the Android shim already owns the
bottom layer. `AndroidDatabase` was built with the same `get/run/all/
transaction` surface as the Windows `database` singleton *"so ported repos
compile against it with only an import-path change"* (`db.ts:160-164`), and
`flush()` is the `saveCoalesced()` durability barrier.

| Layer | Windows | Android today | Work |
|---|---|---|---|
| DB engine | `database` (sql.js + fs) | `AndroidDatabase` (sql.js + IndexedDB) | none |
| Tables | `pos_billiard_handoffs`, `hold_orders` | absent | **L1** |
| Repos | `billiard-pos-handoff-repo.ts` (346), `hold-repo.ts` (177) | absent | **L2** |
| Pure logic | `src/main/pos/billiard-pos-handoff.ts` (430), `pos-auth-epoch.ts` (25) | unreachable (`src/main/**` is forbidden in the shim graph) | **L3** |
| POS store | full billiard guards + `state/replaceCheckoutSnapshot` + `markBilliardOrderCommitted` | reduced fork, none of it | **L4** |
| Orchestration | `pos.module.ts:1981-3010` (~1030 lines) | absent | **L5** |
| Mount | `App.tsx:513,650-651` wires props | `AndroidBootApp.tsx:187` passes none | **L6** |

## 4. Trade-offs

**D-A. How the shim reaches the pure handoff logic (430 lines).**
- A. Promote `src/main/pos/billiard-pos-handoff.ts` → `src/shared/`, update the
  Windows imports. `+` one source of truth for both platforms; the port cannot
  drift. `-` touches Windows import lines (no behaviour change).
- B. Copy it into the shim. `+` zero Windows churn. `-` two copies of money
  logic that WILL diverge — precisely the failure this whole wave is repairing.
- **Chosen: A.** The file imports only `../../shared/*` and pos-store types, so
  the move is mechanical.

**D-B. `hold_orders` on Android.**
- The handoff parks an in-progress ordinary cart in a *protected* Hold before
  freezing the billiard cart. Without holds, `prepare` would have to refuse
  whenever the cashier has a live cart.
- **Chosen:** port `hold-repo` too. Refusing would change cashier behaviour vs
  Windows, and the table is small.

**D-C. Scope of the pos-store parity (L4).** The Android reducer is a reduced
fork. Port guard-by-guard against `src/main/pos/pos-store.ts` rather than
"port what the happy path needs" — every one of those guards exists because a
frozen billiard cart must not be edited, cleared, discounted, or overwritten.

## 5. DECIDED 2026-08-03 (owner delegated the call after review)

**D1 — fiscal readiness on a tablet: require ASSIGNED + a live print-agent link.**

`requiresBilliardFiscalPrinterReadiness` (fiscal-tender-preflight.ts:18-28) turns
the gate on when any of `allowRealFiscalPrint`, `fiscalOnCashSale === 'always'`,
`localFiscalEnabled`, `detectedFiscalConfigured` holds, and Windows then demands
`configured && connected` from the local device.

On Android `hasFiscalPrinter()` returns `configured = connected = !!assigned`
(stubs.ts:252) — the assignment endpoint does not expose live state, so
`connected` there is not a real signal. The tablet therefore requires:

- the salon has a fiscal printer ASSIGNED (`getFiscalPrinterStatus().assigned`), **and**
- the print-agent socket is currently connected (`agentConnection.isConnected()`),

because that socket is the only path the fiscal document can travel. This is the
closest honest analogue of "configured && connected" available on a device that
owns no printer. Additionally `localFiscalEnabled` is hard-coded **false** on
Android: a tablet has no directly attached fiscal device, and claiming one would
distort the `allowRealFiscalPrint` production safety gate.

`assertBilliardRealFiscalGate` is run unchanged on both platforms — it is pure
and the tablet must not be able to bypass the go-live gate.

**D2 — a salon with no `pa_` print-agent key cannot settle from the tablet (fail closed).**

`currentPosSnapshotScope` needs `registerCode || machineId || agentId`. On Android
only `agentId` exists, written by agent-connect from the `/print-agent/connect`
response; Windows' `machineId` is server-assigned (auth.module.ts:241) so minting
a local UUID would put an identity in the journal that the server's agent
registry has never seen — and two tablets could then collide on one register id,
letting them see each other's frozen checkouts.

The two decisions collapse into ONE operational rule: **a tablet may settle only
while it is paired with the salon's print-agent.** That is not a hardship — an
unpaired tablet cannot issue the fiscal receipt for the bill either.

Refusal message must name the fix ("pair this tablet with the salon's
print-agent"), never a bare "register not ready".

**Deliberately still open (flagged, not faked):**
`assertTenderFiscalCompatibilityForProtocol` refuses a discounted checkout on an
ELZAB_STX printer (the Che Saigon incident). The tablet does not know the REMOTE
printer's protocol today, so it cannot run that check. Until the assignment
lookup exposes the protocol, a discounted billiard bill tendered from a tablet
onto an ELZAB fiscal printer will fail at PRINT time rather than being refused
before the tender boundary. Tracked here rather than guessed.

## 6. File impact map

**Create**
- `src/renderer/android-pos/shim/db/billiard-handoff-repo.ts` — port of the Windows repo
- `src/renderer/android-pos/shim/db/hold-repo.ts` — port of the Windows hold repo
- `src/renderer/android-pos/shim/billiard-handoff.ts` — the 8 orchestration methods
- `tests/android-billiard-handoff-repo.test.ts`, `tests/android-billiard-handoff.test.ts`, `tests/android-pos-store-billiard.test.ts`

**Modify**
- `src/renderer/android-pos/shim/db/schema.ts` — 2 tables
- `src/renderer/android-pos/shim/pos-store.ts` — billiard context/guards, snapshot replace, commit marker
- `src/renderer/android-pos/shim/transport.ts` / `stubs.ts` / `real-transport.ts` — namespace wiring
- `src/renderer/android-pos/AndroidBootApp.tsx` — render `POSLayout` with the intent props; pass the two handoff callbacks to `BilliardFloorPlan`
- `src/shared/billiard-pos-handoff-logic.ts` (moved) + the Windows imports that referenced it

**No migration** in the eNail sense — the Android schema is `CREATE TABLE IF
NOT EXISTS` re-applied on every `initAndroidDb`, so a restored image upgrades
itself.

## 7. Risks

| Risk | Sev | Mitigation |
|---|---|---|
| Double-charge / lost payment on a frozen cart | HIGH | port the state machine + disk barriers verbatim; never "fake success" on a failed flush |
| Divergence from Windows over time | HIGH | D-A: one shared copy of the pure logic |
| Cross-tenant leak of a parked cart | MED | scope every read by `salonId+userId+registerId` like the Windows repo |
| Tablet ends a session with no fiscal receipt | HIGH | D1 must be answered before L5 |
| IndexedDB eviction loses a frozen cart | HIGH | pre-existing (#3 of the 2026-08-02 review) — `navigator.storage.persist()` should land with or before this wave |

## 8. Implementation order

1. **L1** schema (2 tables) — nothing depends on it being right except everything.
2. **L2** repos + tests (port, SQL unchanged).
3. **L3** promote the pure logic to `src/shared/`, Windows imports updated, Windows tests green.
4. **L4** pos-store parity + tests.
5. **L5** orchestration + shim namespace wiring — **needs D1/D2**.
6. **L6** mount in `AndroidBootApp` + end-to-end test.

Each step commits separately and must end green on: `npm run build`,
`npx vitest run tests/android-*`, `test:android:boundaries:source`,
`build:android:web` + `test:android:boundaries:bundle`. Full-suite baseline is
14 pre-existing red files — any NEW red file is a regression.
