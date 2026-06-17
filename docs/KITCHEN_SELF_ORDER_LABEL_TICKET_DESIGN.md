# Kitchen Self-Order — Customer Label (50x30) & Kitchen Ticket Improvements

- **Date:** 2026-06-17
- **Revision:** v2 — incorporated app-bot review (QR physical fit, deterministic ASCII-fold,
  shared-route rollout caveat, modifier language decision, count semantics). All 5 findings verified
  against code and accepted.
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
- **Fold ASCII tất định cho nhãn**; **QR tự co cho vừa khổ**; modifier in theo **nhãn canonical** trong snapshot;
  count weighted = 1 món; rollout cần cập nhật **cả kiosk lẫn POS máy in bếp**.

---

## 1. Background — current state

Two artifacts are produced when a customer submits an order at the kitchen self-order kiosk
(`ipcMain 'kitchen-self-order:submit'` in `src/main/modules/pos.module.ts`):

1. **Kitchen ticket** (`buildKitchenTicketLines` in `src/main/printing/kitchen-ticket.ts`) — routed to the
   KITCHEN-role printer. **For the user's topology (kiosk has no local kitchen printer) the ticket goes via the
   shared route and is rendered on the RECEIVER POS** (`hardware.module.ts:2326`), not on the kiosk.
2. **Customer slip** (`printKitchenSelfOrderCustomerSlip`) — printed locally on the kiosk's RECEIPT or LABEL
   printer. Config `kitchenSelfOrderSlipPrinterType`:
   - `RECEIPT` → `buildKitchenPaymentSlipLines` (ESC-POS) — already multilingual + items + total + QR.
   - `LABEL` → `formatKitchenPaymentLabel` (ZPL) — **the 50x30 label in use**.

### Gaps being addressed
- **Kitchen ticket**: modifiers + free note merged into one cramped `Ghi chú: …` line; no item count.
- **50x30 label**: Polish-only strings, only order number + total + QR; ignores `data.customerLanguage`.

### Facts verified in code (corrections vs v1)
- `KitchenTicketData` already carries `brandName`, `fulfillmentType`, `customerLanguage`, `createdAt`,
  `orderNumber`, `totalGrosze`, `items`, `qrPayload`. No new data plumbing for the label fields.
- Order number = `K-NNN` (`formatKitchenSelfOrderNumber`, daily-reset per `business_date`, per-machine).
- **⚠ CORRECTION (was wrong in v1): `sanitizeText()` does NOT reliably fold diacritics.** It calls
  `transliterateForZebra()`, which folds Vietnamese/Latin **only when `textProfile === 'ascii'`**. The profile is
  chosen by a printer-name regex (`ZebraDriver.textProfileForPrinter`, `zebra-driver.ts:27` —
  `/xprinter|xp-?42…|gk420|zdesigner|zebra|ztc/i`). In the default `'zebra'` profile **only `ł/Ł` are folded**;
  Vietnamese passes through. The current Polish label works only because its strings are hand-authored ASCII
  (`DO ZAPLATY`). **→ the new label must ASCII-fold deterministically itself** (see §4).
- Modifier labels come from `formatKitchenSelfOrderModifierLabels()`, formatting the **order snapshot's canonical**
  `groupName/optionName` (`kitchen-self-order.ts` validation stores `group.name`/`option.name`, **not**
  `nameTranslations`). See decision §4.3.
- `KitchenTicketItem.unit` supports weighted items (`kg`). Count must handle this (§4.4).
- The QR in `formatKitchenPaymentLabel` is fixed at `qrX=31mm`, magnification `^BQN,2,2`, on a label whose width
  comes from printer config (`local-printer-repo.ts:53`, =50mm for the 50x30 label). Long payloads overflow the
  19mm to the right of `qrX` and get clipped by `^PW`. See fix §4.5. (The codebase already has an adaptive QR
  sizer to mirror at `zpl-formatter.ts:589`.)

---

## 2. Goals & non-goals

**Goals** — customer label readable in the customer's language with number/count/total/fulfillment/time + a
**scannable** recall QR; kitchen ticket with easy-to-read per-line modifiers and a stand-out free note.

**Non-goals (YAGNI — dropped per decisions)** — per-item labels; customer status display; multi-kiosk number
prefixing; changing release timing (stays `ON_SUBMIT`); listing items on the label (count only); **localizing
modifier snapshots** to kitchen language (see §4.3).

---

## 3. Component A — Kitchen ticket (`buildKitchenTicketLines`)

