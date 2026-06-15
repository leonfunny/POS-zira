// Shared (network) kitchen printer route. Mirrors shared-fiscal-printer:
// a POS without a local kitchen printer submits a KITCHEN_TICKET job to the
// backend, which routes it to the salon's printer registered under the
// KITCHEN role (e.g. the kitchen printer plugged into POS2). Unlike fiscal,
// a kitchen ticket NEVER blocks the sale — failures surface as a cashier
// notification + the Order History reprint button.
import {
  PrintJobType,
  PrinterType,
  SalonPrinterMapping,
  SalonPrinterRole,
} from '../../shared/types';
import { getConfig, getSecureApiKey, getSecureAuthToken } from '../config/store';
import { ApiClient } from '../network/api-client';
import logger from '../logger';
import type { KitchenTicketData } from './kitchen-ticket';

const SHARED_KITCHEN_ROLE: SalonPrinterRole = 'KITCHEN';
// The customer pickup slip prints where the customer's paragon comes out —
// the printer registered under the kiosk's shared receipt role (POS1).
const SHARED_SLIP_ROLE: SalonPrinterRole = 'SELF_CHECKOUT_RECEIPT';
const ASSIGNMENT_ENDPOINT_NEGATIVE_TTL_MS = 60_000;
const KITCHEN_JOB_TIMEOUT_MS = 30_000;

let kitchenEndpointUnavailableUntil = 0;

export interface SharedKitchenPrintResult {
  handled: boolean;
  printed: boolean;
  printerId?: string;
  jobId?: string;
  status?: string;
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
  return !!(printer?.windowsPrinterName?.trim() || printer?.address?.trim());
}

function isReadyPrinterOfType(printer: SalonPrinterMapping | null | undefined, expectedType: PrinterType): printer is SalonPrinterMapping {
  return !!printer
    && String(printer.printerType || '').toUpperCase() === expectedType
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

async function resolveSharedKitchenPrinter(
  token: string | null,
  apiKey: string | null,
  role: SalonPrinterRole = SHARED_KITCHEN_ROLE,
  expectedType: PrinterType = PrinterType.KITCHEN,
): Promise<{ printerId?: string; ready: boolean; error?: string }> {
  if (Date.now() < kitchenEndpointUnavailableUntil) {
    return { ready: false, error: 'Backend printer assignment endpoint is unavailable' };
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
        logger.warn('[SharedKitchenPrinter] JWT assignment lookup failed; retrying with print-agent API key');
      }
    }
    if (!assignments && apiKey) {
      assignments = await client.listPrinterAssignmentsWithApiKey(apiKey, config.machineId);
    }
    if (!assignments) {
      logger.warn(`[SharedKitchenPrinter] ${role} assignment lookup returned no assignments`);
      return { ready: false };
    }
    printerId = assignments.assignments.find((assignment) => assignment.role === role)?.printerId;
  } catch (err: any) {
    if (isBackendContractUnavailable(err)) {
      kitchenEndpointUnavailableUntil = Date.now() + ASSIGNMENT_ENDPOINT_NEGATIVE_TTL_MS;
    }
    const error = err?.message || String(err);
    logger.warn(`[SharedKitchenPrinter] ${role} assignment lookup failed: ${error}`);
    return { ready: false, error };
  }

  if (!printerId) {
    logger.warn(`[SharedKitchenPrinter] ${role} assignment is not configured`);
    return { ready: false, error: `${role} assignment is not configured` };
  }

  try {
    const response = token
      ? await client.listSalonPrinters(token).catch(async (err) => {
          if (!apiKey || !isAuthFailure(err)) throw err;
          logger.warn('[SharedKitchenPrinter] JWT printer readiness lookup failed; retrying with print-agent API key');
          return client.listSalonPrintersWithApiKey(apiKey, {}, config.machineId);
        })
      : await client.listSalonPrintersWithApiKey(apiKey!, {}, config.machineId);
    const printer = response.printers.find((item) => item.id === printerId) || null;
    if (!isReadyPrinterOfType(printer, expectedType)) {
      const error = `${role} printer ${printerId} is not a ready ${expectedType} printer`;
      logger.warn(`[SharedKitchenPrinter] ${error}`);
      return { printerId, ready: false, error };
    }
    return { printerId, ready: true };
  } catch (err: any) {
    if (isBackendContractUnavailable(err)) {
      kitchenEndpointUnavailableUntil = Date.now() + ASSIGNMENT_ENDPOINT_NEGATIVE_TTL_MS;
    }
    const error = err?.message || String(err);
    logger.warn(`[SharedKitchenPrinter] Printer readiness lookup failed: ${error}`);
    return { printerId, ready: false, error };
  }
}

