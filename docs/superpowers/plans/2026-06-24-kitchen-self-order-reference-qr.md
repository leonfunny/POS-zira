# Kitchen Self-Order Reference QR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full-payload customer-slip QR with a tiny `KSOREF:` reference so the cashier scan always resolves through the backend pickup queue (claim → load → settle), fixing both the unscannable-large-QR and the lingering-paid-order bugs.

**Architecture:** The kiosk keeps pushing the FULL order payload to the backend (now with a durable retry outbox). The printed customer QR (both thermal "zamówienie"/pickup-slip `qrPayload` and Zebra label `labelQrPayload`) becomes a small reference to the backend row. On scan, the cashier calls `claim-by-ref`, claims atomically, loads the cart from the backend's stored payload, and settles on payment. Backend is unchanged.

**Tech Stack:** Electron 33 (main: TypeScript via `tsc -p tsconfig.main.json`; renderer: React + Vite), vitest (node env, `tests/**/*.test.ts`), backend NestJS (enail repo — NOT touched).

## Global Constraints

- App-side only (POS-zira). **No backend changes, no backend deploy.** `claim-by-ref`, idempotent `pushFromKiosk`, idempotent `settle` already exist + deployed (Contabo, dormant).
- **Do NOT touch chesaigon.** Forward feature for future salons. Test on a test salon (kitchen-self-order, `PAY_AT_COUNTER`).
- Dev on winpc `C:\POS-zira`, branch `main`. Commit locally; push is a separate owner-approved step.
- Tests = vitest, baseline-diff discipline. Run a single file with `npx vitest run tests/<file>.test.ts`.
- Reference format: `KSOREF:<token>.<orderNumber>` where `<token>` = UUID packed to base64url via existing `encodeKitchenSelfOrderUuidToken` (22 chars), or the raw id URL-encoded when not a UUID.
- Scanner hardware target = 2D / camera (reads QR).

---

### Task 1: Reference QR codec

**Files:**
- Modify: `src/shared/kitchen-self-order.ts` (add prefix const + 2 functions near the existing `decodeKitchenSelfOrderQr`, after the `encodeKitchenSelfOrderUuidToken`/`decodeKitchenSelfOrderUuidToken` helpers ~line 178-200)
- Test: `tests/kitchen-self-order-ref-qr.test.ts` (new)

**Interfaces:**
- Consumes: existing `encodeKitchenSelfOrderUuidToken(value): string|null`, `decodeKitchenSelfOrderUuidToken(value): string|null`, `decodeKitchenSelfOrderQr(code): KitchenSelfOrderQrPayload|null`.
- Produces:
  - `KITCHEN_SELF_ORDER_REF_QR_PREFIX = 'KSOREF:'`
  - `buildKitchenSelfOrderRefQr(sourceOrderId: string|null|undefined, orderNumber: string|null|undefined): string`
  - `decodeKitchenSelfOrderRefQr(code: string): { sourceOrderId: string|null; orderNumber: string|null } | null`

- [ ] **Step 1: Write the failing test**

Create `tests/kitchen-self-order-ref-qr.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buildKitchenSelfOrderRefQr,
  decodeKitchenSelfOrderRefQr,
  decodeKitchenSelfOrderQr,
  KITCHEN_SELF_ORDER_REF_QR_PREFIX,
} from '../src/shared/kitchen-self-order';

describe('kitchen self-order reference QR', () => {
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('round-trips a UUID sourceOrderId + orderNumber', () => {
    const qr = buildKitchenSelfOrderRefQr(uuid, 'K-042');
    expect(qr.startsWith(KITCHEN_SELF_ORDER_REF_QR_PREFIX)).toBe(true);
    expect(decodeKitchenSelfOrderRefQr(qr)).toEqual({ sourceOrderId: uuid, orderNumber: 'K-042' });
  });

  it('keeps the QR short for a UUID (well under 40 chars)', () => {
    expect(buildKitchenSelfOrderRefQr(uuid, '0042').length).toBeLessThan(40);
  });

  it('falls back to the raw id when sourceOrderId is not a UUID', () => {
    const qr = buildKitchenSelfOrderRefQr('kso-local-7', 'K-7');
    expect(decodeKitchenSelfOrderRefQr(qr)).toEqual({ sourceOrderId: 'kso-local-7', orderNumber: 'K-7' });
  });

  it('returns null for non-reference codes', () => {
    expect(decodeKitchenSelfOrderRefQr('KSO1:whatever')).toBeNull();
    expect(decodeKitchenSelfOrderRefQr('1234567890')).toBeNull();
    expect(decodeKitchenSelfOrderRefQr('')).toBeNull();
  });

  it('is not mistaken for a legacy KSO1 payload by the old decoder', () => {
    expect(decodeKitchenSelfOrderQr(buildKitchenSelfOrderRefQr(uuid, 'K-1'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\POS-zira && npx vitest run tests/kitchen-self-order-ref-qr.test.ts`
