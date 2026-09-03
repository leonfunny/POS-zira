# Tạo sản phẩm nhiều biến thể từ tờ "Đơn in" — thiết kế

Ngày 2026-09-03. Cho xưởng may New Fashion (salon 7482), chạy trên máy `tnh`.
Nhánh POS: `feat/label-print-order-20260902` (không đụng `main`).
Nhánh backend eNail: `feat/product-variants-admin-20260903`.

## Vì sao

Tạo sản phẩm trong POS hiện chỉ có tên, giá, mã vạch — không có màu, không có
size. Xưởng vải cần một mã hàng có 6 màu × 3 size = 18 dòng hàng thật, mỗi dòng
có tồn kho riêng.

Tờ "Đơn in" đã là bảng màu × size rồi: `rows[].colorName`, `sizes[].label`,
`quantities[sizeId]`. Nên nhập một tờ, in nhãn và/hoặc lưu thành sản phẩm — không
dựng bảng thứ hai ở màn tạo sản phẩm.

Salon này **không bán tại POS**. Sản phẩm ở đây để in nhãn, theo dõi số lượng và
lưu nhà cung cấp. Doanh thu tính sau, ngoài phạm vi bản này.

## Variant ở backend — nền tảng

Hai bảng. `products` là mẫu (tên, danh mục, thuế). `product_variants` là hàng
thật (SKU, mã vạch, giá, tồn kho, `color_name`, `size_name`). **Mọi bảng khác
trỏ vào `variant_id`**, không trỏ vào `product_id`.

Một komplet nhiều màu = **1 dòng `products` + N dòng `product_variants`**.

Màu/size có hai đường lưu song song và chúng không đồng bộ với nhau:

1. Cột thẳng trên variant: `color_name`, `color_hex`, `color_code`, `size_name`,
   `size_type`.
2. Hệ thuộc tính kiểu Odoo (`product_attributes_new` →
   `product_attribute_values_new` → `template_attribute_lines` →
   `variant_assigned_attributes`) cộng endpoint
   `POST /products/templates/:id/generate-variants` sinh tổ hợp.

Đường 2 đang chạy thật cho dashboard web và import IdoSell/Woo, nhưng nó đặt tên
variant `"LOTUS - Đỏ / M"` mà **không** ghi `color_name`/`size_name`.

**Chọn đường 1** cho salon vải: POS đọc một bảng, không join bốn bảng. Đường 2 để
nguyên, không đụng.

## Đã đo, không phải suy đoán

- `GET /api/v1/warehouse/public/products` và `.../sync-v2` **đã trả sẵn**
  `colorName`, `colorHex`, `colorCode`, `sizeName`, `sizeType`
  (`product.service.ts:1394` spread nguyên entity). Đo bằng curl trên dev với
  salon `e-moon`, cả hai endpoint HTTP 200 và có đủ khoá.
  ⇒ **Không phải sửa gì ở đường sync.**
- Salon 7482 hiện có 2 sản phẩm / 8 variant. LOTUS đúng chuẩn (7 variant, 6 màu,
  size UNI). Kurtka sai: 1 variant nhồi `"mix kolorów"` và `"S/M M/L"` vào một
  dòng — lỗi nhập tay, không phải schema thiếu chỗ.
- Cột `color_name`/`size_name` đã tồn tại trên `product_variants` ⇒ **không có
  migration DB phía backend**.

## Backend — `createProduct` nhận nhiều variant

Một file DTO, một file service. Thuần cộng thêm.

### Hợp đồng

`CreateProductAdminProductDto` thêm một trường tuỳ chọn:

```ts
variants?: Array<{
  colorName?: string | null;
  sizeName?: string | null;
  sku?: string | null;
  barcode?: string | null;
  priceGrossGrosze?: number;   // vắng ⇒ lấy giá ở cấp trên
  initialStockQty?: number;    // vắng ⇒ 0
}>
```

**Vắng `variants` ⇒ hành vi cũ y hệt từng byte.** Đây là chỗ bảo vệ mọi salon
khác đang gọi endpoint này.

Trả về thêm `variants: ProductAdminVariant[]` khi request có `variants`; trường
`variant` cũ vẫn là variant đầu tiên, để client cũ không vỡ.

### Ràng buộc

- 1–100 phần tử. Quá 100 ⇒ 400 `TOO_MANY_VARIANTS`.
- Cặp `(colorName, sizeName)` phải khác nhau trong cùng request ⇒ nếu trùng, 400
  `DUPLICATE_VARIANT_COMBINATION`. Cặp này là khoá khớp lại khi resume, nên nó
  phải duy nhất.
