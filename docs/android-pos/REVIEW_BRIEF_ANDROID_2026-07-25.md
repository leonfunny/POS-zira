Bạn là reviewer độc lập, nhiệm vụ: đánh giá app **Android POS (Zira)** đã đủ tin cậy để đem ra quán thật chưa. Repo: `/var/www/pos-zira`, branch `main` (commit hiện tại `3c2f020`, package version 1.0.25). App Android = renderer Windows được mount lại qua lớp shim ở `src/renderer/android-pos/`, vỏ Capacitor ở `android-pos/`.

## Luật cứng (vi phạm là hỏng việc thật)

- **READ-ONLY**: không sửa/commit/push file nào. Chỉ đọc, grep, chạy test/build.
- **KHÔNG** `npm install`, **KHÔNG** `npx cap sync`, **KHÔNG** ghi vào `android-pos/app/build`.
- **KHÔNG** SSH vào máy POS đang bán hàng (POS1/POS2/POS3 Che Saigon) — quán đang chạy tiền thật.
- Backend DEV `http://127.0.0.1:3003` được phép gọi thoải mái (kể cả POST login bằng creds test).
- Backend PRODUCTION `https://api.enail.pro`: chỉ được `GET`/`OPTIONS` vô hại để soi header CORS/TLS. **KHÔNG** login, **KHÔNG** POST, **KHÔNG** ghi gì.
- Creds test dev: `anna@demo-bia.zira-ai.com` / `Staff123!` (email phải đủ domain). Field login là `emailOrPhone`.

## Ground truth — đọc trước, đừng đi khám phá lại

Cấu hình thật (tôi đã xác nhận):
- `android-pos/variables.gradle`: **minSdk 28**, compileSdk/targetSdk **36**.
- `capacitor.config.ts`: `appId: com.ziraai.posdiagnostics.dev`, `webDir: dist/android-web`, `allowMixedContent: false`, `webContentsDebuggingEnabled: false`, `includePlugins: []`, **KHÔNG set `androidScheme`**.
- `AndroidManifest.xml`: `allowBackup="false"`, `usesCleartextTraffic="false"`, không khai `uses-permission` nào trong manifest app.
- `src/renderer/android-pos/shim/real-transport.ts`: `DEFAULT_API_URL = 'https://api.enail.pro'`, override dev qua `localStorage['zira.dev.apiUrl']`.
- Backend eNail `backend/src/main.ts:240-258`: CORS callback — không có Origin thì cho qua; `NODE_ENV !== production` cho qua tất; production chỉ cho origin trong allowlist, còn lại `callback(null, false)` (không trả header CORS).

Những thứ **cố ý như vậy — KHÔNG báo lại thành lỗi**:
- Bi-a trên Android là **online-only P1**: không có offline queue, không cache SQLite cho billiard.
- Backend không có route `/billiard/fnb/*` → danh sách món trong Bi-a rỗng (Wave B-2 đã ghi nhận).
- `billiardPrintReceipt` trả `{success:true, receiptPrinted:false}` và hiện không có caller (backend tự dispatch in).
- Entitlements đã port thật ở `dff711a` (`shim/entitlements.ts` → `GET /admin/desktop/entitlements`) — đừng báo "vẫn synthetic".
- Full test suite có **14 file đỏ là baseline** (test của main-process Windows, phụ thuộc môi trường: `api-client-*`, `auth-*`, `order-repo-*`, `database-backup-service`, `ssh-tunnel-startup`, `lan-first-kitchen-ticket-receiver`, `e2e/smoke`, `billiard-light-theme`). Chỉ báo file đỏ **mới ngoài** danh sách này.

## Câu hỏi phải trả lời (đây là trọng tâm)