Expected: FAIL — `buildKitchenSelfOrderRefQr is not a function` / import errors.

- [ ] **Step 3: Write minimal implementation**

In `src/shared/kitchen-self-order.ts`, add after `decodeKitchenSelfOrderUuidToken` (before `decodeKitchenSelfOrderQr`):

```ts
export const KITCHEN_SELF_ORDER_REF_QR_PREFIX = 'KSOREF:';

/**
 * Compact customer-slip QR that only REFERENCES the backend pickup row. The
 * cashier resolves it via claim-by-ref and loads the cart from the backend's
 * stored payload, so the printed QR stays tiny regardless of item count.
 * Format: `KSOREF:<token>.<orderNumber>`.
 */
export function buildKitchenSelfOrderRefQr(
  sourceOrderId: string | null | undefined,
  orderNumber: string | null | undefined,
): string {
  const token =
    encodeKitchenSelfOrderUuidToken(sourceOrderId) ??
    encodeURIComponent(String(sourceOrderId ?? '').trim());
  const num = encodeURIComponent(String(orderNumber ?? '').trim());
  return `${KITCHEN_SELF_ORDER_REF_QR_PREFIX}${token}.${num}`;
}

export function decodeKitchenSelfOrderRefQr(
  code: string,
): { sourceOrderId: string | null; orderNumber: string | null } | null {
  const trimmed = String(code || '').trim();
  if (!trimmed.startsWith(KITCHEN_SELF_ORDER_REF_QR_PREFIX)) return null;
  const body = trimmed.slice(KITCHEN_SELF_ORDER_REF_QR_PREFIX.length);
  const dot = body.indexOf('.');
  const tokenPart = dot >= 0 ? body.slice(0, dot) : body;
  const numPart = dot >= 0 ? body.slice(dot + 1) : '';
  const sourceOrderId =
    decodeKitchenSelfOrderUuidToken(tokenPart) ||
    (tokenPart ? decodeURIComponent(tokenPart) : null);
  const orderNumber = numPart ? decodeURIComponent(numPart) : null;
  if (!sourceOrderId && !orderNumber) return null;
  return { sourceOrderId: sourceOrderId || null, orderNumber: orderNumber || null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:\POS-zira && npx vitest run tests/kitchen-self-order-ref-qr.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd C:\POS-zira
git add src/shared/kitchen-self-order.ts tests/kitchen-self-order-ref-qr.test.ts
git commit -m "feat(kitchen-self-order): add KSOREF reference QR codec"
```

---

### Task 2: Kiosk push retry/outbox

**Files:**
- Modify: `src/main/kitchen-self-order/pickup-queue-client.ts` (full rewrite of the push fn + add outbox)
- Test: `tests/pickup-queue-client.test.ts` (extend: update store mock + add outbox tests)

**Interfaces:**
- Consumes: `store` default (`get`/`set`), `getConfig`, `getSecureApiKey` from `../config/store`; `logger`.
- Produces:
  - `pushPickupOrderBestEffort(input: PickupOrderPushInput): Promise<void>` (unchanged signature; now persists transient failures to outbox)
  - `drainPickupPushOutbox(): Promise<void>` (NEW — Task 3 wires it into socket reconnect)
  - `PickupOrderPushInput` interface unchanged.

- [ ] **Step 1: Write the failing test**

Replace the mock block + add tests in `tests/pickup-queue-client.test.ts`. New mock header (replaces the existing `vi.hoisted`/`vi.mock('../src/main/config/store', …)`):

