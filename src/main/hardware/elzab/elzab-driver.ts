import { createHash } from 'crypto';
import type { DailyReportData, PrinterStatusInfo, ReceiptData } from '../../../shared/types';
import { toFiscalSafeItemName, toFiscalSafeText } from '../../../shared/fiscal-text';
import {
  fiscalAttemptRepo,
  type FiscalAttemptJournal,
  type FiscalAttemptRow,
} from '../../database/repos/fiscal-attempt-repo';
import logger from '../../logger';
import { listSerialPorts, getVidForPort } from '../port-utils';
import {
  createDefaultElzabBridge,
  isRealFiscalPrintEnabled,
  type ElzabBridge,
  type ElzabConnectionConfig,
  type ElzabDiagnosticCode,
  type ElzabOperationResult,
} from './elzab-bridge';

// ELZAB Zeta Online enumerates its USB-CDC serial interface under this USB
// Vendor ID (see BRAND_PATTERNS). Used to re-locate the fiscal COM port when a
// USB re-enumeration moves it off the configured number.
const ELZAB_USB_VID = 'C1CA';

type ElzabConnectionState = 'disconnected' | 'physical_present' | 'protocol_ready';

function toFiscalSafeReceiptData(data: ReceiptData): ReceiptData {
  return {
    ...data,
    items: data.items.map((item) => {
      const unit = item.unit === undefined ? undefined : toFiscalSafeText(item.unit).slice(0, 4).trim();
      return {
        ...item,
        name: toFiscalSafeItemName(item.name),
        unit: unit || undefined,
      };
    }),
  };
}

export interface ElzabDriverOptions {
  port?: string;
  address?: string;
  baudRate?: number;
  bridge?: ElzabBridge;
  fiscalJournal?: FiscalAttemptJournal;
  // Injectable for deterministic tests; default to the real PnP-backed scanners.
  listSerialPortsFn?: () => Promise<string[]>;
  getVidForPortFn?: (port: string) => Promise<string | null>;
  // P6: fired when a receipt attempt ends in an ambiguous (UNKNOWN) state so the
  // POS can alert the cashier to reconcile immediately. Best-effort, never throws.
  onFiscalUnknown?: (info: { orderId?: string; orderNumber?: string; code: string; detail?: string }) => void;
}

export class ElzabDriver {
  private connectionState: ElzabConnectionState = 'disconnected';
  private lastDiagnostic: { code: ElzabDiagnosticCode; detail?: string } | undefined;
  private bridge: ElzabBridge;
  private fiscalJournal: FiscalAttemptJournal;
  private listSerialPortsFn: () => Promise<string[]>;
  private getVidForPortFn: (port: string) => Promise<string | null>;

  constructor(private options: ElzabDriverOptions) {
    this.options.baudRate = options.baudRate || 9600;
    this.bridge = options.bridge || createDefaultElzabBridge();
    this.fiscalJournal = options.fiscalJournal || fiscalAttemptRepo;
    this.listSerialPortsFn = options.listSerialPortsFn || listSerialPorts;
    this.getVidForPortFn = options.getVidForPortFn || getVidForPort;
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

    // P2: a flaky USB-serial link can drop/re-enumerate mid-connect. Retry the
    // COM path once after re-resolving the port; IP targets don't re-scan.
    const maxAttempts = this.options.port ? 2 : 1;
    let result: ElzabOperationResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.options.port) await this.resolveElzabPort();
      result = await this.bridge.connect(this.connectionConfig());
      if (result.ok) {
        this.connectionState = 'protocol_ready';
        this.lastDiagnostic = undefined;
        logger.info(`[ElzabDriver] Connected to ${this.options.port || this.options.address} via ELZAB_STX sidecar`);
        return true;
      }
      if (attempt < maxAttempts) {
        logger.warn(`[ElzabDriver] connect attempt ${attempt}/${maxAttempts} failed (${result.code}); re-scanning port and retrying`);
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    if (result) this.setFailure(result);
    return false;
  }

  /**
   * P1: re-point the fiscal COM port to the live ELZAB device when the
   * configured port is no longer present (USB re-enumeration moved it, e.g.
   * COM3 → COM4). Only switches when the configured port is ABSENT and another
   * present port hosts the ELZAB USB VID, so it can never steal a working port
   * or send fiscal commands to an unrelated serial device. No-op for IP targets.
   */
  private notifyUnknown(data: ReceiptData, code: string, detail?: string): void {
    try {
      this.options.onFiscalUnknown?.({ orderId: data.orderId, orderNumber: data.orderNumber, code, detail });
    } catch (e: any) {
      logger.warn(`[ElzabDriver] onFiscalUnknown handler threw (ignored): ${e?.message ?? e}`);
    }
  }

