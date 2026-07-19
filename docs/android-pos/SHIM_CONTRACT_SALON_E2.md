# SHIM_CONTRACT_SALON_E2 — `window.electronAPI` surface required by the SALON POS flow

**Packet:** E2-inventory (read-only) → feeds E2a (salon template shim) + E2b (customers) + E2c (bookings/check-in).
**Date:** 2026-07-19
**Scope:** the salon-mode cashier flow only — `posMode === 'salon'` (nail-salon mode): service
catalog (services = products), service-based cart, **per-service staff assignment**, the staff
turn-board, and the bookings / walk-in check-in schedule view. Boot/auth/config/cart-store/payment
are inherited from S1 and cited, not re-documented.
**Source of truth:** `src/shared/electron.d.ts` (typed surface, esp. `pos.schedule` `:887`,
`pos.nailTurns` `:883`, `pos.sync.staff`/`onStaffUpdated` `:928,943`, `pos.products.getByCategory`
`:803`, `pos.customers` `:1050`), `src/shared/types.ts` (`PosSchedule*` `:2741-2840`,
`NailTurn*` `:2688-2739`, `IPC_CHANNELS` `:1291,1324-1330,1349,1351`), `src/preload/preload.ts`
(`nailTurns` `:751`, `schedule` `:759`, `sync.staff` `:796`, `onStaffUpdated` `:802`,
`getByCategory` `:675`), `src/main/modules/pos.module.ts` (handlers `:1324,3386-3389,3408,3442-3546`,
nail-turn checkout side-effect `:885,3180`), `src/main/modules/sync.module.ts:171` (`pos:sync:staff`),
`src/main/network/api-client.ts` (schedule `:2648-2755`, nail-turns `:2500-2548,2762-2774`, staff
`:3423-3448`).
**Renderers inventoried:** `src/renderer/components/pos/templates/salon/SalonTemplate.tsx` (the only
salon-mode component actually rendered — see §0.3) and the shared components it reaches:
`PaymentModal.tsx`, `SearchBar.tsx`, `usePosStore`, `usePosDb` types, and `POSLayout.tsx` (mode
switch + boot, already covered by S1). `templates/salon/StaffPicker.tsx` is **dead code** (§8).

> **How to read disposition** (same legend as S1):
> **PORT** = shim must implement for real salon behavior.
> **PORT-optional** = real salon behavior but **dark-launch safe** — the template degrades
> gracefully (shows an error / hides the panel) if the shim returns `{success:false,
> unavailable:true}`, so E2a (sale view) does NOT depend on it; required only for E2c
> (schedule / turn-board).
> **STUB** = benign specified default, no real behavior.
> **OVERLAP** = already in the S1 PORT set — done, cite S1 row.
> **EXCLUDE** = other template / hardware / second-screen / admin — STUB no-op or compile-out.

---

## 0. Headline facts that shape the port

1. **Salon mode renders at `POSLayout.tsx:1642`** — `{posMode === 'salon' && <SalonTemplate …/>}`.
   `posMode` defaults to `'salon'` (`POSLayout.tsx:294`, type `PosMode = 'retail'|'salon'|'b2b'|
   'restaurant'` `:45`) and syncs from `config.posMode` (`:1198`). Unlike the S1 retail port, the
   Android shell must seed `config.posMode = 'salon'` (still no in-window mode switcher). All S1
   boot/auth/config/cart-store facts carry over unchanged — `SalonTemplate` is a **pure child** of
   the same `POSLayout` and receives `{state, dispatch, t, language, session}` as props (`:1642`).
2. **There is NO `pos.services.*` namespace.** Nail-salon "services" are modeled as **products** —
   the salon service grid is `pos.products.*` + `pos.categories.*`, identical to the retail catalog
   (S1 §2.D). The only catalog method salon uses that retail did **not** is
   `pos.products.getByCategory(catId)` (`SalonTemplate.tsx:319`). This collapses "E2a services
   catalog" to "one new catalog reader + reuse the S1 product/category surface".
3. **`SalonTemplate` is one file** (`SalonTemplate.tsx`, 1033 lines) with two internal views
   toggled by `activeView`: **`'sale'`** (service grid + cart + PAY → uses catalog + staff +
   shared `PaymentModal`) and **`'schedule'`** (technician timetable + waiting check-ins → uses
   `pos.schedule.*` + `pos.nailTurns.*`). The sale view is the cashier core (E2a); the schedule
   view is the salon-differentiator (E2c) and is entirely **dark-launch safe**.
4. **Per-service staff assignment** is a `cart/setItemStaff` dispatch on each cart line
   (`SalonTemplate.tsx:903`), backed by an inline `<select>` populated from `pos.staff.getAll()`
   (`:279`). `StaffPicker.tsx` is dead code — do not port it (§8). The dispatch action
   `cart/setItemStaff` already exists in the S1 `PosAction` union (S1 §2.C) and the main reducer
   (`src/main/pos/pos-store.ts:154,384`); the shim store only needs to honor it.
