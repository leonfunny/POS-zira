# POS2 -> POS1 Safe Print Retry -- Backend Contract (AS BUILT)

Date: 2026-06-29
Status: **DEPLOYED to Contabo production 2026-06-29.** Backend live (50/50 unit
tests green, tsc clean); migration `2124100000000` applied (last_retry_* columns
present); health 200 via api.enail.pro; guarded-retry routes wired
(`/agent/jobs/:jobId/safe-retry` returns 401 without key). Run your capability
check + the staging smoke test (section 8) before enabling POS2 auto-retry.
Backend repo: eNail `backend/`, branch `feat/product-admin-create-product`
(commits `cda7130b` + `f656b436`), shipped to Contabo dist + source.
Answers request: `server-change-requests/2026-06-29-safe-print-retry-backend-contract.md`
Client plan: `POS2_TO_POS1_SAFE_PRINT_RETRY_PLAN_2026-06-29.md`

> Audience: the POS-zira app worker. This describes EXACTLY what the backend now
> does, so the client can be coded to fit. Where the implemented behavior has a
> nuance vs the original request, it is called out as **NUANCE**.

---

## 0. TL;DR for the client

1. Send a stable `idempotencyKey` on every shared POS2->POS1 create-job call
   (body field `idempotencyKey`, or header `Idempotency-Key`). Backend dedupes
   and never emits a duplicate fiscal command for the same key.
2. POS1 should add `failureClass` to its `job:status` socket emits. Without it,
   a `FAILED` job is treated as `FINAL` = **not** auto-retryable (safe default).
3. To retry, call `POST /agent/jobs/:jobId/safe-retry` (API key) or
   `POST /jobs/:jobId/safe-retry` (staff JWT). Backend retries **only**
   `FAILED + SAFE_BEFORE_PRINT` under a 3-attempt cap; everything else is
   refused with `retryAllowed:false` + `retryBlockedReason`.
4. The retry endpoint does **NOT** throw on a blocked retry -- it returns HTTP
   200 with `retryAllowed:false`. **Decide on `retryAllowed`/`sent`, not on HTTP
   status.**
5. A blocking-create `TIMEOUT` is ambiguous: `retryAllowed:false`. Reconcile via
   `GET /agent/jobs/:jobId`, never auto-retry a TIMEOUT.

---

## 1. Print Job Idempotency  (request section 1 -- IMPLEMENTED)

Applies to both create endpoints:

- `POST /api/v1/print-agent/jobs`            (staff JWT)
- `POST /api/v1/print-agent/agent/jobs`      (print-agent API key headers)

### How to send the key
- Body field: `"idempotencyKey": "..."`, **or**
- HTTP header: `Idempotency-Key: ...`
- **NUANCE -- body wins.** If both are present, the body field is used; the
  header is only a fallback when the body omits it. Pick one; don't send
  conflicting values.

### Dedupe behavior
- Backend stores the key + a server-computed `payloadHash`
  (`sha256:<64-hex>`).
- **Same key + equivalent job** -> returns the EXISTING job. No second row, and
  **no second socket emit** (see re-emit guard below). `sent` will be `false`
  for the duplicate call if the job was already dispatched.
- **Same key + different job** -> **HTTP 409** (`ConflictException`,
  "same idempotencyKey was already used with a different print job"). No job
  emitted.
- **NUANCE -- uniqueness scope is `(salon_id, idempotency_key)`** (a partial
  unique index), not `(salon, printer, key)`. On a key hit the backend also
  asserts that `jobType`, `printerType`, `printerId`, `referenceType`,
  `referenceId`, and `payloadHash` match; any mismatch -> 409. **Therefore your
  key MUST be unique per (printer/machine + order + purpose).** The suggested
  keys already encode `machineId`, which is correct:
  - Fiscal:        `pos-fiscal:{machineId}:{orderId}:default:v1`
  - Order copy:    `pos-receipt:{machineId}:{orderId}:order:v1`
  - Manual reprint: use a FRESH key (e.g. add `:reprint:{ts}`), so the cashier
    deliberately prints a new copy instead of hitting the dedupe.

### `payloadHash` -- client does NOT send it for these endpoints
The backend computes the hash itself from the create DTO over the canonical
JSON of `{jobType, printerType, printerId, referenceType, referenceId,
openDrawer, payload}` (object keys sorted, `undefined` dropped). You only send
`idempotencyKey`. (The separate LAN-first kitchen reserve endpoint is the only
place a client sends `payloadHash`; that is a different flow and out of scope
here.)

