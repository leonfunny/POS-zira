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
import { DeviceDetectionService } from '../hardware/posnet/device-detection-service';
import { PosnetProbeEngine } from '../hardware/posnet/posnet-probe-engine';
import { DeviceProfileRegistry } from '../hardware/posnet/device-profile-registry';
import { FiscalPrinterAdapter } from '../hardware/posnet/fiscal-printer-adapter';
import { ZebraDriver } from '../hardware/zebra/zebra-driver';
import { UniversalDetectionService, UniversalDeviceRegistry } from '../hardware/detection';
import { printLabelToDevice, cleanupOldLabels, getMaxServicesPerLabel } from '../hardware/pdf/pdf-printer';
import { ThermalDriver } from '../hardware/thermal/thermal-driver';
import { HidScanner } from '../hardware/scanner/hid-scanner';
import { listSerialPorts, listWindowsPrinters, listWindowsPrintersDetailed } from '../hardware/port-utils';
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
  CheckinConfirmationData,
  ALLOWED_PROTOCOLS_BY_TYPE,
} from '../../shared/types';
import { getConfig, getConfigValue } from '../config/store';
import { getPosnetDriverStatus, installPosnetDriver, triggerWindowsDriverScan, classifyPrinterCategory, DetectedDevice } from '../hardware/driver-installer';
import { setConfig } from '../config/store';
import SocketClient from '../network/socket-client';
import { WindowManager } from '../windows/window-manager';
import { app } from 'electron';
import logger from '../logger';

type PrinterDriver = PosnetDriver | ZebraDriver | ThermalDriver;
type PrinterDriversMap = { [key in PrinterType]?: PrinterDriver };

/** How often to run printer health checks (ms) */
const HEALTH_CHECK_INTERVAL = 30_000;

/** Health check backoff multipliers: after N consecutive failures, skip N×interval checks.
 *  Index = min(failCount, length-1). E.g. [1,2,4,10] → 30s, 60s, 120s, 300s */
