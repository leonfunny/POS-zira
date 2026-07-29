import {
  CreatePrintJobRequest,
  CreatePrintJobResponse,
  PrintJobFailureClass,
  PrintJobType,
  PrinterType,
  ReceiptData,
  SalonPrinterRole,
} from '../../shared/types';
import { getConfig, getSecureApiKey, getSecureAuthToken } from '../config/store';
import { ApiClient } from '../network/api-client';
import logger from '../logger';
import {
  buildSharedPrintIdempotencyKey,
  classifySharedPrintResponse,
  delay,
  getPrintJobId,
  hasBackendRetryContract,
  normalizePrintJobStatus,
  SHARED_PRINT_RETRY_DELAYS_MS,
  SHARED_RECEIPT_COMPLETION_TIMEOUT_MS,
  SHARED_RECEIPT_TOTAL_WAIT_MS,
} from './shared-print-retry-policy';

const SHARED_RECEIPT_ROLE: SalonPrinterRole = 'SELF_CHECKOUT_RECEIPT';
const ASSIGNMENT_ENDPOINT_NEGATIVE_TTL_MS = 60_000;

let assignmentEndpointUnavailableUntil = 0;

/**
 * Same-session resume registry (POS2 incident 2026-07-06): once a keyed POS
 * receipt job is created, any later attempt for the same order must poll
 * THAT job instead of re-creating. A re-create with the same idempotency key
 * and a rebuilt payload 409s on the backend ("same idempotencyKey was
 * already used with a different print job") and every retry then fails
 * instantly while the receipt actually prints on the shared till.
 */
const KNOWN_RECEIPT_JOBS_MAX = 100;
const knownReceiptJobs = new Map<string, string>(); // idempotencyKey -> jobId

/** Clear the resume registry — used on logout/salon switch and by tests. */
export function resetSharedReceiptResumeRegistry(): void {
  knownReceiptJobs.clear();
}

function rememberReceiptJob(idempotencyKey: string, jobId: string): void {
  if (knownReceiptJobs.has(idempotencyKey)) knownReceiptJobs.delete(idempotencyKey);
  knownReceiptJobs.set(idempotencyKey, jobId);
  while (knownReceiptJobs.size > KNOWN_RECEIPT_JOBS_MAX) {
    const oldest = knownReceiptJobs.keys().next().value;
    if (oldest === undefined) break;
    knownReceiptJobs.delete(oldest);
  }
}

function isIdempotencyConflictError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return (
    /same idempotencyKey/i.test(message) ||
    (/\b409\b/.test(message) && /idempotenc/i.test(message))
  );
}

function isEndpointUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return /\b(404|501)\b/.test(message);
}

function isAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return /\b(401|403)\b|unauthori[sz]ed|forbidden|jwt|token/i.test(message);
}

export interface SharedReceiptPrintMeta {
  referenceType?: string;
  referenceId?: string;
  source?: string;
  openDrawer?: boolean;
  /**
   * Durable outbox mode: return as soon as the backend exposes the fixed job
   * identity so it can be flushed before any longer completion polling.
   */
  returnOnAccepted?: boolean;
}

export interface SharedReceiptPrintResult {
  handled: boolean;
  printed: boolean;
  printerId?: string;
  jobId?: string;
  sent?: boolean;
  status?: string;
  failureClass?: PrintJobFailureClass | null;
  drawerOpenRequested?: boolean;
  /** Job accepted and still not terminal after the full wait budget — the paper may yet come out on the shared till. */
  stillPrinting?: boolean;
  error?: string;
}

export interface SharedReceiptJobIdentity {
  printerId: string;
  jobId: string;
}

function isUnsupportedDrawerIntentError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return (
    /openDrawer|cashDrawer|drawer/i.test(message) &&
    /\b400\b|property .* should not exist|unexpected property|unknown property|whitelist|not allowed|validation/i.test(message)
  );
}

function isUnsupportedSharedPrintContractError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return (
    /\b400\b|property .* should not exist|unexpected property|unknown property|whitelist|not allowed|validation/i.test(message) &&
    /idempotencyKey|waitForCompletion|timeoutMs/i.test(message)
  );
}

