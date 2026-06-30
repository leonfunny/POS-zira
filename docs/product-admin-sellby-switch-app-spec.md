# Spec (bot-app): Đổi đơn vị bán kg ↔ pcs trong Products tab

> Phạm vi: **CHỈ phần app** cho việc đổi `sellBy` (PIECE ↔ WEIGHT) khi sửa sản phẩm.
> Backend đã làm xong + deploy Contabo (verify OK). Category-không-hiện **KHÔNG nằm trong spec này** (đã xử lý riêng).
> Ngày: 2026-06-30. Backend commit `cfb541f2` (production `4c078f26`).

---

## 0. Backend đã hỗ trợ gì (contract MỚI — không cần sửa backend)

**Endpoint:** `PATCH /api/v1/warehouse/product-admin/variants/:variantId`

Body (tất cả optional) — giờ chấp nhận thêm **`sellBy`**:
```jsonc
{
  "name": "...", "barcode": "...", "sku": "...",
  "priceGrossGrosze": 1500, "vatRate": 23, "categoryId": "...",
  "saleUnit": "szt",            // 'kg' cho WEIGHT, 'szt' cho PIECE
  "sellBy": "PIECE",            // <-- MỚI: 'PIECE' | 'WEIGHT'
  "imageUrl": "...", "isActive": true,
  "expectedUpdatedAt": "<iso>"  // optimistic concurrency
}
```

**Hành vi quan trọng:** Khi `sellBy` **đổi** so với giá trị hiện tại của variant, backend **TỰ ĐỘNG ZERO TỒN** (đặt `total_stock_qty = 0` + zero tất cả `stock_quants` của variant, atomic trong cùng transaction). Nếu `sellBy` không đổi hoặc không gửi → tồn **không** bị đụng.

**Response:** `{ variant: ProductAdminVariant, serverTime }`. `ProductAdminVariant` giờ có trường **`sellBy: 'PIECE' | 'WEIGHT' | null`** và `totalStockQty` đã phản ánh tồn sau khi zero.

> Lý do zero: tồn kg (số thập phân) và tồn pcs (số nguyên) là 2 đơn vị khác nhau, số cũ vô nghĩa sau khi đổi. Cashier nhập lại tồn theo đơn vị mới.

---

## 1. `src/shared/types.ts` — thêm `sellBy` vào type

### 1a. Input update
`ProductAdminUpdateVariantInput` hiện **THIẾU** `sellBy`. Thêm:
```ts
export interface ProductAdminUpdateVariantInput {
  name?: string;
  barcode?: string | null;
  sku?: string | null;
  priceGrossGrosze?: number;
  vatRate?: number;
  categoryId?: string | null;
  saleUnit?: string | null;
  sellBy?: 'PIECE' | 'WEIGHT';   // <-- THÊM
  imageUrl?: string | null;
  isActive?: boolean;
  expectedUpdatedAt?: string;
  expectedVersion?: number;
}
```
(Có thể bỏ luôn `retailPrice?` thừa nếu còn — app chỉ gửi `priceGrossGrosze`.)

### 1b. Response variant
Đảm bảo `ProductAdminVariant` (type response) có `sellBy?: 'PIECE' | 'WEIGHT' | null`. Nếu chưa có thì thêm — để `mirrorProductAdminVariant` đọc đúng `variant.sellBy`.

---

## 2. `src/main/network/api-client.ts` — NGỪNG strip `sellBy` khi update

Hiện `updateProductVariant` (~dòng 1617) strip `sellBy` đi trước khi gửi:
```ts
// HIỆN TẠI (sai — backend giờ đã hỗ trợ sellBy):
const body = withoutUnsupportedProductAdminSellBy(payload);
return this.productAdminRequest<...>(token, 'PATCH', `/variants/${encodeURIComponent(variantId)}`, body);
```
**Sửa:** gửi thẳng `payload` (không strip):
```ts
return this.productAdminRequest<...>(token, 'PATCH', `/variants/${encodeURIComponent(variantId)}`, payload);
```
→ Có thể **xoá luôn** helper `withoutUnsupportedProductAdminSellBy` (~dòng 480) nếu không còn chỗ nào dùng. (Lưu ý: `createProductVariant` đã gửi `sellBy` bình thường rồi, không đụng tới.)

---

## 3. `src/renderer/components/products/ProductEditForm.tsx`

