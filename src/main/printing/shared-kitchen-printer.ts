// Shared (network) kitchen printer route. Mirrors shared-fiscal-printer:
// a POS without a local kitchen printer submits a KITCHEN_TICKET job to the
// backend, which routes it to the salon's printer registered under the
// KITCHEN role (e.g. the kitchen printer plugged into POS2). Unlike fiscal,
// a kitchen ticket NEVER blocks the sale — failures surface as a cashier
// notification + the Order History reprint button.
import { randomUUID } from 'crypto';
import {
  type DispatchLanFirstPrintJobRequest,
  PrintJobType,
  PrinterType,
  type ReserveLanFirstPrintJobRequest,
  type SalonPrinterMapping,
  type SalonPrinterRole,
} from '../../shared/types';
import { getConfig, getSecureApiKey, getSecureAuthToken } from '../config/store';
import { ApiClient } from '../network/api-client';
import logger from '../logger';
import type { KitchenTicketData } from './kitchen-ticket';
import { hashLanFirstPrintPayload } from './lan-first-payload-hash';

const SHARED_KITCHEN_ROLE: SalonPrinterRole = 'KITCHEN';
// The customer pickup slip prints where the customer's paragon comes out —
// the printer registered under the kiosk's shared receipt role (POS1).
const SHARED_SLIP_ROLE: SalonPrinterRole = 'SELF_CHECKOUT_RECEIPT';
const ASSIGNMENT_ENDPOINT_NEGATIVE_TTL_MS = 60_000;
const SHARED_PLAIN_JOB_TIMEOUT_MS = 30_000;
const LAN_FIRST_DEFAULT_TIMEOUT_MS = 2000;

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || 'Unknown error');
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

function isFailedPrintStatus(status: string): boolean {
  return ['FAILED', 'TIMEOUT', 'CANCELLED', 'ERROR'].includes(status);
}

function targetFromConfig(
  printer: SalonPrinterMapping,
): { host: string; port: number; timeoutMs?: number } | null {
  const senderConfig = getConfig().lanFirstKitchenSender;
  const targets = senderConfig?.targets || {};
  const keys = [
    printer.machineId && printer.id ? `${printer.machineId}:${printer.id}` : '',
    printer.id,
    printer.machineId || '',
  ].filter(Boolean);

  for (const key of keys) {
    const target = targets[key];
    const host = typeof target?.host === 'string' ? target.host.trim() : '';
    const port = Number(target?.port);
    if (host && Number.isFinite(port) && port > 0) {
      return { host, port, timeoutMs: target.timeoutMs };
    }
  }
  return null;
}

async function readLanJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function resolveSharedKitchenPrinter(
  token: string | null,
  apiKey: string | null,
  role: SalonPrinterRole = SHARED_KITCHEN_ROLE,
  expectedType: PrinterType = PrinterType.KITCHEN,
): Promise<{ printerId?: string; printer?: SalonPrinterMapping; ready: boolean; error?: string }> {
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
    return { printerId, printer, ready: true };
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
  return submitSharedPlainPrint(ticket, SHARED_KITCHEN_ROLE, PrinterType.KITCHEN, false);
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
    true,
  );
}

async function dispatchLanFirstFallback(
  client: ApiClient,
  apiKey: string,
  reserveBody: ReserveLanFirstPrintJobRequest,
  reason: string,
): Promise<SharedKitchenPrintResult> {
  const machineId = reserveBody.sourceMachineId;
  const body: DispatchLanFirstPrintJobRequest = {
    idempotencyKey: reserveBody.idempotencyKey,
    payloadHash: reserveBody.payloadHash,
    dispatchMode: 'LAN_FIRST',
    sourceMachineId: reserveBody.sourceMachineId,
    targetMachineId: reserveBody.targetMachineId,
    printerId: reserveBody.printerId,
    reason,
  };
  const result = await client.dispatchLanFirstPrintJobWithApiKey(apiKey, reserveBody.jobId, body, machineId);
  const status = finalStatusFromResponse(result) || 'SENT';
  const sent = result.sent !== false;
  const failedStatus = isFailedPrintStatus(status);

  return {
    handled: true,
    printed: sent && !failedStatus,
    printerId: reserveBody.printerId,
    jobId: reserveBody.jobId,
    status,
    error: sent && !failedStatus ? undefined : String(result.errorMessage || result.message || 'Backend dispatch was not accepted'),
  };
}

