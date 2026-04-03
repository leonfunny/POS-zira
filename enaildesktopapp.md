# Zira AI Desktop App (Print Agent)

> Electron desktop application for POS, hardware integration, Booksy sync, invoicing, billiard management, camera AI, and remote support.

## Quick Reference

| Item | Value |
|------|-------|
| Framework | Electron 33 + React 18 + TypeScript + Vite 6 |
| Platform | Windows (primary), macOS/Linux (partial) |
| Main Process | `src/main/index.ts` |
| Renderer | 3 windows (Main, POS, Customer Display) |
| Dev Port | 3100 (Vite) |
| Database | sql.js (SQLite WASM, in-memory + file persist) |
| Network | Socket.IO + REST to NestJS backend |
| Build | electron-builder → NSIS installer |
| Auto-update | R2 CDN at `img.zira.pl/downloads/` |
| i18n | 7 languages, 620 keys |
| IPC Channels | 120+ methods via contextBridge |
| Modules | 12 feature modules |

---

## 1. Architecture Overview

### Process Model

```
Main Process (Node.js)
  ├── AgentOrchestrator (lifecycle manager)
  ├── 12 Feature Modules (hardware, pos, sync, auth, booksy, invoice, telegram, ai, remote, security, browser, payment)
  ├── ServiceContainer (DI)
  ├── EventBus (typed pub/sub)
  ├── SocketClient (backend connection)
  └── Database (sql.js SQLite)
       │
       │ IPC (contextBridge)
       │
Preload Process
  └── preload.ts (120+ methods exposed as window.electronAPI)
       │
       │ window.electronAPI.*
       │
Renderer Processes (3 Vite bundles)
  ├── Main Window (App.tsx) — settings, status, chat, invoicing, booksy, security
  ├── POS Window (POSApp.tsx) — fullscreen cashier interface
  └── Customer Display (CustomerApp.tsx) — touchscreen customer-facing
```

### Data Flow

```
Backend (NestJS, Socket.IO)
    ↓
SocketClient → EventBus
    ├── HardwareModule (print jobs, barcode scans)
    ├── PosModule (orders, payments)
    ├── SyncModule (products, billiard)
    ├── AuthModule (connection state)
    └── [Other modules...]
    ↓
IPC Bridge (ipcMain ↔ ipcRenderer)
    ↓
React Renderer (UI)
```

### Core Design Patterns

| Pattern | Implementation |
|---------|---------------|
| Plugin Architecture | Each module implements `AppModule` interface |
| Lightweight DI | `ServiceContainer` with string tokens, no reflection |
| Typed Pub/Sub | `EventBus` with `AppEvents` interface |
| Lifecycle Management | init → start → stop → destroy per module |
| Offline-First | Local SQLite cache + sync queue for backend |
| Multi-Tenant | Database cleared on salon switch |
| Secure Storage | Electron `safeStorage` (OS-level encryption) |

---

## 2. Core Infrastructure

### ServiceContainer (`src/main/core/container.ts`)

```typescript
// Register
container.set<Database>(SERVICE_TOKENS.DATABASE, database);
container.factory<PosStore>(SERVICE_TOKENS.POS_STORE, () => new PosStore());

// Retrieve
const db = container.get<Database>(SERVICE_TOKENS.DATABASE);
const store = container.getOptional<PosStore>(SERVICE_TOKENS.POS_STORE);
```

**Service Tokens:** DATABASE, EVENT_BUS, TOOL_REGISTRY, SOCKET, API_CLIENT, MAIN_WINDOW, WINDOW_MANAGER, HARDWARE_MODULE, PRINTERS, SCANNER, POS_STORE, PAYMENT_CONTROLLER, SHIFT_CONTROLLER, PRODUCT_SYNC, ORDER_SYNC, BILLIARD_SYNC, ZIRA_AI, BROWSER_CONTROLLER, REMOTE_SESSION_MANAGER, SSH_TUNNEL_MANAGER, TELEGRAM_BOT, BOOKSY_SYNC, TRAY_MANAGER, SECURITY_MODULE, EXTENSION_WSS

### EventBus (`src/main/core/event-bus.ts`)

Key events:

| Event | Payload |
|-------|---------|
| `socket:connected` | `{ salonId, salonName }` |
| `socket:disconnected` | `{ reason }` |
| `print:job-received` | `{ jobId, jobType, ... }` |
| `printer:status-changed` | `{ printerType, connected }` |
| `barcode:scanned` | `{ barcode, source }` |
| `config:changed` | `{ changedKeys: string[] }` |
| `user:logged-out` | `{}` |

### AgentOrchestrator (`src/main/core/orchestrator.ts`)

**12-Step Initialization:**

1. `app.whenReady()`
2. Generate/load machine ID (SHA256 of OS ID)
3. Register core services in container
4. Initialize database + seed
5. Create SocketClient
6. `mod.init()` for all modules
7. `mod.registerIpcHandlers()` for all
8. `mod.registerEventHandlers(bus)` for all
9. `mod.setupSocketHandlers(socket)` for all
10. Collect tool definitions
11. Show main window (700x600, preload script)
12. Create TrayManager + configure auto-start

**Graceful Shutdown:** Stop modules in reverse order, disconnect socket, close database.

### AppModule Interface

```typescript
interface AppModule {
  readonly name: string;
  readonly state: ModuleState; // CREATED, READY, RUNNING, STOPPED, DESTROYED, ERROR

  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;

  registerIpcHandlers(): void;
  getToolDefinitions(): ToolDefinition[];
  registerEventHandlers(bus: EventBus): void;
  setupSocketHandlers?(socket: SocketClient): void;
}
```

---

## 3. Modules Reference

### Hardware Module (`src/main/modules/hardware.module.ts`)

Manages multi-printer support and barcode scanners.

**Printer Types:**

| Type | Driver | Protocol | Use Case |
|------|--------|----------|----------|
| RECEIPT | PosnetDriver or ThermalDriver | POSNET or ESC/POS | Fiscal receipts, Z-reports |
| LABEL | ZebraDriver or ThermalDriver | ZPL or ESC/POS | Product/inventory labels |
| TICKET | ThermalDriver | ESC/POS | Non-fiscal order tickets |
| KITCHEN | ThermalDriver | ESC/POS | Kitchen order tickets |

**IPC Channels:**
- `LIST_PORTS` — enumerate COM ports
- `LIST_WINDOWS_PRINTERS` — Windows printer list
- `TEST_PRINT` — test all printers
- `TEST_PRINTER_BY_TYPE` — test specific printer

**Health Check:** 30s periodic check, auto-reconnect on device reappear.

**Print Job Retry:** 3 attempts with 2s delay.

### POS Module (`src/main/modules/pos.module.ts`)

Point of sale with Redux-like store, 60+ IPC handlers.

**Sub-systems:**
- PosStore (Redux-like state management)
- WindowManager (POS + customer display windows)
- PaymentController (cash, card, fiscal receipts)
- ShiftController (open/close, Z-reports)

**POS Modes:** retail, salon, b2b, restaurant

**IPC Groups (60+):**
- State: `pos:get-state`, `pos:dispatch`
- Products: `pos:products:getAll`, `getByCategory`, `search`, `getByBarcode`
- Orders: `pos:orders:create`, `getDailyStats`
- Tables: `pos:tables:getAll`, `getActive`, `updateStatus`, `clearTable`, `setCovers`
- Customers: `pos:customers:getAll`, `search`, `getById`, `increaseDebt`
- Hold: `pos:hold:create`, `list`, `get`, `remove`
- Quick Keys: `pos:quickkeys:list`, `create`, `update`, `remove`, `assign`, `getAssigned`
- Check-ins: `checkin:getToday`, `create`, `updateStatus`, `startService`, `complete`, `markNoShow`, `searchPhone`, `addUpsells`, `updateNotes`, `getStats`
- Payment: `pos:print-receipt`, `pos:open-cash-drawer`, `pos:payment:card`
- Shift: `pos:shift:open`, `pos:shift:close`
- Customer Display: `display:touch`, `display:request-service`, `display:check-in`, `display:browse-services`, `display:back-to-idle`, `display:search-by-phone`

### Sync Module (`src/main/modules/sync.module.ts`)

Delta product sync, order polling, billiard sync with offline queue.

**Sub-systems:**
- ProductSync — incremental product updates, local SQLite cache
- OrderSync — 30s polling for pending orders
- BilliardSync — full sync + mutation queue + 5s dashboard refresh

