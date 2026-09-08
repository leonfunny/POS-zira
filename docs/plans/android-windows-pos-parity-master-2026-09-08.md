# Kế hoạch triển khai POS Android tương đương POS Windows

Ngày: 08/09/2026. Trạng thái: ĐANG THỰC HIỆN, chưa nghiệm thu 100%.
Phê duyệt: người dùng yêu cầu lập kế hoạch chi tiết và triển khai, bao gồm phần backend đã nêu ở lượt trước.

### Trạng thái mới nhất — sổ hoàn tiền Android, chưa bật luồng mới (08/09)

Schema13 và repository lưu sự kiện/đơn/journal nguyên tử đã hoàn tất; kiểm tra tiền thực thu, phương thức, ca/máy/salon và toàn bộ lịch sử trước khi ghi. Chặn luồng cũ đọc/ghi nhầm dữ liệu mới và giữ nguyên UNKNOWN. Parent **1.087 tests / 49 suites đạt**, typecheck/Android web/boundary159/5 đạt. [Chi tiết và giới hạn](android-refund-event-client-2026-09-08.md). Chưa nối V1 HTTP hoặc báo cáo ca theo sự kiện; remote-close recovery/native còn mở. Không APK/deploy, chưa 100% parity.

### Trạng thái trước — lưu cố định báo cáo đóng ca (08/09)

Schema12 lưu report/cash/date nguyên tử; đóng lại đọc đúng bản đã chốt, không tính lại đơn thay đổi hay gửi thêm close POST. Chặn báo cáo lỗi và dữ liệu đầu vào bị đổi trong lúc chờ. Parent **977 tests / 46 suites đạt**, typecheck/Android web/boundary159/5 đạt. [Chi tiết](android-refund-event-client-2026-09-08.md). Sổ sự kiện và remote-close recovery còn mở; V1 chưa bật, chưa APK/deploy.

### Trạng thái trước — mã máy và liên kết ca Android (08/09)

Đã dùng chung UUID máy bền vững, gửi khi mở ca và lưu bằng chứng ca/máy/salon/server khi phản hồi xác minh đầy đủ. Schema11 thêm cột nullable, không suy đoán ca cũ; chặn đổi phiên giữa await và không gửi lại POST mở ca khi401. Parent **919 tests / 41 suites đạt**, typecheck/Android web/boundary159/5 đạt. [Chi tiết](android-refund-event-client-2026-09-08.md). V1 refund chưa kích hoạt; sổ sự kiện, snapshot và native vẫn còn. Chưa phát hành.

### Trạng thái trước — nền tảng Android V1 và chốt lưu ca (08/09)

Đã thêm validator sự kiện và phân bổ tiền chính xác, chưa bật V1 trong runtime. Sửa lỗi mở/đóng ca báo thành công khi lưu thất bại; lỗi lưu liên kết ca cũng chặn thao tác tài chính tiếp. Parent kiểm chứng **534 tests / 11 suites đạt**, typecheck, biên dịch main Windows và Android web đạt. [Kế hoạch và giới hạn](android-refund-event-client-2026-09-08.md). Schema vẫn10; sổ sự kiện, liên kết máy, snapshot báo cáo và nghiệm thu native còn mở. Chưa APK/deploy.

### Trạng thái trước — backend hoàn tiền V1 trên DEV (08/09)

Đã triển khai hợp đồng hoàn tiền có phiên bản: xác thực ca/phương thức, lưu từng sự kiện hoàn, khóa đồng bộ với đóng ca và cập nhật ba nơi dùng báo cáo. Parent chạy độc lập **284 tests / 16 suites đạt**, gồm 24 test PostgreSQL; biên dịch riêng, không đụng dịch vụ đang chạy. [Bằng chứng và giới hạn](android-refund-event-accounting-server-request-2026-09-08.md). Chưa commit/land/deploy. Android chưa dùng V1; bước tiếp theo là liên kết máy/ca và sổ hoàn tiền cục bộ, không gỡ gate sớm.

### Trạng thái trước — chặn mở rộng hoàn tiền theo ca (08/09)

