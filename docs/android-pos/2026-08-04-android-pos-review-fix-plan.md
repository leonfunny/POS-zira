# Plan sửa POS Android sau review 04/08/2026

Nguồn: review code phần POS bán lẻ/grocery trên tablet Android (04/08), sau khi
luồng settle bi-a đã chạy thông end-to-end trên máy thật.

Mỗi mục dưới đây đều đã được xác minh bằng cách đọc code **và** dò runtime trên
emulator qua CDP, không phải suy đoán.

---

## 0. Nguyên tắc chia việc

Giao cho **codex** những việc thoả CẢ BA điều kiện:

1. Windows đã có **bản tham chiếu đúng** trong repo — codex chỉ soi chiếu, không
   phải tự nghĩ ra ngữ nghĩa tiền bạc.
2. Sai/đúng **kiểm được bằng một test tự động**, không cần cắm máy thật.
3. Phạm vi gọn trong 1–2 file, không đụng journal bi-a, không đụng schema.

Giữ lại cho tôi (Claude) những việc cần **quyết định ngữ nghĩa money-path**, cần
gọi backend mới, hoặc cần chạy trên emulator để nghiệm thu.

> Lý do chia thế này: 4 trong 6 lỗi là **bản port rụng mất một điều kiện** so với
> Windows. Đó là việc soi chiếu — codex làm nhanh và an toàn. Còn cái thiếu hẳn
> một tầng kiểm tra (preflight) thì không có gì để soi, phải thiết kế.

---

## 1. Bốn packet giao codex

Chạy tuần tự C1 → C2 → C3 → C4. Mỗi packet là **một commit riêng**.

### Rào chắn chung cho MỌI packet (bắt buộc dán vào prompt)

- Repo: `/var/www/pos-zira`, branch `feat/pos-billiard-parity-20260731`.
- **KHÔNG** sửa gì trong `src/main/**` (đó là Windows, chỉ đọc để tham chiếu).
- **KHÔNG** đụng `shim/billiard-handoff.ts`, `shim/db/billiard-handoff-repo.ts`,
  `shim/db/schema.ts` (journal tiền + schema — thuộc packet của tôi).
- **KHÔNG** sửa/xoá/skip test đang có để cho pass. Test đỏ mới = dừng và báo.
- **KHÔNG** `git add -A` (hook chặn). Stage từng đường dẫn một.
- Sau mỗi packet phải chạy và dán kết quả:
  ```bash
  npm run build
  npm run test:android:boundaries:source
  npx vitest run tests/<file test của packet>
  ```
- Baseline full-suite là **14 file đỏ** (`api-client-*`, `auth-*`, `order-repo-*`,
  `database-backup-service`, `ssh-tunnel-startup`,
  `lan-first-kitchen-ticket-receiver`, `e2e/smoke`, `billiard-light-theme`).
  Chỉ báo file đỏ **ngoài** danh sách đó.

---

### C1 — Kho bi-a: trả lại các rào mà bản port đánh rơi

**Mức độ: cao. Làm trước tiên.**

Ba chỗ, cùng một họ lỗi: dấu "hàng bi-a đã trừ kho lúc thêm vào phiên" bị rụng
khỏi mọi đường tồn kho của Android.

| # | File Android | Windows tham chiếu | Thiếu gì |
|---|---|---|---|
| a | `src/renderer/android-pos/shim/real-transport.ts:1178` | `src/main/modules/pos.module.ts:5204` | vòng lặp trừ kho không bọc `shouldDecrementStockAtCheckout(item, isBilliard)` → **settle bi-a trừ kho F&B lần 2** |
| b | `src/renderer/android-pos/shim/db/order-repo.ts:186` | `src/main/database/repos/order-repo.ts:536` | hoàn kho thiếu `item.inventory_policy !== 'ALREADY_CONSUMED'` → **cộng khống kho** |
| c | `src/renderer/android-pos/shim/db/order-repo.ts:175` | `src/main/database/repos/order-repo.ts:521` | thiếu chặn `if (order.billiard_origin_json) → từ chối xoá` |

Dùng đúng helper chung `shouldDecrementStockAtCheckout` từ
`src/shared/pos/order-line-contract.ts` — **không viết lại điều kiện bằng tay**
(chính việc chép tay đã đẻ ra cả 3 lỗi này).

Cờ `isBilliardCheckout` lấy từ `Boolean(normalizedOrder.billiard_origin_json)`,
đã có sẵn trong scope ở `createOrder`.

Test mới `tests/android-stock-policy.test.ts` phải phủ:
- đơn thường 2 dòng → kho trừ đúng 2 dòng;
- đơn có `billiard_origin_json` → kho **không đổi một ly**;
- `deleteLocalUnsynced` trên đơn thường → hoàn đúng số;
- `deleteLocalUnsynced` trên dòng `inventory_policy='ALREADY_CONSUMED'` → **không** hoàn;
- `deleteLocalUnsynced` trên đơn bi-a → **từ chối**, không xoá, kho không đổi;
- `allowOversell=false` vẫn kẹp sàn 0; `true` thì cho âm (giữ nguyên hành vi cũ).

