# Kitchen Self-Order — Customer Label (50x30) & Kitchen Ticket Improvements

- **Date:** 2026-06-17
- **Status:** Approved design (brainstorm). Pending implementation plan.
- **Scope:** POS-zira app only. **No backend, no DB schema, no print-routing changes.**
- **Related:** `docs/KITCHEN_SELF_ORDER_DESIGN_CONTRACT.md`, `docs/KITCHEN_SELF_ORDER_MVP_PLAN.md`

---

## Tóm tắt quyết định đã chốt (VI)

- **1 đơn = 1 nhãn** (không in nhãn-mỗi-món).
- **Nhãn in theo NGÔN NGỮ KHÁCH** đã chọn lúc gọi món (PL/VI/EN), không còn chỉ tiếng Ba Lan.
- **Số đơn giữ `K-NNN`** (reset theo ngày). Chỉ 1 kiosk → không cần chống trùng đa máy.
- **Phiếu bếp vẫn in NGAY khi khách đặt** (`ON_SUBMIT`), giữ dấu **CHƯA TRẢ TIỀN**.
- **Không làm màn hình trạng thái** "đang phục vụ / món sẵn sàng".
- **Modifier trên phiếu bếp**: mỗi lựa chọn 1 dòng, in đậm; ghi chú khách tách riêng & nổi bật.
- **Nội dung nhãn**: brand · loại đơn · `SỐ ĐƠN` to · QR · `số món · tổng tiền` · dòng hướng dẫn · giờ.

---

## 1. Background — current state

Two artifacts are produced when a customer submits an order at the kitchen self-order kiosk
(`ipcMain 'kitchen-self-order:submit'` in `src/main/modules/pos.module.ts`):

1. **Kitchen ticket** (`buildKitchenTicketLines` in `src/main/printing/kitchen-ticket.ts`) — routed to the
   KITCHEN-role printer (local or shared via backend). Thermal/ESC-POS path → raster render → keeps full
   Vietnamese diacritics.
2. **Customer slip** (`printKitchenSelfOrderCustomerSlip`) — printed locally on the kiosk's RECEIPT or LABEL
   printer. Config `kitchenSelfOrderSlipPrinterType` selects which:
   - `RECEIPT` → `buildKitchenPaymentSlipLines` (ESC-POS) — **already multilingual + lists items + total + QR**.
   - `LABEL` → `formatKitchenPaymentLabel` (ZPL, `src/main/hardware/zebra/zpl-formatter.ts`) — **the 50x30 label
     currently in use**.

### Gaps being addressed

**Kitchen ticket** (`buildKitchenTicketLines`): modifiers and the free-text note are merged by the adapter
`buildKitchenSelfOrderTicket` into one `notes` string, then printed as a single cramped `Ghi chú: …` line.
No total item count in the header.

**50x30 label** (`formatKitchenPaymentLabel`): **Polish-only** fixed strings (`DO ZAPLATY`, `RAZEM`,
`SKANUJ PRZY KASIE`, `POKAZ W KASIE`), and contains only order number + total + QR. No brand, no fulfillment,
no item count, no time, and ignores the customer's chosen language (`data.customerLanguage` is present but unused).

### Relevant facts confirmed in code

- `KitchenTicketData` already carries everything needed: `brandName`, `fulfillmentType`, `customerLanguage`,
  `createdAt`, `orderNumber`/`pickupNumber`, `totalGrosze`, `items`, `qrPayload`. **No new data plumbing.**
- The order number for self-orders is `K-NNN` (`formatKitchenSelfOrderNumber`, daily-reset per `business_date`,
  per-machine local counter).
- The ZPL `sanitizeText()` already calls `transliterateForZebra()`, so any diacritics (VI/PL) are folded to
  ASCII for the Zebra device font automatically — same convention the current Polish strings already follow
  (`DO ZAPLATY`, not `DO ZAPŁATY`). **So label i18n needs no font work.**

---

## 2. Goals & non-goals

