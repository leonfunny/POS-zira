# Server change request: idempotency và recovery cho remote shift close Android

**Trạng thái:** Chỉ là yêu cầu thay đổi server. Chưa có implementation, migration, deploy hay thay đổi production. POS runtime hiện tại phải giữ nguyên và mọi hành vi mới phải được gate bằng capability opt-in.

## 1. Vấn đề cần giải quyết

Android cần có thể phục hồi an toàn khi đóng ca từ xa nhưng server đã commit còn response/ACK bị mất. Với contract hiện tại, client không thể phân biệt ca đã đóng thành công với ca sai hoặc không tồn tại; vì vậy không được coi `404` là thành công và cũng không được retry mù.

## 2. Bằng chứng hiện tại

Bằng chứng parent Tier 2 cho project `POS-zira-release-foundation`, generation `2026-09-08T23:11:40Z`:

- Android real-transport `closeShift` dòng 1487–1517 lưu local snapshot, flush dữ liệu rồi gửi `POST` theo kiểu fire-and-forget; không có durable outbox cho close request.
- `PosApiClient.closePosShift` dòng 1064–1086 chỉ gửi `POST` với `closingCash`.
- Windows `ShiftController` có các cột retry và cơ chế retry, nhưng đang coi `404/409/410` là terminal.
- Backend DEV được đọc read-only tại `/var/www/www/enail/.worktrees/android-pos-restaurant-parity-20260908`: `PosShiftService.closeShift` từ dòng 99 lock/query chỉ theo `{ id, salonId, closedAt: IsNull() }`; không tìm thấy thì ném `NotFound('Open shift not found')`.
- Route `POST` hiện không nhận idempotency key. Chỉ có `GET active by machine`, không có lookup theo shift ID hoặc close request ID.

Coverage của các source path trên không ghi nhận gap, nhưng có trạng thái `metadata_changed` nên source đã được đọc trực tiếp. Tests bị loại bởi fast-pattern. Đây là bằng chứng thiết kế, không phải xác nhận production hiện hành.

### Failure mode bắt buộc phải xử lý

1. Server đóng ca và commit.
2. ACK bị mất trước khi Android nhận response.
3. Retry contract cũ truy vấn chỉ ca đang mở, nên chính ca vừa đóng không còn khớp và có thể trả `404`.
4. Cùng `404` cũng có thể xuất hiện khi shift sai/không tồn tại.

Do đó client không có bằng chứng để xác nhận thành công, nhưng retry không định danh cũng có thể tạo hành vi sai hoặc che mất lỗi dữ liệu.

## 3. Contract additive được yêu cầu

### Capability và request

- Server quảng bá capability mới, ví dụ `shiftCloseIdempotencyVersion: 1`.
- Chỉ client đã thấy capability này mới gửi contract V1. Request legacy không có version/key phải giữ nguyên hành vi hiện tại.
- V1 yêu cầu `closeRequestId` là UUID ổn định, được tạo và lưu bền vững trước lần gửi đầu tiên. Nếu dùng header `Idempotency-Key`, giá trị phải bằng `closeRequestId` trong body.
- Evidence bất biến của request gồm: authenticated `salonId`, `machineId`, `shiftId`, `closingCash` theo representation tiền tệ canonical, authenticated operator ID/role và contract version. Server phải tạo canonical fingerprint từ toàn bộ evidence này; không tin `salonId` hoặc quyền operator do client tự khai.

### Idempotency và response

- Lần xử lý mới hợp lệ phải đóng ca và lưu `closeRequestId`, canonical fingerprint, operator evidence cùng canonical close result trong **cùng một transaction**.
- Replay cùng `closeRequestId`, cùng authenticated scope và cùng frozen evidence phải trả lại cùng canonical close result, kể cả khi shift hiện đã đóng. Replay không được tính toán hoặc đóng ca lần hai.
- Dùng lại cùng key với bất kỳ evidence nào khác phải trả `409` với code riêng, ví dụ `SHIFT_CLOSE_IDEMPOTENCY_CONFLICT`; không dùng chung với lỗi “shift đã đóng”.
- Request mới cho shift đã đóng phải trả lỗi typed riêng, ví dụ `SHIFT_ALREADY_CLOSED`, không giả thành replay thành công và không gộp với `SHIFT_NOT_FOUND`.
- Canonical result tối thiểu gồm `closeRequestId`, `salonId`, `machineId`, `shiftId`, operator ID, `closingCash`, server `closedAt` và toàn bộ snapshot/kết quả close authoritative mà route hiện trả về.