Review backend bằng subagent xác nhận thiếu xác thực ca/phân bổ phương thức hoàn và khóa đồng bộ với đóng ca. Đã lập [yêu cầu sửa backend và kế hoạch hạch toán theo sự kiện](android-refund-event-accounting-server-request-2026-09-08.md). Giữ giới hạn cùng ca/một phương thức; không sửa runtime hoặc deploy trong lượt này. Chạy lại 48 test an toàn hiện tại đạt; chưa phải kiểm chứng tính năng mở rộng.

### Trạng thái trước — nối hoàn tiền và đối soát Android (08/09)

- Đã nối coordinator/journal/validator/API và UI đối soát bằng mã yêu cầu gốc. Mất kết nối sau khi server hoàn tiền hoặc lỗi lưu không được biến thành lần chi mới. Schema10 lưu backend shift ID đã xác minh; không đoán cho ca cũ.
- Phạm vi hiện hỗ trợ: OWNER/MANAGER, đơn local POS đã sync thuộc ca đang mở có liên kết server, một phương thức thanh toán, giá/số lượng chuẩn rõ ràng. Chặn đơn ca cũ/import SERVER, split, giảm giá/tip/phí, Billiard và dữ liệu legacy mơ hồ. Chưa hoàn tất parity.
- Parent kiểm chứng **1187 test khác nhau**, Windows build và Android web/sync/boundary158/5/7 đạt; gồm Chromium UI tests. Chưa APK mới/cài máy/deploy/hoàn tiền thật. [Chi tiết implementation và giới hạn](android-refund-coordinator-2026-09-08.md).

### Giai đoạn trước — nền tảng an toàn hoàn tiền (08/09)

- Đã sửa exact item ID trong hoàn toàn bộ/một phần, “Hoàn tiếp” và cập nhật nền; hai dòng cùng sản phẩm không còn bị trừ hoàn chung. Windows kiểm tra ID/tenant/phản hồi đổi phiên trước khi mở màn hoàn.
- Android schema9 có nhật ký yêu cầu bất biến và khóa yêu cầu chưa rõ kết quả. Shared mapper/validator đã kiểm thử, nhưng chưa nối thành luồng hoàn tiền có phục hồi sau mất mạng. Đã bỏ đường Android POST nguyên DTO/tự đoán thành công/tự cộng tồn kho; thao tác hoàn tiền hiện bị chặn rõ ràng cả ở transport.
- Parent kiểm chứng **1055 test khác nhau**, gồm 13 Chromium UI tests; Windows build và Android web/sync/boundary đạt. Chưa APK mới/deploy/hoàn tiền thật. [Kết quả và phần tiếp theo](android-refund-safety-continuation-2026-09-08.md).

### Giai đoạn trước — lịch sử server Android (08/09)

- Đã nối danh sách/lưu bản sao lịch sử Android bằng API thật và adapter dùng chung Windows; giữ đơn local/ca/tồn kho/upload, ghi chú ghép đúng ID. Chặn phản hồi sai salon/người dùng, đổi đi rồi quay lại, mất phiên và lưu lỗi.
- Parent kiểm chứng **545 test khác nhau**; Windows build và Android web/sync/boundary đạt. Chưa APK mới/deploy. Xem [kết quả continuation](android-server-history-continuation-2026-09-08.md).
- UI chặn phản hồi chi tiết/hoàn tiền cũ và hành động in từ bản server đã lỗi thời. Fiscal-only Android hiện báo chưa hỗ trợ; cần bật hiển thị cả đơn non-fiscal trong Settings để xem lịch sử, không tự đổi cài đặt hoặc giả bằng chứng fiscal.
- Hoàn tiền Android vẫn chưa được mở: sai đơn vị tiền, thiếu bảo vệ retry/lưu trạng thái và mất lịch sử hoàn từng phần; shared Windows còn cần giữ exact item ID khi hoàn sản phẩm trùng nhau. Đây là phần triển khai tiếp theo, không được coi test cũ đạt là an toàn tài chính. Xem [audit](android-refund-authority-review-2026-09-08.md).

### Giai đoạn trước — P2 liên kết dòng món (08/09)

