# Yêu cầu phối hợp backend Zira — POS nhà hàng

Trạng thái: **bản nháp phục vụ kế hoạch**, chưa gửi sang task/server khác, chưa xác nhận API và chưa cho phép triển khai.

**Quyết định phạm vi 08/09/2026:** người dùng chốt Android bán độc lập với Windows. Các đề xuất bên dưới về cùng sửa/settle một check liên thiết bị và realtime chia sẻ check là phương án dự phòng, **không thuộc đợt triển khai hiện tại**. Trọng tâm khảo sát là metadata đơn đã trả, chống trùng khi sync/retry, phạm vi salon/thiết bị và dữ liệu cấu hình bàn. Đơn đang mở và trạng thái phục vụ bàn phải tách theo thiết bị; không tự ghi trạng thái local thành occupied chung trên server. Quyết định này không xác nhận khả năng offline hoặc API nào đã tồn tại.

## Mục đích

POS Windows và Android cần giữ đúng ngữ cảnh đơn nhà hàng. Nếu Android nhận món tại bàn và Windows thanh toán cùng đơn, backend còn phải cung cấp trạng thái check đang mở và xử lý xung đột. Hiện payload đồng bộ được review bỏ table/covers và notes/course; không thể tự thêm trường client trước khi xác minh DTO whitelist.

## Việc cần khảo sát chỉ đọc trước

1. Tìm entity/DTO/controller/service hiện có của bàn, open check, POS order, kitchen/pickup; liệt kê endpoint và role guard thực tế, không tạo API trùng tên khác.
2. Xác nhận DB schema, quan hệ salon, cách trừ kho và thời điểm ghi nhận tiền/thuế; open check tuyệt đối không kích hoạt side effect của paid order.
3. Xác nhận các đường POS create/sync-log/read-back đang xử lý những trường nào; ghi rõ unsupported thay vì giả định.
4. Áp dụng mô hình đã chốt: Android và Windows bán độc lập; xác minh định danh thiết bị/đơn và ngăn thao tác máy này ảnh hưởng check đang mở của máy khác.

## Contract cần được xác nhận

| Năng lực | Đầu vào/đầu ra cần thống nhất | Yêu cầu |
|---|---|---|
| Danh sách/chi tiết bàn | ID, khu vực, capacity, trạng thái, active check | Salon-scope, error khác empty, không occupied chỉ vì xem |
| Mở/lưu/đọc check | Check ID, loại phục vụ, bàn, nhân viên, số khách, dòng món, revision | ID ổn định, bền vững; không tự PAID hoặc trừ kho |
| Metadata dòng | Variant, quantity/unit, notes, course; modifiers theo capability | Validate, persist, trả lại đầy đủ |
| Metadata thực hiện | Takeout recipient/time; delivery name/phone/address/time/instructions/fee khi bật | Validation + privacy, phí/thuế theo quy tắc backend |
| Đồng bộ order đã trả | Check reference, table/covers/type/notes/course/tip và trường hỗ trợ | Tương thích cả sync-log và direct POS order; không nhân đôi |
| Chỉnh sửa liên thiết bị | Expected revision, quyền/ownership, lỗi conflict | Không last-write-wins âm thầm, không nới tenant/user scope |
| Thanh toán/settle | Check ID, attempt/idempotency identity, revision | Atomic, retry an toàn, trạng thái bất định có đối soát |
| Gửi bếp/gọi thêm/hủy | Dòng và revision, course, job/attempt ID | Không gửi lại món cũ; có trạng thái đã gửi/chưa rõ/lỗi |
| Cập nhật realtime | Event cho check/table/kitchen kèm version | Reconnect tải lại nguồn chuẩn; sự kiện trùng/out-of-order không hạ revision |
| Capability/version | Những phần restaurant thật sự được backend hỗ trợ | Client không đổi lỗi thành danh sách bàn rỗng hoặc success giả |

Đường dẫn/method HTTP, tên DTO/entity và mã lỗi cuối cùng phải lấy từ API hiện có hoặc được đề xuất rõ trong phản hồi khảo sát. Bảng này chưa khẳng định endpoint nào đang tồn tại.

## Nguyên tắc dữ liệu và quyền

- Query/mutation/event luôn scope theo salon từ auth; quyền STAFF/MANAGER/OWNER cho sửa, chuyển, hủy, giảm giá và thu tiền phải được xác nhận.
- Không tin số tiền/phí/modifier từ client nếu chưa kiểm tra. Quy đổi minor units/decimal ở biên đúng một lần, bảo toàn tiền và số lượng cân.
- Check chưa thanh toán không bị xóa vì giới hạn danh sách hoặc retention của cache/Hold.
- Migration additive/versioned, không xóa/đổi tên trường phá client cũ; có test đọc dữ liệu cũ và rollback tương thích.
- Khi offline/mất quyền sửa, client không được tự tuyên bố nhận quyền thu tiền/gửi bếp. Chính sách tiếp tục bán cục bộ phải được chốt riêng.

## Bằng chứng bàn giao cần có

- Danh sách file/entity/endpoint thật + request/response đã loại bỏ dữ liệu nhạy cảm.
- Ma trận field: frontend draft → local persistence → DTO → DB backend → response → hai nền tảng.
- Test tenant isolation, cùng check sửa đồng thời, retry create/settle, mạng rớt sau commit, duplicate kitchen send.
- Mô tả migration, version/capability gate và bộ client tối thiểu tương thích.
- Artifact build/test từ máy phát triển; không build/thử nghiệm ad-hoc trên Contabo production.

Không thay đổi backend hoặc triển khai chỉ vì tài liệu này tồn tại. Nếu server chưa có các năng lực cần thiết, phần client phụ thuộc phải chờ yêu cầu thay đổi được xác nhận, không thêm workaround mong manh.
