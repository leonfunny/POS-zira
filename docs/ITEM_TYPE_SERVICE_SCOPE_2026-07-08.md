# Item Kind (itemType/trackInventory) — Scope, Contract, Trạng thái

Date: 2026-07-08 · Backend: LIVE trên api.enail.pro · App: merged main `590ebda → 51c8cf8 → b16548b`

## 1. Mục đích

POS bán được những thứ **không đếm tồn kho**, phân loại rõ ràng thay vì đoán:

| Loại (`itemType`) | Ví dụ | Tồn kho |
| --- | --- | --- |
| `stockable` (mặc định) | bia chai, gạo, mì | Đếm bình thường — không có gì thay đổi |
| `service` | phí ship, giờ chơi bida, gói quà, dịch vụ lẻ | KHÔNG có tồn |
| `consumable` | túi, ống hút, đá — bán/kèm nhưng không muốn quản số | KHÔNG đếm tồn |

Trước đây mọi item bị coi là hàng tồn kho → dịch vụ hiện badge tồn 0 đỏ vô nghĩa,
"Điều chỉnh kho" ghi move rác, và MỖI lần bán tạo một movement âm ma
`POS_OVERSOLD` trên backend.

**KHÔNG nhầm với module `services`/booking của eNail** (đặt lịch, thợ, hoa hồng)
— đó là hệ khác. `itemType` là thuộc tính của product trong catalog bán quầy.

Semantics duy nhất, dùng ở mọi nơi:
**tracked = `itemType === 'stockable'` AND `trackInventory !== false`; field
vắng/NULL (hàng cũ) = tracked** — hành vi hôm nay không đổi cho bất kỳ hàng nào
đang có.

## 2. Backend cung cấp gì (TẤT CẢ ĐÃ LIVE)

Nguồn chân lý: cột có sẵn từ trước — `product_variants.product_type`
(variant-level, lowercase) + `products.track_inventory` (template-level).
Không có migration nào.

- `GET /warehouse/product-admin/capabilities` → `supportsItemType: true`.
  **App PHẢI gate mọi UI mới bằng flag này** (backend cũ không có → picker ẩn).
- Variant response (mọi read/mutation product-admin): thêm `itemType: string`
  + `trackInventory: boolean`.
- `POST /warehouse/product-admin/products` (create):
  - nhận `itemType?: 'stockable'|'service'|'consumable'` (`recipe` bị cấm từ
    POS — kit cần BOM) + `trackInventory?: boolean`;
  - non-stockable **ép** trackInventory=false;
  - `initialStockQty > 0` với non-tracked → **400 `STOCK_NOT_TRACKED`**
    (chặn trước khi claim idempotency slot).
- `PATCH /warehouse/product-admin/variants/:id` (update):
  - `itemType` đổi variant.productType; `trackInventory` đổi **template-level**
    (ảnh hưởng mọi variant cùng template — hàng POS tạo là 1:1 nên thực tế
    per-item);
  - đổi khỏi stockable khi tồn ≠ 0 → **409 `STOCK_MUST_BE_ZERO`**
    (body kèm `currentStockQty`).
- `POST .../variants/:id/stock-adjustments` trên item non-tracked →
  **409 `STOCK_NOT_TRACKED`**.
- Public catalog sync (`GET /warehouse/public/products`): item JSON có sẵn
  `productType` (variant) + `template.trackInventory` — app sync đọc từ đây.
- **Sale-path** (`b2b-pos` deductStock / restoreStock / restoreStockForLine):
  skip non-tracked — bán không trừ, hủy/refund không hoàn. Deploy 08/07.
- Error codes mới: `STOCK_NOT_TRACKED`, `STOCK_MUST_BE_ZERO` (đã có trong
  `ProductAdminErrorCode` union phía app).

## 3. App đã làm (merged main)

- Migration SQLite **v53**: `product_variants.item_type TEXT NULL`,
  `track_inventory INTEGER NOT NULL DEFAULT 1`.
- Helper chung `src/shared/product-stock-tracking.ts`:
  `isStockTracked()` / `productItemType()` — nhận cả camelCase/snake_case,
  NULL = tracked. **Mọi code mới đụng tồn kho phải đi qua helper này.**