5. **Auth = staff JWT, verified** for every NEW salon handler. `pos.schedule.*` READS
   (`getToday`/`getWeek`) try the staff JWT first and **fall back to the `pa_` agent key**
   (`pos.module.ts:997-1000,1014-1017`, route `/api/v1/pos/schedule/agent/…`). Android uses the
   **staff-JWT path only** and never materializes the `pa_` key (hard rail, S1 §0.4). All schedule
   WRITES (`setStaffStatus`/`assignNext`/`requestStaff`) and all nail-turn calls are **staff-JWT
   only** — no agent fallback (`pos.module.ts:3493,3516,3532,3444`).
6. **`SalonTemplate` writes ZERO `localStorage`.** Unlike `RetailTemplate` (S1 §5: `pos.activeCart`
   + `pos.heldCarts`), the salon cart is authoritative in the main POS store only. Android's salon
   cart therefore survives restart **only** through the shim store (`getState`/`dispatch`/
   `onStateChanged`) — there is no browser-storage mirror to fall back on (§6).
7. **Salon checkout has one backend side-effect retail lacks:** after `pos.orders.create` for a
   `mode:'salon'` order, the main process fire-and-forgets `syncNailTurnCheckoutForOrder`
   (`pos.module.ts:3180`, gated `order.mode==='salon'` at `:828`) → `POST
   /api/v1/nail-turns/assignments/:id/checkout` (staff JWT) to close each technician's turn and
   record revenue + tip share. It no-ops if the turn board is unavailable (`:897`). This is a NEW
   best-effort dependency inside the already-PORT `pos.orders.create` (S1 §2.F).
8. **`pos.customers.*` is NOT used by the salon sale flow.** Salon has no customer picker —
   `SalonTemplate` never calls any `customers.*` method; its `customer_name` strings come from
   schedule/booking data, not the customers repo. The customers surface is inventoried in §2.F for
   the E2b packet and is otherwise EXCLUDE for E2a.

---

## 1. Disposition summary

| Disposition | Count | Meaning |
|---|---:|---|
| **PORT** (E2a — sale view needs it) | 4 | New methods the salon cashier core requires |
| **PORT-optional** (E2c — schedule/turns, dark-launch safe) | 8 | Real behavior, but sale view works without them |
| **OVERLAP** (already in S1 PORT set) | 12 | Cite S1 row; nothing new to build |
| **STUB** | 3 | Events/lookups with benign defaults |
| **EXCLUDE** | 7 | Other templates / second-screen / dead code |
| **Total in-scope methods** | **34** | (Unique `electronAPI.*` paths the salon graph reaches; sub-methods of excluded namespaces not individually counted) |

> Counts are the **salon-specific** slice. The 12 OVERLAP rows are done in S1 and listed in §3;
> the 4 PORT + 8 PORT-optional rows in §4 are the actual E2 work list.

### Minimal E2a subset (salon sale view: services + per-service staff + PAY)

The smallest set that makes `activeView==='sale'` usable on Android behind the shim, on top of the
S1 M1–M4 base (login, boot, cart-store, catalog, CASH order, shift):

| # | Method | Disposition | Why required for E2a |
|---|---|---|---|
| 1 | `pos.products.getByCategory(catId)` | **PORT** | Category-filtered service grid (`SalonTemplate.tsx:319`) |
| 2 | `pos.staff.getAll()` | **OVERLAP** (S1 M4) | Staff list for per-line `<select>` (`:279`) — already PORT for shift picker |
| 3 | `pos.sync.staff()` | **PORT** | Pull fresh staff into `staffRepo` on mount (`:285`) |
| 4 | `pos.sync.onStaffUpdated(cb)` | **PORT** | Live-refresh staff after pull/remote change (`:290`) |
| 5 | `dispatch({type:'cart/setItemStaff'})` | **PORT** | Per-service staff assignment on each line (`:903`) — action already in S1 union; shim store must honor it |
| 6 | `PaymentModal` (shared) | **OVERLAP** (S1 M3) | Salon passes `extraOrderFields={{tip, mode:'salon'}}` (`:1027`); `pos.orders.create` already PORT |

E2a does **not** require schedule/turn-board (`activeView==='schedule'`) or customers — those are
PORT-optional / E2c / E2b.

---

## 2. Per-method contract

Call sites are `SalonTemplate.tsx:line` unless noted (≤5 representative). "Shape" columns are
abridged; full types in `src/shared/electron.d.ts` + `src/shared/types.ts`.

### 2.A — Catalog (services = products) — mostly OVERLAP with S1 §2.D

