import {
  CreatePrintJobRequest,
  CreatePrintJobResponse,
  PrintJobFailureClass,
  PrintJobType,
  PrinterType,
  ReceiptData,
  SalonPrinterMapping,
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
  normalizePrintJobStatus,
  SHARED_FISCAL_RETRY_COMPLETION_TIMEOUT_MS,
  SHARED_FISCAL_TOTAL_WAIT_MS,
  SHARED_PRINT_RETRY_DELAYS_MS,
  shouldMintFreshFiscalKey,
} from './shared-print-retry-policy';

const SHARED_FISCAL_ROLE: SalonPrinterRole = 'FISCAL_RECEIPT';
const ASSIGNMENT_ENDPOINT_NEGATIVE_TTL_MS = 60_000;
const FISCAL_JOB_TIMEOUT_MS = 60_000;

let fiscalEndpointUnavailableUntil = 0;

export interface SharedFiscalPrintMeta {
  referenceType?: string;
  referenceId?: string;
  source?: string;
}

export interface SharedFiscalPrintResult {
  handled: boolean;
  printed: boolean;
  printerId?: string;
  jobId?: string;
  status?: string;
  sent?: boolean;
  failureClass?: PrintJobFailureClass | null;
  // The job outlived the polling budget but is not a confirmed failure — the
  // paragon may still be feeding on POS1. Callers must NOT treat this as a hard
  // failure that provokes a duplicate reprint.
  stillPrinting?: boolean;
  error?: string;
}

export interface SharedFiscalPrinterStatus {
  configured: boolean;
  connected: boolean;
  printerId?: string;
  error?: string;
}

function isBackendContractUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return /\b(400|404|501)\b/.test(message);
}

function isAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return /\b(401|403)\b|unauthori[sz]ed|forbidden|jwt|token/i.test(message);
}

function hasPhysicalTarget(printer?: SalonPrinterMapping | null): boolean {
  return !!(
    printer?.windowsPrinterName?.trim()
    || printer?.address?.trim()
  );
}

function isReadyFiscalPrinter(printer?: SalonPrinterMapping | null): printer is SalonPrinterMapping {
  return !!printer
    && String(printer.printerType || '').toUpperCase() === PrinterType.FISCAL
    && printer.isEnabled !== false
    && !!printer.agentIsOnline
    && !!printer.isOnline
    && hasPhysicalTarget(printer);
}

function finalStatusFromResponse(result: Record<string, unknown> | null | undefined): string {
  return String(result?.status || result?.finalStatus || '').toUpperCase();
}

function isUnsupportedIdempotencyFieldError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return (
    /\b400\b|property .* should not exist|unexpected property|unknown property|whitelist|not allowed|validation/i.test(message) &&
    /idempotencyKey/i.test(message)
  );
}

// Same idempotencyKey reused for a different job/payload -> backend 409
// (see docs/server-change-requests/2026-06-29-safe-print-retry-backend-contract-AS-BUILT.md).
function isIdempotencyConflictError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return (
    /same idempotencyKey/i.test(message) ||
    (/\b409\b/.test(message) && /idempotenc/i.test(message))
  );
}


function createClient(): ApiClient {
  const config = getConfig();
  return new ApiClient(config.serverUrl || 'https://api.enail.pro');
}

async function createFiscalJob(
  client: ApiClient,
  token: string | null,
  apiKey: string | null,
  machineId: string | undefined,
  body: CreatePrintJobRequest,
): Promise<CreatePrintJobResponse> {
  return token
    ? await client.createPrintJob(token, body).catch(async (err) => {
        if (!apiKey || !isAuthFailure(err)) throw err;
        logger.warn('[SharedFiscalPrinter] JWT fiscal job create failed; retrying with print-agent API key');
        return client.createPrintJobWithApiKey(apiKey, body, machineId);
      })
    : await client.createPrintJobWithApiKey(apiKey!, body, machineId);
}

async function safeRetryFiscalJob(
  client: ApiClient,
  token: string | null,
  apiKey: string | null,
  machineId: string | undefined,
  jobId: string,
  attemptNo: number,
): Promise<CreatePrintJobResponse> {
  const reason = `POS fiscal auto-retry #${attemptNo}`;
  return token
    ? await client.safeRetryPrintJob(token, jobId, reason).catch(async (err) => {
        if (!apiKey || !isAuthFailure(err)) throw err;
        return client.safeRetryPrintJobWithApiKey(apiKey, jobId, machineId, reason);
      })
    : await client.safeRetryPrintJobWithApiKey(apiKey!, jobId, machineId, reason);
}

