# Review frontend module split — Windows và Android POS

Ngày review: 2026-08-09
Nhánh được đọc: `codex/android-settings-20260809`
Phạm vi: renderer, Android shim, các parity guard và tài liệu đo trên SUNMI; không dùng `main` làm baseline vì `main` không chứa Android.

## 1. Verdict trong ba câu

Android là counterpart của cửa sổ Windows `pos`, không phải cửa sổ `main`: Windows `pos` mount `POSApp -> POSLayout`, còn Android mount `AndroidBootApp -> POSLayout` trực tiếp (`src/renderer/windows/pos/main.tsx:3-9`, `src/renderer/windows/pos/POSApp.tsx:1-6`, `src/renderer/android-pos/AndroidBootApp.tsx:17-23,375-392`).
Quyết định dùng chung cashier renderer vẫn đúng, nhưng câu “không giống Windows” hiện là hỗn hợp của so sai cửa sổ, khác config/viewport có chủ ý, và lỗi thật gồm 390 điểm CSS không tương thích Chromium 83, font khác, ba ngôn ngữ Android không hợp lệ, hai panel Electron-only và một số affordance báo thành công giả (`docs/superpowers/plans/2026-08-07-pos-redesign-dotykacka-brief.md:9-39,102-108`, `src/renderer/android-pos/SettingsScreen.tsx:4-15`, `src/renderer/components/pos/AddProductWebviewPanel.tsx:17-27,215-228`, `src/renderer/components/pos/DebtWebviewPanel.tsx:20-35`).
Không nên port nguyên 17 module back-office; nên giữ một cashier tree, tách coordinator `POSLayout` theo feature/capability, rồi đóng các outcome tại till theo thứ tự loyalty, product quick-edit, lịch/check-in hẹp và order operations hẹp (`docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md:14-20,48-64`, `src/renderer/components/pos/POSLayout.tsx:29-44,1893-1944`).

## 2. Bản đồ năm cửa sổ Windows và một entry Android

`vite.config.ts` khai báo đúng năm input độc lập tại `vite.config.ts:18-40`; mỗi HTML có một React root riêng:

| Entry | React root thực tế | Vai trò | Bằng chứng |
|---|---|---|---|
| `main` | `App` | Vỏ back-office, auth/sidebar và module tabs | `src/renderer/main.tsx:46-50`; imports tại `src/renderer/App.tsx:4-24`; tab bodies tại `src/renderer/App.tsx:614-704` |
| `pos` | `POSApp -> POSLayout` | Cửa sổ thu ngân standalone | `src/renderer/windows/pos/main.tsx:3-9`; `src/renderer/windows/pos/POSApp.tsx:1-6` |
| `customer` | `CustomerApp` | Màn hình hướng về khách | `src/renderer/windows/customer/main.tsx:3-12` |
| `selfCheckout` | `SelfCheckoutApp` | Kiosk tự thanh toán | `src/renderer/windows/self-checkout/main.tsx:3-12` |
| `kitchenSelfOrder` | `KitchenSelfOrderApp` | Kiosk tự đặt món tại bếp | `src/renderer/windows/kitchen-self-order/main.tsx:3-12` |

Android không mount `POSApp`. `vite.android.config.ts:22-31` build `android-pos/index.html`; `src/renderer/android-pos/main.ts:75-79` mount `AndroidBootApp`; component này import `POSLayout` trực tiếp tại `src/renderer/android-pos/AndroidBootApp.tsx:17-23`.

Số dòng đã được đo lại sau khi sửa các comment/doc sai trong phạm vi review:

```text
$ wc -l src/renderer/App.tsx \
  src/renderer/windows/pos/POSApp.tsx \
  src/renderer/windows/customer/CustomerApp.tsx \
  src/renderer/windows/self-checkout/SelfCheckoutApp.tsx \
  src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx \
  src/renderer/android-pos/AndroidBootApp.tsx \
  src/renderer/components/pos/POSLayout.tsx \
  src/renderer/components/Settings.tsx \
  src/renderer/components/products/ProductModule.tsx \
  src/renderer/components/warehouse/WarehouseModule.tsx
   723 App.tsx
     6 POSApp.tsx
   401 CustomerApp.tsx
   935 SelfCheckoutApp.tsx
  1976 KitchenSelfOrderApp.tsx
   412 AndroidBootApp.tsx
  2082 POSLayout.tsx
  6298 Settings.tsx
  1048 ProductModule.tsx
   994 WarehouseModule.tsx
```

Vì vậy `AndroidBootApp = 379` và `POSLayout = 2088` trong packet đã stale. `AndroidBootApp` ban đầu đo 418 dòng trước khi review rút gọn sáu dòng comment sai; logic không đổi.