```ts
const { getConfigMock, getSecureApiKeyMock, storeGetMock, storeSetMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  getSecureApiKeyMock: vi.fn(),
  storeGetMock: vi.fn(),
  storeSetMock: vi.fn(),
}));
vi.mock('../src/main/config/store', () => ({
  default: { get: storeGetMock, set: storeSetMock },
  getConfig: getConfigMock,
  getSecureApiKey: getSecureApiKeyMock,
}));
```

Update the import line to also pull the drain fn:

```ts
import { pushPickupOrderBestEffort, drainPickupPushOutbox } from '../src/main/kitchen-self-order/pickup-queue-client';
```

In `beforeEach`, default the outbox to empty:

```ts
    storeGetMock.mockReturnValue([]);
```

Append these tests inside the `describe`:

```ts
  it('queues a failed push to the outbox and never throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(pushPickupOrderBestEffort(baseInput)).resolves.toBeUndefined();
    expect(storeSetMock).toHaveBeenCalledTimes(1);
    expect(storeSetMock.mock.calls[0][0]).toEqual([baseInput]);
  });

  it('does not queue when the terminal is unpaired', async () => {
    getSecureApiKeyMock.mockReturnValue(null);
    await pushPickupOrderBestEffort(baseInput);
    expect(storeSetMock).not.toHaveBeenCalled();
  });

  it('does not queue on a 2xx response', async () => {
    await pushPickupOrderBestEffort(baseInput);
    expect(storeSetMock).not.toHaveBeenCalled();
  });

  it('drains queued pushes on reconnect, keeping ones that still fail', async () => {
    const a = { ...baseInput, sourceOrderId: 'kso-a' };
    const b = { ...baseInput, sourceOrderId: 'kso-b' };
    storeGetMock.mockReturnValue([a, b]);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200 })   // a sends
      .mockRejectedValueOnce(new Error('still offline')); // b fails
    await drainPickupPushOutbox();
    expect(storeSetMock).toHaveBeenCalledTimes(1);
    expect(storeSetMock.mock.calls[0][0]).toEqual([b]);
  });

  it('drain is a no-op when the outbox is empty', async () => {
    storeGetMock.mockReturnValue([]);
    await drainPickupPushOutbox();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeSetMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\POS-zira && npx vitest run tests/pickup-queue-client.test.ts`
Expected: FAIL — `drainPickupPushOutbox is not a function` and outbox assertions fail.

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `src/main/kitchen-self-order/pickup-queue-client.ts`:

```ts
import store, { getConfig, getSecureApiKey } from '../config/store';
import logger from '../logger';

export interface PickupOrderPushInput {
  /** Source kiosk label, for the cashier list display. */
  terminalId?: string | null;
  /** Kiosk-local kitchen_self_orders.id — backend idempotency + scan-match key. */
  sourceOrderId: string;
  orderNumber: string;
  sequence: number;
  totalGrosze: number;
  /** The encoded order QR string (FULL payload) the backend stores so the
   * cashier can rebuild the cart on claim. NOT the printed reference. */
  qr: string;
}

const OUTBOX_KEY = 'pendingPickupPushes';

// Short ceiling: the push must never delay the kiosk submit response.
const PUSH_TIMEOUT_MS = 4000;

function readOutbox(): PickupOrderPushInput[] {
  const raw = (store as any).get(OUTBOX_KEY);
  return Array.isArray(raw) ? (raw as PickupOrderPushInput[]) : [];
}

function writeOutbox(entries: PickupOrderPushInput[]): void {
  (store as any).set(OUTBOX_KEY, entries);
}

/**
 * One push attempt. `done` = registered or nothing-to-do (don't queue);
 * `done:false` = transient failure (queue + retry later).
 */
async function attemptPush(input: PickupOrderPushInput): Promise<{ done: boolean }> {
  const cfg = getConfig();
  const apiKey = getSecureApiKey();
  if (!apiKey) return { done: true }; // unpaired terminal — nothing to push to

  const baseUrl = String(cfg.serverUrl || 'https://api.enail.pro').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/api/v1/print-agent/pickup-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        terminalId: input.terminalId ?? cfg.machineId ?? null,
        sourceOrderId: input.sourceOrderId,
        orderNumber: input.orderNumber,
        sequence: input.sequence,
        totalGrosze: input.totalGrosze,
        payload: { qr: input.qr },
      }),
      signal: controller.signal,
    });
    if (response.ok) return { done: true };
    // 4xx (except auth/timeout/rate-limit) = terminal client error: stop retrying.
    if (
      response.status >= 400 &&
      response.status < 500 &&
      ![401, 408, 429].includes(response.status)
    ) {
      logger.warn(`[PickupQueue] push rejected (terminal): HTTP ${response.status}`);
      return { done: true };
    }
    logger.warn(`[PickupQueue] push failed (will retry): HTTP ${response.status}`);
    return { done: false };
  } catch (err: any) {
    logger.warn(`[PickupQueue] push failed (will retry): ${err?.message || err}`);
    return { done: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Register a just-submitted kitchen self-order in the backend cashier pickup
 * queue. Best-effort: never throws, never blocks the kiosk. A transient failure
 * is persisted to a durable outbox and retried on reconnect. Backend
 * `pushFromKiosk` is idempotent on (salonId, sourceOrderId), so retries are safe.
 */
export async function pushPickupOrderBestEffort(input: PickupOrderPushInput): Promise<void> {
  try {
    const { done } = await attemptPush(input);
    if (done) return;
    const outbox = readOutbox().filter((e) => e.sourceOrderId !== input.sourceOrderId);
    outbox.push(input);
    writeOutbox(outbox);
    logger.warn(`[PickupQueue] push deferred to outbox: ${input.sourceOrderId}`);
  } catch (err: any) {
    logger.warn(`[PickupQueue] push failed: ${err?.message || err}`);
  }
}

/** Retry every queued push (call on socket reconnect). */
export async function drainPickupPushOutbox(): Promise<void> {
  const outbox = readOutbox();
  if (outbox.length === 0) return;
  const remaining: PickupOrderPushInput[] = [];
  for (const entry of outbox) {
    const { done } = await attemptPush(entry);
    if (!done) remaining.push(entry);
  }
  if (remaining.length !== outbox.length) {
    writeOutbox(remaining);
    logger.info(
      `[PickupQueue] push outbox drained: ${outbox.length - remaining.length} sent, ${remaining.length} pending`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:\POS-zira && npx vitest run tests/pickup-queue-client.test.ts`
Expected: PASS (original 4 + 5 new = 9 tests).

- [ ] **Step 5: Commit**

```bash
cd C:\POS-zira
git add src/main/kitchen-self-order/pickup-queue-client.ts tests/pickup-queue-client.test.ts
git commit -m "feat(pickup-queue): durable retry outbox for kiosk push"
```

---

### Task 3: Print the reference QR + drain push outbox on reconnect

**Files:**
- Modify: `src/main/modules/pos.module.ts` — import + 4 print sites + reconnect hook

**Interfaces:**
- Consumes: `buildKitchenSelfOrderRefQr` (Task 1), `drainPickupPushOutbox` (Task 2).
- Produces: customer prints carry the reference; the full payload still goes to the push.

- [ ] **Step 1: Add imports**

Add `buildKitchenSelfOrderRefQr` to the existing shared import group (the block importing `KITCHEN_SELF_ORDER_QR_PREFIX` near line 108):

```ts
  KITCHEN_SELF_ORDER_QR_PREFIX,
  buildKitchenSelfOrderRefQr,
```

Update the pickup-settle import to add the push drain (line ~50):

```ts
import { settlePickupOrderForSale, drainPickupSettleOutbox } from '../kitchen-self-order/pickup-settle';
import { pushPickupOrderBestEffort, drainPickupPushOutbox } from '../kitchen-self-order/pickup-queue-client';
```

(Replace the existing single `pushPickupOrderBestEffort` import line at ~49 with the line above.)

- [ ] **Step 2: Swap printed QR → reference at all 4 customer-print sites**

At EACH of the 4 sites, keep `qrPayload` (FULL — used for the push + return) and add `refQr`, then pass `refQr` to the ticket constructor and to `labelQrPayload`.

