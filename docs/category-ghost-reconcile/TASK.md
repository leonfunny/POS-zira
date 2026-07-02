# TASK: Category reconcile khi full sync — dọn 22 category "ma" trong pos.db

**Ngày giao:** 2026-07-02 · **Người giao:** Paul (qua Claude backend-session)
**Ưu tiên:** Trung bình (UI bẩn, không mất tiền) · **Phạm vi:** POS-zira app only — KHÔNG đụng backend (backend đã fix xong phần của nó, xem Bối cảnh)

## Bối cảnh — đo được trên POS1 ngày 2026-07-02

- `pos.db` (salon chesaigon) đang giữ **55 categories** trong khi backend chỉ còn **33** → **22 category "ma"** hiện trong tab Products.
- Ghost gần như toàn category rác do flow web `/add` từng auto-tạo theo category shop nguồn (backend đã sửa: không auto-tạo nữa, có dropdown + mapping — prod commits `369472b2`, `d84d2e81`, `c4006560`). Người dùng xoá trên web nhiều đợt, nhưng app không bao giờ quên: có tên tồn **5 đời id khác nhau** ("Kẹo và đồ ăn nhẹ/Đồ ăn nhẹ" ×5, "Đồ uống/Nước trái cây" ×3, "Nước sốt và thực phẩm lỏng/Nước sốt" ×2, họ "Thực phẩm đông lạnh/*" ×4, tên Ba Lan "Przekąski", "Pojemniki Na Wynos"…).
- Chỉ **1** dòng `product_variants` local (đã inactive) còn trỏ vào ghost → dọn an toàn.

## Root cause (đã xác minh trong source POS1)

`src/main/sync/product-sync.ts` — trong `fullSync()`:

- **Products** có reconcile xoá: `productRepo.deactivateExcept(syncedIds)` (kèm ngoại lệ local_variant_imports) ✅
- **Categories** chỉ có `productRepo.upsertCategories(data.categories)` — **không có bước xoá row vắng mặt** ❌

Backend trả về danh sách category đang tồn tại (`/warehouse/...` payload `data.categories`); category bị xoá trên backend chỉ đơn giản "vắng mặt" → app giữ vĩnh viễn.

## Việc cần làm (TDD — test trước)

### Task 1 — `productRepo.deleteCategoriesExcept(keepIds: Set<string>)`
Bảng local `categories` không có cột is_active → **DELETE** thẳng các row có `id NOT IN keepIds`.
Guard trước khi delete:
- `UPDATE product_variants SET category_id = NULL WHERE category_id IN (<ids sắp xoá>)` (1 dòng hiện tại + phòng về sau).
- Nếu `local_variant_imports` / bảng nào khác có FK category thì nullify tương tự (kiểm tra schema thật).
Trả về số row đã xoá để log.

### Task 2 — Gọi trong `fullSync()` (CHỈ full sync, KHÔNG delta)
Trong cùng `database.transaction()` hiện có, **sau** `upsertCategories`:
```ts
if (data.categories.length > 0) {
  const keep = new Set(data.categories.map((c) => c.id));
  const removed = productRepo.deleteCategoriesExcept(keep);
  if (removed > 0) logger.info(`[ProductSync] Pruned ${removed} categories deleted on backend`);
}
```
Lưu ý guard `data.categories.length > 0` — payload rỗng bất thường thì KHÔNG xoá sạch (giống triết lý guard sẵn có của products). Cân nhắc nối vào `evaluateProductSyncGuard` baseline nếu muốn chặt hơn (baseline có sẵn `categoryCount`).

### Task 3 — Tests (vitest)
1. Ghost bị xoá khi vắng mặt trong payload full sync.
2. Payload rỗng → không xoá gì.
3. Variant đang trỏ ghost → category_id thành NULL, variant còn nguyên.
4. Delta sync KHÔNG kích hoạt prune.

### Task 4 — Verify trên máy thật
Sau khi build + chạy: full sync xong `SELECT COUNT(*) FROM categories` phải = số backend (hiện 32). 22 ghost tự biến mất — KHÔNG cần script dọn tay, KHÔNG sửa pos.db thủ công (sql.js ghi đè cả file — cấm đụng khi app chạy).

### Task 5 (điều tra thêm, tách PR riêng nếu làm) — dropdown category cho flow scan-add TRONG APP
Web /add giờ có dropdown chọn category + mapping nhớ lựa chọn (backend: `POST /master-catalog/import-draft` nhận `categoryId` optional; `lookup-by-ean` trả `draft.suggestedCategoryId`). Nếu app có flow scan→tạo sản phẩm từ draft (local_variant_imports?) thì điều tra và làm parity: hiện dropdown categories (đã có local cache), preselect `suggestedCategoryId`, gửi `categoryId` khi import. Backend KHÔNG cần đổi gì thêm.

## Chú ý an toàn
- Mọi thay đổi trong transaction sẵn có của fullSync (đã có restore-point trước full sync).
- Không đổi hành vi delta sync, không đổi backend, không đụng order/fiscal.