### Những premise khác trong packet cần sửa

1. “Mọi file dưới `components/**` ship cả hai nền” không đúng với bundler: Vite đi theo import graph. Tuy nhiên `POSLayout` statically import cả bốn template và các modal/panel tại `src/renderer/components/pos/POSLayout.tsx:29-44`, nên toàn bộ nhánh reachable đó vẫn vào bundle Android.

```text
$ find src/renderer/components -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l
180
$ npm run test:android:boundaries:source
PASS cross-platform boundaries: 149 source file(s) scanned from 1 entry point(s)
```

2. Số surface trong packet vẫn đúng, nhưng phép trừ phải tính tám path Android-only. Runtime capture dùng đúng kỹ thuật của `tests/android-preload-surface-parity.test.ts:13-17,150-169`:

```text
[Preload] Initializing...
[Preload] API exposed successfully
{
  "windows": 412,
  "android": 208,
  "windowsMissingOnAndroid": 212,
  "androidOnly": 8
}
```

Tám path Android-only là `pos.scale.getNetworkInfo`, `pos.scale.readWeight`, `pos.snapshot.clear/load/save`, `pos.sync.eventStatus`, `pos.sync.flushEvents`, `pos.sync.onDraftProductsSynced`; 212 gap Windows-only vẫn được registry hai chiều kiểm soát tại `tests/android-preload-surface-parity.test.ts:47-146,172-220`.

3. Cảnh báo “cả tám `pos.billiardCheckout` đều desktop-only” đã stale. Bảy method delegate tới transport thật tại `src/renderer/android-pos/shim/index.ts:115-144` và `src/renderer/android-pos/shim/real-transport.ts:991-997`; chỉ `beginRestoredTender` còn từ chối tại `src/renderer/android-pos/shim/index.ts:135-138`, được pin bởi `tests/android-billiard-checkout-wiring.test.ts:34-85`.

4. “Windows default = salon” cũng sai nếu nói về config đã materialize: Electron schema mặc định `posMode=retail`, `language=en` tại `src/main/config/store.ts:292,334-350`; Android seed `posMode=salon`, `language/posLanguage=pl` tại `src/renderer/android-pos/shim/config-store.ts:84-105`. `POSLayout` chỉ fallback `salon/pl` khi config thiếu tại `src/renderer/components/pos/POSLayout.tsx:335-337`.

### Android đi xa hơn cửa sổ `pos` ở đâu?

| Phần thêm của `AndroidBootApp` | Nên thuộc đâu? | Kết luận |
|---|---|---|
| Login, verify session, expiry và catalog boot (`AndroidBootApp.tsx:67-180`) | Android host shell | Đúng chỗ: Windows POS standalone không tự login; Windows main làm auth rồi POS đọc identity từ config (`docs/android-pos/SHIM_CONTRACT_S1.md:17-24`). |
| Storage durability banner (`AndroidBootApp.tsx:88-96,329-335`) | Android host shell | Đúng chỗ vì đây là trạng thái persistence/native riêng Android, không phải cashier feature. |
| Cài đặt OWNER/MANAGER (`AndroidBootApp.tsx:235-252,359-368,394-397`) | Android host shell, chỉ cho setting mà Android thật sự thực thi | Boundary đúng, nhưng năm toggle thiết bị hiện chỉ persist mà không có consumer Android; đó là defect riêng ở §4. |
| POS/Bi-a navigation (`AndroidBootApp.tsx:181-229,337-369,399-407`) | Shared till-workspace/router, host chỉ render chrome | Hành vi till này cũng tồn tại trong Windows main tại `App.tsx:645-652`; duplicate entitlement/navigation/lifecycle giữa hai shell sẽ drift. Không nhét vào `POSLayout`, nhưng nên model bằng shared module manifest. |

Kết luận chính xác là: **cashier pane Android tương đương Windows `pos`; toàn bộ Android app là một host shell mở rộng quanh pane đó**.

## 3. Bảng divergence của hai cashier

Bảng này kiểm các khác biệt có thể phát sinh từ host/config/capability trong component graph thu ngân. Nó không khẳng định pixel parity vì chưa chụp hai màn thật với cùng salon, cùng config và cùng dữ liệu; giới hạn đó được ghi ở §7.

### 3.1 Config-driven — không phải fork của cashier code

