# Android POS state ownership and ledger specification

Status: **PROVISIONAL / NO-GO for Android business writes**

Prepared: 2026-07-17

Design checkout: `072f5f78bb6c25bf7358937df4487051db53978d`

Immutable POS evidence baseline: `f0ee58bcd1e5217a4926353f0aff1fefd122941f` (Windows Zira AI 1.0.23)

Immutable backend evidence baseline: `a3518673cfa9436389959a02a22399a28cdc0463`

The cited Windows runtime files under `src/main` and the retail cart source under `src/renderer` are unchanged between the immutable POS baseline and this design checkout. Backend claims describe only the committed tree at `a3518673`; dirty backend worktree changes are not a contract. This document specifies a target ownership model. It does not add a schema, migration, adapter, API call, feature flag, or production permission.

The companion API review is still provisional and the backend decision register remains **NO-GO** for Android order, payment, shift, print, and fiscal writes (`API_AUTH_CONTRACT_MATRIX.md`; `OPEN_BACKEND_CONTRACT_DECISIONS.md`). Consequently this specification cannot unlock GLM-A4, GLM-A5, any production database schema, or Android writes. Those gates require immutable POS/backend SHAs to remain recorded, Phase -1 to exit GO, the API contract review to exit GO, every applicable P0 to close in canonical committed backend source, and the deployed built artifact to be verified.

GLM-B2 remains eligible only as the isolated synthetic SQLite ADR/spike defined by the work-packet plan after this document receives review. B2 may compare implementations and prove fake catalog/order-journal transactions, migration recovery, corruption preservation, and backup exclusions. It cannot use real salon data, wire a backend route, approve the target production schema, or enable a business write. This avoids a circular gate: B2 supplies storage evidence required for a later production decision; it does not inherit production authorization from this provisional document.

## 1. Non-negotiable separation

Android has five durable state families. The first three are the required independent ledgers; the final two prevent shift commands and editable carts from being smuggled into an inappropriate ledger.

| Store | Owns | Must never own |
| --- | --- | --- |
| `order_upload_journal` plus immutable order snapshot/lines | One exact create-order command and its authoritative reconciliation result | Catalog changes, analytics/ERP events, shift commands, mutable carts, print/fiscal jobs |
| Catalog read model plus `local_sync_log` | Inbound catalog page/application history, opaque cursors, tombstones, snapshot completeness, read-model conflicts | Orders, payments, financial facts, shift commands, printer/fiscal actions |
| `pos_event_outbox` | Derived business/ERP/financial event envelopes delivered to the POS-event ingestion contract | The order-create command or any substitute order uploader |
| `shift_command_journal` plus local shift projection | Exact open/close commands and their authoritative replay/reconciliation results | Orders, catalog changes, generic POS events, print/fiscal jobs |
| `cart_draft` plus lines | Mutable, pre-submission cashier work | A submitted order, accepted payment fact, idempotency result, server truth |

**`pos_event_outbox` never uploads the order itself.** A `SaleCompleted` event can describe a fact for analytics/ERP projection, but it cannot create, finish, repair, reconcile, or mark an order uploaded. An acknowledged POS event never changes `order_upload_journal` to acknowledged, and an acknowledged order never implies its POS events were accepted.

The Windows baseline demonstrates why the separation is required:

