# Server Change Request: Product Module Mutations

Date: 2026-05-20
Client repo: `POS-zira`
Requester: codex

## Summary

The desktop POS can already read and sync the sellable catalog through `/api/v1/warehouse/public/products`, import draft products through `/api/v1/master-catalog/scan-create`, and use quick-add image flows. The new Products module needs normal product administration mutations, but this client repo does not currently expose a confirmed general update/deactivate/stock/category mutation contract.

Do not implement these operations as local-only SQLite edits in the desktop app. The backend catalog remains the source of truth.

Machine-readable companion spec: `docs/server-change-requests/2026-05-20-product-admin.openapi.yaml`.

## Scope

This request covers only product administration needed by the desktop POS Products module:

- Runtime capability detection.
- Product/variant create.
- Product/variant field update.
- Soft deactivate/hide from POS.
- Stock adjustment with audit reason.
- Category list/create/update.
- Delta sync or realtime notifications after every mutation.

This request does not cover CSV import/export, full variant matrix editing, supplier purchasing, accounting product templates, or fiscal receipt payload changes.

## Existing Client Constraints

The server implementation must preserve these desktop invariants:

- Money is compared and stored locally in integer grosze. If the API accepts decimal PLN for operator ergonomics, the backend must return an unambiguous minor-unit value too, such as `priceGrossGrosze`.
- Canonical `name` is used for POS orders, receipts, fiscal payloads, and invoice matching. `nameTranslations` is display-only and must not replace canonical `name`.
- Product rows must map to the existing local `ProductVariantRow` shape: id, template id, display/canonical name, barcode, SKU, category, gross price, VAT, stock, active status, updated timestamp, sale unit, image/thumbnail, and optional translations.
- Draft import is already offline-first through `draft_products` and `local_variant_imports`. Product-admin create/update must not break draft reconciliation.
- Historical orders must remain renderable after a product is deactivated.

## Authentication And Tenant Context

All endpoints must require the same authenticated salon context used by the existing POS catalog APIs:

- `Authorization: Bearer <JWT>` is required.
- `X-Salon-Slug` should be accepted when present.
- `X-Salon-Code` should be accepted when present.
- `X-Agent-Id` should be accepted when present, especially for audit trails and stock adjustments.
- Mutating endpoints must accept `Idempotency-Key: <uuid>` where noted.

If both salon slug and salon code are present, the backend should resolve them to one tenant and reject mismatches with `409 SALON_CONTEXT_MISMATCH`.

## Required Capability Endpoint

Add a lightweight capability endpoint so older backend deployments and tenants can be detected at runtime:

`GET /api/v1/warehouse/product-admin/capabilities`

Response:

```json
{
  "version": 1,
  "canCreateProduct": true,
  "canUpdateProduct": true,
  "canDeactivateProduct": true,
  "canAdjustStock": true,
  "canCreateCategory": true,
  "canUpdateCategory": true,
  "supportsOptimisticConcurrency": true
}
```

The client will keep edit/stock/category controls disabled unless the capability is present and true. If a tenant has partial support, set only the supported booleans to `true`. Never return `true` for a capability whose mutation route is not ready in production.

Recommended response status behavior:

- `200`: capability object returned.
- `401`: unauthenticated.
- `403`: authenticated user or tenant cannot administer products.
- `404` or `501`: old backend or route not implemented. The desktop treats this as fail-closed.

## Required Endpoints

### Create Product/Variant

`POST /api/v1/warehouse/product-admin/products`

Headers:

- `Authorization: Bearer <JWT>`
- `X-Salon-Slug` when available
- `X-Salon-Code` when available
- `Idempotency-Key: <uuid>`

Request:

```json
{
  "name": "Coca Cola 500ml",
  "barcode": "5900000000000",
  "sku": "COCA-500",
  "retailPrice": 5.99,
  "priceGrossGrosze": 599,
  "vatRate": 23,
  "initialStockQty": 12,
  "categoryId": "uuid-or-null",
  "saleUnit": "szt",
  "imageUrl": null
}
```

Response:

```json
{
  "product": {
    "id": "template-uuid",
    "name": "Coca Cola 500ml",
    "categoryId": "uuid-or-null"
  },
  "variant": {
    "id": "variant-uuid",
    "templateId": "template-uuid",
    "name": "Coca Cola 500ml",
    "sku": "COCA-500",
    "barcode": "5900000000000",
    "priceGrossGrosze": 599,
    "retailPrice": 5.99,
    "vatRate": 23,
    "categoryId": "uuid-or-null",
    "totalStockQty": 12,
    "availableQty": 12,
    "isActive": true,
    "saleUnit": "szt",
    "imageUrl": null,
    "thumbnailUrl": null,
    "updatedAt": "2026-05-20T12:00:00.000Z",
    "version": 1
  },
  "serverTime": "2026-05-20T12:00:00.000Z"
}
```

`variant` must include enough data for the client to map to `ProductVariantRow`: id, templateId, name, sku, barcode, retailPrice/priceGross, categoryId, imageUrl, totalStockQty/availableQty, taxRate/vatRate, isActive, updatedAt, saleUnit, thumbnailUrl, optional nameTranslations.

Validation rules:

- `name` is required and should be trimmed.
- `barcode` is optional but, when provided, must be unique within the salon/location sellable catalog.
- `sku` is optional but, when provided, must be unique within the salon/location sellable catalog.
- Gross price must be non-negative. To be sellable in POS, it should be positive unless the backend explicitly allows zero-price service/items.
- `initialStockQty` must be a non-negative number.
- VAT must be one of the tenant-supported VAT rates.
- If both `retailPrice` and `priceGrossGrosze` are provided, backend must reject mismatches instead of silently rounding.

Recommended statuses:

- `201`: created.
- `400`: validation failure.
- `401`/`403`: auth failure.
- `409 DUPLICATE_BARCODE` or `409 DUPLICATE_SKU`: duplicate conflict.
- `422`: unsupported VAT, invalid category, or invalid stock quantity.

### Update Product/Variant

`PATCH /api/v1/warehouse/product-admin/variants/:variantId`

Request:

```json
{
  "name": "Coca Cola 500ml",
  "barcode": "5900000000000",
  "sku": "COCA-500",
  "retailPrice": 5.99,
  "priceGrossGrosze": 599,
  "vatRate": 23,
  "categoryId": "uuid-or-null",
  "saleUnit": "szt",
  "imageUrl": null,
  "isActive": true,
  "expectedUpdatedAt": "2026-05-20T11:30:00.000Z",
  "expectedVersion": 3
}
```

Use optimistic concurrency. The backend may use `expectedVersion`, `expectedUpdatedAt`, or both, but it must document which field is authoritative. If the provided version/timestamp is stale, return `409 STALE_PRODUCT` with the current product/variant payload and a field-level conflict summary.

Response:

```json
{
  "variant": {
    "id": "variant-uuid",
    "templateId": "template-uuid",
    "name": "Coca Cola 500ml",
    "sku": "COCA-500",
    "barcode": "5900000000000",
    "priceGrossGrosze": 599,
    "vatRate": 23,
    "categoryId": "uuid-or-null",
    "totalStockQty": 12,
    "availableQty": 12,
    "isActive": true,
    "saleUnit": "szt",
    "imageUrl": null,
    "thumbnailUrl": null,
    "updatedAt": "2026-05-20T12:05:00.000Z",
    "version": 4
  },
  "serverTime": "2026-05-20T12:05:00.000Z"
}
```

Field update rules:

- Omitted fields mean "leave unchanged".
- Explicit `null` is allowed only for nullable fields such as `barcode`, `sku`, `categoryId`, `imageUrl`, and `thumbnailUrl`.
- Stock must not be updated through this endpoint. Use stock adjustments.
- Deactivation should preferably use the dedicated deactivate endpoint so the backend can capture reason/audit metadata.

### Deactivate Product/Variant

`POST /api/v1/warehouse/product-admin/variants/:variantId/deactivate`

Request:

```json
{
  "expectedUpdatedAt": "2026-05-20T11:30:00.000Z",
  "expectedVersion": 3,
  "reason": "No longer sold"
}
```

This must be a soft deactivate/hide from POS, not a hard delete. Historical orders, refunds, receipts, invoices, and fiscal payloads must continue to resolve the old variant id.

Response must include the updated inactive variant row and `serverTime`.

Recommended behavior:

- Inactive products should be excluded from normal POS selling payloads unless explicitly requested by admin/history views.
- Existing order history should still include the old product name/variant id.
- Duplicate checks should continue to protect barcode/SKU reuse unless backend has an explicit archival policy.

### Adjust Stock

`POST /api/v1/warehouse/product-admin/variants/:variantId/stock-adjustments`

