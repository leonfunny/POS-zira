# Review POS nhà hàng — Windows / Android

Ngày: 08/09/2026. Phạm vi: working tree `codex/pos-ui-release-foundation` tại `C:/Users/maxis/enail/POS-zira-release-foundation`, bao gồm phần thiết kế đang sửa, không chỉ commit gốc trên GitHub.

## Kết luận

**Chưa thể coi đây là POS nhà hàng hoàn chỉnh hoặc hai bản Windows/Android đã tương đương.** Windows có giao diện nhà hàng mới và bán tại quầy không cần bàn. Android dùng chung renderer/CSS nhưng hiện loại bỏ chế độ nhà hàng; lớp giao tiếp Android cũng chưa triển khai nghiệp vụ bàn tương ứng. Phần thiết kế mới chủ yếu bao phủ menu, giỏ hàng và chọn bàn, chưa bao phủ mọi màn liên quan.

Đây là review mã nguồn và kiểm tra cục bộ. Không thay đổi mã nghiệp vụ, không tạo đơn thật, không thanh toán/in thật, không sửa database hoặc triển khai lên server. Chưa mở APK trên máy Android, chưa kiểm tra pixel trên hai thiết bị thật. Không có cơ sở xác nhận phiên bản APK/EXE đang cài ngoài checkout này.

## Lỗi và khoảng trống nghiệp vụ

### R1 — P1: Android không chạy chế độ nhà hàng; chỉ đổi một cờ chưa đủ

- `src/renderer/android-pos/shim/config-store.ts:41,54`: kiểu được hỗ trợ chỉ gồm `retail | salon`; cấu hình `restaurant` rơi về `salon`.
- `src/renderer/android-pos/main.ts:48`: khi khởi động, kết quả này được ghi ngược vào cấu hình.
- `src/renderer/android-pos/shim/stubs.ts:540`: lấy bàn luôn trả `[]`; đổi trạng thái, xóa bàn và lưu số khách là thao tác rỗng. Danh sách pickup cũng trả rỗng tại dòng 562.
- `src/renderer/android-pos/shim/index.ts:98`: dispatch trả `Promise<void>`, trong khi `RestaurantTemplate.tsx:172` đọc `result.success`. Nếu cưỡng ép bật restaurant, đổi loại phục vụ/bàn có thể báo lỗi truy cập `success` trên `undefined`.
- `src/renderer/android-pos/shim/pos-store.ts:399`: chỉ đổi `activeTable`, không lưu `orderType` hoặc áp dụng cùng quy tắc bảo vệ giỏ với Windows.

Kiểm tra trực tiếp bằng dữ liệu giả: `resolvePosMode({posMode:'restaurant'})` trả `salon`; hành động chuyển sang delivery trên giỏ trống tạo `checkoutDraft.restaurant.orderType='delivery'` ở Windows nhưng Android vẫn có `checkoutDraft={}`.

Đề xuất: cần một hạng mục parity thực sự gồm mode, hợp đồng dispatch, state/context, API bàn/pickup và test tích hợp. Không chỉ thêm `restaurant` vào danh sách lựa chọn.

### R2 — P1 với quán phục vụ nhiều bàn: chưa có luồng lưu/mở lại đơn từng bàn

`RestaurantTemplate.tsx:64,161,299` chỉ lọc bàn theo trạng thái rồi chọn `activeTable`; không nạp đơn theo `current_order_id`. Khi bàn A đã có món, đổi sang bàn B bị chặn. Thông báo yêu cầu thanh toán hoặc lưu đơn, nhưng `Cart` ở dòng 358 không nhận `onHold`; nút lưu chỉ xuất hiện khi có prop này (`Cart.tsx:1008`). RestaurantTemplate/POSLayout cũng không có luồng gọi lại Hold tương ứng.

Hậu quả: nhân viên không thể dùng luồng nhà hàng này để lưu món bàn A, nhận món bàn B rồi quay lại A. Backend desktop có cơ chế Hold, nhưng chưa được nối vào màn nhà hàng. “Bàn đang mở” không phải danh sách hóa đơn mở như tab Checks trong ảnh tham chiếu.