### Re-emit guard (the fiscal safety core)
`createJobForSalon` emits the `job:new` socket event **only when the returned
job is `PENDING`**. Any duplicate create that returns a job already in `SENT`,
`PRINTING`, `COMPLETED`, `FAILED`, `RESERVED`, or `CANCELLED` -> `sent:false`,
**no second socket emit**. This is what guarantees a fiscal command is never
re-sent on a duplicate create. (`UNKNOWN`/`FINAL`/`UNCERTAIN_AFTER_PRINT` from
the request map to a `FAILED` row with a `failureClass`; `FAILED != PENDING`,
so no emit.)

---

## 2. Final Failure Classification  (request section 2 -- IMPLEMENTED)

### POS1 -> backend: `job:status` socket
The socket `job:status` payload now accepts an optional `failureClass`:
```json
{
  "jobId": "uuid",
  "status": "FAILED",
  "errorMessage": "Printer FISCAL not connected",
  "failureClass": "SAFE_BEFORE_PRINT"
}
```
Allowed `failureClass` values (the ONLY three):
- `SAFE_BEFORE_PRINT`     -- failed before any device command could have gone out
- `UNCERTAIN_AFTER_PRINT` -- may have reached the printer/ELZAB; do NOT retry
- `FINAL`                 -- definitively failed, not retryable

Persistence rules the backend applies on `job:status`:
- `status=COMPLETED`  -> `failureClass` cleared to `null`.
- `status=FAILED` with **no** `failureClass` -> stored as **`FINAL`**
  (legacy/old clients are therefore **not auto-retryable** -- safe default).
- `status=FAILED` with a `failureClass` -> stored as given.
- Backend forwards `failureClass` on the `job:updated` dashboard broadcast too.

**Client action:** POS1's normal status emitter (today it sends only
`jobId/status/errorMessage`) should start sending `failureClass` for the shared
POS2->POS1 jobs, classified by where the failure happened in POS1's print loop.

### Backend -> client: every status-bearing response includes
```ts
{
  jobId: string;
  status: string;          // see section 5 vocabulary
  sent: boolean;
  failureClass: 'SAFE_BEFORE_PRINT' | 'UNCERTAIN_AFTER_PRINT' | 'FINAL' | null;
  errorMessage: string | null;
  timedOut: boolean;
  retryAllowed: boolean;
  retryBlockedReason: string | null;
}
```
This object is returned by: blocking create, non-blocking create, both GET
status endpoints, and both retry endpoints (see section 3, section 4). Create/retry responses
also keep legacy fields (`job{}`, `id`, `printerId`) as a superset for
backward-compat -- additive, nothing removed.

---

## 3. Guarded Retry  (request section 3 -- IMPLEMENTED)

### Endpoints (all three run identical guarded logic)
- `POST /api/v1/print-agent/jobs/:jobId/retry`        (staff JWT) -- **hardened**
- `POST /api/v1/print-agent/jobs/:jobId/safe-retry`   (staff JWT) -- alias
- `POST /api/v1/print-agent/agent/jobs/:jobId/safe-retry`
  (print-agent API key headers: `x-print-agent-api-key`,
  `x-print-agent-machine-id`) -- **use this from POS2**

Optional body: `{ "reason": "POS2 auto-retry #1" }` (recorded for audit).

### Allowed vs refused
- **Allowed only:** `status === FAILED` AND
  `failureClass === SAFE_BEFORE_PRINT` AND `retryCount < 3`.
- **Refused (no dispatch):** `COMPLETED`, `SENT`, `PRINTING`, `PENDING`,
  `RESERVED`, `CANCELLED`; `FAILED + UNCERTAIN_AFTER_PRINT`; `FAILED + FINAL`;
  `FAILED + null` (unknown class); and `retryCount >= 3` (max attempts).

### Response (HTTP 200 in all allowed/refused cases)
```ts
{
  job: { id, jobType, status, agentId, printerId, createdAt },
  id: string, jobId: string,        // both = job id
  status: string,                    // PENDING/SENT after a successful retry; unchanged if blocked
  printerId: string | null,
  sent: boolean,                     // true only if THIS call re-dispatched
  failureClass: string | null,
  retryAllowed: boolean,             // true = retry was performed; false = blocked
  retryBlockedReason: string | null  // human reason when blocked
}
```
- **IMPORTANT -- blocked retries do NOT throw.** A refused retry returns HTTP
  200 with `retryAllowed:false`, `sent:false`, and `retryBlockedReason`.
  Branch on `retryAllowed`/`sent`, not on HTTP error codes.