- `sku`/`barcode` trùng nhau trong cùng request ⇒ 400
  `DUPLICATE_VARIANT_CODE` (không để index DB nổ giữa transaction).
- `sku`/`barcode` trùng với variant đã có trong salon ⇒ 409 `DUPLICATE_SKU` /
  `DUPLICATE_BARCODE` như hiện nay, chỉ mở rộng để quét cả N mã.

### Chỗ khó: sổ idempotency

`product_admin_create_requests` lưu **một** `variant_id` và **một** `template_id`.
Không nhét N id vào đó, và cũng không cần:

- Cả template lẫn N variant nằm trong **cùng một transaction**. Nên `template_id`
  khác NULL vẫn chứng minh "đủ N dòng đã commit" — bất biến
  `!!variantId !== !!templateId ⇒ inconsistent` giữ nguyên.
- `variant_id` = variant đầu tiên (variant "chính"), chỉ để tương thích ngược.
- Lúc resume, đọc lại N variant bằng `templateId` rồi khớp qua
  `(colorName, sizeName)` để biết ô nào cần nhập bao nhiêu tồn.

Tồn kho ban đầu chạy **sau** transaction, mỗi variant một lần
`adjustStock(RECOUNT)` với khoá riêng `create-initial:<requestId>:<variantId>`.
RECOUNT nên phát lại là idempotent: gãy ở variant thứ 3/18 thì thử lại chỉ ghi
tiếp, không cộng dồn. Đường một-variant giữ nguyên khoá cũ
`create-initial:<requestId>` để request cũ vẫn khớp.

Fingerprint payload phải bao gồm `variants` — nếu không, hai đơn khác nhau dùng
chung một Idempotency-Key sẽ được coi là một.

### Deploy

Không migration. Đi lane `deploy-backend-contabo.sh`, **khoá 08:00–20:59 giờ
Warsaw** ⇒ chạy sau 21:00. Lùi lại = trả file `dist` cũ.

## POS — nhánh `feat/label-print-order-20260902`

| Việc | File |
|---|---|
| Ba ô mới trên tờ đơn: nhà cung cấp, giá, ngày | `PrintOrderPanel.tsx` + `label-print-order.ts` |
| Nút **"Lưu thành sản phẩm"** cạnh nút in | `PrintOrderPanel.tsx` |
| Dựng payload N variant từ `rows × sizes` | `src/shared/order-to-product.ts` (mới) |
| Gửi qua outbox, **một** dòng mutation cho cả lô | `pos.module.ts`, `product-admin-mutation-outbox-repo.ts` |
| Mirror N variant về `pos.db` kèm màu/size | `pos.module.ts` (`mirrorProductAdminVariant`) |
| Cột `color_name`, `size_name` cho bảng local | `src/main/database/migrations.ts` |

### Quyết định

- **SKU tự sinh** theo nếp LOTUS đang có: `<styleCode>-<màu>-<size>`, ví dụ
  `MOON-VE114-BEZ-M`. Sửa tay được từng ô trước khi gửi.
- **Ô trống không tạo variant.** Bảng 6×3 mà chỉ điền 11 ô thì tạo 11 variant,
  không tạo 18.
- **Migration POS đánh số từ 900**, không phải 69. Nhánh này sống riêng cho một
  salon; đánh 69 là chắc chắn đụng số với một migration 69 khác trên `main` sau
  này.
- Gửi **một** dòng outbox cho cả lô, không phải N dòng. Máy quầy hay rớt mạng;
  một giao dịch một khoá thì không bao giờ có cảnh tạo được 7/18 rồi đứt.
- Lưu lại `productId` vào tờ đơn sau khi tạo, để bấm hai lần không đẻ ra hai sản
  phẩm.

## Ngoài phạm vi (cố ý)

- Gom biến thể ở màn bán hàng — Paul nói chưa cần, salon này không bán tại POS.
- Doanh thu — tính sau.
- Hệ thuộc tính Odoo — để nguyên.
- Sửa lại dữ liệu Kurtka đang sai — việc nhập liệu, làm riêng.

## Test

Backend: unit cho DTO validation (4 mã lỗi trên), cho `createProduct` với
`variants` (tạo đủ N, resume sau khi gãy giữa chừng, replay cùng
Idempotency-Key trả cùng kết quả, đường không-`variants` không đổi). Mutation-test
từng khẳng định.

POS: unit cho `order-to-product.ts` (ô trống, SKU sinh ra, trùng cặp màu/size),
component test cho nút lưu, test cho mirror N dòng.