Đề xuất: nối lưu/gọi lại đơn vào UI và gắn rõ đơn với bàn; phân biệt chuyển bàn của một đơn với chuyển sang phục vụ một đơn khác. Nếu cần chia sẻ bàn giữa thiết bị, phải xác nhận hợp đồng backend trước khi triển khai.

### R3 — P1: quét barcode có thể vượt bước chọn bàn và làm mắc kẹt giỏ

`POSLayout.tsx:1364–1394` dùng đường thêm hàng kiểu retail cho ô nhận barcode chung, không kiểm tra `canSell` của nhà hàng và không mang course đang chọn. `pos.module.ts:2582–2599` không bổ sung kiểm tra phải chọn bàn cho `cart/addItem`.

Tình huống: restaurant có bàn, chưa chọn bàn, quét một sản phẩm hợp lệ vào ô barcode chung. Món được thêm vào giỏ. Sau đó chọn bàn bị `canChangeRestaurantContext` chặn vì giỏ đã có món (`src/shared/pos-mode.ts:46`), còn mở thanh toán bị `RestaurantTemplate.tsx:236` chặn vì chưa có bàn. Phải xóa giỏ mới thoát được luồng này.

Đề xuất: thao tác chạm món và quét mã phải đi qua cùng kiểm tra ngữ cảnh nhà hàng. Đây là kết luận từ đường mã; chưa thử máy quét vật lý.

### R4 — P1: món có ghi chú khác nhau bị gộp chung

`src/main/pos/pos-store.ts:365` và `src/renderer/android-pos/shim/pos-store.ts:228` chỉ so variant, nhân viên và course khi gộp; không so ghi chú.

Đã tái hiện bằng reducer thực, chỉ giả lập phần phụ thuộc desktop: thêm một Coffee ghi chú “khong duong”, rồi thêm Coffee thường cùng course → chỉ còn một dòng `quantity:2, notes:'khong duong'`. Hai khách có yêu cầu khác nhau bị biểu diễn như cùng một yêu cầu.

Đề xuất: giữ riêng dòng khác ghi chú/cấu hình món. Sau khi sửa phải có test thêm món thường vào dòng đã được ghi chú và ngược lại.

### R5 — P2: thông tin nhà hàng có trong đơn local nhưng bị bỏ khỏi payload đồng bộ

`PaymentModal.tsx:678–716` tạo `table_id`, `covers`, `notes`, `course`. Local order repo cũng lưu các trường đó. Tuy nhiên:

- `src/main/sync/order-sync.ts:235–248` và đường sync-log trong `src/main/modules/pos.module.ts:5813–5845` không đưa bàn/số khách vào DTO đơn.
- `src/main/pos/order-line-contract.ts:57–98` không đưa ghi chú/course vào DTO dòng món.
- Android có cùng khoảng trống tại `shim/real-transport.ts:430–464` và `shim/db/order-repo.ts:70–87`.

Probe DTO dòng món có notes/course trả về chỉ product/variant/SKU/giá/số lượng. Vì vậy không thể kỳ vọng các đường đồng bộ đã kiểm tra mang đủ ngữ cảnh này sang backend hoặc thiết bị khác. Điều này **không đồng nghĩa dữ liệu local đã mất hoặc mọi đường in bếp đều mất ghi chú**.

Đề xuất: lập yêu cầu backend xác nhận trường được nhận/lưu/trả về; sau đó bổ sung mapping hai chiều và test round-trip. Không gửi thêm trường tùy ý vì DTO hiện có chú thích whitelist-strict.

### R6 — P2: chỉ chạm vào bàn đã đánh dấu có khách, nhưng không gắn đơn

`RestaurantTemplate.tsx:177–180` đổi bàn trống thành occupied ngay khi chọn, chưa cần thêm món, không truyền orderId. `table-repo.ts:30` chỉ gắn `current_order_id` và `opened_at` khi có orderId.

