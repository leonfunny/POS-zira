# Prompt cho Claude Session (2) — Fix POSNET Thermal XL Communication

## Bối cảnh

Bạn đang làm việc trong repo `C:\print-agent-master` — Electron + React + TypeScript POS desktop app (Windows). App kết nối với máy in fiscal POSNET qua serial COM port.

**Vấn đề hiện tại:** App detect đúng máy POSNET Thermal XL (VID_1424, PID_100B) trên COM6, nhưng KHÔNG giao tiếp được. Mọi lần gửi POSNET v2 frame (`rtcget`) đều fail với lỗi `The semaphore timeout period has expired` trên **mọi baud rate** (9600, 19200, 38400). Đây KHÔNG phải bug baud rate đơn thuần.

## Tình trạng hardware

```
Windows device:
  Name: POSNET Thermal Serial Port (COM6)
  DeviceID: USB\VID_1424&PID_100B\9213871993
  Status: OK, driver usbser

Config hiện tại:
  protocol: POSNET, port: COM6, baudRate: 9600

App hiển thị: POSNET — POSNET Thermal XL, PID_100B
```

## Những gì session trước đã fix (KHÔNG được revert)

Các file dưới đây đã có uncommitted changes từ session trước. **Giữ nguyên** — chỉ sửa thêm, không revert:

1. **PosnetConnectionState model** (`posnet-driver.ts`): `disconnected → physical_present → protocol_ready`. `isConnected()` chỉ true khi `protocol_ready`.
2. **Port mutex** (`port-mutex.ts`): `withPortLock()` serialize tất cả serial I/O per COM port.
3. **PnP parser** (`pnp-port-parser.ts`): Dùng `$usbPid` thay `$pid` (fix PowerShell built-in variable collision). Parse `COM6|100B` đúng.
4. **No auto baud fan-out cho Thermal XL** (`posnet-driver.ts:182-198`): Nếu PID là 0x100A/0x100B (ambiguous protocol) VÀ write timeout → KHÔNG tự thử baud khác. Classify là `WRONG_BAUD_OR_MODE`.
5. **Health check skip** (`hardware.module.ts:1189-1192`): `requiresManualProtocolAction()` → skip active probe.
6. **UI hint** (`Settings.tsx:1047`): Show "Manual configuration required" cho POSNET Thermal models.

**Tests đang pass (15/15):**
```
tests/posnet-driver.test.ts
```
**Type check, build đều pass.**

## Root cause analysis — Bạn cần xác minh

### Hypothesis 1 (rất có khả năng): Printer-side protocol là THEMAL, không phải POSNET

POSNET Thermal XL/HD có menu `Interfejs PC` cho phép chọn:
- Interface: USB / COM / TCP/IP
- Protocol: **POSNET** hoặc **THEMAL**

Nếu printer đang ở protocol THEMAL:
- POSNET v2 frames (`rtcget`, CRC16) sẽ bị **ignored hoàn toàn**
- Serial Write() timeout vì printer không ACK
- `semaphore timeout` là triệu chứng đúng

**Cách xác minh:** Không thể từ code — cần user kiểm tra menu vật lý trên máy. Nhưng app cần:
- Hiện rõ hướng dẫn: "Kiểm tra menu Interfejs PC → Protocol phải là POSNET"
- Nếu fail, không tự retry vô nghĩa
- Nếu user report printer đang ở THEMAL → app phải nói rõ "THEMAL protocol chưa được support"

### Hypothesis 2: Serial settings không khớp

Current settings: `None parity, 8 data bits, One stop bit, DTR+RTS enabled`.
Thermal XL manual ghi default: `9600, 8N1, no flow control`.

Nhưng khi printer ở THEMAL mode, serial settings có thể khác (THEMAL protocol dùng ESC/POS-like framing, không dùng POSNET v2 CRC16 frames).

### Hypothesis 3 (đã loại trừ): Posnet OPS/SDK bridge