| Method | Call sites | Request | Response | Main impl | Does | Disposition |
|---|---|---|---|---|---|---|
| `pos.products.getAll()` | `:295, :321` | — | `PosProduct[]` | `pos.module.ts:1319` → `productRepo.getAll()` | LOCAL-DB | **OVERLAP** S1 §2.D (PORT M2) |
| `pos.products.search(query)` | `:316` | `(query: string)` | `PosProduct[]` | `pos.module.ts:1325` | LOCAL-DB | **OVERLAP** S1 §2.D (PORT M2) |
| `pos.products.getByBarcode(code)` | `:404` (scanner) | `(barcode: string)` | `PosProduct \| null` | `pos.module.ts:1327` | LOCAL-DB | **OVERLAP** S1 §2.D (PORT M2) |
| `pos.products.getByCategory(catId)` | `:319` | `(categoryId: string)` | `PosProduct[]` | `pos.module.ts:1324` → `productRepo.getByCategory(catId)` (`product-repo.ts:331`) | LOCAL-DB | **PORT** — NEW (retail used search+filter; salon calls this dedicated reader) |
| `pos.categories.getAll()` | `:294` | — | `PosCategory[]` | `pos.module.ts:1329` → `productRepo.getCategories()` | LOCAL-DB | **OVERLAP** S1 §2.D (PORT M2) |

`Product`/`PosProduct` and `Category`/`PosCategory` shapes are identical to S1 §2.D (prices integer
grosze). Services are simply `PosProduct` rows; `SalonTemplate` renders them in a 4-col grid
(`:794`) and adds them to the cart via `cart/addItem` (`:382`), same payload as retail.

### 2.B — Staff (per-service assignment) — one NEW sync method

| Method | Call sites | Request | Response | Main impl | Does | Disposition |
|---|---|---|---|---|---|---|
| `pos.staff.getAll()` | `:279` (mount) | — | `PosStaff[] = { id, user_id?, name, commission_rate, is_active, role? }[]` | `pos.module.ts:3408` → `staffRepo.getAll()` | LOCAL-DB | **OVERLAP** S1 §2.H (PORT M4 — already needed for the shift open picker) |
| `pos.sync.staff()` | `:285` (mount, fire-and-forget) | — | `{ success: boolean; count?: number; error?: string }` | `sync.module.ts:171` → `staffSync.pullStaff()` (`staff-sync.ts:17`) → `apiClient.getStaffProfiles(token)` **`GET /api/v1/staff`** (staff JWT) → writes `staffRepo` → emits `pos:staff-updated` | MIXED (HTTP pull + local write); staff JWT | **PORT** — NEW (retail never synced staff; salon needs fresh technicians for the per-line picker) |
| `pos.sync.onStaffUpdated(cb)` | `:290` (sub on mount) | cb `(data?: any) => void` | unsubscribe `() => void` | preload `:802` (`POS_STAFF_UPDATED='pos:staff-updated'`); emitted `sync.module.ts:174` with `{count}` | Event: re-`loadStaff()` after a pull | **PORT** — NEW |

> Staff refresh is best-effort: `SalonTemplate` calls `getAll()` immediately (renders last-known
> staff) then `sync.staff()` to refresh in the background; if the pull fails the picker still works
> off the local cache. `staffSync.pullStaff()` hits **`GET /api/v1/staff`** (staff JWT) — same route
> family the shift picker already depends on, so no new backend contract.

### 2.C — Schedule (technician timetable + waiting check-ins) — ALL NEW, dark-launch safe

The `activeView==='schedule'` view. Every method is staff-JWT and returns `{success:false,
unavailable:true, error}` when the backend route is absent (api-client maps `403/404/501 → null`),
so the template just sets `scheduleError` (`SalonTemplate.tsx:185,208,222`) and keeps rendering.

| Method | Call sites | Request | Response | Main impl | Does | Disposition |
|---|---|---|---|---|---|---|
| `pos.schedule.getToday(date?)` | `:179`, auto-refresh `:358,366` | `(date?: string 'YYYY-MM-DD')` | `PosScheduleDayIpcResult = { success, schedule?: PosScheduleDayResponse \| null, unavailable?, stale?, error? }` | `pos.module.ts:3455` → `fetchPosScheduleToday` (`:986`) → `apiClient.getPosScheduleToday` **`GET /api/v1/pos/schedule/today?date=`** (staff JWT; `pa_` agent fallback at `:999` — Android skips) → caches to `pos_schedule_cache` table (`:947`) | BACKEND-HTTP (staff) + LOCAL cache; returns stale cache + `stale:true` on failure (`:3460,3470`) | **PORT-optional** (E2c) |
| `pos.schedule.getWeek(from?, days?)` | `:197` | `(from?: string, days?: number)` | `PosScheduleWeekIpcResult = { success, week?: PosScheduleWeekResponse \| null, unavailable?, error? }`; `PosScheduleWeekResponse = { salon?, from, days, schedules: PosScheduleDayResponse[] }` | `pos.module.ts:3475` → `fetchPosScheduleWeek` (`:1003`) → `apiClient.getPosScheduleWeek` **`GET /api/v1/pos/schedule/week?from=&days=`** (staff JWT; agent fallback) → caches each day | BACKEND-HTTP (staff) | **PORT-optional** (E2c) |
| `pos.schedule.setStaffStatus(payload)` | `:243` | `{ staffProfileId: string; status: 'AVAILABLE'\|'BUSY'\|'BREAK'\|'OFF'; idempotencyKey? }` (`PosScheduleStaffStatusPayload`) | `PosScheduleDayIpcResult` (returns the refreshed day) | `pos.module.ts:3491` → `apiClient.setPosScheduleStaffStatus` **`PATCH /api/v1/pos/schedule/staff/:id/status`** (staff JWT **only**) → re-cache | BACKEND-HTTP WRITE (staff). Toggles a technician's turn status. | **PORT-optional** (E2c) — WRITE |
| `pos.schedule.assignNext(payload)` | `:252` | `{ checkinLogId; bookingId?; customerName?; customerPhone?; serviceName?; idempotencyKey? }` (`PosScheduleAssignNextPayload`) | `PosScheduleDayIpcResult` | `pos.module.ts:3514` → `apiClient.assignPosScheduleNext` **`POST /api/v1/pos/schedule/checkins/:id/assign-next`** (staff JWT only) → re-cache | BACKEND-HTTP WRITE (staff). Assigns the next-in-queue waiting check-in to the chosen technician. | **PORT-optional** (E2c) — WRITE |
| `pos.schedule.requestStaff(payload)` | `:268` | `PosScheduleRequestStaffPayload = AssignNext & { staffProfileId }` | `PosScheduleDayIpcResult` | `pos.module.ts:3530` → `apiClient.requestPosScheduleStaff` **`POST /api/v1/pos/schedule/checkins/:id/request-staff`** (staff JWT only) → re-cache | BACKEND-HTTP WRITE (staff). Assigns a *specific* technician to a waiting check-in. | **PORT-optional** (E2c) — WRITE |