```bash
codex exec -C /var/www/pos-zira --sandbox workspace-write "$(cat docs/android-pos/packets/C1.md)"
```

---

### C2 — Stub nào không làm được thì phải TỪ CHỐI, không được báo thành công

**Mức độ: cao (mục 1 của review).**

`src/renderer/android-pos/shim/stubs.ts`:

- **`:338` `mutate`** — hiện `async () => ({ success: true, localOnly: true })`
  vô điều kiện. Dò trên máy: gọi với **id đơn không tồn tại** vẫn trả success.
  Đây là đường **VOID/sửa đơn** trong Lịch sử (`OrderHistoryModal.tsx:1495`), và
  `ensureMirrored` (`:2063`) trả `true` ngay cho đơn local nên tới được thật.
  → Đổi thành từ chối rõ ràng, cùng khuôn với `cancel`/`deleteLocal`/`refund`
  ngay trong file đó (chúng đã "refuse rather than lie" kèm chú thích).
  Thông điệp phải **nói cách làm đúng**: đơn local chưa sync thì dùng "Xoá đơn
  local" (đường này chạy thật và có restock); đơn đã sync thì làm ở quầy Windows.
- **`:288` `reconcileFiscalAttempt`** — cùng bệnh, Windows từ chối khi không có
  attempt nào chờ (`pos.module.ts:6108`). Hiện chưa với tới được vì
  `getReconcilableFiscalAttempt` luôn trả `attempt: null`, nhưng để nguyên là
  mìn chưa nổ → cho từ chối luôn.
- **`:637`/`:643` `hold.create` / `hold.remove`** — trả `{success:true}` rỗng.
  `create` không có ai gọi (chết), `remove` làm thao tác bỏ giỏ treo trông như
  đã chạy → cho cả hai từ chối `desktop-only`, đồng bộ với `createCurrent`/`recall`.

⚠️ **Không được đổi** những stub đang từ chối đúng, và **không** tự đi hiện thực
void thật — đó là quyết định riêng, không nằm trong packet này.

Test `tests/android-refuse-not-lie.test.ts`: với mỗi method trên, assert
`success === false` và `error` là chuỗi khác rỗng; thêm một test chống-rêu liệt kê
các method "được phép trả success không điều kiện" để lần sau ai thêm stub dối
thì đỏ.

---

### C3 — Timer rút hàng đợi đơn ở nền

**Mức độ: trung bình (mục 3 của review).**

Windows: `src/main/sync/order-sync.ts:361-375` — `startPeriodicSync()`, 30 giây,
có jitter 0–5s, `stop()` dọn cả `setTimeout` jitter lẫn `setInterval`.

Android hiện **không có timer nào** cho đơn (đã grep). Chỉ 2 nơi kích hoạt:
`PaymentModal.tsx:739` (bắn một phát sau khi trả tiền) và
`OrderHistoryModal.tsx:1337`. Không có hook `online`/`visibilitychange`/resume.

Hậu quả thật, đã gặp 04/08: đơn bi-a sync lỗi rồi nằm im tới khi gọi tay. Cộng
với `navigator.storage.persisted === false` trên thiết bị → Android có quyền xoá
IndexedDB kèm đơn chưa sync.

Yêu cầu:
- Mirror khuôn Windows (30s + jitter), khởi động sau khi đăng nhập xong, dừng
  khi logout/teardown — bám vào chỗ `billiardInvalidateAuth()` đang được gọi ở
  cả 2 đường teardown.
- **Chống chạy chồng**: nếu một lượt sync đang chạy thì bỏ lượt này, không xếp hàng.
- Không đổi chữ ký `sync.orders()` và không bỏ trigger sau thanh toán.

Test `tests/android-order-drain.test.ts` (fake timers): tick 30s → drain chạy;
drain đang chạy mà tới tick → không gọi chồng; `stop()` → hết tick; `stop()` giữa
lúc jitter → không có interval nào được dựng về sau.

---

### C4 — Nút Hold: có thì phải chạy, không thì đừng hiện

**Mức độ: thấp (mục 5 của review). Thuần UI.**

`pos.hold.createCurrent`/`recall` trả `desktop-only` (đã dò runtime). Nút Hold ở
`src/renderer/components/pos/Cart.tsx:945` **không có prop `disabled`** nên luôn
bấm được. Lỗi *có* được báo qua `showToolbarError`
(`RetailTemplate.tsx:1002`) nhưng rơi vào dải toolbar cuộn ngang bị cắt và tự tắt
— phải đọc DOM mới thấy.

