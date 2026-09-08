# Kế hoạch hoàn thiện POS nhà hàng — Windows / Android

Ngày: 08/09/2026. Trạng thái: **đã vá phần giỏ/cân ở chặng 1; đã nối kho đơn local vào Windows ở chặng 2; chưa nghiệm thu toàn bộ kế hoạch**.

Checkout: `C:/Users/maxis/enail/POS-zira-release-foundation`, nhánh `codex/pos-ui-release-foundation`.

Đầu vào: `docs/reviews/restaurant-pos-cross-platform-review-2026-09-08.md` (R1–R10). Các sửa đổi chưa commit trong checkout phải được giữ nguyên. Kế hoạch không cấp quyền triển khai, thay tài khoản, tạo đơn thật hoặc sửa database production.

## 1. Mục tiêu và phạm vi

- **What:** sửa các lỗi đã xác nhận; hoàn thiện đơn theo bàn; thống nhất dữ liệu và hành vi Windows/Android; hoàn thiện thiết kế các màn trong luồng nhà hàng.
- **Why:** nhân viên phải gọi đúng món, giữ đúng ghi chú, không mất đơn khi đổi bàn/khởi động lại, không thanh toán hoặc gửi bếp trùng.
- **Who:** nhân viên nhận món, thu ngân, quản lý/chủ quán; không thay đổi quyền mặc định của salon nail, retail hoặc bi-a.
- **Where:** React renderer dùng chung, Electron main/preload, Android shim/local database/transport; backend Zira là phạm vi phối hợp riêng khi cần hợp đồng API mới.
- **Scope:** sửa lỗi + hoàn thiện chức năng đã có. Các tính năng bổ sung như tùy chọn món nâng cao, ghép bàn và chia theo người được tách thành đợt riêng, không trộn vào bản vá an toàn đầu tiên.

Thành công không phải chỉ là build xanh hoặc cùng CSS. Cần cùng quy tắc nghiệp vụ, dữ liệu đi đủ một vòng, UI không bị che nút và được thử trên Windows + Android thật.

### Giả định và quyết định cần chốt

1. Quán không quản lý bàn tiếp tục dùng bán tại quầy; lỗi tải bàn **không** được hiểu là quán không có bàn.
2. Giữ hướng thiết kế tối theo ảnh mẫu: danh mục trái, món ở giữa, đơn phải; bố cục co giãn theo kích thước vùng hiển thị, không bắt hai màn khác kích thước có cùng số cột.
3. **Người dùng đã chốt 08/09/2026:** Android là một máy POS riêng, bán độc lập.
   - Mỗi thiết bị quản lý giỏ, ca và đơn/bàn đang mở của mình; không chuyển hoặc cùng sửa một check giữa Android và Windows.
   - Dùng chung quy tắc nghiệp vụ/giao diện, không dùng chung một giỏ đang bán. Trạng thái occupied/active check phải thuộc phạm vi thiết bị, không ghi đè đơn máy khác.
   - Catalog/tài khoản và đồng bộ đơn đã trả vẫn theo backend của salon và hợp đồng đã xác minh; bán độc lập không có nghĩa bỏ backend hoặc tự tạo database server mới.
   - Loại khỏi đợt này: nhận món Android → thu ngân Windows, xung đột cùng check giữa hai máy và realtime chia sẻ check. Chặng 2–4 không còn chờ quyết định mô hình thiết bị; contract metadata/backend và kiểm thử vẫn bắt buộc.
4. Chưa xác định máy Android, kích thước, phiên bản WebView và bản APK đang cài. Chặng nghiệm thu sẽ ghi nhận cụ thể.
5. Chưa xác minh entity/DTO/API thực tế của backend trong lượt lập plan. Không coi tên trường hay endpoint đề xuất là API đã tồn tại.

## 2. Kiến trúc đề xuất

### 2.1 Dùng chung quy tắc; tách phần giao tiếp nền tảng

```text
Chạm món / quét mã / nhận đơn
             |
             v
Kiểm tra context + cấu hình món + số lượng + khóa thanh toán
             |
             v
       Quy tắc POS dùng chung
       /                     \
Windows adapter          Android adapter
Electron + local DB      shim + local DB + API
       \                     /
        Hợp đồng backend đã xác minh
```

- Tách/reuse phần quy tắc thuần cần thiết: nhận diện dòng món, kiểm tra đổi bàn/loại phục vụ, ngữ cảnh restaurant. Không viết lại toàn bộ reducer, sync engine hoặc payment engine.
- Đồng nhất kết quả thao tác, dự kiến dạng `{ success, error?, code? }`; không coi `undefined` là đã lưu thành công. Giữ tương thích với các consumer hiện có.
- Chặn thao tác ở cả UI và lớp có thẩm quyền. Kiểm tra lại context sau thao tác bất đồng bộ như đọc cân/tìm barcode, tránh kết quả cũ được thêm sang bàn hoặc salon mới.
- Hỗ trợ qua capability rõ ràng. API bàn chưa có phải trả “không hỗ trợ/không khả dụng”, không trả `[]` giả như một lần tải thành công.

### 2.2 Đơn đang mở khác hóa đơn đã thanh toán

Mô hình khái niệm đề xuất, tên trường cuối cùng chốt khi kiểm tra backend:

| Đối tượng | Nội dung chính | Quy tắc |
|---|---|---|
| Restaurant check | ID ổn định, salon, bàn hoặc bán quầy, loại phục vụ, nhân viên, số khách, phiên bản, trạng thái | Chỉ chuyển bàn khi lưu thành công; không tự biến thành PAID |
| Dòng món | ID dòng ổn định, variant, số lượng/đơn vị, giá, ghi chú, course; modifiers khi được hỗ trợ | Không gộp khác yêu cầu; dòng đã gửi bếp không bị âm thầm gộp với món mới |
| Ngữ cảnh thực hiện | Khách nhận/giao hàng và thời gian, phí khi chức năng được bật | Phải có kiểm tra và lưu/đồng bộ, không chỉ thêm ô nhập |
| Payment attempt | Check/order ID, định danh lần thu, trạng thái kết quả | Dùng lại bảo vệ idempotency/journal; trạng thái chưa rõ không cho thu lại |
| Table | ID, khu vực, sức chứa, trạng thái và liên kết check đang mở | Chọn/xem bàn không tự tạo occupied; reserved không đồng nghĩa có hóa đơn |

Không đưa đơn đang mở vào đường tạo đơn PAID hiện tại để “tận dụng sync”, vì có thể kích hoạt thanh toán, trừ kho hoặc in quá sớm.

