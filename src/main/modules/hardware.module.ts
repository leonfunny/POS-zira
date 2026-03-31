/**
 * HardwareModule
 *
 * Owns all printer drivers, barcode scanner, and print job routing.
 * Replaces the printer management methods from PrintAgentApp.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
import { PosnetDriver } from '../hardware/posnet/posnet-driver';
import { ZebraDriver } from '../hardware/zebra/zebra-driver';
import { ThermalDriver } from '../hardware/thermal/thermal-driver';
import { HidScanner } from '../hardware/scanner/hid-scanner';
import { listSerialPorts, listWindowsPrinters } from '../hardware/port-utils';
import {
  IPC_CHANNELS,
  PrinterType,
  PrintJobType,
  PrinterConfig,
  PrinterProtocol,
  LabelData,
  ReceiptData,
  DailyReportData,
  DeviceStatus,
} from '../../shared/types';
import { getConfig, getConfigValue } from '../config/store';
import SocketClient from '../network/socket-client';
import { WindowManager } from '../windows/window-manager';
import { app } from 'electron';
import logger from '../logger';

type PrinterDriver = PosnetDriver | ZebraDriver | ThermalDriver;
type PrinterDriversMap = { [key in PrinterType]?: PrinterDriver };

/** How often to run printer health checks (ms) */
const HEALTH_CHECK_INTERVAL = 30_000;

/** Max retries for a failed print job */
const PRINT_JOB_MAX_RETRIES = 2;

/** Delay between retries (ms) */
const PRINT_JOB_RETRY_DELAY = 2_000;

export class HardwareModule extends BaseModule {
  readonly name = 'hardware';

  // Multi-printer dictionary
  private printers: PrinterDriversMap = {};
  // Legacy printers (backward compatibility)
  private receiptPrinter: PrinterDriver | null = null;
  private labelPrinter: PrinterDriver | null = null;
  private printerDriver: PrinterDriver | null = null;
  // Barcode scanner
  private scanner: HidScanner | null = null;
  // Health check timer
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  // Event bus reference for emitting status changes
  private bus: EventBus | null = null;

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[HardwareModule] Initializing printers...');
    await this.reinitializePrinter();

    logger.info('[HardwareModule] Initializing barcode scanner...');
    try {
      this.scanner = new HidScanner();
      this.scanner.start((barcode) => {
        logger.info(`[Scanner] Barcode scanned: ${barcode}`);
        const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
        if (socket?.isConnected()) {
          socket.sendBarcodeScan(barcode);
        }
        // Notify main + POS windows
        const mainWindow = this.container.getOptional<Electron.BrowserWindow>(SERVICE_TOKENS.MAIN_WINDOW);
        try { mainWindow?.webContents.send(IPC_CHANNELS.BARCODE_SCANNED, barcode); } catch {}
        const wm = this.container.getOptional<WindowManager>(SERVICE_TOKENS.WINDOW_MANAGER);
        const posWindow = wm?.getWindow('pos');
        try { if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send(IPC_CHANNELS.BARCODE_SCANNED, barcode); } catch {}
      });
    } catch (err) {
      logger.error('[HardwareModule] Scanner initialization failed (non-fatal):', err);
      this.scanner = null;
    }

    // Expose printers map and module reference in container
    this.container.set(SERVICE_TOKENS.PRINTERS, this.printers);
    this.container.set(SERVICE_TOKENS.HARDWARE_MODULE, this);

    // Start periodic health checks
    this.startHealthCheck();

