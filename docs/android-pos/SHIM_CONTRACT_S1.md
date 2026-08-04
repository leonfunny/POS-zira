# SHIM_CONTRACT_S1 — `window.electronAPI` surface required by the RETAIL POS flow

**Packet:** S1 (read-only inventory) → feeds S2 (shim skeleton).
**Date:** 2026-07-18
**Scope:** the retail cashier flow only — boot → staff login → catalog → cart → **CASH** checkout / order create → order history → shift open/close, plus the config/entitlement/connection/barcode reads that flow depends on, and the print calls reached during CASH checkout.
**Source of truth:** `src/shared/electron.d.ts` (typed surface), `src/shared/types.ts` (`IPC_CHANNELS`, `AuthUser`, `AgentConfig`), `src/preload/preload.ts` (channel→method map), `src/main/modules/{auth,pos,sync,hardware}.module.ts` + `src/main/entitlements/entitlements-controller.ts` (handlers), `src/main/network/api-client.ts` (backend routes).
**Renderers inventoried:** `src/renderer/windows/pos/{POSApp,main}.tsx`, `src/renderer/components/pos/POSLayout.tsx`, `src/renderer/components/pos/templates/retail/{RetailTemplate,QuickActions,retailBrowseFilters}.{tsx,ts}`, `src/renderer/components/pos/{retail-sale-flow,receipt-outcome}.ts`, `Cart.tsx`, `CartItem.tsx`, `PaymentModal.tsx`, `OrderHistoryModal.tsx`, `ShiftModal.tsx`, `ShiftReport.tsx`, `SearchBar.tsx`, `CategoryTabs.tsx`, `ProductGrid.tsx`, `ProductCard.tsx`, `QuickKeys.tsx`, `HoldOrdersModal.tsx`, `SyncConflictBanner.tsx`, and hooks `usePosStore`, `usePosDb`, `useProducts`, `useConfig`, `useAuth`, `useConnectionStatus`, `usePrinterStatus`, `useBarcode`, `useBarcodeForwarder`, `useEntitlements`, `usePosVoiceSearch`. (`useProducts` and `usePrinterStatus` are included for completeness but are **admin/hardware-only and not imported by the POS window** — see Excluded appendix.)

> **How to read disposition:**
> **PORT** = shim must implement for M1–M4 (real behavior).
> **STUB** = shim returns a benign, specified default (no real behavior); list notes the exact return value.
> **LATER** = reached by the flow but deferred to M5 (remote print); STUB until then.
> **EXCLUDE** = hardware / window-mgmt / restaurant / admin surface not applicable to Android; STUB no-op or compile-out.

---

## 0. Headline facts that shape the port

1. **The POS window does not perform login.** `POSLayout` imports neither `useAuth` nor `useConnectionStatus`. It boots from `useConfig()` → `getConfig()` (reads `config.authUser`) and calls `getStatus()` / `onConnectionStatus()` directly. On Windows the **main window** (`AuthScreen` + `useAuth`) logs in, then `setConfig({ authUser, salonId, salonName, salonSlug, posEnabled, customerDisplayEnabled })`; the POS window inherits the logged-in identity from config. **For Android the shim/shell must perform login itself** — so `auth.*` is in scope for M1 even though `POSLayout` never calls it.
2. **`posMode` defaults to `'salon'`** (`POSLayout.tsx:294`, synced from `config.posMode` at `:1192`). Retail renders only when `config.posMode === 'retail'` (`:1625`). The Android shell must seed `config.posMode = 'retail'` (there is no mode-switcher UI inside the POS window).
3. **Cart state is authoritative in the main process**, not the renderer: `usePosStore` = `pos.getState` + `pos.onStateChanged` + `pos.dispatch`. `RetailTemplate` *additionally* mirrors the cart to `localStorage` for crash recovery (keys in §7). Both layers must exist on Android.
4. **Hard-rail auth, verified:** every retail handler resolves its token via `getSecureAuthToken()` — the **staff JWT** (`access_token`) stored by `loginWithEmail`. The `pa_` salon-wide API key (`getSecureApiKey()`) is used **only** by excluded admin surfaces (product-admin writes, schedule-with-apikey, agent-printer management). The retail cashier flow is staff-JWT-only, matching plan §1 rail #1.
5. **`connect()` / `disconnect()` are NOT called by the POS window** (only by `useConnectionStatus`, which the POS window does not import). Android must never call `/print-agent/connect` — these are EXCLUDE.
6. **The renderer uses zero Node/Electron main-process globals** besides `window.electronAPI`. Only browser globals appear (`crypto.randomUUID`, `localStorage`, `CustomEvent`, `ResizeObserver`, `setTimeout`). No port polyfills needed beyond what a WebView already provides.

---

## 1. Disposition summary

| Disposition | Count | Meaning |
|---|---:|---|
| **PORT** | 30 | Real shim implementation required for M1–M4 |
| **STUB** | 24 | Benign default; no real behavior (events w/o device, admin/AI affordances, alt-login, fiscal probe) |
| **LATER** | 9 | Reached by CASH flow but deferred to M5 print; STUB shape given for M1–M4 |
| **EXCLUDE** | 18 | Hardware / window-mgmt / restaurant / admin-import — STUB no-op or compile-out |
| **Total methods** | **81** | |

(Methods counted are the unique `electronAPI.*` call paths observed in scope. Sub-methods of an excluded namespace that are never called by the retail flow are not individually counted; they appear in the appendix.)

### Minimal M1 subset (login + boot)

The smallest set that satisfies M1 (renderer boots on Android behind the shim; staff login; `/auth/me` confirms correct salon; session survives restart):

| # | Method | Disposition | Why required for M1 |
|---|---|---|---|
| 1 | `auth.loginWithEmail(email, password)` | PORT | `POST /api/v1/auth/login` → `{access_token, refresh_token, user}`; stores tokens; `setConfig({authUser, salonId,…})` |
| 2 | `auth.getUser()` | PORT | `GET /api/v1/auth/me` to verify the persisted session on boot |
| 3 | `auth.onExpired(cb)` | PORT | Event: JWT refresh rejected → drop to login |
| 4 | `auth.logout()` | PORT | Clear tokens + `authUser` |
| 5 | `getConfig()` | PORT | Returns sanitized `AgentConfig` (incl. `authUser`, `salonId`, `posMode='retail'`); drives boot + cart-key resolution |
| 6 | `onConfigUpdated(cb)` | PORT | Event: re-`getConfig()` after self/other-window config writes |
| 7 | `getStatus()` | STUB | Boot online check → `{ connected: true, deviceStatus: null }` |
| 8 | `onConnectionStatus(cb)` | STUB | Event: no-op unsubscribe (optionally wire `navigator.onLine`) |
| 9 | `entitlements.get()` | STUB | Feature-flag cache → all-enabled defaults (or cached fetch) |
| 10 | `entitlements.onChanged(cb)` | STUB | Event: no-op unsubscribe |
| 11 | `pos.getState()` | PORT | Initial POS store state (cart/session/display) |
| 12 | `pos.onStateChanged(cb)` | PORT | Event: live POS store updates |
| 13 | `pos.dispatch(action)` | PORT | Cart/session/checkout reducer actions |