### 2.3 Tái sử dụng có điều kiện

- `capturePosCheckoutSnapshot` đã chụp cả state và scope salon/user/register: tái sử dụng mẫu snapshot, kiểm tra scope và rào chắn lưu xuống đĩa.
- `HoldOrderRepo` và luồng Hold hiện có bảo vệ khôi phục, nhưng `prune(limit=20)` tự xóa đơn thường cũ; `pos:hold:create-current` đang gọi prune. **Không dùng nguyên xi làm kho hóa đơn mở nhà hàng.**
- Snapshot Hold hiện gắn người dùng/quầy; không nới lỏng kiểm tra scope để cho Android gọi lại đơn Windows. Chuyển quyền xử lý cần hợp đồng nghiệp vụ riêng.
- `HoldOrdersModal` có thể tái sử dụng thành phần hiển thị/lọc; danh sách đơn nhà hàng phải có trạng thái, lưu lỗi và phân quyền hủy phù hợp, không đơn thuần là danh sách xóa Hold.
- Dùng lại xử lý bán theo cân trong `retail-sale-flow.ts`; không sao chép giao tiếp cân thành một bản thứ ba.
- Dùng lại Modal với focus trap/busy/guard; chỉ thêm hỗ trợ theme có phạm vi nếu cần, giữ nguyên mặc định của các mode khác.

### 2.4 Lựa chọn và đánh đổi

| Quyết định | Phương án không chọn | Đề xuất và lý do |
|---|---|---|
| Quy tắc hai nền tảng | Tiếp tục copy reducer rồi sửa riêng | Dùng chung helper/contract thuần cần thiết + test chung, giảm lệch mà không refactor toàn app |
| Kho đơn mở | Nối thẳng generic Hold có prune | Lifecycle restaurant không bị dọn theo số lượng; reuse persistence safeguards thay vì reuse mù quáng |
| Metadata backend | Gửi thêm trường ngay, giả định server nhận | Xác minh whitelist/DTO/lưu/trả trước rồi mới nối client |
| Ghi chú/số khách nháp | Autosave không báo hoặc thanh toán bỏ qua nháp | Lưu có xác nhận; trước thanh toán/đổi đơn phải commit hoặc yêu cầu xử lý nháp rõ ràng |
| Theme | Đổi màu global toàn app hoặc viết lại mọi modal | Semantic token/theme chỉ cho restaurant, bao phủ cả dialog/portal liên quan |
| Chia sẻ đơn khi offline | Hai máy tự sửa cùng một đơn rồi ghi đè sau | Đề xuất giữ bản nháp cục bộ và trạng thái chờ; không cho tranh quyền thu hoặc xác nhận gửi bếp khi chưa có đảm bảo từ server |

## 3. Các chặng triển khai và tiêu chí qua cổng

### Chặng 0 — Khóa đầu vào và bảo vệ baseline

- [ ] Xác nhận checkout/nhánh, lưu danh sách thay đổi hiện tại; không reset hoặc ghi đè sửa đổi của người dùng.
- [ ] Ghi lại build/version và ảnh các màn trước sửa, cấu hình mode của salon thử nghiệm; không ghi token/mật khẩu vào tài liệu.
- [x] Chốt vai trò Android: máy POS bán độc lập.
- [ ] Thu thập thiết bị/kích thước mục tiêu trước chặng 4/6.
- [ ] Lập test fixture quán có bàn/không bàn, món cân/không cân, đơn có ghi chú/course, trạng thái mạng và ca.
- [ ] Kiểm tra hợp đồng backend bằng truy cập chỉ đọc ở đúng checkout/server được cho phép; nếu cần thay đổi ngoài repo, dùng yêu cầu phối hợp đi kèm.

**Qua cổng:** có baseline kiểm thử tái lập, dữ liệu test tách khỏi quán thật; quyết định liên thiết bị được ghi rõ là đã chốt hoặc còn chờ. Có thể bắt đầu chặng 1 khi nhánh backend vẫn chờ.

### Chặng 1 — Vá lỗi bán hàng hiện tại (R3, R4, R7, R8, R9, R10)

- [x] Viết regression test tái hiện lỗi gộp dòng trước khi sửa (16 fail, 8 pass trên logic cũ); bổ sung test các rào chắn UI.
- [x] Gộp dòng chỉ khi các thuộc tính bán tương đương: variant, giá/VAT/đơn vị, nhân viên, course và ghi chú; chuẩn hóa null/rỗng/trim. Dòng có giảm giá/khóa/bi-a giữ riêng để bảo toàn phân bổ. Modifiers chưa được hỗ trợ.
- [ ] Cho chạm món/barcode qua cùng cửa kiểm tra context; không thêm món chưa chọn bàn khi quán yêu cầu bàn. Bảo vệ cả lúc thanh toán hoặc lookup/cân còn đang chờ.
- [x] Món cân nhận số lượng hợp lệ từ cân hoặc hộp nhập thủ công dùng chung; không tự lấy 1 kg khi thiếu thiết bị/kết quả. Đã kiểm thử code/component; thiết bị cân thật chưa nghiệm thu.
- [x] Ghi chú và số khách: lưu có trạng thái pending/error, chặn thanh toán/đổi ngữ cảnh khi còn nháp; lỗi giữ nguyên dữ liệu. Chưa chứng minh độ bền khi crash hoặc timeout sau ghi.
- [x] Giữ vị trí cuộn khi sửa số lượng/xóa món; chỉ tự cuộn khi khởi tạo hoặc thêm dòng mới.

Tiến độ triển khai 08/09:

- Barcode sản phẩm thường được chuyển từ POSLayout sang handler nhà hàng, dùng cùng luồng thêm món/đọc cân; kiểm tra bàn/loại phục vụ và ca/nhân viên sau lookup. Main process có rào chắn thêm món theo bàn. Các mã đặc biệt pickup/kiosk vẫn đi đường riêng, chưa nghiệm thu toàn bộ đường nhập.
- Đọc cân qua resolver hiện có; cân tắt/lỗi/không ổn định/timeout chuyển sang nhập thủ công. Hộp nhập được tách từ POSLayout để dùng chung; chấp nhận dấu phẩy thập phân, >0 đến 999 kg, chính xác đến gram, không nhận chuỗi số có ký tự thừa. Resolver từ chối NaN/Infinity và độ chính xác không hợp lệ; lỗi kết nối được trả về để mở nhập tay.
- Thêm phiên thao tác để hủy kết quả cũ khi đổi bàn A → B → A, course hoặc ca/nhân viên. Không thay hộp cân đang nhập bằng scan mới, không mở thanh toán khi cân/nhập cân còn chờ; khóa submit/cancel khi đang thêm món, giữ dữ liệu khi dispatch báo lỗi.
- Hộp cân dùng Modal hiện có để quản lý focus/bàn phím và pending; nút ≥44px, theme tối chỉ áp dụng nhà hàng. Không thay đổi API server hoặc migration. Phạm vi lượt tiếp theo: tạo `ManualWeightModal.tsx`; sửa POSLayout, RestaurantTemplate, retail-sale-flow, CSS nhà hàng, các suite restaurant/retail-sale-flow/keyboard và tài liệu này. Theo design-reasoning, chọn reuse Modal/quy tắc số lượng thay cho dựng luồng cân mới; rủi ro hồi quy retail được kiểm tra bằng suite dùng chung.
- Bổ sung 3 thông báo bản nháp/số khách cho 7 ngôn ngữ; áp dụng design-reasoning bằng cách chia sẻ quy tắc nhận diện dòng, không viết lại payment engine.
- 128 test qua trong 9 suite liên quan; `npm run build`, renderer typecheck và Android source/web-build/bundle boundary gates qua. Có cảnh báo bundle lớn và Browserslist cũ. Test Cart thật kiểm tra lỗi/pending ghi chú và cuộn; suite restaurant vẫn mock một số component nên không thay cho E2E.
- Lượt tiếp theo: 161 test qua trong 14 suite, gồm Hold snapshot, giỏ, modal, restaurant và cân. Build Windows và Android web/boundary qua; chưa phải kiểm thử trên thiết bị thật.
- Chưa cài APK, chưa thử hardware/Windows fullscreen, chưa triển khai production; chặng 2–6 chưa hoàn tất. Android đã chốt bán độc lập; chưa bật restaurant Android khi adapter bàn/đơn còn thiếu. Cần xác minh backend cho metadata đơn đã trả, không phát triển chia sẻ check liên thiết bị trong đợt này.

**Qua cổng:** không gộp ly thường với ly không đường; barcode chưa chọn bàn không làm kẹt giỏ; 0,35 kg không thành 1 kg; nháp không mất; Windows/Android reducer chạy cùng bộ test liên quan; retail/salon/bi-a không bị hồi quy.

### Chặng 2 — Hoàn thiện đơn theo bàn và trường cơ bản (R2, R6, R9)

Thiết kế triển khai kho đơn local (08/09):

- **What/Why/Who:** lưu đơn nhà hàng đang mở cho nhân viên trên từng máy độc lập, giữ bản lưu cả sau recall để tránh mất khi restart.
- **Bằng chứng source:** `PosStore.dispatch` hiện cập nhật RAM/broadcast; `pos:hold:recall` xóa Hold rồi flush database. Không coi flush đó là đã lưu giỏ RAM. Vì vậy không nối UI nhà hàng vào generic Hold.
- **Data/API:** bảng local riêng `pos_restaurant_checks`, ID ổn định, scope salon/user/register, revision, snapshot, table/covers, trạng thái SAVED/OPEN/PAYMENT_PENDING/PAYMENT_UNCERTAIN/PAID/CANCELLED. Chưa thêm HTTP/IPC. Giao dịch tiền thật vẫn thuộc payment engine hiện có; kho này không tự thu tiền hoặc trừ kho.
- **Trade-off:** reuse Hold tiết kiệm code nhưng cần thay đổi ngữ nghĩa xóa/prune và có thể ảnh hưởng bi-a. Chọn kho riêng, dùng lại SQLite transaction/durability barrier; contract và repository không phụ thuộc Electron để adapter Android có thể dùng sau.
- **Scope:** mọi đọc/ghi cần đủ salon/user/register; một bàn chỉ có một đơn chưa kết thúc trên cùng máy, nhưng hai máy độc lập không khóa bàn nhau. Không nới quyền truy cập đơn của nhân viên khác. Repository không thay thế kiểm tra quyền ở IPC.
- **Files:** tạo `src/shared/restaurant-check.ts`, `src/shared/restaurant-check-store.ts`, `tests/restaurant-check-store.test.ts`; sửa `src/main/database/migrations.ts` bằng migration additive 67. Không thay dữ liệu/backend production, không bật UI trước khi nối thanh toán và khôi phục an toàn.
- **Risk:** revision chặn stale write; snapshot sai scope/mode hoặc dòng bi-a bị từ chối; payment pending/uncertain không được sửa/hủy/thu lại; không prune đơn chưa kết thúc. Lỗi flush khóa instance cho tới reload thay vì báo thành công hoặc retry mù quáng.
- **Order:** contract/schema → kho lưu + test SQL/reopen/fault-injection → adapter main và thanh toán → UI Checks → Android adapter. Phức tạp kho lưu vừa, tích hợp payment cao. Migration chỉ thêm bảng/index, chưa có chuyển đổi dữ liệu Hold cũ tự động.

Tiến độ kho local:

- [x] Contract/repository dùng chung không import Electron; migration 67 thêm bảng/index, giữ nguyên đơn/Hold cũ.
- [x] Test SQLite: giữ bản khi mở, A → lưu → B → lưu → A, 21/50/100 đơn và export/reopen; ID/revision ổn định, notes/course/covers/tip giữ nguyên.
- [x] Test scope salon/user/register, hai máy độc lập cùng nhãn bàn, một bàn không có hai đơn mở trên cùng máy; stale/concurrent write bị chặn.
- [x] Test payment pending/uncertain khóa sửa/hủy/thu lại; chỉ xác nhận đúng order identity; giữ dữ liệu hủy và lý do. Đây là quy tắc kho dữ liệu, chưa phải tích hợp giao dịch tiền thật.
- [x] Test flush chậm/thất bại/throw: không trả thành công sớm; khóa instance sau lỗi, reload từ bản SQLite đã xác nhận. Chưa thử mất điện/ổ đĩa thật.
- [ ] Nối adapter Windows: singleton/bind auth scope và quyền, giữ dữ liệu qua logout/salon switch, flush `database.saveCoalesced`, snapshot active, đồng bộ với payment journal/confirmed order và hoàn trả tiền không thành công đã được xác minh.
- [ ] Nối UI lưu/mở Checks và Android adapter. **Chưa bật luồng lưu/mở mới trên ứng dụng**, không gọi API repository từ renderer và không coi dữ liệu đang chờ thanh toán là đã trả.