async function getFiscalJobStatus(
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

async function waitForFiscalRetryCompletion(
  client: ApiClient,
  token: string | null,
  apiKey: string | null,
  machineId: string | undefined,
  jobId: string,
  deadlineMs?: number,
): Promise<CreatePrintJobResponse> {
  const deadline = deadlineMs ?? Date.now() + SHARED_FISCAL_RETRY_COMPLETION_TIMEOUT_MS;
  let latest: CreatePrintJobResponse = { jobId, status: 'SENT' };

  while (Date.now() < deadline) {
    latest = await getFiscalJobStatus(client, token, apiKey, machineId, jobId);
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

async function resolveFinalFiscalResult(
  client: ApiClient,
  token: string | null,
  apiKey: string | null,
  machineId: string | undefined,
  printerId: string,
  initial: CreatePrintJobResponse,
): Promise<SharedFiscalPrintResult> {
  let current = initial;
  // The ELZAB paragon on POS1 keeps feeding after the 10s backend hold returns
  // (measured 9.2-19.8s). Poll to this budget before giving any verdict so a
  // slow-but-successful fiscal receipt is not journaled FAILED — which is what
  // provoked cashiers to reprint and risk a duplicate paragon.
  const totalDeadline = Date.now() + SHARED_FISCAL_TOTAL_WAIT_MS;
  let safeRetriesUsed = 0;

  const stillPrintingResult = (jobId: string | undefined, status: string): SharedFiscalPrintResult => ({
    handled: true,
    printed: false,
    printerId,
    jobId,
    status: status || 'IN_FLIGHT',
    sent: current.sent,
    failureClass: current.failureClass ?? null,
    stillPrinting: true,
    error: `Remote fiscal job ${jobId || 'unknown'} still printing on POS1 after ${Math.round(SHARED_FISCAL_TOTAL_WAIT_MS / 1000)}s — check the ELZAB printout before reprinting`,
  });

  for (;;) {
    const jobId = getPrintJobId(current);
    const status = normalizePrintJobStatus(current);
    const decision = classifySharedPrintResponse('FISCAL_RECEIPT', current);

    if (decision.decision === 'SUCCESS') {
      return { handled: true, printed: true, printerId, jobId, status, sent: current.sent, failureClass: current.failureClass ?? null };
    }

    // Job accepted but not terminal yet — keep polling to the budget. The old
    // code lumped this into the non-retryable stop branch and returned
    // printed:false, so every fiscal receipt that outlived the 10s hold
    // surfaced as a failure while the paragon was still feeding.
    if (decision.decision === 'ALREADY_IN_FLIGHT' && jobId) {
      if (Date.now() >= totalDeadline) return stillPrintingResult(jobId, status);
      current = await waitForFiscalRetryCompletion(client, token, apiKey, machineId, jobId, totalDeadline);
      if (current.timedOut) return stillPrintingResult(getPrintJobId(current) || jobId, normalizePrintJobStatus(current));
      continue;
    }

    if (decision.decision !== 'AUTO_RETRY_SAFE' || !jobId || safeRetriesUsed >= SHARED_PRINT_RETRY_DELAYS_MS.length) {
      const rawError = current.errorMessage || current.message || current.retryBlockedReason || decision.reason;
      const error = decision.decision === 'STOP_RECONCILE_REQUIRED'
        ? `Remote fiscal job ${jobId || 'unknown'} is not safe to retry automatically (${rawError}). Check POS1/ELZAB paper and job status before retrying.`
        : rawError;
      return { handled: true, printed: false, printerId, jobId, status, sent: current.sent, failureClass: current.failureClass ?? null, error: String(error) };
    }

    await delay(SHARED_PRINT_RETRY_DELAYS_MS[safeRetriesUsed]);
    safeRetriesUsed += 1;
    const retryResult = await safeRetryFiscalJob(client, token, apiKey, machineId, jobId, safeRetriesUsed);
    if (retryResult.retryAllowed !== true || retryResult.sent !== true) {
      current = retryResult;
      continue;
    }

    logger.info(`[SharedFiscalPrinter] safe retry #${safeRetriesUsed} re-dispatched fiscal job ${jobId}`);
    current = await waitForFiscalRetryCompletion(
      client,
      token,
      apiKey,
      machineId,
      jobId,
      Math.max(totalDeadline, Date.now() + SHARED_FISCAL_RETRY_COMPLETION_TIMEOUT_MS),
    );
  }
}

async function resolveSharedFiscalPrinter(
  token: string | null,
  apiKey: string | null,
): Promise<SharedFiscalPrinterStatus> {
  if (Date.now() < fiscalEndpointUnavailableUntil) {
    return {
      configured: false,
      connected: false,
      error: 'Backend fiscal printer assignment endpoint is unavailable',
    };
  }

  const client = createClient();
  const config = getConfig();
  let printerId: string | undefined;
  try {
    let assignments;
    if (token) {
      try {
        assignments = await client.listPrinterAssignments(token);
      } catch (err) {
        if (!apiKey || !isAuthFailure(err)) throw err;
        logger.warn('[SharedFiscalPrinter] JWT assignment lookup failed; retrying with print-agent API key');
      }
    }
    if (!assignments && apiKey) {
      assignments = await client.listPrinterAssignmentsWithApiKey(apiKey, config.machineId);
    }
    if (!assignments) {
      return { configured: false, connected: false };
    }
    printerId = assignments.assignments.find((assignment) => assignment.role === SHARED_FISCAL_ROLE)?.printerId;
  } catch (err: any) {
    if (isBackendContractUnavailable(err)) {
      fiscalEndpointUnavailableUntil = Date.now() + ASSIGNMENT_ENDPOINT_NEGATIVE_TTL_MS;
    }
    const error = err?.message || String(err);
    logger.warn(`[SharedFiscalPrinter] ${SHARED_FISCAL_ROLE} assignment lookup failed; fiscal route disabled: ${error}`);
    return { configured: false, connected: false, error };
  }

  if (!printerId) {
    return { configured: false, connected: false };
  }

  try {
    const response = token
      ? await client.listSalonPrinters(token).catch(async (err) => {
          if (!apiKey || !isAuthFailure(err)) throw err;
          logger.warn('[SharedFiscalPrinter] JWT printer readiness lookup failed; retrying with print-agent API key');
          return client.listSalonPrintersWithApiKey(apiKey, {}, config.machineId);
        })
      : await client.listSalonPrintersWithApiKey(apiKey!, {}, config.machineId);
    const printer = response.printers.find((item) => item.id === printerId) || null;
    if (!printer) {
      const error = `${SHARED_FISCAL_ROLE} assignment points at missing printer ${printerId}`;
      logger.warn(`[SharedFiscalPrinter] ${error}`);
      return { configured: false, connected: false, printerId, error };
    }
    if (!isReadyFiscalPrinter(printer)) {
      const error = `${SHARED_FISCAL_ROLE} printer ${printerId} is not a ready FISCAL printer`;
      logger.warn(`[SharedFiscalPrinter] ${error}`);
      return { configured: false, connected: false, printerId, error };
    }
    return { configured: true, connected: true, printerId };
  } catch (err: any) {
    if (isBackendContractUnavailable(err)) {
      fiscalEndpointUnavailableUntil = Date.now() + ASSIGNMENT_ENDPOINT_NEGATIVE_TTL_MS;
    }
    const error = err?.message || String(err);
    logger.warn(`[SharedFiscalPrinter] Salon printer readiness lookup failed; fiscal route disabled: ${error}`);
    return { configured: false, connected: false, printerId, error };
  }
}

export async function getSharedFiscalPrinterStatus(): Promise<SharedFiscalPrinterStatus> {
  const token = getSecureAuthToken();
  const apiKey = getSecureApiKey();
  if (!token && !apiKey) return { configured: false, connected: false };
  return resolveSharedFiscalPrinter(token, apiKey);
}

export async function submitSharedFiscalPrint(
  receiptData: ReceiptData,
  meta: SharedFiscalPrintMeta = {},
): Promise<SharedFiscalPrintResult> {
  const token = getSecureAuthToken();
  const apiKey = getSecureApiKey();
  if (!token && !apiKey) return { handled: false, printed: false };

  const route = await resolveSharedFiscalPrinter(token, apiKey);
  if (!route.printerId) {
    return { handled: false, printed: false, error: route.error };
  }
  if (!route.configured || !route.connected) {
    return { handled: true, printed: false, printerId: route.printerId, error: route.error || 'Fiscal printer route is not ready' };
  }

  const client = createClient();
  const config = getConfig();
  const referenceType = meta.referenceType || 'POS_FISCAL_RECEIPT';
  const referenceId = meta.referenceId || receiptData.orderId || receiptData.orderNumber || null;
  const idempotencyKey = buildSharedPrintIdempotencyKey('fiscal', config.machineId, String(referenceId || ''), 'default');
  const body: CreatePrintJobRequest = {
    jobType: PrintJobType.RECEIPT,
    printerType: PrinterType.FISCAL,
    printerId: route.printerId,
    waitForCompletion: true,
    timeoutMs: FISCAL_JOB_TIMEOUT_MS,
    referenceType,
    referenceId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    payload: receiptData,
  };

  try {
    logger.info(
      `[SharedFiscalPrinter] creating POS_FISCAL_RECEIPT job for fiscal printer ${route.printerId} ` +
      `paymentMethod=${String(receiptData.payment?.method || 'none')}`,
    );

    let attemptKey = idempotencyKey;
    let freshKeyUsed = false;
    // At most two iterations: the once-per-order key, then ONE fresh-key
    // re-issue if that job is wedged (terminal SAFE_BEFORE_PRINT).
    for (;;) {
      const attemptBody: CreatePrintJobRequest = { ...body };
      if (attemptKey) attemptBody.idempotencyKey = attemptKey;
      else delete (attemptBody as { idempotencyKey?: string }).idempotencyKey;

      let result: CreatePrintJobResponse;
      try {
        result = await createFiscalJob(client, token, apiKey, config.machineId, attemptBody);
      } catch (err) {
        if (isIdempotencyConflictError(err)) {
          // Same key, different payload — blind retries only repeat this 409.
          logger.error(`[SharedFiscalPrinter] Idempotency conflict for key ${attemptKey || 'n/a'}: ${(err as any)?.message || err}`);
          return {
            handled: true,
            printed: false,
            printerId: route.printerId,
            error: 'A fiscal job for this order already exists on the shared printer — check the ELZAB printout on POS1 first, then use Reprint if a copy is really needed',
          };
        }
        if (attemptBody.idempotencyKey && isUnsupportedIdempotencyFieldError(err)) {
          logger.warn('[SharedFiscalPrinter] Backend does not accept idempotencyKey yet; using legacy fiscal create without auto retry');
          const { idempotencyKey: _idempotencyKey, ...legacyBody } = attemptBody;
          result = await createFiscalJob(client, token, apiKey, config.machineId, legacyBody);
        } else {
          throw err;
        }
      }
      const jobId = (result.jobId || result.id) as string | undefined;
      const status = finalStatusFromResponse(result);

      const final = await resolveFinalFiscalResult(client, token, apiKey, config.machineId, route.printerId, result);
      if (final.printed) {
        logger.info(`[SharedFiscalPrinter] fiscal receipt completed on shared printer ${route.printerId}${jobId ? ` as job ${jobId}` : ''}`);
        return final;
      }

      // Unwedge: the once-per-order key produced a job that terminally failed
      // BEFORE the paragon printed and can no longer auto-retry. Re-issue ONCE
      // under a fresh key so the never-printed receipt can still be produced.
      // shouldMintFreshFiscalKey gates this so it NEVER fires for a job that
      // might already have printed (no duplicate paragon).
      if (!freshKeyUsed && attemptKey && shouldMintFreshFiscalKey(final)) {
        freshKeyUsed = true;
        attemptKey = buildSharedPrintIdempotencyKey('fiscal', config.machineId, String(referenceId || ''), `reprint-${Date.now()}`);
        logger.warn(`[SharedFiscalPrinter] Fiscal job wedged (status=${final.status}, class=${final.failureClass}); re-issuing once with fresh key ${attemptKey}`);
        continue;
      }

      const responseMessage = final.error || result.errorMessage || result.message;
      const finalStatus = final.status || status;
      const error = finalStatus
        ? `Shared fiscal print ${finalStatus.toLowerCase()}${responseMessage ? `: ${responseMessage}` : ''}`
        : 'Backend did not return final COMPLETED status for fiscal receipt job';
      logger.error(`[SharedFiscalPrinter] ${error}${jobId ? ` (${jobId})` : ''}`);
      return { ...final, error };
    }
  } catch (err: any) {
    const error = err?.message || String(err);
    logger.error(`[SharedFiscalPrinter] Shared fiscal print failed for printer ${route.printerId}: ${error}`);
    return { handled: true, printed: false, printerId: route.printerId, error };
  }
}