- Đã thực hiện explicit `localLineId → orderItemId` ở backend DEV và parser/mapper/lưu bền vững/UI phía POS. Không ghép ghi chú/course theo sản phẩm hoặc vị trí; không ghi đè đơn local. Windows schema 69 / Android 8 giữ dữ liệu cũ, không backfill giả.
- Parent chạy độc lập: 476 test POS và 147 test backend đạt; Windows build và Android web/sync/boundary đạt. Xem [báo cáo round-trip](restaurant-line-identity-roundtrip-2026-09-08.md) để phân biệt test giả lập, SQLite thật và các giới hạn.
- Đây là code WIP chưa commit/land/deploy, chưa APK mới. Hợp đồng thiếu ID đã được sửa trong worktree, chưa phải trên canonical/production. Nhật ký cũ bên dưới là lịch sử, không phải trạng thái hiện tại.
- Android server history transport/import, chi tiết/lịch sử hoàn từng phần, phiếu hoàn tiền thật và nghiệm thu thiết bị vẫn chưa xong. Chưa đạt 100% parity hay điều kiện phát hành toàn app.

## 1. Mục tiêu và ranh giới

- Cùng chức năng bán hàng, cùng màn hình và kết quả tính tiền như bản Windows đang chỉnh sửa trên nhánh `codex/pos-ui-release-foundation`.
- Ưu tiên hoàn tất POS nhà hàng; lập danh sách rõ các tính năng salon/nail, grocery/retail và tiện ích Windows để không đánh đồng “màn nhà hàng giống” với “toàn app giống”.
- Android là một máy POS độc lập: ca, giỏ, đơn chờ và trạng thái sử dụng bàn thuộc máy. Không gọi Windows để lấy giỏ/ca đang mở.
- Catalog, cấu hình salon và báo cáo đơn hoàn tất dùng backend Zira. Đăng nhập salon khác không trộn catalog/đơn/khóa thanh toán.
- Nhân viên bán hàng được dùng chức năng được cấp quyền; cấu hình/xử lý tiền bất thường phải có quyền tương ứng và lưu dấu vết.
- Giữ giao diện React dùng chung qua Capacitor; không viết lại app bằng React Native.
- Không coi nút trả thành công giả là chức năng hoàn tất. Không sao chép lỗi Windows sang Android để đạt “giống”.

## 2. Định nghĩa hoàn tất

Mỗi mục phải có: luồng Windows tham chiếu → Android triển khai → test tự động → kiểm thử tích hợp nếu có backend → kiểm thử trên Android thật nếu có phần hệ điều hành/thiết bị. Chỉ mục đã đủ bằng chứng mới được đánh dấu DONE.

Điều kiện nghiệm thu cuối: cùng bộ kịch bản và dữ liệu thử chạy trên Windows và Android cho cùng số tiền, thuế, giảm giá, tip, số lượng, thông tin món, trạng thái đơn và bản in; khởi động lại/mất mạng không tạo đơn hoặc in/thu tiền lặp.

## 3. Bảng phạm vi và mức hiện tại

| Nhóm | Đã có trước đợt này | Phần phải hoàn tất/kiểm chứng |
|---|---|---|
| Giao diện | React/CSS dùng chung, nền tối, menu trái, nhóm món, giỏ phải | Toàn màn hình, xoay màn, bàn phím, modal, popup, màn lỗi trên máy thật |
| Đăng nhập / POSmode | Theo salon, nhớ lựa chọn từng salon | Mất phiên giữa lưu/sync, đổi tài khoản, quyền nhân viên, dữ liệu cách ly |
| Catalog | Đồng bộ, tìm kiếm, danh mục, biến thể | Tên dài, ảnh thiếu, mã vạch, hàng cân, tồn kho, giá thay đổi |
| Giỏ / bán hàng | Ghi chú, course, giảm giá, tip; dùng chung renderer | Cùng cách tính/độ làm tròn, đổi số lượng, sửa giá, dữ liệu lịch sử |
| Bàn | Android có kho bàn và xử lý trạng thái cục bộ | Nguồn sơ đồ bàn thật, cập nhật/ẩn bàn an toàn, cache offline, quán không bàn |
| Đơn chờ | Bộ xử lý dùng chung, lưu/mở, giữ ca hiện tại, khôi phục | Quyền hủy/đối soát, mở đồng thời, không mất đơn khi đổi ngữ cảnh |
| Thanh toán | Luồng tiền mặt/thủ công, khóa đơn chờ trước ghi tiền | Tiền mặt/thẻ/BLIK/chuyển khoản, split tender, chống lặp, trường hợp không rõ kết quả |
| Bếp / pickup | Android chưa triển khai đầy đủ | Danh mục tuyến in, gửi món, trạng thái, claim/release/settle, retry/idempotency |
| Lịch sử / hóa đơn | Một số transport có thật, một số API còn stub | Rà từng API Windows: danh sách/chi tiết/refund/reprint/NIP/proforma/PDF |
| Ca / báo cáo | Ca độc lập, tổng hợp bán/hoàn/giảm giá/tip | Ca mở lại sau restart, sync ca, báo cáo cuối ca, quyền đóng ca |
| In / phần cứng | Có adapter in từ xa | Xác nhận model/driver, in local nếu cần, ngăn in lặp, UNKNOWN, scanner/cân/ngăn kéo |
| Đóng gói | Web build và đồng bộ assets đạt | Đúng JDK/Node/npm/SDK, APK debug, test native, rollout có kiểm soát |

## 4. Quyết định kiến trúc

1. **Dùng chung logic nghiệp vụ**, chỉ khác adapter lưu trữ và thiết bị. Tránh hai bộ xử lý tiền/bàn có hành vi khác nhau. Đã có controller đơn chờ dùng chung.
2. **Lấy cấu hình bàn từ hợp đồng backend có thật**, chỉ lấy layout, không nhập trạng thái/đơn sống của Windows. Nếu backend chưa có hợp đồng phù hợp, bổ sung có kiểm thử; không tự đoán endpoint.
3. **Thêm dữ liệu tương thích ngược**: migration local/backend chỉ bổ sung; dữ liệu cũ không mất. Ghi chú/course/bàn/số khách phải đi qua cả tạo đơn, lưu và trả về lịch sử.
4. **Bền vững trước xác nhận**: lưu phải chờ IndexedDB transaction hoàn tất. Lỗi/corrupt không được đổi thành DB trống. Thanh toán chưa xác định phải đối soát, không cho tự thu lại.
5. **Thay đổi backend ở máy phát triển**, không build/thử trên Contabo production. Xác minh đường dẫn/nhánh/trạng thái trước khi chỉnh; không ghi đè thay đổi khác. Deploy và thao tác máy bán thật tách khỏi kiểm thử giả lập.

## 5. Các giai đoạn, thứ tự và đầu ra

### P0 — Chốt bản tham chiếu và hợp đồng (làm trước)

- Đọc mã Windows, Android và backend hiện có, ghi lại nhánh/commit và các file đang sửa.
- Phân loại từng phương thức shim: thật / stub / thiếu / cần native.
- Xác minh layout, đơn restaurant, bếp/pickup, quyền staff và idempotency trên backend.
- Ghi quyết định mapping API và file cụ thể trước khi sửa mỗi nhóm; các tên API trong tài liệu cũ chỉ là yêu cầu, không phải bằng chứng endpoint tồn tại.
- Đầu ra: bảng gap có bằng chứng, kế hoạch này được cập nhật cùng kết quả triển khai.

### P1 — Bàn thật và ngữ cảnh nhà hàng

- Adapter đọc layout đã xác minh; phân biệt loading/error/empty/cached.
- Đồng bộ tên/khu/sức chứa/thứ tự/active; giữ riêng occupancy/check/covers theo máy.
- Không xóa/ẩn mất bàn có đơn chưa xong; lưu layout mới và cursor/revision cùng transaction.
- Hết mạng dùng layout đã xác thực, không biến lỗi thành “quán không bàn”.
- Tests: hai salon, hai máy, đổi layout khi đang bán, dữ liệu sai, phản hồi đến muộn sau logout, quán thật sự không bàn.

### P2 — Thông tin món/đơn xuyên suốt

- Xác minh và bổ sung DTO/entity/migration khi cần: table ID/label, covers, order type, course, notes, line ID, phân bổ giảm giá.
- Cùng mapping Windows và Android; giữ nguyên đơn vị tiền và quy tắc tính.
- Kiểm thử create → local → sync → server history → in/refund; request lặp chỉ một đơn.
- Không triển khai thêm cột backend nếu dữ liệu tương ứng đã có cấu trúc được hỗ trợ.

### P3 — Bếp, pickup và in phiếu