### 1. Máy Android cũ có chạy được không — đâu là sàn thật?
- minSdk 28 = Android 9. Xác nhận không có chỗ nào ép cao hơn (AGP/Gradle/androidx version, `compileOptions`, desugaring, Java 17 requirement).
- Bundle web build ra **cú pháp JS gì**? Đọc `vite.android.config.ts` (có set `build.target` không? nếu không thì Vite default là gì ở phiên bản này) rồi **kiểm chứng bằng cách grep chính file bundle đã build** trong `dist/android-web/assets/*.js` cho: `?.`, `??=`, `||=`, `#private`, `static{`, `at(`, `structuredClone`, `crypto.randomUUID`, `Object.hasOwn`, `Array.prototype.findLast`, top-level `await`. Với mỗi thứ tìm được, tra WebView/Chrome tối thiểu cần và kết luận: Android 9 (WebView cũ chưa update qua Play) có chạy nổi không.
- `sql.js` (SQLite WASM) chạy được trên WebView Android 9 không, RAM cần bao nhiêu trên tablet 2GB?
- Rủi ro **TLS/root CA** trên máy cũ: cert của `api.enail.pro` chain tới root nào? Máy Android cũ (đặc biệt <7.1 nhưng cả 9 nếu không update) có root đó chưa? Kiểm bằng `openssl s_client -connect api.enail.pro:443 -showcerts` rồi đối chiếu.
- Kết luận rõ: **danh sách phiên bản Android chạy được / không chạy được**, và cái gì chặn.

### 2. Kết nối backend có ổn không — NGHI VẤN LỚN NHẤT: CORS Origin của WebView
Capacitor không set `androidScheme` ⇒ WebView chạy ở origin `https://localhost` (xác nhận lại bằng doc/nguồn Capacitor version đang dùng trong `package.json`). Mọi `fetch` tới `https://api.enail.pro` sẽ mang `Origin: https://localhost`.
- Production backend từ chối origin lạ bằng `callback(null, false)` ⇒ **WebView sẽ chặn response**. Kiểm tra: `https://localhost` (và `capacitor://localhost`, `http://localhost`) có nằm trong `CORS_ORIGIN` production không? Xem `createProductionOriginMatcher` (`backend/src/common/utils/production-cors-origin.util.ts`) có nới cho localhost/scheme app không.
- Verify thực nghiệm: `curl -i -X OPTIONS https://api.enail.pro/api/v1/health -H 'Origin: https://localhost' -H 'Access-Control-Request-Method: GET'` và `curl -i https://api.enail.pro/api/v1/health -H 'Origin: https://localhost'` → có `access-control-allow-origin` không?
- Nếu KHÔNG có: đây là lỗi **P0 chặn toàn bộ app trên thiết bị thật** (app cài xong không login được). Nói rõ 2 hướng sửa: (a) thêm origin vào CORS backend (server change), (b) set `androidScheme`/`hostname` hoặc dùng native HTTP bridge phía client — và đánh giá hướng nào đúng hơn.
- Cũng kiểm layer CORS thứ hai nếu có (tenant CORS middleware) — ghi chú lịch sử: khi smoke qua proxy, backend dev từng trả **500** với Origin lạ, phải strip header `Origin` mới chạy. Tìm cho ra layer nào gây 500 đó.
- `usesCleartextTraffic="false"` ⇒ override `zira.dev.apiUrl` sang `http://...` sẽ bị chặn trên device. Xác nhận và nêu cách test trên máy thật (network-security-config cho debug build?).

### 3. Vòng đời auth / token
`shim/token-store.ts`, `port/api-client.ts`, `shim/real-transport.ts`: token lưu ở đâu (localStorage hay EncryptedSharedPreferences/SecureKV?), refresh-on-401 có single-flight không, rotate refresh token có race không, logout/salon-switch có xoá sạch (token, catalog IndexedDB, entitlements, pa_ key, socket)? Có đường nào token lọt vào log/console/crash report?

### 4. Đường tiền (nặng nhất)
- Bán lẻ: cart → order → tender → sync. Mất mạng giữa lúc thanh toán thì sao? Có `Idempotency-Key` không, retry có thể tạo **đơn đôi / thu tiền 2 lần** không? Đọc `shim/db/order-repo.ts`, outbox/retry trong `real-transport.ts`, `pos/payment-controller.ts`.
- Bi-a: `shim/billiard-transport.ts` — mutate lỗi có bao giờ bị "coi như thành công"? Cache có thể hiển thị số tiền cũ sau khi trả không?
- Fiscal/in: job in gửi qua agent Windows, nếu agent chết thì UI có kẹt hay báo sai "đã in"?

