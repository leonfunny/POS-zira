import {
  PrintJobType,
  PrinterType,
  ReceiptData,
  SalonPrinterMapping,
  SalonPrinterRole,
} from '../../shared/types';
import { getConfig, getSecureApiKey, getSecureAuthToken } from '../config/store';
import { ApiClient } from '../network/api-client';
import logger from '../logger';

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

function createClient(): ApiClient {
  const config = getConfig();
  return new ApiClient(config.serverUrl || 'https://api.enail.pro');
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
  const body = {
    jobType: PrintJobType.RECEIPT,
    printerType: PrinterType.FISCAL,
    printerId: route.printerId,
    waitForCompletion: true,
    timeoutMs: FISCAL_JOB_TIMEOUT_MS,
    referenceType: meta.referenceType || 'POS_FISCAL_RECEIPT',
    referenceId: meta.referenceId || receiptData.orderId || receiptData.orderNumber || null,
    payload: receiptData,
  };

  try {
    logger.info(
      `[SharedFiscalPrinter] creating POS_FISCAL_RECEIPT job for fiscal printer ${route.printerId} ` +
      `paymentMethod=${String(receiptData.payment?.method || 'none')}`,
    );
    const config = getConfig();
    const result = token
      ? await client.createPrintJob(token, body).catch(async (err) => {
          if (!apiKey || !isAuthFailure(err)) throw err;
          logger.warn('[SharedFiscalPrinter] JWT fiscal job create failed; retrying with print-agent API key');
          return client.createPrintJobWithApiKey(apiKey, body, config.machineId);
        })
      : await client.createPrintJobWithApiKey(apiKey!, body, config.machineId);
    const jobId = (result.jobId || result.id) as string | undefined;
    const status = finalStatusFromResponse(result);

    if (status === 'COMPLETED') {
      logger.info(`[SharedFiscalPrinter] fiscal receipt completed on shared printer ${route.printerId}${jobId ? ` as job ${jobId}` : ''}`);
      return { handled: true, printed: true, printerId: route.printerId, jobId, status };
    }

    const finalFailure = status === 'FAILED' || status === 'TIMEOUT' || status === 'CANCELLED';
    const responseMessage = result.errorMessage || result.message;
    const error = finalFailure
      ? `Shared fiscal print ${status.toLowerCase()}${responseMessage ? `: ${responseMessage}` : ''}`
      : 'Backend did not return final COMPLETED status for fiscal receipt job';
    logger.error(`[SharedFiscalPrinter] ${error}${jobId ? ` (${jobId})` : ''}`);
    return { handled: true, printed: false, printerId: route.printerId, jobId, status, error };
  } catch (err: any) {
    const error = err?.message || String(err);
    logger.error(`[SharedFiscalPrinter] Shared fiscal print failed for printer ${route.printerId}: ${error}`);
    return { handled: true, printed: false, printerId: route.printerId, error };
  }
}