| Khác biệt nhìn thấy | Nguyên nhân và bằng chứng | Phân loại |
|---|---|---|
| Fresh Windows mở Retail/English, fresh Android mở Salon/Polish | Windows schema `retail/en` tại `src/main/config/store.ts:292,334-350`; Android seed `salon/pl` tại `src/renderer/android-pos/shim/config-store.ts:84-105`; shared layout đọc `posMode/posLanguage/language` tại `POSLayout.tsx:335-337,1360-1370`. | Config-driven; cùng `POSLayout` nhưng input khác. |
| Android chỉ chấp nhận `retail`/`salon`, còn shared tree có thêm `b2b`/`restaurant` | Resolver Android giới hạn hai mode tại `shim/config-store.ts:31-63`; shared renderer chọn bốn template tại `POSLayout.tsx:1893-1944`. | Product-scope/config capability, không phải React fork. |
| Oversell, hiển thị đơn non-fiscal, fiscal-on-cash và cân có thể khác theo thiết bị | `allowOversell` chi phối sale tại `POSLayout.tsx:335` và `RetailTemplate.tsx:233,674-700`; `showNonFiscalOrders` tại `POSLayout.tsx:1424`; `fiscalOnCashSale` tại `PaymentModal.tsx:182`; scale tại `POSLayout.tsx:934-943`. | Config-driven; phải so cùng config trước khi gọi là lỗi. |
| Tab Bi-a và quyền giải quyết uncertain tender khác theo plan/role | Android đọc entitlement tại `AndroidBootApp.tsx:181-229`, role OWNER/MANAGER tại `:235-252`; Windows main lọc tabs bằng entitlement/override tại `App.tsx:120-158`. | Entitlement/role-driven, nằm ở shell. |

### 3.2 Prop-driven — host cố ý cung cấp ngữ cảnh khác

| Khác biệt nhìn thấy | Nguyên nhân và bằng chứng | Phân loại |
|---|---|---|
| Android cashier dùng chiều cao parent; Windows `pos` dùng toàn viewport | `embedded` được document tại `POSLayout.tsx:267-290`, render thành `h-full` thay vì `h-screen` tại `:1499-1500`; Android truyền prop tại `AndroidBootApp.tsx:375-392`. | Intentional prop divergence; đây là fix chống pay button rơi dưới fold. |
| Android có banner/reconciliation và callbacks Bi-a mà standalone Windows `pos` không có | `POSApp` truyền zero props (`POSApp.tsx:1-6`); Android truyền intent, reconciliation, OWNER ability và callbacks tại `AndroidBootApp.tsx:375-392`. | Android shell là superset của standalone `pos`. |
| Windows `main` có Fullscreen và Edit Product nhưng Android và standalone `pos` không có | Windows main truyền `onFullscreen`, `onEditProduct` tại `App.tsx:615-618`; bare `POSApp` không truyền gì. | Chỉ là khác nếu so Android với **sai cửa sổ `main`**; không phải mismatch với `pos`. |
| Windows main truyền `onRestoredCartTenderOutcomeUncertain`, Android không truyền | Windows main tại `App.tsx:621-629`; prop được forward vào cả bốn template tại `POSLayout.tsx:1910-1943`; test Android hiện chỉ pin ba callback tại `tests/android-shell-props-parity.test.tsx:196-218`. | Chưa tạo mismatch với standalone `pos` vì bare `POSApp` cũng thiếu; là test/design gap phải đóng cùng lúc khi port `beginRestoredTender`. |

### 3.3 Capability-driven — cùng UI, bridge/platform làm được ít hơn

Green name-parity không chứng minh behavior parity; chính parity test tự ghi giới hạn này tại `tests/android-preload-surface-parity.test.ts:23-28`.