**IPC Channels (30+):**
- `pos:sync:products`, `pos:sync:orders`
- `billiard:get:overview`, `get:session`, `get:combos`, `get:floor-plans`, `get:fnb-products`, `get:fnb-categories`, `get:resource-type`, `get:restaurant-combos`
- `billiard:mutate` — queue mutation (op, method, path, body)
- `billiard:sync:status`
- `billiard:print:receipt`, `billiard:print:open-drawer`

**Offline Strategy:** Buffer mutations locally, replay when reconnected.

### Auth Module (`src/main/modules/auth.module.ts`)

Login, token management, connection, config.

**Auth Methods:**
1. **Telegram QR Login:** Generate QR → scan → poll status → auto-connect
2. **Email Login:** email/password → JWT → auto-connect with API key
3. **API Key:** Direct `pa_xxx` key connection

**Security:**
- Rate limiting: login 5/min, connect 10/min
- Secure token storage via `safeStorage` (DPAPI/Keychain/libsecret)
- Multi-tenant isolation: `database.clearSalonData()` on salon switch

**IPC Channels:**
- `GET_CONFIG`, `SET_CONFIG` — config management
- `CONNECT`, `CONNECT_WITH_API_KEY`, `DISCONNECT`, `GET_STATUS`
- `AUTH_TELEGRAM_LOGIN_TOKEN`, `AUTH_CHECK_TOKEN`, `AUTH_LOGIN_EMAIL`
- `dialog:selectFolder`, `shell:openExternal`
- `app:set-auto-start`, `app:get-auto-start`

### AI Module / ZiraAI (`src/main/modules/zira.module.ts`)

LLM chat with tool execution, 3 operating modes.

**Modes:**
1. **Local:** OpenRouter API (grok-4.1-fast), full tool access, no server dependency
2. **Hybrid:** Local tool detection + server AI fallback
3. **Proxy:** Server-only, requires auth

**Tool Detection:** Pattern matching on Vietnamese + English messages for browser, Booksy, system operations.

**IPC Channels:** `ai:getStatus`, `ai:chat`, `ai:clearHistory`

**Conversation History:** In-memory, max 20 messages per user.

### Booksy Module (`src/main/modules/booksy.module.ts`)

Calendar sync via Chrome DevTools Protocol.

**Syncs:** Bookings, Customers, Staff, Resources, Services, Add-ons

**IPC Channels (17):**
- `booksy:get-status`, `booksy:get-config`, `booksy:set-config`
- `booksy:sync-now`, `booksy:start`, `booksy:stop`, `booksy:sync-all`
- `booksy:get-bookings`, `booksy:sync-customers`, `booksy:get-customers`
- `booksy:sync-staff`, `booksy:get-staff`
- `booksy:sync-resources`, `booksy:get-resources`
- `booksy:sync-services`, `booksy:get-services`
- `booksy:sync-addons`, `booksy:get-addons`

### Invoice Module (`src/main/modules/invoice.module.ts`)

Polish invoicing with KSeF e-invoice integration.

**Invoice Types:** RECEIPT, VAT, PROFORMA, CORRECTION, ADVANCE

**IPC Channels (30+):**
- CRUD: `list`, `get`, `create`, `update`, `delete`, `issue`, `cancel`, `duplicate`
- Print: `print` (thermal), `printA4`
- Payment: `markPaid`, `addPayment`
- Numbering: `getNextNumber`
- Corrections: `createCorrection`, `convertProforma`
- Customers: `customer.list`, `search`, `get`, `create`, `update`, `delete`
- Products: `product.list`, `search`, `get`, `create`, `update`, `delete`
- Settings: `seller.get`, `seller.update`, `vatRates.get`
- NIP Lookup: `lookup.nip`, `lookup.euVat`, `lookup.auto`
- KSeF: `ksef.send`, `ksef.sendBatch`, `ksef.getStatus`, `ksef.retry`

### Telegram Module (`src/main/modules/telegram.module.ts`)

Bot lifecycle, command routing, remote printer control.

**Commands:** status, screenshot, click, type, test-printer, open-drawer, print-label

**IPC Channels:** `TELEGRAM_GET_STATUS`, `TELEGRAM_RESTART`

### Remote Module (`src/main/modules/remote.module.ts`)

WebRTC remote desktop + SSH tunneling.

**Two Support Channels:**
1. **WebRTC:** Real-time screen sharing + input, P2P (STUN/TURN fallback)
2. **SSH Tunnel:** Persistent terminal access, auto-keygen, port 10001-10999