**Site A — submit handler (~3006-3010):** change
```ts
        const ticket = buildKitchenSelfOrderTicket(created, brandName, qrPayload, sourceLabel);
        ticket.labelQrPayload = buildKitchenSelfOrderQrPayload(created, {
          kitchenAlreadyReleased: kitchenReleased,
          includeNotes: false,
        });
```
to
```ts
        const refQr = buildKitchenSelfOrderRefQr(created.id, created.order_number);
        const ticket = buildKitchenSelfOrderTicket(created, brandName, refQr, sourceLabel);
        ticket.labelQrPayload = refQr;
```

**Site B — retry print `reprint_slip` branch (~3176-3179):** change
```ts
          const ticket = buildKitchenSelfOrderTicket(order, brandName, qrPayload, sourceLabel);
          ticket.labelQrPayload = buildKitchenSelfOrderQrPayload(order, {
            kitchenAlreadyReleased: true,
            includeNotes: false,
          });
```
to
```ts
          const refQr = buildKitchenSelfOrderRefQr(order.id, order.order_number);
          const ticket = buildKitchenSelfOrderTicket(order, brandName, refQr, sourceLabel);
          ticket.labelQrPayload = refQr;
```

**Site C — retry print full branch (~3208-3212):** change
```ts
        const ticket = buildKitchenSelfOrderTicket(order, brandName, qrPayload, sourceLabel);
        ticket.labelQrPayload = buildKitchenSelfOrderQrPayload(order, {
          kitchenAlreadyReleased: kitchenReleased,
          includeNotes: false,
        });
```
to
```ts
        const refQr = buildKitchenSelfOrderRefQr(order.id, order.order_number);
        const ticket = buildKitchenSelfOrderTicket(order, brandName, refQr, sourceLabel);
        ticket.labelQrPayload = refQr;
```

**Site D — `kitchen-self-order:reprintSlip` handler (~3298-3300):** change
```ts
        const ticket = buildKitchenSelfOrderTicket(order, resolveKitchenSelfOrderBrandName(cfg), qrPayload, sourceLabel);
        ticket.labelQrPayload = buildKitchenSelfOrderQrPayload(order, {
          kitchenAlreadyReleased: true,
          includeNotes: false,
        });
```
to
```ts
        const refQr = buildKitchenSelfOrderRefQr(order.id, order.order_number);
        const ticket = buildKitchenSelfOrderTicket(order, resolveKitchenSelfOrderBrandName(cfg), refQr, sourceLabel);
        ticket.labelQrPayload = refQr;
```

> Leave `const qrPayload = buildKitchenSelfOrderQrPayload(...)` and every `pushPickupOrderBestEffort({ … qr: qrPayload })` untouched — the backend must keep the FULL payload to rebuild the cart.

- [ ] **Step 3: Drain the push outbox on reconnect**

At the reconnect hook (~line 3666), change
```ts
    socket.on('connected', () => { void drainPickupSettleOutbox(); });
```
to
```ts
    socket.on('connected', () => { void drainPickupSettleOutbox(); void drainPickupPushOutbox(); });
```

- [ ] **Step 4: Typecheck + grep verification**

Run: `cd C:\POS-zira && npx tsc -p tsconfig.main.json --noEmit`
Expected: exits 0, no errors.

Run: `cd C:\POS-zira && findstr /N /C:"buildKitchenSelfOrderRefQr(" src\main\modules\pos.module.ts`
Expected: 4 matches (one per print site).

Run: `cd C:\POS-zira && findstr /N /C:"qr: qrPayload" src\main\modules\pos.module.ts`
Expected: 2 matches (the two push sites still send the FULL payload).

- [ ] **Step 5: Commit**

```bash
cd C:\POS-zira
git add src/main/modules/pos.module.ts
git commit -m "feat(kitchen-self-order): print KSOREF reference on customer slip + label; drain push outbox on reconnect"
```

---

### Task 4: Cashier scan resolves the reference via claim-by-ref

**Files:**
- Modify: `src/renderer/components/pos/POSLayout.tsx` — import, new `handleScannedPickupRef`, wire into both scan entries, remove the last silent no-claim fallback.