### 5. Đa tenant (đã từng có lỗi ở đây)
Đổi salon / đăng nhập tài khoản khác trên **cùng một máy**: có bất kỳ dữ liệu nào của salon trước còn sót (catalog SQLite, entitlements, billiard cache, shift, cart, pa_ key)? Cố tìm đường lách còn lại.

### 6. Mạng yếu / chập chờn
Timeout bao nhiêu, có backoff không, poll 10s của billiard có làm gì khi 401/500 liên tục, socket print-agent reconnect có bão không, app có tự hồi phục sau khi mất mạng 5 phút không.

### 7. Thiết bị & UX thật
Rotation, nút back cứng, bàn phím ảo che input, kích thước cảm ứng (tablet POS thường dùng ngón tay), màn 7"–10" và DPI thấp, splash/icon, app bị OS kill khi chạy nền lâu (shift đang mở thì sao), pin/nhiệt do poll + WASM.

### 8. Bảo mật client
WebView settings (JS bridge nào expose ra, `allowNavigation`), CSP của `index.html`, activity `exported="true"` có bị intent bên ngoài gọi được không, có secret/API key nào bị build vào bundle (`grep -iE "sk_|pa_[A-Za-z0-9]{10,}|password|secret" dist/android-web/assets/*.js`), `debuggable`/logging trong release, dữ liệu POS còn lại trên máy khi mất tablet (allowBackup=false rồi, nhưng localStorage token thì sao?).

### 9. Build & phát hành
`appId` đang là `com.ziraai.posdiagnostics.dev` (id "diagnostics dev") — vào Play/production được không, đổi id sau này có làm mất dữ liệu người dùng? Release build có ký chưa (`app-release-unsigned.apk`), versionCode cấp phát thế nào, R8/ProGuard có bật (có làm hỏng shim/reflection không), sideload thì **không có auto-update** — kế hoạch cập nhật máy quán là gì? Đọc thêm `docs/android-pos/production-readiness-register.json` và `scripts/verify-production-readiness.mjs` xem còn mục nào `blocked`.

### 10. Test & khoảng trống
Chạy: `npx vitest run tests/android-*.test.ts tests/android-*.test.tsx`, `npm run build`, `npm run build:android:web`, `npm run test:android:boundaries:source`, `:bundle`, `npm run gate:production-readiness`. Cái gì test **không** phủ mà lại là đường tiền / mất dữ liệu / chặn khởi động? Liệt kê test còn thiếu theo thứ tự ưu tiên.

## Cách làm việc

- Mỗi kết luận phải **dẫn file:dòng** hoặc **output lệnh thật**. Không suy đoán trần.
- Phân biệt rõ: `CONFIRMED` (đã đọc code/chạy lệnh chứng minh) vs `SUSPECTED` (nghi, cần thiết bị thật hoặc thông tin thiếu).
- Cái gì **chỉ kiểm được trên tablet thật** thì đưa vào mục riêng kèm **kịch bản test cụ thể** để người ở quán làm theo (bấm gì, chờ bao lâu, kỳ vọng thấy gì).

## Định dạng báo cáo

1. **VERDICT**: `GO` / `GO có điều kiện` / `NO-GO` cho việc đem 1 tablet ra quán chạy song song — kèm 1 câu lý do gắn với finding nặng nhất.
2. **Bảng finding**, nặng trước:
   `[P0|P1|P2|P3] (CONFIRMED|SUSPECTED) file:line — vấn đề — kịch bản hỏng cụ thể — hướng sửa — client-side hay cần backend`
   (P0 = app không chạy / mất tiền / lộ dữ liệu chéo salon; P1 = hỏng nghiệp vụ chính; P2 = UX/độ tin cậy; P3 = nhỏ)
3. **Câu trả lời trực tiếp cho 2 câu hỏi của chủ**: (a) Android phiên bản nào chạy được / không; (b) kết nối backend có ổn trên thiết bị thật không, nghẽn ở đâu.
4. **Danh sách chỉ kiểm được trên máy thật** + kịch bản test.
5. **Việc cần backend** (nếu có): viết theo mẫu Server Change Request trong `CLAUDE.md` của repo.
6. Cuối cùng: **3 việc nên làm trước tiên** nếu chỉ có 1 ngày.