Kiểm tra lượt kho local: 199 test qua trong 16 suite (28 test kho mới); kiểm tra boundary trực tiếp entry kho mới qua, 4 source file không phụ thuộc nền tảng. Full build Windows qua trước bước bổ sung validation cuối; build main được chạy lại sau validation. Graph generation vẫn `2026-09-08T00:04:44Z`, metadata changed/new files not tracked nên dùng source và test trực tiếp cho các kết luận trên.

Phụ thuộc: chặng 1; quyết định mô hình đơn từ chặng 0. Nếu dùng chung liên thiết bị, phải cùng hợp đồng server ở chặng 3 trước khi phát hành.

- [ ] Phân biệt rõ xem bàn, mở đơn, lưu đơn, mở lại, đổi sang đơn khác, chuyển bàn cho cùng đơn, hủy và thanh toán.
- [ ] Lưu thành công/đủ bền vững mới cho thay giỏ. Lưu thất bại không xóa giỏ hoặc giải phóng bàn.
- [ ] Danh sách Checks thật: ID đơn, bàn/kiểu phục vụ, nhân viên, số khách, thời gian, tổng tiền và trạng thái.
- [ ] Đơn chưa trả tiền không bị prune kể cả trên 20/50/100 đơn; khởi động lại vẫn gọi đúng đơn. Không đụng các journal Hold được bảo vệ của bi-a.
- [ ] occupied/openedAt chỉ theo vòng đời đơn thực; reserved có nhãn riêng; giải phóng sau kết quả thanh toán/hủy đã xác nhận, không theo việc đóng modal.
- [ ] Bán quầy không bàn vẫn mở giỏ trực tiếp; mang đi/giao hàng không bắt chọn bàn.
- [ ] Ngữ cảnh cơ bản: số khách, ghi chú đơn/dòng, course, nhân viên; nhập tip theo quyền và quy tắc tổng tiền hiện có.
- [ ] Mang đi: tên/mã nhận và giờ nhận nếu quán dùng. Giao hàng: tên, điện thoại, địa chỉ, giờ, hướng dẫn; phí giao chỉ bật khi có quy tắc giá/thuế và contract đã xác nhận.

**Qua cổng:** bàn A → lưu → bàn B → quay A không mất món/ghi chú; hơn 20 đơn không mất; restart khôi phục; hủy có xác nhận/quyền; quán không bàn vẫn bán như cũ. Không hiện tính năng giao hàng “hoàn chỉnh” khi mới có nhãn delivery.

### Chặng 3 — Hợp đồng backend và đồng bộ đúng ngữ cảnh (R5)

- [ ] Xác minh endpoint/DTO hiện có cho bàn, check đang mở, order đã trả, pickup/kitchen và sự kiện realtime. Không tự đặt endpoint rồi thêm client workaround.
- [ ] Xác nhận map ghi/đọc: bàn, số khách, loại phục vụ, course, notes, tip, dữ liệu mang đi/giao hàng và modifiers khi bật.
- [ ] Nếu dùng chung thiết bị: version/conflict, quyền sửa/nhận xử lý đơn, thao tác có idempotency, settle đơn đúng một lần; reconnect phải lấy bản chuẩn rồi mới sửa tiếp.
- [ ] Nếu mỗi máy độc lập: ghi rõ phạm vi local; vẫn round-trip metadata đơn đã trả qua backend.
- [ ] Backend tính/kiểm tra tiền và quyền theo salon; không tin giá/phí/tip/modifier gửi từ client nếu chưa kiểm tra.
- [ ] Gửi bếp và in: phân biệt chưa gửi/đã gửi/kết quả chưa rõ, định danh job/dòng; không in lại toàn bộ khi chỉ gọi thêm một món. Không làm thay đổi thời điểm trừ kho khi chỉ thêm tính năng gửi bếp.
- [ ] Test cả đường order sync và sync-log trên Windows, Android transport, và dữ liệu đọc lại từ server.

**Qua cổng:** round-trip không rơi metadata; salon A không truy cập B; retry không tạo đơn/thu tiền/gửi bếp trùng; conflict không ghi đè âm thầm. Nếu cần backend ngoài repo, dừng phần client phụ thuộc cho tới khi có contract được xác nhận.

### Chặng 4 — Android hỗ trợ nhà hàng thật (R1)

- [ ] Mode resolution không chuyển restaurant sang salon khi backend/device đủ capability; lưu lựa chọn theo đúng salon.
- [ ] Đồng nhất dispatch result, context state và kiểm tra giỏ với Windows. Không import Electron/Node main vào Android.
- [ ] Thay stub bàn/đơn/pickup được đưa vào phạm vi bằng adapter thực. Unsupported, offline, error và empty là các trạng thái khác nhau.
- [ ] Lưu/khôi phục local đúng scope; kiểm tra logout/login đổi salon không giữ bàn hoặc giỏ của tenant cũ.
- [ ] Nối cân/máy in theo capability thực: không có thiết bị phải có hướng dẫn/đường nhập phù hợp, không báo thành công giả.
- [ ] Sửa chiều cao shell, safe area, bàn phím và nút Back; không mất nút thanh toán khi có thanh tab POS/Bi-a.
- [ ] Build web, kiểm tra boundary, sync native, build APK test; ghi version và checksum trước khi so sánh.

**Qua cổng:** cùng dữ liệu fixture cho kết quả nghiệp vụ tương đương Windows; mode đúng sau restart/login; APK chạy trên thiết bị thật. Build web xanh không thay thế nghiệm thu này.

### Chặng 5 — Đồng bộ thiết kế toàn luồng nhà hàng

Có thể chuẩn bị token và danh sách màn độc lập; UI liên quan check/trường mới phải bám contract chặng 2–3.

- [ ] Giữ palette restaurant hiện có làm baseline, xác định token cho nền/chữ/border/trạng thái/hành động; không phủ màu global lên salon/retail.
- [ ] Phủ đủ: POS/menu, bàn, Checks, chi tiết đơn, ghi chú/cấu hình món, số khách, lưu/chuyển/hủy, thanh toán/thành công/thất bại, ca, lịch sử/hoàn/in lại, pickup và lỗi mạng.
- [ ] Dialog/portal phải nhận theme có chủ đích; nút phá hủy, lỗi và nút chính giữ ý nghĩa màu, không bị hover rule chung ghi đè.
- [ ] Mọi màn có loading/empty/error/retry/pending/success cần thiết; nút không khả dụng có lý do, không chỉ im lặng bỏ click.
- [ ] Mục tiêu nút chạm ≥44px, focus rõ, trạng thái bàn có chữ, dịch toàn bộ nội dung và aria bằng hệ thống i18n hiện có của Electron renderer.
- [ ] Số cột theo chiều rộng menu, chữ/tên dài không chèn giỏ; ảnh catalog thật, không đổi thành ảnh món không đúng hàng bán.
- [ ] Ở màn hẹp/portrait, dùng vùng giỏ co giãn hoặc drawer phù hợp nhưng tổng tiền và hành động thanh toán luôn tiếp cận được; chốt sau thử trên thiết bị.