| Surface nhìn thấy | Android hiện làm gì | Đánh giá |
|---|---|---|
| Loyalty trong payment | Nút Loyalty luôn render tại `PaymentModal.tsx:1427-1444`; Android thiếu `pos.loyalty.lookupCustomer` trong registry tại `tests/android-preload-surface-parity.test.ts:137-145`; bấm lookup ra “bridge unavailable” tại `PaymentModal.tsx:184-218`. | **Live gap**, không silently hidden. Ưu tiên trước module port. |
| Hold/Recall | UI gate theo `pos.hold.supported` tại `RetailTemplate.tsx:235-240`; real Android transport đã có hold và test pin handler tại `tests/android-shell-props-parity.test.tsx:290-309`. | Không còn là gap; không được lặp lại báo cáo cũ. |
| Restored-interruption tender | `beginRestoredTender` luôn từ chối tại `shim/index.ts:135-138`; PaymentModal gọi nó trước nhận tiền tại `PaymentModal.tsx:295-350`; hold port ghi rõ slice này chưa port tại `shim/hold-orders.ts:89-95`. | Safe refusal, nhưng chặn recovery money-path trên tablet. |
| Customer display | QuickActions luôn render nút display tại `templates/retail/QuickActions.tsx:173-188`; Retail đổi UI sang “open” khi bridge báo success tại `RetailTemplate.tsx:1030-1055`; Android `window.open/close` trả success nhưng `list=[]` tại `shim/stubs.ts:702-710`. | Capability gap **và** false-success defect: cashier thấy trạng thái giả. |
| Camera/AI quick add | QuickActions render Camera tại `QuickActions.tsx:159-165`; Android `recognition`/`quickAdd` trả unavailable tại `shim/stubs.ts:606-613`; shared handlers biến kết quả thành lỗi nhìn thấy tại `POSLayout.tsx:779-816`. | Capability-driven; affordance nên hide/disable bằng manifest thay vì cho bấm rồi fail. |
| Unknown-EAN import | Shared flow thử draft/master/external tại `POSLayout.tsx:702-768`; Android trả empty/refusal tại `shim/stubs.ts:521-534`. | Android rơi về “Barcode not found”; capability-driven. |
| Label/scale | Android label trả `no-label-printer`, scale trả `NO_SCALE` tại `shim/stubs.ts:659-662,713-725`; shared renderer gọi các surface này tại `POSLayout.tsx:667-699,934-943`. | Hardware capability; lỗi chỉ khi UI/config quảng cáo là available. |
| Pickup queue | Menu queue vẫn render tại `POSLayout.tsx:1750-1764,1791-1800`; Android list empty và mutations unavailable tại `shim/stubs.ts:588-596`. | Capability-driven; hiện không thật sự “silently hidden”. |
| Salon schedule/nail turns | Shared template gọi schedule/nail-turn tại `SalonTemplate.tsx:174-287`; shim delegate khi có transport, nếu không trả unavailable tại `shim/stubs.ts:617-658`. | Dark-launch capability; kết quả phụ thuộc backend/transport, không phải template fork. |
| Billiard history/report | Android không carry `dailyReport`/`sessionHistory`; registry giải thích đây là aux panel Windows-only tại `tests/android-preload-surface-parity.test.ts:88-98`. | Intentionally hidden capability. |
| Receipt outbox status | Shared code optional-subscribe tại `POSLayout.tsx:1406-1422`; hai path được waiver tại `android-preload-surface-parity.test.ts:143-145` vì Android remote print trả terminal result và không có local outbox. | Intentional implementation difference, chưa có bằng chứng visible defect. |

### 3.4 Genuine divergence — cùng hành động nhưng nền tảng render/chạy khác

| Divergence thật | Bằng chứng | Kết luận |
|---|---|---|
| Chromium 83 bỏ flex `gap`, `aspect-ratio`, `:where()` và không hiểu `color-mix` | Thiết bị thật/WebView được đo tại `docs/superpowers/plans/2026-08-07-pos-redesign-dotykacka-brief.md:9-39`; current audit output ở §4 báo 390 finding. | Lỗi thật: cùng class/component nhưng Android layout khác Windows. |
| Font cashier khác nhau | Stack chỉ gồm Bahnschrift/Segoe UI/Tahoma tại `tailwind.config.js:34-36` và `index.css:218-225`; repo đã ghi Android fallback Roboto/Noto và làm đổi wrapping tại design brief `:102-108`. | Lỗi visual parity thật; cần self-host một font chung. |
| “Tạo sản phẩm” và “Sổ nợ” dùng Electron `<webview>` trong ordinary Android WebView | POSLayout mount cả hai panel tại `POSLayout.tsx:1562-1575`; Add Product resolve Electron preload/shell rồi render `<webview>` tại `AddProductWebviewPanel.tsx:17-27,64-84,215-228`; Debt render trực tiếp `<webview>` tại `DebtWebviewPanel.tsx:20-35`; không có adapter/custom element tương ứng dưới `src/renderer/android-pos` (output `rg` ở §4). | Reachable platform bug: action dùng shared UI nhưng primitive chỉ tồn tại trong Electron. |
| Android Settings ghi `de/cs/sk`, trong khi shared translations không có | Android enum/options/normalizer tại `SettingsScreen.tsx:4-15,23-31,150-163`; remote patch allowlist lặp lại tại `shim/device-command.ts:52,73-76`; canonical languages tại `translations.ts:3-13`, `shared/types.ts:610`, `main/config/store.ts:292,350`; unknown language fallback English tại `translations.ts:10569-10571`, còn header index `languageNames[language]` tại `POSLayout.tsx:1782-1786`. | Functional bug trong Android-only shell; có thể hiện English nhưng language badge `undefined`. |
| Năm toggle “Thiết bị” Android không có runtime consumer | UI ghi customer display/self-checkout/kitchen/TV/remote tại `SettingsScreen.tsx:191-239`; Android `setConfig` chỉ merge/persist/emit tại `shim/config-store.ts:199-234`; actual consumers nằm trong Windows main tại `window-manager.ts:244-260`, `ad-display.module.ts:65-74`, `remote.module.ts:161-174`. | Shell bug: setting nhìn như điều khiển tính năng nhưng chỉ lưu/report state. |

