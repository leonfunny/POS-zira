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
  // Response received but neither success nor a recognized safe-failure: the
  // receiver may have printed. Do NOT dispatch; mark uncertain so the slip prints.
  if (!responseOk) {
    return { action: 'FAILED_NO_FALLBACK', status: status || `HTTP_${httpStatus}`, error: message || `LAN print HTTP ${httpStatus}`, uncertain: true };
  }
  return { action: 'FAILED_NO_FALLBACK', status: status || 'UNKNOWN', error: message || 'LAN print returned an unexpected response', uncertain: true };
}

export function classifyLanPrintError(err: unknown): LanPrintDecision {
  const e = err as { name?: string; code?: string; cause?: { code?: string } } | undefined;
  const code = String(e?.code || e?.cause?.code || '').toUpperCase();
  // Connection never established → the receiver never received the request →
  // safe to fall back to the backend dispatch.
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return { action: 'FALLBACK', reason: `LAN_CONN_${code}` };
  }
  // Timeout (AbortError) or any other error after the request was sent → the
  // receiver may have printed. Uncertain → no dispatch; slip still prints.
  const timedOut = e?.name === 'AbortError';
  return {
    action: 'FAILED_NO_FALLBACK',
    status: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
    error: timedOut ? 'LAN print timed out' : 'LAN print network error',
    uncertain: true,
  };
}
