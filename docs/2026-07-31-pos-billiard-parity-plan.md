# POS Billiard Parity Wave — Plan (2026-07-31)

> Mang 3 tính năng backend/web đã có xuống POS desktop: **bán lẻ F&B không cần bàn
> (quick-sale)**, **gộp/tách hóa đơn**, **trạng thái + mở ca**. Waitlist và tạo
> booking để wave sau.
>
> Workflow: code + test trên Netcup `/var/www/pos-zira` (branch
> `feat/pos-billiard-parity-20260731`), push origin, **gm (D:\zira-pos-main) pull
> để build/chạy thử**. KHÔNG đụng máy POS quán — Paul tự pull/build sau giờ làm.

## Kiến trúc đã xác minh (điều tra 31/07, main `010e68dc`)

- Renderer gọi `window.electronAPI.billiard.mutate(op, method, path, body)` —
  generic, nhưng bị chặn bởi **allowlist** `src/shared/billiard-contract.ts`
  (method + path regex + operation + policy `online-only|queue-safe`). Route mới
  = thêm entry contract, KHÔNG cần sửa preload.
- Reads mới cũng đi `mutate('online_api', 'GET', path)` (tiền lệ: bookings,
  availability). `apiCall` generic bị khóa cứng print-agent/salons — không dùng.
- `billiard-sync.ts executeMutation`: policy online-only → lỗi mạng là báo user,
  không queue (đúng cho cả 3 feature này). Side-effect sau op theo tên op —
  quick-sale cần 1 nhánh mới để upsert session vào SQLite (phục vụ in bill).
- In bill: `billiard:print:receipt` đọc session từ `billiardSessionRepo` local →
  quick-sale phải upsert trước khi in.
- Quick-sale BE trả `{ session, replayed, stockEvents, changeAmount }`; có
  **fingerprint dedupe server-side** (idempotency-key header optional — apiClient
  không gửi custom header được, dựa fingerprint là đủ).
- i18n POS: `src/renderer/i18n/translations.ts`, 7 ngôn ngữ
  `en|vi|tr|zh|uk|ru|pl`, pattern `t('billiard.x') || 'Fallback'`.
- Catalog món: `useFnbProducts/useFnbCategories` (cache offline sẵn);
  `AddItemToTabModal.tsx` (938 dòng) chứa product-picker + cart tái dùng được.
- UnsettledPanel pattern: panel nhận data qua props từ cha (BilliardFloorPlan).
- `scripts/android/billiard-contract-check.mjs` phải chạy lại sau khi sửa contract
  (android shim dùng chung allowlist).

## Task 1 — Contract entries (nền cho mọi thứ)

`src/shared/billiard-contract.ts`, thêm vào `BILLIARD_MUTATION_ROUTES` (đúng
format các entry hiện có, tất cả `policy: 'online-only'`):

```ts
{ method: 'POST',  path: /^\/billiard\/retail\/quick-sale$/,            operation: 'retail_quick_sale', policy: 'online-only' },
{ method: 'GET',   path: /^\/billiard\/retail\/today$/,                 operation: 'online_api',        policy: 'online-only' },
{ method: 'PATCH', path: /^\/billiard\/sessions\/merge$/,               operation: 'merge_sessions',    policy: 'online-only' },
{ method: 'POST',  path: /^\/billiard\/sessions\/[^/?#]+\/split$/,      operation: 'split_bill',        policy: 'online-only' },
{ method: 'GET',   path: /^\/billiard\/shifts\/current$/,               operation: 'online_api',        policy: 'online-only' },
{ method: 'POST',  path: /^\/billiard\/shifts\/open$/,                  operation: 'open_shift',        policy: 'online-only' },
```

Verify: `node scripts/android/billiard-contract-check.mjs` pass; unit test contract
(nếu có suite sẵn — tìm `billiard-contract` trong test trước, thêm case allow/deny
cho 6 entry).

## Task 2 — billiard-sync side-effects cho op mới

`src/main/sync/billiard-sync.ts` trong `executeMutation`, sau nhánh
`void_sessions_batch`:

```ts
} else if (op === 'retail_quick_sale' && result?.session?.id) {
  // Fnb-only session is born settled — cache it so the local receipt
  // printer and history see it immediately.
  billiardSessionRepo.upsertOne(result.session);
  this.notifyRenderer('payment-updated');
} else if (op === 'merge_sessions') {
  // Source sessions vanish into the target — pull a fresh dashboard so
  // stale ACTIVE rows drop out of the floor immediately.
  await this.refreshDashboard().catch(() => {});
```

(`merge_sessions`/`split_bill`/`open_shift` không thuộc `journalIsAuthoritative`
→ generic refresh đã chạy; nhánh merge chỉ để refresh ĐỒNG BỘ trước khi trả về,
tránh bàn nguồn còn treo trên sơ đồ.)

## Task 3 — Hooks renderer

`src/renderer/hooks/useBilliardData.ts` (theo đúng pattern
`useMutation + window.electronAPI.billiard.mutate`):

```ts
export function useQuickSale(refetch?: () => Promise<void>) {
  // POST /billiard/retail/quick-sale — body RetailQuickSaleDto
  // { items: [{ variantId?, name, quantity, unitPrice }], paymentMethod, cashReceived?, customerName?, customerPhone? }
}
export function useRetailToday() { /* mutate('online_api','GET','/billiard/retail/today') qua useBilliardQuery */ }
export function useMergeSessions(refetch?) { /* PATCH /billiard/sessions/merge { sessionIds } */ }
export function useSplitBill() { /* POST /billiard/sessions/${id}/split { splitType:'BY_AMOUNT', amounts } */ }
export function useCurrentShift() { /* GET /billiard/shifts/current, poll 60s, pollPaused khi tab ẩn */ }
export function useOpenShift(refetch?) { /* POST /billiard/shifts/open { openingFloat? } */ }
```

