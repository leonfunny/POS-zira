# TASK nhỏ: close-retry cần terminal state (2026-07-06)

**Hiện tượng**: backend nhận `POST /pos/shifts/dfeb4692-daee-4c58-bde6-940c5a8fca87/close` → 404 "Open shift not found" **mỗi đúng 5 phút**, 386 lần trong 05-06/07, chạy từ 03/07. Nguồn: `retryUnsyncedShifts()` → vòng `unsyncedClose` (SELECT shifts WHERE synced=1 AND backend_id NOT NULL AND closed_at NOT NULL AND closing_cash NOT NULL) **không có terminal marker** — thành công hay 404 đều không đánh dấu, nên timer 5 phút (mới thêm ở 1.0.20) re-post vĩnh viễn.

**Việc cần làm**:
1. Tìm row thủ phạm trên POS1 + pos2: `SELECT id, staff_name, opened_at, closed_at, backend_id FROM shifts WHERE backend_id LIKE 'dfeb4692%';`
2. Thêm terminal state cho close-retry: migration thêm cột `close_synced INTEGER DEFAULT 0` (hoặc tái dùng convention synced=-1 style); filter thêm `AND close_synced = 0`; set `close_synced = 1` khi close thành công **HOẶC khi backend trả 404** (404 = ca đã đóng/không tồn tại phía server — coi như xong, đừng retry).
3. (Cùng chỗ) cap attempts giống open-retry cho chắc.

Backend không cần đổi gì. Route/logic server đúng; đây thuần túy app-side. Fleet đang chạy tốt — 04+05/07 mỗi máy ca riêng machine_id chuẩn, không chặn chéo.