**Interfaces:**
- Consumes: `decodeKitchenSelfOrderRefQr` (Task 1); existing `window.electronAPI.pos.pickupOrders.claimByRef/release`, `loadKitchenSelfOrderQr`, `decodeKitchenSelfOrderQr`, `removePickupOrder`, `setPickupOrders`, `setActivePickup`, `handleScannedKioskOrder`, `showScanToast`.
- Produces: a `KSOREF:` scan that claims atomically, loads the cart from the backend payload, and settles on payment.

- [ ] **Step 1: Add the import**

In the shared-codec import group (~line 13-15, alongside `decodeKitchenSelfOrderQr` and `type KitchenSelfOrderQrPayload`):

```ts
  decodeKitchenSelfOrderQr,
  decodeKitchenSelfOrderRefQr,
```

- [ ] **Step 2: Add `handleScannedPickupRef`**

Immediately AFTER the existing `handleScannedKioskOrder` useCallback (ends ~line 909), add:

```ts
  // A scanned KSOREF reference: claim the backend row, then build the cart from
  // the AUTHORITATIVE backend payload (the reference carries no items). Always
  // claims → settles on pay → leaves the queue. No silent unclaimed load.
  const handleScannedPickupRef = useCallback(async (
    ref: { sourceOrderId: string | null; orderNumber: string | null },
  ): Promise<void> => {
    const currentState = await window.electronAPI.pos.getState().catch(() => state);
    if ((currentState?.cart.items.length ?? 0) > 0) {
      showScanToast('Clear cart before scanning a kiosk order', 'err');
      return;
    }
    const res = await window.electronAPI.pos.pickupOrders.claimByRef({
      sourceOrderId: ref.sourceOrderId ?? undefined,
      orderNumber: ref.orderNumber ?? undefined,
    });
    if (res?.ok) {
      const pickupOrderId: string | undefined = res.data?.id;
      const authoritativeQr: unknown = res.data?.payload?.qr;
      const decoded = typeof authoritativeQr === 'string'
        ? decodeKitchenSelfOrderQr(authoritativeQr)
        : null;
      if (!decoded) {
        showScanToast('Đơn không hợp lệ', 'err');
        if (pickupOrderId) await window.electronAPI.pos.pickupOrders.release(pickupOrderId).catch(() => {});
        return;
      }
      const loaded = await loadKitchenSelfOrderQr(decoded, { pickupOrderId: pickupOrderId ?? null });
      if (!loaded && pickupOrderId) {
        await window.electronAPI.pos.pickupOrders.release(pickupOrderId).catch(() => {});
      }
      if (loaded && pickupOrderId) {
        setActivePickup({ id: pickupOrderId, orderNumber: decoded.orderNumber });
      }
      if (pickupOrderId) setPickupOrders((prev) => removePickupOrder(prev, pickupOrderId));
      return;
    }
    if (res?.status === 409) { showScanToast('Đơn đang được xử lý ở máy khác', 'err'); return; }
    if (res?.status === 410) { showScanToast('Đơn đã thanh toán hoặc đã huỷ', 'err'); return; }
    showScanToast('Đơn chưa lên hệ thống — chọn từ danh sách hoặc tính tiền tay', 'err');
  }, [state, loadKitchenSelfOrderQr, showScanToast]);
```

- [ ] **Step 3: Wire into `handleBarcodeKeyDown`**

In `handleBarcodeKeyDown`, right after `setBarcodeBuffer('');` and BEFORE `const kioskOrder = decodeKitchenSelfOrderQr(code);`, insert:

```ts
      const pickupRef = decodeKitchenSelfOrderRefQr(code);
      if (pickupRef) {
        document.dispatchEvent(new CustomEvent('pos:manual-cart-action'));
        await handleScannedPickupRef(pickupRef);
        return;
      }
```

Add `handleScannedPickupRef` to that callback's dependency array.

- [ ] **Step 4: Wire into `handleUnknownBarcodeScanned` + remove the silent no-claim load**

Replace the body of `handleUnknownBarcodeScanned` (~line 977-985):

```ts
  const handleUnknownBarcodeScanned = useCallback(async (code: string) => {
    const pickupRef = decodeKitchenSelfOrderRefQr(code);
    if (pickupRef) {
      document.dispatchEvent(new CustomEvent('pos:manual-cart-action'));
      await handleScannedPickupRef(pickupRef);
      return;
    }
    const kioskOrder = decodeKitchenSelfOrderQr(code);
    if (kioskOrder) {
      document.dispatchEvent(new CustomEvent('pos:manual-cart-action'));
      await handleScannedKioskOrder(kioskOrder);
      return;
    }
    await openScanImport(code);
  }, [handleScannedPickupRef, handleScannedKioskOrder, openScanImport]);
```

