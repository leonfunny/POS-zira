# eNail Print Agent - API Integration Guide

> Hướng dẫn cho Windows Developer về cách kết nối Print Agent với Backend

## Tổng quan

Print Agent kết nối với Backend qua 2 bước:
1. **REST API**: Xác thực API Key và lấy thông tin kết nối
2. **WebSocket**: Kết nối real-time để nhận print jobs

---

## Flow hoạt động

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FLOW KẾT NỐI                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. User nhập API Key trong Windows App                                     │
│     ┌─────────────────────────────────────────────────────────────┐        │
│     │ API Key: [pa_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx] [Connect]    │        │
│     └─────────────────────────────────────────────────────────────┘        │
│                              ↓                                              │
│  2. App gọi POST /api/v1/print-agent/connect                               │
│     ┌─────────────────────────────────────────────────────────────┐        │
│     │ Request:                                                     │        │
│     │ {                                                            │        │
│     │   "apiKey": "pa_xxx...",                                     │        │
│     │   "machineId": "a47ac171d19bae93f2f8930472d5d30279f1d03e..", │        │
│     │   "appVersion": "1.0.4",                                     │        │
│     │   "osVersion": "Windows 11"                                  │        │
│     │ }                                                            │        │
│     └─────────────────────────────────────────────────────────────┘        │
│                              ↓                                              │
│  3. Backend trả về thông tin kết nối                                       │
│     ┌─────────────────────────────────────────────────────────────┐        │
│     │ Response:                                                    │        │
│     │ {                                                            │        │
│     │   "agentId": "uuid-xxx",                                     │        │
│     │   "salonId": "uuid-xxx",                                     │        │
│     │   "salonName": "Nail Salon ABC",                             │        │
│     │   "serverUrl": "https://api.enail.pro",                      │        │
│     │   "printerConfig": {                                         │        │
│     │     "port": "COM3",                                          │        │
│     │     "protocol": "THERMAL",                                   │        │
│     │     "baudRate": 9600                                         │        │
│     │   }                                                          │        │
│     │ }                                                            │        │
│     └─────────────────────────────────────────────────────────────┘        │
│                              ↓                                              │
│  4. App lưu API Key và kết nối WebSocket                                   │
│     ┌─────────────────────────────────────────────────────────────┐        │
│     │ WebSocket URL: wss://api.enail.pro/print-agent              │        │
│     │ Auth: { apiKey: "pa_xxx..." }                                │        │
│     └─────────────────────────────────────────────────────────────┘        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## API Endpoints

### Base URL
- **Production**: `https://api.enail.pro/api/v1`
- **Development**: `http://localhost:3003/api/v1`

---

### 1. Kết nối với API Key

**Endpoint**: `POST /print-agent/connect`

**Mô tả**: Xác thực API Key và lấy thông tin kết nối. Endpoint này **PUBLIC** - không cần JWT token.

**Request**:
```json
{
  "apiKey": "pa_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "machineId": "a47ac171d19bae93f2f8930472d5d30279f1d03ebdb3c9d16f1d8eb864bf935c",
  "appVersion": "1.0.4",
  "osVersion": "Windows 11 Pro"
}
```

| Field | Type | Required | Mô tả |
|-------|------|----------|-------|
| `apiKey` | string | ✅ Yes | API Key từ Dashboard (format: `pa_xxx`) |
| `machineId` | string | Optional | Hardware fingerprint của máy tính |
| `appVersion` | string | Optional | Version của Print Agent app |
| `osVersion` | string | Optional | Version của hệ điều hành |

**Response Success (200)**:
```json
{
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "salonId": "660e8400-e29b-41d4-a716-446655440001",
  "salonName": "Nail Salon ABC",
  "serverUrl": "https://api.enail.pro",
  "printerConfig": {
    "port": "COM3",
    "protocol": "THERMAL",
    "baudRate": 9600
  }
}
```

**Response Error (400 - Invalid API Key format)**:
```json
{
  "statusCode": 400,
  "message": "Invalid API key format",
  "error": "Bad Request"
}
```