- Dùng đúng pipeline Windows đã xác minh và quyền hiện tại, không nối Android với giỏ Windows.
- Lưu ý định gửi/in có ID trước khi gửi; xử lý accepted/running/printed/failed/unknown rõ ràng.
- Course/notes và gửi bổ sung món không được in lại toàn bộ ngoài ý muốn.
- Pickup: ownership, claim/release/settle/cancel an toàn khi hai máy thao tác.
- Tests: mất mạng trước/sau nhận, timeout, restart, phản hồi trễ, gửi hai lần, khác salon.

### P4 — Thanh toán, ca, lịch sử và quản lý

- Rà các API còn stub; triển khai bằng endpoint/local repo thật hoặc giữ vô hiệu hóa có lý do.
- So sánh CASH/CARD/BLIK/TRANSFER và thanh toán nhiều phương thức; thay đổi ca/nhân viên không làm đổi đơn đã khóa.
- Quy trình hủy/đối soát cần quyền, lý do và bằng chứng, không có nút “bỏ khóa” tùy ý.
- Kiểm chứng refund/void, in lại, giảm giá, thuế, tip, đóng ca, lịch sử và hóa đơn.

### P5 — Trải nghiệm Android và phần cứng

- Giữ bố cục/cỡ chạm giống Windows ở POS ngang; test tối thiểu 1280×800, 1024×768, 800×1280.
- Fullscreen/back, bàn phím che nội dung, modal, khôi phục khi app background/restart.
- Chốt model POS và máy in/scanner/cân/terminal; phần Windows driver phải có adapter Android thật hoặc đường in từ xa đã được chấp thuận.
- Kiểm tra salon/nail và grocery không bị ảnh hưởng bởi bổ sung restaurant.

### P6 — Build, nghiệm thu và triển khai

- Chuẩn bị toolchain tách biệt, không tự đổi Node/Java toàn hệ thống hoặc hạ yêu cầu dự án.
- Typecheck, test nghiệp vụ, test bridge/boundary, build Windows, Android web, native debug APK.
- Test trên máy/emulator: đăng nhập salon test → ca → bàn A/B hoặc counter → món/ghi chú/giảm giá → lưu/mở → thanh toán → in → lịch sử → đóng ca → restart/offline.
- Ghi ảnh/kết quả và lỗi còn lại. Không tự cài đè POS đang bán hoặc publish bản chưa nghiệm thu.

## 6. File impact ban đầu

- POS: `src/renderer/android-pos/shim/{index,transport,real-transport,restaurant-runtime}.ts`, `shim/db/{schema,restaurant-table-repo,order-repo}.ts`; bổ sung adapter và test riêng theo hợp đồng P0.
- Shared/Windows: chỉ các mapper/controller cần dùng chung; `src/main/sync/order-sync.ts`, renderer restaurant/settings nếu phải nối cấu hình/capability mới.
- Android/native: `android-pos/`, scripts toolchain/build; xác định file cụ thể trước chỉnh sửa.
- Backend: phạm vi restaurant/resources/b2b POS/print-agent có liên quan; đường dẫn, DTO/entity/migration cụ thể sẽ ghi sau P0, trước mọi thay đổi. Không sửa cả monorepo hoặc copy build production cũ vào checkout hiện tại.
- Tài liệu: kế hoạch này, bảng gap/API và log nghiệm thu. Không tự cập nhật wiki.

## 7. Rủi ro và cách chặn

| Rủi ro | Mức | Biện pháp |
|---|---|---|
| Thu/in hai lần | Cao | ID ổn định, lưu ý định, khóa trạng thái không rõ, đối soát |
| Dữ liệu lẫn salon/máy | Cao | Salon từ auth, register riêng, kiểm tra epoch và phản hồi trễ |
| Mất đơn chờ khi đổi layout/cập nhật | Cao | Migration bổ sung, không prune đơn, giữ bàn tham chiếu |
| Sửa nhầm production/bản source cũ | Cao | Xác minh host/path/nhánh, build máy phát triển, kiểm tra diff trước promote |
| Windows chạy khác Android | Cao | Shared logic + cùng bộ fixture/contract tests |
| Chữ/nút sai ngôn ngữ | Vừa | Dùng bảng dịch POS hiện có, không trộn i18n backend/dashboard |

## 8. Thông tin cần để nghiệm thu cuối (không chặn P0–P4)

Model máy Android, phiên bản Android, các model máy in/scanner/cân/terminal và cách kết nối; máy/salon test có thể dùng để cài bản debug. Các kiểm thử tiền/in thực chỉ thực hiện trong ngữ cảnh thử đã thống nhất.