Không thấy nhánh `if (Android)` bên trong `POSLayout`; divergence thật chủ yếu đến từ CSS/font/DOM primitive và Android shell, không phải hai phiên bản JSX của cashier (`POSLayout.tsx:320-337,1499-1500,1893-1944`).

## 4. Defects và live gaps, theo độ ưu tiên

### P1 — CSS compatibility làm hai cashier render khác thật

```text
$ npm run test:css-baseline
CSS baseline: Chromium 83 (Android WebView on the SUNMI counter)
scope=pos  files=132  mode=report-only

flex + gap-*  357 site(s)  -> renders as ZERO spacing
aspect-*       13 site(s)  -> no intrinsic height
emitted CSS:    5 :where(, 7 aspect-ratio, 8 color-mix(
REPORT css baseline: 390 finding(s).
```

Đây là nguyên nhân có bằng chứng mạnh nhất cho cảm giác “không giống”: engine thật không thực thi cùng CSS (`docs/superpowers/plans/2026-08-07-pos-redesign-dotykacka-brief.md:25-54`). Guard mặc định đang report-only, strict là script khác tại `package.json:58-59`; `android:build:verify` không gọi strict tại `package.json:44-45`; responsive probe chỉ test Login unauthenticated tại `scripts/verify-android-responsive.mjs:11-16,61-112`.

### P1 — hai action thu ngân dựa vào Electron-only `<webview>`

```text
$ rg -n '<webview' src/renderer/components/pos src/renderer/components/billiard
src/renderer/components/pos/AddProductWebviewPanel.tsx:222:        <webview
src/renderer/components/pos/DebtWebviewPanel.tsx:31:      <webview
$ rg -n 'customElements.define|HTMLWebViewElement|webview|openExternal|getAddbridgePreloadPath' src/renderer/android-pos android-pos
# no matches
```

“Tạo sản phẩm” được truyền vào Retail ở `POSLayout.tsx:1903-1905` và render trong QuickActions tại `QuickActions.tsx:166-171`; “Sổ nợ” luôn có trong header menu tại `POSLayout.tsx:1740-1749`. Đây không phải code chết.

### P1 — language contract Android không khớp shared renderer

`de/cs/sk` được UI và remote command chấp nhận nhưng không có translation; `tr/zh/ru` có trong shared contract lại không có trong Android settings (`SettingsScreen.tsx:4-15`, `device-command.ts:52`, `translations.ts:3-13`). Đây là lỗi data contract, không phải thiếu polish.

### P1 — capability giả thành công hoặc lộ affordance chết

Customer Display chuyển trạng thái UI sang active dù Android không mở window (`QuickActions.tsx:173-188`, `RetailTemplate.tsx:1030-1055`, `shim/stubs.ts:702-710`). Cùng mẫu này xuất hiện ở năm toggle thiết bị Android chỉ persist, không khởi động consumer nào (`SettingsScreen.tsx:191-239`, `shim/config-store.ts:199-234`).

### P1 live gap — loyalty lookup

Đây là outcome thu ngân thật, nút vẫn nhìn thấy và bấm được, nhưng Android thiếu method (`PaymentModal.tsx:184-218,1427-1444`, `android-preload-surface-parity.test.ts:137-145`). Nên đóng gap này trước mọi module back-office.

### P1 safety gap — restored-interruption tender

Android từ chối trước khi nhận tiền nên không tạo false-success/double-charge, nhưng cashier tablet không thể tiếp tục protected restored cart (`PaymentModal.tsx:295-350`, `shim/index.ts:135-138`, `shim/hold-orders.ts:89-95`). Port method và `onRestoredCartTenderOutcomeUncertain` callback/test cùng một packet; không port nửa money boundary.

### P2 — font và build target

Font fallback làm đổi metrics/wrapping (`tailwind.config.js:34-36`, `index.css:218-225`, design brief `:102-108`). Ngoài ra Android Vite config không pin `build.target` tại `vite.android.config.ts:22-31`; repo đã ghi default target cao hơn Chromium 83 là latent JS risk tại design brief `:127` — chưa có bằng chứng syntax hiện tại làm app crash, nên đây là risk chứ chưa phải observed defect.

### P3 — stale docs/comments

Đã sửa comment nói Android mount `POSApp`, comment “Windows default salon”, và cảnh báo “8 billiard method đều desktop-only” trong `vite.android.config.ts:6-9`, `src/renderer/android-pos/main.ts:1-12,63-69`, `src/renderer/android-pos/shim/config-store.ts:31-50`, `tests/android-preload-surface-parity.test.ts:4-28`. Chỉ comment/doc thay đổi; product behavior không đổi.

