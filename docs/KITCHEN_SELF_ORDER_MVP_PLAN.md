# Kitchen Self-Order MVP Plan

Target checkout: `D:\POS-zira\docs\KITCHEN_SELF_ORDER_MVP_PLAN.md`

Date: 2026-06-10
Status: MVP implemented in local PC-YURI source
Scope: PC-YURI customer-facing food ordering kiosk that prints kitchen tickets on POS1 and customer pickup slips on PC-YURI.

## Summary

Build a separate Kitchen Self-Order flow for food orders. It must not change or risk the existing store self-checkout flow.

The MVP is deliberately narrow:

1. Customer uses PC-YURI near the restaurant entrance.
2. Customer lands directly on the food menu.
3. Language and `Na miejscu` / `Na wynos` are inline header controls, not separate gate screens.
4. Customer browses food menu, adds items, quantity, options, and free-text item notes.
5. Customer reviews and submits the kitchen order.
6. POS1 prints a Vietnamese kitchen ticket for the cooks.
7. PC-YURI prints a small customer slip with the same order number.
8. PC-YURI shows the order number on screen.

Payment, stock decrementing, fiscal receipt, and revenue reporting are out of MVP scope. They will be designed after the physical ordering and printing loop is proven.

## Implementation Snapshot

Implemented in `D:\POS-zira` on `DESKTOP-C92MLRB`:

- New `kitchenSelfOrder` Electron window and preload.
- New `kitchen-self-order:*` IPC namespace.
- New local persistence tables: `kitchen_self_orders` and `kitchen_self_order_items`.
- Separate customer flow: menu-first ordering with inline language and `Na miejscu` / `Na wynos`, cart, notes/options, confirm, done screen.
- Kitchen ticket uses order numbers like `K-042`, Vietnamese kitchen ticket copy, fulfillment type, source `KIOSK PC-YURI`, item notes/options.
- Customer slip uses the customer-selected language and prints locally on PC-YURI when the configured `RECEIPT` or `LABEL` printer supports plain-line printing.
- Store self-checkout still uses the existing `selfCheckout` window, config, cart storage, and paid sale path.

Current MVP limitations:

- No payment collection.
- No fiscal receipt.
- No stock decrement.
- PC-YURI customer slip is best-effort. The on-screen order number is still shown if no PC-YURI slip printer is configured.

## Confirmed Decisions

- Order number shown to customer: `K-042` style.
- Kitchen ticket language: Vietnamese.
- Customer slip language: same language selected by the customer in the kiosk.
- `Na miejscu` / `Na wynos` is a first-class order choice, not a note.
- Item notes are for food-preparation information, such as no onion, less spicy, extra sauce.
- PC-YURI will have a small printer eventually, but device type is not final yet: it may be configured as `RECEIPT` or `LABEL`.
- Do not rely on stock for kitchen food in the MVP.
- Do not modify the existing store self-checkout behavior.

## Recommended Architecture

Use a separate flow/domain with light reuse.

Create a new kiosk/window/config path:

- Window id: `kitchenSelfOrder`
- Preload: `preload-kitchen-self-order.ts`
- Main IPC namespace: `kitchen-self-order:*`
- Config keys:
  - `kitchenSelfOrderEnabled`
  - `kitchenSelfOrderMonitor`
  - `kitchenSelfOrderLanguage`
  - `kitchenSelfOrderSlipPrinterType`
  - `kitchenSelfOrderSlipPrinterId`
  - `kitchenSelfOrderDefaultFulfillment`
- Local cart storage key: separate from self-checkout, e.g. `zira:kitchen-self-order:cart`

Reuse existing pieces where safe:

- Product/category reading from the local POS catalog.
- Product tile/category browsing UI patterns from self-checkout menu mode.
- Kitchen ticket formatter/routing ideas from current kitchen print flow.
- Printer routing infrastructure for local/shared printers.

Do not reuse the existing store self-checkout order-creation path for the MVP, because that path creates paid POS orders, syncs them, prints fiscal receipts, and decrements stock.

## Data Model

Store kitchen order requests locally before printing. This gives us reprint/debug/recovery if either POS1 kitchen ticket or PC-YURI customer slip fails.

Suggested new local tables:

```sql
CREATE TABLE kitchen_self_orders (
  id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  fulfillment_type TEXT NOT NULL, -- DINE_IN | TAKEAWAY
  customer_language TEXT NOT NULL, -- pl | vi | en
  status TEXT NOT NULL, -- SUBMITTED | PRINTED | PARTIAL_PRINT | PRINT_FAILED | CANCELLED
  source_machine_id TEXT,
  source_label TEXT, -- e.g. PC-YURI
  created_at TEXT NOT NULL,
  printed_at TEXT,
  error TEXT
);

CREATE TABLE kitchen_self_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  variant_id TEXT,
  product_id TEXT,
  name_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  options_json TEXT,
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(order_id) REFERENCES kitchen_self_orders(id)
);
```

Number generation:

- Internal daily sequence: `42`
- Stored/displayed `order_number`: `K-042`
- Reset daily by `business_date`
- Use a local atomic sequence counter or derive from today's max inside the same main-process create handler.

## Customer Flow

### Screen 1: Menu

Customer browses:

- Categories
- Product photos
- Product names
- Prices may be shown if available, but MVP does not create a paid POS order.

The first screen uses a menu-first kiosk pattern:

- Default language comes from `kitchenSelfOrderLanguage`.
- Language stays editable in a compact header toggle: `PL`, `VI`, `EN`.
- `Na miejscu` / `Na wynos` stays editable in a compact header toggle.
- The cart remains visible while browsing.

Cart line supports:

- Quantity stepper
- Item note text
- Optional predefined item options later

### Screen 2: Confirm

Show:

- `Na miejscu` / `Na wynos`
- Items
- Quantities
- Item notes
- Submit button

No payment in MVP.

### Screen 3: Done

Show large number:

```text
K-042
```

Message depends on language:

- PL: `Zachowaj numer zamówienia.`
- VI: `Vui lòng giữ số này để nhận món.`
- EN: `Keep this number for pickup.`

Also print customer slip on PC-YURI.

## Printing

### POS1 Kitchen Ticket

Language: Vietnamese.

Example:

```text
*** BEP ***
K-042
NA WYNOS
12:34 · KIOSK PC-YURI

2x PHO BO
   Ghi chu: khong hanh, it cay

1x COM GA
   Ghi chu: them ot
```

Kitchen ticket should include:

- Large order number
- Fulfillment type
- Time
- Source machine label
- Item quantity
- Food name
- Item notes
- Later: item options

No prices on kitchen ticket.

### PC-YURI Customer Slip

Language: customer-selected.

Example in Polish:

```text
SAIGON MARKET
NUMER ZAMOWIENIA
K-042

Na wynos
12:34
Zachowaj ten numer.
```

Example in Vietnamese:

```text
SAIGON MARKET
SO DON
K-042

Mang di
12:34
Vui long giu phieu nay de nhan mon.
```

The PC-YURI slip printer should be abstracted so the implementation can support either:

- local `RECEIPT` printer
- local `LABEL` printer
- later, a dedicated `KITCHEN_SELF_ORDER_SLIP` role if needed

For MVP, prefer a config setting that selects the local printer slot/type instead of hardcoding `RECEIPT`.

## Main IPC/API Draft

Renderer to main:

```ts
window.electronAPI.kitchenSelfOrder.getMenu()
window.electronAPI.kitchenSelfOrder.createOrder(payload)
window.electronAPI.kitchenSelfOrder.reprintCustomerSlip(orderId)
window.electronAPI.kitchenSelfOrder.reprintKitchenTicket(orderId)
```

Payload shape:

```ts
type KitchenSelfOrderCreatePayload = {
  customerLanguage: 'pl' | 'vi' | 'en';
  fulfillmentType: 'DINE_IN' | 'TAKEAWAY';
  items: Array<{
    variantId: string;
    productId?: string | null;
    name: string;
    quantity: number;
    note?: string | null;
    options?: string[];
  }>;
};
```

Create response:

```ts
type KitchenSelfOrderCreateResult = {
  success: boolean;
  orderId?: string;
  orderNumber?: string; // K-042
  kitchenPrinted?: boolean;
  customerSlipPrinted?: boolean;
  error?: string;
};
```

## Non-Goals For MVP

- No payment terminal integration.
- No fiscal receipt.
- No paid POS order creation.
- No revenue reporting.
- No stock decrementing.
- No backend sync requirement.
- No KDS screen/status lifecycle yet.
- No per-product option management UI yet.

## Why Not Use Existing Store Self-Checkout Directly

The existing self-checkout flow is optimized for paid retail/store sales. It creates `orders`, syncs them, prints fiscal receipts, decrements stock, and has payment/fiscal readiness concerns.

Kitchen Self-Order has different semantics:

- It can exist before payment.
- It must print to kitchen immediately.
- It may not decrement stock.
- Its customer slip is not a fiscal receipt.
- It needs item preparation notes/options.
- It should not affect store self-checkout stability.

Therefore, we should reuse safe UI/printer helpers but keep the flow and data model separate.

## Implementation Phases

### Phase 1: Planning/Contracts

- Add this plan.
- Confirm printer configuration approach for PC-YURI slip printer.
- Confirm whether menu source is all food-like categories or manually selected categories.

### Phase 2: Local Domain + Printing

- Add migrations for `kitchen_self_orders` and `kitchen_self_order_items`.
- Add repository for kitchen self-orders.
- Add order number generator for `K-042`.
- Add kitchen ticket builder for Vietnamese kitchen self-order tickets.
- Add customer slip builder with language-specific labels.
- Add main IPC `kitchen-self-order:create`.
- Implement local PC-YURI slip print routing.
- Implement POS1 kitchen print routing through existing shared printer job path or a narrow new print job type if needed.

### Phase 3: PC-YURI Kiosk UI

- Add `kitchenSelfOrder` window + preload.
- Add language screen.
- Add fulfillment screen.
- Add menu/category/product browsing.
- Add cart and confirm screen.
- Add success screen with order number.
- Add staff exit gesture.

### Phase 4: Manual QA

On PC-YURI:

1. Open Kitchen Self-Order.
2. Choose Vietnamese.
3. Choose `Na wynos`.
4. Add two menu items.
5. Add item note.
6. Submit.
7. Confirm POS1 prints kitchen ticket.
8. Confirm PC-YURI prints customer slip.
9. Confirm screen shows same `K-042`.
10. Reprint both slips from a debug/admin action if initial print fails.

### Phase 5: Payment Design Later

After MVP works physically:

- Decide payment mode:
  - pay before print
  - staff confirms then print
  - print then pay at counter
- Decide whether a kitchen order becomes a POS sale later or remains a separate order request.
- Decide fiscal receipt flow and reporting.

## Open Questions

Only one question is blocking the implementation plan:

1. PC-YURI slip printer configuration: should MVP expose a setting for printer type/slot, or should it first try `RECEIPT` then `LABEL` automatically?

Questions intentionally deferred:

- Payment timing.
- Stock behavior for mixed food/retail items.
- Per-product option management.
- KDS screen/status lifecycle.
- Backend sync/reporting.
