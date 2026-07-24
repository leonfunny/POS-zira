import type { CreatePrintJobResponse, PrintJobFailureClass } from '../../shared/types';

export type SharedPrintOperation = 'RECEIPT_ORDER_COPY' | 'FISCAL_RECEIPT';

export type SharedPrintRetryDecision =
  | 'SUCCESS'
  | 'AUTO_RETRY_SAFE'
  | 'STOP_MANUAL_RETRY'
  | 'STOP_RECONCILE_REQUIRED'
  | 'ALREADY_IN_FLIGHT';

export const SHARED_PRINT_RETRY_DELAYS_MS = [2_000, 4_000, 6_000] as const;
export const SHARED_RECEIPT_COMPLETION_TIMEOUT_MS = 10_000;
/**
 * Total client-side budget for ONE shared receipt submission. Real jobs on
 * the shared POS1 till measured 9.2-19.8s end-to-end (2026-07-06, 21 jobs),
 * so the 10s backend hold above regularly ends while the paper is still
 * feeding — the client must keep polling instead of declaring failure.
 * 30s also absorbs one job queued ahead on the shared printer.
 */
export const SHARED_RECEIPT_TOTAL_WAIT_MS = 30_000;
export const SHARED_FISCAL_RETRY_COMPLETION_TIMEOUT_MS = 10_000;

export function normalizePrintJobStatus(result?: CreatePrintJobResponse | null): string {
  return String(result?.status || (result as any)?.finalStatus || '').toUpperCase();
}

export function getPrintJobId(result?: CreatePrintJobResponse | null): string | undefined {
  const value = result?.jobId || result?.id;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function getFailureClass(result?: CreatePrintJobResponse | null): PrintJobFailureClass | null {
  const value = String(result?.failureClass || '').toUpperCase();
  if (value === 'SAFE_BEFORE_PRINT' || value === 'UNCERTAIN_AFTER_PRINT' || value === 'FINAL') {
    return value;
  }
  return null;
}

export function hasBackendRetryContract(result?: CreatePrintJobResponse | null): boolean {
  return !!result && (
    Object.prototype.hasOwnProperty.call(result, 'retryAllowed') ||
    Object.prototype.hasOwnProperty.call(result, 'failureClass') ||
    Object.prototype.hasOwnProperty.call(result, 'retryBlockedReason')
  );
}

export function classifySharedPrintResponse(
  operation: SharedPrintOperation,
  result?: CreatePrintJobResponse | null,
): { decision: SharedPrintRetryDecision; reason: string } {
  const status = normalizePrintJobStatus(result);
  const failureClass = getFailureClass(result);
  const jobId = getPrintJobId(result);

  if (status === 'COMPLETED' || status === 'PRINTED' || (result as any)?.receiptPrinted === true) {
    return { decision: 'SUCCESS', reason: 'completed' };
  }

  if (status === 'SENT' || status === 'PRINTING' || status === 'PENDING' || status === 'RESERVED') {
    return { decision: 'ALREADY_IN_FLIGHT', reason: `job ${status.toLowerCase()}${jobId ? ` (${jobId})` : ''}` };
  }

  if (status === 'TIMEOUT' || result?.timedOut) {
    // The backend never persists a TIMEOUT job status — this response means
    // "blocking wait expired, the job is still in flight on the shared till"
    // (print-agent toJobStatusResponse). Order copies must keep polling the
    // job instead of declaring failure: real POS1 receipts take 13-19s while
    // the backend hold is 10s, so ~95% of POS2 receipts surfaced as failures
    // and a retry only rediscovered the already-printed job (2026-07-24).
    if (operation === 'RECEIPT_ORDER_COPY' && jobId) {
      return { decision: 'ALREADY_IN_FLIGHT', reason: `backend wait expired; job still in flight (${jobId})` };
    }
    return {
      decision: operation === 'FISCAL_RECEIPT' ? 'STOP_RECONCILE_REQUIRED' : 'STOP_MANUAL_RETRY',
      reason: `job timed out${jobId ? ` (${jobId})` : ''}`,
    };
  }

  if (failureClass === 'UNCERTAIN_AFTER_PRINT') {
    return {
      decision: operation === 'FISCAL_RECEIPT' ? 'STOP_RECONCILE_REQUIRED' : 'STOP_MANUAL_RETRY',
      reason: 'uncertain after print',
    };
  }

  if (failureClass === 'FINAL') {
    return { decision: 'STOP_MANUAL_RETRY', reason: 'final failure' };
  }

  if (
    status === 'FAILED' &&
    failureClass === 'SAFE_BEFORE_PRINT' &&
    result?.retryAllowed === true &&
    hasBackendRetryContract(result)
  ) {
    return { decision: 'AUTO_RETRY_SAFE', reason: 'safe before print' };
  }

  if (status === 'FAILED' || status === 'CANCELLED') {
    return { decision: 'STOP_MANUAL_RETRY', reason: status.toLowerCase() };
  }

  return { decision: 'STOP_MANUAL_RETRY', reason: status ? `unexpected ${status.toLowerCase()}` : 'missing final status' };
}

export function buildSharedPrintIdempotencyKey(
  kind: 'receipt' | 'fiscal',
  machineId: string | undefined,
  orderId: string | undefined,
  purpose: 'order' | 'default',
): string | undefined {
  const cleanMachineId = String(machineId || '').trim();
  const cleanOrderId = String(orderId || '').trim();
  if (!cleanMachineId || !cleanOrderId) return undefined;
  return kind === 'fiscal'
    ? `pos-fiscal:${cleanMachineId}:${cleanOrderId}:${purpose}:v1`
    : `pos-receipt:${cleanMachineId}:${cleanOrderId}:${purpose}:v1`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