Tình huống: chọn bàn A, chưa thêm món, chuyển sang bàn B. A vẫn occupied nhưng không có đơn vừa được tạo. Luồng giải phóng ở `RestaurantTemplate.tsx:225` chỉ áp dụng sau thanh toán; không có nút giải phóng bàn trống trong màn này. Danh sách “Bàn đang mở” có thể chứa bàn mở giả; bộ lọc hiện còn tính cả `reserved` vì điều kiện là `status !== 'free'`.

Đề xuất: mở bàn gắn với tạo/lưu đơn thực, hoặc có thao tác mở/hủy bàn rõ ràng; không coi việc xem/chọn bàn là đã nhận khách.

### R7 — P2, khi bán món theo cân: chạm món mặc định thêm đúng 1 đơn vị

`RestaurantTemplate.tsx:194–214` luôn đặt `quantity:1`, kể cả sản phẩm có `sell_by:'WEIGHT'`. Không gọi bước đọc cân/nhập khối lượng như đường retail. Thẻ sản phẩm lại có nhãn đơn vị cân (`ProductCard.tsx:219`).

Hậu quả: món tính theo kg được thêm như 1 kg dù chưa cân. Cần dùng quy tắc nhập số lượng theo loại bán chung, hoặc chủ động chặn sản phẩm cân trong mode nhà hàng cho đến khi hỗ trợ.

### R8 — P2: ghi chú đang nhập có thể không đi vào đơn

`CartItem.tsx:70–87,343–369` giữ nội dung ở state riêng và chỉ lưu khi bấm OK; không có autosave/commit khi mở thanh toán. Thanh toán đọc `item.notes` đã lưu (`PaymentModal.tsx:715`).

Tình huống: gõ ghi chú rồi bấm Thanh toán ngay, không bấm OK. Ghi chú mới không được đưa vào đơn. Cần tự lưu theo quy tắc rõ ràng hoặc cảnh báo còn bản nháp trước khi thanh toán. Nút Hủy vẫn nên giữ ý nghĩa bỏ thay đổi.

### R9 — P2: số khách có bước lưu riêng và nuốt lỗi

`RestaurantTemplate.tsx:256–259` lưu số khách bằng một nút riêng, không trạng thái đang lưu/thành công và `catch(() => {})`. Thanh toán dùng `activeTable.covers`, không phải `coversInput` (`:398`). Người dùng sửa số rồi thanh toán trước khi lưu có thể tạo đơn với số cũ; lỗi lưu cũng không được báo.

Đề xuất: kiểm tra số nguyên hữu hạn, thông báo lỗi, có trạng thái lưu; commit hoặc nhắc lưu trước khi thanh toán. Giới hạn theo sức chứa là lựa chọn nghiệp vụ, không nên tự áp đặt nếu quán cho phép ghép ghế.

### R10 — P2 UX: sửa số lượng cũng kéo giỏ xuống cuối

`Cart.tsx:779–796` theo dõi toàn bộ `id:quantity`, rồi luôn cuộn xuống đáy khi chữ ký thay đổi. Sửa số lượng món ở đầu đơn dài sẽ mất vị trí đang làm việc.

Đề xuất: chỉ cuộn khi thêm một dòng mới ngoài vùng nhìn, hoặc người dùng vốn đang ở cuối; giữ vị trí khi sửa/xóa dòng hiện có.

## Trường và chức năng đã có / còn thiếu

Các mục “thiếu” dưới đây là trong luồng RestaurantTemplate → Cart → PaymentModal đã kiểm tra, không phải kết luận rằng toàn bộ backend Zira không có khả năng đó.

