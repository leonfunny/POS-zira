# POS ↔ Web: đồng bộ Lịch sử & Báo cáo billiard — Plan (2026-07-31)

> Yêu cầu Paul: hiện quán chỉ làm bill trên web; sắp tới làm bill cả trên POS
> thì lịch sử 2 bên phải khớp nhau. Điều tra trước, plan này chờ duyệt rồi code.

## Kết quả điều tra (31/07, main `50c76f4`)

1. **Tab Lịch sử POS (`SessionHistory.tsx`, 533 dòng) là màn CHẾT từ đầu**:
   component gọi `window.electronAPI?.sessionHistory?.get?.()` nhưng
   `sessionHistory` CHỈ tồn tại trong `electron.d.ts` (type) — preload/main
   không có handler nào → optional chaining nuốt lỗi, UI vĩnh viễn
   "No sessions found". Tương tự **DailyReport.tsx cũng mồ côi**:
   `electronAPI.dailyReport.get` không có handler, dù
   `daily-report-repo.ts` (main, query SQLite local) đã viết sẵn.
2. Local SQLite có đủ bảng `billiard_sessions` + `billiard_session_items`,
   nhưng chỉ chứa phiên ACTIVE + pending-POS + tombstone vừa settle — phiên
   làm trên WEB (end + thanh toán web) **không bao giờ về máy POS**. Có tính
   từ local cũng KHÔNG THỂ khớp web (thiếu data + thiếu floor 29/07, VAT,
   retail...).
3. Server đã có sẵn mọi thứ cần:
   - `GET /billiard/sessions/history` (from/to/resourceId/status/sessionType/
     paymentStatus/page/limit → `{data, total, totals}`, items kèm theo) —
     đúng nguồn tab Lịch sử web đang dùng.
   - `GET /billiard/analytics?from&to` — đúng nguồn tab Báo cáo web (đã có
     floor 29/07), và shape khớp UI DailyReport POS gần 1:1:
     `revenueByTable` → TableUtilization, `topFnbItems` → TopFnbItem,
     `peakHours` → HourlyBreakdown, summary → DailyReportSummary.
4. UI POS dùng **snake_case** (started_at, total_charge, items[], payments[])
   vì thiết kế cho SQLite; server trả camelCase → cần mapper thuần.

## Nguyên tắc thiết kế

**Server là nguồn chân lý duy nhất cho lịch sử + báo cáo.** POS online đọc
thẳng 2 endpoint trên (khớp web 100% theo định nghĩa — cùng nguồn, cùng floor
29/07). Offline: lịch sử đọc từ **bảng cache riêng** (điền mỗi lần xem online);
báo cáo offline hiển thị "cần mạng" (phase này). KHÔNG đổ history vào bảng
`billiard_sessions` local để không đụng logic floor/pending/tombstone đang chạy.

## Task 1 — Contract entries (allowlist)

`src/shared/billiard-contract.ts` (nhớ bài học thứ tự — 2 route literal này
không đụng regex `sessions/[^/]+` vì có query/`history` là 2-segment GET):

```ts
{ method: 'GET', path: /^\/billiard\/sessions\/history\?[A-Za-z0-9=&%._:-]*$/, operation: 'online_api', policy: 'online-only' },
{ method: 'GET', path: /^\/billiard\/analytics\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/, operation: 'online_api', policy: 'online-only' },
```

+ case test allow/deny trong `tests/billiard-contract.test.ts` (deny `..`,
deny POST, deny query có `//`).

## Task 2 — Mapper server→UI (pure, test được)

`src/shared/billiard-history-contract.ts` (mới, dùng chung electron+android):

- `mapServerHistorySession(row): HistorySession` — camel→snake, `tableName`
  từ `row.resource?.name`, items → `{id,name,quantity,unit_price,total_price}`,
  payments dựng từ `splitPaymentDetails[]` (method/amount/paidAt) fallback
  `paymentMethod+paidAmount+endedAt`.
- `mapServerAnalyticsToDailyReport(a): ReportData` — summary + revenueByTable→
  tableUtilization + topFnbItems + peakHours→hourlyBreakdown (revenue=0 nếu
  server không trả revenue/giờ — UI đang vẽ theo max, chấp nhận sessions-count).
- Unit tests với fixture JSON chép từ response dev thật.

## Task 3 — Cache lịch sử offline (SQLite)

- Migration local mới: bảng `billiard_history_cache`
  `(id TEXT PK, ended_at TEXT, started_at TEXT, status TEXT, payment_status
  TEXT, resource_id TEXT, search_blob TEXT, payload TEXT/*JSON HistorySession*/,
  cached_at TEXT)` + index `(ended_at)`, `(resource_id, ended_at)`.
- `billiard-history-cache-repo.ts`: `upsertMany(rows)`, `query({dateFrom,
  dateTo, status, resourceId, search, limit, offset})` (search LIKE trên
  search_blob = tên bàn+khách+items), `pruneOlderThan(days=30)` gọi lúc boot.

## Task 4 — Sync + IPC + preload

`billiard-sync.ts` thêm `getSessionHistory(params)`:
online → `apiClient.request GET /billiard/sessions/history?...` (limit 20,
map qua Task 2, upsertMany vào cache, trả `{sessions, total}`);
offline/network-error → query cache, `total` = count cache + cờ `fromCache`.
`getDailyReport(from,to)`: online → GET analytics + map; offline → lỗi có mã
`OFFLINE` (UI hiện cần mạng).

`sync.module.ts` handlers `billiard:session-history:get`,
`billiard:session-history:tables` (từ `billiardResourceRepo` local sẵn có),
`billiard:daily-report:get`; `preload.ts` expose đúng shape `electron.d.ts`
đang khai (đã có sẵn — chỉ nối dây, UI gần như không đổi).

## Task 5 — UI chỉnh tối thiểu

- SessionHistory: banner nhỏ "Đang xem bản lưu offline" khi `fromCache`;
  ô search hoạt động trên cache/trang hiện tại (server không có q param —
  ghi chú hạn chế).
- DailyReport: trạng thái offline "cần mạng"; thêm dòng "Bán lẻ" từ
  `retailRevenue` server (khớp web).
- i18n ~6 key × 7 ngôn ngữ.

## Task 6 — Verify

Typecheck ×2 + build + vitest (baseline 16 fail/14 file đã đo — không thêm);
contract-check.mjs; smoke dev: (1) phiên làm TRÊN WEB xuất hiện trong Lịch sử
POS đúng số tiền/items; (2) quick-sale POS xuất hiện tab Lịch sử web loại
"Bán lẻ" và Báo cáo 2 bên cùng con số; (3) rút mạng → Lịch sử POS vẫn hiện
bản cache + banner; push main → gm pull.

## Ngoài scope (ghi để sau)

Sửa/xóa/hóa đơn lịch sử từ POS (web-only như thiết kế); DailyReport offline
từ daily-report-repo local; server-side search cho history; đồng bộ realtime
đẩy (poll khi mở tab là đủ cho quầy).
