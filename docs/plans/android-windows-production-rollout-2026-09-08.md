# Kế hoạch tiếp tục POS Android–Windows và phát hành production

Ngày 08/09/2026. Yêu cầu: tiếp tục triển khai, dùng subagent, đưa bản đủ điều kiện lên production. Chưa phải xác nhận 100% parity.

### Cập nhật mới nhất — schema13 và lưu xác nhận hoàn tiền

Đã kiểm chứng sổ sự kiện, xác nhận nguyên tử và chặn ghi nhầm qua luồng cũ. **1.087 tests / 49 suites đạt**, typecheck/Android web/boundary159/5 đạt; gồm kiểm thử phục hồi dữ liệu và rollback SQL.js. [Chi tiết](android-refund-event-client-2026-09-08.md). Vẫn NO-GO: repository chưa nối runtime, báo cáo ca theo sự kiện và V1 HTTP chưa bật, remote-close recovery và nghiệm thu máy thật chưa hoàn tất. Không sync native/APK/deploy; APK cũ không đại diện source hiện tại.

### Cập nhật trước — schema12 và snapshot đóng ca

Đã lưu nguyên tử báo cáo/cash/date và trả lại bản gốc khi đóng ca lặp lại; không dựng lại báo cáo lịch sử thiếu snapshot. **977 tests / 46 suites đạt**, typecheck/Android web/boundary159/5 đạt. Vẫn NO-GO: chưa sổ sự kiện/V1 và khôi phục đóng ca từ xa, chưa nghiệm thu native. [Chi tiết](android-refund-event-client-2026-09-08.md). Chưa phát hành APK hoặc deploy.

### Cập nhật trước — schema11 và bằng chứng liên kết máy/ca

Android đã gửi UUID máy bền vững khi mở ca, lưu liên kết xác minh đầy đủ và bảo vệ phiên xuyên await. **919 tests / 41 suites đạt**, typecheck/Android web/boundary159/5 đạt. Vẫn NO-GO production: chưa kích hoạt V1 refund, chưa sổ sự kiện/snapshot/khôi phục đóng ca từ xa, chưa nghiệm thu native. [Kế hoạch cập nhật](android-refund-event-client-2026-09-08.md). Không APK/deploy trong lượt này.

### Cập nhật trước — Android V1 chưa kích hoạt

Đã có helper kiểm tra sự kiện/phân bổ tiền và sửa chốt lưu mở/đóng ca Android. **534 tests đạt**; typecheck/main Windows/Android web đạt. [Chi tiết](android-refund-event-client-2026-09-08.md). Vẫn NO-GO: chưa nối máy/ca V1, migration sổ sự kiện, snapshot báo cáo, khôi phục đóng ca từ xa hoặc nghiệm thu APK trên máy thật. Luồng legacy và các gate khác ca/split giữ nguyên; không phát hành trong bước này.

### Cập nhật trước — V1 đã kiểm thử trên DEV, chưa phát hành

Backend V1 đã có trong worktree DEV: xác thực ca/phương thức, sự kiện hoàn tiền chuẩn và báo cáo theo ca hoàn. Parent độc lập **16 suites / 284 tests đạt**, gồm 24 test PostgreSQL; code biên dịch ra thư mục riêng. Không đổi live dist/PM2, không dữ liệu kinh doanh, không migration hay production deploy. [Chi tiết](android-refund-event-accounting-server-request-2026-09-08.md). Vẫn NO-GO phát hành: Android chưa tích hợp V1/migration sổ hoàn tiền và chưa nghiệm thu native; legacy không được tự nâng cấp thành V1.

### Cập nhật trước — backend accounting gate

NO-GO cho mở rộng hoàn đơn ca cũ/thanh toán kết hợp: backend chưa cung cấp ca hoàn và phân bổ tiền chuẩn đã xác thực, đồng thời có race với đóng ca. Xem [server change request](android-refund-event-accounting-server-request-2026-09-08.md). Không tự khắc phục bằng sổ tiền riêng phía Android. 48 test bảo vệ luồng hiện tại đạt; không runtime change, APK mới hoặc deploy trong lượt này.

### Cập nhật trước — durable refund coordinator

