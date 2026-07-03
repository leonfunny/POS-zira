# TASK: local-variant-import hardening + shift-sync fix (2026-07-04)

> Người gửi: Claude (backend/Netcup) — theo yêu cầu Paul.
> Bối cảnh đầy đủ bên dưới; 4 task xếp theo ưu tiên. Backend ĐÃ vá phần của nó và deploy xong.

## Bối cảnh (chuyện đã xảy ra 03/07)

- POS1 có **2 row `local_variant_imports` kẹt PENDING retry vô hạn**, spam `POST /master-catalog/scan-create` 2 request mỗi 30s **suốt 10 ngày**:
  - Mì Tôm OMACHI 80g×30 thùng, EAN `08936136166391` (GTIN-14) — **27.689 attempts** từ 23/06.
  - Bún Tươi Gia Bảo thùng ×20, EAN `8936150380032` — 4.467 attempts từ 02/07.
- Nguyên nhân phía app:
  1. `reconcileLocalVariantImports` (src/main/sync/product-sync.ts) chỉ `markFailed` cho lỗi price/stock; **mọi lỗi khác → `markAttempt` → PENDING vĩnh viễn, không có cap**.
  2. Payload gửi `categoryId` = **id numeric local** (vd `1214553906`) — backend yêu cầu UUID → 400.
  3. EAN thùng 14 số — backend trước đây chỉ nhận ≤13 → 400.
- **Backend đã vá + deploy Contabo 03/07 ~22:10 UTC** (commit `1222b52c` repo eNail):
  - scan-create nhận EAN 4–14 (GTIN-14 OK; cột `variants.ean` ≤13 nên mã 14 số chỉ nằm ở `barcode`).
  - `categoryId` không phải UUID → **drop** thay vì 400 → rơi về default category mapping.
  - 2 item kẹt đã import xong (variant `727cc871` OMACHI, `d67a6c21` Bún) — spam đã tắt 22:17 UTC.
- Gotcha DB phát hiện trong lúc xử: unique index `IDX_variants_salon_sku (salon_id, sku)` **không loại row soft-deleted** → import lại sản phẩm đã xóa sẽ 409 `VARIANT_EXISTS` mãi mãi (case Bún: row xóa 26/06 vẫn giữ sku `EAN-8936150380032`).

## TASK A — retry cap + xử lý 409 + surfacing (ưu tiên cao nhất)

1. `reconcileLocalVariantImports`: thêm `MAX_ATTEMPTS` (đề xuất **50**). `attempts >= MAX_ATTEMPTS` → `markFailed(variantId, lastError)` — giống pattern retryUnsyncedShifts đang làm (cap 5 → synced=-1).
2. Khi scan-create trả **409 VARIANT_EXISTS**: đừng retry mù. Gọi `lookup-by-ean`; nếu server đã có variant active với EAN đó → `markSynced(variantId, serverVariantId)` (map thay vì create). 409 mà lookup không ra → markFailed luôn (đó là case sku bị row-đã-xóa giữ — cần người xử).
3. UI Products: badge **"Cần xử lý (N)"** liệt kê row FAILED — cho sửa category/EAN rồi re-queue (reset `attempts=0`, `status='PENDING'`).

## TASK B — gửi category đúng

Trước khi enqueue scan-create: map category local (id numeric) → **backend category UUID**; không map được → gửi `null`, đừng gửi id local. Migration v51 đã thêm cột `category_id` trong `local_variant_imports` — điền UUID vào đó từ lúc tạo (UI chọn category của 3875fa2 đã có, nối cho đủ mạch).

## TASK C — shift sync (lỗi thật 03/07: ca Khanh Linh pos2 không đăng ký được)

1. `openPosShift` (src/main/network/api-client.ts) **gửi kèm `machineId`** — backend `PosShiftService.openShift` đã group theo salon+machineId từ lâu; app không gửi → cả salon chung 1 slot `machine_id NULL`, máy mở ca trước chặn máy sau (đúng vụ sáng 03/07: ca pos2 cũ chặn ca mới, phải đóng tay bằng SQL).
2. `retryUnsyncedShifts` hiện **chỉ chạy on-reconnect** — thêm retry theo lịch (mỗi ~5 phút khi online và còn shift `synced=0`), giữ cap 5.
3. Lưu `backend_id` khi sync OK — main đã có, giữ nguyên.

## TASK D — release

- **Bump version 1.0.20** trước khi package/đẩy R2 — hiện tồn tại 2 bản "1.0.19" khác nhau (bản pin "Zira AI" và bản fix userData), updater không phân biệt được.
- Fix userData `02d80f8` đã verify chạy đúng trên POS1 (giữ `zira-ai`) và pos2 (pos2 đã dọn: folder cũ rename thành `zira-ai.bak-20260703`, chỉ còn "Zira AI").

## Ghi chú (không phải việc app)

- `POST /api/v1/pos-events/batch` 404 = backend Contabo thiếu module pos-events (deploy dist từ nhánh không có nó). Việc backend — outbox cứ để tích, sẽ flush khi route lên.