- Orders and items are inserted in one local transaction, but the POS-event emitter runs afterward and is explicitly best-effort (`src/main/database/repos/order-repo.ts:201-264`). Android must not infer atomic event creation from this behavior.
- Windows order upload uses `orders.synced` as pending/in-flight/synced/shelved state and rebuilds the DTO during sync (`src/main/sync/order-sync.ts:71-85,102-165`). The create request currently has no `Idempotency-Key` header (`src/main/network/api-client.ts:2475-2497`). Android requires a separately persisted immutable command before first dispatch.
- Windows `local_sync_log` is a broad bidirectional mutation log and can contain order mutations (`src/main/sync/sync-log-repo.ts:45-163`; `src/main/database/repos/order-repo.ts:317-327,440-467`). Android's catalog `local_sync_log` in this specification is narrower; copying the Windows table name does not authorize reusing it for orders.
- Windows emits durable ERP events with stable `event_id`/`dedupe_key`, per-row acknowledgment and dead-letter state (`src/main/database/repos/pos-event-outbox-repo.ts:22-45,80-164`), but its emitter catches failures so the sale can continue (`src/main/events/pos-event-emitter.ts:99-105`). The Android transaction rules below close that gap for facts selected as mandatory.
- Windows shift rows overload sync flags and retries; open has no durable command payload, while close replay treats message/HTTP patterns as terminal (`src/main/pos/shift-controller.ts:252-349`). The backend cannot currently replay an accepted open or close command (`API_AUTH_CONTRACT_MATRIX.md` S1-S3; P0-SHIFT-1/2).
- Windows retail carts are mutable WebView `localStorage` scoped by a user/config-derived key (`src/renderer/components/pos/templates/retail/RetailTemplate.tsx:250-302`). Android carts require native durable storage and explicit tenant/session binding.

## 2. Identity, tenant binding, canonical bytes, and clocks

### 2.1 Identity hierarchy

Every durable row carries the identity tuple below as ordinary indexed columns, not only inside JSON:

1. `salon_id`: copied from the validated Staff-JWT principal at database-open time. The server remains authoritative. A slug cannot select or change it.
2. `terminal_id`: server-issued registered terminal identity. Until P0-GATE-1 defines and deploys registration, it is absent and every Android write adapter remains disabled.
3. `installation_id`: random native UUID stored in an Android no-backup location. It is correlation, not authentication, and changes after reinstall/clear-data.
4. `actor_user_id`: authenticated actor from the Staff JWT/session. A delegated cashier, if later approved, is a separate `cashier_staff_id` validated by the server; client `staffName` is display data only.
5. Stable local business IDs: UUIDv7 or ULID generated once with cryptographic randomness. Wall-clock ordering is convenient but never establishes correctness.

For the current online-only pilot posture, opening a tenant database requires a successful `/auth/me` check whose salon matches its encrypted/native binding. A cold start without network therefore stays locked and does not display even the last-good catalog. Any mismatch quarantines the database and all ledgers: no read model is displayed, no command is dispatched, and no row is rebound. Logout/revocation can close access but cannot rewrite or discard unresolved commands. Recovery requires reauthentication to the same salon or an owner-reviewed encrypted export/purge procedure. A future read-only/offline grace may expose a last-good catalog only after P1-AUTH-1 defines bounded session lifetime, tenant binding, revocation behavior, and expiry UX; deliberate offline sales additionally require P0-ORDER-1. This provisional rule is not approval of a permanent always-online storage design.

### 2.2 Canonical payload and hash

Commands and events use a versioned canonical JSON profile: UTF-8; sorted object keys; exact schema-selected fields; arrays retain business order; absent optional values are omitted; explicit `null` stays `null`; timestamps are UTC RFC 3339 with milliseconds; money is integer minor units; quantities use contract-defined decimal strings rather than binary floats. The stored `canonicalization_version` makes future changes additive.

`payload_hash = SHA-256(canonical_payload_bytes)`, lowercase hex. The canonical bytes, hash, schema version, command/event ID, idempotency key, tenant tuple, and actor become immutable in the same transaction before first network dispatch. A repeated key with a different hash is `CONFLICT_MANUAL`; code must never “fix” it by minting a fresh key.

Device time supplies display/diagnostic fields only. Server time, opaque cursors, command replay, and database uniqueness decide synchronization. Clock rollback cannot make a terminal row pending or manufacture a newer catalog cursor.

### 2.3 Stable key formats