| Nhóm | Đã có | Còn thiếu hoặc chưa nối hoàn chỉnh |
|---|---|---|
| Bán tại quầy | Menu, tìm kiếm, danh mục, giỏ, bán không cần bàn | Các lỗi ghi chú/barcode/cân ở trên |
| Tại chỗ | Bàn, khu vực, sức chứa, số khách, course | Lưu/mở lại đơn từng bàn; chuyển/ghép bàn và tách đơn có kiểm soát |
| Mang đi | Nhãn `takeout` | Thông tin người nhận/giờ lấy trong form nhà hàng; không nên nhầm với số đơn tự sinh hoặc pickup của kiosk |
| Giao hàng | Nhãn `delivery` | Form người nhận, điện thoại giao hàng, địa chỉ, hướng dẫn, phí giao, giờ giao và trạng thái giao |
| Cấu hình món | Variant là sản phẩm bán, ghi chú tự do, course | Form lựa chọn đường/đá/topping/độ chín, ràng buộc bắt buộc và phần phụ thu; không có nghĩa mọi variant kích cỡ đều thiếu |
| Bếp | Có hệ thống kiosk/pickup riêng trong POSLayout | Chưa thấy thao tác gửi/gọi từng course từ đơn bàn trong RestaurantTemplate; cần xác nhận riêng luồng bếp nhà hàng |
| Thanh toán | Ca mở, tiền mặt/thẻ, nhiều khoản thanh toán, giảm giá, NIP/hóa đơn | Chia theo món/người khác với chia theo phương thức; UI nhập tip không có trong màn nhà hàng dù DTO nhận tip |
| Ngữ cảnh đơn | Nhân viên ca, loại đơn, bàn/số khách local | Chưa mang đầy đủ metadata nhà hàng qua các DTO sync đã kiểm tra |

Số điện thoại loyalty/KSeF trong PaymentModal phục vụ nhận diện/hóa đơn, không thay thế một form giao hàng hoàn chỉnh.

## Thiết kế và mức giống ảnh tham chiếu

| Màn/khu vực | Hiện trạng |
|---|---|
| POS fullscreen, menu trái, sản phẩm, giỏ phải | Đã theo hướng ảnh: nền navy, danh mục dọc, nhóm món có màu, đơn hàng bên phải |
| Bảng chọn bàn | Đã dùng palette tối và nút lớn; vẫn là danh sách theo khu vực, không phải sơ đồ mặt bằng có vị trí |
| “Bàn đang mở” | Cùng palette nhưng chỉ là bộ lọc bàn, chưa tương đương màn Checks quản lý đơn |
| Thanh toán | Vẫn nền trắng/xám, nút brand cũ; `PaymentModal.tsx:1376` nằm ngoài vùng `.restaurant-pos` |
| Mở/đóng ca | Vẫn thành phần dùng chung thiết kế sáng; `ShiftModal.tsx:94,124,168` |
| Lịch sử/chi tiết/hoàn đơn | Còn white panels, font đậm và border cũ; `OrderHistoryModal.tsx:2786,2849` |
| Pickup/bếp trong menu header | Có ở desktop, nhưng Android trả danh sách rỗng; không thể gọi là cùng luồng |

Palette đã chủ đích: canvas `#1c2030`, rail `#191e2c`, panel `#222737`, chữ `#f3f4f8`, chữ phụ `#b4bdd0`, hành động chính `#345daf`. Nhóm món dùng sáu màu trầm. Đây là tương đồng về hướng thiết kế, không phải bản sao pixel của ảnh chụp nghiêng SpotOn.

Ảnh hiện dùng `object-fit:contain` trên nền sáng, giữ được hình ly/chai; ảnh tham chiếu chủ yếu là ảnh món ăn crop sát. Cần chuẩn hóa ảnh catalog nếu muốn gần mẫu hơn. Không nên tự thay ảnh món thật bằng ảnh trang trí không đúng sản phẩm.

### Responsive và khả năng thao tác