- **Errors that DO throw:** `404` if the job id does not exist; `403` if the job
  belongs to another salon.

### Atomicity / concurrency (the section 3 "no double emit" guarantee)
- The `FAILED -> PENDING` flip is a single compare-and-set SQL UPDATE scoped by
  `(id, salon_id, status=FAILED, failure_class=SAFE_BEFORE_PRINT)`.
- Two concurrent safe-retries race on the row: **exactly one** gets
  `affected=1`, becomes `retryAllowed:true`/`sent:true` and emits one
  `job:new`. The loser gets `affected=0` -> `retryAllowed:false`,
  `sent:false`, no emit. **At most one socket job, ever.** (Covered by a unit
  test.)

### Routing & audit
- Retry **targets the original owner agent/printer** -- `agentId`/`printerId` are
  never changed by retry. Re-routing to a different POS requires a **new explicit
  print with a fresh idempotency key**, not a retry.
- On success the backend re-emits `job:new` to the original owner agent and
  marks the job `SENT`. If that agent is offline, `sent:false` and the job stays
  `PENDING` (it is delivered when the agent reconnects via its pending-jobs
  pull).
- Persisted audit: `retryCount` (incremented), `lastRetryReason` (your `reason`),
  `lastRetryBy` (staff `userId`, or `machineId` on the API-key endpoint),
  `lastRetryAt` (timestamp).
- Server cap: **`MAX_RETRIES = 3`** (constant `PrintJobService.MAX_RETRIES`).
  This is the backend hard cap; it is independent of, and complementary to, the
  client's own `maxAutoRetries = 3` UX schedule.

---

## 4. Job Status Lookup  (request section 4 -- IMPLEMENTED)

- `GET /api/v1/print-agent/jobs/:jobId`        (staff JWT)
- `GET /api/v1/print-agent/agent/jobs/:jobId`  (API key headers) -- **use from POS2**

Returns the full section 2 status object PLUS legacy descriptive fields, i.e.:
```ts
{
  // legacy/descriptive
  id, jobType, referenceType, referenceId, createdAt, completedAt,
  // status contract
  jobId, status, sent (false here), failureClass, errorMessage,
  timedOut (false here), retryAllowed, retryBlockedReason
}
```
- Salon-scoped: `403` if the job is not in the API key's / user's salon, `404`
  if unknown.
- `retryAllowed`/`retryBlockedReason` here are the live verdict for the job's
  current persisted state -- use this to drive the manual "Retry / Reconcile" UI
  after a TIMEOUT.

---

## 5. Status vocabulary the backend actually uses

Persisted `PrintJobStatus`:
`RESERVED`, `PENDING`, `SENT`, `PRINTING`, `COMPLETED`, `FAILED`, `CANCELLED`.

Response-only pseudo-status:
- `"TIMEOUT"` -- returned **only** by a blocking create that timed out (see section 6).
  The DB row is NOT changed; it remains in flight (`SENT`/`PRINTING`/`PENDING`).

**NUANCE -- the backend never returns these client-side states:** `UNKNOWN`,
`UNKNOWN_NEEDS_RECONCILIATION`, `APP_RESTART_AFTER_SENT`,
`FISCAL_ATTEMPT_RETRY_BLOCKED`. Those live in POS-zira only. The backend
expresses "not safe to retry" uniformly via `retryAllowed:false` +
`retryBlockedReason`. Map your richer client states onto the backend's
(`status`, `failureClass`, `retryAllowed`) triple.

---

## 6. Timeout Semantics  (request section 5 -- IMPLEMENTED)

Blocking create: send `waitForCompletion: true` and optional `timeoutMs`
(clamped to `[1000, 60000]`, default `20000`).

- On terminal before timeout: returns the real `status`
  (`COMPLETED`/`FAILED`) + `failureClass` + `retryAllowed`.
- On timeout after the job exists:
  - `status: "TIMEOUT"`, `timedOut: true`, the `jobId` is returned.
  - The job row is **left in flight** (never auto-marked) so a late
    `COMPLETED`/`FAILED` from POS1 still wins.
  - `retryAllowed: false`, `retryBlockedReason: "job still in flight (timed out
    waiting)"`. **Never auto-retry a TIMEOUT** -- reconcile via section 4 or the
    `job:updated` socket event.