async function createReceiptJob(
  client: ApiClient,
  token: string | null,
  apiKey: string | null,
  machineId: string | undefined,
  body: CreatePrintJobRequest,
): Promise<CreatePrintJobResponse> {
  return token
    ? await client.createPrintJob(token, body).catch(async (err) => {
        if (!apiKey || !isAuthFailure(err)) throw err;
        logger.warn('[SharedReceiptPrinter] JWT print job create failed; retrying with print-agent API key');
        return client.createPrintJobWithApiKey(apiKey, body, machineId);
      })
    : await client.createPrintJobWithApiKey(apiKey!, body, machineId);
}

async function safeRetryReceiptJob(
  client: ApiClient,
  token: string | null,
  apiKey: string | null,
  machineId: string | undefined,
  jobId: string,
  attemptNo: number,
): Promise<CreatePrintJobResponse> {
  const reason = `POS receipt auto-retry #${attemptNo}`;
  return token
    ? await client.safeRetryPrintJob(token, jobId, reason).catch(async (err) => {
        if (!apiKey || !isAuthFailure(err)) throw err;
        return client.safeRetryPrintJobWithApiKey(apiKey, jobId, machineId, reason);
      })
    : await client.safeRetryPrintJobWithApiKey(apiKey!, jobId, machineId, reason);
}

async function getReceiptJobStatus(
  client: ApiClient,
  token: string | null,
  apiKey: string | null,
  machineId: string | undefined,
  jobId: string,
): Promise<CreatePrintJobResponse> {
  return token
    ? await client.getPrintJobStatus(token, jobId).catch(async (err) => {
        if (!apiKey || !isAuthFailure(err)) throw err;
        return client.getPrintJobStatusWithApiKey(apiKey, jobId, machineId);
      })
    : await client.getPrintJobStatusWithApiKey(apiKey!, jobId, machineId);
}

async function waitForReceiptJobCompletion(
  client: ApiClient,
  token: string | null,
  apiKey: string | null,
  machineId: string | undefined,
  jobId: string,
  deadlineTs?: number,
): Promise<CreatePrintJobResponse> {
  const deadline = deadlineTs ?? Date.now() + SHARED_RECEIPT_COMPLETION_TIMEOUT_MS;
  let latest: CreatePrintJobResponse = { jobId, status: 'SENT' };

  while (Date.now() < deadline) {
    latest = await getReceiptJobStatus(client, token, apiKey, machineId, jobId);
    const status = normalizePrintJobStatus(latest);
    if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED' || status === 'TIMEOUT') {
      return latest;
    }
    await delay(1_000);
  }

  return {
    ...latest,
    jobId,
    status: normalizePrintJobStatus(latest) || 'TIMEOUT',
    timedOut: true,
    retryAllowed: false,
    retryBlockedReason: 'job still in flight (timed out waiting)',
  };
}

