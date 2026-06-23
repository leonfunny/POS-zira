# Kitchen Self-Order Print-Retry Fix (Phase 2a) — Spec + TDD Plan

> **For agentic workers:** REQUIRED SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. If using Claude Superpowers, use the equivalent `superpowers:subagent-driven-development` / `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

Status: reviewed root cause, not yet implemented
Date: 2026-06-23
Repo: **POS-zira** desktop app (Electron) — app-side only, no backend change.
Related: `KITCHEN_SELF_ORDER_KIOSK_RESTRUCTURE_DESIGN.md` (Phase 1), `KITCHEN_SELF_ORDER_DESIGN_CONTRACT.md`.

> **Scope guard:** forward feature, **do NOT touch chesaigon** (POS tab only). Dev + test on `winpc` against test salon `owner+salon-test-kuchnia@test.local`. No production deploy. This is **Phase 2a (robustness)**; the UX/UI redesign is the separate, lower-priority **Phase 2b**.

---

## 1. Problem & root cause (confirmed by reading the code)

On the **kitchen-self-order kiosk**, when a print fails there is no way to retry — the customer must restart the kiosk app to redo the order. Root cause, in `src/main/modules/pos.module.ts` + `src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx`:

1. **Retry is asymmetric.** The submit handler returns `canRetrySlip = kitchenReleased && !slipPrint.printed` — retry exists **only** when the kitchen ticket printed but the customer slip failed. `reprintSlip` even **refuses** (`error:'kitchen_not_printed'`) when `!order.kitchen_printed`. So a **kitchen-ticket failure** (printer offline / unconfigured / LAN unreachable — common on a fresh test salon) has **no retry path** at all: `success=false`, `canRetrySlip=false` → renderer shows a generic error with no retry button.
2. **Re-pressing "Place order" creates a DUPLICATE.** The order is `create()`-d before printing. On a non-`canRetrySlip` failure the renderer is not locked, so pressing submit again runs the full submit → a **new** order (new number, new pickup-queue push), not a retry. The only correct escape is an app restart — exactly the reported symptom.
3. **A throw during printing loses the `orderId`.** The submit `catch` returns `{ success:false, error }` with **no** `orderId`, even though `create()` already ran — so the renderer cannot retry the existing order and re-submits → duplicate.

**Not a Phase 1 regression** — Phase 1 did not touch `pos.module.ts` or `KitchenSelfOrderApp.tsx`. This is a pre-existing gap in the original kitchen-self-order feature.

**Reference pattern to mirror:** the grocery self-checkout already handles print failure (holds the screen on `printFailed`, offers staff call, self-recovers). The kitchen kiosk needs the equivalent for the kitchen-ticket-failure case, plus a no-duplicate retry of the existing order.

## 2. Goals / non-goals

**Goals**
- A print failure (kitchen ticket, slip, or total) offers a **Retry** that re-prints the **existing** order — **never** creates a duplicate.
- A throw during printing still yields a retryable `orderId`.
- A light **"Start over"** escape resets the kiosk for the next customer if the printer stays down. If submit reached the existing pickup-queue push, the created order remains visible to the cashier; if the failure threw before that push, the order may exist only in the local kitchen self-order DB and staff lookup/retry is still required.

**Non-goals (Phase 2a)**
- No UX/UI redesign (that is Phase 2b).
- No deep pickup-queue cancel/release on abandon (that is pickup-queue P4). "Start over" just resets the kiosk; staff handle any stale queue row or local failed-created order.
- No new staff-call backend/infra — "Start over" is a local reset.

## 3. Design (locked)

1. **One source of truth for retry decision — a pure helper** in `src/shared/kitchen-self-order.ts`:
   - `resolveKitchenSelfOrderRetryAction({ kitchenPrinted, customerSlipPrinted })` → `'none' | 'reprint_slip' | 'reprint_all'`:
     - kitchen ✔ + slip ✔ → `'none'`
     - kitchen ✔ + slip ✘ → `'reprint_slip'` (slip only; never re-dispatch a kitchen ticket)
     - kitchen ✘ → `'reprint_all'` (re-print kitchen ticket, then slip)
   The main handler owns this decision. The renderer only locks failed-created orders and delegates the exact slip-vs-all route to `retryPrint`; it may import the helper only for display copy, not for correctness.
2. **New main IPC `kitchen-self-order:retryPrint(orderId)`** that re-prints the **existing** order (no `create()`):
   - `'reprint_all'` → mirror the submit print block on the loaded order: `printKitchenSelfOrderTicket` → `kitchenReleased = printed || uncertain` → rebuild QR/slip with `kitchenAlreadyReleased` → if released, `printKitchenSelfOrderCustomerSlip` → `markPrintResult(order.id, …)`; if `PAY_AT_COUNTER` and newly released, `pushPickupOrderBestEffort` (idempotent by `sourceOrderId`). Preserve the existing "uncertain counts as released" policy to avoid duplicate kitchen tickets after LAN ambiguity.
   - `'reprint_slip'` → the existing `reprintSlip` behavior (`markCustomerSlipResult`).
   - `'none'` → `{ success:true, canRetry:false, canRetrySlip:false }` (already fully printed; idempotent).
   - Returns the same generalized shape as submit: `{ success, orderId, orderNumber, kitchenPrinted, customerSlipPrinted, canRetry, canRetrySlip, error }`.
   - `canRetry` means "an existing created order can be retried"; `canRetrySlip` is kept only for legacy/slip-only compatibility. Renderer lock source of truth is `!success && orderId`, not either flag.
   - Pickup-queue re-push can refresh the QR only while the backend row is still `PENDING` (per pickup-queue design). If the row is already `CLAIMED`/`SETTLED`/`CANCELLED`, the retry path must not assume the backend will overwrite status or payload; it should preserve backend state and rely on cashier claim/scan semantics.
3. **Harden the submit `catch`** to return `orderId: created?.id` (and `orderNumber`) when the order was created before the throw — so any failure is retryable, never re-submittable.
4. **Preload:** expose `kitchenSelfOrder.retryPrint(orderId)`.
5. **Renderer (`KitchenSelfOrderApp.tsx`):**
   - Generalize the lock: `orderLockedForRetry = !!(submitResult && !submitResult.success && submitResult.orderId)`. While locked, the review button is **Retry** (not Place order) and `onBack` cannot leave to menu via the normal path.
   - The retry handler calls `retryPrint(orderId)`; on `success` → clear cart + `done`; else stay + show error + Retry again.
   - When `submitOrder` runs with an active locked order, it must call retry, **not** submit (extends the current `canRetrySlip` guard to `orderLockedForRetry`).
   - Add a **"Start over"** secondary action (only while locked) → clear cart, clear `submitResult`, `setStep('menu')`.
   - If `!success && !orderId` (failed before create) → keep "Place order" (safe re-submit, no order exists).

**Known residual risk:** app-only retry cannot prove the physical outcome of a hard throw that happens after the printer already produced a kitchen ticket but before `markPrintResult` persists `kitchen_printed=1`. The existing print helper's `{ printed, uncertain }` contract is the only protection here; Phase 2a must not claim exactly-once physical printing under process-crash/driver-crash ambiguity.

## 4. TDD Implementation Plan

### Task 0: Reproduce + baseline (no code change)

- [ ] **Step 1: Capture the bug + test baseline**

Run: `cd C:\POS-zira; npx vitest run 2>&1 | Tee-Object "$env:TEMP\pos-zira-phase2a-baseline.txt"`
Note the pre-existing failures (do not commit this file). Confirm the repro on the kiosk: with no kitchen printer configured, submit an order → generic error, no retry, re-press creates a new order number.

### Task 1: Pure retry-action resolver in shared

**Files:**
- Modify: `src/shared/kitchen-self-order.ts`
- Test (new): `tests/kitchen-self-order-retry.test.ts`

**Interfaces:**
- Produces: `export type KitchenSelfOrderRetryAction = 'none' | 'reprint_slip' | 'reprint_all'`
- Produces: `export function resolveKitchenSelfOrderRetryAction(state: { kitchenPrinted?: boolean | number | null; customerSlipPrinted?: boolean | number | null }): KitchenSelfOrderRetryAction`

- [ ] **Step 1: Write the failing test**

Create `tests/kitchen-self-order-retry.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { resolveKitchenSelfOrderRetryAction } from '../src/shared/kitchen-self-order';