## Nhật ký

### P2 tiếp tục, 08/09/2026 — lịch sử và chặn in nhầm

- 3 subagent được dùng lại: inbound history, xác minh hợp đồng backend, Android history/print assessment. Parent sửa shared history UI và kiểm thử độc lập.
- Server → Windows: khôi phục header table/covers/order type từ metadata v1 hợp lệ; sửa bản sao source=SERVER, không ghi đè đơn local. Dòng restaurant import mới không có course đã chứng minh lưu null thay vì mặc định 1.
- Shared Windows/Android history: ưu tiên detail local cho đơn local, không lấy server items qua backend_id; chặn phản hồi chọn đơn đến muộn. Hiện ghi chú/course local trong chi tiết và màn chọn món hoàn tiền; header ghi rõ table ID, không tự dựng tên bàn lịch sử. Không hiển thị course mặc định của server mirror cũ như dữ liệu đã xác minh.
- Android: sửa lỗi printRefundReceipt gọi nhầm sale reprint. Nay trả unsuccessful/receiptPrinted=false với giải thích chưa hỗ trợ, không gửi lệnh in; không tuyên bố chức năng in hoàn tiền đã hoàn tất.
- Gate parent: 11 suites / 128 tests PASS, bao gồm shared UI 20 tests. Hai regression local/server source + stale detail đã fail trước sửa, pass sau sửa. Android web/sync/boundary PASS (150 source, 5 bundle, 7 native assets). Đây không phải APK mới hoặc nghiệm thu máy thật.
- Blocker hợp đồng xác minh trên canonical backend c6576a51: restaurant.lines chỉ có localLineId/productId/lineIndex, không có server orderItemId; ORM trả items không đảm bảo thứ tự. Đã soạn [server change request](android-history-p2-followup-2026-09-08.md), không ghép notes/course bằng vị trí hoặc sản phẩm. Chưa sửa/deploy backend ở đợt này.
- Android vẫn thiếu wiring server history, getRefundDetail, lưu lịch sử hoàn từng phần và metadata trong bản in. Chi tiết [Android P2](android-history-native-p2-2026-09-08.md). Các phần này tiếp tục là điều kiện chưa đạt trước phát hành.
- APK test từ lượt trước không chứa sửa đổi P2 mới. Không cài/publish/restart/in/thu tiền thật; production giữ nguyên. Hướng thiết kế theo skill design-reasoning: tách metadata hiển thị khỏi tính tiền và driver fiscal, không thêm migration hoặc endpoint giả.
- Build cuối trên source đã đóng băng: Windows `npm run build` PASS (renderer typecheck/main TypeScript/Vite), Android sync PASS, diff-check PASS. Các cảnh báo bundle size/Browserslist/sql.js cũ vẫn có, không coi gate boundary đạt là đã kiểm thử thiết bị.

### Tiếp tục phát hành, 08/09/2026 — trạng thái mới nhất

Chi tiết theo [production rollout plan](android-windows-production-rollout-2026-09-08.md), gồm 3 subagent và các cổng kiểm thử/rollback.

- P2 upload: Windows/Android đã dùng shared metadata v1 + immutable upload snapshot, migration Windows 68 / Android 7; chặn đổi nội dung khi đang gửi, retry giữ nguyên payload và salon/server. Đơn cũ giữ legacy. `tableName` optional chưa có snapshot lịch sử nên không tự dựng lại từ tên bàn hiện tại.
- Backend đã land `c6576a518311b81171d566c4c919f7e2355bce85` vào canonical main; build production-shaped + 127 test đạt, exact-file preflight/check-only đạt. **Chưa deploy Contabo**, đang chờ lựa chọn giờ ngoài cao điểm hoặc phê duyệt vượt giờ riêng.
- Parent kiểm thử POS mở rộng 400 test + 13 browser fixture đạt; Windows build và Android web/native-assets sync đạt. Không đồng nghĩa native hardware đã nghiệm thu.
- Native phát hiện/chỉnh chính sách spike cũ cấm INTERNET: chỉ thêm quyền mạng cần cho HTTPS POS, giữ backup/debug/cleartext/signing/dev-ID guards. 97 policy/readiness regression test đạt; production gate vẫn NO-GO theo các quyết định/bằng chứng còn thiếu.
- N1 đã build APK test từ snapshot hash riêng trên Netcup bằng đúng toolchain pin. Parent xác minh lại SHA-256, package/version/INTERNET bằng aapt2; 27 file web được đối chiếu bytes bên trong APK. Xem [native readiness](android-native-release-readiness-2026-09-08.md) để lấy artifact và checksum. Đây là dev package/debug signer, chưa cài máy, chưa ký/publish production; native unit tests cơ bản không thay thế nghiệm thu nghiệp vụ trên thiết bị.
- P2 mapper lịch sử/in và P3/P4 bếp/pickup/đối soát đầy đủ, P5/P6 thiết bị/nâng cấp giữ dữ liệu vẫn cần hoàn tất; không đánh dấu 100% parity.