| Family | Stable identifiers |
| --- | --- |
| Order | `local_order_id`; `order_command_id`; `client_attempt_id`; `idempotency_key = android-order:v1:<salon_id>:<terminal_id>:<order_command_id>` |
| Catalog | `sync_cycle_id`; server opaque `page_cursor`/`sync_cursor`; `source_tx` derived from server event identity or `SHA-256(salon, endpoint, cursor-in, response-hash)` |
| POS event | ULID `event_id`; deterministic `dedupe_key = <event_type>:v<schema>:<salon>:<terminal>:<fact_id>[:<ordinal>]` |
| Shift | `local_shift_id`; one `open_command_id`; one `close_command_id`; namespaced keys `android-shift-open:v1:...` and `android-shift-close:v1:...` |
| Cart | `draft_id`; monotonic local `revision`; no server idempotency key until submission creates a distinct immutable order command |

The header/body order key and `clientAttemptId` use the exact persisted values required by O1/O3. A retry reuses the same canonical bytes. `X-POS-Device-Id` remains diagnostic until registration exists and can never authorize or select a tenant.

### 2.4 Required local uniqueness invariants

Atomic transactions alone do not prevent two concurrent workers from creating separate local lineages. The eventual native schema must enforce the abstract invariants below with database UNIQUE/partial-UNIQUE constraints and foreign keys; application pre-checks are insufficient. These are design constraints for B2 race tests, not approval of production table DDL.

| Family | Required local invariant |
| --- | --- |
| Order | One journal row per `(salon_id, local_order_id)` via a one-to-one foreign key; unique `(salon_id, order_command_id)`, `(salon_id, idempotency_key)`, and `(salon_id, client_attempt_id)` |
| Catalog | Unique applied page/source event per `(salon_id, source_tx)` and unique page position `(salon_id, sync_cycle_id, page_ordinal)`; only one active cycle per salon/endpoint |
| POS event | Unique `(salon_id, event_id)` and `(salon_id, dedupe_key)`; acknowledgment/result rows reference that immutable event rather than copying it |
| Shift | Unique `(salon_id, open_command_id)` and `(salon_id, close_command_id)`; one open and one close command per local shift; a partial unique guard permits at most one unresolved open/close lineage per salon/terminal |
| Cart | Unique `(salon_id, draft_id)` with revision updated by compare-and-set; one submitted order reference per draft |

GLM-B2 must race at least two independent connections/workers against each invariant and prove one winner/one stable existing row, including after process reopen. Constraint conflicts must re-read and compare the existing immutable hash; they must never mint a replacement lineage.

## 3. Order upload journal

### 3.1 Ownership and proposed rows

The application transaction owner writes `orders`, `order_items`, and exactly one `order_upload_journal` row. Only the order uploader changes dispatch metadata. Only a validated O1/O3 response changes the authoritative result fields. A support/manager workflow owns terminal rejection resolution; it cannot edit the submitted payload.

Minimum journal fields are: identity tuple, IDs above, Staff-JWT actor snapshot, local shift ID and eventually server shift ID, canonical payload bytes/hash/version, route/method, state, attempt count, first/last dispatch timestamps, next retry, HTTP/request ID, stable error code, backend order ID/number, server result hash, acknowledgment time, resolution actor/reason/time, and creation/update timestamps. Secrets and JWTs are never stored in the journal.

The backend already has salon-scoped order-key uniqueness and same-key/same-payload replay, while mismatched payload returns conflict (`API_AUTH_CONTRACT_MATRIX.md` O1/O3). Android runtime still remains blocked by P0-PAY-1, P0-GATE-1, P0-AUDIT-1, P0-ORDER-1 and related shift/error decisions.

### 3.2 State diagram

```text
                         auth/gate unavailable
                                  │
                                  ▼
DRAFT --atomic submit--> STAGED ──┴───────────────┐
                           │ eligible              │ pause, no attempt
                           ▼                       │
                       DISPATCHING                 │
                      /     |      \               │
       response lost /      | 2xx exact replay     │
                    ▼       | result                │
              UNKNOWN       └──────────────► ACKED │
                 │ exact replay/reconcile          │
                 └───────────────► DISPATCHING ◄───┘
                          │
            stable invalid/denied/conflict
                          ▼
                  REJECTED_TERMINAL
                          │ owner records resolution
                          ▼
                    RESOLVED_MANUAL
```