const HEALTH_CHECK_BACKOFF = [1, 2, 4, 10];

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
  // Posnet detection services
  private deviceRegistry: DeviceProfileRegistry | null = null;
  private detectionService: DeviceDetectionService | null = null;
  private fiscalAdapter: FiscalPrinterAdapter | null = null;
  // Universal detection services (all printer types)
  private universalRegistry: UniversalDeviceRegistry | null = null;
  private universalDetection: UniversalDetectionService | null = null;
  // (PDF label generator removed — using HTML print + save instead)
  // Health check timer
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  // Last known serial ports — for detecting port changes
  private lastKnownPorts: string[] = [];
  // Health check backoff: consecutive fail count per printer type key
  private healthCheckFailCount: Map<string, number> = new Map();
  private healthCheckTick = 0;
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
        try { mainWindow?.webContents.send(IPC_CHANNELS.BARCODE_SCANNED, barcode); } catch (err: any) { logger.debug('[HardwareModule] send barcode to main window failed:', err?.message); }
        const wm = this.container.getOptional<WindowManager>(SERVICE_TOKENS.WINDOW_MANAGER);
        const posWindow = wm?.getWindow('pos');
        try { if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send(IPC_CHANNELS.BARCODE_SCANNED, barcode); } catch (err: any) { logger.debug('[HardwareModule] send barcode to POS window failed:', err?.message); }
      });
    } catch (err) {
      logger.error('[HardwareModule] Scanner initialization failed (non-fatal):', err);
      this.scanner = null;
    }

    // Initialize Posnet detection services
    logger.info('[HardwareModule] Initializing Posnet detection services...');
    this.deviceRegistry = new DeviceProfileRegistry();
    const probeEngine = new PosnetProbeEngine();
    this.detectionService = new DeviceDetectionService(probeEngine, this.deviceRegistry);
    this.fiscalAdapter = new FiscalPrinterAdapter(this.deviceRegistry);

    // Initialize universal detection services (all printer types)
    logger.info('[HardwareModule] Initializing universal detection services...');
    this.universalRegistry = new UniversalDeviceRegistry();
    this.universalDetection = new UniversalDetectionService(this.universalRegistry);

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
      const ports = await listSerialPorts();
      // Trigger background rescan when port list changes (USB plug/unplug)
      const sorted = [...ports].sort();
      const prev = [...this.lastKnownPorts].sort();
      if (sorted.join(',') !== prev.join(',')) {
        this.lastKnownPorts = ports;
        if (this.universalDetection) {
          logger.info(`[HardwareModule] Port list changed (${prev.join(',')} -> ${sorted.join(',')}), triggering background rescan`);
          void this.universalDetection.rescanKnown().catch(err =>
            logger.warn('[HardwareModule] Background rescan after port change failed:', err)
          );
        }
      }
      return ports;
    });

    ipcMain.handle(IPC_CHANNELS.LIST_WINDOWS_PRINTERS, async () => {
      // Return {name, port}[] so the UI can show port info and help identify ghost printers.
      //
      // Source of truth: getPosnetDriverStatus() runs the v4 ghost-printer filter
      // (PNPDeviceID + Section-2 class allowlist + ghost-name memory). Anything
      // it returns has been verified physically present. We use that as the
      // authoritative list for the dropdown so the user can never select an
      // unplugged "ZDesigner GK420d", "OneNote", "Fax", or stale HP LaserJet.
      //
      // Fallback chain (only used if the filtered status is unusable):
      //   1. Raw Get-Printer with port-name virtual filter (LPT/PORTPROMPT/nul/FILE/TS).
      //   2. Electron printer API (no port info available).
      try {
        const status = await getPosnetDriverStatus();
        const filteredNames = new Map<string, string>(); // name -> port
        for (const dev of status.devices) {
          const name = dev.windowsPrinterName;
          if (!name) continue;
          if (dev.connectionType === 'VIRTUAL') continue;
          // Prefer the windows port name if available; otherwise comPort
          const port = dev.portName || dev.comPort || '';
          if (!filteredNames.has(name)) filteredNames.set(name, port);
        }
        // getPosnetDriverStatus() succeeded — trust its result even if empty.
        // Empty means 0 printers physically connected; do NOT fall through to
        // unfiltered legacy listing (that resurrects ghost printers).
        const result = Array.from(filteredNames, ([name, port]) => ({ name, port }));
        logger.info(`[HardwareModule] LIST_WINDOWS_PRINTERS — returning ${result.length} physically-present printer(s) (filtered via getPosnetDriverStatus)`);
        return result;
      } catch (err) {
        logger.warn('[HardwareModule] LIST_WINDOWS_PRINTERS — filtered query failed, using legacy listing:', err);
      }

      try {
        const detailed = await listWindowsPrintersDetailed();
        if (detailed.length > 0) {
          // Filter out obvious virtual printers by port name as a last-ditch sanity pass
          const GHOST_PORTS = /^(LPT\d+|PORTPROMPT:|nul|FILE:|TS\d+|SHRFAX:|Microsoft\.|OneNote)/i;
          const VIRTUAL_NAMES = /(OneNote|Fax|Microsoft Print to PDF|Microsoft XPS Document Writer|Send To OneNote)/i;
          const real = detailed.filter((p) => !GHOST_PORTS.test(p.portName) && !VIRTUAL_NAMES.test(p.name));
          const ghosts = detailed.length - real.length;
          if (ghosts > 0) logger.info(`[HardwareModule] LIST_WINDOWS_PRINTERS — fallback dropped ${ghosts} virtual printer(s)`);
          logger.info(`[HardwareModule] LIST_WINDOWS_PRINTERS — fallback returning ${real.length} printer(s) (unfiltered for hardware presence)`);
          return real.map((p) => ({ name: p.name, port: p.portName }));
        }
      } catch (err) {
        logger.warn('[HardwareModule] Detailed printer list failed:', err);
      }

      // Fallback: Electron API (no port info available)
      try {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          const printers = await win.webContents.getPrintersAsync();
          if (printers.length > 0) {
            logger.info(`[HardwareModule] Found ${printers.length} printers via Electron API (no port info)`);
            return printers.map((p) => ({ name: p.name, port: '' }));
          }
        }
      } catch (err) {
        logger.warn('[HardwareModule] Electron printer API failed:', err);
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

    ipcMain.handle(IPC_CHANNELS.TEST_PRINTER_BY_CONFIG, async (_, config: PrinterConfig, printerType?: string) => {
      return this.testPrinterByConfig(config, printerType);
    });

    ipcMain.handle(IPC_CHANNELS.CALIBRATE_PRINTER, async (_, config: PrinterConfig) => {
      return this.calibratePrinterByConfig(config);
    });

    ipcMain.handle(IPC_CHANNELS.GET_POSNET_DRIVER_STATUS, async () => {
      return getPosnetDriverStatus();
    });

    ipcMain.handle(IPC_CHANNELS.INSTALL_POSNET_DRIVER, async () => {
      return installPosnetDriver();
    });

    ipcMain.handle(IPC_CHANNELS.SCAN_FOR_DRIVER, async () => {
      return triggerWindowsDriverScan();
    });

    ipcMain.handle(IPC_CHANNELS.AUTO_SETUP_PRINTER, async (_, printerType: string, device?: DetectedDevice) => {
      return this.autoSetupPrinter(printerType || 'RECEIPT', device);
    });

    // Posnet device detection
    ipcMain.handle(IPC_CHANNELS.POSNET_SCAN_DEVICES, async () => {
      if (!this.detectionService) return { success: false, devices: [], warnings: ['Detection service not initialized'] };
      try {
        const result = await this.detectionService.detectAll();
        logger.info(`[HardwareModule] Posnet scan: ${result.devices.length} device(s) found`);
        return result;
      } catch (err: any) {
        logger.error('[HardwareModule] Posnet scan failed:', err);
        return { success: false, devices: [], warnings: [err.message] };
      }
    });

    ipcMain.handle(IPC_CHANNELS.POSNET_LIST_DEVICES, async () => {
      if (!this.deviceRegistry) return { devices: [], selectedSerial: null };
      return this.deviceRegistry.toJSON();
    });

    ipcMain.handle(IPC_CHANNELS.POSNET_SELECT_DEVICE, async (_, serial: string) => {
      if (!this.deviceRegistry || !this.fiscalAdapter) {
        return { success: false, error: 'Detection service not initialized' };
      }
      const device = this.deviceRegistry.selectDevice(serial);
      if (!device) return { success: false, error: `Device ${serial} not found` };
      this.deviceRegistry.save();
      const connected = await this.fiscalAdapter.initialize();
      return { success: connected, device, error: connected ? undefined : 'Failed to connect to selected device' };
    });

    ipcMain.handle(IPC_CHANNELS.POSNET_RESCAN_KNOWN, async () => {
      if (!this.detectionService) return { success: false, devices: [], warnings: ['Detection service not initialized'] };
      try {
        return await this.detectionService.rescanKnownDevices();
      } catch (err: any) {
        logger.error('[HardwareModule] Posnet rescan failed:', err);
        return { success: false, devices: [], warnings: [err.message] };
      }
    });

    // Universal printer detection (all brands)
    ipcMain.handle(IPC_CHANNELS.UNIVERSAL_SCAN_DEVICES, async () => {
      if (!this.universalDetection) return { success: false, devices: [], configured: [], warnings: ['Universal detection not initialized'] };
      try {
        const result = await this.universalDetection.detectAll();
        logger.info(`[HardwareModule] Universal scan: ${result.devices.length} device(s) found`);
        return result;
      } catch (err: any) {
        logger.error('[HardwareModule] Universal scan failed:', err);
        return { success: false, devices: [], configured: [], warnings: [err.message] };
      }
    });

    ipcMain.handle(IPC_CHANNELS.UNIVERSAL_LIST_DEVICES, async () => {
      if (!this.universalRegistry) return { version: 2, lastScan: '', devices: {} };
      return this.universalRegistry.toJSON();
    });

    ipcMain.handle(IPC_CHANNELS.UNIVERSAL_RESCAN_KNOWN, async () => {
      if (!this.universalDetection) return { success: false, devices: [], configured: [], warnings: ['Universal detection not initialized'] };
      try {
        return await this.universalDetection.rescanKnown();
      } catch (err: any) {
        logger.error('[HardwareModule] Universal rescan failed:', err);
        return { success: false, devices: [], configured: [], warnings: [err.message] };
      }
    });

    ipcMain.handle(IPC_CHANNELS.UNIVERSAL_RECOVER_DEVICE, async (_, deviceId: string) => {
      if (!this.universalDetection) return { recovered: false, oldIdentifier: deviceId, message: 'Universal detection not initialized' };
      try {
        return await this.universalDetection.recoverDevice(deviceId);
      } catch (err: any) {
        logger.error('[HardwareModule] Universal recover failed:', err);
        return { recovered: false, oldIdentifier: deviceId, message: err.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.CHECKIN_PRINT_CONFIRMATION, async (_, data: CheckinConfirmationData) => {
      const driver = this.printers[PrinterType.LABEL] || this.labelPrinter;
      if (!driver) return { success: false, error: 'No label printer configured' };
      if (!(driver instanceof ZebraDriver)) return { success: false, error: 'Check-in print requires Zebra printer' };
      try {
        const config = getConfig();
        const labelConfig = (config as any).printers?.LABEL || {};
        const widthMm = labelConfig.labelWidth || config.labelWidth || 50;
        const heightMm = labelConfig.labelHeight || config.labelHeight || 30;
        const printerName = (driver as ZebraDriver).getPrinterName();
        const salonName = config.salonName || config.name || '';

        // Calculate how many services fit per label
        const maxPerLabel = getMaxServicesPerLabel(heightMm);

        if (data.services.length <= maxPerLabel) {
          // Single label — all services fit
          const htmlPath = await printLabelToDevice({
            printerName, labelWidthMm: widthMm, labelHeightMm: heightMm,
            data, salonName,
          });
          return { success: true, htmlPath };
        }

        // Multi-label: split services into chunks
        const chunks: typeof data.services[] = [];
        for (let i = 0; i < data.services.length; i += maxPerLabel) {
          chunks.push(data.services.slice(i, i + maxPerLabel));
        }
        logger.info(`[HardwareModule] Check-in has ${data.services.length} services → ${chunks.length} labels (max ${maxPerLabel}/label at ${heightMm}mm height)`);

        // Grand total across ALL services (not per-page)
        const grandTotal = data.services.reduce((s, v) => s + (v.price || 0), 0);

        // Print in REVERSE order: summary/total page first, CHECK-IN header last.
        // On a label printer the last printed label ends up on top of the stack,
        // so the customer sees the CHECK-IN header first when picking up the labels.
        const htmlPaths: string[] = [];
        for (let i = chunks.length - 1; i >= 0; i--) {
          const chunkData = { ...data, services: chunks[i] };
          const htmlPath = await printLabelToDevice({
            printerName, labelWidthMm: widthMm, labelHeightMm: heightMm,
            data: chunkData, salonName, grandTotal,
            pageInfo: { page: i + 1, total: chunks.length },
          });
          htmlPaths.push(htmlPath);
          // Small delay between labels to avoid printer spooler congestion
          if (i > 0) await new Promise(r => setTimeout(r, 400));
        }

        return { success: true, htmlPath: htmlPaths[0], totalLabels: chunks.length };
      } catch (e: any) {
        logger.error('[HardwareModule] Check-in confirmation print failed:', e);
        // Fallback to ZPL if HTML print fails (ZPL handles multi-label internally)
        try {
          logger.info('[HardwareModule] Falling back to ZPL print...');
          await (driver as ZebraDriver).printCheckinConfirmation(data);
          return { success: true, fallback: 'zpl' };
        } catch (fallbackErr: any) {
          return { success: false, error: e.message };
        }
      }
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

  /**
   * Test a printer directly from its config object — no need to save first.
   * Creates a temporary driver, connects, prints test page, then disconnects.
   */
  async testPrinterByConfig(config: PrinterConfig, printerType?: string): Promise<{ success: boolean; error?: string }> {
    // Backend protocol lock — reject invalid (printerType, protocol) combos
    // before even creating the driver. The UI dropdown should also enforce this,
    // but the backend is the source of truth.
    if (printerType) {
      const allowed = ALLOWED_PROTOCOLS_BY_TYPE[printerType.toUpperCase() as PrinterType];
      if (allowed && !allowed.includes(config.protocol)) {
        return {
          success: false,
          error: `${printerType} slot cannot use ${config.protocol} protocol. Allowed: ${allowed.join(', ')}`,
        };
      }
    }
    // Pass the printerType as the slot name so createPrinterFromConfig also validates.
    const driver = this.createPrinterFromConfig(config, printerType || 'test');
    if (!driver) return { success: false, error: 'Invalid printer configuration (missing port or printer name)' };
    try {
      const connected = await driver.connect();
      if (!connected) return { success: false, error: 'Printer not found. Check the printer name or connection.' };
      await driver.printTest();
      driver.disconnect();
      return { success: true };
    } catch (e: any) {
      try { driver.disconnect(); } catch (err: any) { logger.debug('[HardwareModule] disconnect driver after test failed:', err?.message); }
      return { success: false, error: e.message };
    }
  }

  async calibratePrinterByConfig(config: PrinterConfig): Promise<{ success: boolean; error?: string; paperSize?: { widthMm: number; heightMm: number } }> {
    if (config.protocol !== 'ZEBRA') {
      return { success: false, error: 'Calibration is only supported for Zebra printers' };
    }
    const driver = this.createPrinterFromConfig({ ...config, enabled: true }, 'calibrate');
    if (!driver || !(driver instanceof ZebraDriver)) {
      return { success: false, error: 'Invalid Zebra printer configuration (missing printer name)' };
    }
    try {
      const connected = await driver.connect();
      if (!connected) return { success: false, error: 'Printer not found. Check the printer name or connection.' };
      await driver.calibrate();
      const paperSize = config.windowsPrinter
        ? await ZebraDriver.detectPaperSize(config.windowsPrinter)
        : null;
      driver.disconnect();
      return { success: true, paperSize: paperSize || undefined };
    } catch (e: any) {
      try { driver.disconnect(); } catch (err: any) { logger.debug('[HardwareModule] disconnect driver after calibrate failed:', err?.message); }
      return { success: false, error: e.message };
    }
  }

  async autoSetupPrinter(printerType: string = 'RECEIPT', device?: DetectedDevice): Promise<{ success: boolean; port?: string; windowsPrinter?: string; message: string; action?: string }> {
    // If device info provided, use smart routing based on brand
    if (device) {
      const classification = classifyPrinterCategory(device);
      const effectiveType = printerType || classification.targetType;
      const protocol = classification.protocol;

      logger.info(`[HardwareModule] autoSetupPrinter: ${device.brand} ${device.model} → ${effectiveType} (${protocol})`);

      // Route by protocol
      if (protocol === 'POSNET') {
        return this.autoSetupPosnet(effectiveType);
      }
      return this.autoSetupWindowsPrinter(effectiveType, protocol as PrinterProtocol, device);
    }

    // Legacy: no device info → POSNET-only flow
    return this.autoSetupPosnet(printerType);
  }

  /** POSNET auto-setup: install CDC driver → detect COM port → configure */
  private async autoSetupPosnet(printerType: string): Promise<{ success: boolean; port?: string; message: string; action?: string }> {
    // Step 1: Check/install driver
    const driverStatus = await getPosnetDriverStatus();
    if (!driverStatus.posnetDriverInstalled) {
      logger.info('[HardwareModule] autoSetupPosnet: driver not installed, installing...');
      const installResult = await installPosnetDriver();
      if (!installResult.success) {
        return { success: false, message: `Driver install failed: ${installResult.message}`, action: 'driver_failed' };
      }
      // Wait for driver to register with Windows
      await new Promise(r => setTimeout(r, 2000));
    }

    // Step 2: Detect port by scanning all COM ports
    logger.info('[HardwareModule] autoSetupPosnet: scanning COM ports for POSNET...');
    const port = await PosnetDriver.detectPosnetPort();
    if (!port) {
      return { success: false, message: 'POSNET printer not found on any COM port. Check USB connection and power.', action: 'not_found' };
    }

    // Step 3: Update config
    const config = getConfig();
    const currentPrinters = { ...(config.printers || {}) };
    currentPrinters[printerType as PrinterType] = {
      ...(currentPrinters[printerType as PrinterType] || {}),
      enabled: true,
      protocol: 'POSNET' as PrinterProtocol,
      port,
      baudRate: 9600,
    };
    setConfig({ printers: currentPrinters });

    // Step 4: Reinitialize
    await this.reinitializePrinter();

    logger.info(`[HardwareModule] autoSetupPosnet: configured ${printerType} on ${port}`);
    return { success: true, port, message: `POSNET printer configured on ${port}`, action: 'configured' };
  }

  /** Universal auto-setup for Windows-spooler printers (Zebra, Thermal, HP, etc.) */
  private async autoSetupWindowsPrinter(
    printerType: string,
    protocol: PrinterProtocol,
    device: DetectedDevice,
  ): Promise<{ success: boolean; windowsPrinter?: string; port?: string; message: string; action?: string }> {
    // Step 1: If driver not installed, trigger Windows driver scan
    if (!device.driverInstalled) {
      logger.info(`[HardwareModule] autoSetupWindowsPrinter: driver missing for ${device.brand}, triggering scan...`);
      const scanResult = await triggerWindowsDriverScan();
      if (!scanResult.success) {
        return { success: false, message: `Driver scan failed: ${scanResult.message}`, action: 'driver_failed' };
      }
      // Re-detect to check if driver is now installed
      const freshStatus = await getPosnetDriverStatus();
      const freshDevice = freshStatus.devices.find(d =>
        d.model === device.model || d.windowsPrinterName === device.windowsPrinterName,
      );
      if (!freshDevice?.driverInstalled) {
        return {
          success: false,
          message: `Windows could not find a driver for ${device.brand} ${device.model}. Please install the driver manually from the manufacturer's website.`,
          action: 'driver_not_found',
        };
      }
      // Use fresh device info
      device = freshDevice;
    }

    // Step 2: Determine connection details
    const printerName = device.windowsPrinterName;
    const comPort = device.comPort;

    if (!printerName && !comPort) {
      return { success: false, message: `No Windows printer name or COM port found for ${device.brand} ${device.model}.`, action: 'not_found' };
    }

    // Step 3: Build config based on protocol
    const config = getConfig();
    const currentPrinters = { ...(config.printers || {}) };
    const printerConfig: any = {
      ...(currentPrinters[printerType as PrinterType] || {}),
      enabled: true,
      protocol,
    };

    if (protocol === 'ZEBRA' || protocol === 'WINDOWS') {
      // Zebra and WINDOWS protocol use windowsPrinter (Windows spooler name)
      printerConfig.windowsPrinter = printerName;
    } else if (protocol === 'THERMAL') {
      // Thermal can use either Windows printer name (USB) or COM port (serial)
      if (comPort) {
        printerConfig.port = comPort;
        printerConfig.baudRate = 9600;
      } else {
        printerConfig.windowsPrinter = printerName;
      }
    }

    // Set default label dimensions for label printers
    if (printerType === 'LABEL') {
      printerConfig.labelWidth = printerConfig.labelWidth || 100;
      printerConfig.labelHeight = printerConfig.labelHeight || 50;
    }

    currentPrinters[printerType as PrinterType] = printerConfig;
    setConfig({ printers: currentPrinters });

    // Step 4: Reinitialize
    await this.reinitializePrinter();

    const identifier = printerName || comPort;
    logger.info(`[HardwareModule] autoSetupWindowsPrinter: configured ${printerType} (${protocol}) → ${identifier}`);
    return {
      success: true,
      windowsPrinter: printerName || undefined,
      port: comPort || undefined,
      message: `${device.brand} ${device.model} configured as ${printerType} printer`,
      action: 'configured',
    };
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

  /**
   * After a successful connect(), check if the driver auto-migrated to a new
   * port/printer name (e.g. PosnetDriver detects POSNET on a different COM port
   * than what was in config). If so, persist the new identifier back to
   * electron-store so the renderer UI reflects reality.
   *
   * Returns true if config was updated.
   */
  private persistDriverPortMigration(
    pt: PrinterType,
    driver: PrinterDriver,
    originalConfig: PrinterConfig,
  ): boolean {
    let actualIdentifier: string | null = null;
    let isPort = false;

    if (driver instanceof PosnetDriver) {
      actualIdentifier = driver.getPort();
      isPort = true;
    } else if (driver instanceof ThermalDriver) {
      actualIdentifier = driver.getPrinterNameOrPort();
      isPort = !!actualIdentifier.match(/^COM\d+$/i);
    } else if (driver instanceof ZebraDriver) {
      actualIdentifier = driver.getPrinterName();
      isPort = false;
    }

    if (!actualIdentifier) return false;

    const configuredIdentifier = isPort
      ? (originalConfig.port || '')
      : (originalConfig.windowsPrinter || '');

    if (actualIdentifier.toLowerCase() === configuredIdentifier.toLowerCase()) {
      return false; // no migration
    }

    logger.warn(
      `[HardwareModule] ${pt} driver auto-migrated: ` +
      `config="${configuredIdentifier}" → actual="${actualIdentifier}". Persisting...`
    );

    const config = getConfig();
    const currentPrinters = { ...(config.printers || {}) };
    if (currentPrinters[pt]) {
      const pc = { ...currentPrinters[pt]! };
      if (isPort) {
        pc.port = actualIdentifier;
      } else {
        pc.windowsPrinter = actualIdentifier;
      }
      currentPrinters[pt] = pc;
      setConfig({ printers: currentPrinters });
      logger.info(`[HardwareModule] ${pt} config updated: ${isPort ? 'port' : 'windowsPrinter'}="${actualIdentifier}"`);
      return true;
    }
    return false;
  }

  async reinitializePrinter(): Promise<void> {
    const config = getConfig();
    const initErrors: string[] = [];

    // Disconnect all
    for (const [pt, p] of Object.entries(this.printers)) { try { p?.disconnect(); } catch (err: any) { logger.debug(`[HardwareModule] disconnect printer ${pt} on reinit failed:`, err?.message); } }
    this.printers = {};
    for (const p of [this.receiptPrinter, this.labelPrinter, this.printerDriver]) { try { p?.disconnect(); } catch (err: any) { logger.debug('[HardwareModule] disconnect legacy printer on reinit failed:', err?.message); } }

    const hasPrintersDict = config.printers && Object.keys(config.printers).length > 0;

    if (hasPrintersDict && config.printers) {
      for (const [ptStr, pc] of Object.entries(config.printers)) {
        if (!pc?.enabled) continue;
        const pt = ptStr as PrinterType;
        const driver = this.createPrinterFromConfig(pc, pt);
        if (driver) {
          // Always register the driver so the health check can monitor it
          // and recover when the printer comes back online. Previously,
          // drivers that failed connect() were silently dropped — the health
          // check never knew about them, so a config save while the printer
          // was briefly unavailable permanently lost the driver until restart.
          this.printers[pt] = driver;
          try {
            const ok = await driver.connect();
            if (ok) {
              // P4.2: If connect() auto-migrated to a different identifier
              // (e.g. POSNET found on a different COM port), persist the change
              // so the UI reflects the new port instead of the stale one.
              try {
                this.persistDriverPortMigration(pt, driver, pc);
              } catch (persistErr: any) {
                logger.warn(`[HardwareModule] Persist port migration failed for ${pt}:`, persistErr?.message);
              }
            } else {
              initErrors.push(`${pt}: failed to connect`);
              logger.warn(`[HardwareModule] ${pt}: connect failed — driver registered for health-check recovery`);
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

  /** Check if a driver should be skipped this tick due to backoff. */
  private shouldSkipHealthCheck(key: string): boolean {
    const fails = this.healthCheckFailCount.get(key) || 0;
    if (fails === 0) return false;
    const backoffIdx = Math.min(fails - 1, HEALTH_CHECK_BACKOFF.length - 1);
    const multiplier = HEALTH_CHECK_BACKOFF[backoffIdx];
    // Skip unless tick is aligned to the multiplier
    return (this.healthCheckTick % multiplier) !== 0;
  }

  /**
   * Centralized recovery for any offline printer driver.
   * Delegates to driver-specific recovery, then updates config + calls reconnect().
   * Returns true if recovery succeeded.
   */
  private async attemptDriverRecovery(
    pt: PrinterType,
    driver: PrinterDriver,
    cachedPrinters?: string[],
    cachedPorts?: string[],
  ): Promise<boolean> {
    let newIdentifier: string | null = null;
    let isPort = false;

    if (driver instanceof PosnetDriver) {
      logger.info(`[HardwareModule] Attempting port recovery for POSNET (${pt})...`);
      newIdentifier = await driver.recoverPort();
      isPort = true;
    } else if (driver instanceof ThermalDriver) {
      logger.info(`[HardwareModule] Attempting recovery for Thermal printer (${pt})...`);
      const result = await driver.recoverPrinter(cachedPrinters, cachedPorts);
      if (result.recovered && result.newIdentifier) {
        newIdentifier = result.newIdentifier;
        isPort = !!newIdentifier.match(/^COM\d+$/i);
      }
    } else if (driver instanceof ZebraDriver) {
      logger.info(`[HardwareModule] Attempting recovery for Zebra printer (${pt})...`);
      const result = await driver.recoverPrinter(cachedPrinters);
      if (result.recovered && result.newIdentifier) {
        newIdentifier = result.newIdentifier;
      }
    }

    if (!newIdentifier) return false;

    // Single state mutation point — driver.reconnect() sets internal state
    await driver.reconnect(newIdentifier);

    // Update config to persist the new identifier
    const config = getConfig();
    const currentPrinters = { ...(config.printers || {}) };
    if (currentPrinters[pt]) {
      const pc = { ...currentPrinters[pt]! };
      if (isPort) {
        pc.port = newIdentifier;
      } else {
        pc.windowsPrinter = newIdentifier;
      }
      currentPrinters[pt] = pc;
      setConfig({ printers: currentPrinters });
    }

    logger.info(`[HardwareModule] ${pt} recovered → ${newIdentifier}`);
    return true;
  }

  private async runHealthCheck(): Promise<void> {
    this.healthCheckTick++;
    let changed = false;

    // Fetch printer and port lists once for the entire health check cycle
    // This avoids each driver spawning its own PowerShell process
    const [cachedPrinters, cachedPorts] = await Promise.all([
      listWindowsPrinters(),
      listSerialPorts(),
    ]);

    // Check all drivers in the printers map
    for (const [pt, driver] of Object.entries(this.printers)) {
      if (!driver) continue;

      // Backoff: skip if this driver has been failing repeatedly
      if (this.shouldSkipHealthCheck(pt)) continue;

      const wasBefore = driver.isConnected();
      if (driver instanceof PosnetDriver) {
        await driver.healthCheck(cachedPorts);
      } else if (driver instanceof ThermalDriver) {
        await driver.healthCheck(cachedPrinters, cachedPorts);
      } else if (driver instanceof ZebraDriver) {
        await driver.healthCheck(cachedPrinters);
      } else if ('healthCheck' in driver && typeof (driver as any).healthCheck === 'function') {
        await (driver as any).healthCheck();
      }
      const isNow = driver.isConnected();
      if (isNow !== wasBefore) {
        changed = true;
        logger.info(`[HardwareModule] Health check: ${pt} ${isNow ? 'reconnected' : 'disconnected'}`);
      }

      // If online now, reset backoff
      if (isNow) {
        if (this.healthCheckFailCount.has(pt)) {
          this.healthCheckFailCount.delete(pt);
        }
        continue;
      }

      // Offline — attempt recovery then update backoff
      const recovered = await this.attemptDriverRecovery(pt as PrinterType, driver, cachedPrinters, cachedPorts);
      if (recovered) changed = true;

      // Update backoff counter
      if (recovered) {
        this.healthCheckFailCount.delete(pt);
      } else {
        const prev = this.healthCheckFailCount.get(pt) || 0;
        this.healthCheckFailCount.set(pt, prev + 1);
      }
    }

    // Check legacy drivers
    for (const [label, driver] of [
      ['Receipt', this.receiptPrinter],
      ['Label', this.labelPrinter],
      ['Default', this.printerDriver],
    ] as const) {
      if (!driver) continue;
      if (this.shouldSkipHealthCheck(`legacy:${label}`)) continue;

      const wasBefore = driver.isConnected();
      if (driver instanceof PosnetDriver) {
        await driver.healthCheck(cachedPorts);
      } else if (driver instanceof ThermalDriver) {
        await driver.healthCheck(cachedPrinters, cachedPorts);
      } else if (driver instanceof ZebraDriver) {
        await driver.healthCheck(cachedPrinters);
      } else if ('healthCheck' in driver && typeof (driver as any).healthCheck === 'function') {
        await (driver as any).healthCheck();
      }
      const isNow = driver.isConnected();
      if (isNow !== wasBefore) {
        changed = true;
        logger.info(`[HardwareModule] Health check: ${label} ${isNow ? 'reconnected' : 'disconnected'}`);
      }
      // Update backoff for legacy drivers too
      const legacyKey = `legacy:${label}`;
      if (isNow) {
        this.healthCheckFailCount.delete(legacyKey);
      } else {
        // Attempt recovery for offline legacy drivers
        // Legacy drivers don't have a PrinterType key, so we update config by legacy field name
        let legacyRecovered = false;
        if (driver instanceof PosnetDriver) {
          const newPort = await driver.recoverPort();
          if (newPort) {
            await driver.reconnect(newPort);
            const config = getConfig();
            const legacyField = label === 'Receipt' ? 'receiptPrinter' : label === 'Label' ? 'labelPrinter' : null;
            if (legacyField && (config as any)[legacyField]) {
              setConfig({ [legacyField]: { ...(config as any)[legacyField], port: newPort } });
            }
            legacyRecovered = true;
            changed = true;
          }
        } else if (driver instanceof ThermalDriver) {
          const result = await driver.recoverPrinter(cachedPrinters, cachedPorts);
          if (result.recovered && result.newIdentifier) {
            await driver.reconnect(result.newIdentifier);
            const config = getConfig();
            const legacyField = label === 'Receipt' ? 'receiptPrinter' : label === 'Label' ? 'labelPrinter' : null;
            if (legacyField && (config as any)[legacyField]) {
              const pc = { ...(config as any)[legacyField] };
              if (result.newIdentifier.match(/^COM\d+$/i)) { pc.port = result.newIdentifier; }
              else { pc.windowsPrinter = result.newIdentifier; }
              setConfig({ [legacyField]: pc });
            }
            legacyRecovered = true;
            changed = true;
          }
        } else if (driver instanceof ZebraDriver) {
          const result = await driver.recoverPrinter(cachedPrinters);
          if (result.recovered && result.newIdentifier) {
            await driver.reconnect(result.newIdentifier);
            const config = getConfig();
            const legacyField = label === 'Label' ? 'labelPrinter' : null;
            if (legacyField && (config as any)[legacyField]) {
              setConfig({ [legacyField]: { ...(config as any)[legacyField], windowsPrinter: result.newIdentifier } });
            }
            legacyRecovered = true;
            changed = true;
          }
        }

        if (legacyRecovered) {
          this.healthCheckFailCount.delete(legacyKey);
          logger.info(`[HardwareModule] Legacy ${label} recovered`);
        } else {
          this.healthCheckFailCount.set(legacyKey, (this.healthCheckFailCount.get(legacyKey) || 0) + 1);
        }
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
    try { mainWindow?.webContents.send(IPC_CHANNELS.DEVICE_STATUS, status); } catch (err: any) { logger.debug('[HardwareModule] send device status to main window failed:', err?.message); }

    // Notify backend via Socket.IO
    const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
    if (socket?.isConnected()) {
      socket.sendDeviceStatus(status);
    }

    // Emit on event bus
    this.bus?.emit('hardware:status-changed', status);
  }

  // ─── Private helpers ──────────────────────────────────────────

  /**
   * Allowed (printerType → protocol) combinations.
   *
   * Source of truth lives in shared/types.ts ALLOWED_PROTOCOLS_BY_TYPE so the
   * renderer dropdown and the backend validation cannot drift apart. The
   * backend lock is the LAST line of defence: if the UI is wrong or the user
   * has a stale config on disk, the backend still refuses to build a driver
   * with an illegal (type, protocol) combo.
   */

  private createPrinterFromConfig(config: PrinterConfig | undefined, name: string): PrinterDriver | null {
    if (!config || !config.enabled) return null;

    // ─── Backend protocol lock ──────────────────────────────────────────
    // Reject invalid (printerType, protocol) combinations.
    const printerTypeKey = (name || '').toUpperCase() as PrinterType;
    const allowed = ALLOWED_PROTOCOLS_BY_TYPE[printerTypeKey];
    if (allowed && !allowed.includes(config.protocol)) {
      logger.error(
        `[HardwareModule] REJECTED: ${printerTypeKey} slot cannot use ${config.protocol} protocol. ` +
        `Allowed: ${allowed.join(', ')}`
      );
      return null;
    }

    if (config.protocol === 'ZEBRA') {
      // Zebra label printers: send raw ZPL via Windows spooler API
      if (config.windowsPrinter) return new ZebraDriver(config.windowsPrinter, config.labelWidth || 100, config.labelHeight || 50);
      return null;
    }
    if (config.protocol === 'WINDOWS') {
      // Regular Windows printers (A4, inkjet, laser): use ThermalDriver in
      // windowsTextMode so printTest sends plain text via Out-Printer instead
      // of ESC/POS bytes (which would print as garbage on a laser printer).
      if (config.windowsPrinter) return new ThermalDriver(
        config.windowsPrinter,
        config.baudRate || 9600,
        'USB',
        config.paperWidth || 80,
        config.charsPerLine || 48,
        true,  // windowsTextMode — A4/laser path
      );
      return null;
    }
    if (config.protocol === 'POSNET') {
      if (config.port) return new PosnetDriver(config.port, config.baudRate || 9600);
      logger.warn(`[HardwareModule] POSNET printer "${name}" requires a serial port`);
      return null;
    }
    // THERMAL protocol: ESC/POS thermal receipt printers (USB or serial)
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

  async start(): Promise<void> {
    this.setState(ModuleState.RUNNING);
    // Cleanup old label files from previous days
    cleanupOldLabels().catch(e => logger.warn('[HardwareModule] Label cleanup failed:', e));
  }

  async stop(): Promise<void> {
    this.stopHealthCheck();
    this.scanner?.stop();
    for (const d of Object.values(this.printers)) { try { d?.disconnect(); } catch (err: any) { logger.debug('[HardwareModule] disconnect printer on stop failed:', err?.message); } }
    for (const d of [this.receiptPrinter, this.labelPrinter, this.printerDriver]) { try { d?.disconnect(); } catch (err: any) { logger.debug('[HardwareModule] disconnect legacy printer on stop failed:', err?.message); } }
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> {
    this.stopHealthCheck();
    this.scanner?.stop();
    for (const d of Object.values(this.printers)) { try { d?.disconnect(); } catch (err: any) { logger.debug('[HardwareModule] disconnect printer on destroy failed:', err?.message); } }
    for (const d of [this.receiptPrinter, this.labelPrinter, this.printerDriver]) { try { d?.disconnect(); } catch (err: any) { logger.debug('[HardwareModule] disconnect legacy printer on destroy failed:', err?.message); } }
    this.setState(ModuleState.STOPPED);
  }
}
