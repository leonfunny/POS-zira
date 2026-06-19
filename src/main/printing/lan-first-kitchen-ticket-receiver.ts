import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { networkInterfaces } from 'os';
import type {
  AgentConfig,
  KitchenTicketData,
  LanFirstKitchenNetworkInfo,
  LanFirstPayloadHash,
  LanFirstPrintFailureClass,
  LanFirstPrintResultStatus,
  ReportLanFirstPrintResultRequest,
} from '../../shared/types';
import { PrinterType } from '../../shared/types';
import { getConfig, getSecureApiKey } from '../config/store';
import { localPrinterRepo } from '../database/repos/local-printer-repo';
import {
  lanFirstPrintAttemptRepo,
  type BeginLanFirstPrintAttemptDecision,
  type BeginLanFirstPrintAttemptInput,
} from '../database/repos/lan-first-print-attempt-repo';
import logger from '../logger';
import { ApiClient } from '../network/api-client';
import { validateLanFirstAuthHeaders } from './lan-first-auth';
import { hashLanFirstPrintPayload } from './lan-first-payload-hash';

export const DEFAULT_LAN_FIRST_KITCHEN_TICKET_PORT = 17892;

const MAX_REQUEST_BODY_BYTES = 512 * 1024;

export interface LanFirstKitchenTicketPrintRequest {
  jobId: string;
  idempotencyKey: string;
  payloadHash: LanFirstPayloadHash;
  dispatchMode: 'LAN_FIRST';
  sourceMachineId: string;
  targetMachineId: string;
  printerId: string;
  jobType: 'KITCHEN_TICKET';
  printerType: 'KITCHEN';
  referenceType: 'KITCHEN_TICKET';
  referenceId: string;
  payload: KitchenTicketData;
}

export interface LanFirstKitchenTicketReceiverStatus {
  running: boolean;
  port: number | null;
  defaultPort: number;
  error?: string;
}

interface LocalPrinterLookupRow {
  id: string;
  printer_type?: string | null;
  is_enabled?: number | boolean | null;
}

export interface LanFirstPrintAttemptLedger {
  beginPrintAttempt(input: BeginLanFirstPrintAttemptInput): Promise<BeginLanFirstPrintAttemptDecision>;
  markCompleted(input: BeginLanFirstPrintAttemptInput): Promise<unknown>;
  markFailed(input: BeginLanFirstPrintAttemptInput & {
    failureClass: LanFirstPrintFailureClass;
    errorMessage: string | null;
  }): Promise<unknown>;
}

export interface LanFirstKitchenTicketReceiverDeps {
  getConfig?: () => AgentConfig;
  ledger?: LanFirstPrintAttemptLedger;
  printKitchenTicket: (request: LanFirstKitchenTicketPrintRequest) => Promise<void>;
  getLocalPrinter?: (printerId: string) => LocalPrinterLookupRow | null;
  reportResult?: (
    request: LanFirstKitchenTicketPrintRequest,
    status: LanFirstPrintResultStatus,
    failureClass: LanFirstPrintFailureClass | null,
    errorMessage: string | null,
  ) => Promise<void>;
}

export class LanFirstSafeBeforePrintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LanFirstSafeBeforePrintError';
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function normalizeRemoteAddress(address?: string): string {
  const raw = String(address || '').trim();
  if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length);
  if (raw === '::1') return '127.0.0.1';
  return raw;
}

function isLanOrLoopbackAddress(address?: string): boolean {
  const ip = normalizeRemoteAddress(address);
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === 'localhost') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^(fc|fd|fe80):/i.test(ip)) return true;
  return false;
}

function coerceLanFirstKitchenTicketPort(
  value: unknown,
  fallback = DEFAULT_LAN_FIRST_KITCHEN_TICKET_PORT,
): number {
  const port = Number(value);
  if (Number.isInteger(port) && port >= 0 && port <= 65535) return port;
  return fallback;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', reject);
  });
}

function parseJsonBody(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body is not valid JSON');
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === 'string' ? String(input[key]).trim() : '';
}

