# SCR: Magazyn module for Polish warehouse documents

Date: 2026-05-20
Owner: backend + desktop
Status: draft, blocked on backend contract

## Summary

Build a proper `Magazyn` module for Zira POS covering warehouse documents used in Polish inventory practice: PZ, WZ, RW, PW, MM, and inwentaryzacja / spis z natury. This must not be implemented as direct local edits to `product_variants.in_stock`. The backend must own numbering, posting, stock movements, audit trail, warehouse scoping, and export-ready document records. The desktop app should be a scanner-first workspace that drafts, validates, posts, prints, and syncs those backend-owned documents.

The user's wording mentioned `RX` and `PX`. This spec treats that as a likely shorthand/typo for `RW` and `PW`. Official JPK_MAG guidance recognizes PZ, WZ, RW, and MM as warehouse evidence types. PW is still common in Polish warehouse systems as an internal receipt, but for official JPK_MAG/export mapping the backend must decide whether internal increases are represented as PZ or a separate non-JPK internal document mapped into the accounting layer.

## Current desktop findings

The POS catalog source of truth is already the backend, mirrored locally into SQLite for fast/offline sales. The current local cache is `product_variants`, with stock columns `in_stock` and `available_qty`. Product reads are exposed through `productRepo`, while sales decrement local stock after order creation. Product sync pulls `/api/v1/warehouse/public/products` and updates `product_variants`; sync-log applicators already know how to apply `entity_type='stock'` by setting or delta-updating local stock.

Relevant local code:

- `src/main/database/migrations.ts`: `product_variants`, `draft_products`, `local_variant_imports`.
- `src/main/database/repos/product-repo.ts`: local product/category read model and stock increment/decrement helpers.
- `src/main/network/api-client.ts`: product sync, master catalog lookup, scan-create, quick-add.
- `src/main/modules/pos.module.ts`: POS IPC, product reads, scan-create, order create stock decrement.
- `src/main/sync/entity-applicators.ts`: inbound sync-log support for `product`, `stock`, `order`, and other entities.
- `src/main/modules/sync.module.ts`: 30 second product polling and local import reconciliation.
- `src/renderer/App.tsx`, `src/renderer/components/Sidebar.tsx`, `src/shared/types.ts`, `src/preload/preload.ts`: places that would need a new tab/API surface once backend exists.

Important constraint: `accounting_products` belongs to the invoice module and must not be merged with POS `product_variants`. A warehouse module must operate on the POS catalog variants that sales, self-checkout, refunds, labels, and customer display already use.

## Legal/accounting baseline for Poland

This is not legal advice, but the implementation must at least preserve the following constraints from Polish public guidance and accounting rules.

JPK_MAG guidance from podatki.gov.pl describes four warehouse evidence types: `PZ` increases warehouse stock, `WZ` decreases stock for external release, `RW` decreases stock for internal use, and `MM` records inter-warehouse transfer increases/decreases. It also states that these documents are the basis for recording warehouse operations in accounting books and that draft/buffer documents are not included in JPK_MAG until they are posted into books.

The same guidance states that JPK_MAG is per separated warehouse and should reflect warehouse documents for the given warehouse. It also says PZ/WZ are linked respectively to purchase/sales invoices, while RW is internal consumption and MM is inter-warehouse movement.

Accounting document requirements under the Accounting Act art. 21 include at minimum document type/number, parties, operation description and value when possible with natural units, operation date and issue date if different, signatures/identification of issuer and receiver/releaser of assets, and bookkeeping classification/dekretacja where applicable. Foreign-currency documents need PLN conversion if applicable.

For inwentaryzacja / spis z natury, public tax guidance says the physical inventory list has no fixed form but must contain company name, inventory date, row number, detailed item description/category, unit, counted quantity, unit price in PLN grosze, row value, total value, a closing clause such as `Spis zakonczono na pozycji...`, and signatures of persons preparing the count and the owner/partners. The system should store enough data to print that list and explain differences before posting corrections.

Sources:

- Ministerstwo Finansow, JPK_MAG document types: https://www.podatki.gov.pl/jednolity-plik-kontrolny/pytania-i-odpowiedzi/jpk-mag/czy-w-strukturze-jpk_mag-raportowaniu-podlegaja-wylacznie-wskazane-rodzaje-dokumentow-czy-i-w-jaki-sposob-wykazac-np-przyjecie-z-wewnatrz/
- Ministerstwo Finansow, JPK_MAG per warehouse and PZ/WZ/RW/MM meaning: https://www.podatki.gov.pl/jednolity-plik-kontrolny/pytania-i-odpowiedzi/jpk-mag/czy-dla-rozroznienia-plikow-jpk-mag-zastosowanie-maja-magazyny-ksiegowe-czy-fizyczne-w-przedsiebiorstwie/
- Ministerstwo Finansow, JPK_MAG buffer/draft documents and quantity-value records: https://www.podatki.gov.pl/podatki-firmowe/jednolity-plik-kontrolny/jpk_vat/pytania-i-odpowiedzi-jpk_vat/
- ELI legal text, Accounting Act art. 21: https://eli.gov.pl/api/acts/DU/2021/217/text.html
- podatki.gov.pl, spis z natury required contents for liquidation inventory: https://www.podatki.gov.pl/dzialalnosc-gospodarcza/likwidacja-podatnik-vat/

