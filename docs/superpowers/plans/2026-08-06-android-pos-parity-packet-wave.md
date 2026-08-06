# Android POS SUNMI Parity — Packet Wave 2026-08-06 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Conveyor mode:** each packet below is a self-contained prompt for ONE delegated agent (claude-glm / codex spark / claude code opus). The supervising Claude session reviews the diff, runs the gates, and commits. One packet = one/two commits, reviewable in minutes.

**Goal:** Close three verified, small, money-path-honest gaps in the Android POS shim (fiscal idempotency refusal + resolver-cache honesty, real server order history, order durability fail-closed) without touching the synthetic S1 contract.

**Architecture:** All changes live behind the `ShimTransport` seam (`src/renderer/android-pos/shim/`). Synthetic (no-transport) behavior stays byte-identical — only the real transport changes. Windows main-process behavior is the reference; where we diverge deliberately, the divergence is documented in-file (existing convention).

**Tech Stack:** TypeScript (plain, no TS in vitest test bodies beyond what exists), Vite + Capacitor Android, vitest, SQL.js.

**Repo / branch:** `/var/www/pos-zira`, branch `feat/pos-billiard-parity-20260731` (currently 1 ahead of origin at `2b1df68`). Work each packet on this branch (conveyor style — supervisor commits between packets). Parallel packets MUST have disjoint file sets.

## Global Constraints (hard rails — copy into every agent prompt)

- **DO NOT change synthetic S1 behavior.** `stubs.ts` synthetic literals are pinned by `tests/android-shim.test.ts` (30 tests): synthetic `entitlements.isEnabled === true`, synthetic `payment.preflight` token `android-synthetic:<orderId>`, synthetic print `{success:true, receiptPrinted:true}`, billiard `NO_PRINTER_RESULT = {success:true, receiptPrinted:false}`, `billiard.mutate`/`apiCall` reject without transport. A previous attempt to flip these to `false` broke the S1 contract and was reverted — never again.
- **Staff JWT only.** Never store/call the `pa_` salon key, never `/print-agent/connect` from new code paths.
- **CASH-first order writes; electronic tender code paths stay disabled.**
- **Keep the AppUpdater allowlist untouched:** HTTPS-only, hosts `img.zira.pl`/`releases.enail.pro`/`*.enail.pro`, `.apk` suffix, SHA-256 verify, 200 MB cap, package/cert checks (`android-pos/.../AppUpdaterPlugin.java`). No new native code in this wave.
- **No arbitrary shell execution, no raw SQL strings beyond the existing repo/`database.run` patterns.**
- **No new dependencies. No Electron/Node imports in the Android graph** — `npm run test:android:boundaries:source` must stay green.
- **Gates for every packet:** `npm run typecheck:renderer` PASS, `npx vitest run tests/android-` → **all tests pass** (baseline 2026-08-06: 36 files / 445 tests; new tests raise the count, nothing may fail), `npm run test:android:boundaries:source` PASS.
- **No production deploy, no Play upload, no R2 mutation, no tag.** eNail backend/frontend/migration changes are OUT of this plan (guarded lanes, separate approval). Chesaigon machines are never touched.
- **Commit messages:** conventional (`fix:`/`feat:`), one logical change per commit.

---

## Review findings (2026-08-06) — Android vs Windows

Full inventories: Windows surface = 33 areas / ~174 POS IPC handlers; Android shim maps every method to REAL / STUB / MISSING. Condensed verdict:

### Bugs (real transport, live on SUNMI today)

| # | Where | Defect |
|---|---|---|
| B1 | `remote-print.ts:148-153` + `:814` | Unpaired terminal (empty `machineId`) ⇒ `buildFiscalIdempotencyKey` returns `undefined` ⇒ fiscal job submitted **without idempotency key** ⇒ a resubmit can print a **second fiscal document** (legal issue). |
| B2 | `remote-print.ts:534-559` | A transient 401/5xx/network error on the printer-assignment lookup is **negative-cached for the full TTL (60s)** ⇒ up to a minute of sales silently take the "no-printer" path. |
| B3 | `real-transport.ts:1350` | `createOrder` flushes the DB with `.catch(() => {})` and returns `{success:true}` even when the durability flush failed ⇒ **a paid order can exist only in memory** and vanish on kill. (`hold-orders.ts:117-128` fails closed on the same barrier — inconsistent policy.) |
| B4 | `stubs.ts:328-330` | `pos.orders.getServerList` **never delegates to the transport** ⇒ Order History's server tab is permanently empty (`source:'unconfigured'`) on Android even when logged in and online. |
| B5 | `real-transport.ts:1703,1725` | `openShift`/`closeShift` backend calls are fire-and-forget with swallowed errors ⇒ local shift with no server counterpart (this is what later trips `verifyServerShift`). Documented Windows-parity risk — accepted, not fixed this wave. |
| B6 | `real-transport.ts:1397-1406` | `syncOrders` marks an order SYNCED even when `finishOrder` (backend stock deduction) failed silently. Documented Windows parity — accepted, not fixed this wave. |
| B7 | `real-transport.ts:696-697` | `holds?.invalidateAuth()` duplicated twice in the auth-expired teardown (copy/paste artefact, harmless). Fix opportunistically in P3. |
| B8 | `real-transport.ts:1596` | `refundAmount: result?.refundAmount ?? requestedAmountGrosze / 100` passes the backend value through unit-unchecked (grosze-vs-PLN 100× display risk). Next wave. |

