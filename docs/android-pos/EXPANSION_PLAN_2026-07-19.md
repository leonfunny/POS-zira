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

## Explicitly NOT planned (out of scope for a nail salon)
Restaurant/kitchen/tables/pickup, billiard, B2B wholesale, self-checkout kiosk,
customer second-screen, direct hardware drivers. If the business later needs
one, it becomes its own wave — none is on this roadmap.

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