- Luồng thực thi/đối soát Android đã nối với journal và payload gốc; UNKNOWN chặn yêu cầu mới, không tự gửi lại sau401, không tự cộng tồn kho hoặc in/chi khi đối soát. Schema10 có nullable backend shift mapping từ phản hồi đã xác minh.
- Chỉ hỗ trợ OWNER/MANAGER hoàn đơn local đã sync trong cùng ca mở có liên kết server, một tender và giá chuẩn không giảm giá/tip/phí. Cross-shift/split/legacy/Billiard và nghiệm thu phần cứng vẫn mở; không phải 100% parity hay production acceptance.
- Parent: **1187 test khác nhau đạt**; Windows build + Android web/sync/boundary158/5/7 đạt. [Báo cáo](android-refund-coordinator-2026-09-08.md). Chưa commit/land/deploy/APK mới/cài thiết bị/hoàn tiền thật. Không dùng APK/manifest cũ cho source này.

### Giai đoạn trước — refund safety foundation

- Shared UI giữ exact item ID cả “Hoàn tiếp” và khi đồng bộ nền; sửa nhầm dòng cùng sản phẩm, thêm kiểm tra raw detail ID/tenant và đổi phiên ở Windows.
- Android schema9 bổ sung immutable refund journal; mapper/validator đã có test. Chưa có durable coordinator/reconciliation UX, vì vậy đường thực thi refund Android được chặn cả transport; không phát hành tính năng hoàn tiền như đã hoàn tất.
- Parent: **1055 test khác nhau đạt**, gồm 13 Chromium layout/theme tests. Windows build + Android web/sync/boundary153/5/7 đạt. [Báo cáo](android-refund-safety-continuation-2026-09-08.md).
- Chưa commit/land/deploy/APK mới/cài thiết bị; không có giao dịch hoàn tiền hoặc in thật. APK/manifest cũ không đại diện source hiện tại. Nghiệm thu thiết bị, fiscal-only, phiếu hoàn tiền và refund recovery vẫn mở.

### Giai đoạn trước — Android history wiring

- List/mirror Android đã dùng API thật + shared Windows mapper, không biến import thành đơn bán mới. Parent kiểm chứng 545 test khác nhau, Windows build và Android sync/boundary153/5/7 đạt. [Chi tiết](android-server-history-continuation-2026-09-08.md).
- Hoàn tiền chưa mở, fiscal-only báo unsupported thay vì hiển thị sai; không tự đổi config. Báo cáo refund xác định phần tiếp theo phải sửa cả đơn vị tiền, exact item IDs, retry/audit và xác minh response.
- Chưa commit/land/deploy/APK mới/cài máy. Bằng chứng build trong lượt này là Windows + Android web, không phải native/hardware acceptance. Không dùng manifest c6576a51 cũ để phát hành source mới.

### Giai đoạn trước — explicit line identity

- R1/P2 đã bổ sung `orderItemId` cho snapshot bằng liên kết local-line rõ ràng trong cùng transaction, kiểm thử đảo thứ tự/rollback/replay. Mapper và schema Windows 69 / Android 8 lưu bằng chứng liên kết; UI không hiển thị metadata server chưa chứng minh.
- Parent kiểm thử độc lập 476 test POS + 147 test backend đạt; Windows build và Android web/sync/boundary đạt. Chi tiết và giới hạn: [round-trip report](restaurant-line-identity-roundtrip-2026-09-08.md).
- Thay đổi mới chưa commit/land/deploy và không có trong APK test cũ. Manifest c6576a51 cuối tài liệu chỉ là bằng chứng đợt trước: hash hai service đã đổi, phải build/test/preflight lại đúng snapshot trước phát hành.
- Không vượt khóa giờ bán, không restart production, không cài APK/thu tiền/in thật. Android server history/refund/receipt và signing/device acceptance vẫn là phần việc mở.

## 1. Phạm vi và nguyên tắc phát hành

- Android là máy POS bán độc lập. Giữ giao diện/logic chia sẻ với Windows; không lấy ca/giỏ/bàn đang sử dụng của máy Windows.
- Phát hành theo phụ thuộc: backend hỗ trợ hợp đồng mới → client chọn hợp đồng và lưu payload bất biến → kiểm thử cuối → gói cài đặt đã xác thực → cập nhật thiết bị.
- Không đưa toàn bộ WIP lên production chỉ vì người dùng yêu cầu deploy. Phần bếp/pickup/hardware chưa nghiệm thu không được quảng cáo là đầy đủ.
- Backend exact-file qua lane đã có guard; không migration production trong đợt metadata JSON này. Android SQLite migration phải bổ sung, giữ đơn/ca/check cũ.
- Backend đang bị khóa giờ 08:00–20:59 Warsaw. Yêu cầu deploy hiện tại là phê duyệt production thường, không tự suy ra phê duyệt vượt giờ hoặc restart quầy đang bán.
- Gói Android hiện là diagnostics/dev, chưa cấu hình ký phát hành. Không đổi package ID/chữ ký, không phát APK thử như bản production, không xuất khóa ký.