Lưu ý: câu “chỉ genuine divergence mới là defect” trong packet quá mạnh. Một capability thiếu có thể là scope hợp lệ, nhưng capability **reachable và báo success giả** (customer display) hoặc affordance live không làm được outcome cốt lõi (loyalty) vẫn là product defect, dù JSX shared không fork.

## 5. Recommendation cho module split

### Giữ quyết định shared renderer

Không fork `POSLayout` thành Windows/Android. Plan đã chủ động bỏ cuộc rewrite `PosApplication/PlatformPorts` 641 call-site và chọn renderer thật sau shim tại `PARITY_PORT_PLAN_2026-07-18.md:14-20`; cùng plan yêu cầu Windows behavior là reference tại `:48-64`. Fork bây giờ sẽ làm mọi pricing/cart/payment fix phải sửa hai nơi, trong khi current parity suite đã pin 20 behavior/name/DTO checks.

### Nhưng tách `POSLayout` theo trách nhiệm nội bộ

`POSLayout` 2082 dòng hiện statically import bốn template, payment/shift, scan/import, camera, webviews, pickup, sync và billiard handoff tại `POSLayout.tsx:1-55`; nó chọn bốn mode tại `:1893-1944`. Android build vì vậy tạo app chunk 1.47 MB minified, ngoài SQL.js (`npm run build:android:web` output bên dưới):

```text
✓ 1887 modules transformed
index.css                         152.18 kB
vendor-socketio.js                41.85 kB
vendor-sqljs.js                1,354.43 kB
index.js                       1,466.85 kB
✓ built in 11.23s
```

Đề nghị split theo lớp, không đổi semantics:

1. `WindowsPosHost` và `AndroidPosHost`: auth, native persistence, back button, OS/window integration.
2. Shared `TillWorkspace`: module manifest cho `pos`, `billiard` và các till outcome được entitlement/role/capability gate; host quyết định chrome nhưng không duplicate business navigation.
3. Shared `CashierCoordinator`: giữ cart/config/template selection, nhưng extract `useShiftFlow`, `usePickupFlow`, `useScanImportFlow`, `useQuickAddFlow`, `useBilliardTenderFlow` và `CashierModalLayer` từ `POSLayout`.
4. Narrow `PosCapabilities`: flags như `customerDisplay`, `loyaltyLookup`, `quickAdd`, `labelPrint`, `restoredTender`, `productEdit`; UI hide/disable có lý do thay vì suy luận từ method optional hoặc string `'desktop-only'` (`shim/stubs.ts:502-710`).
5. Chỉ sau khi các extraction giữ parity mới cân nhắc lazy-load template theo `posMode`; phải test offline chunks/CSP và Chromium 83 vì config hiện chưa pin target (`vite.android.config.ts:22-45`, design brief `:127`).

Không tạo lại một `PlatformPorts` bao trùm 641 call. Capability manifest phải nhỏ, read-only ở renderer và phản ánh các outcome nhìn thấy; implementation vẫn ở preload/shim hiện tại.

### Cost và break risks

Đây là ước lượng engineering dựa trên 2082 dòng coordinator, 149-file Android graph, bốn template và money-path callbacks; không phải thời gian đã đo (`POSLayout.tsx:1-55,267-337,1893-1944`; boundary output ở §2).

| Phase | Scope | Ước lượng |
|---|---|---:|
| 1 | Pure extraction hooks/sections, zero behavior change | 2–3 ngày |
| 2 | Capability manifest + hide/disable affordance + tests hai host | 2–3 ngày |
| 3 | Optional template lazy chunks | 1–2 ngày |
| 4 | Windows 800×600/1024×768 + SUNMI 1336×736 regression/on-device | 1–2 ngày |
| **Tổng** | Không gồm sửa 390 CSS findings | **6–10 engineer-days** |

Rủi ro chính: duplicate/unsubscribe barcode và connection listeners (`POSLayout.tsx:332,1382-1422`), reset modal/cart state khi extract, rơi billiard tender callbacks (`POSLayout.tsx:267-290,1910-1943`), remount panes làm mất lifecycle (`AndroidBootApp.tsx:371-407`), lazy chunk fail offline/CSP, và mọi sửa shared cashier đổi luôn till Windows live (`docs/superpowers/plans/2026-08-07-pos-redesign-dotykacka-brief.md:67-79`).

## 6. Trong 17 module chưa port, cái gì thật sự thuộc về till?

Trước danh sách: `pos.loyalty.lookupCustomer` không phải một module nhưng là ưu tiên số 0 vì nằm ngay trong payment (`PaymentModal.tsx:184-218,1427-1444`). Với 17 module, nên port **outcome hẹp**, không copy nguyên component.

