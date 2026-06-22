// Pure classification of a LAN-direct kitchen-ticket print outcome into the
// orchestrator's decision. Extracted from shared-kitchen-printer so it can be
// unit-tested without fetch/electron deps.
//
// The single rule that prevents double-printing: ONLY fall back to the backend
// dispatch when we are confident the receiver did NOT print. A timeout, lost
// response, or HTTP error AFTER the request was sent is UNCERTAIN — the receiver
// may have already printed — so dispatching would print the same ticket twice
// (LAN-direct + backend socket). Uncertain outcomes therefore never dispatch;
// they are flagged `uncertain` so the customer pickup slip still prints.

// Raised from 2000 → 6000: a thermal kitchen-ticket print over LAN takes ~2-4s;
// the old 2s ceiling aborted mid-print and triggered the duplicate. The timeout
// is only a ceiling — a successful print returns as soon as the receiver replies,
// so the happy path is not slowed.
export const LAN_FIRST_DEFAULT_TIMEOUT_MS = 6000;

export type LanPrintDecision =
  | { action: 'ACCEPTED'; status: string }
  | { action: 'FALLBACK'; reason: string }
  | { action: 'FAILED_NO_FALLBACK'; status: string; error?: string; uncertain: boolean };

export function classifyLanPrintResponse(input: {
  status: string; // json.status, upper-cased
  failureClass: string; // json.failureClass, upper-cased
  error: string; // json.error, upper-cased
  message?: string; // human-readable json.error/message
  responseOk: boolean; // response.ok
  httpStatus: number; // response.status
}): LanPrintDecision {
  const { status, failureClass, error, responseOk, httpStatus } = input;
  const message = input.message || '';

  if (status === 'COMPLETED' || status === 'PRINTING') {
    return { action: 'ACCEPTED', status };
  }
  // Receiver explicitly confirmed it did NOT print → safe to dispatch.
  if (failureClass === 'SAFE_BEFORE_PRINT') {
    return { action: 'FALLBACK', reason: 'LAN_SAFE_BEFORE_PRINT' };
  }
  if (error === 'LEDGER_NOT_DURABLE') {
    return { action: 'FALLBACK', reason: 'LAN_LEDGER_NOT_DURABLE' };
  }
  // Receiver got it but the print outcome is uncertain → it may have printed.
  if (failureClass === 'UNCERTAIN_AFTER_PRINT') {
    return { action: 'FAILED_NO_FALLBACK', status: status || 'FAILED', error: message || 'LAN print uncertain after print', uncertain: true };
  }
  // Receiver definitively failed before/without printing.
  if (failureClass === 'FINAL') {
    return { action: 'FAILED_NO_FALLBACK', status: status || 'FAILED', error: message || 'LAN print failed', uncertain: false };
  }
  // Response received but neither success nor a recognized safe-failure (an HTTP
  // error or an unrecognized body). In practice the receiver rejected or never
  // reached the print handler (auth, routing, wrong endpoint) rather than
  // printed-then-failed — a printed-then-failed receiver sets
  // failureClass=UNCERTAIN_AFTER_PRINT. So fall back to the backend dispatch,
  // matching the established contract. Only a true *timeout* (no response at all,
  // see classifyLanPrintError) is treated as uncertain.
  if (!responseOk) {
    return { action: 'FALLBACK', reason: `LAN_HTTP_${httpStatus}` };
  }
  return { action: 'FALLBACK', reason: 'LAN_UNEXPECTED_RESPONSE' };
}

export function classifyLanPrintError(err: unknown): LanPrintDecision {
  const name = (err as { name?: string } | undefined)?.name;
  // A timeout (AbortController.abort()) is the one case where the request was
  // SENT but we got no answer — the receiver may have already printed (a slow
  // thermal print). Dispatching the backend fallback here double-prints (the
  // K-002 bug), so treat it as uncertain: NO dispatch, but the customer slip
  // still prints because the kitchen ticket most likely came out.
  if (name === 'AbortError') {
    return { action: 'FAILED_NO_FALLBACK', status: 'TIMEOUT', error: 'LAN print timed out', uncertain: true };
  }
  // Any other fetch rejection (connection refused/reset, DNS failure, etc.) means
  // the request did not complete a round-trip to a printing receiver → safe to
  // fall back to the backend dispatch (established behavior).
  return { action: 'FALLBACK', reason: 'LAN_NETWORK_ERROR' };
}
