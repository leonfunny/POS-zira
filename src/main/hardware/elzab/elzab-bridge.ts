import { execFile } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { DailyReportData, ReceiptData } from '../../../shared/types';
import { toFiscalSafeText } from '../../../shared/fiscal-text';
import { isRealFiscalPrintEnabled } from '../real-fiscal-print-gate';

export { isRealFiscalPrintEnabled } from '../real-fiscal-print-gate';

const execFileAsync = promisify(execFile);

export type ElzabDiagnosticCode =
  | 'ELZAB_BRIDGE_NOT_CONFIGURED'
  | 'ELZAB_BRIDGE_NOT_FOUND'
  | 'ELZAB_BRIDGE_BAD_RESPONSE'
  | 'ELZAB_TARGET_MISSING'
  | 'ELZAB_HARDWARE_NOT_FOUND'
  | 'ELZAB_PROTOCOL_NOT_READY'
  | 'ELZAB_LOCAL_MENU_MODE'
  | 'ELZAB_UNSUPPORTED_OPERATION'
  | 'ELZAB_NO_DAILY_REPORT_CREATED'
  | 'ELZAB_DAILY_REPORT_NUMBER_UNAVAILABLE'
  | 'ELZAB_DAILY_REPORT_CONFIRMATION_UNKNOWN'
  | 'ELZAB_COMMAND_FAILED'
  | 'ELZAB_LINE_DISCOUNT_UNSUPPORTED'
  | 'REAL_FISCAL_PRINT_DISABLED'
  | 'FISCAL_IDEMPOTENCY_KEY_MISSING'
  | 'FISCAL_ATTEMPT_RETRY_BLOCKED'
  | 'FISCAL_JOURNAL_UNAVAILABLE';

export interface ElzabOperationResult {
  ok: boolean;
  code?: ElzabDiagnosticCode;
  detail?: string;
  data?: unknown;
}

export interface ElzabConnectionConfig {
  protocol: 'ELZAB_STX';
  port?: string;
  address?: string;
  baudRate: number;
}

export interface ElzabBridge {
  canPrintFiscalReceipts?(): boolean;
  checkAvailability(): Promise<ElzabOperationResult>;
  connect(config: ElzabConnectionConfig): Promise<ElzabOperationResult>;
  getStatus(config: ElzabConnectionConfig): Promise<ElzabOperationResult>;
  printTest(config: ElzabConnectionConfig): Promise<ElzabOperationResult>;
  printReceipt(config: ElzabConnectionConfig, data: ReceiptData): Promise<ElzabOperationResult>;
  printReport?(config: ElzabConnectionConfig, kind: 'DAILY' | 'X' | 'Z', data: DailyReportData): Promise<ElzabOperationResult>;
}

export interface ElzabSidecarCommand {
  executablePath: string;
  args?: string[];
  cwd?: string;
  displayPath?: string;
}

export class MissingElzabBridge implements ElzabBridge {
  private unavailable(): ElzabOperationResult {
    return {
      ok: false,
      code: 'ELZAB_BRIDGE_NOT_CONFIGURED',
      detail: 'ELZAB_STX requires an official elzabdr/STX sidecar. Set ZIRA_ELZAB_BRIDGE_PATH after the helper is installed and verified with real hardware.',
    };
  }

  async checkAvailability(): Promise<ElzabOperationResult> { return this.unavailable(); }
  async connect(): Promise<ElzabOperationResult> { return this.unavailable(); }
  async getStatus(): Promise<ElzabOperationResult> { return this.unavailable(); }
  async printTest(): Promise<ElzabOperationResult> { return this.unavailable(); }
  async printReceipt(): Promise<ElzabOperationResult> { return this.unavailable(); }
  async printReport(): Promise<ElzabOperationResult> { return this.unavailable(); }
}

