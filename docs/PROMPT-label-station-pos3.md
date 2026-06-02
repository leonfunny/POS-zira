# Task: POS3 "Label Station" mode — staff meat-label terminal (no payment)

## Context
POS3 is a dedicated terminal at the meat-cutting station (Tailscale `desktop-p8err1q`, has a Zebra ZDesigner GK420d label printer on USB). Workflow: butcher cuts meat → selects the product on POS3 → prints a **50×30 EAN label** (name + price/kg) → sticks it on the bag. At checkout (POS1) the cashier puts the bag on the scale and scans the EAN.

POS3 must run a **restricted "Label Station" mode**: browse meat products + print label only. **NO payment, NO cart/checkout, NO cash drawer, NO refunds, NO order history, NO fiscal.**

What already exists (reuse, don't rebuild):
- Label print API: `window.electronAPI.printLabel(barcode: string, text?: string)` → IPC `PRINT_LABEL` → `hardware.module.printLabel` → `printLabelToDevice` (50×30, barcode + text). Uses `config.printers.LABEL`.
- Price text: `src/renderer/utils/product-label.ts` `formatProductLabelPriceText(product)` — already WEIGHT-aware (returns `"25.00 zł/kg"` for WEIGHT, `"X.XX zł"` for PIECE).
- Product browse/search + category grid: the components used by `POSLayout`.
- Restricted-kiosk precedent: self-checkout (`selfCheckoutEnabled` in `src/main/config/store.ts` ~line 231; gated in `src/renderer/App.tsx` ~line 449 via `isFeatureEnabled`).
- WEIGHT products + internal EAN-13 are already in the catalog (meat products have `2653…` codes); offline-safe after sync.

## Implement
1. **Config** (`src/main/config/store.ts`, mirror the `selfCheckout*` block):
   - `labelStationEnabled: { type: 'boolean', default: false }`
   - `labelStationCategoryIds: { type: 'string', default: '' }` (CSV of allowed categoryIds; empty = all)
   - `labelStationCopies: { type: 'number', default: 1 }`
   - `labelStationExitPin: { type: 'string', default: '' }` (optional; if set, required to leave the mode)
2. **View gating** (`src/renderer/App.tsx`): when `config.labelStationEnabled === true`, boot the app DIRECTLY into a new `LabelStationTab` as a kiosk takeover — hide POS, payment, orders, settings tabs from the operator (same spirit as self-checkout). Add `'labelStation'` to the tab union + `isFeatureEnabled`. Provide an exit affordance gated by `labelStationExitPin` (back to normal POS/Settings).
3. **New component** `src/renderer/components/LabelStationTab.tsx`:
   - Reuse the POS product grid/search. If `labelStationCategoryIds` non-empty, filter categories to that set (default to meat).
   - Tap a product → primary action **"In nhãn" (Print label)**:
     - `text = product.name + "\n" + (formatProductLabelPriceText(product) ?? '')`
     - `await window.electronAPI.printLabel(product.barcode || product.ean, text)` × `copies` (copies input, default `labelStationCopies`).
     - Show a "✓ Đã in" toast + a small recent-prints list.
   - If the product has **no EAN/barcode** → disable Print + show "Thiếu mã EAN" (don't print a blank barcode).
   - WEIGHT product label shows name + price/kg; PIECE shows name + fixed price (handled by `formatProductLabelPriceText`).
4. **Restrictions**: in this mode render ONLY browse + print. No cart, payment, drawer, refund, order-history, fiscal. (Reuse the product browse component WITHOUT the cart/checkout panels.)
5. **Settings** (`src/renderer/components/Settings.tsx`): add a "Label Station" section — enable toggle, allowed-categories picker (multi-select), default copies, exit PIN. The label printer itself is configured in the existing Printers section (POS3: enable `printers.LABEL`, select the Zebra GK420d) — note this for the operator.

## Locked decisions
- 1 bag = 1 product = 1 label (no multi-product labels).
- Price = current `retail_price` at print time (`formatProductLabelPriceText`).
- No scale on POS3 (weighing happens at POS1 checkout).
- Reprint = just print again.

## Acceptance
- With `labelStationEnabled=true`, POS3 boots into Label Station: only (meat) product grid + Print; no payment/cart/cash/refund/orders UI reachable.
- Tap "Thịt ba chỉ" → prints 50×30 label: text "Thịt ba chỉ" + "25.00 zł/kg" + scannable EAN `2653581698166`.
- Tap a PIECE product → label shows fixed `zł` (no `/kg`).
- Product without EAN → Print disabled + "Thiếu mã EAN".
- Copies=N prints N identical labels.
- Exiting the mode requires the PIN (if set).

## Files
- `src/main/config/store.ts` (flags)
- `src/renderer/App.tsx` (view gating, self-checkout precedent ~line 449)
- `src/renderer/components/LabelStationTab.tsx` (new — reuse POS product grid + `window.electronAPI.printLabel`)
- `src/renderer/utils/product-label.ts` (`formatProductLabelPriceText`)
- `src/renderer/components/Settings.tsx` (Label Station settings section)
- Label print path already done: `hardware.module.printLabel` / `pdf-printer.printLabelToDevice` / `zpl-formatter` — no change needed.