```
   *** BẾP ***
       K-042
   CHƯA TRẢ TIỀN          (only when paymentStatus = UNPAID)
      MANG ĐI             (fulfillment, only when set)
  14:23 · KIOSK · 3 món   (time · source · COUNT  <-- new; count = §4.4 helper)
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

1. **Header count**: append `· ${count} ${itemWord}` to the time·source line. `itemWord` by kitchen-ticket
   language (`vi → "món"`, `pl → "poz."`, `en → "items"`). `count` = `kitchenItemCount(items)` (§4.4).
2. **Modifiers**: each entry of `item.modifiers` on its own bold line `   » {modifier}`.
3. **Free note**: when `item.notes` present, `   !! {notes}` (bold), separate from modifiers.

Kitchen ticket renders full Vietnamese diacritics (ESC-POS raster path) — **unaffected by the ZPL font issue**.
Everything else (header, big `K-042`, UNPAID, fulfillment, KOPIA reprint, `NR/SỐ`, no prices) unchanged.

---

## 4. Component B — 50x30 customer label (`formatKitchenPaymentLabel`)

Target (shown with diacritics for clarity; printed ASCII per §4.2):

```
  CHE SAI GON  · MANG DI          brand (small) · fulfillment
   SO DON                ┌──────┐
    K-042                │  QR  │  big order number  +  recall QR (adaptive, §4.5)
   3 mon · 34,00 zl      └──────┘  item count · total
   > Quet / ra quay tra tien      instruction
   14:23                          time