**Qua cổng:** ảnh chụp từng màn có dữ liệu giống nhau ở cùng viewport khớp hệ thống thiết kế; không còn modal sáng lạc theme hoặc chữ chìm; các mode khác giữ nguyên thiết kế.

### Chặng 6 — Kiểm thử tích hợp, pilot và phát hành có kiểm soát

- [ ] Test component thật, chỉ mock biên IO cần thiết; không thay toàn bộ Cart/Payment/TableMap như regression suite hiện tại.
- [ ] Chạy các gate phù hợp: renderer typecheck, main/renderer build, Vitest liên quan và regression thanh toán/hold/salon-switch; Android boundary/build/native gates theo scripts hiện có.
- [ ] Kiểm thử Windows fullscreen 1920×1080, 1366×768, màn rộng; Android tablet 1280×800/1024×600 nếu thiết bị hỗ trợ; portrait, scale 125%/150%, bàn phím mở. Đây là ma trận mục tiêu, sẽ ghi kích thước thực.
- [ ] Luồng thật trên salon test: mở ca → bàn A/B → ghi chú/course → lưu/restart → gọi thêm/gửi bếp → thanh toán → lịch sử; tương tự không bàn/mang đi/giao hàng.
- [ ] Hai máy độc lập: giỏ/check/ca không ảnh hưởng nhau; cả hai đồng bộ đơn đã trả đúng salon, giữ định danh thiết bị/đơn và không tạo trùng khi retry.
- [ ] Thử timeout sau lưu, mất mạng trước/sau thanh toán, crash sau trả tiền trước giải phóng bàn, lỗi in và gửi lại. Kết quả chưa rõ phải yêu cầu đối soát, không thu lại tự động.
- [ ] Hardware: cân, barcode, máy in bill/bếp và thiết bị thanh toán trên môi trường test; không tạo chứng từ thật ở production để thử.
- [ ] Pilot giới hạn trên salon test, giữ bộ cài trước đó, ghi known limitations. Chỉ phát hành production sau xác nhận riêng của người dùng.

**Qua cổng:** mọi lỗi mức chặn vận hành đã đóng bằng test + bằng chứng; không mất dữ liệu, thu trùng, gửi bếp trùng, rò tenant hoặc UI không tiếp cận được nút chính. Thiếu thiết bị/quyền backend là blocker được báo rõ, không đánh dấu nghiệm thu giả.

## 4. Đợt bổ sung sau bản lõi

Được đưa vào backlog để không quên, chưa trộn vào chặng vá lỗi:

- Modifiers có nhóm bắt buộc/min/max, lựa chọn đường/đá/topping/độ chín, phụ thu, hết hàng theo lựa chọn; dữ liệu cấu hình lấy từ backend, không hardcode theo ảnh menu.
- Ghép bàn, chuyển toàn bộ đơn sang bàn khác, tách hóa đơn theo món/người; giữ đối chiếu tiền/thuế/lịch sử và không sửa đơn đã fiskal hóa.
- Quy trình bếp đầy đủ theo course: gửi, gọi tiếp, bổ sung, hủy sau gửi có dấu vết; không chỉ lưu số course rồi coi là đã điều phối bếp.

Chốt nhu cầu thực tế quán trước từng hạng mục; nếu chưa hỗ trợ, UI phải thể hiện đúng phạm vi thay vì hiển thị nút giả.

## 5. Bản đồ file dự kiến

Đường dẫn dưới đây tương đối với checkout nêu đầu tài liệu. Đây là phạm vi có thể ảnh hưởng, **không phải yêu cầu sửa tất cả**; đọc lại source/coverage trước khi triển khai từng chặng.

| Nhóm | MODIFY / reuse hiện có |
|---|---|
| Context/giỏ/loại món | `src/shared/pos-mode.ts`, `src/shared/types.ts`, `src/main/pos/pos-store.ts`, `src/renderer/hooks/usePosStore.ts`, `src/renderer/components/pos/retail-sale-flow.ts` |
| Giao diện bán | `src/renderer/components/pos/POSLayout.tsx`, `Cart.tsx`, `CartItem.tsx`, `ProductCard.tsx`, `PaymentModal.tsx` |
| Nhà hàng | `src/renderer/components/pos/templates/restaurant/RestaurantTemplate.tsx`, `RestaurantMenu.tsx`, `TableMap.tsx`, `DiningOptions.tsx`, `CourseSelector.tsx`, `restaurant-pos.css` |
| Lưu/khôi phục | `src/main/modules/pos.module.ts`, `src/main/database/repos/hold-repo.ts`, `table-repo.ts`, `order-repo.ts`, `src/main/pos/billiard-pos-handoff.ts`, `src/shared/billiard-pos-handoff.ts` — bảo toàn scope/journal protected |
| Cầu Windows | `src/preload/preload-pos.ts`, `src/preload/preload.ts`, `src/shared/electron.d.ts` |
| Đồng bộ | `src/main/sync/order-sync.ts`, `src/main/pos/order-line-contract.ts`, sync-log mapping trong `src/main/modules/pos.module.ts` |
| Android | `src/renderer/android-pos/main.ts`, `AndroidBootApp.tsx`, `shim/config-store.ts`, `shim/index.ts`, `shim/pos-store.ts`, `shim/stubs.ts`, `shim/real-transport.ts`, `shim/db/order-repo.ts` |
| Màn liên quan | `src/renderer/components/pos/HoldOrdersModal.tsx`, `ShiftModal.tsx`, `OrderHistoryModal.tsx`, `src/renderer/components/shared/Modal.tsx`, `src/renderer/i18n/translations.ts` |
| Regression hiện có | `tests/pos-store.test.ts`, `pos-mode.test.ts`, `restaurant-counter-sales.test.tsx`, `android-salon.test.ts`, `pos-template-catalog-refresh.test.ts`; bổ sung suites thanh toán/hold hiện có khi chỉnh biên đó |