Cách rẻ và trung thực nhất: `Cart.tsx:945` đã là `{onHold && (...)}`, nên chỉ cần
**không truyền `onHold`** khi nền tảng không giữ giỏ được. Thêm một cờ năng lực
đọc từ shim (ví dụ `pos.hold.supported === false` trên Android, `true` trên
Windows) rồi `RetailTemplate` truyền `onHold={holdSupported ? handleHoldCart : undefined}`.
Recall cũng ẩn theo.

⚠️ **Không** hiện thực Hold thật trên Android trong packet này (Android đã có
`shim/db/hold-repo.ts` nhưng nó đang phục vụ chỗ giỏ-bị-ngắt của bi-a; dùng lại
là một wave riêng).

Test: thêm mục vào `tests/android-shell-props-parity.test.tsx` — Android không
được nhận `onHold`; và một test rằng Windows **vẫn** nhận.

---

## 2. Phần tôi giữ lại

### M1 — Preflight thanh toán (mục 4 của review)

Windows `pos.module.ts:681-707` trước mỗi lần thu tiền: ca khớp session → **kiểm
ca phía server** → auth không đổi → ca không đổi → token UUID ngẫu nhiên buộc vào
`(orderId, shiftId, authContext)` + TTL, commit thì `assertOrdinaryPosPaymentPreflight`
kiểm lại.

Android `stubs.ts:241` trả `{success:true, token:'android:'+orderId}` — không
kiểm gì, token đoán được, không ai verify.

Đỡ được phần lớn nhờ `real-transport.ts:1126-1147` có rào ca **cục bộ** thật.
Còn hở: chủ đóng ca từ dashboard web → tablet vẫn bán vào ca server coi đã đóng;
đổi người dùng giữa lúc mở màn thanh toán không bị bắt.

Không giao codex: cần thêm một lời gọi backend kiểm ca và quyết định fail-open
hay fail-closed khi tablet mất mạng (fail-closed mà chọn ẩu thì quầy đứng hình
lúc rớt 4G). Đây là quyết định vận hành, tôi sẽ đề xuất kèm số liệu rồi hỏi anh.

### M2 — Nghiệm thu trên máy thật + đóng gói

Sau khi C1–C4 xong: build APK, cài lên emulator KVM (`komputerai-wsl`), chạy lại
kịch bản bán lẻ (quét mã → tiền mặt → thối) và settle bi-a, đối chiếu tồn kho
trước/sau trên server, rồi commit + push. Harness CDP đã dựng sẵn.

---

## 3. Thứ tự và phụ thuộc

```
C1 (kho bi-a)  ─┐
C2 (stub dối)  ─┼─→ M2 nghiệm thu máy thật ─→ push
C3 (timer)     ─┤
C4 (nút Hold)  ─┘
M1 (preflight) ── cần anh quyết fail-open/closed trước khi code
```

C1–C4 độc lập nhau, chạy được song song nếu muốn, nhưng **C1 trước** vì nó là
lỗi đang tính sai tiền hàng mỗi lần tất toán bàn bi-a.

---

## 4. Rủi ro

| Rủi ro | Mức | Chặn bằng |
|---|---|---|
| Codex "sửa luôn cho gọn" mấy chỗ ngoài phạm vi | TB | Rào chắn §1 + review diff từng packet trước khi commit |
| Sửa C1 mà quên chiều hoàn kho → lệch ngược lại | Cao | Test C1 bắt buộc phủ CẢ hai chiều + ca bi-a |
| C2 làm mất đường huỷ đơn của thu ngân | TB | Đã xác minh "Xoá đơn local" (`canDeleteLocal`, `OrderHistoryModal.tsx:2182`) chạy thật; thông điệp từ chối phải trỏ sang đó |
| C3 timer chạy chồng lúc mạng chập chờn | TB | Test chống-chồng bằng fake timers |
| Đổi `stubs.ts` làm vỡ `tests/android-shim.test.ts` (nó pin nguyên văn literal) | Cao | Packet C2 phải cập nhật test đó cùng commit — file tự ghi "changing one here is a contract change" |

---

## 5. Ngoài phạm vi plan này (chỉ ghi nhận)

- `vat_rate: parseFloat(...) || 23` (`real-transport.ts:240`) — hàng VAT **0%
  thật sẽ thành 23%**. Chú thích ghi là chép theo `api-client.ts:2380`, tức lỗi
  chung cả 2 nền, không phải Android đẻ ra. Cần anh xác nhận catalog có mặt hàng
  0% nào không rồi mới sửa (sửa một nền thôi là lệch).
- Cân điện tử / in tem / máy in fiscal trên tablet: thiếu phần cứng, không phải lỗi code.
- Bố cục retail cao hơn viewport ở khổ tablet.
- Hold/Recall chạy thật trên Android (tái dùng `hold-repo.ts`) — wave riêng.