```

### 4.1 Fields & i18n
Per-language copy map keyed by `data.customerLanguage` (pattern from `buildKitchenPaymentSlipLines`), fallback `pl`.
Add: brand (`data.brandName`), fulfillment, item count (§4.4), time. Keep big order number + QR.

| Key | pl | vi | en |
|-----|----|----|----|
| order-number label | `NR ZAMOWIENIA` | `SO DON` | `ORDER NO` |
| count word | `poz.` | `mon` | `items` |
| instruction | `Zeskanuj / zaplac przy kasie` | `Quet / ra quay tra tien` | `Scan / pay at counter` |
| fulfillment takeaway | `NA WYNOS` | `MANG DI` | `TAKEAWAY` |
| fulfillment dine-in | `NA MIEJSCU` | `AN TAI QUAN` | `DINE IN` |

### 4.2 Deterministic ASCII fold (fixes review #2)
The label MUST fold to ASCII **independently of `textProfile`**. Implementation:
- Author all static copy above as ASCII (already done in the table).
- Run **every dynamic string** the label emits (esp. `brandName`) through a deterministic Latin→ASCII fold
  (the NFD-strip + `đ/Đ/ł/Ł/ß` table that `transliterateLatinToAscii` already implements), regardless of profile.
  Extract that logic into a reusable pure helper and call it here; do not rely on `sanitizeText`'s profile gate.

### 4.3 Modifier language (resolves review #4) — DECISION
Print the **canonical modifier label from the order snapshot** (`"{groupName}: {optionName}"`), i.e. the same
language behaviour as item names today. The snapshot stores canonical `group.name`/`option.name`. To show
Vietnamese in the kitchen, **configure modifier canonical names in Vietnamese** (data convention, no code).
Localizing the snapshot to kitchen language (carry `nameTranslations` into the snapshot / re-resolve on the
receiver) is **explicitly out of scope** — it would break "no new data plumbing". Revisit if PL/EN modifiers
appear on Vietnamese tickets in practice.

### 4.4 Count semantics (resolves review #5) — helper
`kitchenItemCount(items)` = Σ over items of `isWeighted(unit) ? 1 : max(1, round(quantity))`, where
`isWeighted(unit)` = unit is set and not in `{'', 'szt', 'pcs'}`. A 0.5 kg item counts as **1**. Used by both
the kitchen-ticket header (§3.1) and the label count (§4.1). Lives next to the existing `formatQuantity` helper.

### 4.5 QR must fit & scan (fixes review #1) — DECISION
The QR is the counter-recall key; it must never be clipped. Make it **adaptive**, mirroring `zpl-formatter.ts:589`:
- Compute the QR's printed width from its payload (module count × magnification ÷ dpmm) and **choose
  magnification/position so `qrX + qrWidth ≤ labelWidth − rightMargin`** (never beyond `^PW`).
- Reserve a fixed QR box on the right; lay text in the remaining left column.
- Prefer the **compact (no-notes) KSO payload** for the label to keep the QR small (recall only needs
  order id + items; notes are not needed at the counter). If even the compact payload cannot fit at the minimum
  readable magnification, log a warning and still print the largest fitting QR.

Priority for vertical/horizontal space: **order number (largest) → QR (scannable) → count·total → secondary**.

---

## 5. Shared type & adapter changes

- **`src/shared/types.ts` — `KitchenTicketItem`**: add `modifiers?: string[]` (readable labels). `notes?` now means
  **free-text note only**.
- **`buildKitchenSelfOrderTicket`** (`pos.module.ts`): pass separately —
  `modifiers: parseKitchenSelfOrderOptions(item.options_json)` and `notes: item.note || null`
  (currently joined with `' | '`). Confirmed `parseKitchenSelfOrderOptions` → `formatKitchenSelfOrderModifierLabels`
  returns readable labels for both the structured and legacy option shapes.
- **`printKitchenTicketForOrder`** (POS orders, same file): pass `modifiers: []`, keep `notes: item.notes`
  → renders note only → no regression.

---

## 6. Rollout / app-to-app compatibility (resolves review #3) — DECISION

The shared KITCHEN route sends the `KitchenTicketData` object (`shared-kitchen-printer.ts`); the **receiver** POS
renders it via `buildKitchenTicketLines` (`hardware.module.ts:2326`). After this change the sender emits
`modifiers` separately and `notes` = free-text only. **An un-updated receiver** (old `buildKitchenTicketLines`)
ignores `modifiers` and prints only the now-shorter `notes` → **modifier lines temporarily missing** (item name,
qty, and free note still print; no crash, no wrong data).

**Decision: accept brief degradation.** Rollout requires updating **both** the kiosk (sender) and the
kitchen-printer POS (receiver) to the same version. Since the fleet auto-updates from R2 and the operator controls
restart timing, update both before relying on modifier lines; note it in release notes.
*(Alternative rejected: dual-write modifiers into `notes` for back-compat — causes double rendering on a new
receiver.)*

---

## 7. Files touched

| File | Change |
|------|--------|
| `src/shared/types.ts` | `KitchenTicketItem`: add `modifiers?: string[]` |
| `src/main/printing/kitchen-ticket.ts` | `buildKitchenTicketLines`: header count + per-line modifiers + `!!` note; add `kitchenItemCount` helper |
| `src/main/modules/pos.module.ts` | adapter split modifiers/notes; `printKitchenTicketForOrder` `modifiers: []` |
| `src/main/hardware/zebra/zpl-formatter.ts` | `formatKitchenPaymentLabel`: i18n copy + brand/fulfillment/count/time, deterministic ASCII fold, adaptive QR; reusable `latinToAscii` helper |
| `src/main/printing/kitchen-ticket.ts` (optional) | `buildKitchenPaymentSlipLines`: add count line for parity |

---

## 8. Testing

**Unit (automated)**
- **Kitchen ticket**: each modifier on its own line; free note via `!!` and separate from modifiers; header count;
  preserved pieces (UNPAID, fulfillment, KOPIA, `NR/SỐ`, no prices).
- **`kitchenItemCount`**: weighted 0.5 kg → 1; `szt`/null → quantity; mixed order; multi-qty sum.
- **Label i18n + ASCII fold (the test that catches review #2)**: build `ZplFormatter` in BOTH `'zebra'` and
  `'ascii'` profiles (and/or via `ZebraDriver` with a **non-matching** printer name) with a Vietnamese
  `brandName`; assert the emitted ZPL contains **no non-ASCII byte**, and the correct per-language copy for
  pl/vi/en.
- **Label QR fit (catches review #1)**: for payloads of ~300 / 450 / 600 chars, assert the chosen QR
  magnification/position yields `qrX + qrWidth ≤ labelWidth` (no clip past `^PW`), and that a QR block is present.

**Manual acceptance (required before go-live, not just unit)**
- **Print-smoke on the real kiosk Zebra**: print the label with a near-worst-case (~600-char) QR payload and a
  Vietnamese brand; **scan the QR at the POS to confirm order recall**; eyeball no overflow/clipping and that
  count/total/fulfillment render.

**Regression** — baseline is green (4 files / 53 tests per app-bot); existing kitchen-ticket + ZPL tests pass;
`typecheck:renderer` + `tsc -p tsconfig.main.json` clean; vitest green.

---

## 9. Known constraints / risks (accepted)

- 50x30mm + QR is tight; order number stays dominant, secondary lines small. The adaptive QR (§4.5) trades a
  little size for guaranteed fit.
- Compact (no-notes) KSO payload is preferred for the label; if the payload is still too large to scan at the
  minimum magnification, the label prints the largest fitting QR and logs a warning.
- ZPL device font cannot render diacritics → label is ASCII-folded deterministically (§4.2). Full-diacritic labels
  would need a downloaded Unicode TTF / raster — out of scope.
- `K-NNN` is a per-machine daily counter; correct for a single kiosk. Revisit if a second kiosk is added.
- Modifier lines on the kitchen ticket require the receiver POS on the same version (§6).