**Goals**
- Customer label readable in the customer's chosen language.
- Customer label shows enough at a glance: number (for pickup), how many items, total (what they'll pay),
  takeaway/dine-in, time, plus the recall QR.
- Kitchen ticket modifiers easy for cooks to read; free-text note stands out.

**Non-goals (YAGNI — explicitly dropped per decisions)**
- Per-item / per-cup labels.
- Customer "now serving / ready" status display.
- Multi-kiosk order-number prefixing or backend-allocated numbers.
- Changing kitchen release timing (stays `ON_SUBMIT`).
- Listing individual items on the 50x30 label (count only).

---

## 3. Component A — Kitchen ticket (`buildKitchenTicketLines`)

Target layout (kitchen language = `vi` for self-orders, falls back pl/en):

```
   *** BẾP ***            (or *** KUCHNIA ***)
       K-042
   CHƯA TRẢ TIỀN          (only when paymentStatus = UNPAID)
      MANG ĐI             (fulfillment, only when set)
  14:23 · KIOSK · 3 món   (time · source · COUNT  <-- count is new)
 ──────────────────────
 1x Chè thái
    » đường 50%           (one bold line PER modifier  <-- new)
    » đá ít
    » + trân châu
 2x Trà sữa
    » full topping
    !! ít đá giùm em       (free-text note, bold, !! prefix  <-- new)
 ──────────────────────
   NR / SỐ:  K-042
```

**Changes**
1. **Header count**: append total item count to the existing time·source line:
   `${HH:MM} · ${source} · ${count} ${itemWord}`.
   - `count` = sum of item quantities (`1x A + 2x B = 3`).
   - `itemWord` by kitchen ticket language: `vi → "món"`, `pl → "poz."`, `en → "items"`.
2. **Modifiers**: render each entry of `item.modifiers` on its own line: `   » {modifier}` (bold).
3. **Free note**: when `item.notes` present, render `   !! {notes}` (bold), distinct from modifiers.
   - The current single `Ghi chú: …` / `>> …` merged line is removed.

Everything else (KUCHNIA/BẾP header, big `K-042`, UNPAID flag, fulfillment line, KOPIA/IN LẠI reprint marker,
`NR / SỐ` footer, no prices) is unchanged.

---

## 4. Component B — 50x30 customer label (`formatKitchenPaymentLabel`)

Target layout (ASCII-folded automatically for the Zebra font; shown here with diacritics for clarity):

```
  CHÈ SÀI GÒN  · MANG ĐI          brand (small) · fulfillment
   SỐ ĐƠN                ┌──────┐
    K-042                │  QR  │  big order number  +  recall QR
   3 món · 34,00 zł      └──────┘  item count · total
   ▸ Quét / ra quầy trả tiền      instruction
   14:23                          time
```

**Changes**
1. Replace the hard-coded Polish strings with a per-language copy map keyed by `data.customerLanguage`
   (same pattern as `buildKitchenPaymentSlipLines`). Fallback `pl`.
2. Add fields: brand name (`data.brandName`, small, top), fulfillment label, item count, time. Keep the big
   order number and the QR.
3. `count` = sum of item quantities. `total` from `data.totalGrosze` (already used).

**Label copy (authored readable; `sanitizeText` folds to ASCII at print time)**

| Key | pl | vi | en |
|-----|----|----|----|
| order-number label | `NR ZAMOWIENIA` | `SỐ ĐƠN` | `ORDER NO` |
| count word | `poz.` | `món` | `items` |
| instruction | `Zeskanuj / zaplac przy kasie` | `Quét / ra quầy trả tiền` | `Scan / pay at counter` |
| fulfillment takeaway | `NA WYNOS` | `MANG ĐI` | `TAKEAWAY` |
| fulfillment dine-in | `NA MIEJSCU` | `ĂN TẠI QUÁN` | `DINE IN` |

Layout note: 50x30mm + QR is tight. Priority order for vertical space: **order number (largest) → QR (must stay
scannable) → count·total → fulfillment/brand/instruction/time (small)**. Implementation tunes `^A0` font sizes
and `^FO` positions; QR stays at current `^BQN` magnification unless a scan problem is observed.

---

## 5. Shared type & adapter changes

- **`src/shared/types.ts` — `KitchenTicketItem`**: add `modifiers?: string[]` (readable modifier labels).
  `notes?: string | null` now means **free-text note only** (no longer the merged options+note string).
- **`buildKitchenSelfOrderTicket`** (`src/main/modules/pos.module.ts`): pass them separately —
  `modifiers: parseKitchenSelfOrderOptions(item.options_json)` and `notes: item.note || null`
  (currently joined with `' | '`).
- **`printKitchenTicketForOrder`** (regular POS orders, same file): pass `modifiers: []` (POS items have no
  structured modifiers) and keep `notes: item.notes`. Renders the note only → **no regression** for POS tickets.

> Confirmed: `parseKitchenSelfOrderOptions` (`pos.module.ts`) → `formatKitchenSelfOrderModifierLabels()` already
> returns an array of human-readable modifier labels (e.g. `["đường 50%", "đá ít", "+ trân châu"]`), handling both
> the new structured `{version:1, modifiers:[…]}` shape and the legacy `string[]` shape. No id→label mapping needed
> in the adapter.

---

## 6. Files touched

| File | Change |
|------|--------|
| `src/shared/types.ts` | `KitchenTicketItem`: add `modifiers?: string[]` |
| `src/main/printing/kitchen-ticket.ts` | `buildKitchenTicketLines`: header count + per-line modifiers + `!!` note |
| `src/main/modules/pos.module.ts` | adapter `buildKitchenSelfOrderTicket` (split modifiers/notes); `printKitchenTicketForOrder` (`modifiers: []`) |
| `src/main/hardware/zebra/zpl-formatter.ts` | `formatKitchenPaymentLabel`: i18n copy map + brand/fulfillment/count/time fields |
| `src/main/printing/kitchen-ticket.ts` (optional) | `buildKitchenPaymentSlipLines`: add count line for parity with the label |
| `tests/…` | unit tests below |

---

## 7. Testing

- **Kitchen ticket** (`buildKitchenTicketLines`): each modifier on its own line; free note rendered with `!!`
  and separate from modifiers; header shows total count; existing pieces preserved (UNPAID, fulfillment,
  reprint KOPIA, `NR/SỐ`, no prices).
- **Label** (`formatKitchenPaymentLabel`): for each of pl/vi/en — correct (ASCII-folded) strings, count + total
  present, fulfillment present, order number present, QR block present, `^PW` set to label width.
- **Regression**: existing kitchen-ticket and ZPL tests pass; `typecheck:renderer` + `tsc -p tsconfig.main.json`
  clean; vitest green.

---

## 8. Known constraints / risks (accepted, not fixed here)

- 50x30mm + QR is space-tight; secondary lines use small fonts, order number stays dominant.
- KSO QR payload can be ~600 chars; at small magnification it is near the scan limit. Behavior unchanged; revisit
  only if scanning degrades.
- ZPL device font cannot render diacritics, so the label is ASCII-folded (consistent with the current Polish
  label). Full-diacritic labels would require a downloaded Unicode TTF or raster rendering — out of scope.
- `K-NNN` is a per-machine daily counter; correct for a single kiosk. Revisit if a second kiosk is added.