- Số cột đã tự co giãn, không cố định 11: menu dùng auto-fill với ô tối thiểu 176px, hoặc 152px ở container nhỏ. Cột giỏ có bề rộng riêng, nên phải tính theo phần menu còn lại, không chỉ độ phân giải màn hình.
- Container ≤900px chuyển danh mục thành thanh ngang; ≤620px xếp giỏ xuống dưới. Đây là thay đổi bố cục có chủ đích, không cần Android và Windows giống số cột ở mọi kích thước.
- Chưa kiểm thử đủ màn thấp/portrait/bàn phím mở. Riêng Android có tab POS/Bi-a: parent cao 100vh + thanh tab, trong khi POSLayout con vẫn 100vh (`AndroidBootApp.tsx:166–188`, `POSLayout.tsx:1570`), nên có rủi ro tràn đáy khi tab này được bật.
- Nút bàn nhanh chỉ cao 36px (`restaurant-pos.css:78`), nút lưu/hủy ghi chú 40px (`CartItem.tsx:357,364`), nhỏ hơn mục tiêu 44px của các nút chính khác.
- Bàn reserved/occupied/bill chủ yếu phân biệt bằng màu; tên trạng thái không hiện đầy đủ trong nội dung nút (`TableMap.tsx:58`). Nên thêm chữ trạng thái, đặc biệt cho người khó phân biệt màu.
- Còn chuỗi tiếng Anh trực tiếp cho lỗi bảo vệ giỏ (`RestaurantTemplate.tsx:83–85`) và nhãn trợ năng `Add ...` (`ProductCard.tsx:175`). Cần đưa vào bản dịch; không có cơ sở kết luận mọi ngôn ngữ đã được QA đầy đủ.

Đánh giá thiết kế qua mã: **B cho màn menu/giỏ mới; C cho tính nhất quán toàn luồng**. Bố cục có chủ đích, không có vấn đề “card trang trí” hàng loạt; điểm yếu là thiết kế mới chỉ đi được một phần luồng và phải phủ CSS lên utility của component cũ.

## Bản đồ trạng thái các thành phần chính

`Có` nghĩa đã thấy nhánh xử lý trong mã, không phải đã chạy mọi tình huống trên thiết bị.

| Thành phần | Trạng thái đã thấy | Khoảng trống cần chú ý |
|---|---|---|
| POSLayout | Loading, kết nối, lỗi dispatch, ca, cảnh báo in | Barcode chung không tuân theo context nhà hàng |
| RestaurantTemplate | Tải bàn, lỗi/thử lại, không có bàn, đổi context đang chờ, chặn thanh toán | Lưu số khách nuốt lỗi; không có đơn riêng mỗi bàn |
| RestaurantCategoryRail | Tất cả, chọn danh mục, danh sách rỗng | Không có thông báo tải/lỗi riêng; dựa vào menu |
| RestaurantMenu | Skeleton, error/retry, empty, tìm không thấy, dữ liệu, làm mới sau sync | Chưa kiểm tra cảm giác cuộn/render trên Android thật |
| ProductCard | Có ảnh, ảnh lỗi/fallback, hết hàng, giá, focus/keyboard | Số lượng theo cân không được template xử lý |
| TableMap | Theo khu vực, chọn bàn, màu trạng thái | Không mở lại đơn; trạng thái phụ thuộc nhiều vào màu |
| DiningOptions | Loại đang chọn | Không nhận prop disabled/busy; parent chặn nhưng nút vẫn có vẻ dùng được |
| CourseSelector | Course đang chọn | Chỉ áp dụng lúc thêm mới; chưa có luồng gọi món từng đợt từ bàn |
| Cart | Rỗng/có món, tổng tiền, ca đóng, nút thanh toán | Hold không được nối; cuộn khi sửa số lượng |
| CartItem | Thu gọn/mở rộng, số lượng, ghi chú đang sửa/đã lưu | Bản nháp ghi chú không được chặn trước thanh toán |
| PaymentModal | Snapshot tiền, nhập/chia khoản, submitting, lỗi/retry, kết quả in | Theme cũ; không có form delivery/tip cho nhà hàng |
| ShiftModal | Danh sách nhân viên/loading/error, nhập tiền, saving, guard thay đổi | Theme cũ |
| OrderHistoryModal | Lọc, tải danh sách, rỗng/lỗi, chọn đơn, hoàn/in lại | Theme cũ; chưa QA thiết bị/API tất cả nhánh |

## Luồng hiện tại