## 2. Phân công subagent và quyền sở hữu

| Luồng | Chủ sở hữu | Phạm vi | Không được làm |
|---|---|---|---|
| A | Subagent client | Shared metadata mapper, sync Windows/Android, local immutable outbox/migration liên quan và test | Không sửa backend, không deploy, không thay tiền/thuế, không commit WIP ngoài phạm vi |
| B | Subagent backend | Review/fix 7 file metadata trong worktree Netcup; strict DTO, auth/tenant, replay và test | Không sửa client, không land/push/deploy/PM2, không mở rộng schema/nghiệp vụ không cần |
| C | Subagent native/release | Kiểm tra build/signing/package/device và lập bảng điều kiện phát hành | Không cài đè máy bán, không ký/publish, không sửa mã đang do A/B sở hữu |
| Điều phối | Agent chính | Plan, preflight deploy, review tích hợp, chạy lại test, manifest, land/deploy khi đủ gate và xác minh | Không bypass guard, không gom thay đổi không liên quan |

## 3. Thực hiện chi tiết và tiêu chí qua từng cổng

### R0 — Kiểm kê và đóng phạm vi

1. Xác minh POS worktree `C:/Users/maxis/enail/POS-zira-release-foundation`, nhánh `codex/pos-ui-release-foundation`, HEAD và WIP.
2. Resume backend `netcup:/var/www/www/enail/.worktrees/android-pos-restaurant-parity-20260908`; không tạo bản trùng, không sửa cây deploy.
3. Đọc graph/source thật; ghi các hạn chế coverage. Kiểm tra lịch triển khai, phiên deploy khác, canonical/production drift và migration đang chờ.
4. Đầu ra: manifest phạm vi + chốt nào cần người dùng xác nhận riêng.

### R1 — Backend tương thích ngược

- Kiểm lại GET `/api/v1/b2b/pos/capabilities`, nested `restaurant` order/item DTO, mode/service type, giới hạn dữ liệu, line identity, metadata JSON và idempotency.
- Không dùng tableId từ client để đọc/ghi bàn server; đây là snapshot ID cục bộ, không phải bằng chứng quyền.
- Test legacy client không có metadata; request đúng; sai tenant/role/shape; món trùng khác notes; retry cùng payload; retry đổi notes/course/covers phải không tạo giao dịch mới.
- Map đúng `.ts → .js` cho 5 file runtime: controller b2b-pos, DTO b2b-pos-order + restaurant-pos-metadata, service b2b-pos + restaurant-pos-metadata. Test không nằm trong artifact runtime.

### R2 — Client không đổi payload giữa các lần gửi

- Dùng mapper browser-safe chia sẻ cho Windows và Android, cùng schemaVersion và đơn vị dữ liệu.
- Chọn version qua capability đã xác minh. Không tự thêm field khi server cũ trả 404; 401/403/network không đồng nghĩa server không hỗ trợ.
- Lưu chính xác DTO và identity trước HTTP đầu tiên; retry/restart/dổi capability không được dựng payload khác cho cùng attempt.
- Đơn cũ đã có lần gửi không rõ kết quả không được tự nâng payload. Không mất thông tin đang lưu trên máy; mọi chuyển trạng thái phải có durability barrier.
- Kiểm thử hai hệ với cùng fixture: tiền/thuế/giảm giá/tip/tenders giữ nguyên; notes/course/table/covers round-trip; storage fail, response lost, reload, salon switch.
- Ghi file impact cụ thể sau khi agent A đọc luồng hiện tại; không thêm abstraction trùng sẵn có.

### R3 — Kiểm thử tích hợp và review phát hành

- Agent chính xem diff và chạy lại các test liên quan; không chỉ tin báo cáo subagent. Có negative/mutation probe chứng minh assertion bắt được lỗi.
- Typecheck, Android/restaurant suites, Windows build, Android web/native boundary và browser layout tests.
- Backend typecheck, DTO/service/replay tests, compile tương thích production bằng lane exact-file.
- Xác minh API hỗ trợ v1 thật trên preview; không gửi đơn thử/in/thu tiền vào production để smoke test.
- Gate NO-GO nếu có lỗi tiền, retry, tenant, migration bảo toàn dữ liệu, artifact không rõ nguồn.