Chú ý `useCurrentShift` dùng cùng cơ chế poll/stale-window như `useFloorOverview`
(line ~110-200 useBilliardData) + tôn trọng `pollPaused` (bài học flicker 25/07:
tab hidden phải pause poll).

## Task 4 — Màn Bán lẻ (RetailQuickSaleModal)

Tạo `src/renderer/components/billiard/RetailQuickSaleModal.tsx`:

- Trái: product picker — **tách phần picker của AddItemToTabModal thành component
  dùng chung** (`FnbProductPicker` nội bộ file đó → export) thay vì copy 900 dòng;
  giữ nguyên facility tabs (`fnb-facilities.ts`) + tên món theo ngôn ngữ cashier
  (displayName logic có sẵn trong AddItemToTabModal).
- Phải: giỏ (sửa số lượng/xóa), tên/SĐT khách (optional), phương thức
  Cash/Card/BLIK/Transfer như PaymentDialog, ô "Khách đưa" khi Cash → hiện
  `changeAmount` trả về từ server (KHÔNG tự tính client — server là nguồn đúng).
- Sau success: hiện màn "Đã thanh toán — tiền thối X" + nút **In bill**
  (`billiard.printReceipt(result.session.id, { method, amount })` — session đã
  được Task 2 upsert) + nút mở két + "Bán tiếp" (reset giỏ).
- Offline (`useSyncStatus.online === false`): nút bán disable + banner
  "Cần mạng để bán lẻ" (đồng bộ hành vi UnsettledPanel).
- Entry point: nút "Bán lẻ" (icon ShoppingCart) trên header BilliardFloorPlan
  (cạnh cụm nút hiện có trong `MenuHeader.tsx`/`MenuActionItems.tsx` — chọn chỗ
  theo layout thật lúc code) + hiện tổng bán lẻ hôm nay từ `useRetailToday` trong
  DailyReport (thêm dòng "Bán lẻ: X").

## Task 5 — Gộp / Tách hóa đơn

- `MergeBillDialog.tsx` (POS): port logic từ web
  (`enail/frontend/src/app/app/billiard/components/MergeBillDialog.tsx`) — list
  phiên ACTIVE/PAUSED khác từ `useFloorOverview`, multi-select, gọi
  `useMergeSessions`. Style theo dialog POS hiện có (TransferTableDialog làm mẫu).
- `SplitBillDialog.tsx` (POS): chia đều 2–10 người / tùy chỉnh số tiền, gọi
  `useSplitBill`; hiện kết quả từng phần. Port từ web SplitBillDialog.
- Gắn 2 nút vào `SessionDetailModal.tsx` POS (393 dòng — cạnh nút Transfer, theo
  đúng hàng nút hiện có) + nút Split trong `PaymentDialog.tsx` (trước khi chọn
  phương thức — cashier hay cần tách ngay lúc tính tiền).

## Task 6 — Trạng thái ca + mở ca

- Chip ca ở header floor plan (cạnh sync status): 🟢 "Ca đang mở · 14:02 · float
  200 PLN" / 🔴 "Chưa mở ca" (data `useCurrentShift`).
- Chip đỏ bấm được → dialog nhỏ mở ca (ô tiền đầu ca optional) →
  `useOpenShift`. KHÔNG làm đóng ca trên POS (đóng ca = đối chiếu tiền, giữ ở
  web như thiết kế).
- Nếu backend trả ca chưa mở, KHÔNG chặn start session (server tự stamp shift
  khi end — đã verify BE `resolveOpenShiftId`); chip chỉ là nhắc nhở. Đơn giản,
  không port nguyên ShiftGate web.

## Task 7 — i18n 7 ngôn ngữ

`src/renderer/i18n/translations.ts`: ~25 key mới nhóm `billiard.retail*`,
`billiard.merge*`, `billiard.split*`, `billiard.shift*` đủ en/vi/tr/zh/uk/ru/pl
(pl + vi dịch kỹ). Dùng đúng pattern `t('key') || 'Fallback'` của POS.

## Task 8 — Verify

1. `npm run typecheck` (hoặc `tsc --noEmit` theo script repo) + `npm run build`
   trên Netcup — pass (baseline chú ý: repo từng có test fail nền, chỉ yêu cầu
   không tăng lỗi mới).
2. `node scripts/android/billiard-contract-check.mjs` pass.
3. Unit test mới: contract entries + reducer/logic thuần nếu tách được (đặt cạnh
   test hiện có của repo).
4. Smoke với backend DEV Netcup (app trỏ dev): quick-sale tạo phiên fnb_only →
   xuất hiện trong web History (Bán lẻ) + Báo cáo; merge 2 bàn; split; chip ca.
5. Push branch → **gm pull, `npm install && npm run dev`** — Paul xem trực tiếp
   trên gm, duyệt rồi mới merge main. Không build installer trong wave này.

## Ngoài scope (wave sau)

Waitlist POS · tạo/sửa booking từ ReservationPanel (contract đã allow POST
bookings, chỉ thiếu UI) · đóng ca trên POS · Android port các feature này
(shim/entitlements còn treo) · idempotency-key header cho apiClient.