### 3a. Gửi `sellBy` trong payload update
Payload (~dòng 176) hiện **không có** `sellBy`. Thêm:
```ts
const payload: ProductAdminUpdateVariantInput = {
  name: name.trim(),
  barcode: barcode.trim() || null,
  sku: sku.trim() || null,
  priceGrossGrosze,
  vatRate: Number(vatRate),
  categoryId: categoryId || null,
  saleUnit: saleUnit.trim() || null,
  sellBy,                          // <-- THÊM (state 'PIECE' | 'WEIGHT')
  imageUrl: imageUrl.trim() || null,
  isActive: product.is_active !== 0,
  expectedUpdatedAt: product.updated_at || undefined,
};
```

### 3b. Khi gạt đổi đơn vị → RESET tồn về 0 + bắt nhập lại (không cắt thập phân)
Handler toggle hiện (~dòng 387-393) chỉ cắt phần thập phân khi sang PIECE:
```ts
// HIỆN TẠI (sai ngữ nghĩa):
setSellBy(nextSellBy);
if (nextSellBy === 'PIECE' && stockQty.includes('.')) {
  setStockQty(String(Math.floor(Number(stockQty) || 0)));
}
```
**Sửa** — khi đơn vị thực sự đổi so với đơn vị gốc của sản phẩm thì reset ô tồn về '0' và buộc nhập lại:
```ts
const originalSellBy = productSellBy(product); // đơn vị gốc của variant
setSellBy(nextSellBy);
setSaleUnit(nextSellBy === 'WEIGHT' ? 'kg' : 'szt'); // gợi ý đơn vị mặc định
if (nextSellBy !== originalSellBy) {
  setStockQty('0');         // backend sẽ zero tồn; user nhập lại theo đơn vị mới
  setStockResetNotice(true); // hiện cảnh báo (3c)
} else {
  setStockResetNotice(false);
}
```

### 3c. Thông báo UX
Khi `sellBy` khác đơn vị gốc, hiện dòng cảnh báo gần ô tồn:
> "Đổi đơn vị bán sẽ **xoá tồn hiện tại** — nhập lại số lượng theo đơn vị mới."

(Tiếng Anh fallback: "Changing the sale unit clears current stock — re-enter the quantity in the new unit.")

### 3d. Thứ tự lưu (đã đúng sẵn — chỉ cần đảm bảo)
Form đang: update variant TRƯỚC (dòng ~196) → rồi adjustStock SAU (dòng ~215) với `expectedUpdatedAt` lấy từ response update (dòng ~204). **Giữ nguyên thứ tự này.** Lý do:
1. `updateVariant({ sellBy })` → backend zero tồn + đổi mode, trả `updatedAt` mới.
2. `adjustStock({ mode: 'recount', newQuantity: <giá trị user nhập lại> })` → đặt tồn theo đơn vị mới, dùng `updatedAt` mới (tránh stale).

Nếu user để tồn = 0 (không nhập lại) → update zero + adjustStock recount-0 → tồn = 0. OK.

`parseStockQuantity(stockQty, sellBy)` đã validate theo `sellBy` (PIECE = số nguyên, WEIGHT = tối đa 3 chữ số thập phân) — giữ nguyên, nó tự đúng sau khi `sellBy` đổi.

---

## 4. Checklist test (app)

- [ ] Type `ProductAdminUpdateVariantInput` có `sellBy`; `ProductAdminVariant` có `sellBy`.
- [ ] `updateProductVariant` gửi `sellBy` (kiểm tra body trên wire có `sellBy`, không bị strip).
- [ ] Sửa 1 SP WEIGHT (vd tồn 3kg) → gạt sang PIECE: ô tồn tự về 0 + hiện cảnh báo. Lưu → tồn = 0 (mirror local + UI). Nhập lại 5 → lưu → tồn = 5 pcs.
- [ ] Gạt PIECE → WEIGHT tương tự (ô tồn về 0, đơn vị 'kg', nhập lại vd 2.5).
- [ ] Sửa SP nhưng KHÔNG đổi đơn vị → tồn giữ nguyên (không bị zero).
- [ ] Sau lưu, `mirrorProductAdminVariant` lưu `sell_by` đúng → `productSellBy(product)` phản ánh đơn vị mới ở lần mở sau.

## 5. Ngoài phạm vi
- Danh mục rỗng không hiện (đã xử lý riêng) — KHÔNG làm ở đây.
- Không cần đổi backend; backend đã accept `sellBy` + auto-zero tồn.