Headers include `Idempotency-Key`.

`reason` is an optional operator note for all modes. When omitted, the backend must store a stable mode-based audit reason; when present, the backend stores and returns the trimmed note.

Request variants:

```json
{
  "mode": "receive",
  "quantity": 10,
  "expectedUpdatedAt": "2026-05-20T11:30:00.000Z",
  "expectedVersion": 3
}
```

```json
{
  "mode": "recount",
  "newQuantity": 17,
  "reason": "Manual count",
  "expectedUpdatedAt": "2026-05-20T11:30:00.000Z",
  "expectedVersion": 3
}
```

```json
{
  "mode": "damage",
  "quantity": 2,
  "expectedUpdatedAt": "2026-05-20T11:30:00.000Z",
  "expectedVersion": 3
}
```

Supported modes:

- `receive`: increment stock by positive `quantity`.
- `recount`: set exact stock to non-negative `newQuantity`.
- `damage`: decrement by positive `quantity`.
- `loss`: decrement by positive `quantity`.
- `return`: increment stock by positive `quantity` for customer returns restored to sellable stock.

Response includes updated variant row, previous quantity, new quantity, adjustment id, and serverTime.

Response:

```json
{
  "adjustment": {
    "id": "adjustment-uuid",
    "variantId": "variant-uuid",
    "mode": "receive",
    "quantityDelta": 10,
    "previousQuantity": 12,
    "newQuantity": 22,
    "reason": "Delivery",
    "createdAt": "2026-05-20T12:10:00.000Z",
    "createdBy": "user-or-agent-id"
  },
  "variant": {
    "id": "variant-uuid",
    "totalStockQty": 22,
    "availableQty": 22,
    "updatedAt": "2026-05-20T12:10:00.000Z",
    "version": 4
  },
  "serverTime": "2026-05-20T12:10:00.000Z"
}
```

Stock rules:

- Stock must never become negative unless the tenant explicitly enables oversell and the response includes `allowsNegativeStock: true`.
- `quantity` and `newQuantity` must be finite numbers. Reject `NaN`, infinity, empty string, and locale-formatted strings.
- Large decrements should still be accepted by API if valid, but the client will ask for user confirmation.
- Every stock mutation must create an audit entry with before/after values, actor, timestamp, reason, and idempotency key.

### Categories

`GET /api/v1/warehouse/product-admin/categories`

Must return all active categories, including empty categories. The current POS category mirror is derived from product payloads and cannot show newly created empty categories reliably.

Response:

```json
{
  "categories": [
    {
      "id": "category-uuid",
      "name": "Drinks",
      "color": "#2563eb",
      "icon": "DR",
      "sortOrder": 10,
      "isActive": true,
      "updatedAt": "2026-05-20T12:00:00.000Z",
      "version": 1
    }
  ],
  "serverTime": "2026-05-20T12:00:00.000Z"
}
```

`POST /api/v1/warehouse/product-admin/categories`

`PATCH /api/v1/warehouse/product-admin/categories/:categoryId`

Fields:

```json
{
  "name": "Drinks",
  "color": "#2563eb",
  "icon": "DR",
  "sortOrder": 10,
  "expectedUpdatedAt": "2026-05-20T11:30:00.000Z"
}
```

Category rules:

- `name` is required and unique enough for the tenant's UI policy.
- `color` and `icon` are optional presentation fields.
- Empty categories must be returned by the admin category endpoint.
- Category update must not orphan products. If a category is hidden/deactivated later, products should either keep a historical category name or be reassigned by an explicit backend policy.

## Error Envelope

Use one stable envelope for all product-admin failures:

```json
{
  "ok": false,
  "code": "DUPLICATE_BARCODE",
  "message": "Barcode is already used by Coca Cola 500ml",
  "field": "barcode",
  "details": {
    "conflictingVariantId": "variant-uuid",
    "conflictingName": "Coca Cola 500ml"
  },
  "serverTime": "2026-05-20T12:00:00.000Z"
}
```

The client will localize the user-facing text from `code` where possible. `message` is still useful for logs and fallback display.

## Error Codes

Use stable machine-readable codes:

- `DUPLICATE_BARCODE`
- `DUPLICATE_SKU`
- `STALE_PRODUCT`
- `PRODUCT_NOT_FOUND`
- `CATEGORY_NOT_FOUND`
- `INVALID_PRICE`
- `INVALID_STOCK_QUANTITY`
- `INSUFFICIENT_STOCK`
- `UNSUPPORTED_CAPABILITY`
- `SALON_CONTEXT_MISMATCH`
- `UNAUTHORIZED_PRODUCT_ADMIN`
- `INVALID_CATEGORY`
- `INVALID_VAT_RATE`
- `PRICE_MINOR_UNIT_MISMATCH`
- `IDEMPOTENCY_CONFLICT`

For duplicate barcode/SKU, return the conflicting product/variant id and display name so the POS can offer "Open existing product".

Recommended status mapping:

- `400`: malformed request, missing required field, invalid number format.
- `401`: no/invalid token.
- `403`: user lacks product admin permission.
- `404`: product, variant, category, or route not found.
- `409`: duplicate barcode/SKU, stale version, idempotency key conflict, salon context mismatch.
- `422`: business validation failure.
- `501`: capability not implemented.

## Sync Contract

After any mutation, backend must do at least one of:

1. Return the updated variant/category row immediately and guarantee the next `/warehouse/public/products?since=...` includes the change.
2. Emit `sync_log` entries or socket events (`catalog:updated`, `stock:updated`, category update equivalent) for all active POS terminals.

The client will still run product sync after mutation, but the backend should not require an app restart or full resync.

The preferred implementation is:

1. Mutation commits to the source-of-truth catalog.
2. Mutation writes a sync-log entry with variant/category id, operation type, updated timestamp, and tenant id.
3. Mutation response returns the updated row immediately.
4. Realtime channel emits one of:
   - `catalog:updated`
   - `stock:updated`
   - `categories:updated`
5. The next `GET /api/v1/warehouse/public/products?since=<cursor>` includes the mutation.

If category mutations are not included in `/warehouse/public/products`, add a category delta endpoint or include category records in the product catalog delta payload.

## Audit Requirements

Backend should persist an audit trail for product administration:

- Product create: actor, tenant, idempotency key, created variant id.
- Product update: actor, before/after changed fields, expected/current version.
- Deactivate: actor, reason, previous active status.
- Stock adjustment: actor, reason, mode, previous quantity, new quantity, adjustment id.
- Category mutation: actor, before/after changed fields.

The desktop MVP does not need to render the audit trail immediately, but the audit data is needed for shop-owner accountability and future support/debugging.

## Backend Acceptance Checklist

Implementation is ready for the desktop client when all items below pass:

- `GET /capabilities` returns `200` with only truthful capability booleans.
- Create product rejects duplicate barcode and duplicate SKU with stable `409` codes and conflicting product metadata.
- Create product accepts an idempotency key and returns the same result when retried with the same key and body.
- Create product rejects an idempotency key reused with a different body.
- Update product applies only dirty fields and rejects stale `expectedVersion` or stale `expectedUpdatedAt`.
- Update product never changes stock.
- Deactivate product is soft, preserves old order history, and removes the product from normal POS selling payloads.
- Stock adjustment supports receive, recount, damage, and loss with before/after quantities and audit rows.
- Stock adjustment rejects invalid quantities and insufficient stock when negative stock is not enabled.
- Category list returns empty active categories.
- Category create/update is visible to the desktop without app restart.
- All mutation responses include enough row data for the desktop to refresh local `product_variants`/category mirrors.
- The next product delta sync includes product mutations.
- Realtime events or sync-log entries notify active terminals.
- All endpoints enforce salon tenancy and product-admin authorization.

## Client Integration Sequence After Backend Ships

Once the backend endpoints above exist, implement the desktop mutation UI in this order:

1. Keep the current capability probe and enable only controls whose capability boolean is true.
2. Add typed `apiClient` wrappers for create/update/deactivate/adjust-stock/categories.
3. Add IPC and preload methods under `window.electronAPI.pos.productAdmin`.
4. Add stock adjustment dialog first because it is operationally isolated and does not overlap with product field editing.
5. Add product edit/save in the detail drawer with optimistic concurrency.
6. Add category manager and inline create category.
7. After each mutation, call product/category sync and preserve the current Products tab search/filter.
8. Extend tests for duplicate handling, stale update handling, and sync refresh.

## Client Behavior Until This Ships

The client will ship only safe read/search/detail UI plus existing draft import and quick-add flows. Normal product edit, stock adjustment, deactivate, and category management stay disabled until runtime capabilities confirm support.