### Missing vs Windows (by design vs live gap)

| Area | Status |
|---|---|
| Fiscal (POSNET/ELZAB direct), thermal ESC/POS, cash drawer, label print | **By design** — Android prints via remote jobs through the Windows agent (staff-JWT `/print-agent/jobs`). Receipt COPY + FISCAL both wired (E1a/E-FISCAL). No local drivers, drawer always reported closed. |
| Scanner (HID wedge), scale (Dibal) | **By design stubs** (`NO_SCALE`, no-op barcode) — no native plugin yet. |
| Billiard | Reads + `mutate` + full handoff (preflight/prepare/markPaymentOpened/beginTender/complete/recover/resolveUncertainTender) are REAL. **`beginRestoredTender` refuses on both transports** — see "Deferred" below; it is NOT a small packet. |
| Kitchen print/TV ads, LAN-first, self-checkout, customer display | **By design excluded** (desktop multi-window/LAN server hardware). |
| Master-catalog import / draft products / AI capture | STUB by design (admin surface, Windows counter). |
| Invoice module + KSeF | Windows has a full local invoice module; Android has the order-scoped slice (NIP lookup, add-invoice, proforma) REAL; PDF download stubbed (FileProvider forbidden by manifest). Accepted. |
| Bookings/Booksy, backup/restore, telegram, remote desktop, forecast, security cams | **By design waived** (desktop-only namespaces, listed in `tests/android-preload-surface-parity.test.ts:60-126`). |
| `pos.loyalty.lookupCustomer` | The only true MISSING path (renderer guards with `?.`) — registered known gap. |
| Server order history (`getServerList`) | **Live gap — fixed by Packet P2.** |
| Fake-success stubs: `kitchenCategories.setPrintEnabled`/`updateOrder` → `{ok:true}`, `quickKeys.create/update/remove/assign` → `{success:true}` | Dishonest stubs, low blast radius. Next wave (needs renderer UX check before flipping to refusals). |

### Deferred explicitly (documented so nobody "quick-fixes" them)