**Response Error (404 - API Key not found)**:
```json
{
  "statusCode": 404,
  "message": "Invalid API key or agent disabled",
  "error": "Not Found"
}
```

---

### 2. Verify API Key (Quick check)

**Endpoint**: `GET /print-agent/verify?apiKey=pa_xxx`

**Mô tả**: Kiểm tra nhanh API Key có hợp lệ không. **PUBLIC** endpoint.

**Response**:
```json
{
  "valid": true,
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "salonId": "660e8400-e29b-41d4-a716-446655440001"
}
```

---

## WebSocket Connection

### URL
- **Production**: `wss://api.enail.pro/print-agent`
- **Development**: `ws://localhost:3003/print-agent`

### Authentication
Khi connect WebSocket, gửi `apiKey` trong `auth` object:

```javascript
const socket = io('https://api.enail.pro/print-agent', {
  auth: {
    apiKey: 'pa_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  },
  transports: ['websocket']
});
```

### Events

#### Client nhận từ Server

| Event | Payload | Mô tả |
|-------|---------|-------|
| `connected` | `{ agentId, salonId, pendingJobs }` | Kết nối thành công |
| `error` | `{ message }` | Lỗi kết nối |
| `job:new` | PrintJob object | Có print job mới |
| `job:updated` | `{ jobId, status }` | Job status updated |

#### Client gửi lên Server

| Event | Payload | Mô tả |
|-------|---------|-------|
| `job:status` | `{ jobId, status, errorMessage? }` | Cập nhật trạng thái job |
| `scan:barcode` | `{ barcode, timestamp }` | Gửi barcode scan |
| `device:status` | `{ printerConnected, scannerActive, ... }` | Cập nhật device status |
| `heartbeat` | - | Keep-alive ping |

### Print Job Object

```json
{
  "jobId": "uuid-xxx",
  "jobType": "RECEIPT",
  "payload": {
    "orderNumber": "ORD-001",
    "items": [
      {
        "name": "Manicure",
        "quantity": 1,
        "unitPrice": 5000,
        "totalPrice": 5000,
        "vatRate": 23
      }
    ],
    "subtotal": 5000,
    "total": 5000,
    "payment": {
      "method": "CASH",
      "amount": 5000
    },
    "cashierName": "Anna"
  },
  "createdAt": "2024-01-20T10:30:00Z"
}
```

### Job Status Values

| Status | Mô tả |
|--------|-------|
| `PENDING` | Job đang chờ |
| `SENT` | Đã gửi tới agent |
| `PRINTING` | Đang in |
| `COMPLETED` | In thành công |
| `FAILED` | In thất bại |
| `CANCELLED` | Đã hủy |

---

## Code Example (TypeScript/Electron)

### 1. Config Store

```typescript
// config/store.ts
interface AgentConfig {
  apiKey: string | null;        // API Key từ user
  agentId: string | null;       // Agent ID từ server
  salonId: string | null;       // Salon ID
  salonName: string | null;     // Tên salon
  serverUrl: string;            // Server URL
  machineId: string;            // Hardware fingerprint
}
```

### 2. Connect với API Key

```typescript
// network/api-client.ts
async function connectWithApiKey(apiKey: string): Promise<ConnectionInfo> {
  const config = getConfig();
  const serverUrl = config.serverUrl || 'https://api.enail.pro';

  const response = await fetch(`${serverUrl}/api/v1/print-agent/connect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      apiKey,
      machineId: config.machineId,
      appVersion: app.getVersion(),
      osVersion: `${process.platform} ${os.release()}`,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Connection failed');
  }

  const data = await response.json();

  // Lưu thông tin vào config
  setConfig({
    apiKey,
    agentId: data.agentId,
    salonId: data.salonId,
    salonName: data.salonName,
    serverUrl: data.serverUrl,
  });

  return data;
}
```

### 3. WebSocket Connection

```typescript
// network/socket-client.ts
import { io, Socket } from 'socket.io-client';

class SocketClient {
  private socket: Socket | null = null;