```text
Đăng nhập
  ├─ Windows: chọn mode theo cấu hình salon → RestaurantTemplate
  └─ Android: restaurant bị loại → salon

RestaurantTemplate → tải bàn + catalog
  ├─ tải bàn lỗi → báo lỗi / thử lại
  ├─ không có bàn → bán tại quầy
  └─ có bàn + tại chỗ → chọn bàn → occupied ngay
          ↓
       chọn món / ghi chú / course
          ├─ sang bàn khác khi có món → chặn; thiếu lối lưu/gọi lại đơn
          └─ thanh toán (phải mở ca)
                 ↓
           lưu đơn local → đồng bộ / in → hoàn tất → giải phóng bàn

Đường barcode chung ──→ thêm món trực tiếp
                         (bỏ qua kiểm tra chọn bàn của template)
```

## Kiểm tra đã chạy và giới hạn

- 5 file kiểm thử, **75 tests passed**: restaurant-counter-sales, android-salon, pos-mode, pos-store, pos-template-catalog-refresh.
- **Android web build thành công**. Có cảnh báo bundle lớn và thư viện sql.js externalize module Node; chưa chạy gate native hoặc APK/device, không coi build web là bằng chứng vận hành Android hoàn chỉnh.
- Probe không ghi dữ liệu: tái hiện gộp ghi chú trên hai reducer, mode restaurant rơi về salon, Android không lưu delivery, DTO dòng món thiếu notes/course.
- CSS Windows hiện có và Android vừa build cùng SHA-256: `7ba30af5d96d825683c3d3585d10124794f9009a2354c6c860039d4717dcc4ae`. Đây chỉ là CSS bundle chung, không phải bằng chứng cùng chức năng hoặc bản đang cài đã cập nhật.
- Không có `android-pos/app/src/main/assets/public` hoặc `android-pos/app/build/outputs` trong checkout tại thời điểm kiểm tra. Chưa sync native/build APK ở lượt này.
- `git diff --check` không báo lỗi. Không sửa source ứng dụng trong lượt review.
- Các test nhà hàng đang mock RestaurantMenu, Cart, PaymentModal và TableMap (`tests/restaurant-counter-sales.test.tsx:15–28`), nên test xanh không chứng minh UI thật, chiều cao fullscreen, hoặc parity Android đã đúng.
- Dùng graph Tier 2, generation `2026-09-08T00:04:44Z`, tra symbol/call paths và kiểm tra coverage. Metadata freshness vẫn báo changed; đã đối chiếu trực tiếp source ở các đoạn làm bằng chứng. Tests/CSS build/i18n bị loại khỏi graph và đã đọc trực tiếp. Không tuyên bố exhaustive audit toàn backend hoặc tất cả tích hợp máy in.

## Thứ tự sửa đề xuất

1. Chặn sai nghiệp vụ: gộp ghi chú, barcode vượt context, lượng bán theo cân.
2. Hoàn thiện đơn theo bàn: lưu/gọi lại, vòng đời occupied/free, số khách và ghi chú chưa lưu.
3. Thống nhất hợp đồng dữ liệu nhà hàng với backend; kiểm tra round-trip bàn/số khách/notes/course.
4. Port restaurant thực sự sang Android, không chỉ chia sẻ React/CSS.
5. Đồng bộ theme thanh toán, lịch sử/hoàn đơn và ca làm; QA fullscreen + màn thấp + portrait + bàn phím.

Quick wins nhỏ, dự kiến dưới 30 phút mỗi mục, chưa thực hiện: giữ vị trí giỏ khi sửa số lượng; hiển thị lỗi lưu số khách; tăng nút bàn nhanh và nút ghi chú lên 44px; dịch các chuỗi lỗi/aria trực tiếp; thêm chữ trạng thái bàn thay vì chỉ màu.

Tổng kết theo `code-design-review`: 13 thành phần chính được đối chiếu trạng thái, 10 phát hiện nghiệp vụ/UX có bằng chứng, cộng các khoảng trống đồng bộ thiết kế/responsive/i18n. Auto-fix: 0 vì yêu cầu hiện tại là review. Những lựa chọn cần chốt trước khi triển khai: ưu tiên bán quầy hay phục vụ nhiều bàn; phạm vi Android; trường giao hàng và tùy chọn món quán thực sự dùng.