## Required document types

### PZ - przyjecie zewnetrzne

Purpose: receive goods into a warehouse, usually from a supplier/purchase invoice or delivery note. It increases stock. It must support scanner-first receiving, partial quantities, supplier data, source document number, costs, VAT rate, and optional label printing.

Posting effect: positive stock movement per line. The backend returns posted document number, posted timestamp, stock movement ids, new stock by variant, and print/export payload.

### WZ - wydanie zewnetrzne

Purpose: release goods out of the warehouse to an external receiver, usually tied to a sales invoice/order, delivery note, transfer to customer, or manual external release. It decreases stock and should block or warn on negative stock unless a manager override is explicitly configured.

Posting effect: negative stock movement per line. WZ must store receiver data separately from buyer data when they differ, because public JPK guidance says WZ receiver should reflect the original WZ content.

### RW - rozchod wewnetrzny

Purpose: internal consumption, damage, shrinkage, staff use, kitchen/use-of-materials, or other non-sale decrease. It decreases stock and requires reason codes.

Posting effect: negative stock movement per line with reason. For loss/damage, the UI should require a note and manager confirmation above a threshold.

### PW - przyjecie wewnetrzne

Purpose: internal increase, production output, found stock, unpacking/breaking bulk to units, or positive inventory difference. It increases stock. PW is common operationally, but official export mapping must be decided backend-side because JPK_MAG's public FAQ names PZ for stock increases.

Posting effect: positive stock movement per line with reason and optional source process.

### MM - przesuniecie miedzymagazynowe

Purpose: transfer between separated warehouses. It must have a source warehouse and target warehouse and produce balanced movements. A single logical MM document should decrease source and increase target atomically.

Posting effect: paired stock movements with one document number and warehouse-specific export visibility.

### Inwentaryzacja / spis z natury

Purpose: count actual stock, compare to book stock, explain differences, print the physical inventory sheet, and then post corrections. Counting itself must not change stock. Posting differences creates adjustment documents:

- positive differences should become PW or backend-mapped PZ/internal increase,
- negative differences should become RW,
- every difference requires reason/status before posting.

The count should support scanner mode, manual count, freeze snapshot, recount, approval, and final posting.

## Backend contract

The desktop app needs these endpoints. Paths are proposed under `/api/v1/warehouse`.

### Warehouse setup

`GET /api/v1/warehouse/warehouses`

Returns warehouses available to the salon/company and the default warehouse for this POS.

```json
{
  "warehouses": [
    {
      "id": "uuid",
      "code": "MAIN",
      "name": "Magazyn glowny",
      "isDefault": true,
      "isActive": true
    }
  ]
}
```

### Document create/update

`POST /api/v1/warehouse/documents`

Creates a draft document. Required fields depend on type.

```json
{
  "type": "PZ",
  "warehouseId": "uuid",
  "targetWarehouseId": null,
  "sourceDocumentNo": "FV/123/2026",
  "contractor": {
    "name": "Supplier sp. z o.o.",
    "nip": "1234567890",
    "address": "..."
  },
  "operationDate": "2026-05-20",
  "notes": "",
  "idempotencyKey": "uuid"
}
```

`PATCH /api/v1/warehouse/documents/:id`

Updates header while draft.

`PUT /api/v1/warehouse/documents/:id/lines`

Replaces draft lines. The backend should validate variant existence, duplicate lines, unit/cost formats, and stock availability for negative documents.

```json
{
  "lines": [
    {
      "variantId": "uuid",
      "barcode": "590...",
      "name": "Coca Cola 500ml",
      "unit": "szt",
      "quantity": 12,
      "unitCostNetGrosze": 250,
      "unitValueGrosze": 307,
      "vatRate": 23,
      "reason": null
    }
  ]
}
```

`POST /api/v1/warehouse/documents/:id/post`

Atomically posts the document. This endpoint must be idempotent. It must assign a final number from the correct per-warehouse series, create stock movements, update stock quants, write audit records, and emit sync events.

Response:

```json
{
  "document": {
    "id": "uuid",
    "type": "PZ",
    "number": "PZ/MAIN/2026/000123",
    "status": "POSTED",
    "warehouseId": "uuid",
    "operationDate": "2026-05-20",
    "postedAt": "2026-05-20T18:22:00.000Z"
  },
  "movements": [
    {
      "id": "uuid",
      "variantId": "uuid",
      "warehouseId": "uuid",
      "delta": 12,
      "newStock": 42
    }
  ]
}
```

