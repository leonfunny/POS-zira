import { PrintJobType, PrinterType, ReceiptData, SalonPrinterRole } from '../../shared/types';
import { getConfig, getSecureAuthToken } from '../config/store';
import { ApiClient } from '../network/api-client';
import logger from '../logger';

const SHARED_RECEIPT_ROLE: SalonPrinterRole = 'SELF_CHECKOUT_RECEIPT';
const ASSIGNMENT_ENDPOINT_NEGATIVE_TTL_MS = 60_000;

let assignmentEndpointUnavailableUntil = 0;

function isEndpointUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return /\b(404|501)\b/.test(message);
}

export interface SharedReceiptPrintMeta {
  referenceType?: string;
  referenceId?: string;
  source?: string;
}

export interface SharedReceiptPrintResult {
  handled: boolean;
  printed: boolean;
  printerId?: string;
  jobId?: string;
  sent?: boolean;
  error?: string;
}

export async function submitSharedReceiptPrint(
  receiptData: ReceiptData,
  meta: SharedReceiptPrintMeta = {},
): Promise<SharedReceiptPrintResult> {
  const token = getSecureAuthToken();
  if (!token) return { handled: false, printed: false };

  if (Date.now() < assignmentEndpointUnavailableUntil) {
    return { handled: false, printed: false };
  }

  const config = getConfig();
  const client = new ApiClient(config.serverUrl || 'https://api.enail.pro');

  let printerId: string | undefined;
  try {
    const response = await client.listPrinterAssignments(token);
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
    const result = await client.createPrintJob(token, {
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.RECEIPT,
      printerId,
      payload: receiptData,
      referenceType: meta.referenceType || 'RECEIPT',
      referenceId: meta.referenceId || receiptData.orderId || receiptData.orderNumber || null,
    });
    const jobId = (result.jobId || result.id) as string | undefined;
    const sent = result.sent !== false;
    logger.info(`[SharedReceiptPrinter] ${meta.source || 'receipt'} routed to shared printer ${printerId}${jobId ? ` as job ${jobId}` : ''}`);
    return { handled: true, printed: sent, sent, printerId, jobId };
  } catch (err: any) {
    logger.error(`[SharedReceiptPrinter] Shared receipt print failed for printer ${printerId}: ${err?.message || err}`);
    return { handled: true, printed: false, printerId, error: err?.message || String(err) };
  }
}