### Kết quả triển khai / kiểm chứng đợt 08/09, 05:35 Warsaw

| Nhóm | Trạng thái có bằng chứng |
|---|---|
| P0 | Đã xác minh API bàn và CreateB2BPOSOrderDto trên DEV; còn phải audit đầy đủ pickup/kitchen và các shim phụ trợ |
| P1 | Đã nối API thật vào Android, schema v6 + cache bền vững, giữ bàn có đơn/giỏ, thông báo cache 7 ngôn ngữ; đạt unit/UI/build. Chưa thử endpoint với tài khoản quán trên APK thật |
| P2 backend | Đã thêm nested DTO + service validation + lưu snapshot trong external_metadata + GET capabilities; nằm trong worktree DEV, chưa land/deploy |
| P2 client | CHƯA nối gửi metadata mới. Cần chọn phiên bản contract và lưu payload sync bất biến trước lần gửi đầu tiên: không để retry sau khi server nâng cấp tự đổi payload/idempotency hash. Sau đó nối mapper lịch sử/in ở cả Windows và Android |
| P3–P4 | Chưa hoàn tất bếp/pickup, quyền hủy/đối soát, đối chiếu toàn bộ thanh toán/hóa đơn/lịch sử |
| P5–P6 | Giao diện bundle chung đạt test; chưa build APK/cài máy/kiểm thử thiết bị. Chưa triển khai production |

Kết quả lệnh:

- POS baseline HEAD `af33318a149e0c0234ae31c4f7e5304cd4f5c0fc` + các thay đổi chưa commit đã giữ nguyên.
- `npx vitest run tests/android- tests/restaurant-check- tests/restaurant-counter-sales.test.tsx`: 26 suites / 363 tests PASS. Bổ sung test lỗi layout UI sau đó: riêng `android-restaurant.test.tsx` 11/11 PASS; tổng 364 test khác nhau được kiểm chứng trong nhóm trên.
- `RUN_RESTAURANT_BROWSER_TESTS=1 ... restaurant-theme.browser.test.tsx`: 13/13 PASS, gồm bundle Android ngang/dọc và desktop; đây là Chromium fixture, không phải Android native.
- `npm run build`: PASS (renderer typecheck + Windows main/renderer).
- `npm run android:sync`: PASS, kiểm tra 148 source files và native assets; chưa tạo APK.
- Backend worktree: 3 suites (`restaurant-pos-metadata`, `create-pos-order-idempotency.service`, `b2b-pos-order.dto`) / 41 tests PASS; `npm run typecheck` PASS. Các log exception là fixture cố ý kiểm thử rollback/tender sai.
- `git diff --check` ở POS và backend: PASS. Không commit, không deploy/PM2, không đổi tài khoản, không in hoặc thu tiền thật.
- Phương pháp: graph POS được refresh, nhưng file mới/tests/i18n có coverage thiếu/stale nên dùng source trực tiếp; backend đọc source chính xác qua SSH sau codemap, không coi graph local backend cũ là bằng chứng bản server.

Ưu tiên tiếp: hoàn tất P2 client với payload ổn định + contract integration test; preview backend theo quy trình riêng trước production; tiếp đến P3, P4 và môi trường build native. Cần model Android và phần cứng để nghiệm thu P5/P6, không được suy ra từ bản Windows.

### P2: hợp đồng metadata backend (triển khai trên worktree DEV, chưa bật production)

