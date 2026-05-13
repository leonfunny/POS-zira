import { createHash } from 'crypto';
import type { DailyReportData, PrinterStatusInfo, ReceiptData } from '../../../shared/types';
import {
  fiscalAttemptRepo,
  type FiscalAttemptJournal,
  type FiscalAttemptRow,
} from '../../database/repos/fiscal-attempt-repo';
import {
  createDefaultElzabBridge,
  type ElzabBridge,
  type ElzabConnectionConfig,
  type ElzabDiagnosticCode,
  type ElzabOperationResult,
} from './elzab-bridge';

type ElzabConnectionState = 'disconnected' | 'physical_present' | 'protocol_ready';

export interface ElzabDriverOptions {
  port?: string;
  address?: string;
  baudRate?: number;
  bridge?: ElzabBridge;
  fiscalJournal?: FiscalAttemptJournal;
}

export class ElzabDriver {
  private connectionState: ElzabConnectionState = 'disconnected';
  private lastDiagnostic: { code: ElzabDiagnosticCode; detail?: string } | undefined;
  private bridge: ElzabBridge;
  private fiscalJournal: FiscalAttemptJournal;

  constructor(private options: ElzabDriverOptions) {
    this.options.baudRate = options.baudRate || 9600;
    this.bridge = options.bridge || createDefaultElzabBridge();
    this.fiscalJournal = options.fiscalJournal || fiscalAttemptRepo;
  }

  getConnectionState(): ElzabConnectionState { return this.connectionState; }
  getLastDiagnostic(): { code: ElzabDiagnosticCode; detail?: string } | undefined { return this.lastDiagnostic; }
  getPort(): string | undefined { return this.options.port; }
  getAddress(): string | undefined { return this.options.address; }

  async connect(): Promise<boolean> {
    if (!this.options.port && !this.options.address) {
      this.setFailure({
        ok: false,
        code: 'ELZAB_TARGET_MISSING',
        detail: 'ELZAB_STX requires a COM port or IP address; a Windows printer name is only a transport install and is not fiscal support.',
      });
      return false;
    }

    const availability = await this.bridge.checkAvailability();
    if (!availability.ok) {
      this.setFailure(availability);
      return false;
    }

    const result = await this.bridge.connect(this.connectionConfig());
    if (!result.ok) {
      this.setFailure(result);
      return false;
    }

    this.connectionState = 'protocol_ready';
    this.lastDiagnostic = undefined;
    return true;
  }

  disconnect(): void {
    this.connectionState = 'disconnected';
  }

  isConnected(): boolean {
    return this.connectionState === 'protocol_ready';
  }

  reconnect(newIdentifier: string): void {
    if (/^COM\d{1,3}$/i.test(newIdentifier)) {
      this.options.port = newIdentifier.toUpperCase();
      this.options.address = undefined;
    } else {
      this.options.address = newIdentifier;
      this.options.port = undefined;
    }
    this.connectionState = 'disconnected';
  }

  async healthCheck(): Promise<boolean> {
    if (!this.options.port && !this.options.address) {
      this.setFailure({
        ok: false,
        code: 'ELZAB_TARGET_MISSING',
        detail: 'ELZAB_STX requires a COM port or IP address.',
      });
      return false;
    }

    const availability = await this.bridge.checkAvailability();
    if (!availability.ok) {
      this.setFailure(availability);
      return false;
    }

    const status = await this.bridge.getStatus(this.connectionConfig());
    if (!status.ok) {
      this.setFailure(status);
      return false;
    }

    this.connectionState = 'protocol_ready';
    this.lastDiagnostic = undefined;
    return true;
  }

  async printTest(): Promise<void> {
    this.assertConnected();
    await this.requireOk(await this.bridge.printTest(this.connectionConfig()), 'ELZAB_STX test print failed');
  }

  async printReceipt(data: ReceiptData): Promise<void> {
    this.assertConnected();
    const context = this.createReceiptAttempt(data);

    try {
      this.assertRealFiscalAllowed('receipt');
    } catch (error: any) {
      this.fiscalJournal.markBlocked(context.attempt.id, 'REAL_FISCAL_PRINT_DISABLED', {
        detail: error?.message || String(error),
      });
      throw error;
    }

    this.fiscalJournal.markSent(context.attempt.id);

    let result: ElzabOperationResult;
    try {
      result = await this.bridge.printReceipt(this.connectionConfig(), data);
    } catch (error: any) {
      this.fiscalJournal.markUnknown(context.attempt.id, 'ELZAB_BRIDGE_THROWN_AFTER_SENT', {
        detail: error?.message || String(error),
      });
      throw new Error(`FISCAL_RESULT_UNKNOWN: ELZAB_STX receipt result is unknown after bridge error: ${error?.message || String(error)}`);
    }

    if (result.ok) {
      this.fiscalJournal.markSuccess(context.attempt.id, result);
      return;
    }

    const code = result.code || 'ELZAB_COMMAND_FAILED';
    if (this.isAmbiguousAfterSent(result)) {
      this.fiscalJournal.markUnknown(context.attempt.id, code, result);
      this.setFailure(result);
      throw new Error(`FISCAL_RESULT_UNKNOWN: ELZAB_STX receipt result is unknown after ${code}${result.detail ? `: ${result.detail}` : ''}`);
    }

    this.fiscalJournal.markFailed(context.attempt.id, code, result);
    await this.requireOk(result, 'ELZAB_STX fiscal receipt failed');
  }