**Modes:** Attended (user approval dialog) or Unattended (PIN auto-accept)

**IPC Channels:** `remote:getState`, `acceptSession`, `rejectSession`, `endSession`
**SSH:** `sshTunnel:getStatus`, `disconnect`, `generateKey`, `start`

### Security Module (`src/main/modules/security.module.ts`)

Camera AI monitoring with Python YOLOv8 engine.

**Pipeline:** Python bridge → YOLO detection → AlertHandler → evidence + Telegram notification

**Algorithms:** loitering, recording, theft, fire, analytics_flow, analytics_staff

**IPC Channels (10):**
- `security:getStatus`, `getConfig`, `setConfig`, `start`, `stop`
- `security:restartCamera`, `getAlerts`, `clearAlerts`, `getAnalytics`

**Evidence:** 30-day retention, screenshots + clips on disk.

### Browser Module (`src/main/modules/browser.module.ts`)

Chrome automation + extension WebSocket bridge.

**Extension:** WebSocket on port 19999 for DOM access, tool execution.

**24 AI Tools:**
- Browser: `browser_setup`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_scroll_and_read`, `browser_close`, etc.
- Facebook: `facebook_create_post`, `facebook_get_messages`, `facebook_reply_message`, `facebook_search`, etc.

**IPC Channels:** `shell:launchChromeDebug`, `chrome:isRunning`, `chrome:checkAndPrompt`, `chrome:forceClose`

### Payment Controller (`src/main/pos/payment-controller.ts`)

Receipt printing + cash drawer.

**Printer Fallback:** fiscal → RECEIPT only; non-fiscal → TICKET → KITCHEN → RECEIPT

**Graceful Degradation:** If printer offline, payment still succeeds (receipt = false).

---

## 4. Hardware Drivers

### Thermal Driver (`src/main/hardware/thermal/thermal-driver.ts`)

ESC/POS protocol via temp files + Windows commands.

**Connection Types:**
- USB: `copy /b <file> \\%COMPUTERNAME%\<printer>` or PowerShell `Out-Printer`
- Serial: `mode.com COM3: baud=9600` + `copy /b <file> COM3:`

**Printer name sanitization:** Regex `/^[a-zA-Z0-9\s\-_.()]+$/` prevents injection.

### ESC/POS Formatter (`src/main/hardware/thermal/escpos-formatter.ts`)

Receipt + report formatting with ~25 ESC/POS commands.

**Key Commands:** INIT (`1B 40`), BOLD, DOUBLE_SIZE, ALIGN_CENTER, CUT_PARTIAL, DRAWER_KICK, QR_CODE, BARCODE_CODE128

**Reports:** Daily (Raport Dobowy), X-Report (snapshot), Z-Report (zeroing, legal requirement)

**Money format:** All prices in grosze (integer cents), display as `(grosze / 100).toFixed(2) + ' zl'`

### Posnet Driver (`src/main/hardware/thermal/posnet-driver.ts`)

Polish fiscal printer driver with 3-step auto-detection.

**Detection:**
1. Filter USB VID 1424 via `Win32_PnPEntity`
2. Test port can open via `System.IO.Ports.SerialPort`
3. Send status query (`STX + '#s' + ETX`), verify response byte `0x02`

**Status:** Mostly mock — `printReceipt()` logs data, actual POSNET commands pending.

### Zebra Label Driver (`src/main/hardware/thermal/label-driver.ts`)

ZPL label printing via Windows API P/Invoke.

**Pipeline:** ReceiptData → ZPL text → temp file → PowerShell P/Invoke (OpenPrinter, WritePrinter, ClosePrinter)

---

## 5. Database

### Architecture

- **Engine:** sql.js (SQLite compiled to WASM)
- **Storage:** In-memory for speed, auto-save every 5s to disk
- **Location:** `%APPDATA%/Zira AI/pos.db`
- **Save:** 3 retry attempts with backoff, notifies renderer on 2+ failures

### Schema (8 Migrations)

| Migration | Tables |
|-----------|--------|
| v1: Core POS | `categories`, `product_variants`, `orders`, `order_items`, `shifts`, `sync_queue`, `sync_metadata` |
| v2: Restaurant | Add `table_id`, `covers`, `order_type` to orders; `pos_tables`, `pos_customers`, `pos_staff` |
| v3: Invoicing | `seller_settings`, `invoice_customers`, `invoices`, `invoice_items`, `invoice_payments`, `invoice_sequences`, `accounting_products`, `vat_rates` |
| v4: KSeF | Add `ksef_number`, `ksef_status`, `ksef_error` to invoices |
| v5: POS Advanced | `pos_hold_orders`, `pos_quickkey_layouts`, `pos_quickkey_assignments`, `pos_recommended_items`, `sequence_counters` |
| v6: Check-in | `checkins` |
| v7: Indices | `orders(shift_id, created_at)`, `pos_customers(nip)` |
| v8: Billiard | `billiard_resources`, `billiard_floor_plans`, `billiard_table_layouts`, `billiard_combos`, `billiard_combo_items`, `billiard_sessions`, `billiard_session_items`, `billiard_mutation_queue` |

### Key Tables

**orders:** id, order_number, status, subtotal, discount, tax, total, payment_method, payment_amount, change_amount, staff_id, staff_name, customer_id, customer_name, customer_nip, shift_id, source, synced, backend_id, table_id, covers, order_type, tip, mode

**invoices:** id, invoice_number (unique), type, status, issue_date, sale_date, due_date, seller/customer snapshots, total_net, total_vat, total_gross, vat_summary (JSON), payment_method, payment_status, ksef_number, ksef_status

**billiard_sessions:** id, resource_id, status, billing_mode (per_minute|hourly|combo), guest_count, started_at, total_minutes, total_charges (grosze), combo_id

**sync_queue:** id, entity_type, entity_id, action, payload (JSON), attempts, last_error, next_retry_at

### Data Conventions

- **Prices:** Integer grosze (cents), never float
- **IDs:** Text UUIDs
- **Timestamps:** ISO 8601 strings
- **Atomic numbering:** SQLite transactions for invoice/order number generation
- **Tenant isolation:** `clearSalonData()` wipes all salon-specific tables on switch

### Repositories (`src/main/database/repos/`)

| Repo | Key Methods |
|------|-------------|
| orderRepo | `create(order, items)`, `getDailyStats(shiftId)`, `generateOrderNumber()` |
| invoiceRepo | `create(dto)`, `getNextNumber(type)`, `calculateVat(items)`, `markSynced(id, backendId)` |
| productRepo | `upsertMany(products)`, `search(query)`, `getByBarcode(code)` |
| customerRepo | `search(query)`, `increaseDebt(id, amount)`, `upsertMany(customers)` |
| checkinRepo | `create(data)`, `getToday()`, `getByDate(date)`, `getStats(date)` |

---

## 6. IPC Bridge Reference

### Preload (`src/preload/preload.ts`)

All methods exposed via `window.electronAPI`:

#### Config & Connection (7 methods)
```
getConfig(), setConfig(config), saveConfig(config)
connect(), connectWithApiKey(apiKey), disconnect(), getStatus()
```

#### Hardware (4 methods + 4 listeners)
```
listPorts(), listWindowsPrinters(), testPrint(), testPrinterByType(type)
onConnectionStatus(cb), onDeviceStatus(cb), onPrintJob(cb), onBarcodeScanned(cb)
```

#### Auth (6 methods)
```
auth.generateLoginToken(), auth.checkToken(token), auth.generateRegisterToken()
auth.getUser(), auth.logout(), auth.loginWithEmail(email, password)
```

#### POS (40+ methods)
```
pos.getState(), pos.dispatch(action), pos.onStateChanged(cb)
pos.products.getAll(), getByCategory(id), search(q), getByBarcode(code)
pos.categories.getAll()
pos.orders.create(order, items), orders.getDailyStats(date)
pos.payment.printReceipt(id, type, nonFiscal), openCashDrawer(), cardPayment(data), getPrinterStatus(), onElavonStatus(cb)
pos.shift.open(data), shift.close(data)
pos.sync.products(), sync.orders(), onProductsSynced(cb), onCatalogUpdated(cb), onStockUpdated(cb)
pos.tables.getAll(), getActive(), updateStatus(id, s, orderId), clearTable(id), setCovers(id, n)
pos.customers.getAll(), search(q), getById(id), increaseDebt(id, amt)
pos.staff.getAll()
pos.hold.create(id, title, payload), list(), get(id), remove(id)
pos.quickKeys.list(mode), get(id), create(id, data), update(id, data), remove(id), assign(regId, mode, layoutId), getAssigned(regId, mode)
```

#### Billiard (12 methods)
```
billiard.getFloorOverview(), getSession(id), getCombos(activeOnly), getFloorPlans()
billiard.getFnbProducts(search, catId), getFnbCategories(), getResourceType(code), getRestaurantCombos()
billiard.mutate(op, method, path, body)
billiard.printReceipt(sessionId, payment, receiptType, nonFiscal), openCashDrawer(), getPrinterStatus(), getSyncStatus()
billiard.onDataUpdated(cb)
```

#### Invoice (30+ methods)
```
invoice.list(filter), get(id), create(data), update(id, data), delete(id)
invoice.issue(id), cancel(id, reason), duplicate(id), print(id, opts), printA4(id)
invoice.markPaid(id), addPayment(id, amount, method, ref)
invoice.getNextNumber(type), createCorrection(origId, reason, items), convertProforma(id)
invoice.customer.list(), search(q), get(id), create(data), update(id, data), delete(id)
invoice.product.list(), search(q), get(id), create(data), update(id, data), delete(id)
invoice.seller.get(), seller.update(data)
invoice.vatRates.get()
invoice.lookup.nip(nip), lookup.euVat(vatId), lookup.auto(identifier)
invoice.ksef.send(id), ksef.sendBatch(ids), ksef.getStatus(), ksef.retry(id)
```

#### Booksy (17 methods)
```
booksy.getStatus(), getConfig(), setConfig(config), syncNow(), start(), stop(), syncAll()
booksy.getBookings(), syncCustomers(), getCustomers(), syncStaff(), getStaff()
booksy.syncResources(), getResources(), syncServices(), getServices(), syncAddons(), getAddons()
booksy.onStatusChanged(cb)
```

#### Checkin (11 methods)
```
checkin.getToday(), getByDate(date), create(data), updateStatus(id, status)
checkin.startService(id), complete(id), markNoShow(id), searchPhone(phone)
checkin.addUpsells(id, upsells), updateNotes(id, notes), getStats(date)
```

#### AI, Telegram, Remote, Security, SSH Tunnel
```
ai.getStatus(), ai.chat(msg, userId, attachments), ai.clearHistory(userId)
telegram.getStatus(), telegram.restart()
remote.getState(), acceptSession(), rejectSession(reason), endSession(reason), onStateChanged(cb)
security.getStatus(), getConfig(), setConfig(config), start(), stop(), restartCamera(id), getAlerts(limit, camId), clearAlerts(), getAnalytics(camId, date), onStatusChanged(cb), onAlert(cb)
sshTunnel.getStatus(), disconnect(), generateKey(), start(), onStatusChanged(cb)
```

#### Utilities
```
debug.openDevTools(), debug.openLogs(), debug.getDiagnostics()
setAutoStart(enabled), getAutoStart()
window.open(id), window.close(id), window.list()
display.list()
selectFolder()
shell.openExternal(url), shell.launchChromeDebug(port)
chrome.isRunning(), chrome.checkAndPrompt(), chrome.forceClose()
entitlements.fetch(), get(), isEnabled(feature), onChanged(cb)
deleteConfirm.getConfig(), deleteConfirm.verify(code)
update.check(), update.install(), update.onStatus(cb)
apiCall(method, path, body)
```

---

## 7. Types Reference (`src/shared/types.ts`)

1,897 lines of type definitions. Key types:

### Enums & Constants

```typescript
AgentStatus: PENDING | ACTIVE | DISABLED
PrinterProtocol: 'THERMAL' | 'POSNET' | 'ZEBRA' | 'WINDOWS'
PrinterType: RECEIPT | LABEL | A4 | TICKET | KITCHEN
PrintJobType: RECEIPT | INVOICE | REPORT | LABEL | BARCODE | TEST | DAILY_REPORT | X_REPORT | Z_REPORT
PrintJobStatus: PENDING | SENT | PRINTING | COMPLETED | FAILED | CANCELLED
InvoiceType: RECEIPT | VAT | PROFORMA | CORRECTION | ADVANCE
InvoiceStatus: DRAFT | ISSUED | SENT | PAID | PARTIALLY_PAID | OVERDUE | CANCELLED
RemoteSessionStatus: IDLE | PENDING | CONNECTING | CONNECTED | DISCONNECTED | FAILED
CheckinStatus: 'waiting' | 'in_service' | 'completed' | 'no_show'
FeatureKey: 'chat' | 'status' | 'booksy' | 'invoicing' | 'settings' | 'debug' | 'pos' | 'remote' | 'telegram' | 'security' | 'checkin' | 'billiard'
Tab: 'pos' | 'billiard' | 'chat' | 'status' | 'booksy' | 'checkin' | 'invoicing' | 'security' | 'settings' | 'debug'
AIProvider: 'openrouter' | 'openai' | 'anthropic' | 'google' | 'local'
SshTunnelState: 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting'
```

### Key Interfaces

- **AgentConfig** — Full configuration (217 lines): agent identity, printer settings, feature configs (telegram, ai, security, booksy)
- **ReceiptData** — Receipt with items, payment, VAT summary
- **DailyReportData** — Fiscal daily reports
- **InvoiceRow** — 50+ fields invoice entity
- **BooksySyncConfig/Status** — Booksy sync configuration and runtime status
- **TelegramConfig** — Bot config with DM/group policies, streaming settings
- **SecurityConfig** — Camera configs with zones, algorithms, RTSP streams
- **RemoteControlState** — Remote session state
- **SalonEntitlements** — Feature access per salon

---

## 8. Renderer / UI

### Component Organization (82+ files)

```
src/renderer/components/
├── Root (12): AuthScreen, BooksySync, Chat, CheckinTab, Debug, Settings, Sidebar, Status, TelegramConfig, etc.
├── pos/ (18): POSLayout, Cart, CategoryTabs, PaymentModal, ProductCard, ProductGrid, ShiftModal, HoldOrdersModal, QuickKeys, SearchBar, templates/ (retail, salon, b2b, restaurant)
├── billiard/ (25): BilliardFloorPlan (42KB), DraggableTable, PaymentDialog, SessionDetailModal, AddTableDialog, AddItemToTabModal, TransferTableDialog, EditContextMenu, FloorTabs, MeasurementOverlay, hooks/, menu/
├── invoicing/ (7): InvoicingTab, InvoiceForm, InvoiceList, QuickInvoice, CustomerManagement, CustomerPicker, SellerSettings
└── security/ (6): SecurityTab, LiveView, CameraGrid, CameraSettings, AnalyticsDashboard, AlertsList
```

### Entitlements System

```typescript
const DEFAULT_ENTITLEMENTS = {
  chat: true, status: true, pos: true, billiard: true, invoicing: true, checkin: true, settings: true,
  booksy: false, debug: false, remote: false, telegram: false, security: false,
};
```

Features with `false` default require paid subscription. Checked via `isFeatureEnabled(feature)` with expiration support.

### i18n System (`src/renderer/i18n/translations.ts`)

**Languages:** en, vi, tr, zh, uk, ru, pl (7 total)

**620 keys organized by:**
- `pos.*` (150+) — cart, shift, payment, modes, offline/online
- `invoice.*` (120+) — types, statuses, items, KSeF, VAT
- `billiard.*` (100+) — sessions, payment, floor plans, packages
- `settings.*` (45+) — printers, language, customer display
- `common.*` (20+) — add, save, cancel, delete, search
- `customer.*`, `chat.*`, `printer.*`, `telegram.*`, `ai.*`, `sidebar.*`, etc.

**Usage:**
```typescript
import { getTranslation } from '../../i18n/translations';
const t = getTranslation('en');
t('pos.cart.total'); // "Total"
```

### Multi-Window Vite Build

3 entry points compiled as separate bundles:

| Window | Entry | Output | Size |
|--------|-------|--------|------|
| Main | `src/renderer/index.html` | `dist/renderer/assets/main-[hash].js` | ~450KB |
| POS | `src/renderer/windows/pos/index.html` | `dist/renderer/assets/pos-[hash].js` | ~280KB |
| Customer | `src/renderer/windows/customer/index.html` | `dist/renderer/assets/customer-[hash].js` | ~220KB |

**Critical Plugin:** `removeCrossOrigin()` strips `crossorigin` attributes (breaks Electron's `file://` protocol).