### R4 — Backend production

1. Chỉ commit đúng file được review trong worktree; ghi test và rollback manifest.
2. `session.sh land` vào canonical, fetch production, deploy-preflight rồi check-only exact-file. Không tự dọn WIP/migration lệch của phiên khác.
3. Chỉ chạy `--yes` khi preflight/check-only qua, trong giờ cho phép hoặc có phê duyệt vượt giờ riêng. Không SCP/rsync/PM2 tay lên Contabo.
4. Lane build isolated production + exact source; backup/hash; tự rollback artifact nếu health fail.
5. Verify health, auth, route capabilities, symbol/artifact hash, PM2 và log mới. Lane hiện poll tối đa 300 giây (60 × 5 giây; boot thường 45–90 giây); chia lượt nhận output ngắn để cập nhật người dùng.
6. Nếu runtime lên nhưng mirror/ref thất bại: báo trạng thái lệch, dừng lần deploy tiếp; không tự manual rollback.

### R5 — Android/Windows phát hành thiết bị

- N0 — sửa mâu thuẫn chính sách mạng của spike tháng 7: POS thật cần quyền Android INTERNET cho HTTPS login/catalog/sync. Thêm đúng quyền này, yêu cầu nó trong merged-manifest gate và cập nhật test chính sách cùng lúc. Giữ nguyên `usesCleartextTraffic=false`, network-security cleartext=false, backup/debug/FileProvider/signing/package locks; không cấp camera/location/storage/USB/Bluetooth tùy tiện. Có executable negative tests cho thiếu INTERNET và quyền lạ, không chỉ sửa assertion để xanh.
- Phạm vi N0: manifest Android, manifest verifier/helper nếu cần, test stage1/native manifest, ghi chú supersession trong docs spike. Subagent native sở hữu; parent review/test độc lập trước snapshot mới. INTERNET không tự xác minh thiết bị thật, backend write authority hay signing production.
- Chốt model Android, phiên bản hệ điều hành, máy in/scanner/cân/terminal và kênh cài bản test; không suy ra từ Sunmi cũ.
- Build bằng toolchain đúng pin, test native, background/kill/restart/rotate/offline; tiền mặt/thẻ/thanh toán tách, lưu/mở check, hai bàn và quán không bàn.
- Package ID, signing certificate, versionCode và khả năng nâng cấp giữ dữ liệu phải xác minh trước publish. Chuẩn bị gói bản cũ + kế hoạch khôi phục dữ liệu; không downgrade schema bằng xóa DB.
- Cài pilot trên máy thử đã chọn rồi mới rộng hơn. Restart POS quầy thật chỉ khi người dùng/nhân viên xác nhận quầy rảnh.
- Thiếu model/ký/kênh phát hành = dừng ở artifact test đã ghi rõ, không coi backend deploy là Android đã được nâng cấp.

## 4. Tiêu chí báo cáo kết quả

Tách rõ: đã code / đã test / đã commit / đã live backend / đã tạo APK / đã cài máy / đã nghiệm thu. Mỗi mức có SHA, file manifest và kết quả thực. Kết quả parity toàn app chỉ DONE khi các nhóm còn thiếu trong master plan đã đạt, không gắn nhãn 100% cho một đợt metadata.

## Nhật ký

### Cập nhật tiếp theo: P2 history (08/09, khoảng 11:20 Warsaw)

- Shared history UI và server header mapper đã sửa, 11 suites / 128 tests PASS; Android web/sync/boundary PASS. Chưa có APK mới chứa sửa đổi này.
- R1 cần bổ sung explicit server orderItemId cho restaurant snapshot lines trước khi tuyên bố round-trip ghi chú/course hoàn tất. Đã ghi yêu cầu server cụ thể trong `android-history-p2-followup-2026-09-08.md`; không sửa production/không ghép theo thứ tự mảng.
- Android refund receipt trước đây gọi nhầm in đơn bán; đã chặn, báo unsupported, không gửi in. Đây là sửa an toàn, chưa phải triển khai phiếu hoàn tiền thật. Lịch sử server/getRefundDetail/native refund history và print metadata còn thiếu; xem `android-history-native-p2-2026-09-08.md`.
- Canonical backend c6576a51 chưa được deploy trong lượt này. Không suy ra phê duyệt vượt khóa giờ bán từ yêu cầu “làm theo kế hoạch”. Không gắn trạng thái GO/100% khi còn các thiếu sót nghiệp vụ và signing/device acceptance.