function validateKitchenRequestShape(input: unknown): {
  request?: LanFirstKitchenTicketPrintRequest;
  error?: string;
} {
  const record = asRecord(input);
  if (!record) return { error: 'Request body must be a JSON object' };

  const request = {
    jobId: stringField(record, 'jobId'),
    idempotencyKey: stringField(record, 'idempotencyKey'),
    payloadHash: stringField(record, 'payloadHash') as LanFirstPayloadHash,
    dispatchMode: stringField(record, 'dispatchMode'),
    sourceMachineId: stringField(record, 'sourceMachineId'),
    targetMachineId: stringField(record, 'targetMachineId'),
    printerId: stringField(record, 'printerId'),
    jobType: stringField(record, 'jobType'),
    printerType: stringField(record, 'printerType'),
    referenceType: stringField(record, 'referenceType'),
    referenceId: stringField(record, 'referenceId'),
    payload: record.payload,
  };

  const requiredStringFields = [
    'jobId',
    'idempotencyKey',
    'payloadHash',
    'dispatchMode',
    'sourceMachineId',
    'targetMachineId',
    'printerId',
    'jobType',
    'printerType',
    'referenceType',
    'referenceId',
  ] as const;
  for (const field of requiredStringFields) {
    if (!request[field]) return { error: `${field} is required` };
  }

  if (request.dispatchMode !== 'LAN_FIRST') return { error: 'dispatchMode must be LAN_FIRST' };
  if (request.jobType !== 'KITCHEN_TICKET') return { error: 'jobType must be KITCHEN_TICKET' };
  if (request.printerType !== 'KITCHEN') return { error: 'printerType must be KITCHEN' };
  if (request.referenceType !== 'KITCHEN_TICKET') return { error: 'referenceType must be KITCHEN_TICKET' };
  if (!/^sha256:[a-f0-9]{64}$/.test(request.payloadHash)) return { error: 'payloadHash must be a sha256 hex digest' };

  const payload = asRecord(request.payload);
  if (!payload) return { error: 'payload must be a JSON object' };

  return { request: request as LanFirstKitchenTicketPrintRequest };
}

function validatePayloadHash(request: LanFirstKitchenTicketPrintRequest): string | null {
  let expected: LanFirstPayloadHash;
  try {
    expected = hashLanFirstPrintPayload({
      jobType: request.jobType,
      printerType: request.printerType,
      printerId: request.printerId,
      referenceType: request.referenceType,
      referenceId: request.referenceId,
      payload: request.payload,
    });
  } catch (error: any) {
    return `payloadHash could not be verified: ${error?.message || error}`;
  }

  return expected === request.payloadHash
    ? null
    : 'payloadHash does not match the request payload';
}

function validateTargetMachine(request: LanFirstKitchenTicketPrintRequest, config: AgentConfig): string | null {
  const machineId = String(config.machineId || '').trim();
  if (!machineId) return null;
  return request.targetMachineId === machineId
    ? null
    : `targetMachineId ${request.targetMachineId} does not match this machine`;
}

function validateLocalKitchenPrinter(row: LocalPrinterLookupRow | null): string | null {
  if (!row) return 'printerId is not configured locally';
  if (String(row.printer_type || '').toUpperCase() !== PrinterType.KITCHEN) {
    return 'printerId is not a KITCHEN printer';
  }
  if (row.is_enabled === 0 || row.is_enabled === false) {
    return 'printerId is disabled locally';
  }
  return null;
}

function ledgerInput(request: LanFirstKitchenTicketPrintRequest): BeginLanFirstPrintAttemptInput {
  return {
    idempotencyKey: request.idempotencyKey,
    payloadHash: request.payloadHash,
    jobId: request.jobId,
    printerId: request.printerId,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'unknown error');
}

export function getLanFirstKitchenNetworkInfo(): LanFirstKitchenNetworkInfo {
  const ips: string[] = [];
  const interfaces = networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      ips.push(entry.address);
    }
  }

  return {
    ips,
    suggestedHost: ips.find((ip) => ip.startsWith('192.168.')) || ips[0] || '127.0.0.1',
    defaultPort: DEFAULT_LAN_FIRST_KITCHEN_TICKET_PORT,
  };
}

export class LanFirstKitchenTicketReceiverService {
  private server: Server | null = null;
  private activePort: number | null = null;
  private lastError: string | undefined;
  private readonly getConfig: () => AgentConfig;
  private readonly ledger: LanFirstPrintAttemptLedger;
  private readonly getLocalPrinter: (printerId: string) => LocalPrinterLookupRow | null;
  private readonly reportResult: NonNullable<LanFirstKitchenTicketReceiverDeps['reportResult']>;

  constructor(private readonly deps: LanFirstKitchenTicketReceiverDeps) {
    this.getConfig = deps.getConfig || getConfig;
    this.ledger = deps.ledger || lanFirstPrintAttemptRepo;
    this.getLocalPrinter = deps.getLocalPrinter || ((printerId) => localPrinterRepo.getById(printerId));
    this.reportResult = deps.reportResult || ((request, status, failureClass, message) =>
      this.reportResultToBackend(request, status, failureClass, message));
  }