---

## 9. Config & Storage

### AgentConfig (`%APPDATA%/Zira AI/config.json`)

```typescript
{
  agentId?: string,           // Unique agent ID
  salonId?: string,           // Salon ownership
  name: string,               // Display name
  machineId: string,          // Device fingerprint
  language?: Language,         // UI language
  apiKey?: string,            // pa_xxx API key
  isPaired: boolean,          // Pairing status
  serverUrl: string,          // Backend URL
  printers?: PrintersConfig,  // Multi-printer config
  printerPort?: string,       // Legacy single printer
  printerProtocol: PrinterProtocol,
  telegram?: TelegramConfig,
  ai?: { enabled, localMode, apiKey, model, maxTokens, temperature, provider },
  security?: SecurityConfig,
  booksy?: BooksySyncConfig,
  sidebarCollapsed?: boolean,
}
```

### Secure Storage

Auth tokens and API keys encrypted via Electron `safeStorage`:
- Windows: DPAPI
- macOS: Keychain
- Linux: libsecret

---

## 10. Build & Deploy

### Development

```bash
cd print-agent
npm run dev       # Vite dev server (port 3100) + TS watch
```

### Production Build

```bash
npm run build      # TypeScript compile + Vite build
npm run dist:win   # electron-builder → NSIS installer
```