`POST /api/v1/warehouse/documents/:id/cancel`

Only allowed for draft, or for posted documents through a correction/reversal flow. Do not hard-delete posted documents.

### Listing, detail, print, export

`GET /api/v1/warehouse/documents?type=&warehouseId=&status=&from=&to=&search=&page=&limit=`

`GET /api/v1/warehouse/documents/:id`

`GET /api/v1/warehouse/documents/:id/print`

Returns a normalized print payload for local A4/thermal/PDF rendering. The payload must include legal/accounting fields: type, number, warehouse, source/target warehouse, contractor/receiver, issue date, operation date, created/posted by, line quantities, units, values, total value, signatures/identification placeholders, and optional dekretacja block.

`GET /api/v1/warehouse/jpk-mag?warehouseId=&from=&to=`

Later phase. It should export only posted PZ/WZ/RW/MM documents, not drafts. If backend does not support JPK_MAG in the first phase, it must at least persist all fields needed for export.

### Inventory count

`POST /api/v1/warehouse/inventory-counts`

Creates a draft inventory count and freezes expected stock snapshot for selected warehouse/scope.

`PUT /api/v1/warehouse/inventory-counts/:id/lines`

Updates counted quantities. Scanner mode can send incremental lines or full replacement; server must keep final count deterministic.

`POST /api/v1/warehouse/inventory-counts/:id/reconcile`

Returns differences without posting stock changes.

`POST /api/v1/warehouse/inventory-counts/:id/post`

Posts corrections. Positive differences become internal receipt mapping; negative differences become RW. Backend must return the generated document ids/numbers.

`GET /api/v1/warehouse/inventory-counts/:id/print`

Returns spis z natury print payload with required rows, totals, closing clause, and signatures.

## Sync requirements

Backend must emit one or both of these mechanisms after posting:

1. Product sync visibility: `/api/v1/warehouse/public/products?since=` returns variants with updated `totalStockQty` / `availableQty` and a reliable `nextSince`.
2. Sync log visibility: emit `entity_type='stock'` entries with either `newStock` or `delta`; the desktop applicator already supports both shapes.

For posted document history, add sync-log entity type `warehouse_document` so desktop can show recent documents offline without refetching every time.

Payload sketch:

```json
{
  "entity_type": "warehouse_document",
  "entity_id": "uuid",
  "event": "posted",
  "payload": {
    "type": "PZ",
    "number": "PZ/MAIN/2026/000123",
    "warehouseId": "uuid",
    "operationDate": "2026-05-20",
    "lines": [
      {
        "variantId": "uuid",
        "name": "Coca Cola 500ml",
        "quantity": 12,
        "unit": "szt",
        "delta": 12,
        "newStock": 42
      }
    ]
  }
}
```

## Desktop implementation plan after backend lands

### Main process

Add:

- `src/main/modules/warehouse.module.ts`
- `src/main/warehouse/warehouse-api.ts` or ApiClient methods
- `src/main/database/repos/warehouse-document-repo.ts`

IPC namespaces:

- `warehouse:warehouses:list`
- `warehouse:documents:list`
- `warehouse:documents:get`
- `warehouse:documents:create`
- `warehouse:documents:update`
- `warehouse:documents:set-lines`
- `warehouse:documents:post`
- `warehouse:documents:cancel`
- `warehouse:documents:print`
- `warehouse:inventory:create`
- `warehouse:inventory:set-lines`
- `warehouse:inventory:reconcile`
- `warehouse:inventory:post`
- `warehouse:inventory:print`

The module should call backend first for every stock-changing operation. Local SQLite is a read-through cache and draft convenience only.

### Renderer

Add:

- `src/renderer/components/warehouse/WarehouseTab.tsx`
- `src/renderer/components/warehouse/WarehouseDocumentList.tsx`
- `src/renderer/components/warehouse/WarehouseDocumentEditor.tsx`
- `src/renderer/components/warehouse/WarehouseScannerInput.tsx`
- `src/renderer/components/warehouse/WarehouseLineTable.tsx`
- `src/renderer/components/warehouse/InventoryCount.tsx`
- `src/renderer/hooks/useWarehouse.ts`

UI should be operational, not ERP-heavy. First screen should be the workbench:

- segmented type selector: PZ, WZ, RW, PW, MM, Inwentaryzacja,
- large focused scan/input field,
- warehouse selector,
- document header drawer,
- dense line table,
- review/post panel,
- document history on the side or separate tab.

For a small shop user, show action labels in plain language:

- `Przyjmij towar` / `Nhap hang` for PZ,
- `Wydaj towar` / `Xuat hang` for WZ,
- `Zuzycie / Strata` for RW,
- `Przyjecie wewnetrzne` for PW,
- `Przesuniecie` for MM,
- `Spis z natury` for inwentaryzacja.

### Validation rules

Client-side validation is only UX; backend remains authoritative.

- Require warehouse for every document.
- Require source and target warehouse for MM and they must differ.
- Require contractor/receiver for WZ/PZ when linked to external document.
- Require source document number for PZ/WZ when tied to purchase/sales invoice or delivery note.
- Require positive quantity.
- Require unit; default from `sale_unit`, fallback `szt`.
- Store money in integer grosze.
- Do not allow posting an empty document.
- Do not allow negative stock without backend-approved override.
- Drafts may be edited. Posted documents are immutable; corrections/reversals create new records.
- Inventory count posting requires reviewed difference reasons.

## Local schema after backend exists

These local tables are only cache/draft support, not authoritative stock:

```sql
CREATE TABLE warehouse_documents (
  id TEXT PRIMARY KEY,
  server_id TEXT,
  type TEXT NOT NULL,
  number TEXT,
  source_document_no TEXT,
  warehouse_id TEXT NOT NULL,
  target_warehouse_id TEXT,
  contractor_json TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  operation_date TEXT NOT NULL,
  issue_date TEXT,
  posted_at TEXT,
  created_by TEXT,
  notes TEXT,
  total_value_grosze INTEGER DEFAULT 0,
  sync_error TEXT,
  updated_at TEXT
);

CREATE TABLE warehouse_document_lines (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  variant_id TEXT,
  barcode TEXT,
  sku TEXT,
  name TEXT NOT NULL,
  unit TEXT DEFAULT 'szt',
  quantity REAL NOT NULL,
  unit_value_grosze INTEGER DEFAULT 0,
  vat_rate INTEGER,
  reason TEXT,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (document_id) REFERENCES warehouse_documents(id) ON DELETE CASCADE
);

CREATE TABLE inventory_counts (
  id TEXT PRIMARY KEY,
  server_id TEXT,
  number TEXT,
  warehouse_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  count_date TEXT NOT NULL,
  created_by TEXT,
  posted_at TEXT,
  notes TEXT,
  snapshot_json TEXT,
  updated_at TEXT
);

CREATE TABLE inventory_count_lines (
  id TEXT PRIMARY KEY,
  count_id TEXT NOT NULL,
  variant_id TEXT,
  barcode TEXT,
  sku TEXT,
  name TEXT NOT NULL,
  unit TEXT DEFAULT 'szt',
  expected_quantity REAL NOT NULL DEFAULT 0,
  counted_quantity REAL NOT NULL DEFAULT 0,
  difference_quantity REAL NOT NULL DEFAULT 0,
  unit_value_grosze INTEGER DEFAULT 0,
  reason TEXT,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (count_id) REFERENCES inventory_counts(id) ON DELETE CASCADE
);
```

## Print templates

The desktop can render A4/PDF/HTML once backend returns payloads. Each document printout should include:

- company/seller details from config/backend,
- document type and final number,
- warehouse code/name,
- issue date and operation date,
- contractor/receiver or source/target warehouse,
- source document number if present,
- line number, item name, SKU/barcode, unit, quantity, unit value, line value, VAT if relevant,
- total value,
- created/posted by,
- signature placeholders or electronic identity markers,
- accounting/dekretacja placeholder when required by the business process.

For inwentaryzacja, include row numbers, counted quantity, unit price, row value, total value, `Spis zakonczono na pozycji ...`, and signature placeholders.

## Acceptance criteria

1. Posting PZ increases backend stock exactly once and POS product grid refreshes without app restart.
2. Posting WZ/RW decreases backend stock exactly once and prevents accidental negative stock.
3. Posting PW increases stock with an internal reason and is export-mapped consistently by backend.
4. Posting MM atomically decreases source warehouse and increases target warehouse.
5. Inventory count can be drafted, printed, reconciled, and posted into adjustment documents only after review.
6. Draft/buffer documents are never included in export payloads.
7. Posted documents are immutable; corrections/reversals are separate records.
8. Every posted document has a stable final number, warehouse, dates, parties where applicable, line quantities, values, audit identity, and print payload.
9. ProductSync or sync-log stock entries update `product_variants.in_stock` / `available_qty` on the desktop.
10. TypeScript checks pass after desktop implementation: `npm run typecheck:renderer` and `npm run build:main`.

## Why desktop-only implementation is rejected

Directly updating local `product_variants.in_stock` would work only on one till and only until the next sync. It would not create official document numbering, stock movement ids, warehouse-scoped records, audit trail, JPK_MAG-ready data, multi-device consistency, or durable print/export documents. It would also conflict with the current architecture where backend catalog/stock is authoritative and the desktop product table is a mirror.