async function postLanFirstKitchenTicket(
  target: { host: string; port: number; timeoutMs?: number },
  timeoutMs: number,
  body: ReserveLanFirstPrintJobRequest,
): Promise<
  | { action: 'ACCEPTED'; status: string }
  | { action: 'FALLBACK'; reason: string }
  | { action: 'FAILED_NO_FALLBACK'; status: string; error?: string }
> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
    : null;

  try {
    const response = await fetch(`http://${target.host}:${target.port}/print/kitchen-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });
    const json = await readLanJson(response);
    const status = String(json.status || '').toUpperCase();
    const failureClass = String(json.failureClass || '').toUpperCase();

    if (status === 'COMPLETED' || status === 'PRINTING') {
      return { action: 'ACCEPTED', status };
    }
    if (failureClass === 'SAFE_BEFORE_PRINT') {
      return { action: 'FALLBACK', reason: 'LAN_SAFE_BEFORE_PRINT' };
    }
    if (String(json.error || '').toUpperCase() === 'LEDGER_NOT_DURABLE') {
      return { action: 'FALLBACK', reason: 'LAN_LEDGER_NOT_DURABLE' };
    }
    if (failureClass === 'UNCERTAIN_AFTER_PRINT' || failureClass === 'FINAL') {
      return {
        action: 'FAILED_NO_FALLBACK',
        status: status || 'FAILED',
        error: String(json.error || json.message || 'LAN print failed after print may have started'),
      };
    }
    if (!response.ok) {
      return { action: 'FALLBACK', reason: `LAN_HTTP_${response.status}` };
    }

    return { action: 'FALLBACK', reason: 'LAN_UNEXPECTED_RESPONSE' };
  } catch {
    return { action: 'FALLBACK', reason: 'LAN_NETWORK_ERROR' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function submitLanFirstKitchenPrint(
  client: ApiClient,
  apiKey: string,
  ticket: KitchenTicketData,
  route: { printerId: string; printer: SalonPrinterMapping },
): Promise<SharedKitchenPrintResult> {
  const config = getConfig();
  const sourceMachineId = String(config.machineId || '').trim();
  const targetMachineId = String(route.printer.machineId || '').trim();

  if (!sourceMachineId || !targetMachineId) {
    logger.warn('[SharedKitchenPrinter] LAN_FIRST sender missing source or target machine ID; falling back to existing backend create-job path');
    return { handled: false, printed: false, printerId: route.printerId, error: 'missing_lan_first_machine_id' };
  }

  const target = targetFromConfig(route.printer);
  if (!target) {
    logger.warn(`[SharedKitchenPrinter] LAN_FIRST sender has no LAN target for ${targetMachineId}:${route.printerId}; falling back to existing backend print path`);
    return { handled: false, printed: false, printerId: route.printerId, error: 'missing_lan_first_target' };
  }

  const hashInput = {
    jobType: 'KITCHEN_TICKET' as const,
    printerType: 'KITCHEN' as const,
    printerId: route.printerId,
    referenceType: 'KITCHEN_TICKET' as const,
    referenceId: ticket.orderId,
    payload: ticket,
  };
  const payloadHash = hashLanFirstPrintPayload(hashInput);
  const reserveBody: ReserveLanFirstPrintJobRequest = {
    ...hashInput,
    jobId: randomUUID(),
    idempotencyKey: ticket.isReprint
      ? `kitchen-ticket-reprint:${ticket.orderId}:${route.printerId}:${randomUUID()}`
      : `kitchen-ticket:${ticket.orderId}:${route.printerId}:${payloadHash}`,
    payloadHash,
    dispatchMode: 'LAN_FIRST',
    sourceMachineId,
    targetMachineId,
  };

  let reserved: Record<string, unknown>;
  try {
    reserved = await client.reserveLanFirstPrintJobWithApiKey(apiKey, reserveBody, sourceMachineId);
  } catch (err) {
    const message = errorMessage(err);
    logger.warn(`[SharedKitchenPrinter] LAN_FIRST reserve failed before LAN print attempt; falling back to existing backend print path: ${message}`);
    return { handled: false, printed: false, printerId: route.printerId, error: message };
  }

  const activeBody: ReserveLanFirstPrintJobRequest = {
    ...reserveBody,
    jobId: String(reserved.jobId || reserved.id || reserveBody.jobId),
  };

  const timeoutMs = Number(target.timeoutMs || config.lanFirstKitchenSender?.timeoutMs || LAN_FIRST_DEFAULT_TIMEOUT_MS);
  const lanResult = await postLanFirstKitchenTicket(target, timeoutMs, activeBody);
  if (lanResult.action === 'ACCEPTED') {
    return {
      handled: true,
      printed: true,
      printerId: route.printerId,
      jobId: activeBody.jobId,
      status: lanResult.status,
    };
  }
  if (lanResult.action === 'FALLBACK') {
    try {
      return await dispatchLanFirstFallback(client, apiKey, activeBody, lanResult.reason);
    } catch (err) {
      const message = errorMessage(err);
      logger.warn(`[SharedKitchenPrinter] LAN_FIRST backend dispatch failed after LAN attempt; not falling back to old create-job path: ${message}`);
      return {
        handled: true,
        printed: false,
        printerId: route.printerId,
        jobId: activeBody.jobId,
        status: 'FAILED',
        error: message,
      };
    }
  }

  return {
    handled: true,
    printed: false,
    printerId: route.printerId,
    jobId: activeBody.jobId,
    status: lanResult.status,
    error: lanResult.error,
  };
}

async function submitSharedPlainPrint(
  ticket: KitchenTicketData,
  role: SalonPrinterRole,
  printerType: PrinterType,
  waitForCompletion: boolean,
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
  const config = getConfig();
  if (
    role === SHARED_KITCHEN_ROLE &&
    printerType === PrinterType.KITCHEN &&
    config.lanFirstKitchenSender?.enabled === true &&
    apiKey &&
    route.printer
  ) {
    const lanFirstResult = await submitLanFirstKitchenPrint(client, apiKey, ticket, {
      printerId: route.printerId,
      printer: route.printer,
    });
    if (lanFirstResult.handled) return lanFirstResult;
  }

  const body = {
    jobType: PrintJobType.KITCHEN_TICKET,
    printerType,
    printerId: route.printerId,
    waitForCompletion,
    ...(waitForCompletion ? { timeoutMs: SHARED_PLAIN_JOB_TIMEOUT_MS } : {}),
    referenceType: 'KITCHEN_TICKET',
    referenceId: ticket.orderId,
    payload: ticket,
  };

  try {
    logger.info(`[SharedKitchenPrinter] creating KITCHEN_TICKET job for printer ${route.printerId} (order ${ticket.orderNumber})`);
    const result = token
      ? await client.createPrintJob(token, body).catch(async (err) => {
          if (!apiKey || !isAuthFailure(err)) throw err;
          logger.warn('[SharedKitchenPrinter] JWT job create failed; retrying with print-agent API key');
          return client.createPrintJobWithApiKey(apiKey, body, config.machineId);
        })
      : await client.createPrintJobWithApiKey(apiKey!, body, config.machineId);
    const jobId = (result.jobId || result.id) as string | undefined;
    const status = finalStatusFromResponse(result);
    const sent = result.sent !== false;
    const failedStatus = ['FAILED', 'TIMEOUT', 'CANCELLED', 'ERROR'].includes(status);

    if (sent && !failedStatus) {
      const acceptedStatus = status || 'SENT';
      logger.info(`[SharedKitchenPrinter] kitchen ticket accepted on printer ${route.printerId}${jobId ? ` as job ${jobId}` : ''}`);
      return { handled: true, printed: true, printerId: route.printerId, jobId, status: acceptedStatus };
    }

    const responseMessage = result.errorMessage || result.message;
    const error = `Shared kitchen print ${status ? status.toLowerCase() : 'was not accepted'}${responseMessage ? `: ${responseMessage}` : ''}`;
    logger.error(`[SharedKitchenPrinter] ${error}${jobId ? ` (${jobId})` : ''}`);
    return { handled: true, printed: false, printerId: route.printerId, jobId, status, error };
  } catch (err: any) {
    const error = err?.message || String(err);
    logger.error(`[SharedKitchenPrinter] Shared kitchen print failed for printer ${route.printerId}: ${error}`);
    return { handled: true, printed: false, printerId: route.printerId, error };
  }
}
