# POS Endpoints — eNail Backend

**Lưu ý:** API dùng **JSON** (NestJS REST), không phải XML. Bên dưới là mẫu request/response JSON cho từng endpoint. Nếu anh cần bản XML (SOAP/legacy), em convert sau.

Base URL: `https://api.enail.pl` (hoặc domain nội bộ tương ứng)
Auth: `Authorization: Bearer <JWT>` cho tất cả endpoint trừ nhóm `/public/pos/*`.

---

## 1. `/b2b/pos/*` — Core bán hàng (30 endpoint)

Guards: `JwtAuthGuard + RolesGuard + FeatureGateGuard` · Feature: `B2B_WHOLESALE`

### 1.1 `POST /b2b/pos/orders` — Tạo đơn POS mới
**Công dụng:** Tạo đơn bán tại quầy (tiền mặt/thẻ/BLIK/chuyển khoản), có hoặc không kèm hóa đơn VAT.
**Roles:** OWNER, MANAGER, STAFF

Request:
```json
{
  "id": "uuid-idempotency-key-optional",
  "staffId": "uuid",
  "shiftId": "uuid",
  "source": "POS",
  "orderType": "standard",
  "mode": "b2b",
  "paymentMethod": "CASH",
  "tenders": [
    { "method": "CASH", "amount": 50.00 },
    { "method": "CARD", "amount": 100.00, "reference": "txn-abc" }
  ],
  "paymentAmount": 150.00,
  "changeAmount": 0,
  "tip": 0,
  "requiresInvoice": true,
  "invoiceType": "VAT",
  "customerNip": "5252344078",
  "customerId": "uuid",
  "customerName": "Anna Kowalska",
  "customerPhone": "+48123456789",
  "customerEmail": "anna@example.com",
  "items": [
    {
      "productId": "uuid",
      "variantId": "uuid",
      "variantSku": "TEA-JAS-250",
      "packQuantity": 2,
      "customPrice": 45.00,
      "customPriceNotes": "Giá đặc biệt",
      "colorCode": "#ff0000",
      "sizeName": "250g"
    }
  ],
  "discountAmount": 5.00,
  "priceType": "brutto",
  "notes": "Giao trong ngày"
}
```

Response (200):
```json
{
  "id": "uuid",
  "orderNumber": "POS-DRA/2026/04/00123",
  "totalAmount": 145.00,
  "paymentStatus": "PAID",
  "status": "COMPLETED",
  "items": [ /* ... */ ],
  "createdAt": "2026-04-17T13:00:00Z"
}
```

---

### 1.2 `GET /b2b/pos/orders/cash/today` — Đơn hôm nay
**Công dụng:** Lấy toàn bộ đơn POS trong ngày hiện tại (cả cash lẫn invoiced).
**Query:** (none)
**Response:** `Order[]`

---

### 1.3 `GET /b2b/pos/orders` — List đơn có filter
**Công dụng:** Tìm kiếm đơn POS theo period/payment status/có hóa đơn.
**Query:**
```
?period=today|week|month|all
&paymentStatus=PENDING|PARTIAL|PAID
&requiresInvoice=true|false
&page=1&limit=20
```
**Response:** `{ orders: Order[], total: number, page, limit }`

---

### 1.4 `GET /b2b/pos/orders/invoiced` — Chỉ đơn có hóa đơn
Giống 1.3 nhưng cố định `requiresInvoice=true`.

---

### 1.5 `GET /b2b/pos/orders/cash/:id` — Chi tiết đơn cash
### 1.6 `GET /b2b/pos/orders/invoiced/:id` — Chi tiết đơn invoiced
**Param:** `id` (uuid) — **Response:** `Order` đầy đủ items, payments, customer.

---

### 1.7 `PATCH /b2b/pos/orders/:id/add-invoice` — Gắn hóa đơn vào đơn đã tạo
**Roles:** OWNER, MANAGER
Request:
```json
{ "customerNip": "5252344078", "invoiceType": "VAT" }
```

---