- HTTP-level timeout: re-issuing the same create with the **same idempotency
  key** returns the existing job if the first request reached the backend (no
  duplicate, no second emit).

Guidance from the client plan still holds: shared receipt/order-copy waits
should use a short cap (~8-10s) because POS1 already runs its own 3-attempt
printer loop with 2s gaps; fiscal may legitimately wait up to 60s.

---

## 7. Acceptance tests (all implemented & green in backend unit suite)

`backend/test/unit/print-agent-routing-foundation.spec.ts` (50/50 pass):
- Duplicate fiscal create, same key + same payload -> one job, one emit.
- Duplicate fiscal create, same key + different payload -> `409`, no emit.
- `FAILED + SAFE_BEFORE_PRINT` -> retried via guarded endpoint.
- `FAILED + UNCERTAIN_AFTER_PRINT` -> refused.
- `FINAL`, unknown(null) class, `SENT`, `PRINTING`, `COMPLETED`, `PENDING`,
  `RESERVED`, `CANCELLED`, max-attempts -> all refused, never re-dispatch.
- Two concurrent safe-retries -> at most one socket job.
- Non-fiscal receipt/order-copy/kitchen create still works (no regression).
- Legacy `job:status` without `failureClass` still works; defaults to
  not-auto-retryable (`FINAL`).
- `Idempotency-Key` header merges into create when body omits it; body wins
  when both set.

---

## 8. Deploy + client rollout status (DEPLOYED 2026-06-29)

The client plan's gates S1-S4 require the contract **deployed and verified** --
this is now DONE on Contabo production:

1. Backend committed + pushed (`feat/product-admin-create-product`,
   `cda7130b` + `f656b436`); unit tests 50/50 green; `tsc --noEmit` clean.
   **Deployed to Contabo** (dist + source shipped).
2. **DB migration applied:** `2124100000000-AddPrintJobRetryMetadata` ran on the
   live Contabo DB; `print_jobs.last_retry_reason/last_retry_at/last_retry_by`
   confirmed present. Prerequisites (`2123500000000-AddLanFirstKitchenPrintJobs`
   with idempotency_key/payload_hash/dispatch_mode/failure_class + unique index,
   and `CreateFiscalReceipts`/backfill/fix) were ALREADY applied on Contabo.
3. Verified: api.enail.pro health 200, login 401, `enail-backend` online with 0
   unstable restarts, `safeRetryJob` + `safe-retry` routes live in running dist.

### Capability detection (no dedicated endpoint was added)
Detect the deployed contract by either:
- Config flag flipped after the owner confirms deploy, OR
- Probe `GET /agent/jobs/:jobId` and check the response contains the
  `retryAllowed` field (absent on the old backend), OR
- `POST /agent/jobs/:jobId/safe-retry` returns 200/200-blocked rather than 404.

### Staging smoke test before enabling (plan gate)
- Duplicate create with same key emits one fiscal job.
- Two concurrent `safe-retry` calls emit at most one job.
- A `TIMEOUT` create is never auto-retried.

---

## 9. Backend files (reference, eNail repo)

- `modules/print-agent/entities/print-job.entity.ts` -- `failureClass`,
  `dispatchMode`, idempotency fields, `lastRetry*` audit, `RESERVED` status,
  unique index.
- `modules/print-agent/services/print-job.service.ts` -- `createPrintJob`
  (idempotency + 409), `updateJobStatus` (failureClass), `computeRetryability`,
  `safeRetryJob` (atomic CAS), `toJobStatusResponse`, `MAX_RETRIES=3`.
- `modules/print-agent/controllers/print-agent.controller.ts` -- create
  (+`Idempotency-Key` header), GET status (staff + API key), `/retry`,
  `/safe-retry`, `/agent/jobs/:jobId/safe-retry`, blocking/TIMEOUT response.
- `modules/print-agent/gateways/print-agent.gateway.ts` -- `job:status` accepts
  `failureClass`; `job:updated` broadcasts it; `sendPrintJob` routes by owner
  `agentId`.
- `modules/print-agent/dto/print-job.dto.ts` -- `idempotencyKey`,
  `failureClass`, `RetryPrintJobDto`.
- `migrations/2124100000000-AddPrintJobRetryMetadata.ts`.
