# Product Workspace Gate Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the release-blocking concurrency, idempotency, lot-receiving, alias, and image races found in the Native Product Workspace review, then publish only the reviewed scope to `main`.

**Architecture:** Keep optimistic-concurrency baselines immutable for the lifetime of a POS edit session; make backend canonical revisions cover both variant and template; make mutation keys bind to normalized request payloads; stage images until the canonical transaction owns them. Fail closed for local aliases and unsupported legacy receive flows.

**Tech Stack:** Electron, React, TypeScript, Vitest, NestJS, TypeORM, PostgreSQL, Jest.

**Status (2026-07-14):** Tasks 1-5 and the review/verification gates are complete. POS verification passed 228 files / 1,953 tests plus production build. Backend verification passed 6 suites / 142 tests plus typecheck and production build in an isolated worktree.

---

### Task 1: Freeze the POS edit baseline and navigation lifecycle

**Files:**
- Modify: `src/renderer/components/products/ProductEditForm.tsx`
- Modify: `src/renderer/components/products/ProductEditView.tsx`
- Test: `tests/product-edit-concurrency.test.ts`

- [x] **Step 1: Write failing behavioral tests**

Add tests around an exported edit-baseline helper used by the form:

```ts
expect(createProductEditBaseline(productAtT1).expectedUpdatedAt).toBe('T1');
expect(createProductEditBaseline(productAtT1).product.in_stock).toBe(10);
expect(reconcileProductEditBaseline(baselineAtT1, productAtT2, true)).toEqual({
  baseline: baselineAtT1,
  conflict: true,
});
```

Also assert that Cancel and Back are disabled while the form reports `busy`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/product-edit-concurrency.test.ts`

Expected: FAIL because the session baseline/reconciliation behavior does not exist and busy is not propagated.

- [x] **Step 3: Implement the minimal fix**

Use one immutable baseline object for dirty comparisons and `expectedUpdatedAt`. A same-ID server refresh must never advance the token underneath stale form state. Propagate `onBusyChange` to the view and disable Cancel/Back during an in-flight mutation.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run tests/product-edit-concurrency.test.ts`

Expected: PASS.

### Task 2: Close POS inventory and alias bypasses

**Files:**
- Modify: `src/renderer/components/products/StockAdjustmentDialog.tsx`
- Modify: `src/renderer/components/products/ProductEditView.tsx`
- Modify: `src/renderer/components/products/ProductModule.tsx`
- Modify: `src/main/database/repos/local-variant-imports-repo.ts`
- Modify: `src/main/modules/pos.module.ts`
- Modify: `src/main/sync/product-sync.ts`
- Test: `tests/product-workspace-behavior.test.ts`
- Test: `tests/product-import-alias-retarget.test.ts`

- [x] **Step 1: Write failing tests**

Test these exact contracts:

```ts
expect(stockAdjustmentModes({ allowReceive: false }).map((m) => m.value)).not.toContain('receive');
expect(repo.getAdminMutationBlockedVariantIds()).toContain(syncedLocalAliasId);
expect(buildLocalImportMutationKey(payloadA)).toBe(buildLocalImportMutationKey(payloadA));
expect(buildLocalImportMutationKey(payloadA)).not.toBe(buildLocalImportMutationKey(payloadB));
```

- [x] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/product-workspace-behavior.test.ts tests/product-import-alias-retarget.test.ts`

Expected: FAIL on legacy receive, SYNCED alias, and payload-bound key assertions.

- [x] **Step 3: Implement the minimal fix**

Hide legacy `receive` when lot receiving is supported, block all local alias rows from product-admin mutation, and derive the scan-create key from a stable normalized payload fingerprint so the same intent reuses a key while an edited intent cannot reuse it.

- [x] **Step 4: Verify GREEN**

Run the focused tests again; expected PASS.

### Task 3: Fix camera lifetime and IPC hardening

**Files:**
- Modify: `src/renderer/components/pos/camera-stream.ts`
- Modify: `src/renderer/i18n/translations.ts`
- Modify: `src/main/pos/product-workspace-input.ts`
- Modify: `src/main/modules/pos.module.ts`
- Test: `tests/camera-stream.test.ts`
- Test: `tests/product-workspace-input.test.ts`
- Test: `tests/product-workspace-infrastructure.test.ts`

- [x] **Step 1: Write failing tests**

Use two deferred `getUserMedia` promises to prove a canceled request cannot clear or leak the newer live stream. Assert booleans/arrays are rejected for numeric receipt fields, error details are redacted, and `products.import.pendingHint` exists for all locales.

- [x] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/camera-stream.test.ts tests/product-workspace-input.test.ts tests/product-workspace-infrastructure.test.ts`