**Output:** `release/Zira AI Setup <version>.exe`

### Auto-Update

CDN: `https://img.zira.pl/downloads/`

```typescript
update.check()     // Check for new version
update.install()   // Download and install
update.onStatus(cb) // Progress tracking
```

### Package.json Build Config

```json
{
  "build": {
    "appId": "com.zira-ai.print-agent",
    "productName": "Zira AI",
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "runAfterFinish": true
    }
  }
}
```

---

## 11. File Reference

### Core
| File | Purpose | LOC |
|------|---------|-----|
| `src/main/index.ts` | Electron entry, exception handling | 310 |
| `src/main/core/orchestrator.ts` | Module lifecycle, window management | 500+ |
| `src/main/core/container.ts` | DI container | 80 |
| `src/main/core/event-bus.ts` | Typed pub/sub | 100 |
| `src/preload/preload.ts` | IPC bridge (120+ methods) | 508 |
| `src/shared/types.ts` | Type definitions | 1,897 |
| `src/shared/electron.d.ts` | ElectronAPI type contract | 517 |

### Modules
| File | Purpose |
|------|---------|
| `src/main/modules/hardware.module.ts` | Printer/scanner drivers |
| `src/main/modules/pos.module.ts` | Point of sale (60+ IPC) |
| `src/main/modules/sync.module.ts` | Backend data sync |
| `src/main/modules/auth.module.ts` | Auth + connection |
| `src/main/modules/booksy.module.ts` | Booksy calendar sync |
| `src/main/modules/invoice.module.ts` | Polish invoicing (KSeF) |
| `src/main/modules/telegram.module.ts` | Telegram bot |
| `src/main/modules/zira.module.ts` | AI/LLM integration |
| `src/main/modules/remote.module.ts` | Remote desktop (WebRTC) |
| `src/main/modules/security.module.ts` | Camera AI (YOLO) |
| `src/main/modules/browser.module.ts` | Web automation |
| `src/main/pos/payment-controller.ts` | Payment processing |

### Hardware
| File | Purpose |
|------|---------|
| `src/main/hardware/thermal/thermal-driver.ts` | ESC/POS thermal |
| `src/main/hardware/thermal/posnet-driver.ts` | Posnet fiscal |
| `src/main/hardware/thermal/escpos-formatter.ts` | Receipt formatting |
| `src/main/hardware/thermal/label-driver.ts` | Zebra ZPL labels |

### Database
| File | Purpose |
|------|---------|
| `src/main/database/database.ts` | SQLite management |
| `src/main/database/migrations/` | 8 schema migrations |
| `src/main/database/repos/` | Data repositories |

### Renderer
| File | Purpose | Size |
|------|---------|------|
| `src/renderer/App.tsx` | Root component | 9KB |
| `src/renderer/i18n/translations.ts` | 620 keys x 7 langs | 140KB |
| `src/renderer/components/Settings.tsx` | Settings panel | 70KB |
| `src/renderer/components/billiard/BilliardFloorPlan.tsx` | Floor plan | 42KB |
| `src/renderer/components/pos/POSLayout.tsx` | POS orchestrator | 11KB |
| `src/renderer/components/pos/PaymentModal.tsx` | Payment UI | 14KB |

---

**Version:** 1.0.4 | **Updated:** 2026-02-18
