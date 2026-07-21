# Backend clarifications — POS Zira Android (E-PARITY), 2026-07-20

**From:** POS Zira Android (parity port of the Zira AI Print Agent), branch
`codex/android-pos-build-ci`, commits 4422db1…43ee99e.
**To:** eNail backend / print-agent server IT.
**Why:** The Android POS on the salon's trusted Sunmi terminal now connects to
the print-agent (pa_ key + Socket.IO), accepts manual card/BLIK, and drives the
owner product-admin surface — exactly like the Windows counter. Three behaviors
depend on **server-side logic we cannot see** (the server codebase is out of
scope for this repo). None BLOCKS local build/test, but each must be confirmed
before rollout to a live salon. No server change may be needed — these are
mostly confirmations.

---

## Q1 — Print-agent job routing (BLOCKING for rollout) 🔴

**Priority:** High — potential receipt/fiscal dead-letter.

The Sunmi opens the same `/print-agent` Socket.IO namespace with the salon's
`pa_` key and calls `POST /api/v1/print-agent/connect`, so the server registers
it as a **connected agent** for the salon. But the Sunmi is a **job SUBMITTER
with NO physical printer** (the ELZAB fiscal printer + thermal printer live on a
separate print-agent host, like Che Saigon). It has no code to execute or ACK a
dispatched print job; it only listens to `job:updated` for status of jobs it
submitted.

**Question:** Does the job router EVER dispatch a real print job (`job:new` /
job assignment) to a connected agent **other than** the specific agent that owns
the target `printerId`? I.e., could a receipt / fiscal / kitchen job for the
salon's physical printer ever be routed to the Sunmi's connection?

- **If NO (jobs are addressed strictly to the owning `printerId`'s agent):** no
  change needed — please confirm so we can document it.
- **If YES (broadcast / any-agent / round-robin to salon agents):** that job
  would be silently swallowed by the Sunmi (it can't print). We then need one of:
  (a) the server to route only to the printer-owning agent, or (b) a documented
  way for an agent to **NACK / decline** a job so the server re-routes it, or
  (c) a flag on `POST /print-agent/connect` marking a connection as
  **submitter-only / no-printer** so the router never assigns it jobs.

**Acceptance:** a print job created for the salon's fiscal/receipt printer is
always delivered to the printer-owning agent and never to a submitter-only
Sunmi connection (or the Sunmi can decline it and the server re-dispatches).

---

## Q2 — Product-admin purchase-price authorization (data-exposure) 🟠

**Priority:** Medium — cost-price exposure to non-privileged staff.

`GET/PATCH /api/v1/warehouse/product-admin/*` responses may include product
**purchase (cost) price**. The Windows agent redacts purchase price **client-
side** when the capability `canViewPurchasePrice` is off. The Android port does
**not** redact client-side — it returns exactly what the server sends.

**Question:** Does the server already gate purchase-price fields by the caller's
role/permission (i.e., omit them from the response for a token that lacks
`canViewPurchasePrice`)?

- **If YES (server omits cost price for unauthorized tokens):** no change needed
  — the Android client is safe as-is. Please confirm the exact fields gated.
- **If NO (server returns cost price to any authenticated staff, relying on the
  client to hide it):** we will port the Windows client-side redaction to
  Android. Please list the response fields that constitute "purchase price" so we
  redact the same set.

**Acceptance:** cost price is never visible (in the network response) to a staff
token without `canViewPurchasePrice`, whether enforced server- or client-side.

---

## Q3 — Product-admin required context headers (confirmation) 🟢

**Priority:** Low — confirmation only.

The Android product-admin requests now send `X-Salon-Slug`, `X-Salon-Code`, and
`X-Agent-Id` (the last two populated from the `POST /print-agent/connect`
response, matching Windows). Before commit 43ee99e, `X-Salon-Code` / `X-Agent-Id`
were omitted (empty in config).

**Question:** Does `/warehouse/product-admin/*` **hard-require** `X-Salon-Code`
and/or `X-Agent-Id` (reject the request without them), or are they supplementary
to `X-Salon-Slug` + the staff JWT? (Confirms whether a Sunmi that has logged in
but not yet completed `/print-agent/connect` — so has no agentId/salonCode — can
still use product-admin.)

**Acceptance:** documented list of required vs optional context headers for the
product-admin routes.

---

### Context notes for the reviewer
- The Sunmi is a **dedicated, owner-trusted fixed terminal** (owner decision
  2026-07-19), so it holds the `pa_` key and connects like the Windows counter
  — this is intentional, not a leak.
- Manual CARD/BLIK on the Sunmi is **cashier-attested** (standalone terminal),
  same as the Windows salon POS; the known backend behavior of marking a
  non-CREDIT tender PAID without capture proof (P0-PAY-1) is accepted by the
  owner on that basis. Not part of these questions.