Expected: FAIL on generation ownership, runtime type validation, redaction, and i18n.

- [x] **Step 3: Implement the minimal fix**

Guard shared camera state with a generation token and stop superseded streams; require `typeof value === 'number'` before numeric validation; redact `error.details` through the same purchase-data scrubber; add all three translations.

- [x] **Step 4: Verify GREEN**

Run the focused tests again; expected PASS.

### Task 4: Make backend OCC and create idempotency complete

**Files on `/var/www/www/enail/backend`:**
- Modify: `src/modules/product-admin/services/product-admin.service.ts`
- Modify: `src/modules/product-admin/dto/product-admin.dto.ts`
- Modify: the product-admin create-request entity and its migration if no reusable persisted metadata column exists
- Test: `src/modules/product-admin/__tests__/product-workspace.service.spec.ts`

- [x] **Step 1: Write failing Jest tests**

Cover a template revision newer than the variant revision and a same-key/different-payload create retry:

```ts
expect(mapVariant({ updatedAt: T1, template: { updatedAt: T2 } }).updatedAt).toBe(T2.toISOString());
await expect(createProduct(salon, changedDto, user, sameKey)).rejects.toMatchObject({
  response: expect.objectContaining({ error: 'IDEMPOTENCY_CONFLICT' }),
});
```

- [x] **Step 2: Run the suite and verify RED**

Run the scoped product-admin Jest suite. Expected: FAIL for incomplete canonical revision and missing create fingerprint.

- [x] **Step 3: Implement the minimal fix**

Lock the template explicitly, compare and return a canonical max(template, variant) revision, persist a SHA-256 fingerprint of the normalized create payload, and reject a key reused with a different fingerprint before replay/resume.

- [x] **Step 4: Verify GREEN**

Run the scoped Jest suite again; expected PASS.

### Task 5: Stage backend images until canonical ownership is established

**Files on `/var/www/www/enail/backend`:**
- Modify: `src/modules/product-admin/services/product-admin.service.ts`
- Modify: product-image persistence only if required for an atomic uniqueness guard
- Test: `src/modules/product-admin/__tests__/product-workspace.service.spec.ts`

- [x] **Step 1: Write failing tests**

Cover a concurrent canonical revision change, two overlapping same-hash uploads, and canonical-transaction failure. Expected behavior: conflict without overwriting the newer image, at most one managed row, and no failed upload left primary.

- [x] **Step 2: Run and verify RED**

Run the focused Jest file; expected FAIL for current pre-transaction primary promotion and non-atomic duplicate handling.

- [x] **Step 3: Implement the minimal fix**

Upload as non-primary, serialize identical variant/hash work, compare the canonical combined revision inside the locked transaction, promote only inside that transaction, and delete only a newly-created staged row on failure.

- [x] **Step 4: Verify GREEN**

Run the focused Jest file again; expected PASS.

### Task 6: Integrate, verify, commit, and publish

**Files:** Only files listed above plus this plan and tests directly proving the fixes.

- [x] **Step 1: Review both diffs**

Confirm every changed line maps to a gate finding and no unrelated dirty backend file is staged.

- [x] **Step 2: Run full verification**

Run POS full Vitest, POS main/renderer typechecks and build; run backend scoped Jest, backend typecheck/build, and `git diff --check` in both repositories.

- [ ] **Step 3: Create scoped commits**

Use small conventional commits: POS concurrency/inventory, POS camera/hardening, backend OCC/idempotency, backend image atomicity.

- [ ] **Step 4: Update and push `main` safely**

Fetch origin, require a fast-forward integration, push only verified commits to `main`, and stop instead of force-pushing if the remote moved incompatibly.
