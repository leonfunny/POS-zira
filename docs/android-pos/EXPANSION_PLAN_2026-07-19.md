# Android parity-port — expansion plan (beyond retail CASH)

Status: ACTIVE — owner decided 2026-07-19: run E1 + E2 in PARALLEL; backend-
gated features = build the client half + draft the exact server change request,
leave dark until the eNail backend ships.
Date: 2026-07-19
Builds on: `PARITY_PORT_PLAN_2026-07-18.md` (S1–S9 done: login, catalog, cart,
CASH order, order-sync, shift, history) and `REVIEW_FIXES_2026-07-19.md`.

Every packet below reuses the proven pattern: the UNMODIFIED Windows renderer
runs behind the `window.electronAPI` shim; we port the main-process behavior it
needs into `src/renderer/android-pos/shim/**`, backed by `PosApiClient` +
SQL.js repos. No new architecture. Hard rails unchanged (staff JWT, no `pa_`
key, test salon until owner go-live, no publish).

## Target profile drives priority: this is a NAIL SALON

A nail salon sells **services first**, retail products second (upsell). The
`pos-zira-setup` nail profile says: *"POS mode: salon when service/check-in/
booking is central; retail only if the shop mostly sells products."* S1–S9
ported the **retail** template. So the single biggest gap for THIS business is
**salon mode** (services, per-service staff, bookings/check-in), not more
retail depth. That is the E1↔E2 fork below.

## Classification of the remaining Windows surface

**A. Client-portable now** (backend routes exist, reuse the shim pattern, no
owner/backend gate): remote receipt print, refund/void, order-history depth,
salon template (services/staff/customers), bookings/check-in reads, invoicing
(NIP/GUS, add-invoice, proforma, PDF), product-admin **reads**.

**B. Backend-gated** (need a backend P0 fix or a new staff-JWT contract before
the client work is safe/possible): electronic payment CARD/BLIK (P0-PAY-1),
fiscal print (P0-FISCAL-1/2), product-admin **writes** (Windows uses the `pa_`
key — needs a staff-JWT variant), reliable shift (P0-SHIFT-1/2), production
terminal gate (P0-GATE-1). Each of these I draft as a server change request;
the client half waits.

**C. Separate project** (OS/hardware/second device): direct fiscal/thermal/
scale/USB drivers, customer second-screen display, self-checkout kiosk, Play
auto-update.

**D. Out of scope for a nail salon** (Windows has them, we deliberately skip):
restaurant/kitchen/tables/pickup, billiard, B2B wholesale.

## Packet waves

### Wave E1 — finish the retail sale (make one CASH sale fully usable)
- **E1a Remote receipt print** (was S10): submit a receipt print job to the
  Windows agent via the existing staff-JWT print routes; states saved/synced/
  print-requested/confirmed/failed. Receipt COPY only — **fiscal print stays
  backend-gated** (P0-FISCAL). Replaces the Wave-1 "receiptPrinted:true" stub
  with a real remote-print coordinator.
- **E1b Refund + void**: port `orders.refund` (POST `/b2b/pos/orders/:id/refund`)
  and void/mutate; wire the Z-report refund/discount subtraction that was
  deferred. Backend routes exist.
- **E1c Order-history depth**: server list/detail/reprint, retry-sync already
  done; add the server-side views the OrderHistoryModal already renders.

### OWNER DECISION 2026-07-19 — dedicated Sunmi POS, fiscal like the grocery
The target is a **dedicated Sunmi Android POS terminal** (fixed in the shop, not
a hand-carried tablet), and it must print **fiscal receipts like the grocery
setup**. This changes two things:
- The "lost-tablet" threat behind the staff-JWT-only / no-`pa_` rail does not
  apply to a fixed trusted terminal. The owner accepts treating the Sunmi like
  a Windows counter. `pa_`-keyed capabilities (product-admin writes, print-agent
  connect, card) may be enabled if/when needed — but see the fiscal note.
- **Fiscal is unblocked WITHOUT dropping the rail or the backend gate.** The
  grocery prints fiscal by submitting a job to the print-agent → ELZAB
  (`shared-fiscal-printer.ts`, role `FISCAL_RECEIPT`), and that submit path
  tries the **staff JWT first** (pa_ is only a fallback). So a Sunmi submits a
  fiscal job to the salon's print-agent exactly like a second Windows POS —
  staff JWT, the same `/print-agent/jobs` route E1a already uses. **No Android
  fiscal driver, no ELZAB on the Sunmi, no rail change.** The ELZAB stays on the
  salon's print-agent box (Plan A, owner-approved).