  async connect(): Promise<void> {
    const config = getConfig();

    if (!config.apiKey) {
      throw new Error('No API key configured');
    }

    const wsUrl = config.serverUrl.replace('https://', 'wss://').replace('http://', 'ws://');

    this.socket = io(`${wsUrl}/print-agent`, {
      auth: {
        apiKey: config.apiKey,
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    this.socket.on('connected', (data) => {
      console.log('Connected to server:', data);
    });

    this.socket.on('job:new', async (job) => {
      console.log('New print job:', job.jobId);
      await this.handlePrintJob(job);
    });

    this.socket.on('error', (error) => {
      console.error('Socket error:', error);
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from server');
    });
  }

  async handlePrintJob(job: PrintJob): Promise<void> {
    try {
      // Gửi status PRINTING
      this.socket?.emit('job:status', {
        jobId: job.jobId,
        status: 'PRINTING',
      });

      // In receipt
      await printer.print(job.payload);

      // Gửi status COMPLETED
      this.socket?.emit('job:status', {
        jobId: job.jobId,
        status: 'COMPLETED',
      });
    } catch (error) {
      // Gửi status FAILED
      this.socket?.emit('job:status', {
        jobId: job.jobId,
        status: 'FAILED',
        errorMessage: error.message,
      });
    }
  }

  sendBarcodeScan(barcode: string): void {
    this.socket?.emit('scan:barcode', {
      barcode,
      timestamp: new Date().toISOString(),
    });
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}
```

---

## UI Flow cho Windows App

### 1. Màn hình chưa kết nối

```
┌─────────────────────────────────────────┐
│         eNail Print Agent               │
├─────────────────────────────────────────┤
│                                         │
│  Chưa kết nối với salon                 │
│                                         │
│  Nhập API Key:                          │
│  ┌─────────────────────────────────┐    │
│  │ pa_                             │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │         🔌 Kết nối              │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ℹ️ Lấy API Key từ Dashboard eNail      │
│     Settings → Print Agent → Copy Key   │
│                                         │
└─────────────────────────────────────────┘
```

### 2. Màn hình đã kết nối

```
┌─────────────────────────────────────────┐
│         eNail Print Agent               │
├─────────────────────────────────────────┤
│                                         │
│  ✅ Đã kết nối                          │
│                                         │
│  Salon: Nail Salon ABC                  │
│  Status: 🟢 Online                      │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  Printer Settings:                      │
│  • A4: HP LaserJet Pro                  │
│  • Receipt: COM3 (THERMAL)              │
│  • Label: Zebra ZD420                   │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │Test A4  │  │Test Rcpt│  │Test Lbl │  │
│  └─────────┘  └─────────┘  └─────────┘  │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │         🔌 Ngắt kết nối         │    │
│  └─────────────────────────────────┘    │
│                                         │
└─────────────────────────────────────────┘
```

---

## Lấy API Key từ Dashboard

Owner đăng nhập vào Dashboard eNail và:

1. Vào **Settings** → **Print Agent**
2. Click **"Tạo Print Agent"**
3. Nhập tên (vd: "Kasa główna")
4. Click **"Generate API Key"**
5. **Copy API Key** (chỉ hiển thị 1 lần!)
6. Dán vào Windows App

---

## Troubleshooting

| Lỗi | Nguyên nhân | Giải pháp |
|-----|-------------|-----------|
| "Invalid API key format" | API Key không bắt đầu bằng `pa_` | Kiểm tra lại API Key |
| "Invalid API key or agent disabled" | API Key không tồn tại hoặc bị vô hiệu | Tạo API Key mới từ Dashboard |
| WebSocket disconnect | Mất kết nối mạng | Auto-reconnect hoặc kiểm tra mạng |
| "Authentication required" | Không gửi apiKey trong auth | Kiểm tra WebSocket auth config |

---

## Version History

| Version | Changes |
|---------|---------|
| 1.0.4 | Thêm API Key authentication |
| 1.0.3 | Multi-printer support |
| 1.0.2 | Initial release |

---

**Contact**: support@enail.pro