1. **`beginRestoredTender`** — Windows implementation (`pos.module.ts:2536-2656`) is a protected-hold journal state machine (READY → TENDER_COMMITTING → TENDER_UNCERTAIN, freeze registry, dispatch queue, auth-epoch checks, durable rollback). On Android the whole restored-cart slice (discovery in `billiardRecover`, restore into `checkoutDraft.restoredInterruption`, hold of a restored cart) is deferred — `hold-orders.ts:89-96`, `billiard-handoff.ts:777-780`. Porting only `beginRestoredTender` is useless without the slice; porting the slice is a full packet wave of its own (recommend: claude code opus, next wave, with this plan's P3 durability work landed first since the journal depends on flush-fail-closed semantics).
2. **Wave-1 receipt skip semantics** (`no printer ⇒ receiptPrinted:true`) — documented divergence #2, pinned by tests, a deliberate pilot-UX decision. P1 makes the skip *diagnosable* (carries the resolver error) without changing the outcome.
3. **eNail migration `2129100000000-CreatePosDeviceCommands`** — check-only PASSED; the `--yes` run is blocked until after 21:00 CEST (Warsaw peak guard). Run from the eNail repo per its contract, NOT from this plan:
   `./scripts/deploy-migration-contabo.sh --migration "backend/src/migrations/2129100000000-CreatePosDeviceCommands.ts" --yes`

---

## Agent assignment & sequencing

| Packet | Agent | Size | Files (must stay disjoint in parallel) |
|---|---|---|---|
| **P1** Remote-print honesty | **claude-glm** (skill `glm-code`, headless) | S | `src/renderer/android-pos/shim/remote-print.ts`, `tests/android-fiscal-print.test.ts`, `tests/android-remote-print.test.ts` |
| **P2** Server order history | **codex spark** (skill `codex-yolo`, one chunk) | S-M | `src/renderer/android-pos/port/server-order-adapter.ts` (new), `src/renderer/android-pos/shim/transport.ts`, `src/renderer/android-pos/shim/stubs.ts`, `src/renderer/android-pos/shim/real-transport.ts`, `tests/android-server-orders.test.ts` (new) |
| **P3** createOrder durability fail-closed | **claude code opus** | M | `src/renderer/android-pos/shim/real-transport.ts`, `tests/android-order-durability.test.ts` (new) |

**Sequencing:** P1 ∥ P2 run in parallel (file sets disjoint). **P3 starts only after P2 is committed** (both touch `real-transport.ts`). Supervisor reviews + commits each packet before the next depends on it. If any agent's diff touches a file outside its packet list → bounce it.

---

## Packet P1 — Remote-print honesty (claude-glm)

Fixes B1 + B2 and adds diagnosability to the skip path. `remote-print.ts` only. Synthetic S1 untouched (this file is only reached through the real transport).

### Task P1.1: Refuse fiscal print on an unpaired terminal (B1)

**Files:**
- Modify: `src/renderer/android-pos/shim/remote-print.ts:784-814` (`runRequestFiscalPrint`)
- Test: `tests/android-fiscal-print.test.ts`

**Interfaces:**
- Consumes: `machineId(): string | undefined` option already threaded into the coordinator (used at `:814`).
- Produces: a new terminal refusal result `{ success:false, fiscalPrinted:false, reason:'failed', error:'fiscal-idempotency-unavailable: …' }`. `RemoteFiscalPrintResult` type needs no change (`reason:'failed'` already exists).

- [ ] **Step 1: Write the failing test** (append to the fiscal describe block; reuse the file's existing `createRemotePrintCoordinator` harness — helper at `tests/android-fiscal-print.test.ts:132`, `machineId` override at `:136`):

```ts
test('fiscal print refuses on an unpaired terminal (no machineId → no idempotency key)', async () => {
  // Fiscal printer IS assigned — the refusal must be about pairing, not assignment.
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/print-agent/printers/assignments')) {
      return jsonResponse(ASSIGNED_FISCAL);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const { coordinator, createdJobs } = await makeCoordinator({
    fetchMock,
    machineId: '',            // unpaired terminal
  });
  const result = await coordinator.requestFiscalPrint('order-1');
  expect(result.success).toBe(false);
  expect(result.fiscalPrinted).toBe(false);
  expect(result.reason).toBe('failed');
  expect(result.error).toContain('fiscal-idempotency-unavailable');
  // The critical assertion: NO fiscal job was ever created.
  expect(createdJobs.length).toBe(0);
});
```

(Adapt helper names to the file's actual harness — it already tracks created jobs via its fetch mock; follow the pattern of the neighboring "idempotency key" tests. If the harness exposes the create-job calls differently, assert on the fetch mock: no call whose URL ends `/print-agent/jobs` with method POST.)

> **machineId resolution gotcha** (`remote-print.ts:495-499`): the coordinator reads `configStore.getRawConfig().machineId` FIRST and only falls back to `options.machineId`. The unpaired test must therefore (a) use a harness config store with NO `machineId` set, and (b) pass `machineId: ''` as the option — the `''` survives the harness's `overrides.machineId ?? 'device-1'` (`??` only catches null/undefined) and then falls through `configured || options.machineId || undefined` to `undefined`.

- [ ] **Step 2: Run it — must FAIL** (currently the job is submitted without a key):
`npx vitest run tests/android-fiscal-print.test.ts` → new test fails, 32 old pass.

- [ ] **Step 3: Implement.** In `runRequestFiscalPrint`, AFTER the no-fiscal-printer skip (keep the benign skip for salons with no fiscal printer) and BEFORE building the payload, insert:

```ts
    // B1 (2026-08-06): a fiscal job without an idempotency key can print a
    // DUPLICATE fiscal document on resubmit. machineId is the key's device
    // component (buildFiscalIdempotencyKey), so an unpaired terminal must
    // refuse — never submit key-less. The receipt COPY path is unchanged
    // (a duplicate copy is annoying, not illegal).
    const cleanMachineId = String(machineId() || '').trim();
    if (!cleanMachineId) {
      return {
        success: false,
        fiscalPrinted: false,
        reason: 'failed',
        error: 'fiscal-idempotency-unavailable: terminal is not paired (missing machineId); pair the device before fiscal printing.',
      };
    }
```

Placement: immediately after the `if (!printerId) { … skip … }` block at `:786-792`.

- [ ] **Step 4: Run tests — PASS:** `npx vitest run tests/android-fiscal-print.test.ts tests/android-remote-print.test.ts`

- [ ] **Step 5: Commit** — `fix(android): refuse fiscal print on unpaired terminal instead of submitting without idempotency key`

### Task P1.2: Stop full-TTL negative-caching of assignment-lookup ERRORS (B2)

**Files:**
- Modify: `src/renderer/android-pos/shim/remote-print.ts:534-559` (`resolvePrinterByRole`)
- Test: `tests/android-remote-print.test.ts`

**Interfaces:**
- Produces: unchanged signature. Behavior change: an **error** result is cached for `min(assignmentCacheTtlMs, 5000)` ms; a **successful** lookup (assignment found OR genuinely absent from a 200 response) keeps the full TTL. Genuine "no assignment" negative caching is unchanged.

- [ ] **Step 1: Write the failing test:**

```ts
test('assignment lookup errors are not negative-cached for the full TTL', async () => {
  vi.useFakeTimers();
  let calls = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/print-agent/printers/assignments')) {
      calls += 1;
      if (calls === 1) throw new Error('backend 502');   // transient error
      return jsonResponse(ASSIGNED_RECEIPT);             // then healthy
    }
    // ...job-create/status handlers per the file's existing harness...
  });
  const { coordinator } = await makeCoordinator({ fetchMock, assignmentCacheTtlMs: 60_000 });

  const first = await coordinator.getPrinterStatus(false);
  expect(first.assigned).toBe(false);           // error → unresolved this attempt

  await vi.advanceTimersByTimeAsync(6_000);     // > 5s error TTL, < 60s full TTL
  const second = await coordinator.getPrinterStatus(false);
  expect(second.assigned).toBe(true);           // error cache expired → re-resolved
  expect(calls).toBe(2);
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run — must FAIL** (today the second call within 60s returns the cached error).

- [ ] **Step 3: Implement.** Add a module-level constant near the other tuning constants:

```ts
/** B2 (2026-08-06): an ERROR from the assignment endpoint is cached only
 *  briefly — long enough to not hammer a flaky endpoint mid-checkout, short
 *  enough that one transient 5xx does not silently skip printing for a full
 *  TTL of sales. Genuine "no assignment" answers keep the full TTL. */
const ASSIGNMENT_ERROR_CACHE_TTL_MS = 5_000;
```

and change the single cache-write line at `:557`:

```ts
    const ttl = error ? Math.min(assignmentCacheTtlMs, ASSIGNMENT_ERROR_CACHE_TTL_MS) : assignmentCacheTtlMs;
    assignmentCacheByRole.set(role, { printerId, error, expiresAt: now + ttl });
```

- [ ] **Step 4: Run both remote-print test files — PASS.**

- [ ] **Step 5: Commit** — `fix(android): cache printer-assignment lookup errors briefly instead of full TTL`

### Task P1.3: Carry the resolver error into the skip results (diagnosability, no semantic change)

**Files:**
- Modify: `src/renderer/android-pos/shim/remote-print.ts:638-643` (receipt skip) and `:785-791` (fiscal skip)
- Test: extend one existing skip test in each file to assert the `error` passthrough.

- [ ] **Step 1: Extend tests:** in the existing "no printer ⇒ skip" tests, drive the skip via a **failing** assignment lookup and assert `result.error` contains the underlying message while `receiptPrinted`/`fiscalPrinted` and `skipped`/`reason` stay exactly as today.

- [ ] **Step 2: Implement.** Both skip sites destructure only `{ printerId }`; also take `error`:

```ts
    const { printerId, error: resolveError } = await resolvePrinterByRole(RECEIPT_PRINTER_ROLE);
    if (!printerId) {
      return {
        success: true, receiptPrinted: true, skipped: true, reason: 'no-printer',
        ...(resolveError ? { error: resolveError } : {}),
      };
    }
```

(and the fiscal twin with `fiscalPrinted:false, reason:'no-fiscal-printer'` — note the fiscal unpaired check from P1.1 sits after this block).

- [ ] **Step 3: Run gates:** `npm run typecheck:renderer && npx vitest run tests/android-remote-print.test.ts tests/android-fiscal-print.test.ts tests/android-shim.test.ts`

- [ ] **Step 4: Commit** — `fix(android): surface assignment-resolver error in print skip results`

---

## Packet P2 — Real server order history (codex spark)

Fixes B4: `pos.orders.getServerList` gets a real transport path. Windows reference: `pos.module.ts:6970-6993`; renderer consumer: `OrderHistoryModal.tsx:1357`. The network method **already exists** (`port/api-client.ts:918 getServerOrders`) — this packet is the adapter + seam wiring.

### Task P2.1: Port the server-order adapter to the Android graph

**Files:**
- Create: `src/renderer/android-pos/port/server-order-adapter.ts`
- Test: `tests/android-server-orders.test.ts` (new)

**Interfaces:**
- Produces: `adaptServerOrder(s: any): any` and `adaptServerOrderItem(item: any, orderId: string, order: any): any` with behavior **byte-identical** to `src/main/sync/pos-order-adapter.ts` (which imports only `../logger` + browser-safe `src/shared/` helpers).

- [ ] **Step 1: Copy the port.** Copy `adaptServerOrder`, `adaptServerOrderItem`, and every helper they reach (all exported: `toGrosze` `:28`, `toVatRate` `:88`, `normalizeRefundLinesJson` `:103`, `mergeRefundLineMetadataJson` `:190`, `normalizePaymentTendersJson` `:230`) **verbatim** from `src/main/sync/pos-order-adapter.ts` into the new file. Replace the `logger` import with a local shim:

```ts
// Ported 1:1 from src/main/sync/pos-order-adapter.ts (2026-08-06). The only
// change is the logger: the main-process logger is Node-coupled and the
// boundary verifier rejects it in the Android graph.
const logger = { warn: (...a: unknown[]) => console.warn('[server-order-adapter]', ...a) } as const;
```

Keep the `src/shared/pos-sale` and `src/shared/pos/vat-rate` imports as-is (they are browser-safe and already in the Android graph).

- [ ] **Step 2: Parity test (failing first because the file doesn't exist):**

```ts
import { describe, expect, test } from 'vitest';
import { adaptServerOrder as adaptAndroid, adaptServerOrderItem as adaptItemAndroid } from '../src/renderer/android-pos/port/server-order-adapter';
import { adaptServerOrder as adaptWindows, adaptServerOrderItem as adaptItemWindows } from '../src/main/sync/pos-order-adapter';

const SERVER_ORDER = {
  id: 'srv-1', orderNumber: 'B2B/2026/08/123', status: 'COMPLETED',
  paymentMethod: 'CASH', paymentStatus: 'PAID', total: 49.0, discountAmount: 0,
  createdAt: '2026-08-06T10:00:00.000Z', staffName: 'Ala Nowak',
  requiresInvoice: false, customerNip: null,
  items: [{ id: 'it-1', variantId: 'p1', productName: 'Gel Polish', quantity: 1, unitPrice: 49.0, vatRate: 23 }],
};

describe('server-order-adapter parity', () => {
  test('adaptServerOrder matches the Windows adapter bit-for-bit', () => {
    expect(adaptAndroid(SERVER_ORDER)).toEqual(adaptWindows(SERVER_ORDER));
  });
  test('adaptServerOrderItem matches the Windows adapter bit-for-bit', () => {
    const a = adaptAndroid(SERVER_ORDER);
    expect(adaptItemAndroid(SERVER_ORDER.items[0], a.id, SERVER_ORDER))
      .toEqual(adaptItemWindows(SERVER_ORDER.items[0], a.id, SERVER_ORDER));
  });
});
```

(Importing the Windows adapter **inside the test** is fine — tests run in Node; the boundary verifier only walks the Android entry graph. **BUT** `src/main/logger` imports `winston` + `electron`, so mock it **unconditionally** at the top of the test file, before the adapter import resolves:

```ts
vi.mock('../src/main/logger', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
```
)

- [ ] **Step 3: Run — PASS.** `npx vitest run tests/android-server-orders.test.ts`
- [ ] **Step 4: Boundary check:** `npm run test:android:boundaries:source` (the new file must not pull `src/main/**`).
- [ ] **Step 5: Commit** — `feat(android): port server-order adapter to the Android graph`

### Task P2.2: Add the transport port + wire stubs + real transport

**Files:**
- Modify: `src/renderer/android-pos/shim/transport.ts` (after `getOrderDetail?` at `:210`)
- Modify: `src/renderer/android-pos/shim/stubs.ts:328-330`
- Modify: `src/renderer/android-pos/shim/real-transport.ts` (orders section, near `getOrderHistory` `:1463`)
- Test: `tests/android-server-orders.test.ts`

**Interfaces:**
- Produces (transport.ts):

```ts
  /**
   * Server-side order list for Order History (S1 §2.G getServerList). Windows:
   * pos.module.ts:6970 → GET /api/v1/b2b/pos/orders (staff JWT), rows adapted
   * via adaptServerOrder/-Item. Never throws — network/auth failures map to
   * source:'network-error' / 'unconfigured' exactly like Windows.
   */
  getServerOrders?(params: any): Promise<{
    orders: any[];
    items: Record<string, any[]>;
    total: number;
    page: number;
    limit: number;
    source: 'server' | 'unconfigured' | 'network-error';
    error?: string;
  }>;
```

- [ ] **Step 1: Failing test** (extend `tests/android-server-orders.test.ts`; harness pattern: `tests/android-real-transport.test.ts` builds `createRealTransport` over a fetch mock + TokenStore):

```ts
test('getServerList delegates to the transport and adapts rows', async () => {
  // fetch mock: GET /api/v1/b2b/pos/orders → { orders:[SERVER_ORDER], total:1, page:1, limit:20 }
  const transport = await makeRealTransport({ fetchMock });
  const result = await transport.getServerOrders!({ page: 1, limit: 20 });
  expect(result.source).toBe('server');
  expect(result.orders).toHaveLength(1);
  expect(result.items[result.orders[0].id]).toHaveLength(1);
});

test('getServerList without auth token reports unconfigured (Windows parity)', async () => {
  const transport = await makeRealTransport({ fetchMock, noToken: true });
  const result = await transport.getServerOrders!({});
  expect(result.source).toBe('unconfigured');
  expect(result.orders).toEqual([]);
});

test('getServerList network failure reports network-error, never throws', async () => {
  const transport = await makeRealTransport({ fetchMock: failingFetch });
  const result = await transport.getServerOrders!({});
  expect(result.source).toBe('network-error');
  expect(result.error).toBeTruthy();
});

test('synthetic install keeps the unconfigured literal', async () => {
  const api = installShimForTest();                 // no transport
  const result = await api.pos.orders.getServerList({});
  expect(result).toEqual({ orders: [], items: {}, total: 0, page: 1, limit: 50, source: 'unconfigured' });
});
```

- [ ] **Step 2: Implement real-transport.** In the orders section of `createRealTransport`:

```ts
    getServerOrders: async (params: any) => {
      const limit = params?.limit ?? 20;
      const unconfigured = { orders: [], items: {}, total: 0, page: 1, limit, source: 'unconfigured' as const };
      // Windows parity (pos.module.ts:6971-6978): no token → 'unconfigured',
      // not an error. requireToken throws when logged out — probe first.
      const token = await tokenStore.getAccessToken().catch(() => null);
      if (!token) return unconfigured;
      try {
        const data = await client.getServerOrders(params ?? {});
        const itemsMap: Record<string, any[]> = {};
        const orders = data.orders.map((s: any) => {
          const adapted = adaptServerOrder(s);
          if (Array.isArray(s.items)) {
            itemsMap[adapted.id] = s.items.map((item: any) => adaptServerOrderItem(item, adapted.id, s));
          }
          return adapted;
        });
        return { orders, items: itemsMap, total: data.total, page: data.page, limit: data.limit, source: 'server' as const };
      } catch (err: any) {
        return { orders: [], items: {}, total: 0, page: 1, limit, source: 'network-error' as const, error: err?.message ?? String(err) };
      }
    },
```

`tokenStore` is the correct name — `createRealTransport` destructures `const { configStore, tokenStore } = options;` at `real-transport.ts:566` and `tokenStore.getAccessToken(): Promise<string | null>` is in scope inside the returned transport object. Import the two adapters from `../port/server-order-adapter`.

- [ ] **Step 3: Implement stubs delegation.** Replace `stubs.ts:328-330` with:

```ts
    // Delegate to the transport so Order History's server tab shows real
    // backend orders (Windows pos.module.ts:6970). The synthetic fallback keeps
    // the exact S2 'unconfigured' literal (pinned by tests).
    getServerList: (params: any) => withTransport(
      transport.getServerOrders,
      [params],
      () => ({
        orders: [] as any[], items: {} as Record<string, any[]>, total: 0, page: 1,
        limit: params?.limit ?? 50, source: 'unconfigured' as const,
      }),
    ),
```

Note the synthetic literal today ignores params and returns `limit: 50`; passing `params?.limit ?? 50` preserves the observed default for the no-arg call. If `tests/android-shim.test.ts` pins the old exact object for a no-arg call, the result is identical — verify, don't weaken the test.

- [ ] **Step 4: Run gates:** `npm run typecheck:renderer && npx vitest run tests/android- && npm run test:android:boundaries:source`
- [ ] **Step 5: Commit** — `feat(android): real server order history via transport getServerOrders`

---

## Packet P3 — `createOrder` durability fail-closed (claude code opus, AFTER P2 lands)

Fixes B3 (+B7 opportunistically). Money path: a `{success:true}` whose order didn't reach disk is a lie the cashier acts on.

### Task P3.1: Fail closed when the post-create flush fails

**Files:**
- Modify: `src/renderer/android-pos/shim/real-transport.ts:1349-1355` (createOrder), `:696-697` (B7 duplicate line)
- Test: `tests/android-order-durability.test.ts` (new; harness pattern from `tests/android-real-transport.test.ts`)

**Interfaces:**
- Consumes: `database.flush(): Promise<void>` (rejects when `persistence.saveImage` rejects — `db/db.ts:261-272`), `database.get/run/transaction` on the same `AndroidDatabase`.
- Produces: unchanged signature `createOrder(order, items) → {success, id?, error?, duplicate?}` plus a new failure shape `{success:false, error:'order-durability-failed: <detail>'}` and, on rollback failure, `{success:false, error:'order-durability-failed: <detail>', rollbackDurabilityError:'<detail>'}`.

**Design (mirror `hold-orders.ts` fail-closed policy and Windows `pos.module.ts` semantics — Windows AWAITS `database.save()` and lets a failure surface):**

> **Rollback must be capture-and-restore, NOT arithmetic reverse, and NOT `deleteLocalUnsynced`:**
> - The decrement at `:1340-1345` uses `MAX(0, in_stock - ?)` when `allowOversell` is off — if stock was already 0 the decrement was **clamped**, so adding `+quantity` back would create **phantom stock**.
> - `orderRepo.deleteLocalUnsynced` (`db/order-repo.ts:174`) is NOT reusable here: it refuses billiard-origin orders outright, and its restock predicate (`inventory_policy !== 'ALREADY_CONSUMED'`) is a different predicate than `shouldDecrementStockAtCheckout` — drift between the two would corrupt stock.
> - Correct approach: **before** the decrement loop, `SELECT in_stock, available_qty FROM product_variants WHERE id = ?` for each variant that will be decremented (the `shouldDecrementStockAtCheckout` set) and keep the rows in a local array. On rollback, write those captured values back verbatim and delete the order rows. The WebView is single-threaded and `createOrder` runs synchronously between capture and rollback — no concurrent writer can interleave.

1. Capture pre-decrement stock values for the affected variants (see box above).
2. After the stock-decrement loop, `await database.flush()` in a try/catch (no more `.catch(() => {})`).
3. On flush failure: **roll back** inside `database.transaction(...)` — `DELETE FROM order_items WHERE order_id = ?`, `DELETE FROM orders WHERE id = ?`, and for each captured row `UPDATE product_variants SET in_stock = ?, available_qty = ? WHERE id = ?`. Then attempt a second `database.flush()` for the rollback.
   - Rollback flush OK → return `{success:false, error:'order-durability-failed: ' + <original flush error>}` — the cashier retries; the in-memory row is gone, so the idempotent-by-id guard no longer sees it and the retry re-creates cleanly.
   - Rollback flush FAILS → the in-memory DB is rolled back (row gone — a later retry still re-creates cleanly) but the persisted image is stale/unknown; return `{success:false, error:'order-durability-failed: …', rollbackDurabilityError: <rollback error>}`.
4. **Backstop for a rollback transaction that itself throws** (sql.js should not fail on in-memory DELETE/UPDATE, but the row would then still exist and the duplicate guard at `:1264` would answer a retry with a lying `{success:true, duplicate:true}`): wrap the rollback transaction in try/catch; on throw, add the id to a module-scope `durabilityFailedOrders = new Set<string>()` and teach the duplicate guard:

```ts
        if (normalizedOrder.id && orderRepo.getById(normalizedOrder.id)) {
          if (durabilityFailedOrders.has(normalizedOrder.id)) {
            return {
              success: false,
              error: 'order-durability-failed: this order could not be persisted and its rollback also failed; restart the app before retrying.',
            };
          }
          return { success: true, id: normalizedOrder.id, duplicate: true } as any;
        }
```

5. `syncNailTurnCheckoutForOrder` fires only on the success path.
6. B7: delete ONE of the duplicated `holds?.invalidateAuth();` lines at `:696-697` (the mis-indented first one).

- [ ] **Step 1: Failing tests:**

Simulate flush failure through the **persistence seam** — the same injection the existing harness already uses (`tests/android-real-transport.test.ts:112-120` passes `dbInit: { locateFile, persistence: { loadImage, saveImage } }`; a rejecting `saveImage` makes `database.flush()` reject naturally, `db/db.ts:261-272`):

```ts
function flakyPersistence() {
  const state = { failSaves: 0 };   // >0 → next N saveImage calls reject
  return {
    state,
    persistence: {
      loadImage: async () => null,
      saveImage: async () => {
        if (state.failSaves > 0) { state.failSaves -= 1; throw new Error('disk full'); }
      },
      quarantineImage: async () => {},
    },
  };
}

test('createOrder fails closed when the durability flush fails, and restores captured stock', async () => {
  const { state, persistence } = flakyPersistence();
  const { transport } = build({ dbInit: { locateFile: NODE_LOCATE_FILE, persistence } });
  // seed product p1 (SEEDED_STOCK) + open shift via the harness's existing helpers
  state.failSaves = 2;               // create-flush AND rollback-flush both fail
  const first = await transport.createOrder!(ORDER, ITEMS);
  expect(first.success).toBe(false);
  expect(first.error).toContain('order-durability-failed');
  expect((first as any).rollbackDurabilityError).toBeTruthy();
  // in-memory rollback happened even though its flush failed:
  expect(await transport.getOrderDetail!(ORDER.id)).toBeNull();
  expect((await transport.getProductById!('p1'))!.in_stock).toBe(SEEDED_STOCK);
  // persistence healthy again → retry re-creates cleanly (no duplicate lie)
  const retry = await transport.createOrder!(ORDER, ITEMS);
  expect(retry).toMatchObject({ success: true, id: ORDER.id });
});

test('rollback does not fabricate stock past a MAX(0) clamped decrement', async () => {
  // Seed p1 with in_stock = 0, allowOversell = false. The decrement clamps at 0;
  // a naive arithmetic rollback would set stock to +quantity. Capture-and-restore
  // must land back at exactly 0.
  const { state, persistence } = flakyPersistence();
  const { transport, configStore } = build({ dbInit: { locateFile: NODE_LOCATE_FILE, persistence } });
  // seed p1 with in_stock: 0, available_qty: 0; open shift
  state.failSaves = 1;
  const result = await transport.createOrder!(ORDER, ITEMS);
  expect(result.success).toBe(false);
  expect((await transport.getProductById!('p1'))!.in_stock).toBe(0);   // NOT 1
});

test('happy path unchanged: flush succeeds → {success:true, id}, order persisted', async () => {
  const { persistence } = flakyPersistence();          // failSaves stays 0
  const { transport } = build({ dbInit: { locateFile: NODE_LOCATE_FILE, persistence } });
  // seed + open shift
  const result = await transport.createOrder!(ORDER, ITEMS);
  expect(result).toMatchObject({ success: true, id: ORDER.id });
  expect(await transport.getOrderDetail!(ORDER.id)).not.toBeNull();
});
```

(Seeding mechanics — products, shift open, ORDER/ITEMS fixtures: copy the createOrder test setup already present in `tests/android-real-transport.test.ts` verbatim; do not invent a new harness. `build(...)` is that file's factory at `:42`.)

- [ ] **Step 2: Run — new tests FAIL** (`success:true` today even with a rejecting flush).
- [ ] **Step 3: Implement** per the design above. Keep the rollback SQL the exact mirror of the decrement at `:1340-1345` (swap `-` for `+`; `allowNegative` variant needs no `MAX()` on the way back up; keep `track_inventory = 1`).
- [ ] **Step 4: Full gates:** `npm run typecheck:renderer && npx vitest run tests/android- && npm run test:android:boundaries:source`. Watch `tests/android-order-drain.test.ts` and `tests/android-weighted-sale.test.ts` — they exercise createOrder and must stay green with the awaited flush.
- [ ] **Step 5: Commit** — `fix(android): fail closed when a paid order cannot be flushed to disk` (separate tiny commit for B7: `chore(android): drop duplicated invalidateAuth call in auth teardown`)

---

## Supervisor protocol (this Claude session — after each packet)

1. `git -C /var/www/pos-zira diff` review: packet file-list respected, no synthetic literal changed, no new deps, no `src/main` imports in the Android graph.
2. Gates: `npm run typecheck:renderer` · `npx vitest run tests/android-` (0 fail; count ≥ 445 + new) · `npm run test:android:boundaries:source`.
3. Commit with the packet's message; keep the worktree clean between packets.
4. After ALL packets: full `npm test` once (whole suite, not just android), then push `feat/pos-billiard-parity-20260731` to origin.

### Build + install on the SUNMI (after the wave is committed)

```bash
cd /var/www/pos-zira
# ONE command: runs android:sync (boundary checks + vite android web build +
# cap sync + normalize + native-assets check) then gradle :app:assembleLiveDebug.
# NOTE: scripts/run-android-build.mjs is the WRONG script (it builds plain
# Debug/Release, not the liveDebug flavor).
npm run android:build:live
# APK: android-pos/app/build/outputs/apk/liveDebug/app-liveDebug.apk
sha256sum android-pos/app/build/outputs/apk/liveDebug/app-liveDebug.apk   # record new SHA (old: f9d07433…)
adb connect 127.0.0.1:44528               # SUNMI android-580f4984-… (tunnel already up)
adb -s 127.0.0.1:44528 install -r android-pos/app/build/outputs/apk/liveDebug/app-liveDebug.apk
# liveDebug applicationId = com.ziraai.posdiagnostics.dev.live
#   (base "com.ziraai.posdiagnostics.dev" + applicationIdSuffix ".live", app/build.gradle:26,44)
adb -s 127.0.0.1:44528 shell monkey -p com.ziraai.posdiagnostics.dev.live -c android.intent.category.LAUNCHER 1
```

If the Vite live server is preferred for iteration: `npm run dev:android:live` (binds `100.72.205.122:5173`; the liveDebug APK loads it).

**On-device smoke (SUNMI):** login → catalog → CASH sale → Order History: server tab now shows backend orders (P2) → fiscal print attempt on the unpaired/paired state you're testing (P1 refusal message when unpaired) → kill app mid-sale → relaunch → order present (P3 durability).

**No production deploy from this plan.** The eNail migration `--yes` run (after 21:00 CEST) and any backend/frontend deploy go through the eNail guarded lanes with Paul's explicit confirmation, from the eNail repo.