    this.setState(ModuleState.READY);
    logger.info('[HardwareModule] Initialized');
  }

  registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.LIST_PORTS, async () => {
      // Use the same shared utility as the drivers
      return listSerialPorts();
    });

    ipcMain.handle(IPC_CHANNELS.LIST_WINDOWS_PRINTERS, async () => {
      try {
        // Strategy 1: Electron built-in async API (getPrintersAsync, available since Electron 27)
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          const printers = await win.webContents.getPrintersAsync();
          if (printers.length > 0) {
            const names = printers.map((p) => p.name);
            logger.info(`[HardwareModule] Found ${names.length} printers via Electron API`);
            return names;
          }
        }
      } catch (err) {
        logger.warn('[HardwareModule] Electron printer API failed:', err);
      }

      try {
        // Strategy 2: shared utility (PowerShell Get-Printer → Get-CimInstance fallback)
        const names = await listWindowsPrinters();
        if (names.length > 0) {
          logger.info(`[HardwareModule] Found ${names.length} printers via PowerShell`);
          return names;
        }
      } catch (err) {
        logger.warn('[HardwareModule] PowerShell printer list failed:', err);
      }

      logger.warn('[HardwareModule] No printers found by any method');
      return [];
    });

    ipcMain.handle(IPC_CHANNELS.TEST_PRINT, async () => {
      return this.testPrint();
    });

    ipcMain.handle(IPC_CHANNELS.TEST_PRINTER_BY_TYPE, async (_, printerType: string) => {
      return this.testPrinterByType(printerType as PrinterType);
    });

    logger.info('[HardwareModule] IPC handlers registered');
  }

  registerEventHandlers(bus: EventBus): void {
    this.bus = bus;

    // Route incoming print jobs
    bus.on('print:job-received', async (payload) => {
      try {
        await this.handlePrintJob(payload as any);
      } catch (err) {
        logger.error('[HardwareModule] Unhandled error in print job handler:', err);
      }
    });

    // Re-initialize printers when config changes
    bus.on('config:changed', async (payload) => {
      try {
        const printerKeys = ['printers', 'printerPort', 'printerProtocol', 'printerBaudRate', 'zebraPrinter', 'receiptPrinter', 'labelPrinter'];
        if (payload.changedKeys.some(k => printerKeys.includes(k))) {
          logger.info('[HardwareModule] Printer config changed, reinitializing...');
          await this.reinitializePrinter();
        }
      } catch (err) {
        logger.error('[HardwareModule] Unhandled error in config:changed handler:', err);
      }
    });
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        definition: {
          type: 'function',
          function: {
            name: 'print_receipt',
            description: 'Print a receipt on the thermal printer',
            parameters: {
              type: 'object',
              properties: {
                order_number: { type: 'string', description: 'Order number' },
                items: { type: 'string', description: 'Comma-separated items' },
              },
              required: [],
            },
          },
        },
        module: this.name,
        category: 'hardware',
        execute: async () => {
          const result = await this.testPrint();
          return result.success ? '✅ Test receipt printed' : `❌ ${result.error}`;
        },
      },
      {
        definition: {
          type: 'function',
          function: {
            name: 'print_label',
            description: 'Print a barcode label on the label printer',
            parameters: {
              type: 'object',
              properties: {
                barcode: { type: 'string', description: 'Barcode value' },
                text: { type: 'string', description: 'Text below barcode' },
              },
              required: ['barcode'],
            },
          },
        },
        module: this.name,
        category: 'hardware',
        execute: async (args) => {
          const result = await this.printLabel(args.barcode as string, args.text as string | undefined);
          return result.success ? '✅ Label printed' : `❌ ${result.error}`;
        },
      },
      {
        definition: {
          type: 'function',
          function: {
            name: 'open_drawer',
            description: 'Open the cash drawer connected to the receipt printer',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        module: this.name,
        category: 'hardware',
        execute: async () => {
          const result = await this.openCashDrawer();
          return result.success ? '✅ Cash drawer opened' : `❌ ${result.error}`;
        },
      },
      {
        definition: {
          type: 'function',
          function: {
            name: 'get_printer_status',
            description: 'Get status of all connected printers',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        module: this.name,
        category: 'hardware',
        execute: async () => {
          const status = this.getPrintersStatus();
          if (status.length === 0) return '❌ No printers configured';
          return status
            .map((p) => `${p.type}: ${p.connected ? '✅ Connected' : '❌ Disconnected'} (${p.protocol || 'unknown'} @ ${p.address || 'n/a'})`)
            .join('\n');
        },
      },
    ];
  }

  // ─── Public accessors (used by other modules) ─────────────────

  getPrinterForType(printerType: PrinterType): PrinterDriver | null {
    if (this.printers[printerType]) return this.printers[printerType]!;
    if (printerType === PrinterType.LABEL && this.labelPrinter) return this.labelPrinter;
    if ((printerType === PrinterType.RECEIPT || printerType === PrinterType.TICKET || printerType === PrinterType.KITCHEN) && this.receiptPrinter) {
      return this.receiptPrinter;
    }
    return this.printerDriver;
  }

  getDeviceStatus(): DeviceStatus {
    const config = getConfig();
    const hasPrintersDict = config.printers && Object.keys(config.printers).length > 0;
    const hasLegacyMultiPrinter = config.receiptPrinter?.enabled || config.labelPrinter?.enabled;

    let printerConnected = false;
    let printerPort: string | null = null;

    if (hasPrintersDict && config.printers) {
      const connectedPrinters: string[] = [];
      for (const [pt, pc] of Object.entries(config.printers)) {
        if (!pc?.enabled) continue;
        const driver = this.printers[pt as PrinterType];
        if (driver?.isConnected()) {
          printerConnected = true;
          connectedPrinters.push(`${pt}: ${pc.protocol === 'ZEBRA' || pc.protocol === 'WINDOWS' ? pc.windowsPrinter : pc.port}`);
        }
      }
      printerPort = connectedPrinters.length > 0 ? connectedPrinters.join(', ') : null;
    } else if (hasLegacyMultiPrinter) {
      const rc = this.receiptPrinter?.isConnected() || false;
      const lc = this.labelPrinter?.isConnected() || false;
      printerConnected = rc || lc;
      const ports: string[] = [];
      if (rc) ports.push(`Receipt: ${config.receiptPrinter?.windowsPrinter || config.receiptPrinter?.port}`);
      if (lc) ports.push(`Label: ${config.labelPrinter?.windowsPrinter || config.labelPrinter?.port}`);
      printerPort = ports.length > 0 ? ports.join(', ') : null;
    } else {
      printerPort = config.printerProtocol === 'ZEBRA' ? config.zebraPrinter || null : config.printerPort || null;
      printerConnected = this.printerDriver?.isConnected() || false;
    }

    return {
      printerConnected,
      printerPort,
      scannerActive: this.scanner?.isActive() || false,
      appVersion: app.getVersion(),
    };
  }

  getPrintersStatus(): Array<{ type: string; connected: boolean; protocol?: string; address?: string }> {
    const config = getConfig();
    const result: Array<{ type: string; connected: boolean; protocol?: string; address?: string }> = [];

    if (config.printers && Object.keys(config.printers).length > 0) {
      for (const [pt, pc] of Object.entries(config.printers)) {
        if (!pc?.enabled) continue;
        result.push({
          type: pt,
          connected: this.printers[pt as PrinterType]?.isConnected() || false,
          protocol: pc.protocol,
          address: pc.windowsPrinter || pc.port,
        });
      }
    }

    if (result.length === 0) {
      if (config.receiptPrinter?.enabled) {
        result.push({ type: 'RECEIPT', connected: this.receiptPrinter?.isConnected() || false, protocol: config.receiptPrinter.protocol, address: config.receiptPrinter.windowsPrinter || config.receiptPrinter.port });
      }
      if (config.labelPrinter?.enabled) {
        result.push({ type: 'LABEL', connected: this.labelPrinter?.isConnected() || false, protocol: config.labelPrinter.protocol, address: config.labelPrinter.windowsPrinter || config.labelPrinter.port });
      }
      if (result.length === 0 && (config.printerPort || config.zebraPrinter)) {
        result.push({ type: 'DEFAULT', connected: this.printerDriver?.isConnected() || false, protocol: config.printerProtocol, address: config.zebraPrinter || config.printerPort });
      }
    }

    return result;
  }

  async testPrint(): Promise<{ success: boolean; error?: string; results?: Record<string, boolean> }> {
    const results: Record<string, boolean> = {};
    let anySuccess = false;
    let lastError = '';

    for (const [pt, driver] of Object.entries(this.printers)) {
      if (driver?.isConnected()) {
        try { await driver.printTest(); results[pt] = true; anySuccess = true; } catch (e: any) { results[pt] = false; lastError = e.message; }
      }
    }

    if (Object.keys(results).length === 0) {
      for (const [n, d] of [['Receipt', this.receiptPrinter], ['Label', this.labelPrinter], ['Printer', this.printerDriver]] as const) {
        if (d?.isConnected()) {
          try { await d.printTest(); results[n] = true; anySuccess = true; } catch (e: any) { results[n] = false; lastError = e.message; }
        }
      }
    }

    if (Object.keys(results).length === 0) return { success: false, error: 'No printer connected' };
    return { success: anySuccess, error: anySuccess ? undefined : lastError, results };
  }

  async testPrinterByType(printerType: PrinterType): Promise<{ success: boolean; error?: string }> {
    let driver: PrinterDriver | undefined | null = this.printers[printerType];
    if (!driver) {
      if (printerType === PrinterType.RECEIPT) driver = this.receiptPrinter;
      else if (printerType === PrinterType.LABEL) driver = this.labelPrinter;
      else driver = this.printerDriver;
    }
    if (!driver?.isConnected()) return { success: false, error: `Printer ${printerType} not connected` };
    try { await driver.printTest(); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
  }

  async openCashDrawer(printerType?: PrinterType): Promise<{ success: boolean; error?: string }> {
    let driver: PrinterDriver | null = null;
    if (printerType) { driver = this.printers[printerType] || null; }
    else { driver = this.printers[PrinterType.RECEIPT] || this.receiptPrinter || this.printerDriver || null; }
    if (!driver) return { success: false, error: 'No printer available for cash drawer' };
    if (!driver.isConnected()) return { success: false, error: 'Printer not connected' };
    try { await driver.openDrawer(); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
  }

  async printLabel(barcode: string, text?: string): Promise<{ success: boolean; error?: string }> {
    const driver = this.printers[PrinterType.LABEL] || this.labelPrinter;
    if (!driver) return { success: false, error: 'No label printer configured' };
    if (!driver.isConnected()) return { success: false, error: 'Label printer not connected' };
    if (!(driver instanceof ZebraDriver)) return { success: false, error: 'Label printing requires Zebra printer' };
    try {
      await driver.printLabel({ barcode, barcodeType: barcode.length === 13 ? 'EAN13' : 'CODE128', text1: text || barcode, quantity: 1 });
      return { success: true };
    } catch (e: any) { return { success: false, error: e.message }; }
  }

  async reinitializePrinter(): Promise<void> {
    const config = getConfig();
    const initErrors: string[] = [];

    // Disconnect all
    for (const [pt, p] of Object.entries(this.printers)) { try { p?.disconnect(); } catch {} }
    this.printers = {};
    for (const p of [this.receiptPrinter, this.labelPrinter, this.printerDriver]) { try { p?.disconnect(); } catch {} }

    const hasPrintersDict = config.printers && Object.keys(config.printers).length > 0;

    if (hasPrintersDict && config.printers) {
      for (const [ptStr, pc] of Object.entries(config.printers)) {
        if (!pc?.enabled) continue;
        const pt = ptStr as PrinterType;
        const driver = this.createPrinterFromConfig(pc, pt);
        if (driver) {
          try {
            const ok = await driver.connect();
            if (ok) {
              this.printers[pt] = driver;
            } else {
              initErrors.push(`${pt}: failed to connect`);
            }
          } catch (e: any) {
            logger.error(`[HardwareModule] ${pt} connect failed:`, e);
            initErrors.push(`${pt}: ${e.message}`);
          }
        }
      }
      this.receiptPrinter = null; this.labelPrinter = null; this.printerDriver = null;
    } else if (config.receiptPrinter?.enabled || config.labelPrinter?.enabled) {
      this.receiptPrinter = this.createPrinterFromConfig(config.receiptPrinter, 'Receipt Printer' as any);
      if (this.receiptPrinter) {
        try {
          const ok = await this.receiptPrinter.connect();
          if (!ok) initErrors.push('Receipt: failed to connect');
        } catch (e: any) { initErrors.push(`Receipt: ${e.message}`); }
      }
      this.labelPrinter = this.createPrinterFromConfig(config.labelPrinter, 'Label Printer' as any);
      if (this.labelPrinter) {
        try {
          const ok = await this.labelPrinter.connect();
          if (!ok) initErrors.push('Label: failed to connect');
        } catch (e: any) { initErrors.push(`Label: ${e.message}`); }
      }
      this.printerDriver = null;
    } else {
      this.receiptPrinter = null; this.labelPrinter = null;
      this.printerDriver = this.createPrinterDriverLegacy();
      if (this.printerDriver) {
        try {
          const ok = await this.printerDriver.connect();
          if (!ok) initErrors.push('Default printer: failed to connect');
        } catch (e: any) { initErrors.push(`Default: ${e.message}`); }
      }
    }

    // Update container reference
    this.container.set(SERVICE_TOKENS.PRINTERS, this.printers);

    // Surface errors to UI
    if (initErrors.length > 0) {
      logger.warn(`[HardwareModule] Printer init issues: ${initErrors.join('; ')}`);
      this.bus?.emit('hardware:printer-errors', { errors: initErrors });
    }

    // Notify status change
    this.notifyStatusChange();
  }

  // ─── Periodic Health Check ──────────────────────────────────────

  private startHealthCheck(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.runHealthCheck();
      } catch (err) {
        logger.error('[HardwareModule] Health check error:', err);
      }
    }, HEALTH_CHECK_INTERVAL);

    logger.info(`[HardwareModule] Health check started (every ${HEALTH_CHECK_INTERVAL / 1000}s)`);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
      logger.info('[HardwareModule] Health check stopped');
    }
  }

  private async runHealthCheck(): Promise<void> {
    let changed = false;

    // Check all drivers in the printers map
    for (const [pt, driver] of Object.entries(this.printers)) {
      if (!driver) continue;
      const wasBefore = driver.isConnected();
      if ('healthCheck' in driver && typeof (driver as any).healthCheck === 'function') {
        await (driver as any).healthCheck();
      }
      if (driver.isConnected() !== wasBefore) {
        changed = true;
        logger.info(`[HardwareModule] Health check: ${pt} ${driver.isConnected() ? 'reconnected' : 'disconnected'}`);
      }
    }

    // Check legacy drivers
    for (const [label, driver] of [
      ['Receipt', this.receiptPrinter],
      ['Label', this.labelPrinter],
      ['Default', this.printerDriver],
    ] as const) {
      if (!driver) continue;
      const wasBefore = driver.isConnected();
      if ('healthCheck' in driver && typeof (driver as any).healthCheck === 'function') {
        await (driver as any).healthCheck();
      }
      if (driver.isConnected() !== wasBefore) {
        changed = true;
        logger.info(`[HardwareModule] Health check: ${label} ${driver.isConnected() ? 'reconnected' : 'disconnected'}`);
      }
    }

    if (changed) {
      this.notifyStatusChange();
    }
  }

  /**
   * Notify UI and backend about printer status changes.
   */
  private notifyStatusChange(): void {
    const status = this.getDeviceStatus();

    // Notify renderer windows
    const mainWindow = this.container.getOptional<Electron.BrowserWindow>(SERVICE_TOKENS.MAIN_WINDOW);
    try { mainWindow?.webContents.send(IPC_CHANNELS.DEVICE_STATUS, status); } catch {}

    // Notify backend via Socket.IO
    const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
    if (socket?.isConnected()) {
      socket.sendDeviceStatus(status);
    }

    // Emit on event bus
    this.bus?.emit('hardware:status-changed', status);
  }

  // ─── Private helpers ──────────────────────────────────────────

  private createPrinterFromConfig(config: PrinterConfig | undefined, name: string): PrinterDriver | null {
    if (!config || !config.enabled) return null;
    if (config.protocol === 'ZEBRA' || config.protocol === 'WINDOWS') {
      if (config.windowsPrinter) return new ZebraDriver(config.windowsPrinter, config.labelWidth || 100, config.labelHeight || 50);
      return null;
    }
    if (config.protocol === 'POSNET') {
      if (config.port) return new PosnetDriver(config.port, config.baudRate || 9600);
      logger.warn(`[HardwareModule] POSNET printer "${name}" requires a serial port`);
      return null;
    }
    if (config.windowsPrinter) return new ThermalDriver(config.windowsPrinter, config.baudRate || 9600, 'USB', config.paperWidth || 80, config.charsPerLine || 48);
    if (config.port) return new ThermalDriver(config.port, config.baudRate || 9600, 'SERIAL', config.paperWidth || 80, config.charsPerLine || 48);
    return null;
  }

  private createPrinterDriverLegacy(): PrinterDriver | null {
    const protocol = getConfigValue('printerProtocol') as PrinterProtocol;
    if (protocol === 'ZEBRA' || protocol === 'WINDOWS') {
      const name = getConfigValue('zebraPrinter') as string | undefined;
      if (name) return new ZebraDriver(name, (getConfigValue('labelWidth') as number) || 100, (getConfigValue('labelHeight') as number) || 50);
      return null;
    }
    const port = getConfigValue('printerPort') as string | undefined;
    const zebra = getConfigValue('zebraPrinter') as string | undefined;
    const baud = (getConfigValue('printerBaudRate') as number) || 9600;
    if (zebra) return new ThermalDriver(zebra, baud, 'USB', 80, 48);
    if (port) return new ThermalDriver(port, baud, 'SERIAL', 80, 48);
    return null;
  }

  private getPrinterTypeForJob(job: any): PrinterType {
    if (job.printerType) return job.printerType;
    if (job.jobType === PrintJobType.LABEL || job.jobType === PrintJobType.BARCODE) return PrinterType.LABEL;
    return PrinterType.RECEIPT;
  }

  /**
   * Check if a print job type is a fiscal operation.
   * Fiscal jobs (receipts, invoices on POSNET, Z-reports) must BLOCK the sale on failure
   * per Polish fiscal regulations — they cannot be silently skipped.
   */
  private isFiscalJob(job: any): boolean {
    // Z_REPORT is a fiscal zeroing operation
    if (job.jobType === PrintJobType.Z_REPORT) return true;
    // Receipts and invoices printed on a POSNET fiscal printer are fiscal
    if (
      (job.jobType === PrintJobType.RECEIPT || job.jobType === PrintJobType.INVOICE) &&
      this.getPrinterForType(this.getPrinterTypeForJob(job)) instanceof PosnetDriver
    ) {
      return true;
    }
    return false;
  }

  /**
   * Handle a print job with retry logic.
   *
   * Fiscal jobs (POSNET receipts/invoices, Z-reports) use a strict retry policy:
   * - Fixed 2s delay between retries (no exponential backoff)
   * - On final failure: status = 'BLOCKED' so the POS UI can prevent the sale
   *
   * Non-fiscal jobs use the standard retry with a 'FAILED' status on exhaustion.
   */
  private async handlePrintJob(job: any): Promise<void> {
    const printerType = this.getPrinterTypeForJob(job);
    const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
    const fiscal = this.isFiscalJob(job);

    for (let attempt = 0; attempt <= PRINT_JOB_MAX_RETRIES; attempt++) {
      const targetPrinter = this.getPrinterForType(printerType);

      if (!targetPrinter?.isConnected()) {
        if (attempt < PRINT_JOB_MAX_RETRIES) {
          logger.warn(`[HardwareModule] Job ${job.jobId}: printer ${printerType} not connected, retry ${attempt + 1}/${PRINT_JOB_MAX_RETRIES} in ${PRINT_JOB_RETRY_DELAY}ms...`);
          socket?.sendJobStatus(job.jobId, 'RETRYING', `Printer not connected, retry ${attempt + 1}/${PRINT_JOB_MAX_RETRIES}`);
          await new Promise(r => setTimeout(r, PRINT_JOB_RETRY_DELAY));
          await this.runHealthCheck();
          continue;
        }
        const failStatus = fiscal ? 'BLOCKED' : 'FAILED';
        const failMsg = fiscal
          ? `FISCAL PRINTER ${printerType} NOT CONNECTED — sale must be blocked`
          : `Printer ${printerType} not connected`;
        logger.error(`[HardwareModule] Job ${job.jobId}: ${failMsg}`);
        socket?.sendJobStatus(job.jobId, failStatus, failMsg);
        return;
      }

      try {
        socket?.sendJobStatus(job.jobId, 'PRINTING');
        const isLabel = printerType === PrinterType.LABEL;
        const isReport = [PrintJobType.DAILY_REPORT, PrintJobType.X_REPORT, PrintJobType.Z_REPORT].includes(job.jobType);

        if (isLabel) {
          if (targetPrinter instanceof ZebraDriver) await targetPrinter.printLabel(job.payload as LabelData);
          else throw new Error('Label printing requires Zebra printer');
        } else if (isReport) {
          if (targetPrinter instanceof ThermalDriver) {
            const rd = job.payload as DailyReportData;
            if (job.jobType === PrintJobType.DAILY_REPORT) await targetPrinter.printDailyReport(rd);
            else if (job.jobType === PrintJobType.X_REPORT) await targetPrinter.printXReport(rd);
            else await targetPrinter.printZReport(rd);
          } else throw new Error('Reports require Thermal printer');
        } else {
          await targetPrinter.printReceipt(job.payload as ReceiptData);
        }

        socket?.sendJobStatus(job.jobId, 'COMPLETED');
        return; // success — exit retry loop
      } catch (error: any) {
        logger.error(`[HardwareModule] Job ${job.jobId} attempt ${attempt + 1} failed:`, error);

        if (attempt < PRINT_JOB_MAX_RETRIES) {
          logger.info(`[HardwareModule] Retrying in ${PRINT_JOB_RETRY_DELAY}ms...`);
          await new Promise(r => setTimeout(r, PRINT_JOB_RETRY_DELAY));
        } else {
          const failStatus = fiscal ? 'BLOCKED' : 'FAILED';
          const failMsg = fiscal
            ? `FISCAL PRINT FAILED — sale must be blocked: ${error.message}`
            : error.message;
          socket?.sendJobStatus(job.jobId, failStatus, failMsg);
        }
      }
    }
  }

  async start(): Promise<void> { this.setState(ModuleState.RUNNING); }

  async stop(): Promise<void> {
    this.stopHealthCheck();
    this.scanner?.stop();
    for (const d of Object.values(this.printers)) { try { d?.disconnect(); } catch {} }
    for (const d of [this.receiptPrinter, this.labelPrinter, this.printerDriver]) { try { d?.disconnect(); } catch {} }
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> {
    this.stopHealthCheck();
    this.scanner?.stop();
    for (const d of Object.values(this.printers)) { try { d?.disconnect(); } catch {} }
    for (const d of [this.receiptPrinter, this.labelPrinter, this.printerDriver]) { try { d?.disconnect(); } catch {} }
    this.setState(ModuleState.STOPPED);
  }
}