`PosScheduleDayResponse` (`types.ts:2772`): `{ salon:{id?,slug?,timezone?}, business_date, range?,
staff: PosScheduleStaffSummary[], bookings: PosScheduleBookingSummary[], unassigned_bookings?,
waiting_checkins: PosScheduleCheckinSummary[], active_assignments: PosScheduleAssignmentSummary[],
next_turn?: {staff_profile_id, name?}|null, server_time?, version?, stale?, cached_at? }`. The
template reads `staff[].queue_position/status/revenue_today_pln`, `bookings[]` (filtered per staff
by `staff_profile_id` at `:120`), `waiting_checkins[]`, `active_assignments[]`, `next_turn`, and
`salon.timezone` (for `formatTime`).

> **Idempotency:** the three write actions send `idempotency_key` (body) generated in the renderer
> as `pos-zira:<op>:<id>:<Date.now()>` (`:246,257,274`). Preserve this — it is the double-tap guard
> on technician-queue mutations.

### 2.D — Nail-turn board (technician queue summary) — NEW, dark-launch safe

Shown in the sale view as the "Lượt thợ" banner (`SalonTemplate.tsx:562-610`) when available.

| Method | Call sites | Request | Response | Main impl | Does | Disposition |
|---|---|---|---|---|---|---|
| `pos.nailTurns.getToday()` | `:161` (mount + manual refresh `:346,352,1020`) | — | `NailTurnBoardIpcResult = { success, board?: NailTurnBoardResponse \| null, unavailable?, error? }`; `NailTurnBoardResponse = { day?:{strategy,half_turn_threshold_pln,…}, settings?, staff?: NailTurnStaffSummary[], active_assignments?: NailTurnAssignmentSummary[], can_undo?, last_action? }` | `pos.module.ts:3442` → `apiClient.getNailTurnBoard` **`GET /api/v1/nail-turns/today`** (staff JWT; `nailTurnRequest` `:2500`) | BACKEND-HTTP (staff). `unavailable:true` when 403/404/501 (`:3447`) → template hides the banner (`nailTurnUnavailable`, `:562,167`). | **PORT-optional** (E2c) |
| `pos.nailTurns.onUpdated(cb)` | `:347` (sub on mount) | cb `(data: { orderId?, checkedOut? }) => void` | unsubscribe | preload `:751` (`POS_NAIL_TURNS_UPDATED='pos:nail-turns-updated'`); emitted `pos.module.ts:938` after a nail-turn checkout | Event: reload board (+ schedule if visible) | **STUB**-ok → no-op unsub if nail-turns skipped; **PORT** if E2c |

> **Checkout side-effect (not a direct salon-template call, but part of salon order flow):**
> `pos.orders.create` (S1 §2.F, already PORT) — for `mode:'salon'` orders only — fire-and-forgets
> `syncNailTurnCheckoutForOrder` (`pos.module.ts:3180`, gate at `:828`). It groups cart lines by
> `staffId`, resolves each to a `staff_profile_id` against the live board, then calls
> `apiClient.checkoutNailTurnAssignment` **`POST /api/v1/nail-turns/assignments/:id/checkout`**
> (staff JWT, idempotency key `pos-zira:nail-turn-checkout:<orderId>:<assignmentId>`) with
> `{amount_pln, tip_pln, idempotency_key}` to close the technician's turn and credit revenue + tip
> share. **No-ops** if no auth token, board unavailable, or no active assignment (`:897,912,926`).
> Emits `pos:nail-turns-updated` if any checkout succeeded (`:938`). The Android order-create path
> should replicate this best-effort; skipping it only means technician revenue/turn tracking lags
> (the sale itself completes).