  private async resolveElzabPort(): Promise<void> {
    const configured = this.options.port;
    if (!configured) return;
    try {
      const present = await this.listSerialPortsFn();
      if (present.includes(configured.toUpperCase())) return; // configured port still live → keep it
      for (const candidate of present) {
        const vid = await this.getVidForPortFn(candidate);
        if (vid === ELZAB_USB_VID) {
          logger.warn(`[ElzabDriver] Configured fiscal port ${configured} not present; ELZAB (VID ${ELZAB_USB_VID}) found on ${candidate} — using ${candidate} for this connection.`);
          this.options.port = candidate;
          return;
        }
      }
      logger.warn(`[ElzabDriver] Configured fiscal port ${configured} absent and no ELZAB (VID ${ELZAB_USB_VID}) device among present ports [${present.join(', ') || 'none'}].`);
    } catch (e: any) {
      logger.warn(`[ElzabDriver] resolveElzabPort scan failed: ${e?.message ?? e}`);
    }
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
    const fiscalData = toFiscalSafeReceiptData(data);
    if (fiscalData.items.some((item) => Number(item.allocatedDiscount || 0) > 0)) {
      const detail =
        'This ELZAB sidecar exposes only a whole-receipt discount and cannot preserve frozen Billiard discounts per VAT line. ' +
        'No fiscal command was sent. Use an accepted POSNET line-discount path or remove the allocated discount.';
      this.lastDiagnostic = { code: 'ELZAB_LINE_DISCOUNT_UNSUPPORTED', detail };
      throw new Error(`ELZAB_LINE_DISCOUNT_UNSUPPORTED: ${detail}`);
    }
    // The sidecar rejects non-positive unit prices only after ReceiptBegin,
    // which strands the attempt in UNKNOWN_NEEDS_RECONCILIATION (2026-07-20
    // 'Koperek' incident). Refuse here, before any attempt or sidecar I/O,
    // so the failure is definite and the order copy can still print.
    const zeroPriced = fiscalData.items.find((item) => !(Number(item.unitPrice) > 0));
    if (zeroPriced) {
      const detail =
        `Receipt item '${zeroPriced.name}' has a non-positive unit price and cannot be fiscalized. ` +
        'No fiscal command was sent. Print the non-fiscal order copy instead or fix the item price.';
      this.lastDiagnostic = { code: 'ELZAB_UNSUPPORTED_OPERATION', detail };
      throw new Error(`ELZAB_UNSUPPORTED_OPERATION: ${detail}`);
    }
    const context = this.createReceiptAttempt(fiscalData);

    try {
      this.assertRealFiscalAllowed('receipt');
    } catch (error: any) {
      this.fiscalJournal.markBlocked(context.attempt.id, 'REAL_FISCAL_PRINT_DISABLED', {
        detail: error?.message || String(error),
      });
      await this.flushFiscalJournal('safety-gate');
      throw error;
    }

    this.fiscalJournal.markSent(context.attempt.id);
    const sentFlush = await this.flushFiscalJournal('before-send');
    if (!sentFlush.success) {
      const detail =
        `ELZAB fiscal attempt ${context.attempt.id} could not be persisted before sidecar I/O: ${sentFlush.error || 'unknown durability error'}. No fiscal command was sent.`;
      this.fiscalJournal.markFailed(context.attempt.id, 'FISCAL_JOURNAL_UNAVAILABLE', { detail });
      await this.flushFiscalJournal('before-send-failure');
      this.lastDiagnostic = { code: 'FISCAL_JOURNAL_UNAVAILABLE', detail };
      throw new Error(`FISCAL_JOURNAL_UNAVAILABLE: ${detail}`);
    }

    let result: ElzabOperationResult;
    try {
      result = await this.bridge.printReceipt(this.connectionConfig(), fiscalData);
    } catch (error: any) {
      const detail = error?.message || String(error);
      this.fiscalJournal.markUnknown(context.attempt.id, 'ELZAB_BRIDGE_THROWN_AFTER_SENT', { detail });
      await this.flushFiscalJournal('unknown-bridge-outcome');
      this.notifyUnknown(fiscalData, 'ELZAB_BRIDGE_THROWN_AFTER_SENT', detail);
      throw new Error(`FISCAL_RESULT_UNKNOWN: ELZAB_STX receipt result is unknown after bridge error: ${detail}`);
    }

    if (result.ok) {
      this.fiscalJournal.markSuccess(context.attempt.id, result);
      const outcomeFlush = await this.flushFiscalJournal('confirmed-success');
      if (!outcomeFlush.success) {
        const detail =
          `ELZAB confirmed the receipt, but its fiscal result could not be persisted: ${outcomeFlush.error || 'unknown durability error'}. Do not print again; reconcile this order.`;
        this.fiscalJournal.markUnknown(context.attempt.id, 'FISCAL_OUTCOME_DURABILITY_FAILED', { detail });
        await this.flushFiscalJournal('confirmed-success-reconciliation');
        this.lastDiagnostic = { code: 'FISCAL_JOURNAL_UNAVAILABLE', detail };
        this.notifyUnknown(fiscalData, 'FISCAL_OUTCOME_DURABILITY_FAILED', detail);
        throw new Error(`FISCAL_RESULT_UNKNOWN: ${detail}`);
      }
      return;
    }

    const code = result.code || 'ELZAB_COMMAND_FAILED';
    if (this.isAmbiguousAfterSent(result)) {
      this.fiscalJournal.markUnknown(context.attempt.id, code, result);
      await this.flushFiscalJournal('unknown-command-outcome');
      this.setFailure(result);
      this.notifyUnknown(fiscalData, code, result.detail);
      throw new Error(`FISCAL_RESULT_UNKNOWN: ELZAB_STX receipt result is unknown after ${code}${result.detail ? `: ${result.detail}` : ''}`);
    }

    this.fiscalJournal.markFailed(context.attempt.id, code, result);
    await this.flushFiscalJournal('confirmed-command-failure');
    await this.requireOk(result, 'ELZAB_STX fiscal receipt failed');
  }