/**
 * Dev-only mock that simulates a healthy ELZAB sidecar so the UI flow
 * (test print, status check) can be verified without the official
 * elzabdr.dll + real hardware.
 *
 *  ┌─ FISCAL SAFETY GUARDRAILS ─────────────────────────────────────────┐
 *  │ • Refuses to instantiate inside a packaged production build       │
 *  │   (app.isPackaged === true) — only dev mode (npm run dev).        │
 *  │ • Refuses printReceipt / printReport — these would generate fake  │
 *  │   fiscal output, which is illegal under Polish tax law.           │
 *  │ • printTest is OK because it's a non-fiscal diagnostic page.      │
 *  │ • Logs a loud banner every time it is mounted so it cannot be     │
 *  │   accidentally enabled in production.                             │
 *  └────────────────────────────────────────────────────────────────────┘
 *
 * Activate by setting the env var `ZIRA_ELZAB_MOCK=true` BEFORE starting
 * Electron in development. Example:
 *
 *   $env:ZIRA_ELZAB_MOCK = "true"
 *   npx electron .
 */
export class DevMockElzabBridge implements ElzabBridge {
  private static readonly MOCK_MODEL = 'ELZAB Zeta Online (MOCK)';
  private static readonly MOCK_FIRMWARE = 'MOCK-0.0.0';

  private refuseReal(operation: string): ElzabOperationResult {
    return {
      ok: false,
      code: 'ELZAB_UNSUPPORTED_OPERATION',
      detail:
        `ELZAB_MOCK_REFUSES_REAL_FISCAL: The dev mock bridge refuses ${operation} because it would generate ` +
        'fake fiscal output. Polish tax law requires fiscalization with authorized ELZAB service ' +
        'before any real fiscal command. Unset ZIRA_ELZAB_MOCK and install the official sidecar to print real receipts.',
    };
  }

  async checkAvailability(): Promise<ElzabOperationResult> {
    return {
      ok: true,
      code: undefined,
      detail: 'DEV MOCK bridge available — non-fiscal diagnostics only',
      data: { mock: true, model: DevMockElzabBridge.MOCK_MODEL, firmware: DevMockElzabBridge.MOCK_FIRMWARE },
    };
  }

  async connect(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    return {
      ok: true,
      detail: `DEV MOCK connected via ${config.port || config.address} @ ${config.baudRate}`,
      data: { mock: true },
    };
  }

  async getStatus(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    return {
      ok: true,
      data: {
        mock: true,
        model: DevMockElzabBridge.MOCK_MODEL,
        firmware: DevMockElzabBridge.MOCK_FIRMWARE,
        paper: 'OK',
        target: config.port || config.address,
      },
    };
  }

  async printTest(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    // Test pages are NON-FISCAL diagnostic prints — safe to simulate.
    return {
      ok: true,
      detail: `DEV MOCK printed test page to ${config.port || config.address} (nothing actually sent to hardware)`,
      data: { mock: true, lines: ['*** DEV MOCK TEST PAGE ***', 'Zira AI Print Agent', 'ELZAB_STX simulation', new Date().toISOString()] },
    };
  }

  async printReceipt(): Promise<ElzabOperationResult> {
    return this.refuseReal('printReceipt');
  }

  async printReport(): Promise<ElzabOperationResult> {
    return this.refuseReal('printReport');
  }
}

/**
 * Sidecar boundary for the official ELZAB library.
 *
 * Do not load elzabdr.dll directly into Electron. The helper process owns the
 * vendor DLL/API and speaks a tiny JSON protocol with this app:
 *
 *   helper.exe <command> <base64-json>
 *
 * stdout must be JSON shaped like ElzabOperationResult. This keeps the fiscal
 * integration mockable and avoids coupling Electron to vendor-native ABI.
 */
export class ElzabSidecarBridge implements ElzabBridge {
  private readonly command: Required<Omit<ElzabSidecarCommand, 'displayPath'>> & { displayPath: string };

  constructor(
    executable: string | ElzabSidecarCommand,
    private readonly timeoutMs = 30_000,
  ) {
    const command = typeof executable === 'string' ? { executablePath: executable } : executable;
    this.command = {
      executablePath: command.executablePath,
      args: command.args || [],
      cwd: command.cwd || path.dirname(command.executablePath),
      displayPath: command.displayPath || command.executablePath,
    };
  }