### 2.E — Cart dispatch — salon actions (mechanism OVERLAP, one action is salon-specific)

The dispatch channel `pos.dispatch` is OVERLAP (S1 §2.C, PORT). Salon uses these actions:

| Action | Call sites | Payload | Reducer | Disposition |
|---|---|---|---|---|
| `cart/addItem` | `:382` | `{ id: crypto.randomUUID(), variantId, name, name_translations, sku, price, quantity:1, total:price, saleUnit, sellBy:'PIECE', imageUrl?, vatRate }` | `pos-store.ts` | **OVERLAP** (S1) — identical to retail add |
| `cart/setItemStaff` | `:903` | `{ id, staffId, staffName }` | `pos-store.ts:154,384` | **PORT** — NEW salon action (per-service staff assignment on a cart line). Action is already in the S1 `PosAction` union; the shim store reducer must apply `staffId`/`staffName` to the matching line. |
| `cart/updateQuantity` | `:931, :944` | `{ id, quantity }` | — | **OVERLAP** (S1) |
| `cart/removeItem` | `:929` | `{ id }` | — | **OVERLAP** (S1) |
| `cart/clear` | `:861` | — | — | **OVERLAP** (S1) |

`CartItem` carries `staffId?`/`staffName?` (set by `setItemStaff`); these flow into the order item
at checkout as `staff_id`/`staff_name` (S1 §2.F item shape), which is what drives per-technician
revenue + the nail-turn checkout grouping (§2.D). Salon reads `state.tip` (`SalonTemplate.tsx:148`)
and `state.cart` from the shared store; it does **not** use `state.activeCustomer`.

### 2.F — Customers — available surface, NOT used by the salon sale flow (E2b only)

`SalonTemplate` calls **none** of these. They are the B2B-customer / invoice surface, inventoried
here for the E2b packet. For E2a they are EXCLUDE/STUB.

| Method | Call sites (none in salon) | Request | Response | Main impl | Does | Disposition |
|---|---|---|---|---|---|---|
| `pos.customers.getAll()` | B2B `B2BTemplate.tsx:56` only | — | `PosCustomer[]` | `pos.module.ts:3386` → `customerRepo.getAll()` | LOCAL-DB only (no backend route) | **EXCLUDE** for salon |
| `pos.customers.search(q)` | — | `(query)` | `PosCustomer[]` | `pos.module.ts:3387` → `customerRepo.search()` | LOCAL-DB | **EXCLUDE** |
| `pos.customers.getById(id)` | — | `(id)` | `PosCustomer \| null` | `pos.module.ts:3388` → `customerRepo.getById()` | LOCAL-DB | **EXCLUDE** |
| `pos.customers.increaseDebt(id, amt)` | `PaymentModal.tsx:521` (**INVOICE branch only**) | `(id, amount)` | `Promise<void>` | `pos.module.ts:3389` → `customerRepo.increaseDebt()` | LOCAL-DB (B2B debt) | **EXCLUDE** (salon CASH skips; S1 §2.F) |
| `pos.customers.lookupNip(nip)` | `OrderHistoryModal.tsx:928` (invoice extra) | `(nip)` | `{ success, data?, error? }` | `pos.module.ts:3970` → `apiClient.lookupCustomerByNip` **`GET /api/v1/b2b/pos/customers/nip/:nip`** (staff JWT) | BACKEND-HTTP (GUS) | **EXCLUDE** (invoice extra) |

> There is **no `pos.customers.create`** electronAPI method. `apiClient.createSalonCustomer`
> (`POST /api/v1/print-agent/salon-customers`, staff JWT, `api-client.ts:2972`) exists but is called
> only from a sync worker, not exposed on the `pos.customers.*` surface. If E2b needs customer
> create from the POS, that is a **new client method + the route already exists** (no server change).

### 2.G — Shared checkout (PaymentModal) — OVERLAP with S1

`SalonTemplate.tsx:1013-1029` renders `<PaymentModal cart dispatch … shiftId staffId staffName
checkoutDraft extraOrderFields={{ tip, mode:'salon' }} />`. `PaymentModal`'s full surface is S1
§2.F/§2.I — `pos.orders.create`, `pos.sync.orders()`, `pos.payment.*`. The only salon delta is
`extraOrderFields`: it sets `order.mode='salon'` (which triggers the §2.D nail-turn checkout
side-effect) and `order.tip` (integer grosze, from `state.tip`). Both fields are already part of
the S1 `pos.orders.create` order shape. **Nothing new to port in PaymentModal.**

---

## 3. OVERLAP with the S1 PORT set (already done — cite, don't rebuild)

These salon call sites resolve to methods S1 already marked PORT:

| Salon use | S1 row | Notes |
|---|---|---|
| `pos.products.getAll/search/getByBarcode` (`:295,316,321,404`) | S1 §2.D PORT M2 | Identical catalog |
| `pos.categories.getAll()` (`:294`) | S1 §2.D PORT M2 | Identical |
| `pos.staff.getAll()` (`:279`) | S1 §2.H PORT M4 | Same local `staffRepo`; salon reuses it for the per-line picker |
| `pos.dispatch` (`cart/addItem`, `updateQuantity`, `removeItem`, `clear`) (`:382,861,929,931,944`) | S1 §2.C PORT | Same store/reducer |
| `pos.sync.onProductsSynced(cb)` (`:339`) | S1 §2.E PORT | Catalog-reload event |
| `pos.orders.create` / `pos.sync.orders()` / `pos.payment.*` (via `PaymentModal`) | S1 §2.F/§2.I PORT M3 / LATER | Salon passes `{tip, mode:'salon'}` only |
| Boot/config/auth (`getConfig`, `onConfigUpdated`, `getStatus`, `auth.*`, `pos.getState/onStateChanged`) | S1 §0/§2.A/§2.B/§2.C PORT M1 | Inherited via `POSLayout` |
| Shift (`pos.shift.open/close`) | S1 §2.H PORT M4 | `session.isOpen` gates the PAY button (`SalonTemplate.tsx:994,1004`) |

---

## 4. NEW methods salon needs that retail did NOT (the E2 work list)

### 4.1 Required for E2a (sale view)

| # | Method | Backend route | HTTP | Auth | Local backing | Disposition |
|---|---|---|---|---|---|---|
| 1 | `pos.products.getByCategory(catId)` | — (local) | — | — | `productRepo.getByCategory` | **PORT** (LOCAL-DB read; trivial — same repo S1 already opens) |
| 2 | `pos.sync.staff()` | `/api/v1/staff` | GET | staff JWT | `staffRepo` (after pull) | **PORT** |
| 3 | `pos.sync.onStaffUpdated(cb)` | — (event) | — | — | — | **PORT** (emit on staff pull) |
| 4 | `dispatch cart/setItemStaff` | — (reducer) | — | — | shim store | **PORT** (apply staffId/staffName to line) |

### 4.2 Required for E2c (schedule / turn-board) — all dark-launch safe

| # | Method | Backend route | HTTP | Auth | Disposition |
|---|---|---|---|---|---|
| 5 | `pos.nailTurns.getToday()` | `/api/v1/nail-turns/today` | GET | staff JWT | **PORT-optional** (null→hide banner) |
| 6 | `pos.nailTurns.onUpdated(cb)` | — (event `pos:nail-turns-updated`) | — | — | **STUB**-ok / **PORT** with 5 |
| 7 | `pos.schedule.getToday(date?)` | `/api/v1/pos/schedule/today?date=` | GET | staff JWT¹ | **PORT-optional** (stale-cache fallback) |
| 8 | `pos.schedule.getWeek(from?,days?)` | `/api/v1/pos/schedule/week?from=&days=` | GET | staff JWT¹ | **PORT-optional** |
| 9 | `pos.schedule.setStaffStatus(p)` | `/api/v1/pos/schedule/staff/:id/status` | PATCH | staff JWT | **PORT-optional** — WRITE |
| 10 | `pos.schedule.assignNext(p)` | `/api/v1/pos/schedule/checkins/:id/assign-next` | POST | staff JWT | **PORT-optional** — WRITE |
| 11 | `pos.schedule.requestStaff(p)` | `/api/v1/pos/schedule/checkins/:id/request-staff` | POST | staff JWT | **PORT-optional** — WRITE |
| 12 | nail-turn checkout (order-create side-effect, `mode='salon'`) | `/api/v1/nail-turns/assignments/:id/checkout` | POST | staff JWT | **PORT-optional** (best-effort; no-op if board absent) |

¹ Schedule READS have a `pa_` agent-key fallback (`/api/v1/pos/schedule/agent/…`) on Windows.
Android uses the **staff-JWT path only** (hard rail). All schedule WRITES + nail-turn calls are
staff-JWT-only with no agent fallback.

### 4.3 Backend existence + auth verdict (does it exist? staff JWT vs `pa_`?)

Every NEW route is **staff-JWT** (the agent-key path is a Windows-only read fallback Android
skips). Existence is **dark-launch-tolerant**: `api-client` maps `403/404/501 → null`, the
`pos.module` handler returns `{success:false, unavailable:true}`, and `SalonTemplate` shows a
banner error / hides the panel rather than crashing. Concretely:

- **`/api/v1/staff` (GET)** — used today by the shift picker path (`staffSync.pullStaff`). Believed
  deployed (the S1 shift feature already depends on populated `staffRepo`). **No server change.**
- **`/api/v1/nail-turns/today` (GET)** + **`/…/assignments/:id/checkout` (POST)** —
  `getNailTurnBoard`/`checkoutNailTurnAssignment` (`api-client.ts:2546,2762`). Dark-launch safe.
  Verify deployment on the target salon; absence just hides the turn board.
- **`/api/v1/pos/schedule/{today,week}` (GET)**, **`/staff/:id/status` (PATCH)**,
  **`/checkins/:id/assign-next` (POST)**, **`/checkins/:id/request-staff` (POST)** —
  `api-client.ts:2648-2755`. Dark-launch safe. Verify deployment; absence disables the schedule
  view with a user-visible error, does not block sales.