M1 does **not** require catalog, sync, orders, shift, or print — those are M2–M5. `auth.generateLoginToken` / `checkToken` / `generateRegisterToken` (Telegram-QR login) are **STUB** for the pilot; email login is primary.

---

## 2. Per-method contract

Call sites are `file:line` (≤5 representative). "Shape" columns are abridged; full types live in `src/shared/electron.d.ts`.

### 2.A — Boot · Config · Connection

| Method | Call sites | Request | Response | Main impl | Does | Disposition |
|---|---|---|---|---|---|---|
| `getConfig()` | `useConfig.ts:25,36,58`; `RetailTemplate.tsx:257`; `POSLayout.tsx:291` (via `useConfig`) | — | `AgentConfig` **sanitized** (all secrets stripped; keeps `authUser`, `salonId`, `salonName`, `salonSlug`, `posMode`, `posLanguage`, `language`, `allowOversell`, `showNonFiscalOrders`, `scale.{enabled,port}`, `booksy.hasJwt`) | `auth.module.ts:230` → `getRendererConfig` `:77` | LOCAL-CONFIG (electron-store read; secrets blanked) | **PORT** |
| `onConfigUpdated(cb)` | `useConfig.ts:35` | cb `() => void` | unsubscribe `() => void` | preload `:109` (`ipcRenderer.on('config-updated')`) | Event: ping → renderer re-`getConfig()` | **PORT** (emit on self `setConfig`) |
| `setConfig(partial)` / `saveConfig(partial)` | `useConfig.ts:46,52`; `POSLayout.tsx:291` (`saveConfig`) | `Partial<AgentConfig>` | merged `AgentConfig` | `auth.module.ts:232` (`SET_CONFIG`, both alias same channel) | LOCAL-CONFIG (electron-store write) | **PORT** (settings; STUB-ok M1–M3 if no settings UI — but needed to persist `posMode`/quick-keys) |
| `getStatus()` | `POSLayout.tsx:1215`; `useConnectionStatus.ts:27` | — | `{ connected: boolean; deviceStatus: DeviceStatus \| null }` | `auth.module.ts:305` | LOCAL (socket + device probe) | **STUB** → `{ connected: true, deviceStatus: null }` |
| `onConnectionStatus(cb)` | `POSLayout.tsx:1222`; `useConnectionStatus.ts:35` | cb `(status)=>void` | unsubscribe | preload `:213` (`connection-status`) | Event: live online/device status | **STUB** → no-op unsub (or `navigator.onLine`) |
| `connect()` / `disconnect()` | `useConnectionStatus.ts:47,51` (**not imported by POS window**) | — | `{ success: boolean }` | `auth.module.ts:286` / `:299` | Socket + `/print-agent/connect` | **EXCLUDE** (hard rail: never call `/print-agent/connect`) — STUB `{ success: true }` |

### 2.B — Auth · Login

| Method | Call sites | Request | Response | Main impl | Does | Disposition |
|---|---|---|---|---|---|---|
| `auth.loginWithEmail(email, password)` | `useAuth.ts:47`; `AuthScreen.tsx:607` | `(email: string, password: string)` | `{ success: boolean; data?: { user: AuthUser }; error?: string; restarting?: boolean }` — `AuthUser = { id, email, firstName, lastName, role, salonId, salonName? }` | `auth.module.ts:748` → `apiClient.loginWithEmail` `POST /api/v1/auth/login` | BACKEND-HTTP (staff). Stores `access_token`+`refresh_token` (safeStorage), `setConfig({authUser, salonId, salonName, salonSlug, posEnabled, customerDisplayEnabled})`. Rate-limited. | **PORT M1** |
| `auth.getUser()` | `useAuth.ts:14` | — | `{ success: boolean; data?: { isAuthenticated: boolean; user?: AuthUser }; error?: string }` | `auth.module.ts:690` → `apiClient.getMe` `GET /api/v1/auth/me` | BACKEND-HTTP (staff JWT). Boot verify. | **PORT M1** |
| `auth.onExpired(cb)` | `useAuth.ts:38` | cb `() => void` | unsubscribe | preload (`auth-expired` event) | Event: refresh-token rejected → force re-login | **PORT M1** |
| `auth.logout()` | `useAuth.ts:67` | — | `{ success: boolean }` | `auth.module.ts:731` | Clears secure tokens + `authUser`. | **PORT** |
| `auth.generateLoginToken()` | `useAuth.ts:56`; `AuthScreen.tsx:499,586` | — | `{ success; data?: TelegramLoginTokenResponse; error? }` | `auth.module.ts:681` (`AUTH_REGISTER_TOKEN`) / `AUTH_TELEGRAM_LOGIN_TOKEN` (archive) → `POST /api/v1/auth/telegram/login-token` | BACKEND-HTTP. Telegram-QR login. | **STUB** → `{ success:false, error:'telegram-login-unavailable' }` (email login is primary) |
| `auth.checkToken(token)` | `useAuth.ts:57`; `AuthScreen.tsx:527` | `(token: string)` | `{ success; data?: TelegramLoginTokenStatus; error? }` | `auth.module.ts:601` → `GET /api/v1/auth/telegram/login-token/:token` | BACKEND-HTTP poll. | **STUB** (as above) |
| `auth.generateRegisterToken()` | `useAuth.ts:58`; `AuthScreen.tsx:573` | — | token | `auth.module.ts:681` | BACKEND-HTTP. Telegram register. | **STUB** (as above) |