async function resolveFinalReceiptResult(
  client: ApiClient,
  token: string | null,
  apiKey: string | null,
  machineId: string | undefined,
  printerId: string,
  initial: CreatePrintJobResponse,
  idempotencyKey?: string,
): Promise<SharedReceiptPrintResult> {
  let current = initial;
  // Shared jobs on the POS1 till take 9-20s end-to-end; the 10s backend hold
  // regularly returns while the job is still in flight. Poll to this budget
  // before giving any verdict.
  const totalDeadline = Date.now() + SHARED_RECEIPT_TOTAL_WAIT_MS;
  let safeRetriesUsed = 0;

  const stillPrintingResult = (jobId: string | undefined, status: string): SharedReceiptPrintResult => ({
    handled: true,
    printed: false,
    sent: current.sent,
    printerId,
    jobId,
    status: status || 'IN_FLIGHT',
    failureClass: current.failureClass ?? null,
    stillPrinting: true,
    error: `receipt job still printing on the shared till after ${Math.round(SHARED_RECEIPT_TOTAL_WAIT_MS / 1000)}s — check the printout before reprinting`,
  });

  for (;;) {
    const jobId = getPrintJobId(current);
    if (idempotencyKey && jobId) rememberReceiptJob(idempotencyKey, jobId);
    const status = normalizePrintJobStatus(current);
    if (!status && !hasBackendRetryContract(current) && current.sent !== false) {
      return { handled: true, printed: true, sent: current.sent, printerId, jobId };
    }
    const decision = classifySharedPrintResponse('RECEIPT_ORDER_COPY', current);

    if (decision.decision === 'SUCCESS') {
      return { handled: true, printed: true, sent: current.sent, printerId, jobId, status, failureClass: current.failureClass ?? null };
    }

    // Job accepted but not terminal yet — keep polling it. The old code
    // returned printed:false here, so EVERY receipt that outlived the 10s
    // backend hold surfaced as a failure while the paper still came out
    // (POS2 2026-07-06: min job 9.2s, avg 14.5s, max 19.8s).
    if (decision.decision === 'ALREADY_IN_FLIGHT' && jobId) {
      if (Date.now() >= totalDeadline) return stillPrintingResult(jobId, status);
      current = await waitForReceiptJobCompletion(client, token, apiKey, machineId, jobId, totalDeadline);
      if (current.timedOut) return stillPrintingResult(getPrintJobId(current) || jobId, normalizePrintJobStatus(current));
      continue;
    }

    if (decision.decision !== 'AUTO_RETRY_SAFE' || !jobId || safeRetriesUsed >= SHARED_PRINT_RETRY_DELAYS_MS.length) {
      const error = current.errorMessage || current.message || current.retryBlockedReason || decision.reason;
      return { handled: true, printed: false, sent: current.sent, printerId, jobId, status, failureClass: current.failureClass ?? null, error: String(error) };
    }

    await delay(SHARED_PRINT_RETRY_DELAYS_MS[safeRetriesUsed]);
    safeRetriesUsed += 1;
    const retryResult = await safeRetryReceiptJob(client, token, apiKey, machineId, jobId, safeRetriesUsed);
    if (retryResult.retryAllowed !== true || retryResult.sent !== true) {
      current = retryResult;
      continue;
    }

    logger.info(`[SharedReceiptPrinter] safe retry #${safeRetriesUsed} re-dispatched job ${jobId}`);
    current = await waitForReceiptJobCompletion(
      client,
      token,
      apiKey,
      machineId,
      jobId,
      Math.max(totalDeadline, Date.now() + SHARED_RECEIPT_COMPLETION_TIMEOUT_MS),
    );
  }
}

/**
 * Reconcile one already-accepted shared receipt job.
 *
 * This deliberately bypasses assignment discovery, the in-memory resume
 * registry and createPrintJob. The caller obtained this identity from the
 * durable receipt outbox, so changing route or creating another job could
 * duplicate a customer receipt (and its cash-drawer pulse) after restart.
 */
export async function reconcileSharedReceiptPrintJob(
  identity: SharedReceiptJobIdentity,
): Promise<SharedReceiptPrintResult> {
  const printerId = String(identity?.printerId || '').trim();
  const jobId = String(identity?.jobId || '').trim();
  if (!printerId || !jobId) {
    throw new Error('shared-receipt-reconcile-identity-incomplete');
  }

  const token = getSecureAuthToken();
  const apiKey = getSecureApiKey();
  if (!token && !apiKey) {
    throw new Error('shared-receipt-reconcile-auth-unavailable');
  }

  const config = getConfig();
  const client = new ApiClient(config.serverUrl || 'https://api.enail.pro');
  const current = await getReceiptJobStatus(
    client,
    token,
    apiKey,
    config.machineId,
    jobId,
  );
  const final = await resolveFinalReceiptResult(
    client,
    token,
    apiKey,
    config.machineId,
    printerId,
    current,
  );

  return {
    ...final,
    handled: true,
    printerId,
    jobId,
    // The drawer intent, if any, belonged to the original remote job. Polling
    // it must never request or infer a second drawer pulse.
    drawerOpenRequested: false,
  };
}