- Ingestion cả 2 đường: catalog sync mapper (`api-client.ts`) + product-admin
  mirror (`pos.module.ts`); upsert COALESCE-preserve để caller không biết field
  không xóa mất giá trị đã sync.
- Capabilities mapper có `supportsItemType` (`51c8cf8` — mapper whitelist từng
  field, field mới nào cũng PHẢI thêm dòng map, có test chống tái phạm).
- UI Products tab: picker 3 loại ở Create (gate `supportsItemType`); Edit có
  select loại + ẩn ô tồn; ẩn nút "Điều chỉnh kho" (EditView + Drawer); tile
  hiện chip "Dịch vụ"/"Không tồn kho" thay strip màu + badge số; filter Sắp
  hết/Hết hàng bỏ qua non-tracked; stock row hiện "— (không theo dõi tồn)".
- **Local stock guard**: `STOCK_TRACKED_GUARD_SQL` (export từ `product-repo.ts`)
  gắn vào MỌI câu UPDATE tồn local — `decrementStock` 2 nhánh +
  `incrementStock` + 3 câu raw trong `order-repo.ts` (delete-restock /
  edit-restore / edit-deduct). Mutation tồn local MỚI nào cũng phải mang guard
  này (test `product-item-type-tracking.test.ts` đếm số lần dùng).
- i18n: en/vi/pl `products.itemType.*`.
- Tests: `product-item-type-tracking.test.ts` (helper + wiring contract),
  `product-stock-tracking-guard.test.ts` (hành vi thật trên sql.js). Full
  suite 209 files PASS.

## 4. CHƯA fully support — việc còn lại

### Cho bot app (review + làm tiếp)

1. **Sale grid / quick keys (POS tab bán hàng)** — CHƯA RÀ. Nếu tile bán hàng
   hiển thị số tồn, cảnh báo hết hàng, hoặc block bán khi stock 0: phải dùng
   `isStockTracked()` — service luôn bán được, không bao giờ "hết hàng".
2. **Kiosk / self-order / customer display** — CHƯA RÀ, cùng câu hỏi như trên.
3. **Ẩn sellBy (PIECE/WEIGHT) khi chọn service** trong Create/Edit — hiện vẫn
   cho chọn, vô hại nhưng vô nghĩa (service bán theo cân?).
4. **Search overlay / scan**: quét barcode một service (nếu có barcode) phải
   thêm vào giỏ bình thường — nên smoke test.
5. i18n 4 ngôn ngữ còn lại (tr/zh/uk/ru) đang fallback English.
6. Smoke test tay các flow mục 5 bên dưới.

### Backend (báo backend bot khi cần, KHÔNG tự sửa từ app)

- Multi-variant template: đổi `trackInventory` ảnh hưởng sibling; guard
  zero-stock chỉ check variant đang sửa (POS 1:1 nên chưa gấp — documented).
- Các đường bán KHÁC ngoài b2b-pos (B2B wholesale, ecommerce, kitchen-self-order
  backend) chưa gate stock-skip — POS là đường duy nhất bán service hiện tại.
- Máy cài mới: sync chỉ trả hàng active → service đã inactive không về (giới
  hạn chung của inactive, không riêng service).

## 5. Smoke test chuẩn (sau khi build main)

1. Build + mở app → Products: hàng hiện tại y nguyên (data live 100% stockable).
2. Tạo sản phẩm → picker "Loại sản phẩm" hiện (vì backend live) → chọn Dịch vụ
   → ô tồn kho biến mất → tạo OK, tile có chip "Dịch vụ".
3. Mở nó: không có nút Điều chỉnh kho, stock row "— (không theo dõi tồn)".
4. **Bán 2 cái** → đơn in/tính tiền bình thường; tồn local ĐỨNG IM và tồn
   backend ĐỨNG IM (trước đây backend ghi âm POS_OVERSOLD).
5. Refund/hủy đơn đó → không cộng kho ở đâu cả.
6. Guard đổi loại: hàng thường có tồn > 0 → Edit → đổi thành Dịch vụ → Save
   phải bị chặn 409 STOCK_MUST_BE_ZERO; recount về 0 thì đổi được.
7. Filter "Hết hàng"/"Sắp hết" không chứa hàng dịch vụ.