### 1.8 `PATCH /b2b/pos/orders/:id` — Update payment (Elavon terminal)
Request:
```json
{
  "paymentStatus": "PAID",
  "elavonTransactionId": "TXN123",
  "cardType": "VISA",
  "maskedPan": "**** **** **** 1234",
  "authCode": "AUTH001",
  "notes": "Đã cà thẻ"
}
```

---

### 1.9 `GET /b2b/pos/customers/nip/:nip` — Tìm/tạo KH theo NIP
**Công dụng:** Search customer bằng NIP; nếu không có thì gọi API GUS của Ba Lan để lấy thông tin công ty.
Response:
```json
{
  "customer": null,
  "gusData": {
    "nip": "5252344078",
    "name": "FIRMA SP. Z O.O.",
    "address": "ul. Przykładowa 1, 00-001 Warszawa",
    "regon": "123456789"
  },
  "source": "gus"
}
```

---

### 1.10 `GET /b2b/pos/gus/:nip` — Preview GUS (không tạo KH)
Throttle: 10 req/phút.
Response: `{ success: true, data: {...} }`

---

### 1.11 `POST /b2b/pos/orders/:id/generate-proforma` — Xuất proforma
**Công dụng:** Convert đơn POS-DRA thành POS-PRO và tạo Faktura Proforma.
**Roles:** OWNER, MANAGER
Response:
```json
{
  "success": true,
  "order": { "id": "uuid", "orderNumber": "POS-PRO/2026/04/00045", "requiresInvoice": true },
  "proformaId": "uuid"
}
```

---

### 1.12 `GET /b2b/pos/orders/invoiced/:id/invoice-pdf` — Download PDF hóa đơn
Query: `?type=VAT|PROFORMA`
Response: `application/pdf` (attachment)

### 1.13 `GET /b2b/pos/orders/cash/:id/receipt-pdf` — Download PDF biên lai
### 1.14 `GET /b2b/pos/orders/cash/:id/receipt-pdf/preview` — Xem biên lai inline
### 1.15 `GET /b2b/pos/orders/invoiced/:id/invoice-pdf/preview` — Xem hóa đơn inline

---

### 1.16 `POST /b2b/pos/orders/:id/notify-telegram` — Thông báo Telegram
**Công dụng:** Gửi thông báo đơn hàng cho nhân viên kho qua bot Telegram.
Response: `{ success: true, messageId: "..." }`

---

### 1.17 `POST /b2b/pos/orders/:id/send-to-customer` — Gửi email cho KH
Request: `{ "email": "customer@example.com" }`
*(Hiện đang stub — chưa implement mail service)*

---

### 1.18 `POST /b2b/pos/orders/:id/refund` — Hoàn tiền
**Roles:** OWNER, MANAGER
Request:
```json
{
  "type": "PARTIAL",
  "amount": 20.00,
  "reason": "Hàng lỗi",
  "items": [ { "orderItemId": "uuid", "quantity": 1 } ],
  "refundMethod": "CASH"
}
```

---

### 1.19–1.21 Cancel order (3 biến thể cùng logic)
- `PATCH /b2b/pos/orders/:id/cancel`
- `PATCH /b2b/pos/orders/cash/:id/cancel`
- `PATCH /b2b/pos/orders/invoiced/:id/cancel`

Roles: OWNER, MANAGER — không body.

---

### 1.22–1.23 Delete order
- `DELETE /b2b/pos/orders/cash/:id`
- `DELETE /b2b/pos/orders/invoiced/:id`

Chỉ xóa được đơn DRAFT/CANCELLED hoặc đơn trong ngày.

---

### 1.24–1.25 Mark paid
- `POST /b2b/pos/orders/cash/:id/mark-paid`
- `POST /b2b/pos/orders/invoiced/:id/mark-paid`

Request: `{ "amount": 150.00 }`

---

### 1.26 `PATCH /b2b/pos/orders/:id/items` — Batch edit items
Request:
```json
{
  "items": [
    { "itemId": "uuid", "packQuantity": 3, "unitPrice": 42.00, "itemDiscount": 0 }
  ],
  "discountAmount": 5,
  "discountPercent": 10,
  "notes": "Chỉnh sửa theo yêu cầu KH"
}
```