CREATE dự kiến, chỉ khi thật sự cần sau chốt contract:

- `src/shared/restaurant-check.ts`: contract/quy tắc check thuần dùng chung, không phụ thuộc Electron.
- Module/repository restaurant check riêng nếu generic Hold không thể mở rộng an toàn; tên/path chốt sau khảo sát persistence và API, không tự dựng mô hình server trong frontend.
- `tests/restaurant-cart-safety.test.tsx`, `tests/restaurant-check-lifecycle.test.ts`, `tests/restaurant-order-metadata.test.ts`, `tests/android-restaurant-parity.test.ts`, `tests/restaurant-theme.test.tsx` (tên đề xuất).
- E2E fixture/snapshot cho component thật và artifact ảnh Windows/Android; theo cấu trúc test hiện có khi triển khai.

MIGRATE:

- Chặng 1 dự kiến không cần migration.
- Check metadata/persistence: thêm trường optional/version hoặc bảng mới theo framework migration local hiện có; đọc được dữ liệu cũ, backup trước, không sửa schema bằng lệnh SQL ad-hoc.
- Backend: chỉ thiết kế migration sau kiểm tra entity thật; yêu cầu additive/backward-compatible, không drop/rename phá dữ liệu. Chưa có tên migration hoặc số file server chắc chắn.

## 6. Ma trận kiểm thử bắt buộc

| ID | Tình huống | Kết quả phải đạt |
|---|---|---|
| T01 | 2 món cùng variant nhưng khác ghi chú/course/giá | Không gộp sai; trường hợp giống hệt vẫn xử lý đúng |
| T02 | Scan chưa chọn bàn; lookup trả về sau đổi context | Không kẹt giỏ, không thêm sang bàn/salon mới |
| T03 | Cân lỗi/không ổn định/0,35 kg | Không mặc định 1 kg; số tiền đúng quy tắc đơn vị |
| T04 | Ghi chú/số khách đang nháp rồi Pay/đổi đơn | Lưu hoặc hỏi rõ; lỗi giữ nguyên dữ liệu |
| T05 | A → lưu → B → A; restart; 21/50/100 check | Mở đúng đơn, không prune mất |
| T06 | Chỉ xem/chọn bàn, hủy đơn rỗng, reserved | Không tạo occupied giả; trạng thái có chữ |
| T07 | Quán không bàn; table API lỗi | Bán trực tiếp khi thật sự không bàn; lỗi không giả empty |
| T08 | Sync và đọc lại Windows/Android | Đủ table/covers/type/notes/course/tip/trường đã bật |
| T09 | Hai máy bán độc lập, sync/retry/timeout | Không lẫn giỏ/check/ca; không nhân đôi đơn hoặc thu tiền khi retry |
| T10 | Gửi bếp rồi gọi thêm, timeout in, Pay | Không tự in lại món đã gửi; uncertain có đối soát |
| T11 | Logout/login đổi salon và đổi nhân viên | Không rò đơn/bàn; quyền chuyển người được kiểm tra |
| T12 | Fullscreen/portrait/bàn phím/modal nested | Không che Pay, focus đúng, mọi trạng thái đọc rõ |
| T13 | Retail/salon/bi-a, split tender, refund, Hold protected | Không hồi quy ngoài nhà hàng |

Baseline lượt review trước: 75 test liên quan qua; Android web build qua; chưa phải native/real-device acceptance. Không chạy lại chỉ để lập kế hoạch này.

## 7. Rủi ro, migration và rollback

| Rủi ro | Mức | Biện pháp |
|---|---|---|
| Mất đơn khi lưu, prune, restart | Cao | Durable barrier, không dọn check mở, fault-injection và test >20 đơn |
| Thu tiền/trừ kho/gửi bếp trùng | Cao | Giữ payment journal/idempotency, tách open check khỏi paid order, kiểm tra trạng thái bất định |
| Hai thiết bị ghi đè hoặc khác salon | Cao | Server scope + quyền, version/conflict; không bỏ kiểm tra scope snapshot |
| API backend không nhận trường mới | Cao | Contract gate và round-trip trước khi mở UI |
| Đổi shared CSS làm hỏng mode khác | Vừa | Theme có phạm vi và snapshot regression các mode |
| App cũ đọc dữ liệu check mới | Cao | Versioning/capabilities, migration additive; không downgrade mù quáng khi còn giao dịch mở |
| Android thiếu hardware/API nhưng báo thành công | Cao | Capability/error rõ, test adapter thật |

Rollback đề xuất: tắt phần tính năng mới nếu gặp sự cố, giữ dữ liệu/journal, dừng nhận giao dịch mới bị ảnh hưởng và đối soát giao dịch đang dở. Chỉ dùng bộ cài trước khi đã kiểm tra tương thích schema và không bỏ rơi check/attempt mới. Không rollback bằng cách xóa database hoặc restore đè mất giao dịch.

Build/test ngoài production. Với thay đổi backend: build/kiểm tra ở máy phát triển, Contabo chỉ nhận artifact đã xác minh theo quy trình dự án; không chạy thử nghiệm/build ad-hoc trên Contabo. Cập nhật POS quầy và restart app live cần thời điểm/cho phép riêng.

## 8. Phụ thuộc và gói công việc đầu tiên

```text
0. Baseline + chốt vai trò Android + xác minh contract
               |
1. Vá an toàn giỏ / barcode / ghi chú / cân
               |
2. Đơn theo bàn <----> 3. Backend / dữ liệu / bếp
               \      /
              4. Android

5. Theme toàn luồng (bám contract của 2–3)
               |
6. E2E Windows + Android → pilot → duyệt phát hành
```

**Gói đầu tiên sẵn sàng khi được yêu cầu triển khai:** test R4 gộp ghi chú → sửa shared line identity hẹp → test R3 barcode/context → sửa cửa thêm món → regression quán không bàn, retail/salon. Sau đó xử lý cân và bản nháp. Chưa cần thay backend hoặc đăng nhập tài khoản quán thật để làm gói này.

Độ phức tạp: vá lỗi cục bộ vừa; lifecycle nhiều bàn cao; backend liên thiết bị cao và phụ thuộc contract; giao diện vừa; Android cao vì adapter/native/thiết bị. Không ấn định số giờ hoặc tổng file server khi chưa khảo sát backend và chưa chốt mô hình thiết bị.

## 9. Cập nhật triển khai: nối đơn local vào Windows

