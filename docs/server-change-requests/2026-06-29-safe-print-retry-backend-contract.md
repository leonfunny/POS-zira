# Server Change Request: Safe Print Retry Contract

Date: 2026-06-29
Client repo: POS-zira Electron print agent
Requested by: codex, after review of POS2 -> POS1 safe print retry plan
Client plan: `docs/POS2_TO_POS1_SAFE_PRINT_RETRY_PLAN_2026-06-29.md`

## Summary

POS2 can only auto retry shared receipt/fiscal printing safely if the backend
provides hard idempotency, final failure classification, and guarded retry. The
client must not retry fiscal create-job timeouts or broad failed jobs by itself,
because a duplicate fiscal command may print twice.

## Required Backend Contract

### 1. Print Job Idempotency

For `POST /api/v1/print-agent/jobs` and the print-agent API-key equivalent:

- Accept a stable idempotency key for shared POS print jobs. Accepting both
  body field `idempotencyKey` and header `Idempotency-Key` is preferred.
- Store a payload hash with the idempotency key.
- For the same salon/printer/idempotency key and same payload hash, return the
  existing job instead of creating or emitting another job.
- For the same key with a different payload hash, return `409` and do not emit
  a job.
- For fiscal jobs, never emit a second socket job for an existing
  `SENT`, `PRINTING`, `COMPLETED`, `UNKNOWN`, `FINAL`, or
  `UNCERTAIN_AFTER_PRINT` outcome.

Suggested fiscal key:

```text
pos-fiscal:{machineId}:{orderId}:default:v1
```

Suggested initial order-copy key:

```text
pos-receipt:{machineId}:{orderId}:order:v1
```

Manual reprints should use a fresh key so the cashier can intentionally print a
new copy.

### 2. Final Failure Classification

Persist optional `failureClass` from normal `job:status` socket updates:

```json
{
  "jobId": "job-id",
  "status": "FAILED",
  "errorMessage": "Printer FISCAL not connected",
  "failureClass": "SAFE_BEFORE_PRINT"
}
```

Allowed values:

- `SAFE_BEFORE_PRINT`
- `UNCERTAIN_AFTER_PRINT`
- `FINAL`

Waiting create-job responses and job-status responses must return:

```ts
{
  jobId: string;
  status: string;
  sent?: boolean;
  failureClass?: 'SAFE_BEFORE_PRINT' | 'UNCERTAIN_AFTER_PRINT' | 'FINAL' | null;
  errorMessage?: string | null;
  timedOut?: boolean;
  retryAllowed?: boolean;
  retryBlockedReason?: string | null;
}
```

If the current state is `SENT` or `PRINTING` and no final failure class exists,
the client will treat the job as in-flight/ambiguous and will not auto retry.

### 3. Guarded Retry Endpoint

Either harden the existing endpoint:

```http
POST /api/v1/print-agent/jobs/:jobId/retry
```

or add a dedicated safe endpoint:

```http
POST /api/v1/print-agent/jobs/:jobId/safe-retry
```

Required behavior:

- Allow retry only when current state is `FAILED` and
  `failureClass === SAFE_BEFORE_PRINT`.
- Reject `SENT`, `PRINTING`, `COMPLETED`, `UNKNOWN`, `TIMEOUT` with in-flight
  job, `UNCERTAIN_AFTER_PRINT`, and `FINAL`.
- Use an atomic transaction/row lock or compare-and-set transition so two retry
  requests cannot emit two socket jobs.
- Enforce max retry attempts server-side.
- Persist attempt count, last retry reason, retry actor, and timestamps.
- Retry must target the original owner agent/printer. A route change requires a
  new explicit manual print, not automatic retry.

Response shape:

```ts
{
  jobId: string;
  status: string;
  sent: boolean;
  failureClass?: string | null;
  retryAllowed: boolean;
  retryBlockedReason?: string | null;
}
```

### 4. Job Status Lookup

Provide or confirm a client-usable status endpoint:

```http
GET /api/v1/print-agent/jobs/:jobId
```

The response must include final status, `failureClass`, `timedOut`, and
`retryAllowed` fields listed above.

### 5. Timeout Semantics

- If a blocking wait times out after a job exists, return the `jobId` and mark
  the result as not safe for auto retry.
- If a client request times out at HTTP level, a later repeated request with the
  same idempotency key must return the existing job if the first request reached
  the backend.
- `TIMEOUT` with a `jobId` is ambiguous for fiscal and must not be
  `retryAllowed`.

## Acceptance Tests

- Duplicate fiscal create with the same key and same payload returns one job and
  emits one socket job.
- Duplicate fiscal create with the same key and different payload returns `409`.
- Fiscal `FAILED + SAFE_BEFORE_PRINT` can be retried once through the guarded
  endpoint.
- Fiscal `FAILED + UNCERTAIN_AFTER_PRINT` cannot be retried.
- Fiscal `FINAL`, `UNKNOWN`, `SENT`, `PRINTING`, `COMPLETED`, and timed-out
  in-flight jobs cannot be retried.
- Two concurrent safe-retry calls for the same job emit at most one socket job.
- Normal receipt/order-copy idempotency does not break existing non-fiscal
  print behavior.
- Existing clients that do not send `failureClass` still work; their failures
  default to not auto-retryable.

## Client Rollout Dependency

POS-zira will keep automatic retry disabled until:

1. This backend contract is deployed.
2. POS-zira capability check/config confirms the contract is available.
3. A staging smoke test proves no duplicate fiscal job is emitted on duplicate
   create or concurrent retry.
