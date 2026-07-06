# POS durability gaps fix plan - 2026-07-06

Scope: fix the confirmed POS source gaps on WinPC after repo cleanup, while keeping the app version at `1.0.20`. Do not build, package, install, deploy, restart the live counter app, or bump `package.json` / `package-lock.json` in this task.

Current verified source state:

- Repo: `C:\Users\pc\POS-zira`
- Branch: `main`
- Head: `206d0c8637ab2cdde95d1692d715dd4df532f829`
- Remote: `origin/main` at the same commit
- Worktree baseline: clean
- Runtime/install currently remains `1.0.20`; Paul will build and reinstall manually after code fixes.

## Goals

1. Make salon switching restore fail-closed when a target salon archive exists but cannot be staged.
2. Stop closed-shift sync from retrying forever; add terminal state and retry cap.
3. Add an additive split-refund tender allocation contract without breaking old backend payloads.
4. Make inbound `applyOrder` status handling consistent with full order mirror behavior.
5. Add focused regression tests for each changed behavior.

## Non-goals

- No app version bump; keep `1.0.20`.
- No installer build, release artifact, or live app restart.
- No backend deployment in this task.
- No destructive local DB, archive, or runtime data changes.

## Phase 1 - Salon restore must fail closed

Files to inspect/edit:

- `src/main/modules/auth.module.ts`
- Existing backup tests in `tests/database-backup-service.test.ts`
- Add a focused auth/salon-switch regression test if no suitable test harness exists.

Required behavior:

- `archiveSalon(oldSalonId)` must still be required before leaving the current salon.
- If `backup.hasSalonArchive(newSalonId)` is false, first-time fresh start remains allowed.
- If `backup.hasSalonArchive(newSalonId)` is true and `stageSalonRestore(newSalonId)` fails, return `{ ok: false, willRestart: false, error }`.
- In that failure path, do not call `database.clearSalonData()` and do not persist the new session.
- Error text should tell the operator that the target salon archive exists but cannot be restored/staged.

Regression tests:

- Target archive missing -> fresh start path still clears and returns ok.
- Leaving salon archive fails -> abort, no clear.
- Target archive exists + staging succeeds -> ok + restart.
- Target archive exists + staging fails -> abort, no clear, no restart.

Acceptance check:

- No path with an existing target archive may fall through to `database.clearSalonData()` after staging failure.

## Phase 2 - Shift close retry terminal state

Files to inspect/edit:

- `src/main/pos/shift-controller.ts`
- `src/main/database/migrations.ts`
- `tests/shift-controller.test.ts`

Preferred data model:

- Add close-specific state columns so open-sync and close-sync are not overloaded into one `synced` flag:
  - `close_synced INTEGER DEFAULT 0`
  - `close_sync_attempts INTEGER DEFAULT 0`
  - `close_sync_error TEXT`
- Migration must be additive and idempotent for existing local SQLite DBs.

Retry query should select only closed shifts needing close sync:

- `backend_id IS NOT NULL`
- `closed_at IS NOT NULL`
- `closing_cash IS NOT NULL`
- `COALESCE(close_synced, 0) = 0`
- `COALESCE(close_sync_attempts, 0) < MAX_ATTEMPTS`

Required behavior:

- On successful `apiClient.closePosShift`, set `close_synced = 1`, clear `close_sync_error`, and mark dirty.
- On transient failure, increment `close_sync_attempts`, store a bounded error message, and retry later.
- On known terminal response such as 404/not found/already closed, mark `close_synced = -1` or another explicit terminal value, store the reason, and stop retrying.
- On retry exhaustion, mark `close_synced = -1`, store `Max retry exceeded`, and stop retrying.
- Keep existing shift-open retry behavior intact.

Regression tests:

- Retries one unsynced close and marks success.
- Transient failure increments close attempts and remains retryable.
- 404/not-found marks terminal and does not keep retrying.
- Max attempts marks terminal and does not call the backend again.
- Existing open retry tests still pass.

Acceptance check:

- No query may reselect every closed shift forever after a successful close or terminal close failure.

## Phase 3 - Split refund tender allocation

Files to inspect/edit:

- `src/main/pos/refund-backend-payload.ts`
- `src/main/modules/pos.module.ts`
- `src/main/events/pos-event-emitter.ts`
- Tests for refund payload/event behavior; add one if missing.

Contract shape:

```ts
type RefundTenderAllocation = {
  method: 'CASH' | 'CARD' | 'BLIK' | 'BANK_TRANSFER' | 'TRANSFER' | 'INVOICE' | 'OTHER';
  amount: number; // IPC minor units/grosze
};

interface RefundIpcPayload {
  tenderAllocations?: RefundTenderAllocation[];
}
```

Backend payload should include an additive field, for example:

```json
{
  "tenderAllocations": [
    { "method": "CASH", "amount": 10.00 },
    { "method": "CARD", "amount": 5.00 }
  ]
}
```

Required behavior:

- Do not remove or rename existing `amount`, `lines`, or `manualAdjustmentAmount` fields.
- Full refund should allocate by original `payment_tenders` when present.
- Partial refund should allocate proportionally by original tender amounts unless a stricter UI/backend contract is chosen before implementation.
- Rounding must preserve the exact requested refund amount in grosze.
- If no split tender data exists, keep the old behavior and omit `tenderAllocations`.
- POS event `RefundIssued` may remain single-method only if backend contract is not ready, but the chosen limitation must be documented in the test or code comment.

Regression tests:

- Single tender refund omits or sends one allocation consistently.
- Split full refund sends exact original tender split.
- Split partial refund allocates proportionally and totals exactly to refund amount.
- Existing backend payload tests still pass with no tender field.

Acceptance check:

- Payload contains enough information for backend cash/card/BLIK refund accounting without breaking old backend consumers.

## Phase 4 - `applyOrder` local status consistency

Files to inspect/edit:

- `src/main/sync/entity-applicators.ts`
- `src/main/sync/pos-order-adapter.ts`
- `tests/apply-order-refund.test.ts` or a new focused apply-order status test.

Required behavior:

- Incremental order apply should normalize statuses with the same rules as full mirror where safe:
  - `REFUNDED`, `PARTIAL_REFUND`, `CANCELLED` update local `orders.status`.
  - `refundAmount > 0` derives `PARTIAL_REFUND` / `REFUNDED` based on total.
  - `DELIVERED` from server maps to local `COMPLETED` where this matches `adaptServerOrder`.
- Avoid overwriting local draft/unpaid workflow states unless the server payload is clearly a settled/terminal state.
- Continue writing `server_status` and `server_updated_at` for audit/debug.

Regression tests:

