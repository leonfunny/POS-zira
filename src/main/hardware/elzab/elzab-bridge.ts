import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import type { DailyReportData, ReceiptData } from '../../../shared/types';

const execFileAsync = promisify(execFile);

export type ElzabDiagnosticCode =
  | 'ELZAB_BRIDGE_NOT_CONFIGURED'
  | 'ELZAB_BRIDGE_NOT_FOUND'
  | 'ELZAB_BRIDGE_BAD_RESPONSE'
  | 'ELZAB_TARGET_MISSING'
  | 'ELZAB_HARDWARE_NOT_FOUND'
  | 'ELZAB_PROTOCOL_NOT_READY'
  | 'ELZAB_UNSUPPORTED_OPERATION'
  | 'ELZAB_COMMAND_FAILED';

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
  checkAvailability(): Promise<ElzabOperationResult>;
  connect(config: ElzabConnectionConfig): Promise<ElzabOperationResult>;
  getStatus(config: ElzabConnectionConfig): Promise<ElzabOperationResult>;
  printTest(config: ElzabConnectionConfig): Promise<ElzabOperationResult>;
  printReceipt(config: ElzabConnectionConfig, data: ReceiptData): Promise<ElzabOperationResult>;
  printReport?(config: ElzabConnectionConfig, kind: 'DAILY' | 'X' | 'Z', data: DailyReportData): Promise<ElzabOperationResult>;
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
  constructor(
    private readonly executablePath: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async checkAvailability(): Promise<ElzabOperationResult> {
    if (!existsSync(this.executablePath)) {
      return {
        ok: false,
        code: 'ELZAB_BRIDGE_NOT_FOUND',
        detail: `ELZAB sidecar not found at ${this.executablePath}`,
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
      const { stdout } = await execFileAsync(this.executablePath, [command, encoded], {
        timeout: this.timeoutMs,
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

export function createDefaultElzabBridge(): ElzabBridge {
  const executablePath = process.env.ZIRA_ELZAB_BRIDGE_PATH?.trim();
  if (!executablePath) return new MissingElzabBridge();
  return new ElzabSidecarBridge(executablePath);
}
