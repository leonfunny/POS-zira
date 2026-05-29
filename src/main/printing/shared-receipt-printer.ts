import { PrintJobType, PrinterType, ReceiptData, SalonPrinterRole } from '../../shared/types';
import { getConfig, getSecureApiKey, getSecureAuthToken } from '../config/store';
import { ApiClient } from '../network/api-client';
import logger from '../logger';

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
    const body = {
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.RECEIPT,
      printerId,
      payload: receiptData,
      referenceType: meta.referenceType || 'RECEIPT',
      referenceId: meta.referenceId || receiptData.orderId || receiptData.orderNumber || null,
      ...(meta.openDrawer ? { openDrawer: true } : {}),
    };
    logger.info(
      `[SharedReceiptPrinter] creating ${body.referenceType || 'RECEIPT'} job for printer ${printerId} ` +
      `openDrawer=${meta.openDrawer ? 'true' : 'false'} paymentMethod=${String(receiptData.payment?.method || 'none')}`,
    );
    let drawerOpenRequested = !!meta.openDrawer;
    let result;
    try {
      result = token
        ? await client.createPrintJob(token, body).catch(async (err) => {
            if (!apiKey || !isAuthFailure(err)) throw err;
            logger.warn('[SharedReceiptPrinter] JWT print job create failed; retrying with print-agent API key');
            return client.createPrintJobWithApiKey(apiKey, body, config.machineId);
          })
        : await client.createPrintJobWithApiKey(apiKey!, body, config.machineId);
    } catch (err) {
      if (!meta.openDrawer || !isUnsupportedDrawerIntentError(err)) throw err;
      logger.warn('[SharedReceiptPrinter] Backend does not accept openDrawer yet; retrying receipt job without drawer intent');
      drawerOpenRequested = false;
      const { openDrawer: _unsupported, ...retryBody } = body;
      result = token
        ? await client.createPrintJob(token, retryBody).catch(async (retryErr) => {
            if (!apiKey || !isAuthFailure(retryErr)) throw retryErr;
            return client.createPrintJobWithApiKey(apiKey, retryBody, config.machineId);
          })
        : await client.createPrintJobWithApiKey(apiKey!, retryBody, config.machineId);
    }
    const jobId = (result.jobId || result.id) as string | undefined;
    const sent = result.sent !== false;
    logger.info(`[SharedReceiptPrinter] ${meta.source || 'receipt'} routed to shared printer ${printerId}${jobId ? ` as job ${jobId}` : ''}`);
    return { handled: true, printed: sent, sent, printerId, jobId, drawerOpenRequested };
  } catch (err: any) {
    logger.error(`[SharedReceiptPrinter] Shared receipt print failed for printer ${printerId}: ${err?.message || err}`);
    return { handled: true, printed: false, printerId, error: err?.message || String(err) };
  }
}