`UNKNOWN` is unresolved, not failed. Transport/timeout/5xx never dead-letters an order solely by attempt count. `401` pauses for reauthentication; `403`, stable validation `400`, and payload/key `409` stop automatic dispatch. Until P1-ERR-1 supplies stable machine-readable codes, automatic terminal classification is disabled.

### 3.3 Retry, reconciliation, retention, and dead-letter ownership

- Retry authority: the single native uploader under a database lease; UI may request “retry now” but cannot construct or send a command.
- Reconciliation authority: exact O3 replay of the original POST. Fuzzy order history is diagnostic only because P1-ORD-1 is open.
- Backoff: bounded exponential delay with jitter for pre-dispatch network unavailability and ambiguous transport/5xx; no maximum converts ambiguity to failure.
- Retention: unresolved rows and immutable order snapshots are never automatically deleted. ACKED and owner-resolved rows remain locally for at least 400 days; longer legal/accounting retention belongs to the backend/export policy and is not satisfied by this cache.
- Dead-letter owner: there is no generic order “dead letter.” Stable rejections enter `REJECTED_TERMINAL`; an OWNER/MANAGER plus support tooling records a reason and authoritative disposition. Purge requires confirmed export/backup, a separate audit record, and no unresolved lineage.

## 4. Catalog read model and `local_sync_log`

### 4.1 Ownership and cursor rules

The catalog synchronizer alone writes sync-log/cursor fields. The read-model applicator writes product/category/tombstone rows inside the same transaction that records application. UI is read-only. Catalog is always scoped to the bound salon; production use remains conditional on P1-CAT-1.

For product sync-v2, the current page cursor is retryable, page effects commit atomically, and `nextSyncCursor` replaces the completed-cycle cursor only when the final page says `hasMore=false`. Categories must not claim lossless parity until P1-CAT-2 closes. A failed, partial, invalid, or empty response never deletes the last good snapshot. The Windows lossless behavior similarly distinguishes category completeness before prune (`SOURCE_RECONCILIATION_2026-07-17.md`, disposition for `67a4439`).

Proposed log fields include identity tuple, `sync_cycle_id`, endpoint/schema, input cursor, next page/final cursor, response hash, source transaction, page ordinal, completeness flag, state, received/applied timestamps, stable error, retry count, and diagnostic request ID. The response body may be retained compressed only within the privacy/storage policy; the read model and response hash are the durable recovery evidence.

### 4.2 State diagram

```text
IDLE --start/persist cycle--> FETCHING
  ▲                              │
  │ transport error              ▼
  ├──────── RETRY_WAIT ◄──── RECEIVED
  │                              │ atomic apply(log + rows + page cursor)
  │                              ▼
  │                           APPLIED_PAGE --hasMore--> FETCHING
  │                              │ final complete page
  │                              ▼
  └──────────────────────── COMPLETE_CYCLE

RECEIVED/APPLYING --invalid schema/hash/constraint--> QUARANTINED_PAGE
QUARANTINED_PAGE --reviewed full-resync decision--> IDLE (last good view retained)
```

After process death, `FETCHING` without a response simply retries. `RECEIVED`/`APPLYING` is re-applied idempotently in a new transaction or rolled back; a final cursor can never exist without all corresponding read-model effects.

### 4.3 Retry, reconciliation, retention, and dead-letter ownership

- Retry authority: catalog synchronizer; safe GET retry with identical opaque cursor.
- Reconciliation authority: server cursor protocol and a reviewed full snapshot after documented stale-cursor `409`. The client never manufactures cursor time.
- Retention: completed sync-log pages for at least 7 days (matching the Windows accepted-log precedent at `src/main/sync/sync-log-repo.ts:153-163`); keep the current/previous completed cycle metadata and all quarantined pages until a successful replacement plus support resolution. Tombstone retention follows the server cursor contract.
- Dead-letter owner: repeated transport failures stay retryable. Invalid schema/hash/constraint becomes `QUARANTINED_PAGE`; support owns diagnosis. A cashier may continue with an explicitly labeled last-good snapshot if policy permits but cannot mark the page resolved.

## 5. `pos_event_outbox`

