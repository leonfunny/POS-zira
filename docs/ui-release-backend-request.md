# BLIK recipient configuration — backend change request

Status: proposal, not an implemented API. Related plan item: W02 / review R02.

The desktop PaymentModal and both receipt formatter branches currently contain a fixed BLIK phone number. The UI release work does not change that recipient without a verified merchant-scoped configuration and receipt persistence contract. This remains a blocker for distributing the same build to multiple merchants.

## Existing boundaries

- `AgentConfig.salonId` is server-assigned and blocked from generic renderer SET_CONFIG updates in `src/main/modules/auth.module.ts`.
- The generic settings path is not a dedicated, server-verified payment-recipient update operation.
- `ReceiptData` has no recipient snapshot field today. UI, initial printing, queued retries and historical reprints must use the same resolved destination.

## Requested contract

1. Expose the current authenticated merchant's BLIK recipient configuration. Resolve the merchant from the authenticated session rather than accepting an arbitrary client-supplied salonId as authorization.
2. Restrict updates to the authorized owner/payment-administration role. Validate role and merchant membership server-side; return an explicit forbidden result for unauthorized requests.
3. Return a versioned configuration containing merchant identity, normalized phone number, enabled/confirmed state, version and update time. Endpoint names should follow the existing server conventions; no new endpoint is assumed to exist in this repository.
4. Require the expected configuration version on update, or the server's equivalent concurrency control. Return a conflict if another register/administrator has changed the destination.
5. Bind the effective recipient/configuration version to the payment/order or durable receipt snapshot. Reject mismatched merchant or stale recipient preparation rather than silently replacing the displayed destination.
6. Preserve this snapshot for queued printing and reprints. Define legacy-order behavior: missing recipient data must not be filled with another merchant's number or today's changed destination.
7. Include an audit record of the authorized change and return a sanitized read model to registers. Public kiosk configuration must not gain payment-administration capability.

## Desktop follow-up once the contract is available

- Add a dedicated edit/review/confirm setting instead of autosaving each phone-number keystroke.
- Read the verified setting through main/preload and the appropriate existing merchant context.
- Freeze the resolved destination for an in-progress payment; configuration refresh applies to the next payment.
- Pass the snapshot into both text and raster receipt rendering; remove both fixed constants together.
- Treat missing/unconfirmed/mismatched configuration as unavailable for new BLIK payments; keep other valid methods usable.
- Preserve old configuration during upgrade until the owner explicitly verifies the destination; never mark the old code constant as an owner-confirmed value automatically.

## Acceptance scenarios

- Merchant A and B have different recipients; neither register can read/write/use the other's recipient.
- An unauthorized cashier cannot change the recipient by invoking IPC/API directly.
- Two concurrent owner edits produce an explicit conflict, not a last-write-wins silent change.
- A recipient update during an active payment does not alter the displayed or printed destination for that payment.
- Offline retry/reprint uses the recorded snapshot, including after a configuration change.
- Legacy receipt, split payment including BLIK, refund and queued receipt behavior are explicitly covered.
- New installs without a confirmed destination never display the current fixed number as their default.

No financial destination, permission gate or server contract is altered by this request document.
