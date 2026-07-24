import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../../logger';
import { ReceiptFormatter } from './receipt-formatter';
import { ReceiptData, PrinterStatusInfo, PosnetDiagnoseResult, DailyReportData } from '../../../shared/types';
import { listSerialPorts, sanitizePortName } from '../port-utils';
import { POSNET_PRODUCT_IDS } from './probe-profiles';
import { withPortLock } from './port-mutex';
import { buildFindPosnetVidPortsScript, parsePosnetVidPortOutput } from './pnp-port-parser';
import { createHash } from 'crypto';
import {
  FiscalAttemptJournal,
  FiscalAttemptRow,
  fiscalAttemptRepo,
} from '../../database/repos/fiscal-attempt-repo';
import { isRealFiscalPrintEnabled } from '../real-fiscal-print-gate';

const execFileAsync = promisify(execFile);

/** Known POSNET USB Vendor ID */
const POSNET_USB_VID = '1424';

// ─── CRC16-CCITT (poly 0x1021, init 0) ─────────────────────────────────────

const CRC16_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    t.push(crc);
  }
  return t;
})();

function crc16(data: Buffer): string {
  let crc = 0;
  for (const b of data) {
    crc = ((crc << 8) & 0xFFFF) ^ CRC16_TABLE[((crc >> 8) ^ b) & 0xFF];
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function formatPid(pid: number): string {
  return `0x${pid.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Step-by-step guidance + model name for an ambiguous-protocol POSNET Thermal.
 * Empty `steps` means no printer-menu action is known/required.
 */
export function getProtocolMismatchGuidance(pid?: number): { modelName?: string; steps: string[] } {
  const productName = pid !== undefined ? POSNET_PRODUCT_IDS[pid] : undefined;
  const modelName = productName ? `POSNET ${productName}` : undefined;
  if (!productName || !/thermal/i.test(productName)) {
    return { modelName, steps: [] };
  }
  return {
    modelName,
    steps: [
      'On the printer, press MENU to open settings',
      'Navigate to: Interfejs PC (PC interface)',
      'Select: Protokół (Protocol)',
      'Choose POSNET — this driver does not support THEMAL',
      'Save the setting and restart the printer',
      'Click Diagnose again to verify',
    ],
  };
}

function getProtocolMismatchHint(pid?: number): string {
  const { modelName, steps } = getProtocolMismatchGuidance(pid);
  if (!modelName || steps.length === 0) return '';
  return ` Detected ${modelName} (${formatPid(pid!)}). This model supports both POSNET and THEMAL protocols on the printer, but only POSNET v2 is supported by this driver. Open the printer menu Interfejs PC → Protokół and set it to POSNET, then save and restart the printer. If it is already POSNET, verify the PC interface is USB and the cable is healthy.`;
}

function isAmbiguousThermalProtocolPid(pid?: number): boolean {
  return pid === 0x100A || pid === 0x100B;
}

function isSerialWriteTimeout(text?: string): boolean {
  return /semaphore timeout period has expired|operation has timed out|write timed out/i.test(text || '');
}

function exactNonNegativeMinor(value: unknown, field: string): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`POSNET_FISCAL_AMOUNT_INVALID: ${field} must be a non-negative integer grosz amount.`);
  }
  return amount;
}

function exactPositiveMinor(value: unknown, field: string): number {
  const amount = exactNonNegativeMinor(value, field);
  if (amount <= 0) {
    throw new Error(`POSNET_FISCAL_PRICE_INVALID: ${field} must be a positive integer grosz amount.`);
  }
  return amount;
}

/**
 * Build the complete fiscal transaction before any byte is written. Billiard
 * discounts stay attached to their frozen VAT line via POSNET's fixed line
 * discount fields (`rd1` + `rw`); gross prices are never rewritten to make a
 * discounted total divide evenly by quantity.
 */
export function buildPosnetFiscalFrames(data: ReceiptData): { frames: string[][]; payableTotal: number } {
  const formattedData = new ReceiptFormatter().formatOrder(data);
  const frames: string[][] = [['trinit', 'bm0']];
  let payableTotal = 0;
  const declaredTotal = exactNonNegativeMinor(data.total, 'receipt.total');
  const explicitDiscountFlags = data.items.map((item) => Object.prototype.hasOwnProperty.call(item, 'allocatedDiscount'));
  if (explicitDiscountFlags.some(Boolean) && !explicitDiscountFlags.every(Boolean)) {
    throw new Error('POSNET_FISCAL_DISCOUNT_INVALID: receipt mixes explicit and implicit line discount allocation.');
  }

  let lineDiscounts = formattedData.items.map((item, index) => (
    exactNonNegativeMinor(item.allocatedDiscount, `items[${index}].allocatedDiscount`)
  ));
  if (!explicitDiscountFlags.some(Boolean)) {
    const ordinaryDiscount = exactNonNegativeMinor(data.discount ?? 0, 'receipt.discount');
    const grossLines = formattedData.items.map((item, index) => (
      exactNonNegativeMinor(item.total, `items[${index}].totalPrice`)
    ));
    const grossTotal = grossLines.reduce((sum, gross) => sum + gross, 0);
    if (grossTotal - ordinaryDiscount !== declaredTotal) {
      throw new Error(
        `POSNET_FISCAL_PAYABLE_MISMATCH: ordinary gross ${grossTotal} minus discount ${ordinaryDiscount} does not equal receipt total ${declaredTotal}.`,
      );
    }
    if (ordinaryDiscount > 0) {
      const ranked = grossLines.map((gross, index) => {
        const numerator = ordinaryDiscount * gross;
        return {
          index,
          base: grossTotal > 0 ? Math.floor(numerator / grossTotal) : 0,
          remainder: grossTotal > 0 ? numerator % grossTotal : 0,
        };
      });
      lineDiscounts = ranked.map((entry) => entry.base);
      let centsLeft = ordinaryDiscount - lineDiscounts.reduce((sum, amount) => sum + amount, 0);
      ranked
        .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
        .forEach((entry) => {
          if (centsLeft > 0 && lineDiscounts[entry.index] < grossLines[entry.index]) {
            lineDiscounts[entry.index] += 1;
            centsLeft -= 1;
          }
        });
      if (centsLeft !== 0) {
        throw new Error('POSNET_FISCAL_DISCOUNT_INVALID: ordinary discount could not be allocated exactly.');
      }
    }
  }

  for (const [index, item] of formattedData.items.entries()) {
    const price = exactPositiveMinor(item.price, `items[${index}].unitPrice`);
    const gross = exactNonNegativeMinor(item.total, `items[${index}].totalPrice`);
    const discount = lineDiscounts[index];
    if (discount > gross) {
      throw new Error(
        `POSNET_FISCAL_DISCOUNT_INVALID: items[${index}] discount ${discount} exceeds gross ${gross}.`,
      );
    }
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw new Error(`POSNET_FISCAL_QUANTITY_INVALID: items[${index}].quantity must be positive.`);
    }

    const qty = item.quantity.toFixed(3);
    const vatIndex = { A: 0, B: 1, C: 2, D: 3, E: 4 }[item.vat];
    if (vatIndex === undefined) {
      throw new Error(
        `POSNET_FISCAL_VAT_UNSUPPORTED: items[${index}] uses unmapped POSNET VAT code ${item.vat}.`,
      );
    }
    const lineFrame = [
      'trline',
      `na${item.name}`,
      `vt${vatIndex}`,
      `pr${price}`,
      `il${qty}`,
      `wa${gross}`,
    ];
    if (discount > 0) {
      lineFrame.push('rd1', `rw${discount}`, 'rnRabat');
    }
    frames.push(lineFrame);
    payableTotal += gross - discount;
  }

  if (payableTotal !== declaredTotal) {
    throw new Error(
      `POSNET_FISCAL_PAYABLE_MISMATCH: discounted line total ${payableTotal} does not equal receipt total ${declaredTotal}.`,
    );
  }

  const paymentType = formattedData.payment?.type === 2 ? 2 : 0;
  frames.push(['trpayment', `ty${paymentType}`, `wa${payableTotal}`]);
  frames.push(['trend', `to${payableTotal}`]);
  return { frames, payableTotal };
}

// ─── POSNET frame constants ─────────────────────────────────────────────────

const STX = 0x02;
const ETX = 0x03;
const TAB = 0x09;

/**
 * Posnet Driver — POSNET v2 serial protocol for Temo HS and compatible printers.
 *
 * Frame format: STX + body + '#' + CRC16(4hex) + ETX
 * Body:         cmd + TAB + (param + TAB)*
 * CRC covers:   body (everything between STX and '#', exclusive)
 *
 * All serial I/O via PowerShell System.IO.Ports.SerialPort.
 */
export type PosnetConnectionState = 'disconnected' | 'physical_present' | 'protocol_ready';

export interface PosnetDiagnosticCode {
  code: 'PORT_NOT_FOUND' | 'PORT_BUSY' | 'DEVICE_DETECTED_NO_PROTOCOL_RESPONSE' | 'WRONG_BAUD_OR_MODE' | 'COMMAND_REJECTED' | 'PRINT_OK' | 'ACCESS_DENIED' | 'REAL_FISCAL_PRINT_DISABLED' | 'FISCAL_ATTEMPT_RETRY_BLOCKED' | 'POSNET_THERMAL_PROTOCOL_UNSUPPORTED';
  detail?: string;
}

type PosnetVerifyResult = {
  ok: boolean;
  result?: string;
  errorCode?: 'ACCESS_DENIED' | 'WRONG_BAUD_OR_MODE';
  detail?: string;
};

export interface PosnetDriverOptions {
  /** Called when a fiscal receipt outcome is ambiguous after bytes were sent. */
  onFiscalUnknown?: (info: { orderId?: string; orderNumber?: string; code: string; detail?: string }) => void;
  /** Injectable for tests; defaults to the shared fiscal_attempts repo. */
  fiscalJournal?: FiscalAttemptJournal;
  /** Injectable production kill switch; defaults to the shared fiscal gate. */
  isRealFiscalPrintEnabled?: () => boolean;
}

export class PosnetDriver {
  private connectionState: PosnetConnectionState = 'disconnected';
  private modelName?: string;
  private firmwareVersion?: string;
  private lastDiagnostic?: PosnetDiagnosticCode;
  private detectedPid?: number;
  private lastBaudProbeFailures: string[] = [];
  private fiscalJournal: FiscalAttemptJournal;
  private onFiscalUnknown?: PosnetDriverOptions['onFiscalUnknown'];
  private realFiscalPrintEnabled: () => boolean;

  constructor(
    private portName: string = 'COM3',
    private baudRate: number = 9600,
    private protocol: 'THERMAL' | 'POSNET' = 'POSNET',
    options: PosnetDriverOptions = {},
  ) {
    this.fiscalJournal = options.fiscalJournal || fiscalAttemptRepo;
    this.onFiscalUnknown = options.onFiscalUnknown;
    this.realFiscalPrintEnabled = options.isRealFiscalPrintEnabled || isRealFiscalPrintEnabled;
    logger.info(`[PosnetDriver] Driver initialized for ${portName} @ ${baudRate}`);
  }

  getModelName(): string | undefined { return this.modelName; }
  getFirmwareVersion(): string | undefined { return this.firmwareVersion; }
  getConnectionState(): PosnetConnectionState { return this.connectionState; }
  getLastDiagnostic(): PosnetDiagnosticCode | undefined { return this.lastDiagnostic; }
  getDetectedPid(): number | undefined { return this.detectedPid; }
  getBaudRate(): number { return this.baudRate; }

  private assertPrintProtocolSupported(operation: string): void {
    if (this.protocol === 'POSNET') return;
    const detail = `PosnetDriver cannot ${operation} through the THERMAL profile because this driver emits POSNET v2 frames, not ESC/POS bytes. Select a real thermal driver or the verified POSNET protocol.`;
    this.lastDiagnostic = { code: 'POSNET_THERMAL_PROTOCOL_UNSUPPORTED', detail };
    throw new Error(`POSNET_THERMAL_PROTOCOL_UNSUPPORTED: ${detail}`);
  }
  requiresManualProtocolAction(): boolean {
    return this.connectionState === 'physical_present'
      && (this.lastDiagnostic?.code === 'DEVICE_DETECTED_NO_PROTOCOL_RESPONSE'
        || this.lastDiagnostic?.code === 'WRONG_BAUD_OR_MODE');
  }

  // ─── Connection lifecycle ─────────────────────────────────────────────────

  async connect(): Promise<boolean> {
    const lockResult = await withPortLock(this.portName, 'connect', () => this.connectInner());
    if (!lockResult.ok) {
      this.lastDiagnostic = { code: 'PORT_BUSY', detail: lockResult.message };
      logger.warn(`[PosnetDriver] connect() blocked: ${lockResult.message}`);
      return false;
    }
    return lockResult.value;
  }

  private async connectInner(): Promise<boolean> {
    logger.info(`[PosnetDriver] Connecting to ${this.portName}...`);
    try {
      const ports = await listSerialPorts();
      const portUpper = this.portName.toUpperCase();

      if (!ports.includes(portUpper)) {
        // Check if VID_1424 is on a different port
        const candidates = await PosnetDriver.findPosnetCandidates();
        if (candidates.length === 0) {
          this.connectionState = 'disconnected';
          this.lastDiagnostic = { code: 'PORT_NOT_FOUND', detail: `${this.portName} not present. Available: ${ports.join(', ') || 'none'}` };
          logger.warn(`[PosnetDriver] ${this.lastDiagnostic.detail}`);
          return false;
        }
        // VID found elsewhere — try to use that port
        const targetPort = candidates.find(c => ports.includes(c.toUpperCase())) || candidates[0];
        logger.info(`[PosnetDriver] Port ${this.portName} missing, found VID_1424 on ${targetPort}`);
        if (targetPort.toUpperCase() !== portUpper) {
          const lockResult = await withPortLock(targetPort, 'connect:migrated-port', async () => {
            this.portName = targetPort;
            return this.connectInner();
          });
          if (!lockResult.ok) {
            this.lastDiagnostic = { code: 'PORT_BUSY', detail: lockResult.message };
            return false;
          }
          return lockResult.value;
        }
        this.portName = targetPort;
      }

      // Port exists — check VID for physical presence
      const pid = await PosnetDriver.findPosnetPidForPort(this.portName);
      if (pid !== null) {
        this.detectedPid = pid;
        this.connectionState = 'physical_present';
        logger.info(`[PosnetDriver] VID_1424 PID_${pid.toString(16).toUpperCase()} detected on ${this.portName}`);
      }

      // Try POSNET protocol verification via rtcget
      const configuredVerify = await PosnetDriver.verifyPosnetDeviceUnlocked(this.portName, this.baudRate);
      if (configuredVerify.ok) {
        this.connectionState = 'protocol_ready';
        this.lastDiagnostic = undefined;
        logger.info(`[PosnetDriver] Connected and verified POSNET on ${this.portName} @ ${this.baudRate}`);
        return true;
      }
      const configuredFailure = `${this.baudRate}:${configuredVerify.result || configuredVerify.errorCode || configuredVerify.detail || 'failed'}`;
      if (configuredVerify.errorCode === 'ACCESS_DENIED') {
        this.lastDiagnostic = { code: 'ACCESS_DENIED', detail: configuredVerify.detail || `Access denied opening ${this.portName}` };
        return false;
      }

      // rtcget failed at configured baud — run baud probe only when useful.
      if (this.connectionState === 'physical_present') {
        const terminalWriteFailure = configuredVerify.errorCode === 'WRONG_BAUD_OR_MODE';
        const shouldProbeBaud = !terminalWriteFailure && !isAmbiguousThermalProtocolPid(this.detectedPid);
        if (shouldProbeBaud) {
          const probeResult = await this.probeBaudRates();
          if (probeResult) {
            this.baudRate = probeResult;
            this.connectionState = 'protocol_ready';
            this.lastDiagnostic = undefined;
            logger.info(`[PosnetDriver] Baud probe succeeded: ${this.portName} @ ${probeResult}`);
            return true;
          }
          if (this.lastDiagnostic?.code === 'ACCESS_DENIED') {
            return false;
          }
        }
        // Device physically present but selected/probed POSNET v2 baud did not respond.
        const failures = [configuredFailure, ...this.lastBaudProbeFailures].join(', ');
        const protocolHint = getProtocolMismatchHint(this.detectedPid);
        this.lastDiagnostic = {
          code: terminalWriteFailure ? 'WRONG_BAUD_OR_MODE' : 'DEVICE_DETECTED_NO_PROTOCOL_RESPONSE',
          detail: `VID_1424 on ${this.portName} but no POSNET response. Tried ${failures}.${protocolHint}`,
        };
        logger.warn(`[PosnetDriver] ${this.lastDiagnostic.detail}`);
        return false;
      }

      // Port exists but no VID and no rtcget — not a POSNET device
      this.connectionState = 'disconnected';
      this.lastDiagnostic = { code: 'PORT_NOT_FOUND', detail: `No POSNET device on ${this.portName}` };
      return false;
    } catch (error: any) {
      const msg = error?.message || String(error);
      if (msg.includes('Access') && msg.includes('denied')) {
        this.lastDiagnostic = { code: 'ACCESS_DENIED', detail: msg };
        // Do NOT set connected — port busy does not mean device is present
      } else {
        this.lastDiagnostic = { code: 'PORT_NOT_FOUND', detail: msg };
      }
      logger.error('[PosnetDriver] Connection failed:', error);
      this.connectionState = 'disconnected';
      return false;
    }
  }

  /**
   * Probe multiple baud rates to find one that gets a POSNET response.
   * Returns the working baud rate or null if none respond.
   */
  private async probeBaudRates(): Promise<number | null> {
    const baudsToTry = [9600, 19200, 115200].filter(b => b !== this.baudRate);
    this.lastBaudProbeFailures = [];
    // Already tried this.baudRate in connect(), try the rest
    for (const baud of baudsToTry) {
      logger.info(`[PosnetDriver] Probing ${this.portName} @ ${baud}...`);
      const result = await PosnetDriver.verifyPosnetDeviceUnlocked(this.portName, baud);
      if (result.ok) return baud;
      this.lastBaudProbeFailures.push(`${baud}:${result.result || result.errorCode || result.detail || 'failed'}`);
      if (result.errorCode === 'ACCESS_DENIED') {
        this.lastDiagnostic = { code: 'ACCESS_DENIED', detail: result.detail || `Access denied opening ${this.portName}` };
        return null;
      }
      if (result.errorCode === 'WRONG_BAUD_OR_MODE') {
        this.lastDiagnostic = { code: 'WRONG_BAUD_OR_MODE', detail: result.detail || `Serial write timed out on ${this.portName}` };
        return null;
      }
    }
    return null;
  }

  disconnect(): void {
    this.connectionState = 'disconnected';
    logger.info(`[PosnetDriver] Disconnected`);
  }

  getPort(): string { return this.portName; }

  async recoverPort(): Promise<string | null> {
    if (this.requiresManualProtocolAction()) {
      logger.info(`[PosnetDriver] Recovery skipped for ${this.portName}: POSNET protocol did not respond; manual protocol/profile action required`);
      return null;
    }
    logger.info('[PosnetDriver] Scanning all COM ports for POSNET device...');
    const found = await PosnetDriver.detectPosnetPort();
    if (found) {
      logger.info(`[PosnetDriver] Found POSNET on ${found} (current: ${this.portName})`);
    }
    return found;
  }

  isConnected(): boolean { return this.connectionState === 'protocol_ready'; }

  /** Reconnect using a new COM port (RecoverableDriver). */
  reconnect(newPort: string): void {
    logger.info(`[PosnetDriver] Reconnecting: ${this.portName} → ${newPort}`);
    this.portName = newPort;
    this.connectionState = 'physical_present';
  }

  async healthCheck(cachedPorts?: string[]): Promise<boolean> {
    const ports = cachedPorts ?? await listSerialPorts();
    const portUpper = this.portName.toUpperCase();
    const stillAvailable = ports.includes(portUpper);
    if (this.connectionState === 'protocol_ready' && !stillAvailable) {
      logger.warn(`[PosnetDriver] Health check: port ${this.portName} disappeared`);
      this.connectionState = 'disconnected';
    } else if (this.connectionState === 'disconnected' && stillAvailable) {
      // Port reappeared — mark as physical only, require reconnect for protocol_ready
      logger.info(`[PosnetDriver] Health check: port ${this.portName} reappeared (physical only)`);
      this.connectionState = 'physical_present';
    }
    return this.isConnected();
  }

  // ─── Printing ─────────────────────────────────────────────────────────────

  /**
   * Query the printer for its model + firmware via POSNET `modinf`.
   *
   * POSNET response format: modinf TAB na<name> TAB nv<version> TAB ... TAB # CRC ETX
   * On failure (no response, wrong command, legacy model that doesn't support
   * modinf), falls back to USB VID_1424 PID lookup via POSNET_PRODUCT_IDS.
   * Result is cached on the instance (this.modelName / this.firmwareVersion)
   * so subsequent callers don't re-query the printer.
   */
  async identifyModel(): Promise<{ modelName?: string; firmwareVersion?: string; source: 'modinf' | 'usb-pid' | 'none' }> {
    if (!this.isConnected()) {
      return { source: 'none' };
    }

    // 1) Try modinf
    try {
      const responses = await this.sendPosnetSequence([['modinf']]);
      const resp = responses[0] || '';
      // Parse: find na<name> and nv<version> tokens
      const nameMatch = resp.match(/\bna([^\t\x03#]+)/);
      const versMatch = resp.match(/\bnv([^\t\x03#]+)/);
      if (nameMatch) {
        this.modelName = nameMatch[1].trim();
        if (versMatch) this.firmwareVersion = versMatch[1].trim();
        logger.info(`[PosnetDriver] modinf → ${this.modelName} fw=${this.firmwareVersion ?? '?'}`);
        return { modelName: this.modelName, firmwareVersion: this.firmwareVersion, source: 'modinf' };
      }
    } catch (err) {
      logger.warn(`[PosnetDriver] modinf failed, falling back to USB PID lookup: ${(err as Error).message}`);
    }

    // 2) Fallback: USB PID lookup for VID_1424
    try {
      const pid = await PosnetDriver.findPosnetPidForPort(this.portName);
      if (pid !== null && POSNET_PRODUCT_IDS[pid]) {
        this.modelName = `POSNET ${POSNET_PRODUCT_IDS[pid]}`;
        logger.info(`[PosnetDriver] USB PID 0x${pid.toString(16)} → ${this.modelName}`);
        return { modelName: this.modelName, source: 'usb-pid' };
      }
    } catch (err) {
      logger.debug(`[PosnetDriver] USB PID lookup failed: ${(err as Error).message}`);
    }

    return { source: 'none' };
  }

  /**
   * Print a test page via non-fiscal transaction.
   *
   * Primary path: `trinit bm0` → `trline` × N → `trend to<total>` (POSNET v2 standard).
   * Fallback path: `prninit` → `prnline tx<text>` × N → `prnend` (legacy non-fiscal
   * printout, for older POSNET models that reject `trinit`).
   *
   * Model name on the receipt is the one returned by `identifyModel()` — no
   * hard-coded model string.
   */
  async printTest(): Promise<void> {
    if (!this.isConnected()) throw new Error('Printer not connected');
    this.assertPrintProtocolSupported('print');
    logger.info(`[PosnetDriver] Printing test page on ${this.portName}...`);

    if (!this.modelName) {
      await this.identifyModel();
    }
    const modelLine = this.modelName ? `Model: ${this.modelName}` : 'POSNET Printer';

    const lines = [
      '*** TEST PRINT ***',
      modelLine,
      `${this.portName} @ ${this.baudRate}`,
      new Date().toLocaleString('pl-PL'),
      'Zira AI Print Agent',
    ];

    // A Test button must never create turnover. Use only POSNET's non-fiscal
    // printout commands; if the model rejects them, fail explicitly and let a
    // controlled real sale verify fiscal printing after go-live.
    try {
      const frames: string[][] = [['prninit']];
      for (const text of lines) {
        frames.push(['prnline', `tx${text}`]);
      }
      frames.push(['prnend']);

      await this.sendPosnetSequence(frames);
      logger.info('[PosnetDriver] Non-fiscal test page printed (prninit path)');
    } catch (error) {
      logger.error('[PosnetDriver] Non-fiscal prninit test page failed');
      throw error;
    }
  }

  /**
   * Print a receipt. In POSNET protocol mode the trinit/trline/trpayment/
   * trend sequence opens a REAL fiscal transaction on the device, so every
   * attempt is journaled in fiscal_attempts exactly like the ELZAB path:
   * a confirmed/unknown prior attempt for the same order BLOCKS automatic
   * retries (no duplicate paragons), ambiguous outcomes after bytes were
   * sent are marked UNKNOWN for the Order History reconciliation flow.
   */
  async printReceipt(data: ReceiptData): Promise<void> {
    if (!this.isConnected()) throw new Error('Printer not connected');
    this.assertPrintProtocolSupported('print receipts');
    logger.info('[PosnetDriver] Printing receipt...');

    // Preflight the complete arithmetic and frames before creating a SENT
    // journal state or allowing any serial write.
    const { frames } = buildPosnetFiscalFrames(data);

    const attempt = this.createReceiptAttempt(data);

    if (!this.realFiscalPrintEnabled()) {
      const detail = 'Real POSNET fiscal receipt is disabled. Enable allowRealFiscalPrint only during controlled production go-live.';
      this.lastDiagnostic = { code: 'REAL_FISCAL_PRINT_DISABLED', detail };
      this.fiscalJournal.markBlocked(attempt.id, 'REAL_FISCAL_PRINT_DISABLED', { detail });
      throw new Error(`REAL_FISCAL_PRINT_DISABLED: ${detail}`);
    }

    this.fiscalJournal.markSent(attempt.id);

    try {
      await this.sendPosnetSequence(frames);
    } catch (error: any) {
      const detail = error?.message || String(error);
      if (this.failedBeforeAnyByteSent()) {
        // Port lock / invalid port — nothing reached the printer, a clean
        // retry is safe.
        this.fiscalJournal.markFailed(attempt.id, this.lastDiagnostic?.code || 'POSNET_SEND_FAILED', { detail });
        throw error;
      }
      // Bytes may have reached the device: the paragon could have printed
      // even though we lost the confirmation. Block silent retries and
      // route staff to the reconciliation flow.
      this.fiscalJournal.markUnknown(attempt.id, 'POSNET_THROWN_AFTER_SENT', { detail });
      this.notifyUnknownSafe(data, 'POSNET_THROWN_AFTER_SENT', detail);
      throw new Error(`FISCAL_RESULT_UNKNOWN: POSNET receipt result is unknown after send error: ${detail}`);
    }

    this.fiscalJournal.markSuccess(attempt.id, { responses: 'ok' });
    logger.info('[PosnetDriver] Receipt printed');
  }

  /** Port-lock and invalid-port failures happen before any byte is written. */
  private failedBeforeAnyByteSent(): boolean {
    const code = this.lastDiagnostic?.code;
    return code === 'PORT_BUSY' || code === 'PORT_NOT_FOUND';
  }

  private notifyUnknownSafe(data: ReceiptData, code: string, detail?: string): void {
    try {
      this.onFiscalUnknown?.({ orderId: data.orderId, orderNumber: data.orderNumber, code, detail });
    } catch (e: any) {
      logger.warn(`[PosnetDriver] onFiscalUnknown handler threw (ignored): ${e?.message ?? e}`);
    }
  }

  private createReceiptAttempt(data: ReceiptData): FiscalAttemptRow {
    const orderId = (data.orderId || data.orderNumber || '').trim();
    const paymentId = data.paymentId?.trim() || null;
    if (!orderId) {
      const detail = 'POSNET fiscal receipt requires ReceiptData.orderId or orderNumber for idempotency.';
      this.lastDiagnostic = { code: 'FISCAL_IDEMPOTENCY_KEY_MISSING', detail } as any;
      throw new Error(`FISCAL_IDEMPOTENCY_KEY_MISSING: ${detail}`);
    }

    const blocking = this.fiscalJournal.findBlockingAttempt(orderId, paymentId);
    if (blocking) {
      const detail = `Existing fiscal attempt ${blocking.id} for order ${orderId} is ${blocking.status}; automatic retry is blocked.`;
      this.lastDiagnostic = { code: 'FISCAL_ATTEMPT_RETRY_BLOCKED', detail } as any;
      throw new Error(`FISCAL_ATTEMPT_RETRY_BLOCKED: ${detail}`);
    }

    const payloadJson = posnetStableStringify(data);
    const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
    const attemptNo = this.fiscalJournal.getNextAttemptNo(orderId, paymentId);
    const idempotencyKey = `${orderId}:${paymentId || 'default'}:${attemptNo}`;

    return this.fiscalJournal.createPending({
      orderId,
      paymentId,
      attemptNo,
      idempotencyKey,
      printerType: 'FISCAL',
      payloadJson,
      payloadHash,
    });
  }

  async printZReport(data: DailyReportData): Promise<void> {
    if (!this.isConnected()) throw new Error('Printer not connected');
    this.assertPrintProtocolSupported('print reports');
    if (!this.realFiscalPrintEnabled()) {
      const detail = 'Real POSNET fiscal report transaction is disabled. Enable allowRealFiscalPrint only during controlled production go-live.';
      this.lastDiagnostic = { code: 'REAL_FISCAL_PRINT_DISABLED', detail };
      throw new Error(`REAL_FISCAL_PRINT_DISABLED: ${detail}`);
    }
    logger.info('[PosnetDriver] Printing Z-report...');

    const frames: string[][] = [];
    frames.push(['trinit', 'bm0']);

    frames.push(['trline', 'na=== Z-REPORT ===', 'vt0', 'pr0', 'il1.000']);
    frames.push(['trline', `naDate: ${data.date}`, 'vt0', 'pr0', 'il1.000']);
    if (data.cashierName) {
      frames.push(['trline', `naCashier: ${data.cashierName}`, 'vt0', 'pr0', 'il1.000']);
    }
    frames.push(['trline', `naOrders: ${data.transactionCount}`, 'vt0', 'pr0', 'il1.000']);
    frames.push(['trline', `naTotal: ${(data.grossSales / 100).toFixed(2)}`, 'vt0', 'pr0', 'il1.000']);

    for (const p of data.paymentSummary ?? []) {
      frames.push(['trline', `na${p.method}: ${(p.amount / 100).toFixed(2)}`, 'vt0', 'pr0', 'il1.000']);
    }

    frames.push(['trend', 'to0']);

    await this.sendPosnetSequence(frames);
    logger.info('[PosnetDriver] Z-report printed');
  }

  /** Display message on customer display */
  async displayMessage(line1: string, line2?: string): Promise<void> {
    if (!this.isConnected()) return;
    try {
      const frames: string[][] = [['dsptxtline', 'id0', 'no0', `ln${line1}`]];
      if (line2) frames.push(['dsptxtline', 'id0', 'no1', `ln${line2}`]);
      await this.sendPosnetSequence(frames);
    } catch (err) {
      logger.warn('[PosnetDriver] Display message failed:', err);
    }
  }

  /** Open cash drawer */
  async openDrawer(): Promise<void> {
    if (!this.isConnected()) throw new Error('Printer not connected');
    await this.sendPosnetSequence([['opendrwr']]);
    logger.info('[PosnetDriver] Cash drawer opened');
  }

  async getStatus(): Promise<PrinterStatusInfo> {
    return {
      connected: this.isConnected(),
      type: 'POSNET',
      mock: false,
      port: this.portName,
      protocol: this.protocol,
      connectionState: this.connectionState,
      diagnostic: this.lastDiagnostic,
      detectedPid: this.detectedPid,
    };
  }

  // ─── POSNET protocol helpers ──────────────────────────────────────────────

  /**
   * Build a POSNET v2 frame.
   * Format: STX + cmd + TAB + (param + TAB)* + '#' + CRC16(4hex) + ETX
   */
  private static buildFrame(cmd: string, ...params: string[]): Buffer {
    // Body = cmd + TAB + (param + TAB)*
    let body = cmd + '\t';
    for (const p of params) body += p + '\t';

    const bodyBuf = Buffer.from(body, 'ascii');
    const crcHex = crc16(bodyBuf);

    // Frame = STX + body + '#' + CRC + ETX
    const frame = Buffer.alloc(1 + bodyBuf.length + 1 + 4 + 1);
    let offset = 0;
    frame[offset++] = STX;
    bodyBuf.copy(frame, offset); offset += bodyBuf.length;
    frame[offset++] = 0x23; // '#'
    Buffer.from(crcHex, 'ascii').copy(frame, offset); offset += 4;
    frame[offset++] = ETX;

    return frame;
  }

  private static classifySerialError(error: any, port: string): PosnetDiagnosticCode {
    const msg = error?.message || String(error);
    if (/access.*denied|denied.*access/i.test(msg)) {
      return { code: 'ACCESS_DENIED', detail: msg };
    }
    if (/busy|another operation/i.test(msg)) {
      return { code: 'PORT_BUSY', detail: msg };
    }
    if (/no response|noreply/i.test(msg)) {
      return { code: 'DEVICE_DETECTED_NO_PROTOCOL_RESPONSE', detail: msg };
    }
    if (isSerialWriteTimeout(msg)) {
      return { code: 'WRONG_BAUD_OR_MODE', detail: msg };
    }
    if (/POSNET .* failed|ERR|\?/i.test(msg)) {
      return { code: 'COMMAND_REJECTED', detail: msg };
    }
    return { code: 'COMMAND_REJECTED', detail: msg || `POSNET command failed on ${port}` };
  }

  /**
   * Send multiple POSNET frames in a single serial session.
   * Opens port → writes all frames (waiting for response between each) → closes.
   * Throws on any error response from the printer.
   * Acquires port mutex to prevent concurrent access.
   */
  private async sendPosnetSequence(commands: string[][]): Promise<string[]> {
    const safePort = sanitizePortName(this.portName);
    if (!safePort) throw new Error(`Invalid port name: ${this.portName}`);

    try {
      const lockResult = await withPortLock(this.portName, `sendPosnetSequence(${commands[0]?.[0] || '?'})`, () => this.sendPosnetSequenceInner(commands, safePort));
      if (!lockResult.ok) {
        this.lastDiagnostic = { code: 'PORT_BUSY', detail: lockResult.message };
        throw new Error(lockResult.message);
      }
      this.lastDiagnostic = { code: 'PRINT_OK' };
      return lockResult.value;
    } catch (error: any) {
      if (this.lastDiagnostic?.code !== 'PORT_BUSY') {
        this.lastDiagnostic = PosnetDriver.classifySerialError(error, this.portName);
      }
      throw error;
    }
  }

  private async sendPosnetSequenceInner(commands: string[][], safePort: string): Promise<string[]> {

    // Build all frames as hex arrays for PowerShell
    const frameHexArrays: string[] = [];
    const cmdLabels: string[] = [];
    for (const [cmd, ...params] of commands) {
      const frame = PosnetDriver.buildFrame(cmd, ...params);
      const hex = Array.from(frame).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(',');
      frameHexArrays.push(hex);
      cmdLabels.push(cmd);
    }

    // Build PowerShell script that sends all frames in one session
    let psScript = '$ProgressPreference = "SilentlyContinue"\n';
    psScript += `$p = New-Object System.IO.Ports.SerialPort('${safePort}', ${this.baudRate}, 'None', 8, 'One')\n`;
    psScript += '$p.WriteTimeout = 5000\n$p.ReadTimeout = 5000\n';
    psScript += '$p.DtrEnable = $true\n$p.RtsEnable = $true\n';
    psScript += '$results = @()\n';
    psScript += 'try {\n  $p.Open()\n';

    for (let i = 0; i < frameHexArrays.length; i++) {
      psScript += `  $f${i} = [byte[]]@(${frameHexArrays[i]})\n`;
      psScript += `  $p.Write($f${i}, 0, $f${i}.Length)\n`;
      psScript += '  Start-Sleep -Milliseconds 1200\n';
      psScript += '  $n = $p.BytesToRead\n';
      psScript += '  if ($n -gt 0) {\n';
      psScript += '    $buf = New-Object byte[] $n\n';
      psScript += '    $p.Read($buf, 0, $n) | Out-Null\n';
      psScript += '    $results += [System.Text.Encoding]::ASCII.GetString($buf)\n';
      psScript += '  } else { $results += "NOREPLY" }\n';
    }

    psScript += '  $results -join "|||"\n';
    psScript += '} catch {\n  Write-Error $_.Exception.Message\n';
    psScript += '} finally {\n  if ($p.IsOpen) { $p.Close() }\n}\n';

    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');

    try {
      const { stdout, stderr } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        { encoding: 'utf8', timeout: commands.length * 3000 + 10000 },
      );

      if (stderr?.trim()) {
        // Filter out ONLY harmless PowerShell CLIXML progress records
        // (e.g. "Preparing modules for first use"). Keep actual errors.
        const filteredStderr = stderr.replace(/#< CLIXML[\s\S]*?Preparing modules[\s\S]*?<\/Objs>/gi, '').trim();
        // Also check for CLIXML-wrapped errors (Write-Error produces CLIXML that
        // contains the real error message — don't silently swallow it).
        const cliXmlError = stderr.match(/<S S="Error">([^<]+)<\/S>/);
        if (cliXmlError) {
          const errMsg = cliXmlError[1].replace(/&#xD;&#xA;/g, '').trim();
          logger.warn(`[PosnetDriver] Serial CLIXML error: ${errMsg}`);
          throw new Error(`Serial error: ${errMsg}`);
        }
        if (filteredStderr) {
          logger.warn(`[PosnetDriver] Serial stderr: ${filteredStderr}`);
          throw new Error(`Serial error: ${filteredStderr}`);
        }
        logger.debug(`[PosnetDriver] Ignored PowerShell progress output on stderr`);
      }

      const responses = stdout.trim().split('|||');
      logger.info(`[PosnetDriver] Responses: ${JSON.stringify(responses)}`);

      // Empty stdout means PowerShell script hit an exception before producing
      // any output — the error was likely caught in the PS catch block.
      // Treat this as a write failure (common when CTS is not asserted).
      if (!stdout.trim() || (responses.length === 1 && !responses[0])) {
        throw new Error(`No data returned from printer on ${this.portName} — the printer may not be accepting data (check cable, power, and paper)`);
      }

      // Check for errors in responses
      for (let i = 0; i < responses.length; i++) {
        const resp = responses[i] || '';
        if (resp === 'NOREPLY') {
          throw new Error(`No response from printer on ${this.portName} — check that a POSNET printer is connected to this port`);
        }
        if (resp.includes('ERR') || (resp.includes('?') && !resp.startsWith(cmdLabels[i]))) {
          // Error from printer
          throw new Error(`POSNET ${cmdLabels[i]} failed: ${resp.trim()}`);
        }
      }

      return responses;
    } catch (error: any) {
      // If the error is a POSNET protocol error, cancel any pending transaction
      try {
        const cancelFrame = PosnetDriver.buildFrame('prncancel');
        const cancelHex = Array.from(cancelFrame).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(',');
        const cancelScript = '$ProgressPreference = "SilentlyContinue"\n' +
          `$p = New-Object System.IO.Ports.SerialPort('${safePort}', ${this.baudRate}, 'None', 8, 'One')\n` +
          '$p.WriteTimeout = 3000; $p.DtrEnable = $true; $p.RtsEnable = $true\n' +
          'try { $p.Open()\n' +
          `  $f = [byte[]]@(${cancelHex}); $p.Write($f, 0, $f.Length)\n` +
          '  Start-Sleep -Milliseconds 500\n' +
          '} finally { if ($p.IsOpen) { $p.Close() } }\n';
        const enc = Buffer.from(cancelScript, 'utf16le').toString('base64');
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8', timeout: 8000 });
      } catch { /* best-effort cancel */ }

      throw error;
    }
  }

  // ─── Static detection ─────────────────────────────────────────────────────

  /**
   * Auto-detect POSNET device.
   * Step 1: Find COM ports with VID 1424
   * Step 2: Verify port can be opened
   * Step 3: Send rtcget to confirm POSNET device
   */
  static async detectPosnetPort(): Promise<string | null> {
    try {
      const candidates = await PosnetDriver.findPosnetCandidates();
      if (candidates.length === 0) {
        logger.info('[PosnetDriver] Step 1: No USB devices with VID_1424 found');
        return null;
      }
      logger.info(`[PosnetDriver] Step 1: VID candidates: ${candidates.join(', ')}`);

      const openable: string[] = [];
      for (const port of candidates) {
        const canOpen = await PosnetDriver.testPortOpen(port);
        if (canOpen) openable.push(port);
      }
      if (openable.length === 0) {
        logger.warn('[PosnetDriver] Step 2: None of the candidate ports could be opened');
        return null;
      }
      logger.info(`[PosnetDriver] Step 2: Openable ports: ${openable.join(', ')}`);

      for (const port of openable) {
        const confirmed = await PosnetDriver.verifyPosnetDevice(port);
        if (confirmed) {
          logger.info(`[PosnetDriver] Step 3: Confirmed POSNET device on ${port}`);
          return port;
        }
      }

      // No POSNET response on any candidate — do NOT silently return a random
      // port (the old behavior caused test prints to "succeed" silently).
      logger.warn(`[PosnetDriver] Step 3: No POSNET device responded on any candidate port`);
      return null;
    } catch (error) {
      logger.error('[PosnetDriver] detectPosnetPort failed:', error);
      return null;
    }
  }

  /**
   * Find the USB Product ID (PID) for a given COM port, if it's a POSNET
   * VID_1424 device. Returns null for non-POSNET ports.
   */
  private static async findPosnetPidForPort(port: string): Promise<number | null> {
    try {
      const psCommand = buildFindPosnetVidPortsScript(POSNET_USB_VID);
      const { stdout, stderr } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psCommand],
        { encoding: 'utf8', timeout: 15000 },
      );
      const target = port.toUpperCase();
      for (const row of parsePosnetVidPortOutput(stdout, stderr)) {
        if (row.port === target) {
          return row.pid;
        }
      }
      return null;
    } catch (error) {
      logger.debug(`[PosnetDriver] findPosnetPidForPort failed: ${(error as Error).message}`);
      return null;
    }
  }

  private static async findPosnetCandidates(): Promise<string[]> {
    try {
      const psCommand = buildFindPosnetVidPortsScript(POSNET_USB_VID);
      const { stdout, stderr } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psCommand],
        { encoding: 'utf8', timeout: 15000 },
      );
      return parsePosnetVidPortOutput(stdout, stderr).map(row => row.port);
    } catch (error) {
      logger.error('[PosnetDriver] findPosnetCandidates failed:', error);
      return [];
    }
  }

  private static async testPortOpen(port: string): Promise<boolean> {
    const safePort = sanitizePortName(port);
    if (!safePort) return false;
    const locked = await withPortLock(safePort, `testPortOpen(${safePort})`, () => PosnetDriver.testPortOpenUnlocked(safePort));
    if (!locked.ok) return false;
    return locked.value;
  }

  private static async testPortOpenUnlocked(safePort: string): Promise<boolean> {
    try {
      const psCommand =
        `$p = New-Object System.IO.Ports.SerialPort('${safePort}', 9600, 'None', 8, 'One'); ` +
        '$p.ReadTimeout = 1000; $p.WriteTimeout = 1000; ' +
        'try { $p.Open(); Write-Output "OK" } finally { if ($p.IsOpen) { $p.Close() } }';
      const { stdout } = await execFileAsync(
        'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand],
        { encoding: 'utf8', timeout: 8000 },
      );
      return stdout.trim().includes('OK');
    } catch { return false; }
  }

  /**
   * Verify POSNET device by sending rtcget (read clock).
   * A POSNET printer responds with: rtcget TAB da<date> TAB #CRC ETX
   */
  private static async verifyPosnetDevice(port: string, baudRate: number = 9600): Promise<boolean> {
    const safePort = sanitizePortName(port);
    if (!safePort) return false;
    const locked = await withPortLock(safePort, `verifyPosnetDevice(${safePort}@${baudRate})`, async () => {
      const result = await PosnetDriver.verifyPosnetDeviceUnlocked(safePort, baudRate);
      return result.ok;
    });
    if (!locked.ok) return false;
    return locked.value;
  }

  private static async verifyPosnetDeviceUnlocked(port: string, baudRate: number = 9600): Promise<PosnetVerifyResult> {
    const safePort = sanitizePortName(port);
    if (!safePort) return { ok: false, result: 'INVALID_PORT' };
    try {
      // Build rtcget frame
      const frame = PosnetDriver.buildFrame('rtcget');
      const hexArray = Array.from(frame).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(',');

      const psScript =
        '$ProgressPreference = "SilentlyContinue"\n' +
        `$p = New-Object System.IO.Ports.SerialPort('${safePort}', ${baudRate}, 'None', 8, 'One')\n` +
        '$p.ReadTimeout = 3000\n$p.WriteTimeout = 3000\n' +
        '$p.DtrEnable = $true\n$p.RtsEnable = $true\n' +
        'try {\n  $p.Open()\n' +
        `  $f = [byte[]]@(${hexArray})\n` +
        '  $p.Write($f, 0, $f.Length)\n' +
        '  Start-Sleep -Milliseconds 2500\n' +
        '  $n = $p.BytesToRead\n' +
        '  if ($n -gt 0) {\n' +
        '    $buf = New-Object byte[] $n\n' +
        '    $p.Read($buf, 0, $n) | Out-Null\n' +
        '    $s = [System.Text.Encoding]::ASCII.GetString($buf)\n' +
        "    if ($s -match 'rtcget') { Write-Output 'POSNET' }\n" +
        "    elseif ($buf[0] -eq 0x02) { Write-Output 'POSNET' }\n" +
        "    else { Write-Output 'UNKNOWN' }\n" +
        "  } else { Write-Output 'NOREPLY' }\n" +
        '} catch {\n  Write-Output "ERROR:$($_.Exception.Message)"\n' +
        '} finally {\n  if ($p.IsOpen) { $p.Close() }\n}\n';

      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        { encoding: 'utf8', timeout: 12000 },
      );

      const result = stdout.trim();
      logger.info(`[PosnetDriver] verifyPosnetDevice(${safePort}): ${result}`);
      if (result === 'POSNET') return { ok: true, result };
      if (/ERROR:.*access.*denied|ERROR:.*denied.*access/i.test(result)) {
        return { ok: false, result, errorCode: 'ACCESS_DENIED', detail: result.replace(/^ERROR:/, '') };
      }
      if (isSerialWriteTimeout(result)) {
        return { ok: false, result, errorCode: 'WRONG_BAUD_OR_MODE', detail: result.replace(/^ERROR:/, '') };
      }
      return { ok: false, result: result || 'EMPTY' };
    } catch (error: any) {
      const msg = error?.message || String(error);
      logger.warn(`[PosnetDriver] verifyPosnetDevice(${safePort}) failed:`, error);
      if (/access.*denied|denied.*access/i.test(msg)) {
        return { ok: false, errorCode: 'ACCESS_DENIED', detail: msg };
      }
      if (isSerialWriteTimeout(msg)) {
        return { ok: false, result: 'ERROR', errorCode: 'WRONG_BAUD_OR_MODE', detail: msg };
      }
      return { ok: false, result: 'ERROR', detail: msg };
    }
  }

  /**
   * Diagnostic-only probe: check port presence → VID/PID → open → rtcget.
   *
   * Unlike `connect()` this method does NOT mutate any driver state, does NOT
   * send print commands, and does NOT auto-save config. It's a read-only
   * inspection used by the Settings UI to show users exactly where the
   * communication chain breaks.
   *
   * Serial I/O is serialized via `withPortLock`, so calling this while another
   * operation owns the port returns `PORT_BUSY` without disturbing it.
   */
  static async diagnosePort(port: string, baudRate: number = 9600): Promise<PosnetDiagnoseResult> {
    const safePort = sanitizePortName(port);
    if (!safePort) {
      return {
        port,
        portPresent: false,
        portOpenable: false,
        vidMatch: false,
        posnetResponse: false,
        baudRate,
        diagnostic: { code: 'PORT_NOT_FOUND', detail: `Invalid port name: ${port}` },
        guidance: ['The port name is invalid — choose a valid COM port'],
        requiresManualSetup: false,
      };
    }

    const portUpper = safePort.toUpperCase();
    const ports = await listSerialPorts();
    const portPresent = ports.includes(portUpper);

    let pid: number | null = null;
    try { pid = await PosnetDriver.findPosnetPidForPort(safePort); } catch { /* non-fatal */ }
    const vidMatch = pid !== null;
    const productName = pid !== null ? POSNET_PRODUCT_IDS[pid] : undefined;
    const modelName = productName ? `POSNET ${productName}` : undefined;
    const pidHex = pid !== null ? formatPid(pid) : undefined;

    const result: PosnetDiagnoseResult = {
      port: portUpper,
      portPresent,
      portOpenable: false,
      vidMatch,
      pid: pid ?? undefined,
      pidHex,
      modelName,
      posnetResponse: false,
      baudRate,
      diagnostic: { code: 'PORT_NOT_FOUND' },
      guidance: [],
      requiresManualSetup: false,
    };

    if (!portPresent) {
      result.diagnostic = {
        code: 'PORT_NOT_FOUND',
        detail: `${portUpper} not present. Available: ${ports.join(', ') || 'none'}`,
      };
      result.guidance = [
        'Check that the printer is powered on',
        'Check the USB cable is connected on both ends',
        'Install or reinstall the POSNET USB driver if the device is new',
      ];
      return result;
    }

    const locked = await withPortLock(safePort, `diagnosePort(${safePort}@${baudRate})`, () =>
      PosnetDriver.verifyPosnetDeviceUnlocked(safePort, baudRate),
    );

    if (!locked.ok) {
      result.diagnostic = { code: 'PORT_BUSY', detail: locked.message };
      result.guidance = [
        'Another operation is using the printer right now',
        'Wait a few seconds and click Diagnose again',
      ];
      return result;
    }

    const verify = locked.value;
    result.portOpenable = verify.errorCode !== 'ACCESS_DENIED';

    if (verify.ok) {
      result.posnetResponse = true;
      result.diagnostic = {
        code: 'PRINT_OK',
        detail: `POSNET v2 responded on ${portUpper} @ ${baudRate}`,
      };
      result.guidance = ['The printer is ready — click Test Print to verify the full print path'];
      return result;
    }

    if (verify.errorCode === 'ACCESS_DENIED') {
      result.diagnostic = { code: 'ACCESS_DENIED', detail: verify.detail || `Access denied opening ${portUpper}` };
      result.guidance = [
        'Close any other app that may be using the printer (Posnet OPS, previous Test Print dialog)',
        'Disconnect and reconnect the USB cable',
        'Restart the printer',
      ];
      return result;
    }

    const wrongBaudOrMode = verify.errorCode === 'WRONG_BAUD_OR_MODE';
    const protocolHint = getProtocolMismatchHint(pid ?? undefined);
    result.diagnostic = {
      code: wrongBaudOrMode ? 'WRONG_BAUD_OR_MODE' : 'DEVICE_DETECTED_NO_PROTOCOL_RESPONSE',
      detail: `VID_${POSNET_USB_VID} on ${portUpper} but no POSNET response @ ${baudRate}.${protocolHint}`,
    };
    const { steps } = getProtocolMismatchGuidance(pid ?? undefined);
    if (steps.length > 0) {
      result.guidance = steps;
      result.requiresManualSetup = true;
    } else {
      result.guidance = [
        'Verify the printer is powered on and has paper',
        'Check the USB cable is fully seated on both ends',
        'Try restarting the printer',
        'If this persists, the printer may not support POSNET v2 protocol',
      ];
    }
    return result;
  }
}


/** Deterministic JSON for fiscal payload hashing (key-sorted, like ELZAB). */
function posnetStableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (val as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return val;
  });
}