Thiết kế theo `design-reasoning`: nhân viên lưu/mở lại đơn trên chính máy và tài khoản đang đăng nhập; không thay HTTP/backend, không chia sẻ đơn mở sang Android. Controller main lấy snapshot/scope tin cậy, ghi bền trước khi xóa giỏ, lưu tiếp mọi sửa đổi của đơn đã mở. Trạng thái thanh toán khóa trước tạo hóa đơn, chỉ đối chiếu order COMPLETED trong kho local mới kết thúc check.

Lựa chọn: giữ bản lưu khi mở, không dùng recall của generic Hold vốn xóa bản lưu. Đổi lại, cần Save check trước khi đổi bàn/ngữ cảnh; xóa dòng cuối của check đang mở bị từ chối vì chưa có màn hủy có phân quyền. Draft chưa từng bấm Save vẫn chỉ nằm trong RAM. Không được quảng bá là mọi giỏ đều chống mất điện.

File impact của đợt nối:

- CREATE `src/main/pos/restaurant-check-controller.ts`, `tests/restaurant-check-controller.test.ts`: điều phối state/main, scope, disk barrier, payment/recovery; test dùng reducer và SQL.js thật.
- MODIFY `src/main/modules/pos.module.ts`: IPC list/save/open/begin-payment, chặn ghi đè từ Hold/bi-a, tự lưu chỉnh sửa, đối chiếu và hoàn tất paid check.
- MODIFY `src/preload/preload.ts`, `src/preload/preload-pos.ts`, `src/shared/electron.d.ts`: capability restaurantChecks optional; không giả adapter Android.
- MODIFY `RestaurantTemplate.tsx`, `restaurant-pos.css`: danh sách đơn, lưu/mở lại, trạng thái và lỗi; chọn bàn không tự đánh occupied khi có capability mới.
- MODIFY `PaymentModal.tsx`: chờ durable boundary trước tạo đơn, không retry khi phản hồi bất định; luồng khác không có callback giữ nguyên.
- MODIFY `src/renderer/i18n/translations.ts`: nhãn đơn và hướng dẫn đối soát trong 7 ngôn ngữ.
- MODIFY `tests/restaurant-counter-sales.test.tsx`, `tests/payment-modal-close-behavior.test.tsx`: hành vi API mới, lưu lỗi/chờ, lỗi tải danh sách, chống tạo đơn trước acknowledgment.
- MIGRATE: dùng migration 67 đã thêm ở đợt kho local; không thêm migration/endpoint server trong đợt nối.

Giới hạn và rủi ro còn mở: chưa có hủy check có phân quyền, chưa có owner-resolution cho pending không có order, chưa E2E IPC/hardware/fiscal/split-tender hoặc khởi động lại app thật. Pending không có bằng chứng thanh toán vẫn khóa, không tự đoán thất bại rồi cho thu lại. Android restaurant chưa bật; cần adapter độc lập và native QA. Không triển khai production, không cài APK hoặc tạo giao dịch thật.

Kiểm chứng đợt nối: 274 test qua trong 18 suite liên quan; full Windows build và Android source/web-build/bundle boundary qua. Sau bổ sung guard đóng ca, validation danh sách và kiểm tra payload thanh toán khớp: full Windows build chạy lại qua, 47 test trong 3 suite bị ảnh hưởng chạy lại qua. Build cảnh báo bundle lớn/Browserslist cũ và sql.js browser externals; không thay dependencies trong đợt này. Graph Tier 2 vẫn stale so với source mới; dùng coverage + đọc trực tiếp, không khẳng định audit toàn bộ hệ thống.

### Chỉnh giao diện theo ảnh mẫu và sửa lỗi CSS cascade

Yêu cầu 08/09: nền xanh đen, danh mục trái, menu ảnh + dải màu nhóm ở giữa, giỏ tối bên phải. Giữ ảnh catalog và giá thật, giữ Zira branding; không sửa luồng bán/payment/tenant. Lỗi tái hiện: utility `bg-white` và `p-1.5` nạp sau theme ghi đè thẻ, còn chữ sáng vẫn thắng.

Phương án: tách các utility trình bày mặc định khỏi variant restaurant trong ProductCard, giữ handler/stock/image dùng chung; theme có selector riêng và fallback màu. Không dùng `!important` toàn app hoặc thay ảnh hàng hóa bằng ảnh món ăn mẫu. Giữ giá trên thẻ dù ảnh tham khảo không thấy rõ giá, vì POS cần kiểm tra giá trước khi thêm.

Impact: MODIFY `src/renderer/components/pos/ProductCard.tsx` và `src/renderer/components/pos/templates/restaurant/restaurant-pos.css`; CREATE `tests/restaurant-theme.browser.test.tsx` kiểm tra component thật với cả hai thứ tự CSS, bản CSS build, tương phản và kích thước fullscreen. MODIFY tài liệu kế hoạch này. Không API/schema/migration/i18n mới. Phạm vi nhỏ, không cài dependency.

Kiểm chứng: tái hiện test đỏ trước sửa; sau sửa test browser với ảnh fixture và kiểm tra retail vẫn nền trắng/chữ tối; build Windows + test thao tác sản phẩm/giỏ. Screenshot fixture không thay cho nghiệm thu native/hardware hoặc database thật. Chưa restart app live khi có giỏ đang bán.

Kết quả: test browser đỏ đúng lỗi `rgb(255,255,255)` thay vì màu nhóm khi theme nạp trước; sau sửa 9 test browser qua (cả hai thứ tự CSS + CSS build, tương phản chữ >=4.5:1, focus >=3:1, 6 viewport 390–2560px). 118 test sản phẩm/giỏ/mode liên quan qua. Full Windows build qua, renderer build chạy lại sau chỉnh khoảng cách/focus qua; Android web/boundary qua trước chỉnh focus cuối. Không đổi logic bán, dữ liệu, ảnh catalog hoặc backend. Ảnh fixture lưu ngoài repo ở `C:/Users/maxis/.codex/visualizations/2026/09/08/restaurant-theme/`; ảnh món minh họa chỉ có trong test. Test browser là opt-in `RUN_RESTAURANT_BROWSER_TESTS=1`, cần Chromium của Playwright hoặc Chrome đã cài; không tải trình duyệt ngầm. 390px mới kiểm tra tràn/ngăn nút Pay bị che, giỏ rất chật nên chưa nghiệm thu UX điện thoại hoặc Android native.

## 10. Trạng thái lập kế hoạch

### Android: đồng bộ giao diện nhà hàng (08/09, lượt tiếp theo)