### Nhật ký giai đoạn trước

- Bắt đầu R0; đọc quy trình deploy-gate/deploy-enail; giờ hiện tại 10:26 Warsaw thuộc giờ khóa backend. Đã hỏi lựa chọn ngoài giờ hoặc phê duyệt cập nhật trong giờ bán, chưa có trả lời.
- R0 preflight PASS (không phải deploy): canonical `83b9f5b7`, production snapshot `2fba8077`, không có migration lệch/active deploy; vẫn khóa giờ bán. Phải kiểm lại refs và khóa trước lần triển khai thật.
- Có 119 backend source path khác production. Trong phạm vi 5 artifact dự kiến, service POS mang thêm thay đổi tip/tender và làm tròn hoàn tiền đã có trên trunk (124 dòng diff; không có import mới), DTO tip thêm `Min(0)`. Không được gọi đây là gói chỉ-metadata: cần review/test các thay đổi tài chính đi kèm trước quyết định phát hành.
- Đọc runbook dist drift; 5 artifact dự kiến không có trong manifest drift lịch sử, nhưng manifest cũ không chứng minh bytes production hiện tại. Lane phải xác minh nguồn/artifact trước deploy.
- Baseline HTTP production: health, `/vi/login`, `/app/mail-inbox` đều trả 200; đây chỉ là kiểm tra HTTP trước deploy, không phải xác nhận đăng nhập hoặc nghiệp vụ.
- R1 review phát hiện nhánh fallback `dto.id` có thể trả đơn cũ dù metadata thay đổi khi key khác/thiếu; agent backend đang sửa và bổ sung regression test.
- R5 native assessment: gate NO-GO với 22 bằng chứng/quyết định chưa đóng; R12 đã PASS. Không có thiết bị Android kết nối, package vẫn diagnostics/dev, chưa có APK của snapshot parity. Báo cáo chi tiết: `android-native-release-readiness-2026-09-08.md`. Đang chuẩn bị JDK đúng pin riêng cho build test, không thay Java hệ thống.
- Parent đã chạy riêng 6 suite nhà hàng: 117 test PASS. Backend 6 suite: 127 test PASS (lần đầu 2 đường dẫn test bị nhập sai; chạy lại đúng đường dẫn đạt 27 test còn lại; không phải lỗi source).
- R1 sửa cả race `dto.id`: sau unique violation, chỉ đọc đúng salon + POS discriminator rồi so hash; không trả đơn tenant khác hoặc đơn B2B khác loại. Agent đã chứng minh regression fail trước/sau sửa. Parent đã đọc diff và chạy lại test.
- `--check-only` chỉ preflight, **không build**. Vì vậy agent đang build/test riêng snapshot `origin/production=2fba8077` + đúng 5 file runtime; 6 test input được overlay để chạy đủ regression. Chưa chuyển artifact này tới production.
- Isolated production-shaped build đã PASS, 127 test PASS; parent xác minh lại source SHA-256/compiled imports. Backend đã commit đúng 7 file (`ed87b916`, trước rebase); chưa land hoặc deploy. Land đầu bị cache graft rỗng do chẩn đoán tạo ra, đã giữ nguyên cache ở `/var/tmp/android-pos-prodcheck-20260908.YKAv00/graft-cache-preserved`; lần sau gặp lifecycle lock phiên khác, không phá lock.
- Parent gate mở rộng: 29 suite / 400 test PASS; đã cập nhật assertion schema test từ 6 lên 7 và kiểm tra default legacy=0. Windows `npm run build` PASS; Android sync/bundle/native-asset boundary PASS (149 source, 5 bundle, 7 copied asset files). Chưa phải APK native build.
- Native kiểm tra phát hiện manifest spike cũ chưa có INTERNET và gate chủ động cấm quyền này. N0 được đưa vào phạm vi yêu cầu POS thật của người dùng; APK snapshot trước N0 chưa được build và không được quảng cáo login được.
- Backend đã land bằng session helper: `origin/main=c6576a518311b81171d566c4c919f7e2355bce85`. Preflight mới và exact-file `--check-only` PASS. Production vẫn `2fba8077`, chưa chạy `--yes`, chưa restart. Chờ lựa chọn giờ triển khai; không tạo lịch tự động khi chưa có yêu cầu.
- Parent browser gate: 13/13 test PASS, gồm built Windows/Android CSS và viewport cảm ứng; đây là fixture Chromium, không phải APK trên thiết bị.
- Hợp đồng capability xác minh raw object, không có response wrapper. Read-only CORS OPTIONS với Origin `https://localhost` (Capacitor Android mặc định) trả 204 + đúng Access-Control-Allow-Origin và authorization; không cần nới CORS backend. Chưa xác nhận login/giao dịch native thật.
- Parent kiểm tra N0: diff chỉ cấp INTERNET, merged gate yêu cầu quyền hiện diện và từ chối quyền lạ; 18 test thực thi chính verifier + stage1/build-only/readiness = 97 test PASS. Thêm 26 test migration và receipt-outbox lifecycle PASS. Không thay policy signing/dev package.
- N1 hoàn tất: snapshot source hash `6b88d7898b58ad2c5230853f7928d2738ccef1141e43a52b96ada7559befaead`, 2.213 input files không đổi sau build; 27 web files hash-identical dist → native assets → APK. Native preflight/build/debug+release manifest gates PASS với Node 22.22.2, npm 10.8.2, JDK 21.0.11, SDK 36. Native unit suite chỉ có 1 test cơ bản mỗi variant, không chứng minh nghiệp vụ thiết bị.
- APK test local: `C:/Users/maxis/enail/POS-zira-artifacts/android-parity-test-20260908T085617Z/Zira-POS-1.0.26-2026090801-WIP-TEST.apk`; SHA-256 `2d456368e905aebec4ef6ad02a956437cb8acc819f48a0d264616f80c2d6d4ce`. Parent xác minh độc lập checksum và aapt2: package `com.ziraai.posdiagnostics.dev`, version 1.0.26/code 2026090801, minSDK 28/targetSDK 36, có INTERNET. Debug signer; release APK/AAB vẫn unsigned và giữ làm evidence, không phát hành.
- Kết thúc đợt này: 3 subagent hoàn tất; backend main đã land nhưng production vẫn chưa đổi; chưa cài/login native, chưa kiểm thử nâng cấp giữ dữ liệu/in/thanh toán thật. Dependency audit toàn bộ prod dependencies có 17 advisory (10 moderate, 7 high, 0 critical), chưa chứng minh phạm vi ảnh hưởng Android. Các phần parity còn thiếu và signing/device acceptance vẫn NO-GO; không tuyên bố 100% hoặc production hoàn tất. Chưa nhận trả lời về giờ deploy và model/máy Android thử.