**KHÔNG CÓ SDK.** Posnet OPS (`C:\Program Files (x86)\Posnet OPS\`) là Electron app (có `app.asar`), không phải library/DLL. Chỉ có Chromium DLLs (`d3dcompiler_47.dll`, `ffmpeg.dll`, etc.). **Không có** PosnetSDK.dll, không có COM API, không có CLI tool.

`StubPosnetSdkClient` trong `posnet-probe-engine.ts` là placeholder — luôn return false. **Không cần implement SDK bridge.**

## Files cần đọc/sửa

### Files chính (đọc kỹ trước khi sửa):

| File | Vai trò |
|------|---------|
| `src/main/hardware/posnet/posnet-driver.ts` | POSNET v2 driver, connection state, rtcget verify, serial I/O |
| `src/main/modules/hardware.module.ts` | Health check, driver init, testPrinterByConfig 6-step flow |
| `src/renderer/components/Settings.tsx` | UI: detected devices, diagnostic messages, actions |
| `src/main/hardware/posnet/posnet-probe-engine.ts` | Multi-profile probe engine (POSNET_V2, THERMAL, SDK_BRIDGE) |
| `src/main/hardware/posnet/probe-profiles.ts` | Probe profiles + POSNET_PRODUCT_IDS |
| `src/main/hardware/posnet/device-detection-service.ts` | Full scan orchestrator |

### Files hỗ trợ:

| File | Vai trò |
|------|---------|
| `src/main/hardware/posnet/port-mutex.ts` | Serial port mutex |
| `src/main/hardware/posnet/pnp-port-parser.ts` | VID/PID extraction from PnP |
| `src/shared/types.ts` | IPC channels, PrinterStatusInfo, TestPrintStep, PosnetDiagnosticCode |
| `src/shared/electron.d.ts` | Window API type declarations |

### Logs:

```
C:\Users\pc\AppData\Roaming\zira-ai\logs\combined1.log   (mới nhất, 2026-04-21)
C:\Users\pc\AppData\Roaming\zira-ai\logs\error.log
```

Search keywords: `COM6`, `PID_100B`, `WRONG_BAUD_OR_MODE`, `semaphore timeout`, `POSNET`, `THEMAL`, `rtcget`, `verifyPosnet`, `testPrinterByConfig`, `Skipping active POSNET recovery`

### Tests hiện có (23 tests, 5 files):

```
tests/posnet-driver.test.ts              — 15 tests
tests/posnet-pnp-parsing.test.ts         — tests for pnp-port-parser
tests/driver-installer-posnet-profile.test.ts — profile classification
tests/posnet-runtime-locking.test.ts     — port mutex
tests/hardware-posnet-config.test.ts     — config → driver creation
```

## Việc cần làm

### A. Cải thiện diagnostic state machine (posnet-driver.ts)

**Hiện tại** `PosnetDiagnosticCode.code` có:
```typescript
'PORT_NOT_FOUND' | 'PORT_BUSY' | 'DEVICE_DETECTED_NO_PROTOCOL_RESPONSE' | 'WRONG_BAUD_OR_MODE' | 'COMMAND_REJECTED' | 'PRINT_OK' | 'ACCESS_DENIED'
```

**Cần thêm hoặc refine:**
- Khi PID_100B + write timeout → diagnostic phải chứa **actionable guidance**, không chỉ technical error code. Detail string nên bao gồm:
  - Tên model cụ thể ("POSNET Thermal XL")
  - Hành động user cần làm ("Check printer menu: Interfejs PC → Protocol must be set to POSNET, not THEMAL")
  - Nếu printer xác nhận đang ở THEMAL → "This app does not support THEMAL fiscal protocol. Switch to POSNET or contact support."
- `requiresManualProtocolAction()` đã hoạt động đúng — giữ nguyên logic, chỉ cải thiện detail messages.

### B. Thêm "Diagnose / Check Setup" probe riêng (hardware.module.ts + IPC)

Hiện tại chỉ có `testPrinterByConfig()` — nó chạy 6-step flow bao gồm **gửi print command** (trinit/trline/trend). Nếu protocol chưa verify, bước print gây lỗi hoặc timeout.

**Cần thêm:** Một IPC handler nhẹ `POSNET_DIAGNOSE_PORT` hoặc tương tự:
- Input: port, baudRate
- Chỉ chạy diagnostic: open port → send rtcget → report kết quả
- KHÔNG gửi print command
- KHÔNG auto-save config
- Return: `{ portOpen: boolean, vidMatch: boolean, pid?: number, posnetResponse: boolean, diagnostic: string, guidance: string[] }`
- UI có thể gọi trước khi user bấm "Test Print"

**Lưu ý:** Probe này phải dùng `withPortLock()` để tránh conflict.

### C. Cải thiện UI diagnostic (Settings.tsx)

Khi device có `autoSetupEligible === false` VÀ isPosnet:
- Hiện tại chỉ show 1 dòng text tĩnh. Cần thêm:
  1. **Nút "Diagnose"** bên cạnh nút Refresh — gọi `POSNET_DIAGNOSE_PORT` mới
  2. **Kết quả diagnosis hiển thị chi tiết:**
     - `[✓] COM6 detected (VID_1424, PID_100B)`
     - `[✓] Port opens successfully`
     - `[✗] No POSNET v2 response (semaphore timeout)`
     - → "Likely cause: Printer-side protocol is not set to POSNET"
     - → Step-by-step: "1. Press MENU on printer → 2. Interfejs PC → 3. Protocol → 4. Select POSNET → 5. Save & restart printer → 6. Click Diagnose again"
  3. Nếu diagnose thành công (POSNET response OK) → tự enable nút "Test Print" / "Auto Setup"

### D. Health check không hammer COM6 (hardware.module.ts)

**Hiện tại đã tốt:** Health check có backoff `[1, 2, 4, 10]` và `requiresManualProtocolAction()` skip active recovery. Nhưng log cho thấy health check vẫn **poll DriverInstaller mỗi 30s** (line `Filtering 9 spooler printers; present COM=COM6`).

**Cần:** Khi POSNET driver ở state `physical_present` + diagnostic `WRONG_BAUD_OR_MODE`:
- Health check chỉ check passive presence (COM6 still in port list?)
- KHÔNG gọi `getPosnetDriverStatus()` nặng mỗi 30s cho cùng device đang fail
- Chỉ re-probe khi: (a) user click Diagnose, (b) user thay đổi config, (c) port list thay đổi (device unplug/replug)

### E. KHÔNG LÀM những thứ này

- ❌ Không thử thêm baud rates nào nữa (đã thử hết, đều timeout)
- ❌ Không implement THEMAL/fiscal-THEMAL protocol (không có tài liệu)
- ❌ Không implement SDK bridge (không có DLL, Posnet OPS chỉ là Electron app)
- ❌ Không touch sync/refund/order code
- ❌ Không refactor printer architecture broadly
- ❌ Không revert dirty files từ session trước
- ❌ Không auto-save POSNET profile nếu probe chưa succeed
- ❌ Không auto-switch fiscal POSNET sang generic THERMAL

## Tests cần thêm/update

Thêm vào `tests/posnet-driver.test.ts` hoặc file test mới:

1. **Thermal XL + write timeout → guidance contains setup instructions**
   - `WRONG_BAUD_OR_MODE` detail chứa "Interfejs PC" hoặc "printer menu"
   - Detail chứa model name "Thermal XL"

2. **Thermal XL KHÔNG auto-switch sang THERMAL**
   - After connect fail with PID_100B, protocol vẫn là POSNET, không tự đổi sang THERMAL

3. **Thermal XL KHÔNG auto-save config khi probe fail**
   - Config không được modify nếu connect() return false

4. **Health check skip khi `requiresManualProtocolAction()` = true**
   - Đã có test tương tự — verify lại hoặc extend

5. **Diagnose IPC handler (nếu thêm):**
   - Returns đúng format
   - Dùng port lock
   - Không gửi print commands
   - Works khi port busy (returns PORT_BUSY)

6. **UI test (optional): diagnostic message render đúng cho Thermal XL**

## Verification — chạy theo thứ tự

```bash
# 1. Unit tests (phải pass hết, KHÔNG break existing)
npm test -- tests/posnet-driver.test.ts tests/posnet-pnp-parsing.test.ts tests/driver-installer-posnet-profile.test.ts tests/posnet-runtime-locking.test.ts tests/hardware-posnet-config.test.ts

# 2. Type check main process
npx tsc -p tsconfig.main.json

# 3. Type check renderer
npm run typecheck:renderer

# 4. Full build
npm run build

# 5. (Optional) Full test suite — nếu fail ở unrelated tests (salon/checkin UI), mention nhưng không fix
npm test
```

## Acceptance criteria

- [ ] `WRONG_BAUD_OR_MODE` diagnostic detail chứa actionable setup guidance (tên model + bước kiểm tra menu printer)
- [ ] Có IPC `POSNET_DIAGNOSE_PORT` (hoặc tên tương đương) — diagnostic-only, không print, dùng port lock
- [ ] UI có nút Diagnose cho POSNET Thermal models detected nhưng chưa protocol_ready
- [ ] UI hiện step-by-step guidance khi diagnose fail (Interfejs PC → POSNET)
- [ ] Health check KHÔNG active-probe khi `requiresManualProtocolAction()` = true (đã có, verify giữ nguyên)
- [ ] Health check giảm overhead cho device đang fail (không poll driver status nặng mỗi 30s)
- [ ] Tất cả test cũ pass + test mới cho diagnostic guidance
- [ ] Type check + build pass
- [ ] Không auto-switch protocol, không auto-save config khi fail
- [ ] Không touch sync/refund/order code

## Ghi chú quan trọng

**Thứ đầu tiên nên làm khi session 2 bắt đầu:** Đọc log mới nhất (`combined1.log`) để xác minh tình trạng hiện tại chưa thay đổi. Sau đó đọc `posnet-driver.ts` từ đầu đến cuối — đây là file quan trọng nhất.

**Nếu gặp conflict giữa prompt này và thực tế code:** Trust code hiện tại, không trust prompt. Code là source of truth.

**Về printer-side THEMAL:** Đây có thể là root cause thật. Nhưng app không thể tự fix — chỉ user mới đổi được menu trên máy in vật lý. Nhiệm vụ của app là **chẩn đoán đúng, hướng dẫn rõ, và không làm phiền user với retry vô nghĩa**.