export async function submitSharedReceiptPrint(
  receiptData: ReceiptData,
  meta: SharedReceiptPrintMeta = {},
): Promise<SharedReceiptPrintResult> {
  const token = getSecureAuthToken();
  const apiKey = getSecureApiKey();
  if (!token && !apiKey) return { handled: false, printed: false };

  if (Date.now() < assignmentEndpointUnavailableUntil) {
    return { handled: false, printed: false };
  }

  const config = getConfig();
  const client = new ApiClient(config.serverUrl || 'https://api.enail.pro');

  let printerId: string | undefined;
  try {
    let response;
    if (token) {
      try {
        response = await client.listPrinterAssignments(token);
      } catch (err) {
        if (!apiKey || !isAuthFailure(err)) throw err;
        logger.warn('[SharedReceiptPrinter] JWT assignment lookup failed; retrying with print-agent API key');
      }
    }
    if (!response && apiKey) {
      response = await client.listPrinterAssignmentsWithApiKey(apiKey, config.machineId);
    }
    if (!response) return { handled: false, printed: false };
    printerId = response.assignments.find((assignment) => assignment.role === SHARED_RECEIPT_ROLE)?.printerId;
  } catch (err: any) {
    if (isEndpointUnavailable(err)) {
      assignmentEndpointUnavailableUntil = Date.now() + ASSIGNMENT_ENDPOINT_NEGATIVE_TTL_MS;
    }
    logger.warn(`[SharedReceiptPrinter] Assignment lookup failed; falling back to local printer: ${err?.message || err}`);
    return { handled: false, printed: false, error: err?.message || String(err) };
  }

  if (!printerId) return { handled: false, printed: false };

  try {
    const referenceType = meta.referenceType || 'RECEIPT';
    const referenceId = meta.referenceId || receiptData.orderId || receiptData.orderNumber || null;
    const initialPosReceipt = referenceType === 'POS_RECEIPT' && !receiptData.isReprint && !receiptData.isRefund;
    const idempotencyKey = initialPosReceipt
      ? buildSharedPrintIdempotencyKey('receipt', config.machineId, String(referenceId || ''), 'order')
      : undefined;
    const body: CreatePrintJobRequest = {
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.RECEIPT,
      printerId,
      payload: receiptData,
      referenceType,
      referenceId,
      ...(initialPosReceipt && !meta.returnOnAccepted
        ? { waitForCompletion: true, timeoutMs: SHARED_RECEIPT_COMPLETION_TIMEOUT_MS }
        : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(meta.openDrawer ? { openDrawer: true } : {}),
    };
    logger.info(
      `[SharedReceiptPrinter] creating ${body.referenceType || 'RECEIPT'} job for printer ${printerId} ` +
      `openDrawer=${meta.openDrawer ? 'true' : 'false'} paymentMethod=${String(receiptData.payment?.method || 'none')}`,
    );
    let drawerOpenRequested = !!meta.openDrawer;

    // Resume instead of re-create: a keyed receipt already submitted this
    // session polls its existing job. Re-creating with the same key and a
    // rebuilt payload is a guaranteed backend 409 (POS2 2026-07-06).
    const knownJobId = idempotencyKey ? knownReceiptJobs.get(idempotencyKey) : undefined;
    if (knownJobId) {
      logger.info(`[SharedReceiptPrinter] resuming known receipt job ${knownJobId} for key ${idempotencyKey}`);
      try {
        const resumed = await getReceiptJobStatus(client, token, apiKey, config.machineId, knownJobId);
        const final = await resolveFinalReceiptResult(client, token, apiKey, config.machineId, printerId, resumed, idempotencyKey);
        return { ...final, drawerOpenRequested: false };
      } catch (err: any) {
        logger.warn(`[SharedReceiptPrinter] Known job ${knownJobId} status lookup failed (${err?.message || err}); creating instead`);
      }
    }

    let result: CreatePrintJobResponse | undefined;
    let currentBody = body;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await createReceiptJob(client, token, apiKey, config.machineId, currentBody);
        break;
      } catch (err) {
        if (isIdempotencyConflictError(err)) {
          // A job with this key already exists but with different content —
          // blind retries can only ever repeat this 409. Tell the operator
          // what actually happened instead of a generic printer failure.
          logger.error(
            `[SharedReceiptPrinter] Idempotency conflict for key ${currentBody.idempotencyKey || idempotencyKey || 'n/a'}: ${(err as any)?.message || err}`,
          );
          return {
            handled: true,
            printed: false,
            printerId,
            error:
              'A receipt job for this order already exists on the shared printer — check the printout on the shared till first, then use Reprint if a copy is really needed',
          };
        }
        if (currentBody.openDrawer && isUnsupportedDrawerIntentError(err)) {
          logger.warn('[SharedReceiptPrinter] Backend does not accept openDrawer yet; retrying receipt job without drawer intent');
          drawerOpenRequested = false;
          const { openDrawer: _unsupported, ...retryBody } = currentBody;
          currentBody = retryBody;
          continue;
        }
        if (
          (currentBody.idempotencyKey || currentBody.waitForCompletion || currentBody.timeoutMs) &&
          isUnsupportedSharedPrintContractError(err)
        ) {
          logger.warn('[SharedReceiptPrinter] Backend does not accept safe retry contract fields yet; using legacy receipt create');
          const {
            idempotencyKey: _idempotencyKey,
            waitForCompletion: _waitForCompletion,
            timeoutMs: _timeoutMs,
            ...retryBody
          } = currentBody;
          currentBody = retryBody;
          continue;
        }
        throw err;
      }
    }
    if (!result) throw new Error('Shared receipt print did not return a backend response');

    const jobId = (result.jobId || result.id) as string | undefined;
    if (idempotencyKey && jobId) rememberReceiptJob(idempotencyKey, jobId);
    if (initialPosReceipt && meta.returnOnAccepted && jobId) {
      const status = normalizePrintJobStatus(result);
      const decision = classifySharedPrintResponse('RECEIPT_ORDER_COPY', result);
      if (decision.decision === 'SUCCESS') {
        return {
          handled: true,
          printed: true,
          sent: result.sent,
          printerId,
          jobId,
          status,
          failureClass: result.failureClass ?? null,
          drawerOpenRequested,
        };
      }
      if (
        decision.decision === 'ALREADY_IN_FLIGHT'
        || (
          result.sent !== false
          && !['FAILED', 'CANCELLED'].includes(status)
        )
      ) {
        return {
          handled: true,
          printed: false,
          sent: result.sent !== false,
          printerId,
          jobId,
          status: status || 'SENT',
          failureClass: result.failureClass ?? null,
          drawerOpenRequested,
          stillPrinting: true,
          error: 'Shared receipt job accepted; completion will be reconciled from the durable outbox',
        };
      }
      return {
        handled: true,
        printed: false,
        sent: result.sent,
        printerId,
        jobId,
        status,
        failureClass: result.failureClass ?? null,
        drawerOpenRequested,
        error: String(
          result.errorMessage
          || result.message
          || result.retryBlockedReason
          || decision.reason,
        ),
      };
    }
    if (initialPosReceipt && currentBody.waitForCompletion) {
      const final = await resolveFinalReceiptResult(client, token, apiKey, config.machineId, printerId, result, idempotencyKey);
      logger.info(
        `[SharedReceiptPrinter] ${meta.source || 'receipt'} final status ${final.status || 'unknown'} ` +
        `for shared printer ${printerId}${jobId ? ` as job ${jobId}` : ''}`,
      );
      return { ...final, drawerOpenRequested };
    }

    const sent = result.sent !== false;
    logger.info(`[SharedReceiptPrinter] ${meta.source || 'receipt'} routed to shared printer ${printerId}${jobId ? ` as job ${jobId}` : ''}`);
    return { handled: true, printed: sent, sent, printerId, jobId, drawerOpenRequested };
  } catch (err: any) {
    logger.error(`[SharedReceiptPrinter] Shared receipt print failed for printer ${printerId}: ${err?.message || err}`);
    return { handled: true, printed: false, printerId, error: err?.message || String(err) };
  }
}