  private async flushFiscalJournal(stage: string): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await this.fiscalJournal.flush();
      if (!result.success) {
        logger.error(`[ElzabDriver] Fiscal journal flush failed at ${stage}: ${result.error || 'unknown error'}`);
      }
      return result;
    } catch (error: any) {
      const detail = error?.message || String(error);
      logger.error(`[ElzabDriver] Fiscal journal flush threw at ${stage}: ${detail}`);
      return { success: false, error: detail };
    }
  }

  async printDailyReport(data: DailyReportData): Promise<ElzabOperationResult> {
    return this.printReport('DAILY', data);
  }

  async printXReport(data: DailyReportData): Promise<ElzabOperationResult> {
    return this.printReport('X', data);
  }

  async printZReport(data: DailyReportData): Promise<ElzabOperationResult> {
    return this.printReport('Z', data);
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

  private async printReport(kind: 'DAILY' | 'X' | 'Z', data: DailyReportData): Promise<ElzabOperationResult> {
    this.assertConnected();
    this.assertRealFiscalAllowed(`${kind} report`);
    if (!this.bridge.printReport) {
      throw new Error(`ELZAB_STX ${kind} report is not implemented until the official sidecar supports it.`);
    }
    const result = await this.bridge.printReport(this.connectionConfig(), kind, data);
    if (result.ok) return result;

    this.setFailure(result);
    const error = new Error(
      `ELZAB_STX ${kind} report failed: ${result.code || 'ELZAB_COMMAND_FAILED'}${result.detail ? `: ${result.detail}` : ''}`,
    );
    (error as Error & { result?: ElzabOperationResult }).result = result;
    throw error;
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
    const detail = (result.detail || '').toLowerCase();
    if (/receiptbegin failed|receiptconditions failed/.test(detail)) return false;
    if (code === 'ELZAB_BRIDGE_BAD_RESPONSE' || code === 'ELZAB_COMMAND_FAILED') return true;
    return /timeout|timed out|etimedout|econnreset|econnaborted|broken pipe|crash|exited|killed/.test(detail);
  }

  private assertRealFiscalAllowed(operation: string): void {
    if (isRealFiscalPrintEnabled()) return;
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
    if (code === 'ELZAB_LOCAL_MENU_MODE') {
      this.connectionState = 'protocol_ready';
      return;
    }
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