  async applyConfig(): Promise<void> {
    const receiverConfig = this.getConfig().lanFirstReceiver;
    if (receiverConfig?.enabled !== true) {
      await this.stop();
      return;
    }

    const sharedSecret = String(receiverConfig.auth?.sharedSecret || '').trim();
    const allowUnauthenticated = receiverConfig.auth?.allowUnauthenticated === true;
    if (!sharedSecret && !allowUnauthenticated) {
      await this.stop();
      this.lastError = 'LAN_FIRST receiver shared secret is required';
      logger.warn('[LanFirstKitchen] LAN_FIRST receiver not started: shared secret is required');
      return;
    }

    const port = coerceLanFirstKitchenTicketPort(receiverConfig.port);
    if (this.server && this.activePort === port) return;

    await this.stop();
    await this.start(port);
  }

  getStatus(): LanFirstKitchenTicketReceiverStatus {
    return {
      running: !!this.server,
      port: this.activePort,
      defaultPort: DEFAULT_LAN_FIRST_KITCHEN_TICKET_PORT,
      error: this.lastError,
    };
  }

  getNetworkInfo(): LanFirstKitchenNetworkInfo {
    return {
      ...getLanFirstKitchenNetworkInfo(),
      running: !!this.server,
      port: this.activePort,
      error: this.lastError,
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.activePort = null;
    if (!server) return;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    logger.info('[LanFirstKitchen] Stopped LAN_FIRST kitchen ticket receiver');
  }

  private async start(port: number): Promise<void> {
    this.lastError = undefined;
    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        logger.error('[LanFirstKitchen] Request failed:', error);
        sendJson(res, 500, { success: false, error: errorMessage(error) });
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', onError);
        resolve();
      });
    }).catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    });

    this.server = server;
    const address = server.address() as AddressInfo | null;
    this.activePort = address?.port ?? port;
    const receiverConfig = this.getConfig().lanFirstReceiver;
    const allowUnauthenticated = receiverConfig?.auth?.allowUnauthenticated === true;
    const authMode = allowUnauthenticated ? 'auth disabled by explicit dev flag' : 'auth enabled';
    logger.warn(`[LanFirstKitchen] LAN_FIRST kitchen ticket receiver listening on 0.0.0.0:${this.activePort}; ${authMode}`);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://lan-first-kitchen.local');
    const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress);

    if (!isLanOrLoopbackAddress(remoteAddress)) {
      logger.warn(`[LanFirstKitchen] Blocked non-LAN request from ${remoteAddress || 'unknown'}`);
      sendJson(res, 403, { success: false, error: 'LAN_FIRST receiver is only available on the local network' });
      return;
    }

    if (url.pathname === '/health') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }
      sendJson(res, 200, { success: true, ...this.getStatus() });
      return;
    }

    if (url.pathname === '/auth-test') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }

      let rawBody: string;
      try {
        rawBody = await readRequestBody(req);
      } catch (error) {
        sendJson(res, 400, { success: false, error: errorMessage(error) });
        return;
      }

      const auth = this.validateAuth(req, rawBody);
      if (!auth.ok) {
        sendJson(res, auth.statusCode, { success: false, error: auth.error });
        return;
      }

      sendJson(res, 200, { success: true, status: 'AUTH_OK', ...this.getStatus() });
      return;
    }

    if (url.pathname !== '/print/kitchen-ticket') {
      sendJson(res, 404, { success: false, error: 'Not found' });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { success: false, error: 'Method not allowed' });
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readRequestBody(req);
    } catch (error) {
      sendJson(res, 400, { success: false, error: errorMessage(error) });
      return;
    }

    const auth = this.validateAuth(req, rawBody);
    if (!auth.ok) {
      sendJson(res, auth.statusCode, { success: false, error: auth.error });
      return;
    }

    let parsed: unknown;
    try {
      parsed = parseJsonBody(rawBody);
    } catch (error) {
      sendJson(res, 400, { success: false, error: errorMessage(error) });
      return;
    }

    await this.handlePrintRequest(parsed, res, auth.sourceMachineId);
  }

  private validateAuth(
    req: IncomingMessage,
    rawBody: string,
  ): { ok: true; sourceMachineId: string } | { ok: false; statusCode: number; error: string } {
    const receiverConfig = this.getConfig().lanFirstReceiver;
    const sharedSecret = String(receiverConfig?.auth?.sharedSecret || '').trim();
    const allowUnauthenticated = receiverConfig?.auth?.allowUnauthenticated === true;

    if (sharedSecret) {
      const auth = validateLanFirstAuthHeaders({
        headers: req.headers,
        bodyJson: rawBody,
        sharedSecret,
      });
      if (!auth.ok) {
        return { ok: false, statusCode: auth.statusCode, error: auth.error };
      }
      return { ok: true, sourceMachineId: auth.sourceMachineId };
    }

    if (!allowUnauthenticated) {
      return { ok: false, statusCode: 401, error: 'LAN_FIRST auth shared secret is required' };
    }

    return { ok: true, sourceMachineId: '' };
  }

  private async handlePrintRequest(input: unknown, res: ServerResponse, authenticatedSourceMachineId = ''): Promise<void> {
    const shape = validateKitchenRequestShape(input);
    if (!shape.request) {
      sendJson(res, 400, { success: false, error: shape.error });
      return;
    }

    const request = shape.request;
    if (authenticatedSourceMachineId && request.sourceMachineId !== authenticatedSourceMachineId) {
      sendJson(res, 403, { success: false, error: 'sourceMachineId does not match LAN auth header' });
      return;
    }

    const hashError = validatePayloadHash(request);
    if (hashError) {
      sendJson(res, 400, { success: false, error: hashError });
      return;
    }

    const targetError = validateTargetMachine(request, this.getConfig());
    if (targetError) {
      sendJson(res, 403, { success: false, error: targetError });
      return;
    }

    const ledgerDecision = await this.ledger.beginPrintAttempt(ledgerInput(request));
    if (ledgerDecision.action === 'REJECT') {
      sendJson(
        res,
        ledgerDecision.reason === 'PAYLOAD_HASH_MISMATCH' ? 409 : 503,
        { success: false, error: ledgerDecision.reason, status: ledgerDecision.row?.status },
      );
      return;
    }

    if (ledgerDecision.action === 'NOOP') {
      const statusCode = ledgerDecision.status === 'PRINTING' ? 202 : ledgerDecision.status === 'COMPLETED' ? 200 : 409;
      sendJson(res, statusCode, {
        success: ledgerDecision.status !== 'FAILED',
        duplicate: true,
        status: ledgerDecision.status,
        failureClass: ledgerDecision.failureClass ?? null,
      });
      return;
    }

    const printerError = validateLocalKitchenPrinter(this.getLocalPrinter(request.printerId));
    if (printerError) {
      await this.failBeforePrint(request, printerError);
      sendJson(res, 422, {
        success: false,
        status: 'FAILED',
        failureClass: 'SAFE_BEFORE_PRINT',
        error: printerError,
      });
      return;
    }

    try {
      await this.deps.printKitchenTicket(request);
      await this.ledger.markCompleted(ledgerInput(request));
      await this.reportSafely(request, 'COMPLETED', null, null);
      sendJson(res, 200, { success: true, status: 'COMPLETED' });
    } catch (error) {
      const message = errorMessage(error);
      const failureClass: LanFirstPrintFailureClass = error instanceof LanFirstSafeBeforePrintError
        ? 'SAFE_BEFORE_PRINT'
        : 'UNCERTAIN_AFTER_PRINT';
      await this.ledger.markFailed({
        ...ledgerInput(request),
        failureClass,
        errorMessage: message,
      });
      await this.reportSafely(request, 'FAILED', failureClass, message);
      sendJson(res, 500, {
        success: false,
        status: 'FAILED',
        failureClass,
        error: message,
      });
    }
  }

  private async failBeforePrint(request: LanFirstKitchenTicketPrintRequest, message: string): Promise<void> {
    await this.ledger.markFailed({
      ...ledgerInput(request),
      failureClass: 'SAFE_BEFORE_PRINT',
      errorMessage: message,
    });
    await this.reportSafely(request, 'FAILED', 'SAFE_BEFORE_PRINT', message);
  }

  private async reportSafely(
    request: LanFirstKitchenTicketPrintRequest,
    status: LanFirstPrintResultStatus,
    failureClass: LanFirstPrintFailureClass | null,
    message: string | null,
  ): Promise<void> {
    try {
      await this.reportResult(request, status, failureClass, message);
    } catch (error) {
      logger.warn(`[LanFirstKitchen] Backend result report failed for job ${request.jobId}: ${errorMessage(error)}`);
    }
  }

  private async reportResultToBackend(
    request: LanFirstKitchenTicketPrintRequest,
    status: LanFirstPrintResultStatus,
    failureClass: LanFirstPrintFailureClass | null,
    message: string | null,
  ): Promise<void> {
    const apiKey = getSecureApiKey();
    const config = this.getConfig();
    const machineId = String(config.machineId || '').trim();
    if (!apiKey || !machineId) return;

    const body: ReportLanFirstPrintResultRequest = {
      status,
      failureClass,
      errorMessage: message,
      idempotencyKey: request.idempotencyKey,
      payloadHash: request.payloadHash,
      transport: 'LAN_DIRECT',
    };

    const client = new ApiClient(config.serverUrl || 'https://api.enail.pro');
    await client.reportLanFirstPrintResultWithApiKey(apiKey, request.jobId, body, machineId);
  }
}