describe('kitchen self-order retry action', () => {
  it('fully printed → none', () => {
    expect(resolveKitchenSelfOrderRetryAction({ kitchenPrinted: 1, customerSlipPrinted: 1 })).toBe('none');
    expect(resolveKitchenSelfOrderRetryAction({ kitchenPrinted: true, customerSlipPrinted: true })).toBe('none');
  });
  it('kitchen ok, slip failed → reprint_slip', () => {
    expect(resolveKitchenSelfOrderRetryAction({ kitchenPrinted: 1, customerSlipPrinted: 0 })).toBe('reprint_slip');
  });
  it('kitchen failed → reprint_all (covers the gap)', () => {
    expect(resolveKitchenSelfOrderRetryAction({ kitchenPrinted: 0, customerSlipPrinted: 0 })).toBe('reprint_all');
    expect(resolveKitchenSelfOrderRetryAction({})).toBe('reprint_all');
    expect(resolveKitchenSelfOrderRetryAction({ kitchenPrinted: null, customerSlipPrinted: null })).toBe('reprint_all');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/kitchen-self-order-retry.test.ts`
Expected: FAIL — `resolveKitchenSelfOrderRetryAction` not exported.

- [ ] **Step 3: Implement the resolver**

In `src/shared/kitchen-self-order.ts` (next to `resolveKitchenSelfOrderMenuSource`):
```ts
export type KitchenSelfOrderRetryAction = 'none' | 'reprint_slip' | 'reprint_all';

export function resolveKitchenSelfOrderRetryAction(
  state: { kitchenPrinted?: boolean | number | null; customerSlipPrinted?: boolean | number | null },
): KitchenSelfOrderRetryAction {
  const kitchen = state.kitchenPrinted === true || Number(state.kitchenPrinted) === 1;
  const slip = state.customerSlipPrinted === true || Number(state.customerSlipPrinted) === 1;
  if (kitchen && slip) return 'none';
  if (kitchen && !slip) return 'reprint_slip';
  return 'reprint_all';
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/kitchen-self-order-retry.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/shared/kitchen-self-order.ts tests/kitchen-self-order-retry.test.ts
git commit -m "feat(kitchen-self-order): pure retry-action resolver (none|reprint_slip|reprint_all)"
```

### Task 2: Main `retryPrint` IPC + harden submit catch + preload

**Files:**
- Modify: `src/main/modules/pos.module.ts` (new `kitchen-self-order:retryPrint` handler; submit `catch` returns `orderId`)
- Modify: `src/preload/preload-kitchen-self-order.ts` (expose `retryPrint`)
- Modify: `tests/kitchen-self-order.test.ts` (static wiring assertions)

**Interfaces:**
- IPC `kitchen-self-order:retryPrint` (orderId) → `{ success, orderId, orderNumber, kitchenPrinted, customerSlipPrinted, canRetry, canRetrySlip, error }`.
- Preload: `kitchenSelfOrder.retryPrint(orderId: string)`.
- Keep `canRetrySlip` on existing submit/reprint responses for compatibility, but new renderer logic must lock by `!success && orderId`.

- [ ] **Step 1: Write the failing static-wiring test**

Add to `tests/kitchen-self-order.test.ts`:
```ts
  it('offers a no-duplicate retry that re-prints the existing order (kitchen + slip)', () => {
    const posModuleSource = readSource('src/main/modules/pos.module.ts');
    const preloadSource = readSource('src/preload/preload-kitchen-self-order.ts');
    const retryStart = posModuleSource.indexOf("ipcMain.handle('kitchen-self-order:retryPrint'");
    const retryEnd = posModuleSource.indexOf("ipcMain.handle('", retryStart + 1);
    const retryBlock = retryStart >= 0 ? posModuleSource.slice(retryStart, retryEnd === -1 ? undefined : retryEnd) : '';

    // A dedicated retry IPC that re-prints the EXISTING order — never create() again.
    expect(retryStart).toBeGreaterThan(-1);
    expect(retryBlock).toContain('kitchenSelfOrderRepo.getById');
    expect(retryBlock).toContain('resolveKitchenSelfOrderRetryAction');
    expect(retryBlock).not.toContain('kitchenSelfOrderRepo.create');
    expect(retryBlock).toContain('markPrintResult(order.id');
    expect(retryBlock).toContain('pushPickupOrderBestEffort');
    // The submit catch must surface the created orderId so a throw is still retryable.
    expect(posModuleSource).toContain('orderId: created?.id');
    expect(preloadSource).toContain("ipcRenderer.invoke('kitchen-self-order:retryPrint'");
  });
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/kitchen-self-order.test.ts -t "no-duplicate retry"` → FAIL.

- [ ] **Step 3: Implement the retry handler (read the submit + reprintSlip blocks first)**

In `pos.module.ts`, add `ipcMain.handle('kitchen-self-order:retryPrint', …)` near `reprintSlip`:
- Trim/validate `orderId`; `kitchenSelfOrderRepo.getById(id)`; not found → `{ success:false, error:'order_not_found' }`.
- `const action = resolveKitchenSelfOrderRetryAction({ kitchenPrinted: order.kitchen_printed, customerSlipPrinted: order.customer_slip_printed })`.
- `'none'` → `{ success:true, orderId:order.id, orderNumber:order.order_number, kitchenPrinted:true, customerSlipPrinted:true, canRetry:false, canRetrySlip:false }`.
- `'reprint_slip'` → reuse the existing `reprintSlip` body (slip-only via `printKitchenSelfOrderCustomerSlip` + `markCustomerSlipResult`); return `{ canRetry: !slipPrint.printed, canRetrySlip: !slipPrint.printed }`.
- `'reprint_all'` → mirror the submit print block **on the loaded order** (no `create()`): `buildKitchenSelfOrderTicket` → `printKitchenSelfOrderTicket` → `kitchenReleased = kitchenPrint.printed || kitchenPrint.uncertain === true` → rebuild QR + label QR with `kitchenAlreadyReleased: kitchenReleased` → `slipPrint = kitchenReleased ? printKitchenSelfOrderCustomerSlip(ticket) : { printed:false, error:'kitchen_not_printed' }` → `markPrintResult(order.id, { kitchenPrinted: kitchenReleased, customerSlipPrinted: slipPrint.printed, … })`; if `normalizeKitchenSelfOrderCheckoutMode(getConfig().kitchenSelfOrderCheckoutMode)` is `PAY_AT_COUNTER` and the kitchen became **newly** released by this retry, `pushPickupOrderBestEffort({ sourceOrderId: order.id, qr: qrPayload, … })`. **Why:** idempotent by `sourceOrderId`, this can refresh the cashier pickup-queue row's QR to `kitchenAlreadyReleased=true` while that row is still `PENDING`, so a later cashier claim/scan does **not** re-dispatch the kitchen ticket (prevents a double kitchen ticket). If the backend row is already claimed/settled/cancelled, do not assume payload refresh; do not force any status rollback. Skip the re-push if the kitchen did not become released. Return `{ success: kitchenReleased && slipPrint.printed, orderId, orderNumber, kitchenPrinted: kitchenReleased, customerSlipPrinted: slipPrint.printed, canRetry: !(kitchenReleased && slipPrint.printed), canRetrySlip: kitchenReleased && !slipPrint.printed, error }`.
- Wrap in try/catch mirroring `reprintSlip` (`canRetry:true` on throw).
- Add `resolveKitchenSelfOrderRetryAction` to the `../../shared/kitchen-self-order` import.

In the **submit** handler's `catch` (currently `return { success: false, error: … }`), change to:
```ts
} catch (e: any) {
  logger.error(`[PosModule] Kitchen self-order submit failed: ${e?.message || e}`);
  return { success: false, orderId: created?.id, orderNumber: created?.order_number, canRetry: !!created?.id, error: e?.message || String(e) };
}
```
(Hoist `let created` above the `try` or capture it so the catch can read it; if `created` is undefined the renderer simply allows a safe re-submit.)

In `preload-kitchen-self-order.ts`, add inside `kitchenSelfOrder`:
```ts
    retryPrint: (orderId: string) => ipcRenderer.invoke('kitchen-self-order:retryPrint', orderId),
```

- [ ] **Step 4: Run static test + typecheck** — `npx vitest run tests/kitchen-self-order.test.ts` → PASS; `npx tsc -p tsconfig.main.json --noEmit` → 0.

- [ ] **Step 5: Commit**
```bash
git add src/main/modules/pos.module.ts src/preload/preload-kitchen-self-order.ts tests/kitchen-self-order.test.ts
git commit -m "feat(kitchen-self-order): retryPrint IPC re-prints existing order (no duplicate) + submit catch returns orderId"
```

### Task 3: Renderer — symmetric retry + start-over escape

**Files:**
- Modify: `src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx`
- Modify: `src/shared/electron.d.ts` — add `retryPrint` to `kitchenSelfOrder` typing
- Modify: `tests/kitchen-self-order.test.ts` (static assertions for the renderer wiring)

- [ ] **Step 1: Write the failing static test**

Add to `tests/kitchen-self-order.test.ts`:
```ts
  it('locks a failed-but-created order to retry (no resubmit) and offers Start over', () => {
    const appSource = readSource('src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx');
    const submitStart = appSource.indexOf('const submitOrder');
    const submitEnd = appSource.indexOf('const orderLockedForRetry', submitStart);
    const submitBlock = submitStart >= 0 ? appSource.slice(submitStart, submitEnd === -1 ? undefined : submitEnd) : '';
    // Any failed order that was created is retry-locked, not just slip failures.
    expect(appSource).toContain('orderLockedForRetry');
    expect(appSource).toContain('kitchenSelfOrder?.retryPrint?.(');
    // Re-submit path must defer to retry while locked.
    expect(submitBlock).toContain('orderLockedForRetry');
    expect(submitBlock).toContain('retryPrint(');
    // Escape hatch so a stuck kiosk does not need an app restart.
    expect(appSource).toContain('onStartOver');
  });
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/kitchen-self-order.test.ts -t "Start over"` → FAIL.

- [ ] **Step 3: Implement (read the submit/review block ~L433-560 first)**
- Replace `orderLockedForSlipRetry` with `orderLockedForRetry = !!(submitResult && !submitResult.success && submitResult.orderId)`.
- Add a `retryPrint(orderId)` handler (mirror `retryCustomerSlip`) that calls `window.electronAPI?.kitchenSelfOrder?.retryPrint?.(orderId)`; on `result?.success` → `setCart([])` + `setStep('done')`; else `setCustomerError(...)` and keep locked.
- In `submitOrder`, change the early guard from `submitResult?.canRetrySlip` to `orderLockedForRetry` → call `retryPrint(submitResult!.orderId!)` and return before any `kitchenSelfOrder?.submit?.(` call. The single `retryPrint` IPC routes slip-vs-all server-side; do not require the renderer to duplicate that decision.
- `ReviewScreen`: keep `orderLocked={orderLockedForRetry}`, `submitLabel={orderLockedForRetry ? t.retry : t.placeOrder}`, and `onBack` blocked while locked. Add an `onStartOver` prop rendered only when `orderLockedForRetry`, wired to: `setSubmitResult(null); setCustomerError(null); setCart([]); setStep('menu')`.
- Add an i18n key `t.retry` / reuse `t.retrySlip` text generalized to "Retry / In lại" and `t.startOver` in the kitchen-self-order i18n table.
- Update `src/shared/electron.d.ts` kitchenSelfOrder typing with `retryPrint(orderId: string): Promise<any>`. `tests/ipc-contracts.test.ts` already reads this file; update/add an assertion there if the contract test coverage needs it.

- [ ] **Step 4: Run static test + renderer typecheck** — `npx vitest run tests/kitchen-self-order.test.ts` → PASS; `npm run typecheck:renderer` → 0.

- [ ] **Step 5: Commit**
```bash
git add src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx src/shared/electron.d.ts tests/kitchen-self-order.test.ts
git commit -m "feat(kitchen-self-order): symmetric print retry + Start over escape (no app restart, no duplicate)"
```

### Task 4: Full verification

- [ ] **Step 1: Full suite vs baseline**
Run: `npx vitest run 2>&1 | Tee-Object "$env:TEMP\pos-zira-phase2a-after.txt"`
Expected: failing test files are a subset of the Task 0 baseline — **no new failures**. (Do not commit the temp file.)

- [ ] **Step 2: Typechecks** — `npm run typecheck:renderer` and `npx tsc -p tsconfig.main.json --noEmit` → 0.

- [ ] **Step 3: Manual smoke on `salon-test-kuchnia` (record results)**
- Printer offline → submit → **Retry** button shown (not generic dead-end); order number **unchanged** on retry; **no duplicate** order created.
- Re-enable printer → press Retry → kitchen ticket + slip print; kiosk goes to **done**.
- Printer stays down → **Start over** resets the kiosk to menu; if the failed submit reached pickup push, the created order is visible to the cashier in the pickup queue. If the failure threw before pickup push, confirm the order remains recoverable via retry/local lookup and does not get duplicated.
- Slip-only failure (kitchen ok) → Retry re-prints **only** the slip (no second kitchen ticket).

- [ ] **Step 4: Record verification summary in the handoff/PR message only. Do not commit temp logs or a one-off verification note unless an existing project doc intentionally needs updating.**

## 5. Self-review (coverage)
- §1.1 kitchen-fail no retry → Task 1 (resolver) + Task 2 (`reprint_all`) + Task 3 (lock+retry button).
- §1.2 resubmit duplicate → Task 3 (lock defers to retry, no `submit`).
- §1.3 throw loses orderId → Task 2 (submit catch returns `orderId`).
- §3 start-over escape → Task 3.
- No-duplicate / idempotent pickup push → Task 2 (`pushPickupOrderBestEffort` is idempotent by `sourceOrderId`; QR refresh is only guaranteed while backend row is still `PENDING`).
- Phase 2b (UX redesign) intentionally NOT here.