### 1.27 `POST /b2b/pos/orders/:id/items` — Thêm 1 item
Request:
```json
{
  "productId": "uuid",
  "variantSku": "COFFEE-200",
  "packQuantity": 1,
  "unitPrice": 35.00,
  "itemDiscount": 0
}
```

### 1.28 `DELETE /b2b/pos/orders/:id/items/:itemId` — Xóa 1 item

---

### 1.29 `POST /b2b/pos/orders/:id/finish` — Chốt đơn (không edit được nữa)
Request: `{ "notes": "Hoàn tất" }`

### 1.30 `GET /b2b/pos/orders/:id/history` — Lịch sử edit đơn
Response: `AuditLog[]`

---

## 2. `/b2b/pos/shifts/*` — Ca làm việc POS (3 endpoint)

Guards: giống section 1.

### 2.1 `POST /b2b/pos/shifts` — Mở ca
Request:
```json
{
  "staffId": "uuid",
  "staffName": "Anna K.",
  "openingCash": 200,
  "machineId": "POS-01"
}
```
Response: `{ id, salonId, staffId, openingCash, openedAt, status: "OPEN" }`

### 2.2 `POST /b2b/pos/shifts/:shiftId/close` — Đóng ca
Request: `{ "closingCash": 2150, "notes": "OK" }`
Response: `{ id, closingCash, cashDelta, ordersCount, closedAt, status: "CLOSED" }`

### 2.3 `GET /b2b/pos/shifts/active` — Lấy ca đang mở
Query: `?machineId=POS-01` (optional)
Response: shift hoặc `{ active: false }`

---

## 3. `/pos/shifts/*` — Alias cho frontend cũ (3 endpoint)

Cùng logic section 2, khác URL:
- `POST /pos/shifts/open`
- `POST /pos/shifts/:shiftId/close`
- `GET /pos/shifts/active`

---

## 4. `/public/pos/:salonSlug/*` — Auth công khai (5 endpoint)

Không cần JWT (public). Dùng để login POS terminal.

### 4.1 `GET /public/pos/:salonSlug/info` — Thông tin salon
Response: `{ salonId, name, logoUrl, brandKey, locale }`

### 4.2 `POST /public/pos/:salonSlug/login` — Login bằng PIN
Throttle: 10 req/phút.
Request:
```json
{ "pin": "1234" }
```
Response:
```json
{
  "success": true,
  "data": {
    "token": "<JWT>",
    "staff": { "id": "uuid", "name": "Anna", "role": "STAFF" },
    "salon": { "id": "uuid", "name": "Chè Sài Gòn Praha 4" }
  }
}
```

### 4.3 `GET /public/pos/:salonSlug/telegram-qr` — Tạo QR Telegram login
Response: `{ qrCodeUrl, token, expiresAt }`

### 4.4 `POST /public/pos/:salonSlug/telegram-auth` — Verify token Telegram
Request: `{ "token": "..." }`
Response: giống 4.2 (trả JWT).

### 4.5 `GET /public/pos/:salonSlug/staff` — Danh sách nhân viên (để chọn)
Response: `[{ id, name, avatarUrl, role }]`

---

## Tổng kết

| Nhóm | Số endpoint | Auth |
|---|---|---|
| `/b2b/pos/*` | 30 | JWT + role |
| `/b2b/pos/shifts/*` | 3 | JWT + role |
| `/pos/shifts/*` | 3 | JWT + role (alias) |
| `/public/pos/*` | 5 | Public (PIN/Telegram) |
| **Tổng** | **41** | |

## Ghi chú thêm
- Payment methods: `CASH`, `CARD`, `BANK_TRANSFER`, `BLIK`, `CREDIT` (nợ)
- Invoice types: `NONE`, `PROFORMA`, `VAT`
- Price type: `netto` / `brutto`
- Order status: `DRAFT`, `COMPLETED`, `CANCELLED`, `PENDING_STOCK`
- Payment status: `PENDING`, `PARTIAL`, `PAID`, `FAILED`
- Số đơn format: `POS-DRA/YYYY/MM/NNNNN` (draft/cash), `POS-PRO/...` (proforma), `POS-VAT/...` (VAT invoice)