### 4.4 Server-request candidates

- **NONE blocking for E2a.** Catalog/staff reuse existing routes; per-service staff assignment is
  a local reducer action; CASH checkout is S1.
- **Bookings WRITE / check-in** — the salon POS **reads** check-ins and **assigns** them
  (`assignNext`/`requestStaff`); it does **not create** walk-in check-ins. Those routes
  (`/api/v1/pos/schedule/checkins/:id/assign-next` etc.) exist client-side and degrade gracefully,
  so no server request is needed to render E2c.
- **Walk-in check-in CREATION from the POS** — currently lives only on the **customer second
  screen** (`display:check-in` IPC → `pos.module.ts:1071`, plus `checkin:create` /
  `checkin:createWithCustomer` channels `types.ts:1564,1573`), which is EXCLUDE on Android. If E2c
  wants to create walk-in check-ins **from the POS window itself**, that is a **new client feature**
  and likely a **new/confirmed backend check-in-create route** — flag as a **server-request
  candidate for E2c** (draft when that packet starts; not blocking E2a).
- **Customer create from POS (E2b)** — `POST /api/v1/print-agent/salon-customers` already exists
  (`api-client.ts:2972`, staff JWT); only a **new client `pos.customers.*` method** is needed, no
  server change.

---

## 5. Events / subscriptions the salon flow uses

Every subscription returns an unsubscribe `() => void`. The shim exposes the same shape; STUB
events return a no-op unsubscribe and never emit.

| Event method | Subscriber | Payload to callback | Disposition |
|---|---|---|---|
| `pos.sync.onProductsSynced(cb)` | `SalonTemplate.tsx:339` | `()` → bump `catalogRevision` (reload products/categories) | **OVERLAP** (S1 PORT) |
| `pos.sync.onStaffUpdated(cb)` | `SalonTemplate.tsx:290` | `{ count?: number }` (data optional) → re-`loadStaff()` | **PORT** — NEW |
| `pos.nailTurns.onUpdated(cb)` | `SalonTemplate.tsx:347` | `{ orderId?, checkedOut? }` → reload board (+ schedule if visible) | **STUB**-ok / **PORT** with nail-turns |
| `pos.onStateChanged(cb)` | (via `usePosStore`, inherited) | full `PosState` | **OVERLAP** (S1 PORT) |
| `onConfigUpdated(cb)` / `onConnectionStatus(cb)` / `auth.onExpired(cb)` / `pos.onFiscalUnknown(cb)` / `pos.onPickupOrderEvent(cb)` | `POSLayout` boot (inherited) | see S1 §3 | **OVERLAP** (S1 — STUB no-op unsubs for fiscal/pickup/connection) |

`SalonTemplate` mounts **no new boot subscriptions in `POSLayout`** — all salon-specific loads are
inside its own `useEffect`s (`:283-377`). `POSLayout`'s unconditional boot subs (pickup,
fiscalUnknown, connectionStatus — S1 §7.8) still fire under salon mode; keep them as STUB no-ops.

---

## 6. `localStorage` / `sessionStorage` keys used by the salon flow

**None.** `SalonTemplate.tsx` does not touch `window.localStorage` or `sessionStorage` (verified —
zero occurrences). The salon cart is authoritative in the main POS store only; there is no
`pos.activeCart`/`pos.heldCarts` mirror (contrast S1 §5, which is `RetailTemplate`-only).

**Android port consequence:** the salon cart survives a renderer reload **only** through the shim's
backing store (`getState`/`dispatch`/`onStateChanged`). If the Android shell drops the store on
restart, the in-progress salon cart is lost — there is no browser-storage fallback to recover from.
If crash-recovery parity with retail is wanted, the E2a shim should mirror the salon cart to
WebView `localStorage` under the same `pos.activeCart.${userId}` scheme S1 §5 documents (this is a
new Android-side behavior, not a Windows port — Windows salon does not do it).

---

## 7. Renderer use of Node/Electron globals besides `electronAPI`

Same as S1 §4 — **none requiring a polyfill.** Salon-specific globals observed:

- `crypto.randomUUID()` — cart-line id (`SalonTemplate.tsx:385`).
- `Date.now()` — schedule idempotency keys (`:246,257,274`) and (implicitly) `isoDate(new Date())`
  for the default schedule date (`:129,453,460`).
- `window.setInterval` / `clearInterval` + `window.addEventListener('focus',…)` +
  `document.addEventListener('visibilitychange',…)` — 30 s schedule auto-refresh while the schedule
  view is visible (`:362-377`).
- `document.visibilityState` — gate the silent refresh (`:365`).
- `productGridRef.current?.scrollTo(…)` — reset grid scroll on category change (`:306`).

All are standard browser APIs a WebView provides. No `require`/`process`/`ipcRenderer`/`Buffer`.

---

## 8. Excluded surfaces (reachable in the POS graph but NOT salon-mode)