- The one genuinely Android-native piece is the **Sunmi built-in ESC/POS printer**
  for the non-fiscal customer copy (Sunmi's Android printer SDK) — a later
  device packet; the legal fiscal receipt comes from the ELZAB via the agent.

Packet **E-FISCAL** (in progress): the fiscal twin of E1a — extend the
remote-print coordinator to submit `FISCAL_RECEIPT` jobs, wire
`pos.payment.printFiscalReceipt` + `hasFiscalPrinter`.

### STATUS 2026-07-19 — client cash-sale surface is COMPLETE for the pilot
After E1a/E1b/E2a/E3, every method the SalonTemplate + RetailTemplate cashier
flow calls is ported: login → salon services + retail products → cart with
per-service staff → CASH order → shift + Z-report → remote receipt print →
refund → VAT invoice (NIP/add-invoice/proforma). **E1c is already covered**
(history views ported in S8/S9/E1a/E1b). **E2b (customers) is N/A for a nail
salon** — the only customer methods the POS window calls are `getAll` and
`increaseDebt`, both used exclusively by the **B2BTemplate** (EXCLUDE); the
salon/retail sale flow has no customer picker, and `lookupNip` is done in E3.
The remaining stubs are all out of the client's reach:
- **Backend-gated** (E4 writes, E5): electronic payment (P0-PAY-1), fiscal
  print (P0-FISCAL), product-admin writes (pa_→staff-JWT gap). Client-prep +
  server request only; cannot be finished client-side.
- **Android-platform**: PDF download (FileProvider/share the manifest forbids).
- **EXCLUDE**: B2B, restaurant, billiard, self-checkout, customer display.

**The productive next step is E6 (packaging + on-device pilot), which needs a
named tablet + a test salon from the owner** — not more feature packets.

### Wave E2 — salon mode (services, staff-per-service, bookings/check-in)
The nail-salon core. All templates already exist in the renderer; we port the
shim methods they call.
- **E2a Salon template**: `posMode='salon'` (or a per-device toggle), services
  catalog + service-based cart, per-service staff assignment.
- **E2b Customers**: lookup/create/history (routes exist).
- **E2c Bookings / check-in**: walk-in + booked queue, check-in flow (backend
  booking routes exist). This is what makes it a salon POS, not a till.

### Wave E3 — Polish invoicing (VAT)
- **E3a**: NIP/GUS lookup, add-invoice, generate-proforma, invoice/receipt PDF.
  All backend routes exist; the OrderHistoryModal UI is already there.

### Wave E4 — products / inventory admin (retail upsell for the salon)
- **E4a Reads**: product-admin catalog view, stock levels, categories admin
  (read-only) — client-portable.
- **E4b Writes**: create/edit product, stock adjust, scan-import. **Backend-
  gated** — Windows uses the `pa_` key for these; needs a staff-JWT product-
  admin contract. Draft server change request; ship reads first.

### Wave E5 — backend-gated production features (need the backend track first)
Not client work until the eNail backend P0s land through the guarded lane:
- **E5a Electronic payment** CARD/BLIK/split — after P0-PAY-1 (capture proof).
- **E5b Fiscal print** — after P0-FISCAL-1/2 (tenant-safe + UNKNOWN status).
- **E5c Terminal gate + reliable shift** — after P0-GATE-1, P0-SHIFT-1/2.
These are the register-blocked items already tracked in
`OPEN_BACKEND_CONTRACT_DECISIONS.md`; I prepare the client side + tests but
they stay dark until the backend is deployed and verified.

### Wave E6 — packaging + device pilot (from the original plan)
- **S11 device polish** (rotation/back/keyboard parity), **S12 sideload APK**,
  then Play flavor (owner decisions: applicationId/Play/signer), then the
  M6 on-device smoke and a shadow pilot on the test salon.

### Wave B-1 — billiard (Bi-a), online-only — SHIPPED 2026-07-21
Billiard was originally in the "Explicitly NOT planned" list below (nail-salon
profile, 2026-07-19). It shipped as a self-contained online-only wave on branch
`codex/android-billiard-port` (plan: `2026-07-21-billiard-android-port-plan.md`).
It is gated by the `billiard` entitlement and is **online-only** — it is NOT the
offline-capable, locally-cached billiard the Windows agent runs.

**What shipped (P1):**
- **Shim namespace + synthetic defaults** (`src/renderer/android-pos/shim/stubs.ts`):
  `buildBilliardNamespace` + `buildApiCall`, wired in `index.ts`. Reads degrade to
  benign empty/offline defaults so the renderer boots with no network; **writes
  reject** — `billiard.mutate` and `apiCall` throw a network-required error when no
  transport is present (money path: never fake a charge — the server is the source
  of truth).
- **Online-only transport** (`billiard-transport.ts`, spread into the real transport):
  reads hit the backend through the staff-JWT `PosApiClient` with a 10s dashboard
  poll (matches Windows `billiard-sync.ts:163`) + in-memory cache; writes
  (`billiard.mutate`) go **straight through** with the real error surfaced (no local
  SQLite cache, no offline mutation queue — that is the Windows agent's job).
  `apiCall` is allowlisted to `/billiard/`, `/resources/`, `/restaurant/` prefixes
  and rejects path traversal / other routes.
- **Entitlement-gated POS ⟷ Bi-a mode tabs** (`AndroidBootApp.tsx`): when
  `entitlements.get().features.billiard.enabled`, a POS/Bi-a tab nav mounts the
  unmodified `BilliardFloorPlan` (mode persists in `localStorage`); without the
  entitlement it renders plain `POSApp` exactly as before.
- **`printReceipt` is off the money path.** Android has no local receipt printer, so
  the billiard `printReceipt` mirrors the Windows no-printer literal
  (`{ success:true, receiptPrinted:false }`); the backend dispatches the real
  receipt. `PaymentDialog` treats `receiptPrinted:false` as "payment done, receipt
  skipped", so settlement never blocks on printing.

**Explicitly out — Wave B-2 candidates (not shipped):**
- **Offline queue** — P1 has no offline mode; network loss = stale read-only floor
  view + mutations fail loudly. Owner-decision-gated before live salon use (see
  `production-readiness-register.json` `billiard-online-only`).
- **Local printer / cash-drawer hardware** — no Android ESC/POS or drawer driver.
- **Aux namespaces** (`reservation`, `happyHour`, `kds`, `stock`, `sessionHistory`,
  `billiardGuest`, `dailyReport`) — deliberately left `undefined`; the UI calls them
  via `?.` optional chaining, so they are dark-launch-safe.
- **F&B product route** — `/billiard/fnb/*` is not deployed (verified 404 in the
  contract spike), so the add-item product list renders empty until a real backend
  route ships.

See `SHIM_CONTRACT_S1.md §2.N` for the per-method contract.

## Explicitly NOT planned (out of scope for a nail salon)
Restaurant/kitchen/tables/pickup, B2B wholesale, self-checkout kiosk, customer
second-screen, direct hardware drivers. (Billiard was on this list until Wave B-1
shipped it online-only on 2026-07-21 — see above.) If the business later needs
one of the rest, it becomes its own wave — none is on this roadmap.

## Decision (owner, 2026-07-19)
- **E1 and E2 run in parallel.** Packets are sequenced to avoid file collision
  on the shared shim (transport.ts / stubs.ts / real-transport.ts): read-only
  inventory packets and new self-contained modules parallelize freely; packets
  that edit the same shared file are serialized. Both waves progress.
- **Backend-gated features (E4b, E5): client-prep + server request.** I build
  and test the client half, write the exact server change request per item
  (eNail CLAUDE.md template), and leave it dark behind a flag until the backend
  is deployed and verified. Requests go to Paul to forward to backend IT.

### claude-glm conveyor rules (revised 2026-07-19 after usage-limit incidents)
- **ONE claude-glm run at a time. Never launch a second while one is running.**
  Parallel GLM runs hit the Z.ai usage limit; a throttled run stalls, and a
  killed run's child process keeps writing files under the supervisor — the
  E1a/E1b/E2a chaos. Sequential single-run avoids both.
- **Wait for the run to fully complete; do not kill it as "stalled".** GLM runs
  are slow (the acceptance phase alone is minutes). If a takeover is truly
  needed, `pkill -9 -f claude-glm` ALL matches, then verify the file md5 is
  stable over several seconds before editing.
- **Trust tsc + vitest, not IDE diagnostics** during/after a GLM run — the
  language server lags file writes and reports stale "does not exist" errors.
- Packets small enough for the supervisor to do reliably (thin layers, wiring,
  test-only) are done directly, no GLM — faster than reconciling half-writes.

### Execution order (collision-aware)
1. E1a remote receipt print (new remote-print coordinator module + print
   namespace wiring) ‖ E2-inventory (read-only doc: SalonTemplate + bookings
   electronAPI surface).
2. E1b refund/void ‖ E2a salon template (services/staff-per-service cart).
3. E1c history depth ‖ E2b customers.
4. E3 invoicing ‖ E2c bookings/check-in.
5. E4a product-admin reads; E4b writes → server request.
6. E5 backend-gated (electronic pay, fiscal, terminal gate) → client-prep +
   server requests.
7. E6 device polish + sideload + pilot.

## Reality checks kept honest
- Backend-gated waves (E5, E4b) cannot be "finished" on the client alone. I
  will build + test the client half and draft the exact server change request,
  but they are not done until the eNail backend ships.
- "Complete then test" still ends at a real device + test salon. Each wave adds
  unit/contract tests, but device verification (M6) remains the gate before any
  real salon — unit-green is not field-proven.