| Rank | Module Windows | Quyết định cho Android till | Lý do/evidence |
|---:|---|---|---|
| 1 | `ProductModule` | Port quick edit/price/stock correction cho OWNER/MANAGER, không port full 1048 dòng | Android đã có narrow product-admin transport gồm create/update/adjust/receive/category tại `shim/product-admin.ts:179-265`; full module mang browse/draft/category/admin flows tại `ProductModule.tsx:1-20,58-76`. |
| 2 | `BookingsTodayScreen` | Port các action “hôm nay” còn thiếu, không copy full screen | Full module list/edit/cancel appointment qua desktop `bookings.*` tại `BookingsTodayScreen.tsx:1-10`; cashier Salon đã có lịch, waiting check-ins và assignment tại `SalonTemplate.tsx:188-287,625-795`. |
| 3 | `CheckinWizard` | Chỉ port staff-assisted check-in nếu SalonTemplate chưa cover; không đặt nguyên customer kiosk vào nav thu ngân | Wizard là multi-step customer flow tại `CheckinWizard.tsx:5-15,25-45`; Android cashier đã có schedule/waiting workflow nêu trên. |
| 4 | `OrdersTab` | Đóng các order-operation gap trong `OrderHistoryModal`; không port full 713 dòng | Retail đã mount `OrderHistoryModal` tại `RetailTemplate.tsx:1574-1582`; modal đã có refund/reprint/invoice operations, ví dụ refund tại `OrderHistoryModal.tsx:638-703`. |
| 5 | `TouchKeyboard` | Chỉ thêm sau test IME/keyboard thật chứng minh cần | Windows main mount keyboard global tại `App.tsx:710-715`; Android có input stack riêng trong hardware shim tại `shim/stubs.ts:713-725`. |
| 6 | `RemoteIndicator` | Chỉ bắt buộc cùng packet nếu Android thật sự có remote-control | Indicator là security disclosure khi session active tại `RemoteIndicator.tsx:9-18,47-59`; Android registry xếp `remote` vào desktop integration tại `android-preload-surface-parity.test.ts:78-87`. |
| 7 | `LabelModule` | Không port full module; thêm quick label action khi remote label-print capability tồn tại | Module gọi local `printLabel` tại `LabelModule.tsx:671`; Android hiện trả `no-label-printer` tại `shim/stubs.ts:713-725`. |
| 8 | `Status` | Giữ diagnostics tối thiểu trong Android Settings, không port full connect/print-agent screen | Full Status flush sync, test print và connect API key tại `Status.tsx:49-98`; Android shell đã hiển thị identity/version/network tại `SettingsScreen.tsx:242-252`. |
| 9 | `InvoicingTab` | Không port full back-office; payment chỉ cần NIP/invoice outcome hiện có | Full module có quick/list/customers/seller settings tại `InvoicingTab.tsx:1-17,23-61`; PaymentModal đã có NIP và `INVOICE` method tại `PaymentModal.tsx:222-229,1450-1478`. |
| 10 | `SelfCheckoutTab` | Không thuộc handheld till | Đây là config UI cho hai cửa sổ kiosk riêng, mount `GrocerySelfCheckoutPanel` và `KitchenSelfOrderPanel` tại `SelfCheckoutTab.tsx:1-6,39-46`; Windows Vite đã có entries riêng tại `vite.config.ts:32-39`. |
| 11 | `BooksySync` | Không port | Long-lived desktop integration: status/config/bookings/sync tại `BooksySync.tsx:9-25,48-80`; registry waiver `booksy` là desktop integration tại `android-preload-surface-parity.test.ts:78-87`. |
| 12 | `WarehouseModule` | Không port full module; chỉ stock correction đã nằm ở rank 1 | Module quản lý PZ/WZ/RW/PW/MM/INW tại `WarehouseModule.tsx:17-32,51-63`, là warehouse/back-office. |
| 13 | `ForecastOrderingTab` | Không port | Gọi forecast, warehouse và tạo purchase-order draft tại `ForecastOrderingTab.tsx:219-367`; không phải cashier transaction. |
| 14 | `SecurityTab` | Không port | Điều khiển security service start/stop/config tại `SecurityTab.tsx:36-109`; registry xếp `security` back-office tại `android-preload-surface-parity.test.ts:110-127`. |
| 15 | `Chat` | Không port | AI status/chat/history tại `Chat.tsx:20-36,212-301`; registry xếp `ai` back-office tại `android-preload-surface-parity.test.ts:110-127`. |
| 16 | `Debug` | Không port | DevTools/log/backup/restore desktop tại `Debug.tsx:42-125`; các namespace này được waiver desktop shell tại `android-preload-surface-parity.test.ts:68-87`. |
| 17 | `Sidebar` | Không phải module để port | Đây là chrome điều hướng 17 tab của `App`, được mount tại `App.tsx:583-598`; Android cần `TillWorkspace` hẹp chứ không copy back-office sidebar. |