  async checkAvailability(): Promise<ElzabOperationResult> {
    if (!existsSync(this.command.executablePath)) {
      return {
        ok: false,
        code: 'ELZAB_BRIDGE_NOT_FOUND',
        detail: `ELZAB sidecar not found at ${this.command.displayPath}`,
      };
    }
    return this.invoke('check', {});
  }

  connect(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    return this.invoke('connect', { config });
  }

  getStatus(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    return this.invoke('status', { config });
  }

  printTest(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    return this.invoke('test', { config });
  }

  printReceipt(config: ElzabConnectionConfig, data: ReceiptData): Promise<ElzabOperationResult> {
    return this.invoke('receipt', { config, data });
  }

  printReport(config: ElzabConnectionConfig, kind: 'DAILY' | 'X' | 'Z', data: DailyReportData): Promise<ElzabOperationResult> {
    return this.invoke('report', { config, kind, data });
  }

  private async invoke(command: string, payload: unknown): Promise<ElzabOperationResult> {
    try {
      const body = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { command, ...(payload as Record<string, unknown>) }
        : { command, payload };
      const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
      const timeout = command === 'receipt' || command === 'report'
        ? Math.max(this.timeoutMs, 120_000)
        : command === 'test'
          ? Math.max(this.timeoutMs, 45_000)
          : this.timeoutMs;
      const { stdout } = await execFileAsync(this.command.executablePath, [...this.command.args, command, encoded], {
        cwd: this.command.cwd,
        env: buildSidecarEnv(),
        timeout,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const parsed = JSON.parse(String(stdout || '').trim());
      if (typeof parsed?.ok !== 'boolean') {
        return {
          ok: false,
          code: 'ELZAB_BRIDGE_BAD_RESPONSE',
          detail: `ELZAB sidecar returned JSON without boolean ok for ${command}`,
          data: parsed,
        };
      }
      return parsed as ElzabOperationResult;
    } catch (error: any) {
      return {
        ok: false,
        code: 'ELZAB_COMMAND_FAILED',
        detail: error?.message || String(error),
      };
    }
  }
}

export class ElzabK10EcrBridge implements ElzabBridge {
  constructor(private readonly timeoutMs = 15_000) {}

  canPrintFiscalReceipts(): boolean {
    return true;
  }

  async checkAvailability(): Promise<ElzabOperationResult> {
    const tools = resolveK10EcrTools();
    if (!tools) {
      return {
        ok: false,
        code: 'ELZAB_BRIDGE_NOT_FOUND',
        detail: 'ELZAB K10 ECR tools were not found. Install/extract official winexe.zip, or set ZIRA_ELZAB_K10_WINEXE_DIR.',
      };
    }

    return {
      ok: true,
      detail: 'ELZAB K10 ECR bridge available.',
      data: { bridge: 'ELZAB_K10_ECR', tools: tools.displayRoot },
    };
  }

  connect(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    return this.readStatus(config, 'connected');
  }

  getStatus(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    return this.readStatus(config, 'status');
  }

  printTest(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    return this.readStatus(config, 'read-only test');
  }

  async printReceipt(config: ElzabConnectionConfig, data: ReceiptData): Promise<ElzabOperationResult> {
    const validation = validateK10ReceiptData(data);
    if (!validation.ok) return validation;

    const port = (config.port || '').trim().toUpperCase();
    if (!/^COM\d{1,3}$/.test(port)) {
      return {
        ok: false,
        code: 'ELZAB_TARGET_MISSING',
        detail: 'ELZAB K10 ECR receipt printing requires a COM port.',
      };
    }

    const tools = resolveK10EcrTools();
    if (!tools) {
      return {
        ok: false,
        code: 'ELZAB_BRIDGE_NOT_FOUND',
        detail: 'ELZAB K10 ECR tools were not found. Install/extract official winexe.zip, or set ZIRA_ELZAB_K10_WINEXE_DIR.',
      };
    }

    const baudRate = config.baudRate || 115200;
    const workDir = path.join(os.tmpdir(), `zira-elzab-k10-receipt-${process.pid}-${Date.now()}`);
    try {
      mkdirSync(workDir, { recursive: true });
      copyFileSync(tools.sequenceExe, path.join(workDir, 'PoSekwSt.exe'));
      copyFileSync(tools.taxExe, path.join(workDir, 'OPodatek.exe'));
      copyFileSync(tools.winIpDll, path.join(workDir, 'WinIP.dll'));
      writeK10Config(workDir, port, baudRate);

      const taxes = await readK10TaxRates(workDir, this.timeoutMs);
      const sequence = buildK10ReceiptSequence(data, taxes);
      const inputPath = path.join(workDir, 'POSEKWST.IN');
      const outputPath = path.join(workDir, 'POSEKWST.OUT');
      writeLatin1(inputPath, sequence);

      await execFileAsync(path.join(workDir, 'PoSekwSt.exe'), ['POSEKWST.IN', outputPath], {
        cwd: workDir,
        timeout: Math.max(this.timeoutMs, 60_000),
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });

      const raw = existsSync(outputPath) ? readFileSync(outputPath, 'latin1') : '';
      const report = readOptionalLatin1(path.join(workDir, 'RAPORT.TXT'));
      const parsed = parseK10SequenceOutput(raw, report);
      if (!parsed.ok) return parsed;

      return {
        ok: true,
        detail: `ELZAB K10 fiscal receipt sent on ${port}.`,
        data: {
          bridge: 'ELZAB_K10_ECR',
          target: port,
          baudRate,
          model: parsed.model,
          sequenceCount: parsed.sequenceCount,
          taxRates: taxes.map((tax) => ({ letter: tax.letter, rate: tax.rate, exempt: tax.exempt })),
        },
      };
    } catch (error: any) {
      return {
        ok: false,
        code: 'ELZAB_COMMAND_FAILED',
        detail: error?.message || String(error),
      };
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  async printReport(): Promise<ElzabOperationResult> {
    return {
      ok: false,
      code: 'ELZAB_UNSUPPORTED_OPERATION',
      detail: 'ELZAB K10 ECR report printing is not wired. Run reports from the authorized cash-register/service workflow.',
    };
  }

  private async readStatus(config: ElzabConnectionConfig, label: string): Promise<ElzabOperationResult> {
    const port = (config.port || '').trim().toUpperCase();
    if (!/^COM\d{1,3}$/.test(port)) {
      return {
        ok: false,
        code: 'ELZAB_TARGET_MISSING',
        detail: 'ELZAB K10 ECR bridge requires a COM port.',
      };
    }

    const tools = resolveK10EcrTools();
    if (!tools) {
      return {
        ok: false,
        code: 'ELZAB_BRIDGE_NOT_FOUND',
        detail: 'ELZAB K10 ECR tools were not found. Install/extract official winexe.zip, or set ZIRA_ELZAB_K10_WINEXE_DIR.',
      };
    }

    const baudRate = config.baudRate || 115200;
    const workDir = path.join(os.tmpdir(), `zira-elzab-k10-${process.pid}-${Date.now()}`);
    try {
      mkdirSync(workDir, { recursive: true });
      copyFileSync(tools.statusExe, path.join(workDir, 'OStatus.exe'));
      copyFileSync(tools.winIpDll, path.join(workDir, 'WinIP.dll'));
      writeK10Config(workDir, port, baudRate);
      writeLatin1(path.join(workDir, 'OSTATUS.IN'), '#1\r\n#\r\n#\r\n');

      const outputPath = path.join(workDir, 'OSTATUS.OUT');
      await execFileAsync(path.join(workDir, 'OStatus.exe'), ['OSTATUS.IN', outputPath], {
        cwd: workDir,
        timeout: this.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });

      const raw = readFileSync(outputPath, 'latin1');
      const parsed = parseK10Status(raw);
      if (!parsed.model) {
        return {
          ok: false,
          code: 'ELZAB_COMMAND_FAILED',
          detail: `ELZAB K10 ${label} did not return a model/status response.`,
          data: { raw },
        };
      }

      return {
        ok: true,
        detail: `ELZAB K10 ${label} OK on ${port}.`,
        data: {
          bridge: 'ELZAB_K10_ECR',
          target: port,
          baudRate,
          model: parsed.model,
          status: parsed.status,
        },
      };
    } catch (error: any) {
      return {
        ok: false,
        code: 'ELZAB_COMMAND_FAILED',
        detail: error?.message || String(error),
      };
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

function writeLatin1(filePath: string, text: string): void {
  writeFileSync(filePath, Buffer.from(text, 'latin1'));
}

function readOptionalLatin1(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'latin1') : '';
}

function writeK10Config(workDir: string, port: string, baudRate: number): void {
  writeLatin1(path.join(workDir, 'KONFIG.TXT'), `$01\t${port}:${baudRate}:STX0:1\t3\r\n`);
}

function parseK10Status(raw: string): { model?: string; status: Record<string, number> } {
  const status: Record<string, number> = {};
  let model: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('#ELZAB')) {
      model = line.slice(1).trim();
      continue;
    }

    const match = line.match(/^\$(\d+)\t(-?\d+)/);
    if (match) status[match[1]] = Number(match[2]);
  }

  return { model, status };
}

interface K10TaxRate {
  letter: string;
  rate: number | null;
  exempt: boolean;
}

function validateK10ReceiptData(data: ReceiptData): ElzabOperationResult {
  if (data.isRefund || data.isReprint) {
    return {
      ok: false,
      code: 'ELZAB_UNSUPPORTED_OPERATION',
      detail: 'ELZAB K10_ECR currently supports only original sale receipts. Refunds and reprints are not sent.',
    };
  }
  if (data.customerNip) {
    return {
      ok: false,
      code: 'ELZAB_UNSUPPORTED_OPERATION',
      detail: 'ELZAB K10_ECR NIP/customer invoice receipt flow is not wired. No fiscal command was sent.',
    };
  }
  if ((data.discount || 0) > 0 || data.items.some((item) => (item.allocatedDiscount || 0) > 0)) {
    return {
      ok: false,
      code: 'ELZAB_LINE_DISCOUNT_UNSUPPORTED',
      detail: 'ELZAB K10_ECR raw receipt sequence does not support discounted Zira receipts yet. No fiscal command was sent.',
    };
  }
  if (data.tenders && data.tenders.length > 1) {
    return {
      ok: false,
      code: 'ELZAB_UNSUPPORTED_OPERATION',
      detail: 'ELZAB K10_ECR split-payment fiscal receipts are not wired. No fiscal command was sent.',
    };
  }
  const paymentMethod = String(data.payment?.method || '').toUpperCase();
  if (paymentMethod && paymentMethod !== 'CASH') {
    return {
      ok: false,
      code: 'ELZAB_UNSUPPORTED_OPERATION',
      detail: `ELZAB K10_ECR currently supports only CASH receipts via PoSekwSt. Got ${paymentMethod}; no fiscal command was sent.`,
    };
  }
  if (!data.items.length) {
    return {
      ok: false,
      code: 'ELZAB_UNSUPPORTED_OPERATION',
      detail: 'ELZAB K10_ECR receipt requires at least one item. No fiscal command was sent.',
    };
  }
  const lineTotal = data.items.reduce((sum, item) => sum + k10LineTotalGrosze(item), 0);
  if (lineTotal !== Math.round(Number(data.total || 0))) {
    return {
      ok: false,
      code: 'ELZAB_UNSUPPORTED_OPERATION',
      detail: `ELZAB K10_ECR receipt total mismatch: line total ${lineTotal} grosze, receipt total ${Math.round(Number(data.total || 0))} grosze. No fiscal command was sent.`,
    };
  }
  return { ok: true };
}

async function readK10TaxRates(workDir: string, timeoutMs: number): Promise<K10TaxRate[]> {
  writeLatin1(path.join(workDir, 'OPODATEK.IN'), '#1\r\n#\r\n#\r\n');
  const outputPath = path.join(workDir, 'OPODATEK.OUT');
  await execFileAsync(path.join(workDir, 'OPodatek.exe'), ['OPODATEK.IN', outputPath], {
    cwd: workDir,
    timeout: Math.max(timeoutMs, 15_000),
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  const raw = existsSync(outputPath) ? readFileSync(outputPath, 'latin1') : '';
  const report = readOptionalLatin1(path.join(workDir, 'RAPORT.TXT'));
  const values = raw
    .split(/\r?\n/)
    .find((line) => line.startsWith('$'))
    ?.slice(1)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!values || values.length < 7) {
    throw new Error(`ELZAB K10 tax-rate read failed${report ? `: ${summarizeK10Report(report)}` : ''}`);
  }

  return values.slice(0, 7).map((value, index) => ({
    letter: String.fromCharCode('A'.charCodeAt(0) + index),
    rate: parseK10TaxRate(value),
    exempt: /^ZWOLNIONA$/i.test(value),
  }));
}

function parseK10TaxRate(value: string): number | null {
  if (/^REZERWA$/i.test(value) || /^ZWOLNIONA$/i.test(value)) return null;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function buildK10ReceiptSequence(data: ReceiptData, taxes: K10TaxRate[]): string {
  const lines: string[] = ['#1', '#', '#'];
  lines.push(`$20h\t1\t4\t0\t${toLeHex4(Math.round(data.total))}`);

  for (const item of data.items) {
    const quantity = k10Quantity(item.quantity);
    const lineTotal = k10LineTotalGrosze(item);
    const vatLetter = k10VatLetter(item.vatRate, taxes);
    lines.push(
      `$06h\t0\t43\t0\t20h:'${k10FixedText(item.name, 28)}':'0':${toLeHex4(quantity.value)}:'${quantity.decimals}':'${k10Unit(item.unit)}':${toLeHex4(Math.round(item.unitPrice))}`,
    );
    lines.push(`$'${vatLetter}'\t0\t4\t0\t${toLeHex4(lineTotal)}`);
  }

  lines.push('$07h\t0\t0\t0');
  lines.push('$24h\t1\t0\t0');
  return `${lines.join('\r\n')}\r\n`;
}

function k10LineTotalGrosze(item: ReceiptData['items'][number]): number {
  return Math.round(Number(item.totalPrice ?? (Number(item.unitPrice) * Number(item.quantity))));
}

function k10Quantity(quantityInput: number): { value: number; decimals: '0' | '1' | '2' | '3' } {
  const quantity = Number(quantityInput);
  if (!(quantity > 0)) {
    throw new Error(`ELZAB K10 quantity must be positive. Got ${String(quantityInput)}.`);
  }

  for (const decimals of [0, 1, 2, 3] as const) {
    const scale = 10 ** decimals;
    const value = Math.round(quantity * scale);
    if (Math.abs(quantity * scale - value) < 0.000001 && value > 0) {
      return { value, decimals: String(decimals) as '0' | '1' | '2' | '3' };
    }
  }

  throw new Error(`ELZAB K10 quantity supports at most 3 decimal places. Got ${quantity}.`);
}

function k10VatLetter(vatRateInput: number, taxes: K10TaxRate[]): string {
  const vatRate = Number(vatRateInput);
  const tax = taxes.find((candidate) => candidate.rate !== null && Math.abs(candidate.rate - vatRate) < 0.001);
  if (tax) return tax.letter;
  throw new Error(
    `ELZAB K10 VAT rate ${vatRate}% is not configured in the cash register PTU table. ` +
    `Read rates: ${taxes.map((candidate) => `${candidate.letter}=${candidate.exempt ? 'ZW' : candidate.rate ?? 'REZERWA'}`).join(', ')}.`,
  );
}

function k10FixedText(value: string | undefined, length: number): string {
  return toFiscalSafeText(value || '')
    .replace(/[':;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, length)
    .padEnd(length, ' ');
}

function k10Unit(value: string | undefined): string {
  return k10FixedText(value || 'szt', 4);
}

function toLeHex4(input: number): string {
  const value = Math.round(Number(input));
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`ELZAB K10 amount out of 4-byte range: ${String(input)}`);
  }
  return [0, 8, 16, 24]
    .map((shift) => `${((value >>> shift) & 0xff).toString(16).padStart(2, '0')}h`)
    .join(':');
}

function parseK10SequenceOutput(raw: string, report: string): ElzabOperationResult & { model?: string; sequenceCount?: number } {
  const commandRows = raw.split(/\r?\n/).filter((line) => line.startsWith('$'));
  const failed = commandRows.find((line) => !/^\$0(?:\t|$)/.test(line));
  const model = raw
    .split(/\r?\n/)
    .find((line) => line.startsWith('#ELZAB'))
    ?.slice(1)
    .trim();

  if (failed) {
    return {
      ok: false,
      code: 'ELZAB_COMMAND_FAILED',
      detail: `ELZAB K10 receipt sequence failed: ${failed}`,
      data: { raw, report },
    };
  }
  if (commandRows.length === 0) {
    return {
      ok: false,
      code: 'ELZAB_COMMAND_FAILED',
      detail: `ELZAB K10 receipt sequence produced no command confirmations${report ? `: ${summarizeK10Report(report)}` : ''}`,
      data: { raw, report },
    };
  }

  return { ok: true, model, sequenceCount: commandRows.length };
}

function summarizeK10Report(report: string): string {
  const errorLine = report.split(/\r?\n/).find((line) => /^#\d+/.test(line) && !line.startsWith('#01\t'));
  return (errorLine || report.split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'unknown error').trim();
}

function resolveK10EcrTools(): {
  statusExe: string;
  taxExe: string;
  sequenceExe: string;
  winIpDll: string;
  displayRoot: string;
} | undefined {
  const explicit = process.env.ZIRA_ELZAB_K10_WINEXE_DIR?.trim();
  const candidates = [
    explicit,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'zira-ai', 'elzab', 'winexe', 'winexe') : undefined,
    path.join(process.cwd(), 'resources', 'elzab', 'winexe', 'winexe'),
    typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'elzab', 'winexe', 'winexe') : undefined,
  ].filter((candidate): candidate is string => !!candidate);

  for (const root of candidates) {
    const statusExe = [
      path.join(root, 'EXE bez widocznego okna', 'OStatus.exe'),
      path.join(root, 'OStatus.exe'),
    ].find((candidate) => existsSync(candidate));
    const taxExe = [
      path.join(root, 'EXE bez widocznego okna', 'OPodatek.exe'),
      path.join(root, 'OPodatek.exe'),
    ].find((candidate) => existsSync(candidate));
    const sequenceExe = [
      path.join(root, 'EXE bez widocznego okna', 'PoSekwSt.exe'),
      path.join(root, 'PoSekwSt.exe'),
    ].find((candidate) => existsSync(candidate));
    const winIpDll = [
      path.join(root, 'WinIP.dll'),
      path.join(path.dirname(root), 'WinIP.dll'),
    ].find((candidate) => existsSync(candidate));

    if (statusExe && taxExe && sequenceExe && winIpDll) {
      return { statusExe, taxExe, sequenceExe, winIpDll, displayRoot: root };
    }
  }

  return undefined;
}

function isPackagedProductionBuild(): boolean {
  try {
    // Lazy require so this module stays testable outside Electron.
    const electron = require('electron');
    return !!electron?.app?.isPackaged;
  } catch {
    return false;
  }
}

/**
 * Dev mock can be enabled via either:
 *   • ZIRA_ELZAB_MOCK=true env var (CI / shell launches)
 *   • A file `elzab-dev-mock.flag` inside the app userData directory
 *     (survives Electron restarts and spawn-chain env loss; toggle by
 *     creating/deleting the file)
 *   • A boolean key `elzabDevMock: true` inside config.json next to it.
 *
 * The file/config flag is the recommended way for local dev because env
 * vars are lost across cmd/npx/Electron auto-restart boundaries.
 */
function isMockEnabled(): boolean {
  const envOn = process.env.ZIRA_ELZAB_MOCK === 'true';
  let userData: string | undefined;
  let flagExists = false;
  let configFlagOn = false;
  try {
    const electron = require('electron');
    userData = electron?.app?.getPath?.('userData');
    if (userData) {
      const fs = require('fs');
      const path = require('path');
      flagExists = fs.existsSync(path.join(userData, 'elzab-dev-mock.flag'));
      const cfgPath = path.join(userData, 'config.json');
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, 'utf8');
        const cfg = JSON.parse(raw);
        if (cfg?.elzabDevMock === true) configFlagOn = true;
      }
    }
  } catch {
    /* ignore */
  }
  const enabled = envOn || flagExists || configFlagOn;
  // Audit log so we can prove which path triggered (or didn't).
  try {
    const logger = require('../../logger').default;
    logger?.info?.(
      `[ElzabBridge] isMockEnabled probe: env=${envOn} flag=${flagExists} configKey=${configFlagOn} userData=${userData || 'NIL'} → ${enabled}`,
    );
  } catch {
    /* logger optional */
  }
  return enabled;
}

export function createDefaultElzabBridge(): ElzabBridge {
  if (isMockEnabled()) {
    if (isPackagedProductionBuild()) {
      // HARD FAIL — never allow mock in shipped builds. Sales would be illegal.
      throw new Error(
        'ELZAB_MOCK_REFUSED_IN_PRODUCTION: ZIRA_ELZAB_MOCK=true is rejected in packaged production builds. ' +
        'The mock bridge is dev-only because it cannot produce valid Polish fiscal receipts.',
      );
    }
    // Loud warning so this is never missed in logs or screen captures.
    const banner = '*'.repeat(72);
    // eslint-disable-next-line no-console
    console.warn(`\n${banner}\n[ElzabBridge] DEV MOCK BRIDGE ACTIVE — DO NOT USE IN PRODUCTION\n[ElzabBridge] Test prints will succeed without real hardware. Real fiscal\n[ElzabBridge] commands (printReceipt, printReport) will be REFUSED.\n${banner}\n`);
    try {
      // Best-effort: log via app logger if available so it lands in combined.log.
      const logger = require('../../logger').default;
      logger?.warn?.('[ElzabBridge] DEV MOCK ACTIVE — dev only, fiscal receipts will be refused');
    } catch { /* logger optional for unit tests */ }
    return new DevMockElzabBridge();
  }

  const executablePath = process.env.ZIRA_ELZAB_BRIDGE_PATH?.trim();
  if (!executablePath) {
    const bundledSidecar = resolveBundledPowerShellSidecar();
    if (bundledSidecar) return new ElzabSidecarBridge(bundledSidecar);
    return new MissingElzabBridge();
  }
  return new ElzabSidecarBridge(executablePath);
}

function buildSidecarEnv(): NodeJS.ProcessEnv {
  if (!isRealFiscalPrintEnabled()) return process.env;
  return { ...process.env, ALLOW_REAL_FISCAL_PRINT: 'true' };
}

function findPowerShellExe(): string | undefined {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function getElectronUserDataPath(): string | undefined {
  try {
    const electron = require('electron');
    return electron?.app?.getPath?.('userData');
  } catch {
    return undefined;
  }
}

function resolveConfigPath(): string | undefined {
  const userData = getElectronUserDataPath();
  if (userData) return path.join(userData, 'config.json');
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'zira-ai', 'config.json');
  return undefined;
}

function resolveBundledPowerShellSidecar(): ElzabSidecarCommand | undefined {
  if (process.env.ZIRA_ELZAB_DISABLE_AUTO_SIDECAR === 'true') return undefined;

  const powerShell = findPowerShellExe();
  if (!powerShell) return undefined;

  const explicitScript = process.env.ZIRA_ELZAB_SIDECAR_SCRIPT?.trim();
  const userData = getElectronUserDataPath();
  const candidates = [
    explicitScript,
    path.join(process.cwd(), 'resources', 'elzab', 'sidecar', 'elzab-stx-sidecar.ps1'),
    typeof process.resourcesPath === 'string'
      ? path.join(process.resourcesPath, 'elzab', 'sidecar', 'elzab-stx-sidecar.ps1')
      : undefined,
    userData ? path.join(userData, 'elzab', 'sidecar', 'elzab-stx-sidecar.ps1') : undefined,
  ].filter((candidate): candidate is string => !!candidate);

  const script = candidates.find((candidate) => existsSync(candidate));
  if (!script) return undefined;

  return {
    executablePath: powerShell,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    cwd: path.dirname(script),
    displayPath: script,
  };
}