### Reconciliation lookup

Cung cấp read-only lookup V1 trong cùng authenticated salon scope:

- `GET .../shift-close-requests/:closeRequestId`: trả canonical committed result; nếu không có trả `404 SHIFT_CLOSE_REQUEST_NOT_FOUND`.
- Nếu recovery cần đối chiếu khi local key bị hỏng/mất, bổ sung `GET .../shifts/:shiftId/close-status`: phân biệt rõ `OPEN`, `CLOSED` và `SHIFT_NOT_FOUND`, kèm canonical close identity/result khi đã đóng.

Lookup phải kiểm tra salon, machine/operator policy như close route và không được làm thay đổi trạng thái.

## 4. Transaction và locking

- Dùng database transaction và row-level locking. Mọi close flow V1 phải theo cùng lock order cho idempotency record rồi shift record để tránh race/deadlock.
- Unique constraint tối thiểu trên `(salon_id, close_request_id)`; concurrent duplicate phải hội tụ về một committed result.
- Shift phải được tìm theo `{id, salonId}` rồi lock, sau đó mới đánh giá trạng thái đóng; không lọc `closedAt IS NULL` trước khi có cơ hội nhận diện replay.
- Validate machine binding, operator authority và frozen evidence dưới lock. Close mutation, snapshot, idempotency record và canonical response phải commit atomically; lỗi phải rollback toàn bộ.
- Side effects/event chỉ phát sau commit. Retry sau timeout, restart hoặc concurrent request không được phát close event lần hai.

## 5. Compatibility và client gate

- Đây là contract additive. Legacy Android/Windows và request không opt-in tiếp tục dùng contract cũ; không đổi ngầm ý nghĩa `404/409/410` cho chúng.
- Android chỉ bật remote close recovery sau khi: capability V1 được xác nhận, `closeRequestId` cùng frozen payload được lưu bền vững trước send, và có outbox/reconciliation lifecycle an toàn.
- Trước gate đó, POS runtime giữ nguyên. Không được coi `404` hiện tại là success, bỏ lỗi terminal một cách đại trà, hoặc tự động retry close không có cùng key.

## 6. Acceptance tests bắt buộc

- Commit thành công nhưng mất ACK; retry cùng key trả đúng một canonical result và chỉ một lần đóng ca.
- Replay sau shift đã đóng, process restart và concurrent duplicate đều trả cùng result.
- Cùng key nhưng khác `shiftId`, `machineId`, `closingCash`, salon hoặc operator evidence trả `409 SHIFT_CLOSE_IDEMPOTENCY_CONFLICT` và không mutate.
- Shift sai/không tồn tại, khác salon, sai machine hoặc operator không đủ quyền bị từ chối bằng code phân biệt và không mutate.
- Request mới cho shift đã đóng không bị coi là replay; replay đúng key vẫn thành công.
- Race giữa hai close request khác key cho cùng shift chỉ có một winner; loser nhận lỗi typed, không có snapshot/event trùng.
- Rollback ở mọi điểm lỗi không để lại shift đóng nửa chừng hoặc idempotency record giả committed.
- Lookup theo request/shift tuân thủ tenant boundary và trả đúng trạng thái sau ACK loss.
- Regression cho legacy Android/Windows chứng minh contract cũ không đổi khi không opt-in capability.

## 7. Thứ tự rollout đề xuất

1. Chốt DTO, error codes, capability và schema/migration trong backend DEV.
2. Implement transaction/idempotency/lookup và chạy unit, integration PostgreSQL, concurrency và HTTP tests tại DEV.
3. Thêm Android durable outbox, frozen payload và reconciliation nhưng vẫn để feature gate tắt.
4. Kiểm tra regression Windows và mixed-version clients.
5. Chỉ sau acceptance đầy đủ mới bật capability/client gate theo rollout riêng đã được phê duyệt.

Tài liệu này không phê duyệt deploy, production mutation, PM2 restart, APK release hoặc thay đổi runtime POS hiện tại.
