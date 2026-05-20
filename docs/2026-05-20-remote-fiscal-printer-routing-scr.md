# Backend Spec: Remote Fiscal Printer Routing

Ngày: 2026-05-20  
Owner phía client: Zira Electron Print Agent  
Mục tiêu: cho POS 2 dùng máy in tài chính đang cắm ở POS 1 thông qua backend, nhưng **không thay đổi** luồng driver tài chính local đang hoạt động ở POS 1.

## 1. Tóm Tắt

Hiện tại client Electron đã có nền tảng route print job theo `printerId`. POS owner nhận socket job, `HardwareModule` resolve `printerId` sang driver local, rồi in bằng driver thật. Shared receipt đang dùng cơ chế này cho order copy, nhưng fiscal chưa được phép đi qua remote route vì fiscal cần kết quả cuối cùng, idempotency và trạng thái `UNKNOWN`.

Backend cần thêm contract để:

1. Lưu printer assignments theo role salon-wide, gồm `FISCAL_RECEIPT`.
2. Trả về danh sách printer online/readiness toàn salon.
3. Tạo fiscal print job dạng blocking: POS gọi API, backend gửi job tới owner POS, rồi API chỉ trả về khi job có trạng thái cuối `COMPLETED`, `FAILED`, `UNKNOWN`, hoặc `TIMEOUT`.
4. Không bao giờ coi `sent=true` hoặc socket delivery là fiscal success.

## 2. Nguyên Tắc Không Được Phá

- POS đang cắm máy in tài chính là process duy nhất mở COM/IP/sidecar.
- POS khác không được edit COM port, protocol, Windows printer name, hay driver settings của printer thuộc owner POS khác.
- Không expose POSNET/ELZAB COM port qua mạng.
- Không bypass fiscal attempt journal local của client, đặc biệt ELZAB `UNKNOWN_NEEDS_RECONCILIATION`.
- Không retry fiscal job tự động nếu owner POS trả `UNKNOWN`.
- Không dùng shared receipt `SELF_CHECKOUT_RECEIPT` cho fiscal.

## 3. Model Hiện Có Ở Client

Client đã có các type/role chuẩn bị sẵn:

```ts
type SalonPrinterRole =
  | 'SELF_CHECKOUT_RECEIPT'
  | 'POS_RECEIPT'
  | 'FISCAL_RECEIPT'
  | 'KITCHEN'
  | 'LABEL'
  | 'A4';
```

Client Settings hiện chỉ bật live route `SELF_CHECKOUT_RECEIPT`. Các role khác hiển thị ở trạng thái planned cho tới khi backend hỗ trợ.

Luồng local fiscal hiện tại:

```text
PaymentController.printFiscalReceipt(orderId)
  -> getPrinter(PrinterType.FISCAL)
  -> local POSNET/ELZAB driver
```

Luồng này phải giữ nguyên khi không có `FISCAL_RECEIPT` assignment.

## 4. Data Model Backend Cần Có

### 4.1 `print_agents`

Đã có hoặc cần có:

```text
id
salon_id
api_key_hash
machine_id
name / display_name
app_version
is_online
last_seen_at
paired_at
status
```

Identity phải là physical installation identity. Không được collapse nhiều POS cùng salon vào một `print_agents.id`. Backend trước đây đã cần fix bằng `(salon_id, machine_id)` hoặc `(apiKeyHash, machineId)`.

### 4.2 `print_agent_printers`

Mỗi physical/configured printer là một row:

```text
id
salon_id
agent_id
printer_type          -- RECEIPT | FISCAL | LABEL | A4 | TICKET | KITCHEN
display_name
protocol              -- THERMAL | WINDOWS | POSNET | ELZAB_STX | ZEBRA
windows_printer_name
address               -- COM3, IP/host, or other backend target string
baud_rate
paper_width
paper_height
chars_per_line
supports_cut
supports_cash_drawer
is_enabled
is_online             -- physical/device health from owner POS
last_error
last_checked_at
last_used_at
created_at
updated_at
```

Important:

- `is_online` phải phản ánh `device:status.printerStatuses[]` của owner POS.
- `agent.is_online` và `printer.is_online` là hai trạng thái khác nhau.
- Printer có row không có nghĩa là online. Row chỉ là configured/installed.

### 4.3 `salon_printer_assignments`

Tạo hoặc mở rộng table:

```sql
CREATE TABLE salon_printer_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL,
  role TEXT NOT NULL,
  printer_id UUID NOT NULL REFERENCES print_agent_printers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (salon_id, role)
);
```

Validation:

```text
SELF_CHECKOUT_RECEIPT -> printer_type = RECEIPT
POS_RECEIPT           -> printer_type = RECEIPT
FISCAL_RECEIPT        -> printer_type = FISCAL
KITCHEN               -> printer_type = KITCHEN
LABEL                 -> printer_type = LABEL
A4                    -> printer_type = A4
```