(The legacy `KSO1:` branch now routes through `handleScannedKioskOrder`, which claims — replacing the old `loadKitchenSelfOrderQr(kioskOrder)` that loaded without claiming.)

- [ ] **Step 5: Typecheck verification**

Run: `cd C:\POS-zira && npm run typecheck:renderer`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
cd C:\POS-zira
git add src/renderer/components/pos/POSLayout.tsx
git commit -m "feat(pickup-queue): scan KSOREF reference -> claim-by-ref + load from backend payload"
```

---

### Task 5: E2E verification on a test salon

**Files:** none (manual verification). Do NOT run on chesaigon.

**Interfaces:**
- Consumes: Tasks 1-4. Confirms the happy path + the two original bugs are gone.

- [ ] **Step 1: Build + run on the test machine**

```bash
cd C:\POS-zira
npm run build
npm run start
```
Expected: app launches; paired to a test salon with kitchen-self-order `PAY_AT_COUNTER`.

- [ ] **Step 2: Large-order scannability**

Submit a kitchen self-order with many items (10+). Inspect the printed customer slip/label QR.
Expected: the QR is small (`KSOREF:` ~35 chars) and scans on the first try.

- [ ] **Step 3: Scan → claim → pay → leaves queue (the core bug)**

On a cashier POS station, confirm the order shows in "Đơn bếp (N)". Scan the slip QR.
Expected: cart loads from the backend payload; the "Đang xử lý: <số>" banner appears; the row leaves this station's list. Take payment.
Expected: after payment the row is gone from the queue on ALL stations (settled).

- [ ] **Step 4: Two-machine + edge cases**

- Second station scanning the same already-claimed slip → "Đơn đang được xử lý ở máy khác" (409).
- Scanning an already-paid slip → "Đơn đã thanh toán hoặc đã huỷ" (410).
- Pull the network at submit, restore it, then scan → the push outbox drains on reconnect and the scan resolves (or, if still unregistered, the clear "Đơn chưa lên hệ thống" toast shows — no silent unclaimed load).
- List-tap path still works unchanged.

- [ ] **Step 5: Record results**

Note pass/fail per step. If all pass, the feature is ready for the owner's decision on rollout (push to origin/main + per-salon enablement).

---

## Self-Review

**Spec coverage:**
- Reference codec → Task 1. ✓
- Both customer print formats (`qrPayload` thermal + `labelQrPayload` Zebra) → reference → Task 3 (all 4 sites). ✓ Kitchen ticket stays QR-less (passed `null`) — untouched. ✓
- Scan resolves via claim-by-ref, loads from backend payload, settles, removes silent fallback → Task 4. ✓
- Durable push retry/outbox + drain on reconnect → Tasks 2 & 3. ✓
- Backend unchanged → no backend task. ✓
- Edge cases 404/409/410, legacy `KSO1:` slips → Task 4 + Task 5. ✓
- Constraints (app-only, no chesaigon, test salon, winpc main) → Global Constraints + Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✓

**Type consistency:** `buildKitchenSelfOrderRefQr(sourceOrderId, orderNumber)` and `decodeKitchenSelfOrderRefQr(code) -> {sourceOrderId, orderNumber}|null` used identically in Tasks 1/3/4. `drainPickupPushOutbox()` defined in Task 2, imported + called in Task 3. `claimByRef({sourceOrderId?, orderNumber?})` matches the existing preload signature. ✓

**Note on test depth:** Tasks 1 & 2 are full TDD (pure codec + push outbox with mocked fetch/store — matches the repo's existing `tests/**/*.test.ts` unit style). Tasks 3 & 4 are integration glue in the large `pos.module.ts` / `POSLayout.tsx` files, which this codebase verifies by typecheck + E2E rather than component/IPC unit tests; Task 5 is the E2E gate. This is intentional and consistent with the established testing approach, not a coverage gap to paper over.