- **`templates/salon/StaffPicker.tsx` — DEAD CODE.** Never imported by `SalonTemplate` (or anything
  else — `grep StaffPicker src/renderer/` returns only its own definition). `SalonTemplate` inlines
  its own staff `<select>` at `:897-916`. Do **not** port `StaffPicker.tsx`; it compiles out.
- **Restaurant / kitchen / pickup / tables:** `pos.pickupOrders.*`, `pos.tables.*`,
  `pos.onPickupOrderEvent`, `kitchenCategories.*` — rendered only under `posMode==='restaurant'`
  (`POSLayout.tsx:1644`), not salon.
- **B2B template:** `B2BTemplate.tsx`, `CustomerPanel` (`posMode==='b2b'`, `:1643`);
  `pos.customers.{getAll,search,getById,increaseDebt}` are B2B-customer / invoice paths (§2.F).
- **Customer second screen / walk-in check-in creation:** `display:check-in` (`pos.module.ts:1071`),
  `display:get-bookings`, `display:request-service`, `checkin:create`,
  `checkin:createWithCustomer` (`types.ts:1564,1573`), `onCustomerCheckIn`/`onCustomerRequest`/
  `onCustomerDisplayStatus` (`electron.d.ts:1079-1081`), `useCheckinWizard`, `CheckInView`,
  `CustomerApp`. These are where walk-in check-ins are *created* today — second-screen only, EXCLUDE
  on Android (single window). The salon POS only *reads/assigns* check-ins via `pos.schedule.*`.
- **`bookings.*` namespace (top-level, not `pos.bookings`):** `electronAPI.bookings.{create,update}`
  used by `components/booking/{BookingCreateForm,BookingEditForm,BookingsTodayScreen}.tsx` —
  dashboard-synced appointment screens, **not imported by `SalonTemplate`**. Out of scope for E2a;
  possibly relevant to a later E2c appointment screen.
- **AI / camera / voice / scale / label / window-mgmt / loyalty / product-admin:** same EXCLUDE set
  as S1 §6/§2.K/§2.L/§2.M — salon does not reach them.
- **Telegram QR login:** `auth.generateLoginToken`/`checkToken`/`generateRegisterToken` — STUB
  (email login is primary, S1 §2.B).

---

## 9. Notes for E2a (salon template shim)

1. **Seed `config.posMode = 'salon'`** in the Android shell (mirror of S1's retail seeding). With
   it, `POSLayout` renders `SalonTemplate` unchanged; nothing else in `POSLayout` is salon-specific.
2. **E2a is cheap because services = products.** Reuse the S1 catalog surface verbatim
   (`pos.products.getAll/search/getByBarcode`, `pos.categories.getAll`, `pos.sync.products`,
   `onProductsSynced`). The only new catalog reader is `getByCategory` — a one-line `productRepo`
   call the shim already has the repo for.
3. **Staff surface is two methods on top of the S1 `staff.getAll`:** add `pos.sync.staff()` (GET
   `/api/v1/staff`, staff JWT → `staffRepo`) and emit `pos:staff-updated`. The per-line staff
   `<select>` then works off the same local staff rows the shift picker already uses.
4. **Per-service staff assignment = `cart/setItemStaff`.** The dispatch channel is PORT (S1); the
   shim store reducer must apply `{staffId, staffName}` to the matching `CartItem` so it flows into
   the order item (`staff_id`/`staff_name`) at checkout — that is what drives technician revenue and
   the nail-turn checkout grouping.
5. **Schedule + nail-turns are PORT-optional and dark-launch safe.** Implement them to return
   `{success:false, unavailable:true}` (or stale cache for `getToday`) until the routes are verified
   on the target salon; `SalonTemplate` already handles both by hiding the panel / showing
   `scheduleError`. E2a can ship without them; E2c lights them up.
6. **Salon checkout delta vs retail = `mode:'salon'` + `tip`.** Both are already fields in the S1
   `pos.orders.create` order shape; `PaymentModal` is shared and unmodified. The one new
   server-side behavior is the **nail-turn checkout side-effect** (`syncNailTurnCheckoutForOrder`,
   §2.D) — replicate it best-effort inside the Android order-create path; it no-ops cleanly when the
   board is absent, so it cannot break a sale.
7. **No localStorage mirror on Windows salon.** If crash-recovery parity with retail is desired, the
   Android shim must add it (new behavior) — the Windows salon template does not, so a 1:1 port has
   no cart recovery for salon. Decide explicitly in E2a.
8. **Staff-JWT only.** All NEW routes are staff JWT. The schedule READ agent-key fallback
   (`/api/v1/pos/schedule/agent/…`) is Windows-only and must NOT be used (hard rail: never hold/call
   the `pa_` key). The shim resolves the token exactly as S1 does (`getSecureAuthToken` equivalent).
9. **Dead code:** do not port `StaffPicker.tsx`. Keep `SalonTemplate`'s inline staff `<select>`
   (`:897-916`) as the source of truth for per-line staff.
10. **Verify-before-rely on the schedule/nail-turn backend.** These routes are defined client-side
    and degrade gracefully, but their live deployment on the pilot salon's backend must be
    confirmed before claiming E2c "done" — absence is silent (panel hidden), not an error.