Theo `design-reasoning`, phạm vi lượt này là giao diện dùng chung và các lệnh giỏ cần thiết cho bán trực tiếp trên Android độc lập. Android dùng Capacitor/WebView, không phải React Native; không tạo một bản theme/component khác. Nhân viên nhà hàng dùng cùng RestaurantTemplate, ProductCard, CategoryRail, Cart và PaymentModal như Windows. Giữ ảnh/giá catalog; không seed bàn hoặc sản phẩm mẫu vào dữ liệu thật.

Phát hiện source: resolver Android loại `restaurant` thành `salon`; dispatch trả `undefined` trong khi màn nhà hàng cần acknowledgment; reducer bỏ qua `orderType` và `cart/completeCheckout`. Lỗi màu thẻ trước đó nằm trong component dùng chung, cần kiểm tra thêm CSS build Android, không chỉ build Windows.

Lựa chọn: sửa adapter hẹp cho bán trực tiếp, giữ các capability chưa có ở trạng thái chưa hỗ trợ. Không nhân dịp sửa UI mà port vội payment journal/check lifecycle hoặc giả thành công thao tác bàn. Android chưa có nguồn cấu hình bàn được xác nhận; chỉ cung cấp bán không bàn và báo rõ giới hạn trên màn, không suy diễn stub rỗng là nhà hàng backend không có bàn. Lưu/mở nhiều check theo bàn, in bếp và hardware/native acceptance vẫn chưa đạt parity.

File impact dự kiến: MODIFY `src/renderer/android-pos/shim/{config-store,pos-store,index,stubs,real-transport}.ts` (mode theo salon, acknowledgment/context/complete, capability counter); `src/shared/electron.d.ts`, `RestaurantTemplate.tsx`, `src/renderer/i18n/translations.ts` (thông báo capability rõ ràng); `tests/restaurant-theme.browser.test.tsx`, `tests/android-salon.test.ts`; CREATE `tests/android-restaurant.test.tsx` (adapter thật + màn dùng chung). Nếu cần sửa script build Windows, ghi bổ sung phạm vi trước khi sửa. Không API server, không schema/migration, không thay DB/payment transport trong lượt này.

Rủi ro: đổi loại bán khi giỏ còn món → chặn cả UI và adapter; đổi salon mang mode cũ → nhớ lựa chọn theo salon; CSS cascade → test cả CSS Android build và hai thứ tự source; tự nhận đã cập nhật APK → chỉ báo đúng artifact/native nào đã kiểm tra. Kiểm chứng: test đỏ trước sửa, tests Android/restaurant liên quan, typecheck, build web Android + source/bundle/native-assets boundaries, kiểm tra ảnh tablet ngang/dọc bằng Chromium. Không thao tác giao dịch thật hay cài lại thiết bị đang bán.

Bổ sung impact sau kiểm tra shell: `AndroidBootApp.tsx` và `restaurant-pos.css` dùng cùng palette cho thanh POS/Bi-a của Android khi đang ở nhà hàng, không để một dải trắng ngoài màn tối; `tests/android-billiard-boot.test.tsx` kiểm tra theme chỉ áp dụng đúng mode. `tests/android-real-transport.test.ts` kiểm tra lấy mode từ entitlement salon hiện tại trước khi mount POS, lựa chọn retail cũ và phản hồi đến muộn sau logout. Không thay hoặc cài toolchain native trong lượt này.

Kết quả lượt Android:

- 6 test mới đỏ trước sửa, sau sửa 8 test adapter/component qua. Android không còn đổi restaurant thành salon ở boot; login lấy suggestedPosMode từ entitlement đúng salon, giữ lựa chọn theo salon và bỏ phản hồi muộn sau logout. Default salon của bản Android cũ không còn đè gợi ý restaurant khi chưa có lựa chọn per-salon rõ ràng; lựa chọn retail cũ vẫn được giữ.
- 349 test trong 26 suite Android/restaurant/store/payment qua; sau bổ sung theme shell, 43 test thuộc 3 suite bị ảnh hưởng chạy lại qua (gồm 1 test shell mới). 13 test Chromium qua, gồm CSS Android build, tương phản và 3 kích thước tablet touch 1280×800, 1024×768, 800×1280. Đây là fixture dùng component thật/dữ liệu giả, không phải ảnh chụp app native hoặc giao dịch thật.
- Full Windows build, Android web build, source/bundle boundary và `cap sync` + native-assets boundary qua. CSS Windows, Android web và assets native có cùng SHA-256 `8F0DF11A748AB3E715741321D7C545A02604E9A012C520E2FEFD9D17EA4816DA`. Không có fork theme Android riêng.
- Chưa tạo/cài APK: preflight hiện lỗi `spawnSync npm.cmd EINVAL` trên Node 24.13.0; kiểm tra riêng thấy Java 1.8.0_503, không đúng Java 21 theo toolchain dự án. SDK 36/build-tools 36 có trên máy nhưng chưa cấu hình biến môi trường. Không sửa phiên bản hệ thống hoặc tải toolchain ngầm.
- Chưa đạt parity chức năng toàn bộ: Android chỉ bán trực tiếp; table/check journal, in bếp, contract round-trip backend, lưu bền khi mất điện và native/hardware QA còn mở. Không sửa DB/order transport để che các giới hạn đó. Không tuyên bố bản APK đang cài đã hết lỗi hoặc giống Windows 100%.

- [x] Liên kết mọi R1–R10 với chặng xử lý và tiêu chí nghiệm thu.
- [x] Kiểm tra lại snapshot/Hold/Modal/preload trước khi đề xuất reuse; ghi nhận giới hạn prune 20 và scope user/register.
- [x] Tách chức năng bổ sung, contract backend, migration, rollback và giới hạn QA.
- [x] Người dùng chốt Android là máy POS riêng, bán độc lập; không chia sẻ check đang mở.
- [ ] Backend contract được khảo sát/xác nhận.
- [ ] Thiết bị test và quyền thao tác thử nghiệm được xác định trước native/production.

Sử dụng skill `design-reasoning` cho yêu cầu, kiến trúc, lựa chọn, phạm vi file, rủi ro và thứ tự làm. Graph Tier 2 generation `2026-09-08T00:04:44Z`; coverage có metadata_changed và các file test/i18n/docs bị exclude, nên các điểm quan trọng được đối chiếu source trực tiếp và báo cáo review hiện có. Wiki không tìm thấy ở các vị trí mặc định đã kiểm tra; chưa ghi ADR vào wiki. Đây là proposal, không phải thông báo các chức năng đã được triển khai.