### 5.1 Ownership

Only a domain fact transaction enqueues an event. The event uploader can update attempts/ack/error state, never payload identity. Backend POS-event ingestion owns acceptance/deduplication; ERP/financial read models own projections. An OWNER/MANAGER plus support owns critical dead letters.

The Windows evidence uses `event_id` as backend idempotency identity, a deterministic `dedupe_key`, per-row accepted/duplicate/rejected results, transport retry without dead-letter, and 25 repeated per-event rejects before dead-letter (`src/main/database/repos/pos-event-outbox-repo.ts:80-164`; `src/main/sync/pos-event-uploader.ts:6-25,63-133`). These are precedents, not approval to wire the Android route before the API/backend gates pass.

Minimum fields match the identity/event envelope evidence plus `payload_hash` and `canonicalization_version`. `salon_id` is retained locally for quarantine/binding even if the wire envelope omits it and the backend derives tenant from Staff JWT (`src/main/database/repos/pos-event-outbox-repo.ts:221-238`).

### 5.2 State diagram

```text
FACT COMMIT --atomic enqueue--> PENDING --lease/batch--> IN_FLIGHT
                                ▲                    /     |      \
                                │ transport/5xx     /      |       \ accepted/duplicate
                                └── RETRY_WAIT ◄───┘       |        └──► ACKED
                                                          │ per-event stable rejection
                                                          ▼
                                                    REJECTED_RETRYABLE
                                                          │ bounded repeated rejects
                                                          ▼
                                                     DEAD_LETTER
                                                          │ owner retry, exact same bytes/ID
                                                          └──────────► PENDING
```

Process death turns expired `IN_FLIGHT` into `PENDING` without changing `event_id` or bytes. A partial batch response updates each event independently. Missing entries in a nominally successful batch remain unresolved and are retried; they are not assumed accepted.

### 5.3 Retry, reconciliation, retention, and dead-letter ownership

- Retry authority: single native event uploader; batches never couple order-journal state.
- Reconciliation authority: accepted/duplicate by exact `event_id`. No analytics total or order-history presence substitutes for an event acknowledgment.
- Retention: ACKED rows for at least 30 days, matching the Windows default (`src/main/database/repos/pos-event-outbox-repo.ts:199-218`). PENDING and DEAD_LETTER are never auto-pruned.
- Dead-letter owner: operational/insight events go to support triage; important/critical financial events alert OWNER/MANAGER and support. Resetting the same `event_id` to PENDING is permitted only after external/backend remediation and must resend byte-for-byte identical canonical payload/hash. Any payload correction creates a new event ID and a new dedupe lineage that explicitly supersedes the old event; the old row remains immutable and DEAD_LETTER/RESOLVED with the cross-reference. A future server protocol may define that supersession, but it may never reinterpret changed bytes under the original ID.
- Shift close is not blocked by an event transport backlog because these are derived projections, but unresolved critical events must appear in the shift diagnostics and cannot be presented as reconciled.

Again, **`pos_event_outbox` never uploads orders**. Its endpoint, acknowledgment, retry count, and dead-letter status have no authority over order creation.

## 6. Separate shift-command journal

### 6.1 Contract gate and ownership

Shift open and close use their own commands because their payload, reconciliation, operator impact, and idempotency differ from orders. Android shift writes remain disabled/read-only until both backend contracts exist and pass DB-backed race/response-loss/restart tests:

- Open: salon-scoped durable command key/hash; same key/same payload replays the same shift; changed payload is stable `409`; terminal and authenticated actor are server-bound (P0-SHIFT-1/P0-AUDIT-1).
- Close: durable command key/hash plus authoritative close-result lookup/replay containing accepted closing cash/counts; an already-closed or missing shift cannot be reduced to a generic success (P0-SHIFT-2).

The local journal owner writes immutable open/close rows. The shift uploader dispatches. The backend is authoritative for server shift state and accepted cash. UI never decides that a timeout opened or closed a shift.

### 6.2 State diagram