export async function submitSharedKitchenPrint(
  ticket: KitchenTicketData,
): Promise<SharedKitchenPrintResult> {
  return submitSharedPlainPrint(ticket, SHARED_KITCHEN_ROLE, PrinterType.KITCHEN);
}

/**
 * Print the customer pickup slip on the shared receipt printer (where the
 * customer's paragon comes out — POS1 at chesaigon). Payload kind must be
 * PICKUP_SLIP so the receiving POS renders the slip layout.
 */
export async function submitSharedPickupSlip(
  slip: KitchenTicketData,
): Promise<SharedKitchenPrintResult> {
  return submitSharedPlainPrint(
    { ...slip, kind: 'PICKUP_SLIP' },
    SHARED_SLIP_ROLE,
    PrinterType.RECEIPT,
  );
}

async function submitSharedPlainPrint(
  ticket: KitchenTicketData,
  role: SalonPrinterRole,
  printerType: PrinterType,
): Promise<SharedKitchenPrintResult> {
  const token = getSecureAuthToken();
  const apiKey = getSecureApiKey();
  if (!token && !apiKey) {
    logger.warn(`[SharedKitchenPrinter] Cannot submit ${role} print: missing auth token/API key`);
    return { handled: false, printed: false, error: 'missing_print_agent_auth' };
  }

  const route = await resolveSharedKitchenPrinter(token, apiKey, role, printerType);
  if (!route.printerId) {
    logger.warn(`[SharedKitchenPrinter] Cannot submit ${role} print: ${route.error || 'no assigned printer'}`);
    return { handled: false, printed: false, error: route.error };
  }
  if (!route.ready) {
    logger.warn(`[SharedKitchenPrinter] Cannot submit ${role} print to ${route.printerId}: ${route.error || 'route is not ready'}`);
    return { handled: true, printed: false, printerId: route.printerId, error: route.error || 'Kitchen printer route is not ready' };
  }

  const client = createClient();
  const body = {
    jobType: PrintJobType.KITCHEN_TICKET,
    printerType,
    printerId: route.printerId,
    waitForCompletion: true,
    timeoutMs: KITCHEN_JOB_TIMEOUT_MS,
    referenceType: 'KITCHEN_TICKET',
    referenceId: ticket.orderId,
    payload: ticket,
  };

  try {
    logger.info(`[SharedKitchenPrinter] creating KITCHEN_TICKET job for printer ${route.printerId} (order ${ticket.orderNumber})`);
    const config = getConfig();
    const result = token
      ? await client.createPrintJob(token, body).catch(async (err) => {
          if (!apiKey || !isAuthFailure(err)) throw err;
          logger.warn('[SharedKitchenPrinter] JWT job create failed; retrying with print-agent API key');
          return client.createPrintJobWithApiKey(apiKey, body, config.machineId);
        })
      : await client.createPrintJobWithApiKey(apiKey!, body, config.machineId);
    const jobId = (result.jobId || result.id) as string | undefined;
    const status = finalStatusFromResponse(result);

    if (status === 'COMPLETED') {
      logger.info(`[SharedKitchenPrinter] kitchen ticket completed on printer ${route.printerId}${jobId ? ` as job ${jobId}` : ''}`);
      return { handled: true, printed: true, printerId: route.printerId, jobId, status };
    }

    const responseMessage = result.errorMessage || result.message;
    const error = `Shared kitchen print ${status ? status.toLowerCase() : 'did not complete'}${responseMessage ? `: ${responseMessage}` : ''}`;
    logger.error(`[SharedKitchenPrinter] ${error}${jobId ? ` (${jobId})` : ''}`);
    return { handled: true, printed: false, printerId: route.printerId, jobId, status, error };
  } catch (err: any) {
    const error = err?.message || String(err);
    logger.error(`[SharedKitchenPrinter] Shared kitchen print failed for printer ${route.printerId}: ${error}`);
    return { handled: true, printed: false, printerId: route.printerId, error };
  }
}
