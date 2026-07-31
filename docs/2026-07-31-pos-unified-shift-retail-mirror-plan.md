# Wave 3 — Salon bi-a trên POS: MỘT CA, MỘT SỔ (plan, chờ duyệt)

> Ruling Paul 31/07 tối: hành vi theo salon. Salon bi-a → ca và sổ sách quy về
> bi-a (như web); salon tạp hóa → giữ nguyên đang chạy, không đổi một ly.
> Bối cảnh: gm là máy dev, quán bia thật vẫn 100% web, chưa có máy in fiscal —
> build trước, có máy thì lắp test.

## Điều tra chốt (31/07)

- Công tắc per-salon có sẵn: **`entitlements.features` của POS** (tab Bi-a đang
  bật theo entitlement billiard) → mọi hành vi mới gate theo đây, salon tạp hóa
  miễn nhiễm tuyệt đối.
- Hook chốt đơn POS có sẵn: `posEventEmitter.emitOrderFinalized(order, items)`
  (order-repo:504, idempotent theo dedupe_key).
- Đơn handoff bi-a phân biệt được: `orders.billiard_origin_json != null`
  (tiền bàn đã thuộc sổ bi-a qua session — phải loại khỏi mirror, không double).
- Đơn có `client_attempt_id` (uuid) — dùng làm idempotency key cho mirror,
  không cần migration.
- 2 hệ ca hiện hữu: cashier shift POS (local-first `shifts` + sync
  `cashier_shifts`) và business shift bi-a (server `billiard_daily_closes`).

## Phase A — Ca hợp nhất (salon bi-a)

Một hành động của thu ngân điều khiển cả hai sổ; két tiền vật lý là một.

- **A1 Mở ca**: handler `pos:shift:open` — sau khi mở ca POS local thành công,
  nếu (billiard salon && online && server chưa có ca bi-a mở) → POST
  `/billiard/shifts/open` `{openingCash: <cùng float>, notes: "auto cùng ca POS
  <id8>"}`. Offline/lỗi mạng → KHÔNG chặn ca POS (chip đỏ trên floor sẽ nhắc mở
  khi có mạng).
- **A2 Đóng ca**: flow `pos:shift:close` — nếu ca bi-a đang mở: lấy
  `GET /billiard/daily-close/summary`, màn đóng ca POS thêm khối **"Bi-a"**
  (tiền mặt dự kiến bi-a + tổng dự kiến GỘP của cả két = POS + bi-a) để thu
  ngân đếm MỘT lần; sau khi ca POS đóng xong → POST `/billiard/shifts/:id/close`
  với `notes` ghi link ca POS + số đếm két gộp, **không truyền actualCash riêng**
  — màn đối chiếu chi tiết 3 phương thức vẫn là đất của web (xem lại bất cứ lúc
  nào ở tab Đóng ca web). Ca bi-a chưa mở → flow đóng như cũ.
- **A3** Chip Ca bi-a trên sơ đồ giữ nguyên (thông tin + mở tay khi cần).

## Phase B — Mirror bán lẻ tab POS → sổ bi-a (salon bi-a)

Bán lẻ vẫn bán ở **tab POS như thường** (đúng ruling trước — không có UI bán lẻ
nào quay lại tab bi-a). Thêm plumbing vô hình: đơn chốt xong tự ghi một phiên
"Bán lẻ" vào sổ bi-a server — Lịch sử + Báo cáo bi-a (web lẫn POS) thấy nó
y như bán lẻ làm trên web.

- **B1 Contract**: thêm lại `POST /billiard/retail/quick-sale` với op MỚI
  **`retail_mirror`**, policy **`queue-safe`** — server idempotent theo
  paymentAttemptId + fingerprint nên **mất wifi vẫn bán bình thường, mirror tự
  replay khi có mạng, không bao giờ ghi đôi**. Test denial hiện tại đổi thành
  allow đúng op này (comment giải thích: plumbing, không phải UI).
- **B2 Main hook**: trên `emitOrderFinalized` — điều kiện: salon bi-a
  && `billiard_origin_json == null` && đơn thanh toán xong → build payload
  {items: [{name, quantity, unitPrice}] từ order_items (bỏ dòng có
  `billiard_json`), paymentMethod map CASH/CARD/BLIK/TRANSFER,
  paymentAttemptId: `client_attempt_id`, sourceRef: order.id} → đẩy qua
  `executeMutation('retail_mirror', ...)`. Helper build payload = hàm thuần,
  unit-test đầy đủ (map method, lọc dòng bi-a, làm tròn tiền).
- **B3 BE nhỏ (1 cặp file)**: `RetailQuickSaleDto` thêm optional
  `sourceRef` (≤64) lưu vào `pricingSnapshot.quickSale.sourceRef` — đối soát
  phiên mirror ↔ đơn POS về sau. Deploy exact-file như mọi khi.
- **B4 Giới hạn phase này (ghi rõ)**: hoàn/void đơn POS **không** tự trừ sổ
  bi-a (cần thì void tay trên web bằng nút Xóa nợ; mirror-void là phase sau).
- **B5 Sổ sách**: với salon bi-a, **sổ bi-a là sổ canonical** (lời Paul); đơn
  bán lẻ tồn tại song song trong sổ orders POS (phục vụ fiscal/vận hành máy) —
  KHÔNG được cộng hai báo cáo với nhau.

## Phase C — Verify

Unit: contract entries, payload builder, shift-link logic tách hàm thuần.
Toàn cục: typecheck ×2, build, vitest = baseline 16 fail không đổi. BE: jest
retail specs + build + deploy controller+dto (chờ lệnh deploy riêng như nếp).
Smoke trên gm khi Paul rảnh: mở ca POS → chip bi-a tự xanh; bán 1 đơn tab POS
→ hiện trong Lịch sử bi-a POS + web + Báo cáo; rút wifi bán tiếp → có mạng lại
tự xuất hiện; đóng ca POS → khối Bi-a gộp + web Đóng ca thấy ca đã đóng.

## Ngoài scope wave này

Mirror-void/refund; gộp thật 2 bảng ca server-side (đợi wave dọn drift
`cashier_shifts`); waitlist + form booking POS; Android.