```text
OPEN_STAGED --> OPEN_DISPATCHING --> OPEN_ACKED --> LOCALLY_ACTIVE
     ▲                 │ unknown          │
     └── OPEN_UNKNOWN ◄┘                  │ local seal requested
                                         ▼
                                  CLOSE_HELD_UNRESOLVED
                                   │ all blocking order work resolved
                                   ▼
                                   CLOSE_STAGED --> CLOSE_DISPATCHING
                                                          │
                                          timeout/5xx ────┤
                                                          ▼
                                                   CLOSE_UNKNOWN
                                                          │ exact replay/result lookup
                                                          ▼
                                                   CLOSE_ACKED

Any stable payload/key/tenant/actor conflict --> CONFLICT_MANUAL
```

Only one unresolved open lineage and one close lineage can exist per local shift. `OPEN_UNKNOWN` prevents creating another shift. A close command cannot be regenerated with a different closing cash after dispatch; a correction is a separately authorized backend adjustment, never a retry.

### 6.3 Shift-close behavior with unresolved local work

1. “Seal locally” atomically freezes the shift's closing cash/count snapshot and stops new carts/orders on that shift. It is not a server close.
2. If any order journal row for that shift is `STAGED`, `DISPATCHING`, `UNKNOWN`, or `REJECTED_TERMINAL` without an owner disposition, the close journal enters `CLOSE_HELD_UNRESOLVED`. UI shows exact counts/oldest age and offers reconciliation, not “closed/synced.”
3. Catalog backlog never blocks close. POS-event backlog does not block command dispatch, but critical event backlog remains visible. Cart drafts must be explicitly discarded, reassigned before sealing, or submitted; they cannot silently become orders.
4. When all order lineages are ACKED or have an explicit owner/server disposition, the exact frozen close command may dispatch. If the approved backend contract instead supports a server close with unresolved-order references, that must be a versioned owner-approved policy and exact response, not a client inference.
5. `CLOSE_UNKNOWN` blocks opening a subsequent shift on the same terminal until exact command replay/result lookup resolves it. Staff can sign out; unresolved rows remain tenant-bound and immutable.
6. In the current contract, S1/S3 are non-idempotent and S2 cannot recover accepted closing cash. Therefore Android exposes shift state read-only and never reaches any dispatch state.

### 6.4 Retry, retention, and ownership

Network/5xx ambiguity replays the exact command indefinitely with bounded backoff; `401` pauses; stable `400/403/409` stops for review. Unresolved commands are never pruned. ACKED/resolved shift commands and frozen snapshots remain at least 400 days. OWNER/MANAGER plus support owns conflicts and must record disposition; a cashier cannot convert `404` to success.

## 7. Cart/draft durability

### 7.1 State diagram

```text
EMPTY --> EDITABLE_DRAFT <--> HELD_DRAFT
            │ revisions committed atomically
            │ submit transaction
            ▼
       SUBMISSION_FROZEN --atomic order snapshot+journal--> SUBMITTED
            │ local validation/storage failure
            └────────────────────────────────────────────► EDITABLE_DRAFT

EDITABLE_DRAFT/HELD_DRAFT --explicit actor action--> DISCARDED
```

Cart rows are mutable and revisioned. Each edit atomically replaces/updates draft lines and totals. A draft binds to salon, terminal, installation, actor/session projection, price snapshot version, and optional acknowledged local shift. A different tenant/session cannot open it without an explicit same-salon handoff policy.

Submission is one local transaction: validate the latest revision, freeze it, create immutable order snapshot/lines and order journal, then mark the draft `SUBMITTED`. The network starts only after commit. A crash before commit leaves the editable draft; a crash after commit finds one submitted order lineage. The order payload never reads mutable draft rows during retry.

Draft retention is 30 days after last edit for abandoned drafts, followed by an audited local purge policy; held drafts are never auto-purged while linked to an active shift. Submitted drafts may retain only a reference after the immutable order snapshot exists. Cart storage is native database storage, not WebView `localStorage`, and contains no auth token.

## 8. Atomic transaction table

