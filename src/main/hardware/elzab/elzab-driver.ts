import type { DailyReportData, PrinterStatusInfo, ReceiptData } from '../../../shared/types';
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
}

export class ElzabDriver {
  private connectionState: ElzabConnectionState = 'disconnected';
  private lastDiagnostic: { code: ElzabDiagnosticCode; detail?: string } | undefined;
  private bridge: ElzabBridge;

  constructor(private options: ElzabDriverOptions) {
    this.options.baudRate = options.baudRate || 9600;
    this.bridge = options.bridge || createDefaultElzabBridge();
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
    await this.requireOk(
      await this.bridge.printReceipt(this.connectionConfig(), data),
      'ELZAB_STX fiscal receipt failed',
    );
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