For `FISCAL_RECEIPT`, protocol must be `POSNET` or `ELZAB_STX`.

### 4.4 `print_jobs`

Existing job table should support these fields, or equivalent:

```text
id
salon_id
agent_id              -- owner print agent target
printer_id
job_type              -- RECEIPT, LABEL, INFO_LABEL, etc.
printer_type          -- FISCAL, RECEIPT, ...
payload_json
reference_type
reference_id
idempotency_key
blocking              -- boolean
status                -- PENDING | SENT | PRINTING | COMPLETED | FAILED | UNKNOWN | TIMEOUT | CANCELLED
error_code
error_message
result_json
created_by_agent_id   -- caller POS, optional
created_at
sent_at
printing_at
completed_at
updated_at
```

Recommended unique constraint for fiscal:

```sql
CREATE UNIQUE INDEX uniq_fiscal_print_job_idempotency
ON print_jobs (salon_id, printer_id, idempotency_key)
WHERE printer_type = 'FISCAL' AND idempotency_key IS NOT NULL;
```

If duplicate request arrives with same idempotency key, return the existing job status instead of creating a second fiscal command.

## 5. API Contract

### 5.1 List Salon Printers

Existing/desired endpoint:

```http
GET /api/v1/print-agent/salons/me/printers
```

Optional query:

```text
shareableOnly=true
role=SELF_CHECKOUT_RECEIPT | POS_RECEIPT | FISCAL_RECEIPT | KITCHEN | LABEL | A4
```

Response:

```json
{
  "printers": [
    {
      "id": "printer-id",
      "agentId": "owner-agent-id",
      "machineId": "owner-machine-id",
      "agentName": "POS 1",
      "agentIsOnline": true,
      "agentLastSeenAt": "2026-05-20T17:00:00.000Z",
      "displayName": "POSNET Fiscal",
      "printerType": "FISCAL",
      "protocol": "POSNET",
      "windowsPrinterName": null,
      "address": "COM3",
      "isEnabled": true,
      "isOnline": true,
      "lastError": null,
      "lastCheckedAt": "2026-05-20T17:00:00.000Z",
      "lastUsedAt": null
    }
  ]
}
```

Readiness semantics:

```text
configured = row exists and target exists
enabled    = isEnabled !== false
owner app online = agentIsOnline === true
device online = isOnline === true
ready = configured && enabled && owner app online && device online
```

### 5.2 List Assignments

```http
GET /api/v1/print-agent/salons/me/printer-assignments
```

Response:

```json
{
  "assignments": [
    {
      "id": "assignment-id",
      "salonId": "salon-id",
      "role": "FISCAL_RECEIPT",
      "printerId": "printer-id",
      "createdAt": "2026-05-20T17:00:00.000Z",
      "updatedAt": "2026-05-20T17:00:00.000Z"
    }
  ]
}
```

### 5.3 Upsert Assignment

```http
PUT /api/v1/print-agent/salons/me/printer-assignments/:role
Content-Type: application/json
```

Request:

```json
{
  "printerId": "printer-id"
}
```

Validation:

- Auth user/token must belong to the same salon.
- `printerId` must belong to same salon.
- `role` must be known.
- `printer_type` must match role.
- For `FISCAL_RECEIPT`, printer must be `FISCAL` and protocol must be `POSNET` or `ELZAB_STX`.
- Do not require caller POS to own the printer. Any authorized salon POS/admin can select a ready salon route.
- Editing printer hardware fields remains restricted to owner agent/admin endpoints.

Response:

```json
{
  "assignment": {
    "id": "assignment-id",
    "salonId": "salon-id",
    "role": "FISCAL_RECEIPT",
    "printerId": "printer-id",
    "updatedAt": "2026-05-20T17:00:00.000Z"
  }
}
```

### 5.4 Delete Assignment

```http
DELETE /api/v1/print-agent/salons/me/printer-assignments/:role
```

Return `204` or updated assignment list.

### 5.5 Create Non-blocking Print Job

Existing endpoint may remain:

```http
POST /api/v1/print-agent/jobs
```

For non-fiscal receipt/label jobs, current behavior can remain. Returning `sent=true` is acceptable only for soft side effects.

### 5.6 Create Blocking Fiscal Print Job

Add one of these options:

Option A: extend existing endpoint:

```http
POST /api/v1/print-agent/jobs
```

Option B: explicit endpoint:

```http
POST /api/v1/print-agent/jobs/blocking
```

Request:

```json
{
  "jobType": "RECEIPT",
  "printerType": "FISCAL",
  "printerId": "fiscal-printer-id",
  "payload": {
    "orderId": "order-id",
    "paymentId": "payment-attempt-id-or-null",
    "orderNumber": "POS-20260520-001",
    "items": [],
    "payment": {},
    "subtotal": 1000,
    "total": 1000
  },
  "referenceType": "POS_FISCAL_RECEIPT",
  "referenceId": "order-id",
  "idempotencyKey": "order-id:payment-attempt-id-or-default",
  "blocking": true,
  "timeoutMs": 30000
}
```

Backend behavior:

1. Validate printer belongs to caller salon.
2. Validate printer is `FISCAL`.
3. Validate owner `agentIsOnline` and printer `isOnline`.
4. Upsert/find print job by idempotency key.
5. Send socket job only to owner `agent_id`.
6. Wait until final status or timeout.
7. Return final result to caller.

Response success:

```json
{
  "jobId": "job-id",
  "printerId": "fiscal-printer-id",
  "status": "COMPLETED",
  "fiscalStatus": "SUCCESS_CONFIRMED",
  "errorCode": null,
  "errorMessage": null,
  "result": null
}
```

Response failed:

```json
{
  "jobId": "job-id",
  "printerId": "fiscal-printer-id",
  "status": "FAILED",
  "fiscalStatus": "FAILED_CONFIRMED",
  "errorCode": "FISCAL_PRINTER_OFFLINE",
  "errorMessage": "Fiscal printer is offline on POS 1",
  "result": null
}
```

Response unknown:

```json
{
  "jobId": "job-id",
  "printerId": "fiscal-printer-id",
  "status": "UNKNOWN",
  "fiscalStatus": "UNKNOWN_NEEDS_RECONCILIATION",
  "errorCode": "OWNER_POS_DISCONNECTED_AFTER_SENT",
  "errorMessage": "Owner POS disconnected after fiscal command may have been sent",
  "result": null
}
```

HTTP status recommendation:

- `200` for final `COMPLETED`, `FAILED`, `UNKNOWN`, or duplicate idempotency returning existing state.
- `409` if duplicate idempotency maps to incompatible payload hash.
- `422` for invalid role/type/protocol payload.
- `503` if owner POS/printer is not ready before dispatch.
- `504` if blocking wait times out before final status.

Even on `504`, persist job as `TIMEOUT` or keep server-side status observable. Do not let the caller assume success.

## 6. Socket Contract

### 6.1 Backend -> Owner POS

Existing event can be reused:

```text
job:new
```

Payload:

```json
{
  "jobId": "job-id",
  "jobType": "RECEIPT",
  "printerType": "FISCAL",
  "printerId": "fiscal-printer-id",
  "payload": {},
  "referenceType": "POS_FISCAL_RECEIPT",
  "referenceId": "order-id",
  "createdAt": "2026-05-20T17:00:00.000Z",
  "blocking": true,
  "idempotencyKey": "order-id:payment-id"
}
```

Important routing rule:

```text
target socket room/connection = print_agent_printers.agent_id
not caller agent id
not random salon agent
```

### 6.2 Owner POS -> Backend

Existing event:

```text
job:status
```

Current client sends:

```json
{
  "jobId": "job-id",
  "status": "PRINTING",
  "errorMessage": null
}
```

Backend should accept current shape. For better fiscal diagnostics, future-compatible optional fields are recommended:

```json
{
  "jobId": "job-id",
  "status": "FAILED",
  "errorCode": "FISCAL_RESULT_UNKNOWN",
  "errorMessage": "ELZAB result is unknown after timeout",
  "fiscalStatus": "UNKNOWN_NEEDS_RECONCILIATION",
  "result": {}
}
```

If current client only sends `FAILED` with error text containing `FISCAL_RESULT_UNKNOWN`, backend should map it to `UNKNOWN` for blocking fiscal jobs.

Mapping recommendation:

```text
PRINTING  -> PRINTING
COMPLETED -> COMPLETED
FAILED + error contains FISCAL_RESULT_UNKNOWN -> UNKNOWN
FAILED + owner socket disconnected after PRINTING/SENT -> UNKNOWN
FAILED otherwise -> FAILED
```

### 6.3 Device Status

Client already sends:

```json
{
  "printerConnected": true,
  "printerPort": "FISCAL:POSNET",
  "scannerActive": true,
  "appVersion": "1.0.4",
  "printerStatuses": [
    {
      "printerId": "printer-id",
      "isOnline": true,
      "lastError": null
    }
  ]
}
```

Backend must update `print_agent_printers.is_online` by each `printerId`, not aggregate `printerConnected`.

## 7. Fiscal State Machine

Recommended backend statuses:

```text
PENDING
SENT
PRINTING
COMPLETED
FAILED
UNKNOWN
TIMEOUT
CANCELLED
```

Fiscal final semantics:

```text
COMPLETED = owner POS confirmed fiscal driver success
FAILED    = owner POS confirms fiscal command did not succeed before risky sent point
UNKNOWN   = command may have reached fiscal device; manual reconciliation required
TIMEOUT   = caller did not receive final status in time; treat as not successful
```

Caller POS must treat only `COMPLETED` as success.

## 8. Idempotency Rules

Fiscal print requests must include:

```text
idempotencyKey = orderId + ':' + (paymentId || 'default')
```

Backend must:

- Return existing final state for repeated same idempotency key.
- Not enqueue a second fiscal command for the same key.
- Detect incompatible duplicate payload and return `409`.
- Keep `UNKNOWN` sticky until a human/admin reconciliation resolves it.

## 9. Security And Permissions

Minimum:

- Caller must be authenticated and belong to the same salon.
- Caller can select assignment for same salon if it has POS/admin rights.
- Caller cannot edit hardware fields of printer rows owned by another POS agent.
- Owner POS socket must authenticate with `machineId`.
- Job dispatch must target the owner agent id for the selected `printerId`.

Recommended audit log:

```text
who selected route
who requested fiscal print
which printerId/agentId executed it
job final status
error/unknown reason
timestamps
```

## 10. Rollout Plan

### Phase 1: Backend inventory/assignment

- Add roles and validation.
- Ensure `GET /salons/me/printers` returns all salon printers with readiness fields.
- Allow POS 2 to assign `SELF_CHECKOUT_RECEIPT` to POS 1 ready receipt printer.
- Keep fiscal route hidden/planned in client.

### Phase 2: Blocking fiscal jobs

- Add blocking fiscal job create/wait.
- Map socket statuses into final fiscal states.
- Add idempotency protection.
- Add timeout/unknown behavior.

### Phase 3: Client fiscal route enablement

After Phase 2 deploy:

- Client adds `submitBlockingFiscalPrint()`.
- Client enables `FISCAL_RECEIPT` route in Settings.
- Client uses remote route only when assignment exists and printer is ready.
- If no assignment exists, current local fiscal path remains unchanged.

## 11. Backend Test Checklist

### Assignment tests

- Can assign `SELF_CHECKOUT_RECEIPT` to `RECEIPT`.
- Can assign `FISCAL_RECEIPT` to `FISCAL`.
- Cannot assign `FISCAL_RECEIPT` to `RECEIPT`.
- Cannot assign cross-salon printer.
- Cannot assign disabled/no-target printer if `shareableOnly` path requires readiness.

### Inventory tests

- `GET /salons/me/printers` returns printers from multiple POS agents in same salon.
- Response includes `agentIsOnline` and per-printer `isOnline`.
- A printer row remains configured but not ready when owner POS offline.
- `device:status.printerStatuses[]` updates the correct printer row by id.

### Blocking job tests

- Fiscal job targets owner agent of `printerId`, not caller agent.
- `COMPLETED` owner status returns success to waiting API.
- `FAILED` owner status returns failed result.
- Owner disconnect after `PRINTING` returns `UNKNOWN` or times out into non-success.
- Duplicate idempotency key returns existing job and does not emit second socket job.
- Duplicate key with different payload returns `409`.
- Printer offline before dispatch returns `503`.
- Blocking wait timeout returns `504` or status `TIMEOUT`, never success.

### Compatibility tests

- Existing non-fiscal `/print-agent/jobs` behavior remains unchanged.
- Existing `SELF_CHECKOUT_RECEIPT` assignments continue working.
- Existing Windows printer sync remains scoped by `machineId`.

## 12. Client Contract Expected After Backend Is Ready

Client will call something equivalent to:

```ts
const assignment = assignments.find(a => a.role === 'FISCAL_RECEIPT');
if (!assignment) {
  return printFiscalReceiptLocally(orderId);
}

const result = await api.createBlockingPrintJob({
  jobType: 'RECEIPT',
  printerType: 'FISCAL',
  printerId: assignment.printerId,
  payload: receiptData,
  referenceType: 'POS_FISCAL_RECEIPT',
  referenceId: orderId,
  idempotencyKey: `${orderId}:${paymentId || 'default'}`,
  blocking: true,
  timeoutMs: 30000,
});

return result.status === 'COMPLETED';
```

Client will not mark fiscal success for `SENT`, `FAILED`, `UNKNOWN`, or `TIMEOUT`.

## 13. Definition Of Done

- POS 1 local fiscal printing still works without remote assignment.
- POS 2 can see POS 1 fiscal printer as configured/ready in salon inventory.
- POS 2 can assign `FISCAL_RECEIPT` only to a valid fiscal printer.
- POS 2 fiscal print waits for final backend result.
- Backend never sends fiscal job to wrong agent.
- Backend never reports fiscal success from socket delivery alone.
- Duplicate fiscal request cannot print twice.
- Unknown fiscal outcome is represented explicitly and blocks automatic retry.