## Backend release manifest đã kiểm tra (chưa live)

Canonical commit `c6576a518311b81171d566c4c919f7e2355bce85`; production base `2fba8077b8fb768b5e4630b58badcb7fa14e0855`. Build kiểm chứng riêng: `/var/tmp/android-pos-prodcheck-20260908.YKAv00`. Năm source dưới `backend/src/modules/b2b/` ánh xạ tương ứng sang `backend/dist/modules/b2b/*.js`:

| Source | SHA-256 source đã build/test |
|---|---|
| `dto/b2b-pos-order.dto.ts` | `c5d4edc354e857c30f124bc10743c6c731066a6f45f05acdcf659d300ae107dc` |
| `dto/restaurant-pos-metadata.dto.ts` | `6368459617e23716ba8de78117a618e7b3c9479052905e2a8aed1161e423cf75` |
| `services/b2b-pos.service.ts` | `c1bb3eb04252ec728767351044526afb91aeb4c38f977269b1898b0846cf61d3` |
| `services/restaurant-pos-metadata.ts` | `db69d34929a406bc0f279e8e443ba7ead1b47cc60202202badd8540ca94ffc5a` |
| `controllers/b2b-pos.controller.ts` | `112e4681941c3b91999a0b3e424d39c15dbaca1109bdebe8d73e854c21878bf4` |

Lane thật phải build lại từ production snapshot hiện hành + canonical exact source, không copy artifact thử bằng tay. Nếu source/ref/lock/migration thay đổi phải chạy lại gate; không lấy bảng này để bỏ qua guard. Whole-file financial drift `07f0233c` và `629fc904` đã được nêu và kiểm thử ở trên.