> **Windows side-effects the Android shim MUST NOT replicate (hard rail):**
> - `auth.loginWithEmail` (and Telegram `checkToken`) **fire-and-forget `connectWithAvailablePrintAgentKey()`**, which fetches `GET /api/v1/print-agent/my-key` (staff JWT) then calls `POST /api/v1/print-agent/connect` with the **`pa_` salon key** and opens the print-agent socket. Android must **skip this entirely** — never store/call the `pa_` key, never `/print-agent/connect`, never the socket (plan §1 rail #1). The shim's `loginWithEmail` does only: POST login → store staff JWT → `setConfig({authUser,…})`.
> - `auth.logout` on Windows **keeps the local SQL.js mirror** (orders/products) and only clears tokens + `authUser`/`salonName`/`salonSlug`/`agentId`/`isPaired`, so a re-login to the same salon is healthy. The shim should mirror this (logout ≠ wipe local POS data).
> - Tokens are persisted by Windows as `encryptedAuthToken` / `encryptedRefreshToken` (DPAPI via safeStorage in `%APPDATA%/Zira AI/config.json`). Android uses Capacitor secure storage (S4) — same logical keys, Keystore-backed.

### 2.C — POS Store (cart / session / display) — authoritative cart state

| Method | Call sites | Request | Response | Main impl | Does | Disposition |
|---|---|---|---|---|---|---|
| `pos.getState()` | `usePosStore.ts:139` (retail); `POSLayout.tsx:897,1009,1059` (restaurant only — EXCLUDE) | — | `PosState` `{ cart:{items,subtotal,discount,tax,total}, checkoutDraft, session:{shiftId,staffId,staffName,isOpen,openedAt}, display, activeCustomer?, tip? }` | `pos.module.ts:1022` (`pos:get-state`) | LOCAL (in-main POS store/reducer) | **PORT** |
| `pos.onStateChanged(cb)` | `usePosStore.ts:140` | cb `(state: PosState)=>void` | unsubscribe | preload (`pos:state-changed`) | Event: full state on every reducer change | **PORT** |
| `pos.dispatch(action)` | `usePosStore.ts:145` (retail); `POSLayout.tsx:852,855,876,948` (restaurant only — EXCLUDE) | `PosAction` union: `cart/{addItem,removeItem,updateQuantity,clear,applyDiscount,clearDiscount,setItemNotes,setItemPrice,setItemStaff,setItemCourse}`, `checkoutDraft/{update,clear}`, `session/{open,close}`, `display/setMode`, `customer/{select,clear}`, `tip/{set,clear}` | `{ success: true }` | `pos.module.ts:1027` (`pos:dispatch`) | LOCAL (store reducer) | **PORT** |

> **Cart persistence note:** the store is the source of truth; `RetailTemplate` mirrors to `localStorage` (§7). `pos.dispatch` carries `CartItem = { id, variantId, name, sku, price, quantity, total, saleUnit, sellBy, imageUrl?, vatRate, name_translations }` (prices integer grosze).

### 2.D — Catalog

| Method | Call sites | Request | Response | Main impl | Does | Disposition |
|---|---|---|---|---|---|---|
| `pos.products.getAll()` | `RetailTemplate.tsx:333,343,473` | — | `PosProduct[]` | `pos.module.ts:1319` → `productRepo.getAll()` | LOCAL-DB (SQL.js) | **PORT M2** |
| `pos.products.getById(id)` | `RetailTemplate.tsx:671,855`; `Cart.tsx:622`; `POSLayout.tsx:480` | `(id: string)` | `PosProduct \| null` | `pos.module.ts:1328` | LOCAL-DB | **PORT M2** |
| `pos.products.getByBarcode(code)` | `RetailTemplate.tsx:808,870`; `POSLayout.tsx:1128,648,705` | `(barcode: string)` | `PosProduct \| null` | `pos.module.ts:1327` | LOCAL-DB | **PORT M2** |
| `pos.products.search(query)` | `RetailTemplate.tsx:396,884` | `(query: string)` | `PosProduct[]` | `pos.module.ts:1325` | LOCAL-DB | **PORT M2** |
| `pos.products.searchByCode(query)` | (not on retail template; admin) | `(query)` | `PosProduct[]` | `pos.module.ts:1326` | LOCAL-DB | **STUB** → `[]` |
| `pos.categories.getAll()` | `RetailTemplate.tsx:332,342,472` | — | `PosCategory[]` | `pos.module.ts:1329` → `productRepo.getCategories()` | LOCAL-DB | **PORT M2** |
| `pos.categories.getAllIncludingEmpty()` | `POSLayout.tsx:540` (scan-import, admin) | — | `PosCategory[]` | `pos.module.ts:1330` | LOCAL-DB | **STUB** → `[]` |
| `pos.draftProducts.searchByCode(q)` / `getAll()` / `getByBarcode(b)` | `RetailTemplate.tsx:403` (searchByCode only) | varies | draft rows | `pos.module` (`pos:draft-products:*`) | LOCAL-DB | **STUB** → `[]` / `null` |
| `pos.masterCatalog.lookupByEan(ean)` | `POSLayout.tsx:549,568` (scan-import, admin) | `(ean: string)` | `{ ok: boolean; draft: any \| null; error? }` | `pos.module` (`pos:master-catalog:lookupByEan`) | LOCAL-DB / backend lookup | **STUB** → `{ ok:false, draft:null }` |

`PosProduct = { id, template_id, name, sku, barcode, retail_price, category_id, image_url, in_stock, available_qty, vat_rate, is_active, is_on_sale, thumbnail_url, sale_unit, sell_by?, updated_at }` (prices integer grosze). `PosCategory = { id, name, image_url, icon, color, sort_order, updated_at, kitchen_print? }`.

### 2.E — Sync (catalog pull + order push)

| Method | Call sites | Request | Response | Main impl | Does | Disposition |
|---|---|---|---|---|---|---|
| `pos.sync.products()` | `RetailTemplate.tsx:542` (manual sync); `useProducts.ts:192` (admin) | — | `{ success: boolean; productsCount?: number; error?: string }` | `sync.module.ts:137` → `apiClient.getPosProducts` `GET /api/v1/warehouse/public/products` (+ `/sync-v2` cursor) → writes local SQL.js | MIXED (HTTP pull + local write); staff JWT via `getSecureAuthToken()` (`sync.module.ts:690`) **plus `X-Salon-Slug` header** from config | **PORT** (S6) |
| `pos.sync.orders()` | `PaymentModal.tsx:509` | — | `Promise<void>` | `sync.module.ts:141` → `order-sync` worker uploads pending orders `POST /api/v1/b2b/pos/orders` (`src/main/sync/order-sync.ts:99`, staff JWT) | MIXED (local queue → HTTP push) | **PORT** (S8) |
| `pos.sync.onProductsSynced(cb)` | `RetailTemplate.tsx:469`; `useProducts.ts:174` | cb `()=>void` | unsubscribe | preload (`pos:products-synced`) | Event: catalog reload | **PORT** |
| `pos.sync.onCatalogUpdated(cb)` | `useProducts.ts:175` (admin hook only) | cb `(data)=>void` | unsubscribe | preload (`pos:catalog-updated`) | Event | **STUB** |
| `pos.sync.onStockUpdated(cb)` | `useProducts.ts:176` (admin hook only) | cb `(data)=>void` | unsubscribe | preload (`pos:stock-updated`) | Event | **STUB** |
| `pos.sync.onDraftProductsSynced(cb)` | `useProducts.ts:177` (admin hook only) | cb `()=>void` | unsubscribe | preload | Event | **STUB** |
| `pos.sync.onOrderSynced(cb)` | `OrderHistoryModal.tsx:1424` | cb `({orderId, backendId})=>void` | unsubscribe | preload (`pos:order-synced`) | Event: refresh history | **PORT** |
| `pos.sync.onOrderSyncFailed(cb)` | `OrderHistoryModal.tsx:1432` | cb `({orderId, orderNumber, error, code?})=>void` | unsubscribe | preload (`pos:order-sync-failed`) | Event | **PORT** |
| `pos.sync.eventStatus()` / `getConflicts()` / `resolveConflict()` / `onSyncEntry(cb)` | `SyncConflictBanner.tsx:53,69,80` | varies | conflict rows | `pos.module` / `sync.module` | LOCAL-DB sync-log | **STUB** (banner can render empty) |

### 2.F — Cart payment · CASH order create

Cashier taps **Complete** with `method==='CASH'`, `splitMode===false` → `PaymentModal.completePayment()` fires, in order: (1) `pos.orders.create` → (2) `pos.sync.orders()` fire-and-forget → (3) `pos.payment.printReceiptAndOpenDrawer` (CASH) → (4) optional `pos.payment.printFiscalReceipt`. (INVOICE-only `pos.customers.increaseDebt` is skipped — CASH port.)

| Method | Call sites | Request | Response | Main impl | Does | Disposition |
|---|---|---|---|---|---|---|
| `pos.orders.create(order, items)` | `PaymentModal.tsx:503` | `order: { id, order_number:null, number_series:'FISCAL'\|'ORDER', status:'COMPLETED', subtotal, discount, tax, total, payment_method:'CASH', payment_amount, change_amount, staff_id, staff_name, customer_id, customer_name, customer_nip, shift_id (REQUIRED), source:'POS', table_id, covers, order_type:'standard', tip, mode:'retail', synced:0, backend_id:null, created_at, synced_at:null, payment_tenders, kitchen_number }`; `items: [{ id, order_id, variant_id, name, sku, price, quantity, sale_quantity, sale_unit, sell_by:'PIECE'\|'WEIGHT', total, vat_rate, staff_id, staff_name, notes, course }]` (grosze integers) | `{ success: boolean; id?: string; error?: string }` | `pos.module.ts:3053` → `orderRepo.create(normalizedOrder, normalizedItems)`; backend sync enqueued separately | MIXED (LOCAL-DB insert; HTTP push via order-sync). Staff JWT. | **PORT M3** |
| `pos.payment.hasFiscalPrinter()` | `PaymentModal.tsx:211` | — | `{ success: boolean; configured: boolean; connected: boolean }` | `pos.module` (`pos:has-fiscal-printer`) | HARDWARE probe (fiscal) | **STUB** → `{ success:true, configured:false, connected:false }` |
| `pos.payment.printReceiptAndOpenDrawer(orderId)` | `PaymentModal.tsx:548` | `(orderId: string)` | `{ success; receiptPrinted: boolean; drawerOpened: boolean; error? }` | `pos.module.ts:3629` region (`pos:print-receipt-and-open-drawer`) → thermal printer + cash drawer (creates print job) | HARDWARE (thermal + drawer) | **LATER** (M5); M1–M4 **STUB** → `{ success:true, receiptPrinted:false, drawerOpened:false }` |
| `pos.payment.printReceipt(orderId)` | `PaymentModal.tsx:549,680` | `(orderId: string)` | `{ success; receiptPrinted: boolean; error? }` | `pos.module.ts:3629` (`pos:print-receipt`) | HARDWARE (thermal) | **LATER** (M5); STUB as above |
| `pos.payment.printFiscalReceipt(orderId)` | `PaymentModal.tsx:353`; `OrderHistoryModal.tsx:1513` | `(orderId: string)` | `{ success; fiscalPrinted: boolean; error? }` | `pos.module` (`pos:print-fiscal-receipt`) | HARDWARE (fiscal) | **LATER**/EXCLUDE; STUB → `{ success:true, fiscalPrinted:false }` |
| `pos.customers.increaseDebt(id, amount)` | `PaymentModal.tsx:521` (**INVOICE branch only — CASH port skips**) | `(id: string, amount: number)` | `Promise<void>` | `pos.module` | LOCAL-DB (B2B debt) | **EXCLUDE**/STUB (void) |

> **`pos.orders.create` Windows semantics — port byte-for-byte (S8):**
> - **Shift enforcement:** the handler queries the local `shifts` table for an open shift (`closed_at IS NULL`) and copies `shift_id`/`staff_id`/`staff_name` onto the order; it aborts with a user-facing error if any is missing. (Renderer mirrors this: `PaymentModal` blocks Complete when `!session.shiftId`.)
> - **Item normalization:** each line is rebuilt via `shared/pos-sale.ts` helpers (`getLineSellBy`, `getLineSaleQuantity`, `getLineTotalGrosze`); all amounts are **integer grosze**. Stock is decremented locally per item (`productRepo.decrementStock`, `allowNegative` per `allowOversell`).
> - **Local-first + durable:** `orderRepo.create()` inserts the order + items into SQL.js, then `database.save()` **flushes the DB image immediately** (paid orders must survive a crash). Returns `{success:true, id}` (or `{success:true, id, duplicate:true}` on an id race — **not** an error).
> - **Backend push is async, not inline.** `OrderSync.syncPendingOrders()` (`src/main/sync/order-sync.ts`) drains the outbox using the staff JWT (`getSecureAuthToken`):
>   1. `apiClient.createPosOrder(token, dto)` → **`POST /api/v1/b2b/pos/orders`**
>   2. immediately `apiClient.finishOrder(token, backendId)` → **`POST /api/v1/b2b/pos/orders/:id/finish`** (backend deducts stock on finish)
>   3. on success `orderRepo.markSynced(localId, backendId, backendOrderNumber)` + emit `pos:order-synced`.
> - **Order-sync DTO** sent to the backend (built in `order-sync.ts:164-225`): `{ id, priceType:'brutto', requiresInvoice:!!customer_nip, posLocalCreatedAt, items:[{ variantId, quantity, unitPrice, … }], tenders?:[{ method, amountDecimalPLN }], paymentMethod, staffId, staffName, shiftId, customerId, customerNip, customerName, source, orderType, mode, discountAmountDecimalPLN, paymentAmountDecimalPLN, changeAmountDecimalPLN, tipDecimalPLN }`. (Note: backend DTO uses **PLN decimals** (`/100`), while the local row + renderer use integer grosze.)
> - **Retry policy:** transient errors retry up to `MAX_SYNC_ATTEMPTS = 5`; business errors (insufficient stock, price mismatch) shelve immediately with `synced = -1`. `pos.orders.retrySync` resets and re-drains the same pair.
> - **`number_series`** is `'ORDER'` for CASH/BLIK/INVOICE, `'FISCAL'` for CARD/TRANSFER. A single `orderAttemptIdRef` UUID is generated at modal mount (`PaymentModal.tsx:143`) and reused across retries — preserve this double-tap guard.

### 2.G — Order history

| Method | Call sites | Request | Response | Main impl | Does | Disposition |
|---|---|---|---|---|---|---|
| `pos.orders.getHistory(filters)` | `OrderHistoryModal.tsx:1359` | `{ from:'YYYY-MM-DD', to:'YYYY-MM-DD', paymentMethod?, staffName?, page?, limit?, fiscalOnly? }` | `{ orders: PosOrderRow[]; total; page; limit }` | `pos.module.ts:3214` → `orderRepo` | LOCAL-DB | **PORT** |
| `pos.orders.getServerList(params)` | `OrderHistoryModal.tsx:1357` | `{ period?, from?, to?, customerId?, staffId?, staffName?, search?, paymentMethod?, paymentStatus?, status?, requiresInvoice?, page?, limit? }` | `{ orders, items:Record<id,PosOrderItemRow[]>, total, page, limit, source:'server'\|'unconfigured'\|'network-error', error? }` | `pos.module.ts:4040` → `apiClient.getServerOrders` `GET /api/v1/b2b/pos/orders` | BACKEND-HTTP (staff) | **PORT** |
| `pos.orders.getDetail(orderId)` | `OrderHistoryModal.tsx:1427,1435,1457,1471,1672` | `(orderId: string)` | `{ order: PosOrderRow; items: PosOrderItemRow[] } \| null` | `pos.module.ts:3243` → `orderRepo` | LOCAL-DB | **PORT** |
| `pos.orders.retrySync(orderId)` | `OrderHistoryModal.tsx:824` | `(orderId: string)` | `{ success; result?; summary?; error? }` | `pos.module.ts:3997` → order-sync retry | MIXED (HTTP push) | **PORT** |
| `pos.orders.cancel(orderId)` | `OrderHistoryModal.tsx:1781` | `(orderId: string)` | `{ success; error? }` | `pos.module` | LOCAL/HTTP | **LATER**/STUB (void extra) |
| `pos.orders.deleteLocal(orderId)` | `OrderHistoryModal.tsx:1604` | `(orderId: string)` | `{ success; restocked?; error? }` | `pos.module` | LOCAL-DB | **LATER**/STUB |
| `pos.orders.mutate(orderId, data)` | `OrderHistoryModal.tsx:1093` | `{ type:'payment'\|'items'\|'void', reason?, paymentMethod?, paymentAmount?, changeAmount?, items?, restock? }` | `{ success:false, error:'Order changes are unavailable on Android. Use Delete local for an unsynced order; correct a synced order at the Windows counter.' }` | `pos.module` | LOCAL-DB | **LATER**/STUB — refuse; use Delete local for unsynced orders, Windows for synced orders |
| `pos.orders.mirrorFromServer(orderId, kind)` | `OrderHistoryModal.tsx:1657` | `(orderId, 'cash'\|'invoiced')` | `{ success; localOrderId?; wasSplit?; error? }` | `pos.module` | LOCAL insert from server | **LATER**/STUB |
| `pos.orders.refund(orderId, data)` | `OrderHistoryModal.tsx:518` | `{ type:'FULL'\|'PARTIAL', refundRequestId, reason, computedRefundTotal, lines:[{variantId?,sku?,name,quantity,unit,unitPrice,refundAmount,restock,vatRate}], manualAdjustmentAmount? }` | `{ success; refundedLines?; refundAmount?; receiptPrinted?; mutationDetected?; requiresRefresh?; error? }` | `pos.module` → `POST /api/v1/b2b/pos/orders/:id/refund` | BACKEND-HTTP (staff) | **LATER**/STUB (refund/invoice extra) |
| `pos.orders.downloadPdf(orderId, kind, invoiceType?)` | `OrderHistoryModal.tsx:919` | `(orderId, 'receipt'\|'invoice', 'VAT'\|'PROFORMA'?)` | `{ success; filePath?; error? }` | `pos.module` → `GET /api/v1/b2b/pos/orders/{cash\|invoiced}/:id/{receipt-pdf\|invoice-pdf}` | BACKEND-HTTP | **LATER**/STUB (invoice extra) |
| `pos.orders.addInvoice(orderId, data)` | `OrderHistoryModal.tsx:938` | `(orderId, { customerNip, invoiceType? })` | `{ success; order?; error? }` | `pos.module` → `PATCH /api/v1/b2b/pos/orders/:id/add-invoice` | BACKEND-HTTP | **LATER**/STUB (invoice extra) |
| `pos.orders.generateProforma(orderId)` | `OrderHistoryModal.tsx:949` | `(orderId: string)` | `{ success; proforma?; error? }` | `pos.module` → `POST /api/v1/b2b/pos/orders/:id/generate-proforma` | BACKEND-HTTP | **LATER**/STUB (invoice extra) |
| `pos.customers.lookupNip(nip)` | `OrderHistoryModal.tsx:928` | `(nip: string)` | `{ success; data?; error? }` | `pos.module` | HTTP (GUS) | **LATER**/STUB (invoice extra) |

> **Core history (view-only)** = `getHistory` + `getServerList` + `getDetail` + `reprintReceipt`. Refund / void / invoice / PDF / NIP are invoice-refund extras reachable from the detail panel but **not required** for a pilot CASH cashier.

### 2.H — Shift

| Method | Call sites | Request | Response | Main impl | Does | Disposition |
|---|---|---|---|---|---|---|
| `pos.shift.open(data)` | `POSLayout.tsx:1242` | `{ staffId: string; staffName: string; openingCash: number }` (grosze) | `{ success; shiftId?: string; error? }` | `pos.module.ts:4650` → `apiClient.openPosShift` `POST /api/v1/pos/shifts/open` | BACKEND-HTTP (staff). On success dispatches `session/open`. | **PORT M4** |
| `pos.shift.close(data)` | `POSLayout.tsx:1253` | `{ shiftId: string; closingCash: number; fiscalOnly?: boolean }` | `{ success; report?: any; error? }` | `pos.module.ts:4659` → `apiClient.closePosShift` `POST /api/v1/pos/shifts/:id/close` | BACKEND-HTTP (staff). Report → `ShiftReport`. | **PORT M4** |
| `pos.staff.getAll()` | `ShiftModal.tsx:38` | — | `PosStaff[] = { id, user_id?, name, commission_rate, is_active, role? }[]` | `pos.module.ts:3408` → `staffRepo.getAll()` | LOCAL-DB (staff picker for open-shift) | **PORT M4** |
| `pos.shift.getActive()` | **not called by POS renderer** (session hydrates from `pos.getState`) | — | `{ success; shift?; error? }` | `pos.module.ts:4108` → `GET /api/v1/pos/shifts/active` | BACKEND-HTTP | **STUB** (unused in window; session comes from store) |

`ShiftReport` (read from props by `ShiftReport.tsx`): `{ shiftId, staffName, openedAt, closedAt, openingCash, closingCash, totalSales, totalOrders, cashTotal, cardTotal, blikTotal, transferTotal, difference, unsyncedOrders?, fiscalOnlySales? }` (grosze).

### 2.I — Print / receipt (reached during CASH checkout; deferred to M5)

All thermal/fiscal receipt + drawer calls create print jobs through the Windows agent. Per plan §3 M5 they are **LATER** (remote print via staff-JWT routes) and **STUB** for M1–M4.

| Method | Call sites | Disposition / STUB return |
|---|---|---|
| `pos.payment.printReceipt(orderId)` | `PaymentModal.tsx:549,680` | **LATER**; STUB `{ success:true, receiptPrinted:false, error:'no-printer' }` |
| `pos.payment.printReceiptAndOpenDrawer(orderId)` | `PaymentModal.tsx:548` | **LATER**; STUB `{ success:true, receiptPrinted:false, drawerOpened:false }` |
| `pos.payment.printFiscalReceipt(orderId)` | `PaymentModal.tsx:353`; `OrderHistoryModal.tsx:1513` | **LATER**/EXCLUDE; STUB `{ success:true, fiscalPrinted:false }` |
| `pos.payment.reprintReceipt(orderId)` | `OrderHistoryModal.tsx:1488` | **LATER**; STUB as printReceipt |
| `pos.payment.printRefundReceipt(orderId)` | `OrderHistoryModal.tsx:560,1487` | **LATER**; STUB as printReceipt |
| `pos.payment.getPrintAttempts(orderId)` | `OrderHistoryModal.tsx:1558` | **LATER**; STUB `{ success:true, attempts:[] }` |
| `pos.payment.getLatestFiscalAttempt(orderId)` | `OrderHistoryModal.tsx:1559` | **LATER**; STUB `{ success:true, attempt:null, printer:null }` |
| `pos.payment.getReconcilableFiscalAttempt(orderId)` | `OrderHistoryModal.tsx:1542` | **LATER**; STUB `{ success:true, attempt:null }` |
| `pos.payment.reconcileFiscalAttempt(orderId, didPrint)` | `OrderHistoryModal.tsx:1579` | **LATER**; STUB `{ success:false, error:'Fiscal attempt reconciliation is available on the Windows counter.' }` |

The `PrintReceiptResponse` contract consumed by `receipt-outcome.ts` is `{ success?: boolean; receiptPrinted?: boolean }`.

### 2.J — Scanner input (event)

| Method | Call sites | Request | Response | Does | Disposition |
|---|---|---|---|---|---|
| `onBarcodeScanned(cb)` | `useBarcode.ts:7`; `SearchBar.tsx:54`; `PaymentModal.tsx:880` | cb `(barcode: string)=>void` | unsubscribe | Event: HID scanner / keyboard wedge → barcode string | **PORT** (M2+); **STUB** no-op unsub until a device scanner (Capacitor camera/USB) is wired. Catalog side (`pos.products.getByBarcode`) is separate and PORT M2. |

### 2.K — Hardware (EXCLUDE)

| Method | Call sites | Disposition / STUB return |
|---|---|---|
| `scale.readWeight(options?)` / `pos.scale.readWeight` | `Cart.tsx:703`; `RetailTemplate.tsx:597`; `POSLayout.tsx:764,1145` (ref into `resolveRetailCartItem`) — only active when `config.scale.enabled` | **EXCLUDE**; STUB `{ success:false, weightKg:0, stable:false, code:'NO_SCALE', error:'no-scale' }` |
| `printLabel(barcode, text?, options?)` | `RetailTemplate.tsx:655`; `POSLayout.tsx:494` | **EXCLUDE**; STUB `{ success:false, error:'no-label-printer' }` |
| `listWindowsPrinters()` | `usePrinterStatus.ts:22` (**not imported by POS window**) | **EXCLUDE**; STUB `[]` |
| `testPrint()` | `usePrinterStatus.ts:38` | **EXCLUDE**; STUB `{ success:false, error:'no-printer' }` |
| `testPrinterByType(type)` | `usePrinterStatus.ts:49` | **EXCLUDE**; STUB `{ success:false, error:'no-printer' }` |

### 2.L — Window management (EXCLUDE)

| Method | Call sites | Disposition / STUB |
|---|---|---|
| `window.open(id)` | `RetailTemplate.tsx:961` (`'customer'`) | **EXCLUDE**; STUB `{ success:true }` (Android single-window) |
| `window.close(id)` | `RetailTemplate.tsx:973` | **EXCLUDE**; STUB `{ success:true }` |
| `window.list()` | `RetailTemplate.tsx:955` | **EXCLUDE**; STUB `[]` (no customer-display window) |

### 2.M — Admin / AI / restaurant (EXCLUDE or STUB)

| Method | Call sites | Disposition / STUB |
|---|---|---|
| `pos.productAdmin.updateVariant(variantId, payload)` | `Cart.tsx:623` (admin line-price edit bridge) | **EXCLUDE**; STUB `{ ok:false, code:'UNAUTHORIZED_PRODUCT_ADMIN' }` |
| `pos.recognition.analyze(payload)` / `pos.recognition.scanMatch(payload)` | `RetailTemplate.tsx:172-184`; `POSLayout.tsx:629` (auto-camera AI) | **EXCLUDE**; STUB `{ ok:false, products:[], error:'recognition-unavailable' }` |
| `pos.quickAdd.prepare(payload)` / `pos.quickAdd.finalize(payload)` | `POSLayout.tsx:613,635` (camera add-product) | **EXCLUDE**; STUB `{ ok:false, error:'quick-add-unavailable' }` |
| `pos.masterCatalog.lookupExternalByEan(ean)` / `importExternal(payload)` / `importDraft(payload)` | `POSLayout.tsx:554,698,699` (admin catalog import) | **EXCLUDE**; STUB `{ ok:false }` |
| `pos.voice.transcribe(payload)` | `usePosVoiceSearch.ts` | **EXCLUDE**; STUB `{ ok:false, error:'voice-unavailable' }` |
| `pos.pickupOrders.{machineId,listOpen,claim,claimByRef,release,settle,cancel}` | `POSLayout.tsx:906–1085,962,992` (restaurant block) | **EXCLUDE** (restaurant); STUB no-op / `[]` |
| `pos.onPickupOrderEvent(cb)` | `POSLayout.tsx:971` (boot sub, restaurant-semantic but unconditional) | **EXCLUDE**; STUB no-op unsub (or gate on posMode) |
| `pos.onFiscalUnknown(cb)` | `POSLayout.tsx:1231` (boot sub, shared) | **STUB** no-op unsub (no fiscal printer) |
| `pos.loyalty.lookupCustomer(phone)` | `PaymentModal.tsx:160,176` (optional; tolerates `undefined`) | **STUB** — leaving the bridge `undefined` is acceptable (PaymentModal guards with `?.`) |

### 2.N — Billiard (Bi-a) — online-only floor-plan/tab surface

Entitlement-gated (the `billiard` feature; the Android shell only mounts `BilliardFloorPlan` when `entitlements.get()` returns `features.billiard.enabled`). P1 is **online-only**: no local SQLite cache, no offline write queue (the Windows counterpart caches in `src/main/sync/billiard-sync.ts`). Reads hit the backend through the transport and **degrade to benign empty/offline defaults** when no transport is present so the renderer boots; **writes reject** — see the rule below. The aux namespaces the UI reaches via optional chaining (`reservation`/`happyHour`/`kds`/`stock`/`sessionHistory`/`billiardGuest`/`dailyReport`) are deliberately left `undefined` (P1 decision — safe via `?.`).

| Method | Call sites | Request | Response / S2 STUB default | Windows main impl | Disposition |
|---|---|---|---|---|---|
| `billiard.getFloorOverview()` | `useBilliardData.ts` | — | `{ tables:[], floorPlans:[], layouts:[], sessions:[], _fromCache:true }` | `billiard:get-floor-overview` → `getLocalFloorOverview()` (`billiard-sync.ts:633`) | **PORT** (T4 online) |
| `billiard.getSession(id)` | `useBilliardData.ts` | `(id: string)` | `null` | `billiard:get-session` | **PORT** |
| `billiard.getCombos(activeOnly?)` | `useBilliardData.ts` | `(activeOnly?: boolean)` | `[]` | `billiard:get-combos` (`GET /billiard/combos`) | **PORT** |
| `billiard.getFloorPlans()` | `useBilliardData.ts` | — | `[]` | `billiard:get-floor-plans` (`GET /billiard/floor-plans`) | **PORT** |
| `billiard.getFnbProducts(search?, categoryId?)` | `useBilliardData.ts` | `(search?, categoryId?)` | `[]` | `billiard:get-fnb-products` | **PORT** (may 404 → `[]`, P2 follow-up) |
| `billiard.getFnbCategories()` | `useBilliardData.ts` | — | `[]` | `billiard:get-fnb-categories` | **PORT** |
| `billiard.getResourceType(code)` | `useBilliardData.ts` | `(code: string)` | `null` | `billiard:get-resource-type` | **PORT** |
| `billiard.getRestaurantCombos()` | `useBilliardData.ts` | — | `[]` | `billiard:get-restaurant-combos` (`GET /restaurant/combos`) | **PORT** |
| `billiard.mutate(op, method, path, body?)` | `useBilliardApi.ts`; `useBilliardData.ts`; `PaymentDialog.tsx` | `(op, method, path, body?)` | **REJECT** `Error('Billiard requires a network connection.')` | `billiard:mutate` → `executeMutation` (`billiard-sync.ts:176`) | **PORT** — see reject rule |
| `billiard.getSyncStatus()` | `useBilliardData.ts` | — | `{ pending:0, lastSync:null, online:false }` | `billiard:get-sync-status` (`billiard-sync.ts:606`) | **PORT** |
| `billiard.onDataUpdated(cb)` | `useBilliardData.ts` | cb `(data:{ type:string })=>void` | no-op unsubscribe (never emits) | preload (`billiard:data-updated`) | **PORT** (emit on poll/refresh) |
| `billiard.printReceipt(sessionId, payment)` | `PaymentDialog.tsx` | `(sessionId, { method, amount })` | `{ success:true, receiptPrinted:false }` (NO_PRINTER_RESULT) | `billiard:print:receipt` (`sync.module.ts:307`, no-printer return `:390`) | **STUB** → NO_PRINTER_RESULT (T5 confirmed benign: no remote-print wiring — the backend dispatches receipts; both the stub and the real transport return `NO_PRINTER_RESULT`) |
| `billiard.openCashDrawer()` | `PaymentDialog.tsx` | — | `{ success:false }` | `billiard:print:open-drawer` | **STUB** (no drawer hardware on Android) |
| `apiCall(method, path, body?)` | (typed surface; origin/main routes online reads through `billiard.mutate` op `'online_api'` instead) | `(method, path, body?)` | **REJECT** `Error('This operation requires a network connection.')` | n/a (renderer proxy) | **PORT** — T4 allowlists `/billiard/` `/resources/` `/restaurant/` prefixes |

> **MONEY-PATH REJECT RULE (do not fake success):** `billiard.mutate` and `apiCall` MUST reject when no transport is present. origin/main's `useBilliardApi` routes **every** online read through `billiard.mutate('online_api', …)` and every write (layout update, resource create/rename/delete, booking create/cancel/check-in, session payment) through `billiard.mutate` too — so a synthetic success would silently drop a charge/mutation (incident history: the billiard `estimateCharge` pause bug; the server is the source of truth for charges). The S2 stub therefore rejects with a clear network-required error; the real transport (T4) forwards to the backend and surfaces the real error, never catching it into an optimistic "paid".
>
> **printReceipt contract:** the stub mirrors the exact literal Windows returns when no receipt printer is connected (`{ success:true, receiptPrinted:false }`, `sync.module.ts:390`). `PaymentDialog` treats `receiptPrinted:false` as "payment done, receipt skipped" (toast/warning), NOT payment failure — so settlement on a device with no local printer is never blocked. Pinned by `tests/android-billiard-shim.test.ts` and the `NO_PRINTER_RESULT` constant in `stubs.ts`.

---

## 3. Events / subscriptions (all `electronAPI.on*` / callbacks in scope)

Every subscription returns an unsubscribe `() => void`. The shim must expose the same call shape; for STUB events it returns a no-op unsubscribe and never emits.

| Event method | Subscriber | Payload to callback | Disposition |
|---|---|---|---|
| `onConfigUpdated(cb)` | `useConfig` | `()` (ping → re-`getConfig`) | **PORT** |
| `onConnectionStatus(cb)` | `POSLayout`, `useConnectionStatus` | `ConnectionStatus` (`{ connected, … }`) | **STUB** |
| `onBarcodeScanned(cb)` | `useBarcode`, `SearchBar`, `PaymentModal` | `barcode: string` | **PORT** (M2+) / **STUB** until scanner |
| `auth.onExpired(cb)` | `useAuth` | `()` | **PORT M1** |
| `pos.onStateChanged(cb)` | `usePosStore` | full `PosState` | **PORT** |
| `pos.onFiscalUnknown(cb)` | `POSLayout` (boot) | `{ orderId?, orderNumber?, code, detail? }` | **STUB** |
| `pos.onPickupOrderEvent(cb)` | `POSLayout` (boot) | `{ event, data }` | **EXCLUDE**/STUB |
| `pos.sync.onProductsSynced(cb)` | `RetailTemplate`, `useProducts` | `()` | **PORT** |
| `pos.sync.onCatalogUpdated(cb)` | `useProducts` (admin) | `(data)` | **STUB** |
| `pos.sync.onStockUpdated(cb)` | `useProducts` (admin) | `(data)` | **STUB** |
| `pos.sync.onDraftProductsSynced(cb)` | `useProducts` (admin) | `()` | **STUB** |
| `pos.sync.onOrderSynced(cb)` | `OrderHistoryModal` | `{ orderId, backendId }` | **PORT** |
| `pos.sync.onOrderSyncFailed(cb)` | `OrderHistoryModal` | `{ orderId, orderNumber, error, code? }` | **PORT** |
| `pos.sync.onSyncEntry(cb)` | `SyncConflictBanner` | `(data)` | **STUB** |
| `entitlements.onChanged(cb)` | `useEntitlements` | full `SalonEntitlements` | **STUB** |

---

## 4. Renderer use of Node/Electron globals besides `electronAPI`

**None found — no port polyfill required.** Every in-scope file talks to the main process exclusively through `window.electronAPI.*`. No `require`, `process`, `ipcRenderer`, `Buffer`, `__dirname`, `global`, or Node `crypto`. The only non-DOM globals used are standard browser APIs a WebView already provides:

- `crypto.randomUUID()` — cart-line / order-attempt / refund-request IDs (`RetailTemplate.tsx:277,922,942`; `retail-sale-flow.ts:111`; `PaymentModal.tsx:143,485`; `OrderHistoryModal.tsx:272`). Fallback in `OrderHistoryModal` uses `Date.now()`+`Math.random()`.
- `window.localStorage` — cart persistence (§7).
- `document.body.dataset.posPaymentOpen` / `posAddProductOpen` — cross-component flags (`PaymentModal.tsx:287,289`; `SearchBar.tsx:56`).
- `document.dispatchEvent(new CustomEvent('pos:focus-search' \| 'pos:manual-cart-action'))` (`RetailTemplate.tsx:515,578`) + listeners.
- `window.addEventListener('keydown')`, `ResizeObserver`, `setTimeout/setInterval/clear*`, `document.activeElement`, `requestAnimationFrame`.

`useBarcodeForwarder` calls `(window as any).electronAPI.sendKeyboardInput` per keystroke (HID wedge forwarder) — an EXCLUDE Android-side (Android has its own input stack); STUB it to a no-op.

---

## 5. `localStorage` / `sessionStorage` keys used by the retail flow

All access is `window.localStorage` (no `sessionStorage` anywhere in scope). **All cart persistence lives in `RetailTemplate.tsx`** — `usePosStore`, `Cart`, `PaymentModal`, etc. do **not** touch storage directly.

| Key | Shape | Read / Write sites | Notes |
|---|---|---|---|
| `pos.activeCart.${userId}` | `JSON.stringify(CartItem[])` where `CartItem = { id, variantId, name, sku, price, quantity, total, saleUnit, sellBy, imageUrl?, vatRate, name_translations }` (prices integer grosze) | Read `RetailTemplate.tsx:272` (restore on mount); Write `:295` (persist on cart change); Remove `:297` (cart empties), `:465` (after successful payment) | `userId = cfg.authUser.id || cfg.salonId || 'default'` (resolved via `getConfig()` at `:257`). **Skipped entirely** (key set to `null`) when `userId === 'offline'` or empty. On restore each item gets a fresh `crypto.randomUUID()` id and `total = price*quantity`. |
| `pos.heldCarts` | `JSON.stringify(Array<{ id: string; items: CartItem[]; total: number; createdAt: string }>)` (bounded to 6 most-recent) | Read `RetailTemplate.tsx:306` (load on mount); Write `:318` (save on heldCarts change) | Global key (single, not per-user). |

**Android port note:** WebView `localStorage` works as-is; no shim translation needed. The `${userId}` resolution depends on `getConfig().authUser.id` being populated — i.e. M1 login must `setConfig({ authUser })` before the POS template mounts, otherwise carts persist under `'default'`.

---

## 6. Excluded surfaces (imported by POS files but NOT retail-cashier)

These are reachable in the POS window graph but belong to other templates / admin / hardware and are **out of scope** for the retail cashier port (STUB or compile-out):

- **Restaurant / kitchen / pickup:** `pos.pickupOrders.*` (`POSLayout.tsx:906–1085,962,992`), `pos.onPickupOrderEvent` (`:971`), `pos.tables.*`, kitchen-self-order dispatches (`pos.dispatch` `checkoutDraft/update` with `kitchenSelfOrder`, `:855`), `kitchenCategories.*`. The boot `useEffect`s at `POSLayout.tsx:962,971,992` fire unconditionally (pickup `machineId` / `listOpen` / `onPickupOrderEvent`) — stub them to no-ops rather than removing, to avoid changing the renderer.
- **Salon template:** `SalonTemplate.tsx` (+ `StaffPicker`) — alternate `posMode`, not rendered for retail.
- **B2B template:** `B2BTemplate.tsx`, `CustomerPanel` — alternate `posMode`. `pos.customers.{lookupNip,increaseDebt}` are B2B-invoice paths.
- **Admin / product management:** `useProducts` (admin-only; not imported by any POS template), `pos.productAdmin.*`, `pos.draftProducts.*`, `pos.masterCatalog.{importExternal,importDraft,lookupExternalByEan,scanCreate}`, `AddProductWebviewPanel`, `ScanImportModal`, `QuickAddCameraModal`, `CategoryRankingSettings`, `StaffManagementSettings`, `QuickKeysLayoutManager`.
- **AI / camera:** `pos.recognition.{analyze,scanMatch}`, `pos.quickAdd.{prepare,finalize}`, `pos.voice.transcribe`, `usePosVoiceSearch`, `AutoCameraSearch`, `QuickAddCameraModal`.
- **Hardware:** `scale.readWeight`, `printLabel`, `listWindowsPrinters`, `testPrint`, `testPrinterByType`, `usePrinterStatus` (printer diagnostics — not the cashier window), `useBarcodeForwarder.sendKeyboardInput` (HID wedge).
- **Window mgmt / customer display:** `window.{open,close,list}` (`RetailTemplate.tsx:955–973`), `CustomerApp`.
- **Loyalty:** `pos.loyalty.lookupCustomer` (optional bridge, undefined-tolerant).
- **Telegram auth:** `auth.generateLoginToken` / `checkToken` / `generateRegisterToken` (QR login; email login is the pilot path).

---

## 7. Notes for S2 (shim skeleton)

1. **Expose a typed `window.electronAPI`** matching `src/shared/electron.d.ts` exactly (same method paths + arg orders). The renderer is unmodified; a signature mismatch silently breaks the port.
2. **M1 first:** implement the 13 methods in §1 (login + boot + store). Seed `config.posMode='retail'` and `authUser` so `RetailTemplate` mounts and resolves its cart key.
3. **Two persistence layers to reproduce:**
   - Main-process POS store → shim in-memory/SQL.js store backing `getState`/`dispatch`/`onStateChanged`.
   - `RetailTemplate` localStorage carts → works in WebView unchanged (§5).
4. **Auth = staff JWT only.** Shim stores `access_token`+`refresh_token` (Capacitor secure storage, S4) and attaches `Authorization: Bearer <jwt>` to catalog/orders/shift/entitlements calls. **Never** materialize the `pa_` salon key; the excluded admin surfaces are the only `getSecureApiKey()` consumers.
5. **CASH-only writes (plan rail #2):** `pos.orders.create` ships `payment_method:'CASH'`; electronic-tender paths (`pos.payment.cardPayment` / `onElavonStatus`) stay disabled. They are the one retail flow that is **not REST** — Windows drives card payment over Socket.IO (`requestElavonPayment` → `elavon:payment-response`) authenticated by the **`pa_` api-key**, which Android never holds. Excluded by both scope and the hard rail.
6. **Print = STUB until M5.** Return the specified benign defaults (§2.I) so the CASH checkout completes without a printer; the Windows counter keeps printing in the meantime (plan rail #6).
7. **Token storage location quirk:** on Windows the eNail JWT lives under `config.booksy.{enailJwt,encryptedEnailJwt}` and `getRendererConfig` reports `booksy.hasJwt`. The Android shim need not replicate this namespace, but `getConfig()` must keep `authUser`/`salonId`/`posMode` visible and must **strip all secret fields** exactly as `getRendererConfig` does (§2.A).
8. **Unconditional boot subscriptions** (`onConnectionStatus`, `onFiscalUnknown`, `onPickupOrderEvent`, pickup `machineId`/`listOpen`) fire regardless of `posMode` — stub them as no-op unsubs so the retail boot path is unaffected.
9. **Order-sync is the S8 crux.** `pos.orders.create` is local-first; the backend `POST /api/v1/b2b/pos/orders` + `/finish` happens in the outbox drainer with the staff JWT, 5 transient retries, business-error shelve. The exact backend DTO (PLN decimals, not grosze) and the shift/stock/normalization rules are spelled out in the §2.F note — port them byte-for-byte; a divergence here is a silent data-correctness bug, not a crash.
