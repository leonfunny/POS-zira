# PROMPT Task 5 — Dropdown category cho flow scan-import TRONG APP (PR riêng)

Đọc `C:\Users\pc\POS-zira\docs\category-ghost-reconcile\TASK.md` mục Task 5 để lấy bối cảnh, rồi làm PR **tách riêng** — TUYỆT ĐỐI không đụng code prune category vừa ship (deleteCategoriesExcept / fullSync), không đụng backend, không đụng order/fiscal.

## Backend contract (ĐÃ LIVE trên api.enail.pro từ 2026-07-02 — app không cần chờ gì)

- `POST /master-catalog/lookup-by-ean` → khi `mode: "IMPORT_DRAFT"`, response có thêm `draft.suggestedCategoryId: string | null` (mapping shop-nguồn→shop-mình đã nhớ từ lần chọn trước; null nếu chưa từng chọn).
- `POST /master-catalog/import-draft` → nhận thêm field **optional** `categoryId` (uuid, phải là category của salon — backend validate). Bỏ qua → backend tự dùng mapping đã nhớ, không có mapping thì vào ô "Chưa phân loại". Gửi categoryId → backend TỰ ghi nhớ mapping cho lần sau. **App không phải lưu mapping gì cả.**

## Việc cần làm (điều tra → báo plan → chờ duyệt → TDD)

1. **Điều tra hiện trạng**: flow scan-import trong app — IPC `importDraft` hiện nhận `{ ean, retailPriceGrosze }`; modal scan-import hiện chỉ hỏi giá. Xác định file IPC handler (main), preload, component modal (renderer), và response lookup đang được map vào preview ở đâu (field `suggestedCategoryId` hiện bị rơi).
2. **Mở rộng IPC** `importDraft`: thêm `categoryId?: string`, truyền xuống body POST `/master-catalog/import-draft`. Không gửi field khi rỗng/undefined.
3. **Map `suggestedCategoryId`** từ response lookup-by-ean vào draft preview đưa sang renderer.
4. **Modal thêm dropdown "Danh mục"**:
   - Options = `productRepo.getCategories()` (cache local sẵn có — sau fix prune thì cache này luôn khớp backend).
   - Option đầu: `"Chưa phân loại (mặc định)"` với value rỗng → không gửi `categoryId`.
   - Preselect `suggestedCategoryId` NẾU id đó có trong options; không có trong list (mapping trỏ category vừa bị xoá, cache chưa kịp sync) → rơi về option mặc định.
   - Staff đổi được thoải mái; chọn gì gửi nấy.
   - Nếu cache categories rỗng → ẩn dropdown, gửi như cũ (không chặn import).
5. **TDD vitest**:
   - IPC gửi body có `categoryId` khi chọn, KHÔNG có field khi để mặc định;
   - preselect đúng khi suggested nằm trong list; fallback mặc định khi suggested không có trong list / null;
   - categories rỗng không vỡ UI/không chặn import;
   - payload cũ (không categoryId) vẫn hoạt động (backward compat).
6. **Quy trình**: báo findings + plan trước, chờ duyệt rồi code; xong chạy targeted tests + `npm run build`, nộp diff + kết quả test để review TRƯỚC khi cài lên máy thật.