Danh sách imports chứng minh đủ 17 phần không có counterpart: `App.tsx:4-24`; Android counterpart hiện có cho `AuthScreen`/`Settings` bằng `LoginScreen`/`SettingsScreen`, và dùng chung `POSLayout`/`BilliardFloorPlan` tại `AndroidBootApp.tsx:17-23,375-407`.

## 7. Traps cho lần port/refactor tiếp theo

1. **Engine floor là Chromium 83**, không phải Electron 33: flex-gap, aspect ratio và selector hiện đã fail trên thiết bị thật (`docs/superpowers/plans/2026-08-07-pos-redesign-dotykacka-brief.md:25-54`).
2. **Canvas thật là 1336×736 CSS px**, không phải 1920×1080 physical; Android chrome còn ăn thêm chiều cao (`design brief:13-23`, `AndroidBootApp.tsx:328-371`). Windows phải đồng thời chịu 800×600 minimum và 1024×768 default (`window-manager.ts:60-69`).
3. **`embedded` không phải style tùy ý**: bỏ prop này làm child đòi 100vh trong parent đã có banner/nav, đẩy payment toolbar xuống fold (`POSLayout.tsx:267-290,1499-1500`, `AndroidBootApp.tsx:375-380`).
4. **Tên API trùng không chứng minh behavior**: runtime surface test chỉ kiểm name; billiard từng green khi behavior chưa port, và hiện vẫn còn `beginRestoredTender` (`android-preload-surface-parity.test.ts:23-28`, `android-billiard-checkout-wiring.test.ts:34-85`).
5. **Optional method không đồng nghĩa UI đã hide**: Loyalty, pickup, camera và customer display đều còn affordance nhìn thấy (`PaymentModal.tsx:1427-1444`, `POSLayout.tsx:1750-1764`, `QuickActions.tsx:159-188`).
6. **Browser primitive cũng là capability**: `<webview>` không đi qua `electronAPI`, nên surface parity guard không bắt được (`AddProductWebviewPanel.tsx:17-27,222-228`, `DebtWebviewPanel.tsx:31-35`).
7. **Sửa shared cashier là release Windows lẫn Android**: quyết định này đã được ghi rõ tại `docs/superpowers/plans/2026-08-07-pos-redesign-dotykacka-brief.md:67-79`; test cả 1024×768 và 1336×736 trước rollout.
8. **Bundle graph không phải directory glob**, nhưng static import bốn mode vẫn ship cả bốn: `POSLayout.tsx:29-44,1893-1944`; lazy-load phải giữ offline availability.

## 8. Validation đã chạy

```text
$ npm run test:android:parity
Test Files  3 passed (3)
Tests       20 passed (20)

$ npx vitest run tests/android-settings-screen.test.tsx \
  tests/android-billiard-checkout-wiring.test.ts --reporter=verbose
Test Files  2 passed (2)
Tests       15 passed (15)

$ npm run test:android:boundaries:bundle
PASS cross-platform boundaries: 149 source file(s) scanned from 1 entry point(s);
5 built bundle file(s) scanned

$ npm run build:android:web
✓ 1887 modules transformed
✓ built in 11.23s
```

Parity tests green không phủ các defect Settings language, runtime effect của device toggles, `<webview>` Android và authenticated cashier layout; các test Settings hiện chỉ chứng minh value được persist tại `tests/android-settings-screen.test.tsx:145-226`.

## 9. Những gì chưa kiểm

- Chưa chụp/pixel-diff Windows `pos` và Android trên thiết bị thật với **cùng salon, cùng user, cùng `posMode`, cùng language, cùng catalog/cart**; vì vậy review không nói hai màn “giống pixel”.
- Chưa login hay gọi backend production/test salon; không tạo order, refund, shift, billiard payment, loyalty lookup hoặc print job.
- Chưa chạy hardware flows trên SUNMI: scanner, camera, IME, remote receipt/label printer, customer display, back button và storage refusal.
- Chưa chạy strict CSS gate vì nó được biết sẽ fail với 390 finding; không sửa behavior/CSS trong pass review này.
- Chưa thử dynamic-import/lazy chunk trên Chromium 83/offline; đó mới là recommendation, không phải implementation.
- Không đọc/so với `main` như baseline Android theo ràng buộc của packet; chỉ dùng `main` để giải thích vì sao người dùng có thể đã so nhầm cửa sổ.
