# Print Journal — which printer printed each order (`print_attempts`)

**Date:** 2026-06-02
**Status:** Implemented (local-only, no backend change)

## Problem

POS-zira does not record which printer printed an order. `orders` has no
printer column; fiscal prints are journaled in `fiscal_attempts` (rich
tax-device status), but the non-fiscal order/receipt copy has no journal. So
"was this order printed, and on which printer?" can only be inferred from the
payment flow or logs.

## Goal

Record, per order, which printer each document copy was sent to and whether it
printed; show it in Order History as badges (Order: Xprinter XP-80T · Fiscal:
ELZAB COM3 · Failed · Not printed).

## Key code facts (verified)

- Receipt prints flow through `PaymentController` methods: `printReceipt`
  (BLIK/card copy), `printReceiptAndOpenDrawer` (CASH — its own logic, NOT
  `printReceiptData`), `reprintReceipt`, `printRefundReceipt`. CASH must be
  journaled in `printReceiptAndOpenDrawer`, not only `printReceiptData`.
- Fiscal prints are journaled at the **ELZAB driver** level into
  `fiscal_attempts` (createPending → markSent → markSuccess/Failed/Unknown +
  reconciliation). `printFiscalReceipt` only returns boolean/throws.
- `PaymentController` is config-decoupled (constructor-injected). The host
  (`pos.module`) owns config, so the journal write is injected as a callback.
- `fiscal_attempts` is LOCAL-only (no backend sync); `print_attempts` matches.

## Design (union)

- New local table `print_attempts` (migration v38): id, order_id,
  document_type (ORDER|REPRINT|REFUND), printer_type, printer_name,
  printer_target, route (LOCAL|SHARED_NETWORK), status (PRINTED|FAILED|
  NO_PRINTER), error, created_at. Cleared on salon switch (tenant isolation).
- `printAttemptRepo` mirrors `fiscalAttemptRepo`: record / findByOrder /
  findLatestByOrder.
- `PaymentController` reports each receipt outcome via injected
  `recordPrintAttempt`. `pos.module` resolves the configured printer's
  name/target from config (or the shared printerId) and persists the row.
- Fiscal stays in `fiscal_attempts`; added `findLatestByOrder` + IPC
  `pos:fiscal:get-latest` (enriched with the configured fiscal printer label).
- Order History unions both: per-document badges in the Printing section.

## Backend

No change. Printers + print agent are local; both journals are local SQLite.
A backend column + sync would only be needed to show printer info on the web
dashboard (out of scope).

## Caveats

- Receipt history is not backfillable (no prior journal) → old orders show
  "Not printed"; inferred by flow as before. Fiscal badges DO work
  retroactively (fiscal_attempts already has history).

## Files

`migrations.ts` (v38), `database.ts` (clear list), `print-attempt-repo.ts`
(new), `fiscal-attempt-repo.ts` (findLatestByOrder), `payment-controller.ts`
(callback + journaling), `pos.module.ts` (resolver + IPC), `preload*.ts`,
`electron.d.ts`, `OrderHistoryModal.tsx` (badges), `translations.ts` (en/pl/vi),
`tests/print-attempt-repo.test.ts`.