  async printDailyReport(data: DailyReportData): Promise<void> {
    await this.printReport('DAILY', data);
  }

  async printXReport(data: DailyReportData): Promise<void> {
    await this.printReport('X', data);
  }

  async printZReport(data: DailyReportData): Promise<void> {
    await this.printReport('Z', data);
  }

  async openDrawer(): Promise<void> {
    throw new Error('ELZAB_STX cash drawer command is not wired. Use the vendor sidecar only after it implements this fiscal-printer operation.');
  }

  async getStatus(): Promise<PrinterStatusInfo> {
    return {
      connected: this.isConnected(),
      type: 'ELZAB',
      port: this.options.port,
      protocol: 'ELZAB_STX',
      connectionType: this.options.port ? 'USB_CDC_COM' : 'RNDIS_OR_TCP',
      connectionState: this.connectionState,
      diagnostic: this.lastDiagnostic,
    };
  }

  private async printReport(kind: 'DAILY' | 'X' | 'Z', data: DailyReportData): Promise<void> {
    this.assertConnected();
    this.assertRealFiscalAllowed(`${kind} report`);
    if (!this.bridge.printReport) {
      throw new Error(`ELZAB_STX ${kind} report is not implemented until the official sidecar supports it.`);
    }
    await this.requireOk(
      await this.bridge.printReport(this.connectionConfig(), kind, data),
      `ELZAB_STX ${kind} report failed`,
    );
  }

  private connectionConfig(): ElzabConnectionConfig {
    return {
      protocol: 'ELZAB_STX',
      port: this.options.port,
      address: this.options.address,
      baudRate: this.options.baudRate || 9600,
    };
  }

  private createReceiptAttempt(data: ReceiptData): { attempt: FiscalAttemptRow } {
    const orderId = (data.orderId || data.orderNumber || '').trim();
    const paymentId = data.paymentId?.trim() || null;
    if (!orderId) {
      const detail = 'ELZAB_STX fiscal receipt requires ReceiptData.orderId or orderNumber for idempotency.';
      this.lastDiagnostic = { code: 'FISCAL_IDEMPOTENCY_KEY_MISSING', detail };
      throw new Error(`FISCAL_IDEMPOTENCY_KEY_MISSING: ${detail}`);
    }

    const blocking = this.fiscalJournal.findBlockingAttempt(orderId, paymentId);
    if (blocking) {
      const detail = `Existing fiscal attempt ${blocking.id} for order ${orderId} is ${blocking.status}; automatic retry is blocked.`;
      this.lastDiagnostic = { code: 'FISCAL_ATTEMPT_RETRY_BLOCKED', detail };
      throw new Error(`FISCAL_ATTEMPT_RETRY_BLOCKED: ${detail}`);
    }

    const payloadJson = stableStringify(data);
    const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
    const attemptNo = this.fiscalJournal.getNextAttemptNo(orderId, paymentId);
    const idempotencyKey = `${orderId}:${paymentId || 'default'}:${attemptNo}`;

    return {
      attempt: this.fiscalJournal.createPending({
        orderId,
        paymentId,
        attemptNo,
        idempotencyKey,
        printerType: 'FISCAL',
        payloadJson,
        payloadHash,
      }),
    };
  }

  private isAmbiguousAfterSent(result: ElzabOperationResult): boolean {
    const code = result.code || 'ELZAB_COMMAND_FAILED';
    if (code === 'ELZAB_BRIDGE_BAD_RESPONSE' || code === 'ELZAB_COMMAND_FAILED') return true;
    const detail = (result.detail || '').toLowerCase();
    return /timeout|timed out|etimedout|econnreset|econnaborted|broken pipe|crash|exited|killed/.test(detail);
  }

  private assertRealFiscalAllowed(operation: string): void {
    if (process.env.ALLOW_REAL_FISCAL_PRINT === 'true') return;
    const detail = `Real ELZAB fiscal ${operation} is disabled. Set ALLOW_REAL_FISCAL_PRINT=true only during controlled production go-live.`;
    this.lastDiagnostic = { code: 'REAL_FISCAL_PRINT_DISABLED', detail };
    throw new Error(`REAL_FISCAL_PRINT_DISABLED: ${detail}`);
  }

  private assertConnected(): void {
    if (this.isConnected()) return;
    const detail = this.lastDiagnostic?.detail || 'ELZAB_STX sidecar/hardware is not connected.';
    const code = this.lastDiagnostic?.code || 'ELZAB_PROTOCOL_NOT_READY';
    throw new Error(`${code}: ${detail}`);
  }

  private async requireOk(result: ElzabOperationResult, prefix: string): Promise<void> {
    if (result.ok) return;
    this.setFailure(result);
    throw new Error(`${prefix}: ${result.code || 'ELZAB_COMMAND_FAILED'}${result.detail ? `: ${result.detail}` : ''}`);
  }

  private setFailure(result: ElzabOperationResult): void {
    const code = result.code || 'ELZAB_COMMAND_FAILED';
    this.lastDiagnostic = { code, detail: result.detail };
    this.connectionState = code === 'ELZAB_PROTOCOL_NOT_READY' ? 'physical_present' : 'disconnected';
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableStringify);
  if (!value || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortForStableStringify((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