- Worktree backend: `netcup:/var/www/www/enail/.worktrees/android-pos-restaurant-parity-20260908`, branch `feat/android-pos-restaurant-parity-20260908-20260908`, base `54869551`.
- Hiện `CreateB2BPOSOrderDto` chưa nhận bàn/covers/course/line notes. Cả mapper Windows/Android đều bỏ các trường này. Không gửi thêm field tới backend production whitelist-strict trước khi server hỗ trợ.
- Chọn metadata có phiên bản trong `B2BOrder.externalMetadata.meta.restaurant`, dùng cột JSONB `external_metadata` đã có; không thêm FK, không join/migration. `tableId` là ID layout cục bộ (Windows có thể không phải UUID), chỉ là snapshot mô tả, không cấp quyền truy cập bàn server. `tableName` và covers là dữ liệu tại lúc bán. Mỗi dòng có localLineId/notes/course, lưu cùng productId và vị trí dòng để giữ các món trùng sản phẩm nhưng khác ghi chú.
- Nhận nested DTO allowlist, giới hạn độ dài, xác minh mode/orderType và line ID duy nhất tại service boundary (không chỉ dựa global validation); metadata tham gia idempotency hash sẵn có. Không dùng metadata để quyết định số tiền/thuế/tồn kho.
- CREATE backend: `modules/b2b/dto/restaurant-pos-metadata.dto.ts`, `modules/b2b/services/restaurant-pos-metadata.ts`, `modules/b2b/__tests__/restaurant-pos-metadata.spec.ts`.
- MODIFY backend: `dto/b2b-pos-order.dto.ts` (nested DTO), `services/b2b-pos.service.ts` (validate + JSON snapshot), `controllers/b2b-pos.controller.ts` (GET capabilities, cùng JWT/roles/feature gate), `__tests__/create-pos-order-idempotency.service.spec.ts` (persistence/replay).
- Client gửi metadata chỉ sau khi contract capability được xác minh; tích hợp capability/history/in còn là bước kế tiếp, không bật ngầm field chưa được production hỗ trợ.

### P0 → P1: hợp đồng đã xác minh và file impact

- Backend DEV `netcup:/var/www/www/enail`, branch `main`: `TableController.findAll` (`backend/src/modules/restaurant/controllers/table.controller.ts`) dùng `GET /api/v1/restaurant/tables`, JWT, OWNER/MANAGER/STAFF; salon lấy từ token. `TableService.findAll` lọc salon, trả toàn bộ bàn gồm inactive, sắp theo tableNumber, quan hệ zone/floorPlan. Đây không phải API phân trang.
- Mapping chỉ nhận `id`, `salonId`, `tableNumber`, `capacity`, `isActive`, `zone.name` và thứ tự danh sách. Không nhập `status/currentOrderId/occupiedSince/assignedServer` từ server. Không gọi API mở/đóng bàn server cho sổ bán độc lập.
- Chọn dùng API có sẵn thay vì thêm endpoint layout: không đổi backend/migration production ở P1. Bất lợi: response có thêm dữ liệu không cần dùng; mapper allowlist loại bỏ toàn bộ dữ liệu ngoài layout.
- Local thêm bảng `pos_table_layout_sync(salon_id, synced_at)` trong schema v6, cùng transaction với layout. Không xóa bàn; đánh dấu inactive, vẫn hiện bàn đang có đơn chưa xong hoặc giỏ đang chọn. Cache chỉ được dùng khi đã sync thành công; lỗi 401/403/schema/salon không được biến thành offline hoặc quán rỗng.
- CREATE: `shim/restaurant-layout.ts`, `tests/android-restaurant-layout.test.ts`.
- MODIFY: `shim/db/restaurant-table-repo.ts`, `shim/db/schema.ts`, `shim/restaurant-runtime.ts`, `shim/transport.ts`, `shim/real-transport.ts`, `shim/index.ts`; `tests/android-restaurant-runtime.test.ts`, `tests/android-real-transport.test.ts`; shared API type và `RestaurantTemplate.tsx` nếu cần hiển thị cache; test UI tương ứng.
- Thứ tự: validate/mapper → repo transaction → runtime/auth epoch/cache → transport/UI → tests và build. Không thay thuật toán tiền, không deploy.

- Khởi tạo kế hoạch: giữ nguyên các thay đổi đã làm; bắt đầu P0 xác minh backend trên máy phát triển. Chưa triển khai production, chưa nghiệm thu native.