| User/system action | Rows that commit atomically | Explicitly outside that transaction |
| --- | --- | --- |
| Save cart edit | `cart_draft` revision + affected `cart_draft_line` rows + recalculated totals | Order/event/shift journals; network |
| Submit cart | freeze draft + immutable `orders` row + all `order_items` + one `order_upload_journal` row | HTTP dispatch; backend result; print/fiscal work |
| Record a mandatory local business fact | domain fact transition + corresponding `pos_event_outbox` rows and hashes | Event HTTP upload; order acknowledgment |
| Lease order command | journal state/lease/attempt metadata only, guarded by compare-and-set | Payload bytes; order/items; HTTP itself |
| Apply order result | exact journal ACK/rejection + backend IDs/result hash + local order projection | POS-event acknowledgment; mutable cart |
| Apply catalog page | page `local_sync_log` state + all product/category upserts/tombstones + next page cursor | Final cycle cursor if more pages remain; any business command |
| Finish catalog cycle | final page effects + completed-cycle `nextSyncCursor` + cycle status | Deleting last-good snapshot on an error |
| Enqueue POS event | event row(s) + originating fact transition when the fact is mandatory | Batch upload; order upload |
| Apply POS-event batch result | each returned event's ACK/reject/backoff state; partial results remain per-row | Order/shift state |
| Stage shift open | local shift projection + immutable open command row | HTTP dispatch; POS-event ACK |
| Seal shift locally | frozen shift close snapshot + close command in HELD/STAGED state + terminal sales lock | Server close; deleting unresolved orders |
| Apply shift result | command result + authoritative local shift projection | Order/event/catalog state |

SQLite uses explicit transactions and foreign keys; WAL/full-sync/encryption/checkpoint details belong to GLM-B2. “Atomic” here is a required invariant, not a claim that the current Windows implementation already satisfies every row.

## 9. Diagnostics and operator surface

Diagnostics expose counts and age by ledger, state, salon/terminal (redacted), stable local IDs, request IDs, attempts, next retry, payload hash prefix, last stable error code, and server IDs. They never display JWTs, refresh tokens, customer secrets, full payment data, raw printer/fiscal content, or allow arbitrary SQL/payload editing.

Required alarms are: oldest unresolved order; any order/shift `UNKNOWN`; terminal rejection/conflict; catalog last-success age and quarantined page; POS-event dead-letter counts by reliability class; local-sealed/server-open shift; and tenant/device quarantine. Export is encrypted, owner-authorized, scoped, and produces an audit record.

## 10. Chaos and recovery matrix

“Terminal” below means the system has an authoritative outcome; “unresolved” means operator-facing work must remain visible and retained.

