# PROMPT cho bot — Category ghost reconcile (POS-zira app)

Copy nguyên khối dưới đây đưa cho bot:

---

Đọc kỹ file `C:\Users\pc\POS-zira\docs\category-ghost-reconcile\TASK.md` rồi **ĐIỀU TRA trước, chưa code**:

1. **Xác nhận root cause** trong `src/main/sync/product-sync.ts`: `fullSync()` có `productRepo.deactivateExcept(syncedIds)` cho products nhưng categories chỉ có `productRepo.upsertCategories(data.categories)` — không có bước dọn category đã bị xoá trên backend.
2. **Đo hiện trạng**: đếm categories trong pos.db so với backend. ⚠️ TUYỆT ĐỐI không mở/sửa `pos.db` khi app đang chạy (app dùng sql.js — ghi đè cả file); muốn đọc thì `copy` ra file khác rồi đọc bản copy. Kỳ vọng: ~55 local vs 32 trên backend (22+ ghost, có tên tồn 5 đời id như "Kẹo và đồ ăn nhẹ/Đồ ăn nhẹ").
3. **Soi schema local**: bảng `categories` (không có is_active → sẽ DELETE), liệt kê mọi bảng có cột `category_id` (product_variants, local_variant_imports, …) để thiết kế bước nullify FK trước khi xoá.
4. **Xem `evaluateProductSyncGuard`** + `baseline.categoryCount` — đề xuất có nối guard "payload categories rỗng thì không xoá gì" vào guard sẵn có không.
5. **Báo cáo findings + kế hoạch theo 5 task trong TASK.md, chờ duyệt rồi mới code.** Khi code: TDD bằng vitest từng task, chỉ đụng full sync (không đụng delta sync, không đụng backend, không đụng order/fiscal). Kết quả cuối: sau 1 lần full sync, số categories local == số backend, ghost tự biến mất, không cần script dọn tay.

Task 5 trong TASK.md (dropdown chọn category cho flow scan-add TRONG APP) là hạng mục điều tra riêng, tách PR — backend đã sẵn sàng từ 2026-07-02: `POST /master-catalog/import-draft` nhận `categoryId` (optional), `POST /master-catalog/lookup-by-ean` trả `draft.suggestedCategoryId`; app không cần backend đổi thêm gì.

---
