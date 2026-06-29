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
} from './shared-print-retry-policy';

const SHARED_RECEIPT_ROLE: SalonPrinterRole = 'SELF_CHECKOUT_RECEIPT';
const ASSIGNMENT_ENDPOINT_NEGATIVE_TTL_MS = 60_000;

let assignmentEndpointUnavailableUntil = 0;

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
  error?: string;
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
): Promise<CreatePrintJobResponse> {
  const deadline = Date.now() + SHARED_RECEIPT_COMPLETION_TIMEOUT_MS;
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
): Promise<SharedReceiptPrintResult> {
  let current = initial;

  for (let retryIndex = 0; retryIndex <= SHARED_PRINT_RETRY_DELAYS_MS.length; retryIndex++) {
    const jobId = getPrintJobId(current);
    const status = normalizePrintJobStatus(current);
    if (!status && !hasBackendRetryContract(current) && current.sent !== false) {
      return { handled: true, printed: true, sent: current.sent, printerId, jobId };
    }
    const decision = classifySharedPrintResponse('RECEIPT_ORDER_COPY', current);

    if (decision.decision === 'SUCCESS') {
      return { handled: true, printed: true, sent: current.sent, printerId, jobId, status, failureClass: current.failureClass ?? null };
    }

    if (decision.decision !== 'AUTO_RETRY_SAFE' || !jobId || retryIndex >= SHARED_PRINT_RETRY_DELAYS_MS.length) {
      const error = current.errorMessage || current.message || current.retryBlockedReason || decision.reason;
      return { handled: true, printed: false, sent: current.sent, printerId, jobId, status, failureClass: current.failureClass ?? null, error: String(error) };
    }

    await delay(SHARED_PRINT_RETRY_DELAYS_MS[retryIndex]);
    const retryAttemptNo = retryIndex + 1;
    const retryResult = await safeRetryReceiptJob(client, token, apiKey, machineId, jobId, retryAttemptNo);
    if (retryResult.retryAllowed !== true || retryResult.sent !== true) {
      current = retryResult;
      continue;
    }

    logger.info(`[SharedReceiptPrinter] safe retry #${retryAttemptNo} re-dispatched job ${jobId}`);
    current = await waitForReceiptJobCompletion(client, token, apiKey, machineId, jobId);
  }

  return { handled: true, printed: false, printerId, error: 'Shared receipt retry exhausted' };
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
      ...(initialPosReceipt ? { waitForCompletion: true, timeoutMs: SHARED_RECEIPT_COMPLETION_TIMEOUT_MS } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(meta.openDrawer ? { openDrawer: true } : {}),
    };
    logger.info(
      `[SharedReceiptPrinter] creating ${body.referenceType || 'RECEIPT'} job for printer ${printerId} ` +
      `openDrawer=${meta.openDrawer ? 'true' : 'false'} paymentMethod=${String(receiptData.payment?.method || 'none')}`,
    );
    let drawerOpenRequested = !!meta.openDrawer;
    let result: CreatePrintJobResponse | undefined;
    let currentBody = body;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await createReceiptJob(client, token, apiKey, config.machineId, currentBody);
        break;
      } catch (err) {
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
    if (initialPosReceipt && currentBody.waitForCompletion) {
      const final = await resolveFinalReceiptResult(client, token, apiKey, config.machineId, printerId, result);
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