| # | Chaos case | Expected recovery and outcome |
| --- | --- | --- |
| 1 | Process dies after cart edit begins but before commit | Transaction rolls back; previous draft revision is restored. **Terminal:** editable draft, no order/journal row. |
| 2 | Process dies after submit commit but before first HTTP byte | One immutable order and STAGED journal survive; uploader sends the same key/bytes. **Unresolved until ACK**, never a second order. |
| 3 | Order request commits on server but response is lost | Journal becomes UNKNOWN; exact O3 replay returns the same backend order. **Terminal ACK** only after exact replay; no new key. |
| 4 | Same order key is paired with changed payload/hash due to corruption/bug | Local preflight or server `409` stops dispatch. **Unresolved CONFLICT_MANUAL**; no automatic repair or fresh key. |
| 5 | Token expires while an order is staged/in flight | `401` pauses uploader; native broker reauthenticates without changing command. Ambiguous in-flight work exact-replays. **Unresolved** until auth and replay. |
| 6 | App starts under a Staff JWT for a different salon than the database | Database and all ledgers quarantine before display/dispatch. **Unresolved tenant incident**; no rebinding or purge by cashier. |
| 7 | Catalog transport returns an empty body/timeout during full sync | Last-good catalog and completed cursor remain; current fetch retries. **Terminal preservation**, sync remains unresolved/retryable. |
| 8 | Process dies halfway through applying a catalog page | SQLite rolls back page/log/cursor together; same opaque cursor refetches/reapplies. **Terminal APPLIED** after retry, no half-pruned catalog. |
| 9 | Product sync completes pages but app dies before final cursor commit | Final transaction either contains last-page effects plus cursor or neither. Retry final page with same cursor. **Terminal COMPLETE_CYCLE** after retry. |
| 10 | Server returns accepted, duplicate, rejected, and omits one POS event in one batch | ACK accepted/duplicate per ID; rejected backs off/dead-letters by policy; omitted row remains pending. **Mixed terminal/unresolved** per row, never batch-wide success. |
| 11 | Event transport fails 100 times | Network failures remain PENDING/RETRY_WAIT and are not attempt-count dead-lettered. **Unresolved**, order status unchanged. |
| 12 | A critical financial event reaches DEAD_LETTER after stable per-event rejects | Alert OWNER/MANAGER/support; retain bytes and ID. **Unresolved DEAD_LETTER** until explicit backend/superseding-event resolution; shift diagnostics show it. |
| 13 | Shift-open reaches server but response is lost | `OPEN_UNKNOWN`; exact open-command replay must return the same server shift. Until P0-SHIFT-1 exists, dispatch is disabled. **Unresolved and new open blocked.** |
| 14 | Shift-close reaches server but response is lost | `CLOSE_UNKNOWN`; exact close replay/result lookup must return accepted closing cash. A later `404` alone is not success. **Unresolved and next shift blocked.** |
| 15 | Cashier requests close with two UNKNOWN orders and one dead-letter POS event | Freeze/seal locally and enter CLOSE_HELD_UNRESOLVED because of orders. Event is diagnostic, not order upload. **Unresolved close** until order dispositions exist. |
| 16 | Device clock jumps backward 24 hours during retries | Stable IDs, hashes, attempt counters, server cursors and monotonic scheduling preserve order; no state regression. **Outcome unchanged**; diagnostic records skew. |
| 17 | Device reboots after leasing an order/event row | Expired lease recovers to UNKNOWN/PENDING and exact IDs/bytes retry. **Unresolved until authoritative ACK**, no duplicate local row. |
| 18 | App is uninstalled/cleared with unresolved commands | No claim of recovery from local storage. Server terminal is revoked and encrypted export/backup policy is invoked if available. **Potentially unresolved data-loss incident**; production rollout is blocked until B2 restore/backup acceptance proves the owner-approved behavior. |
| 19 | Disk-full occurs during checkout submit | Whole transaction fails; UI cannot claim payment/order completion. Existing cart remains at last committed revision. **Terminal local failure**, retry only after storage remediation. |
| 20 | Server accepts order but rejects its derived POS event | Order journal may be ACKED; event is retry/dead-letter independently. **Terminal order, unresolved event**; never resend order through the event path. |

## 11. Gate checklist

This specification remains non-authorizing until all are true:

- Phase -1 reconciliation is GO with the immutable SHAs above or reviewed descendants.
- `API_AUTH_CONTRACT_MATRIX.md` and `OPEN_BACKEND_CONTRACT_DECISIONS.md` exit provisional/NO-GO after owner review.
- P0-GATE-1, P0-AUDIT-1, P0-SHIFT-1/2, P0-PAY-1 and the applicable order/offline/error decisions have committed, DB-backed tests and guarded live-artifact verification.
- Backend uniqueness/replay tests cover concurrent same-key requests, changed payload, response loss, restart, cross-tenant IDs, and registered terminal binding.
- GLM-B2 proves the selected Android SQLite/encryption/backup design, including atomic transactions, WAL/checkpoint, migration failure preservation, corrupt database handling, process death, reinstall, cloud restore, and device-transfer exclusion.
- Executable tests prove every transaction row above, all chaos cases, and that each uploader can fail independently without mutating another ledger.
- Build boundary tests prove Android contains no Electron/Node adapter, print-agent credential/route, printer/fiscal implementation, Windows updater, or production secret.

Current lifecycle status: **target runtime planned; this docs-only specification implemented on the feature branch; no runtime/schema/API implementation; not landed on canonical; not built; not deployed; not verified live.**
