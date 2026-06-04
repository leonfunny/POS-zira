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
import { ElzabDriver } from '../hardware/elzab/elzab-driver';
import { DeviceDetectionService } from '../hardware/posnet/device-detection-service';
import { PosnetProbeEngine } from '../hardware/posnet/posnet-probe-engine';
import { DeviceProfileRegistry } from '../hardware/posnet/device-profile-registry';
import { FiscalPrinterAdapter } from '../hardware/posnet/fiscal-printer-adapter';
import { ZebraDriver } from '../hardware/zebra/zebra-driver';
import { UniversalDetectionService, UniversalDeviceRegistry } from '../hardware/detection';
import { printLabelToDevice, printInfoLabelToDevice, cleanupOldLabels } from '../hardware/pdf/pdf-printer';
import { ThermalDriver } from '../hardware/thermal/thermal-driver';
import { HidScanner } from '../hardware/scanner/hid-scanner';
import { chooseScannerTargetWindow } from '../hardware/scanner/scanner-target';
import { readScaleWeight } from '../hardware/scale/scale-reader-service';
import { getScaleNetworkInfo, ScaleNetworkService } from '../hardware/scale/scale-network-service';
import { listSerialPorts, listWindowsPrintersDetailed, getVidForPort } from '../hardware/port-utils';
import { validateProtocolAgainstVid, type ValidationResult as PortValidationResult } from '../hardware/detection/vid-protocol-registry';
import {
  IPC_CHANNELS,
  PrinterType,
  PrintJobType,
  PrinterConfig,
  PrinterProtocol,
  LabelData,
  LabelPrintOptions,
  ReceiptData,
  DocumentData,
  DailyReportData,
  DeviceStatus,
  CheckinConfirmationData,
  InfoLabelData,
  ALLOWED_PROTOCOLS_BY_TYPE,
  TestPrintStep,
  TestPrintStepName,
  TestPrintResult,
} from '../../shared/types';
import { getConfig, getConfigValue } from '../config/store';
import { localPrinterRepo, rowToPrinterConfig } from '../database/repos/local-printer-repo';
import { fiscalAttemptRepo } from '../database/repos/fiscal-attempt-repo';
import { getPosnetDriverStatus, installPosnetDriver, triggerWindowsDriverScan, classifyPrinterCategory, DetectedDevice } from '../hardware/driver-installer';
import { setConfig } from '../config/store';
import SocketClient from '../network/socket-client';
import { WindowManager } from '../windows/window-manager';
import { notifyPosRenderers } from '../windows/notify-pos-renderers';
import { app } from 'electron';
import logger from '../logger';
import { buildKitchenTicketLines, type KitchenTicketData } from '../printing/kitchen-ticket';

type PrinterDriver = PosnetDriver | ElzabDriver | ZebraDriver | ThermalDriver;
type LocalPrinterRow = ReturnType<typeof localPrinterRepo.getEnabled>[number];
type PrinterDriversMap = { [key in PrinterType]?: PrinterDriver };
type PrinterDriversById = { [serverPrinterId: string]: PrinterDriver | undefined };

function isDriverInstance<T>(driver: unknown, constructorFn: unknown): driver is T {
  return typeof constructorFn === 'function' && driver instanceof (constructorFn as new (...args: any[]) => T);
}

function isElzabDriver(driver: unknown): driver is ElzabDriver {
  return isDriverInstance<ElzabDriver>(driver, ElzabDriver);
}

function shouldRenderInfoLabelViaWindows(config?: PrinterConfig | null): boolean {
  const printerName = config?.windowsPrinter || config?.address || '';
  return /xprinter|xp-?423|xp-?42/i.test(printerName);
}

/** How often to run printer health checks (ms).
 *  Each tick can spawn a PowerShell PnP/spooler query in getPosnetDriverStatus(),
 *  which briefly blocks the main process. Keep this high enough that UI clicks
 *  don't visibly lag every cycle. */
const HEALTH_CHECK_INTERVAL = 90_000;
const PRINTER_CONNECT_TIMEOUT_MS = 12_000;

/** Health check backoff multipliers: after N consecutive failures, skip N×interval checks.
 *  Index = min(failCount, length-1). E.g. [1,2,4,10] → 90s, 180s, 360s, 900s */
const HEALTH_CHECK_BACKOFF = [1, 2, 4, 10];

/** Max retries for a failed print job */
const PRINT_JOB_MAX_RETRIES = 2;

/** Delay between retries (ms) */
const PRINT_JOB_RETRY_DELAY = 2_000;

const RECEIPT_LIKE_PRINTER_TYPES = new Set<string>([
  PrinterType.RECEIPT,
  PrinterType.KITCHEN,
  PrinterType.TICKET,
]);

export class HardwareModule extends BaseModule {
  readonly name = 'hardware';

  // Multi-printer dictionary
  private printers: PrinterDriversMap = {};
  private printersById: PrinterDriversById = {};
  // Legacy printers (backward compatibility)
  private receiptPrinter: PrinterDriver | null = null;
  private labelPrinter: PrinterDriver | null = null;
  private printerDriver: PrinterDriver | null = null;
  // Barcode scanner
  private scanner: HidScanner | null = null;
  private scaleNetworkService: ScaleNetworkService | null = null;
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
  // Cached detection snapshot — reused when every active driver is stuck on
  // manual-protocol-action and the serial port list hasn't changed, to avoid
  // hammering PnP/spooler queries every 30s for a device we can't recover
  // without the user physically changing the printer menu.
  private lastDetectionSnapshot: Awaited<ReturnType<typeof getPosnetDriverStatus>> | null = null;
  private lastDetectionPortSignature: string = '';
  // Event bus reference for emitting status changes
  private bus: EventBus | null = null;
  private handleAgentConnected = () => {
    this.notifyStatusChange();
  };

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[HardwareModule] Initializing printers...');
    const unknownFiscalAttempts = fiscalAttemptRepo.markOpenSentAsUnknownOnStartup();
    if (unknownFiscalAttempts > 0) {
      logger.warn(`[HardwareModule] Marked ${unknownFiscalAttempts} SENT fiscal attempt(s) as UNKNOWN_NEEDS_RECONCILIATION after startup`);
    }
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
        // Route scanner input to one active sales surface. Broadcasting to
        // every open checkout can add the same item to POS and kiosk carts.
        const mainWindow = this.container.getOptional<Electron.BrowserWindow>(SERVICE_TOKENS.MAIN_WINDOW);
        const wm = this.container.getOptional<WindowManager>(SERVICE_TOKENS.WINDOW_MANAGER);
        const posWindow = wm?.getWindow('pos');
        const selfCheckoutWindow = wm?.getWindow('selfCheckout');
        const candidates = [
          { label: 'self-checkout', window: selfCheckoutWindow },
          { label: 'POS', window: posWindow },
          { label: 'main', window: mainWindow },
        ].filter((entry): entry is { label: string; window: Electron.BrowserWindow } =>
          !!entry.window && !entry.window.isDestroyed(),
        );
        const focusedWindow = BrowserWindow.getFocusedWindow();
        const target = chooseScannerTargetWindow(candidates, focusedWindow?.id);
        try {
          target?.window.webContents.send(IPC_CHANNELS.BARCODE_SCANNED, barcode);
        } catch (err: any) {
          logger.debug(`[HardwareModule] send barcode to ${target?.label || 'sales'} window failed:`, err?.message);
        }
      });
    } catch (err) {
      logger.error('[HardwareModule] Scanner initialization failed (non-fatal):', err);
      this.scanner = null;
    }

    this.scaleNetworkService = new ScaleNetworkService(
      () => getConfig(),
      () => readScaleWeight(getConfig(), { forceLocal: true }),
    );
    await this.scaleNetworkService.applyConfig().catch((err: any) => {
      logger.warn('[HardwareModule] Remote scale share did not start:', err?.message || err);
    });

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

    const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
    socket?.on('agent:connected', this.handleAgentConnected);

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

    ipcMain.handle(IPC_CHANNELS.SCALE_READ_WEIGHT, async (_event, options?: { port?: string; forceLocal?: boolean }) => {
      return readScaleWeight(getConfig(), options);
    });

    ipcMain.handle(IPC_CHANNELS.SCALE_GET_NETWORK_INFO, () => {
      return this.scaleNetworkService?.getStatus() || {
        ...getScaleNetworkInfo(),
        running: false,
        port: null,
      };
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
        logger.info(
          `[HardwareModule] LIST_WINDOWS_PRINTERS returning ${status.windowsPrinters.length} printer(s) from detection snapshot`
        );
        return status.windowsPrinters;
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

    ipcMain.handle(IPC_CHANNELS.PRINT_LABEL, async (_event, barcode: string, text?: string, options?: LabelPrintOptions) => {
      return this.printLabel(barcode, text, options);
    });

    ipcMain.handle(IPC_CHANNELS.TEST_PRINTER_BY_TYPE, async (_, printerType: string) => {
      return this.testPrinterByType(printerType as PrinterType);
    });

    ipcMain.handle(IPC_CHANNELS.TEST_PRINTER_BY_CONFIG, async (_, config: PrinterConfig, printerType?: string) => {
      return this.testPrinterByConfig(config, printerType);
    });

    ipcMain.handle(IPC_CHANNELS.VALIDATE_PRINTER_PORT, async (_, port: string, protocol: PrinterProtocol): Promise<PortValidationResult> => {
      if (!port) return { ok: true, code: 'NO_DEVICE_ON_PORT' };
      const vid = await getVidForPort(port);
      return validateProtocolAgainstVid(vid, protocol);
    });

    ipcMain.handle(IPC_CHANNELS.OPEN_LOG_FOLDER, async () => {
      try {
        const { shell } = require('electron');
        const logPath = require('path').join(app.getPath('userData'), 'logs');
        await shell.openPath(logPath);
        return { success: true, path: logPath };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
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

    ipcMain.handle(IPC_CHANNELS.POSNET_DIAGNOSE_PORT, async (_, port: string, baudRate?: number) => {
      try {
        const result = await PosnetDriver.diagnosePort(port, baudRate || 9600);
        logger.info(`[HardwareModule] Diagnose ${port}@${baudRate || 9600} → ${result.diagnostic.code} (posnetResponse=${result.posnetResponse})`);
        return result;
      } catch (err: any) {
        logger.error('[HardwareModule] Diagnose failed:', err);
        return {
          port,
          portPresent: false,
          portOpenable: false,
          vidMatch: false,
          posnetResponse: false,
          baudRate: baudRate || 9600,
          diagnostic: { code: 'PORT_NOT_FOUND', detail: err?.message || String(err) },
          guidance: ['Unexpected error during diagnostic — check the app logs'],
          requiresManualSetup: false,
        };
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
      return this.printCheckinConfirmation(data);
    });

    logger.info('[HardwareModule] IPC handlers registered');
  }

  async printCheckinConfirmation(data: CheckinConfirmationData): Promise<{ success: boolean; error?: string; htmlPath?: string; totalLabels?: number; fallback?: string }> {
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

      // Always 1 service per label: each service prints on its own physical slip so that
      // multi-service check-ins produce N labels (with QR on the last one).
      const maxPerLabel = 1;

      if (data.services.length <= maxPerLabel) {
        const htmlPath = await printLabelToDevice({
          printerName, labelWidthMm: widthMm, labelHeightMm: heightMm,
          data, salonName,
        });
        return { success: true, htmlPath };
      }

      const chunks: typeof data.services[] = [];
      for (let i = 0; i < data.services.length; i += maxPerLabel) {
        chunks.push(data.services.slice(i, i + maxPerLabel));
      }
      logger.info(`[HardwareModule] Check-in has ${data.services.length} services → ${chunks.length} labels (max ${maxPerLabel}/label at ${heightMm}mm height)`);

      const grandTotal = data.services.reduce((s, v) => s + (v.price || 0), 0);

      const htmlPaths: string[] = [];
      for (let i = chunks.length - 1; i >= 0; i--) {
        const chunkData = { ...data, services: chunks[i] };
        const htmlPath = await printLabelToDevice({
          printerName, labelWidthMm: widthMm, labelHeightMm: heightMm,
          data: chunkData, salonName, grandTotal,
          pageInfo: { page: i + 1, total: chunks.length },
        });
        htmlPaths.push(htmlPath);
        if (i > 0) await new Promise(r => setTimeout(r, 400));
      }

      return { success: true, htmlPath: htmlPaths[0], totalLabels: chunks.length };
    } catch (e: any) {
      logger.error('[HardwareModule] Check-in confirmation print failed:', e);
      try {
        logger.info('[HardwareModule] Falling back to ZPL print...');
        await (driver as ZebraDriver).printCheckinConfirmation(data);
        return { success: true, fallback: 'zpl' };
      } catch (fallbackErr: any) {
        return { success: false, error: e.message };
      }
    }
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
        const printerKeys = ['printers', 'multiPrinterMode', 'printerPort', 'printerProtocol', 'printerBaudRate', 'zebraPrinter', 'receiptPrinter', 'labelPrinter'];
        if (payload.changedKeys.some(k => printerKeys.includes(k))) {
          logger.info('[HardwareModule] Printer config changed, reinitializing...');
          await this.reinitializePrinter();
        }
        if (payload.changedKeys.includes('scale')) {
          await this.scaleNetworkService?.applyConfig();
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
                text: { type: 'string', description: 'Product name or text for the label' },
                priceText: { type: 'string', description: 'Formatted retail price, e.g. 12.99 zl' },
                sku: { type: 'string', description: 'Optional SKU to print in small text' },
              },
              required: ['barcode'],
            },
          },
        },
        module: this.name,
        category: 'hardware',
        execute: async (args) => {
          const result = await this.printLabel(args.barcode as string, args.text as string | undefined, {
            priceText: args.priceText as string | undefined,
            sku: args.sku as string | undefined,
          });
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

  private isMultiPrinterModeEnabled(config = getConfig()): boolean {
    return !!config.multiPrinterMode;
  }

  getPrinterForType(printerType: PrinterType): PrinterDriver | null {
    if (this.printers[printerType]) return this.printers[printerType]!;

    // FISCAL fallback: only if RECEIPT slot holds a PosnetDriver (pre-migration compat)
    if (printerType === PrinterType.FISCAL && this.printers[PrinterType.RECEIPT]) {
      const receiptDriver = this.printers[PrinterType.RECEIPT];
      if (receiptDriver instanceof PosnetDriver) return receiptDriver;
    }

    // RECEIPT fallback: preserve old POSNET-only installs, but do not send
    // generic receipts to ELZAB. ELZAB is a fiscal protocol path, not a
    // replacement for a thermal receipt printer.
    if (printerType === PrinterType.RECEIPT && this.printers[PrinterType.FISCAL]) {
      const fiscalDriver = this.printers[PrinterType.FISCAL]!;
      if (fiscalDriver instanceof PosnetDriver) return fiscalDriver;
    }

    if (printerType === PrinterType.LABEL && this.labelPrinter) return this.labelPrinter;
    if ((printerType === PrinterType.RECEIPT || printerType === PrinterType.TICKET || printerType === PrinterType.KITCHEN) && this.receiptPrinter) {
      return this.receiptPrinter;
    }
    if (isElzabDriver(this.printerDriver)) {
      return printerType === PrinterType.FISCAL ? this.printerDriver : null;
    }
    return this.printerDriver;
  }

  private getPrinterConfigForJob(job: any): { printerType: PrinterType; config?: PrinterConfig } {
    const config = getConfig();
    const printers = config.printers || {};

    if (job.printerId) {
      const localPrinter = localPrinterRepo.getById(job.printerId);
      if (localPrinter) {
        return {
          printerType: (localPrinter.printer_type || PrinterType.RECEIPT) as PrinterType,
          config: rowToPrinterConfig(localPrinter),
        };
      }

      for (const [pt, pc] of Object.entries(printers)) {
        if (pc?.serverPrinterId === job.printerId) {
          return { printerType: pt as PrinterType, config: pc };
        }
      }
    }

    const printerType = this.getPrinterTypeForJob(job);
    return { printerType, config: printers[printerType] };
  }

  private getPrinterForJob(job: any): PrinterDriver | null {
    if (job.printerId && this.printersById[job.printerId]) {
      return this.printersById[job.printerId]!;
    }
    const target = this.getPrinterConfigForJob(job);
    return this.getPrinterForType(target.printerType);
  }

  getDeviceStatus(): DeviceStatus {
    const config = getConfig();
    const multiPrinterMode = this.isMultiPrinterModeEnabled(config);
    const hasLegacyMultiPrinter = config.receiptPrinter?.enabled || config.labelPrinter?.enabled;

    let printerConnected = false;
    let printerPort: string | null = null;
    const printerStatuses: DeviceStatus['printerStatuses'] = [];

    if (multiPrinterMode) {
      const connectedPrinters: string[] = [];
      const seenPrinterIds = new Set<string>();
      for (const row of localPrinterRepo.getAll()) {
        const driver = this.printersById[row.id];
        const isOnline = row.is_enabled === 1 && !!driver?.isConnected();
        seenPrinterIds.add(row.id);
        printerStatuses.push({ printerId: row.id, isOnline });
        if (row.is_enabled !== 1) continue;
        if (isOnline) {
          printerConnected = true;
          connectedPrinters.push(`${row.printer_type || 'PRINTER'}:${row.display_name || row.id}`);
        }
      }
      for (const [pt, pc] of Object.entries(config.printers || {})) {
        if (!pc?.enabled) continue;
        if (pc.serverPrinterId && seenPrinterIds.has(pc.serverPrinterId)) continue;
        const driver = this.printers[pt as PrinterType];
        const isOnline = !!driver?.isConnected();
        if (pc.serverPrinterId) {
          printerStatuses.push({ printerId: pc.serverPrinterId, isOnline });
        }
        if (isOnline) {
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
      ...(printerStatuses.length > 0 && { printerStatuses }),
    };
  }

  getPrintersStatus(): Array<{ type: string; connected: boolean; protocol?: string; address?: string }> {
    const config = getConfig();
    const result: Array<{ type: string; connected: boolean; protocol?: string; address?: string }> = [];
    const multiPrinterMode = this.isMultiPrinterModeEnabled(config);

    if (multiPrinterMode) {
      const seenPrinterIds = new Set<string>();
      for (const row of localPrinterRepo.getEnabled()) {
        seenPrinterIds.add(row.id);
        result.push({
          type: `${row.printer_type || 'PRINTER'}:${row.display_name || row.id}`,
          connected: this.printersById[row.id]?.isConnected() || false,
          protocol: row.protocol,
          address: row.windows_printer_name || row.port || row.address || undefined,
        });
      }
      for (const [pt, pc] of Object.entries(config.printers || {})) {
        if (!pc?.enabled) continue;
        if (pc.serverPrinterId && seenPrinterIds.has(pc.serverPrinterId)) continue;
        result.push({
          type: pt,
          connected: this.printers[pt as PrinterType]?.isConnected() || false,
          protocol: pc.protocol,
          address: pc.windowsPrinter || pc.port || pc.address,
        });
      }
    }

    if (!multiPrinterMode && result.length === 0) {
      if (config.receiptPrinter?.enabled) {
        result.push({ type: 'RECEIPT', connected: this.receiptPrinter?.isConnected() || false, protocol: config.receiptPrinter.protocol, address: config.receiptPrinter.windowsPrinter || config.receiptPrinter.port || config.receiptPrinter.address });
      }
      if (config.labelPrinter?.enabled) {
        result.push({ type: 'LABEL', connected: this.labelPrinter?.isConnected() || false, protocol: config.labelPrinter.protocol, address: config.labelPrinter.windowsPrinter || config.labelPrinter.port || config.labelPrinter.address });
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
   * Emit a per-step progress update to the renderer so the UI can show live
   * diagnostics instead of a single opaque success/failure toast.
   */
  private emitTestPrintProgress(step: TestPrintStep): void {
    try {
      const mainWindow = this.container.getOptional<Electron.BrowserWindow>(SERVICE_TOKENS.MAIN_WINDOW);
      mainWindow?.webContents.send(IPC_CHANNELS.TEST_PRINT_PROGRESS, step);
    } catch (err: any) {
      logger.debug('[HardwareModule] send test-print progress failed:', err?.message);
    }
  }

  /**
   * Run one diagnostic step, time it, record the outcome, and stream the
   * result to the renderer. Returns true on success so the caller can short-
   * circuit when a step fails.
   */
  private async runStep(
    steps: TestPrintStep[],
    step: TestPrintStepName,
    fn: () => Promise<{ detail?: string; data?: unknown }>,
  ): Promise<boolean> {
    const start = Date.now();
    try {
      const out = await fn();
      const entry: TestPrintStep = { step, ok: true, detail: out.detail, data: out.data, durationMs: Date.now() - start };
      steps.push(entry);
      this.emitTestPrintProgress(entry);
      return true;
    } catch (e: any) {
      const entry: TestPrintStep = { step, ok: false, error: e?.message || String(e), durationMs: Date.now() - start };
      steps.push(entry);
      this.emitTestPrintProgress(entry);
      return false;
    }
  }

  /**
   * Test a printer directly from its config object — no need to save first.
   *
   * Runs a 6-step diagnostic flow (config → connect → identify → build → send
   * → verify), streaming per-step progress to the renderer. Returns the full
   * step list so the UI can show exactly where things went wrong.
   */
  async testPrinterByConfig(config: PrinterConfig, printerType?: string): Promise<TestPrintResult> {
    const steps: TestPrintStep[] = [];
    const result: TestPrintResult = { success: false, steps };

    // STEP 1 — config validation
    const configOk = await this.runStep(steps, 'config', async () => {
      if (printerType) {
        const allowed = ALLOWED_PROTOCOLS_BY_TYPE[printerType.toUpperCase() as PrinterType];
        if (allowed && !allowed.includes(config.protocol)) {
          throw new Error(`${printerType} slot cannot use ${config.protocol} protocol. Allowed: ${allowed.join(', ')}`);
        }
      }
      if (!config.port && !config.windowsPrinter && !config.address) {
        throw new Error('Missing port (COM), address, or windowsPrinter name in config');
      }
      // VID-aware protocol mismatch check: if the COM port hosts a known
      // printer brand, refuse before opening the serial port. Saves the
      // user from a 15s baud fan-out + cryptic "no response" error.
      if (config.port) {
        const vid = await getVidForPort(config.port);
        const validation = validateProtocolAgainstVid(vid, config.protocol);
        if (!validation.ok) {
          throw new Error(
            `PROTOCOL_DEVICE_MISMATCH: ${validation.detail} ` +
            `Suggested fix: change protocol to ${validation.suggestedProtocol}.`,
          );
        }
      }
      return { detail: `protocol=${config.protocol} target=${config.port || config.address || config.windowsPrinter}` };
    });
    if (!configOk) return result;

    // Build driver (no side effects yet)
    const driver = this.createPrinterFromConfig({ ...config, enabled: true }, printerType || 'test');
    if (!driver) {
      const entry: TestPrintStep = { step: 'config', ok: false, error: 'createPrinterFromConfig returned null (invalid combination)' };
      steps.push(entry);
      this.emitTestPrintProgress(entry);
      return result;
    }

    try {
      // STEP 2 — connect
      const connectOk = await this.runStep(steps, 'connect', async () => {
        const connected = await driver.connect();
        if (!connected) {
          if (driver instanceof PosnetDriver) {
            const diag = driver.getLastDiagnostic();
            const state = driver.getConnectionState();
            if (diag?.code === 'PORT_BUSY') throw new Error(`PORT_BUSY: ${diag.detail}`);
            if (diag?.code === 'ACCESS_DENIED') throw new Error(`ACCESS_DENIED: ${diag.detail}`);
            if (diag?.code === 'WRONG_BAUD_OR_MODE') throw new Error(`WRONG_BAUD_OR_MODE: ${diag.detail}`);
            if (state === 'physical_present') throw new Error(`DEVICE_DETECTED_NO_PROTOCOL_RESPONSE: ${diag?.detail || `Device detected on ${driver.getPort()} but no POSNET protocol response`}`);
            throw new Error(`PORT_NOT_FOUND: ${diag?.detail || 'Printer not found'}`);
          }
          if (isElzabDriver(driver)) {
            const diag = driver.getLastDiagnostic();
            if (diag) throw new Error(`${diag.code}: ${diag.detail || 'ELZAB_STX is not ready'}`);
            throw new Error('ELZAB_STX_NOT_READY: official sidecar or fiscal printer is not available');
          }
          throw new Error('Printer not found. Check the cable, power, and whether the printer is selected/installed.');
        }
        if (driver instanceof PosnetDriver) {
          const pid = driver.getDetectedPid();
          const pidInfo = pid ? ` (PID 0x${pid.toString(16).toUpperCase()})` : '';
          return { detail: `Connected on ${driver.getPort()}${pidInfo}` };
        }
        if (isElzabDriver(driver)) {
          return { detail: `Connected via ${driver.getPort() || driver.getAddress()}` };
        }
        return { detail: 'Connected' };
      });
      if (!connectOk) return result;

      // STEP 3 — identify model (best-effort; non-fatal)
      await this.runStep(steps, 'identify', async () => {
        if (driver instanceof PosnetDriver) {
          const info = await driver.identifyModel();
          result.modelName = info.modelName;
          result.firmwareVersion = info.firmwareVersion;
          const pid = driver.getDetectedPid();
          const pidStr = pid ? ` [VID_1424 PID_${pid.toString(16).toUpperCase().padStart(4, '0')}]` : '';
          return { detail: info.modelName ? `${info.modelName} (${info.source})${pidStr}` : `unknown (no response)${pidStr}`, data: info };
        }
        if (driver instanceof ThermalDriver) {
          const info = driver.identifyModel();
          result.modelName = info.modelName;
          return { detail: info.modelName ? `${info.modelName} (${info.source})` : 'unknown', data: info };
        }
        return { detail: 'Skipped (non-thermal/posnet driver)' };
      });

      // STEP 4 — build is implicit inside printTest; we record which charset/cut are in use
      await this.runStep(steps, 'build', async () => {
        if (driver instanceof ThermalDriver) {
          result.charsetUsed = driver.getCharset();
          result.cutModeUsed = driver.getCutMode();
          return { detail: `charset=${result.charsetUsed} cut=${result.cutModeUsed}` };
        }
        return { detail: 'POSNET frame (non-fiscal trinit/trline/trend)' };
      });

      // STEP 5 + 6 — send and verify are combined inside printTest() because
      // the driver throws on verify failure. We report them as two entries so
      // the UI lines up with the documented 6-step flow.
      // Pass salon/seller info so the test page renders the same header
      // a real receipt would — a misconfigured NIP shows up here before
      // the first sale instead of on a customer's paragon.
      const sendOk = await this.runStep(steps, 'send', async () => {
        if (typeof (driver as any).printTest === 'function' && driver instanceof ThermalDriver) {
          await (driver as ThermalDriver).printTest({
            salonName: (getConfigValue('salonName') as string | undefined),
            sellerName: (getConfigValue('receiptSellerName') as string | undefined),
            sellerNip: (getConfigValue('receiptSellerNip') as string | undefined),
          });
        } else {
          await driver.printTest();
        }
        return { detail: 'Bytes written to printer' };
      });
      if (!sendOk) return result;

      await this.runStep(steps, 'verify', async () => {
        // printTest() already throws on stuck jobs / protocol errors; if we got
        // here, verify passed. Kept as a distinct step for UI parity.
        return { detail: 'No stuck jobs, no protocol errors' };
      });

      result.success = steps.every(s => s.ok);
      try {
        result.logFilePath = require('path').join(app.getPath('userData'), 'logs', 'combined.log');
      } catch { /* logger path not critical */ }
      return result;
    } finally {
      try { driver.disconnect(); } catch (err: any) { logger.debug('[HardwareModule] disconnect driver after test failed:', err?.message); }
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
      if (device.autoSetupEligible === false) {
        const isPosnet = (device.brand || '').toUpperCase() === 'POSNET' || (device.vid || '').toUpperCase() === '1424';
        const posnetHint = isPosnet
          ? ' This POSNET model may be set to POSNET or THEMAL on the printer itself; verify the printer-side PC protocol is POSNET before selecting the COM port.'
          : '';
        return {
          success: false,
          message: `${device.brand} ${device.model} requires manual configuration. Select the COM port and slot in Settings instead of auto-setup.${posnetHint}`,
          action: 'manual_required',
        };
      }

      const classification = classifyPrinterCategory(device);
      const effectiveType = printerType || classification.targetType;
      const protocol = classification.protocol;

      logger.info(`[HardwareModule] autoSetupPrinter: ${device.brand} ${device.model} → ${effectiveType} (${protocol})`);

      // Route by protocol
      if (protocol === 'POSNET') {
        return this.autoSetupPosnet(effectiveType);
      }
      if (protocol === 'ELZAB_STX') {
        return this.autoSetupElzab(device);
      }
      return this.autoSetupWindowsPrinter(effectiveType, protocol as PrinterProtocol, device);
    }

    // Legacy: no device info → POSNET-only flow
    return this.autoSetupPosnet(printerType);
  }

  /** POSNET auto-setup: install CDC driver → detect COM port → configure */
  private async autoSetupPosnet(_printerType: string): Promise<{ success: boolean; port?: string; message: string; action?: string }> {
    const printerType = 'FISCAL';
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
    setConfig({ multiPrinterMode: true, printers: currentPrinters });

    // Step 4: Reinitialize
    await this.reinitializePrinter();

    logger.info(`[HardwareModule] autoSetupPosnet: configured ${printerType} on ${port}`);
    return { success: true, port, message: `POSNET printer configured on ${port}`, action: 'configured' };
  }

  private async autoSetupElzab(device: DetectedDevice): Promise<{ success: boolean; port?: string; message: string; action?: string }> {
    const printerType: PrinterType = PrinterType.FISCAL;
    const port = device.comPort;
    if (!port) {
      return {
        success: false,
        message: `ELZAB ${device.model || 'printer'} has no COM port detected. Install the ELZAB USB CDC driver so Windows assigns a COMx, then run detection again.`,
        action: 'not_found',
      };
    }

    const config = getConfig();
    const currentPrinters = { ...(config.printers || {}) };
    currentPrinters[printerType] = {
      ...(currentPrinters[printerType] || {}),
      enabled: true,
      protocol: 'ELZAB_STX' as PrinterProtocol,
      port,
      baudRate: 9600,
      address: '',
      windowsPrinter: '',
    };
    setConfig({ multiPrinterMode: true, printers: currentPrinters });

    await this.reinitializePrinter();

    logger.info(`[HardwareModule] autoSetupElzab: configured FISCAL with ELZAB_STX on ${port}`);
    return {
      success: true,
      port,
      message: `ELZAB ${device.model || 'printer'} configured on ${port} (FISCAL/ELZAB_STX). Fiscal output still requires the official elzabdr/STX sidecar — set ZIRA_ELZAB_BRIDGE_PATH before live use.`,
      action: 'configured',
    };
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

    if (RECEIPT_LIKE_PRINTER_TYPES.has(printerType) && (protocol === 'THERMAL' || protocol === 'WINDOWS')) {
      printerConfig.paperWidth = printerConfig.paperWidth ?? 80;
      printerConfig.charsPerLine = printerConfig.charsPerLine ?? 48;
    }

    // Set default label dimensions for label printers
    if (printerType === 'LABEL') {
      printerConfig.labelWidth = printerConfig.labelWidth || 50;
      printerConfig.labelHeight = printerConfig.labelHeight || 30;
    }

    currentPrinters[printerType as PrinterType] = printerConfig;
    setConfig({ multiPrinterMode: true, printers: currentPrinters });

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

  async printLabel(barcode: string, text?: string, options?: LabelPrintOptions): Promise<{ success: boolean; error?: string }> {
    const normalizedBarcode = String(barcode || '').trim();
    if (!normalizedBarcode) return { success: false, error: 'Barcode is required' };
    const driver = this.printers[PrinterType.LABEL] || this.labelPrinter;
    if (!driver) return { success: false, error: 'No label printer configured' };
    if (!driver.isConnected()) {
      logger.warn('[HardwareModule] Label printer disconnected at print time; attempting reconnect');
      const reconnected = await this.connectPrinterWithTimeout(driver, 'Label');
      if (!reconnected || !driver.isConnected()) return { success: false, error: 'Label printer not connected' };
    }
    if (!(driver instanceof ZebraDriver)) return { success: false, error: 'Label printing requires Zebra printer' };
    try {
      const priceText = options?.priceText?.trim() || options?.text2?.trim();
      const skuText = options?.sku?.trim();
      const detailText = options?.text3?.trim() || (skuText ? `SKU ${skuText}` : undefined);
      const requestedQuantity = Number(options?.quantity ?? options?.copies ?? 1);
      const quantity = Number.isFinite(requestedQuantity)
        ? Math.max(1, Math.min(999, Math.round(requestedQuantity)))
        : 1;
      await driver.printLabel({
        barcode: normalizedBarcode,
        barcodeType: /^\d{13}$/.test(normalizedBarcode) ? 'EAN13' : 'CODE128',
        text1: text?.trim() || normalizedBarcode,
        text2: priceText,
        text3: detailText,
        quantity,
      });
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
    let actualBaudRate: number | undefined;

    if (driver instanceof PosnetDriver) {
      actualIdentifier = driver.getPort();
      isPort = true;
      actualBaudRate = driver.getBaudRate();
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
    const configuredBaudRate = originalConfig.baudRate || 9600;
    const identifierChanged = actualIdentifier.toLowerCase() !== configuredIdentifier.toLowerCase();
    const baudChanged = typeof actualBaudRate === 'number' && actualBaudRate !== configuredBaudRate;

    if (!identifierChanged && !baudChanged) {
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
      if (identifierChanged) {
        if (isPort) {
          pc.port = actualIdentifier;
        } else {
          pc.windowsPrinter = actualIdentifier;
        }
      }
      if (baudChanged) {
        pc.baudRate = actualBaudRate;
      }
      currentPrinters[pt] = pc;
      setConfig({ multiPrinterMode: true, printers: currentPrinters });
      logger.info(`[HardwareModule] ${pt} config updated: ${isPort ? 'port' : 'windowsPrinter'}="${actualIdentifier}", baudRate=${pc.baudRate || configuredBaudRate}`);
      return true;
    }
    return false;
  }

  private sortPrinterRowsForConnect(rows: LocalPrinterRow[]): LocalPrinterRow[] {
    const priority = (row: LocalPrinterRow) => {
      const type = (row.printer_type || PrinterType.RECEIPT) as PrinterType;
      if (type === PrinterType.RECEIPT) return 0;
      if (type === PrinterType.FISCAL) return 1;
      if (type === PrinterType.LABEL) return 2;
      return 3;
    };
    return [...rows].sort((a, b) => priority(a) - priority(b));
  }

  private async connectPrinterWithTimeout(driver: PrinterDriver, label: string): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => {
          logger.warn(`[HardwareModule] ${label}: connect timed out after ${PRINTER_CONNECT_TIMEOUT_MS}ms; continuing with other printers`);
          resolve(false);
        }, PRINTER_CONNECT_TIMEOUT_MS);
      });
      return await Promise.race([driver.connect(), timedOut]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async reinitializePrinter(): Promise<void> {
    // One-time migration: split merged RECEIPT config into FISCAL + RECEIPT
    const preConfig = getConfig();
    const receiptCfg = preConfig.printers?.RECEIPT;
    if (receiptCfg?.protocol === 'POSNET' && !preConfig.printers?.FISCAL) {
      const updatedPrinters = { ...(preConfig.printers || {}) };

      updatedPrinters.FISCAL = {
        enabled: true,
        protocol: 'POSNET' as PrinterProtocol,
        serverPrinterId: receiptCfg.serverPrinterId,
        displayName: receiptCfg.displayName,
        port: receiptCfg.port,
        baudRate: receiptCfg.baudRate || 115200,
        paperWidth: receiptCfg.paperWidth || 80,
        charsPerLine: receiptCfg.charsPerLine || 48,
      };

      if (receiptCfg.windowsPrinter) {
        updatedPrinters.RECEIPT = {
          enabled: true,
          protocol: 'THERMAL' as PrinterProtocol,
          windowsPrinter: receiptCfg.windowsPrinter,
          baudRate: 9600,
          paperWidth: receiptCfg.paperWidth || 80,
          charsPerLine: receiptCfg.charsPerLine || 48,
          supportsCut: receiptCfg.supportsCut ?? true,
          supportsCashDrawer: receiptCfg.supportsCashDrawer ?? true,
          charset: receiptCfg.charset || 'utf8',
          cutMode: receiptCfg.cutMode || 'partial',
        };
      } else {
        delete updatedPrinters.RECEIPT;
      }

      setConfig({ printers: updatedPrinters });
      logger.info('[HardwareModule] Migrated POSNET from RECEIPT → FISCAL, restored RECEIPT for thermal');
    }

    const config = getConfig();
    const initErrors: string[] = [];

    // Disconnect all
    for (const [pt, p] of Object.entries(this.printers)) { try { p?.disconnect(); } catch (err: any) { logger.debug(`[HardwareModule] disconnect printer ${pt} on reinit failed:`, err?.message); } }
    this.printers = {};
    for (const [printerId, p] of Object.entries(this.printersById)) { try { p?.disconnect(); } catch (err: any) { logger.debug(`[HardwareModule] disconnect printer ${printerId} on reinit failed:`, err?.message); } }
    this.printersById = {};
    for (const p of [this.receiptPrinter, this.labelPrinter, this.printerDriver]) { try { p?.disconnect(); } catch (err: any) { logger.debug('[HardwareModule] disconnect legacy printer on reinit failed:', err?.message); } }

    const multiPrinterMode = this.isMultiPrinterModeEnabled(config);

    if (multiPrinterMode) {
      const localRows = this.sortPrinterRowsForConnect(localPrinterRepo.getEnabled());
      const registeredPrinterIds = new Set<string>();

      for (const row of localRows) {
        const pt = (row.printer_type || PrinterType.RECEIPT) as PrinterType;
        const pc = rowToPrinterConfig(row);
        // New backend rows carry per-printer label dimensions. Older local
        // mirrors did not, so fall back to the legacy per-type config only
        // when a mirrored LABEL row has not been refreshed with paper_height.
        const cfgPrinter = (config.printers as any)?.[pt];
        const hasRowLabelDimensions = pt === PrinterType.LABEL
          && typeof pc.labelWidth === 'number'
          && pc.labelWidth > 0
          && typeof pc.labelHeight === 'number'
          && pc.labelHeight > 0;
        if (cfgPrinter && !hasRowLabelDimensions) {
          if (typeof cfgPrinter.labelWidth === 'number' && cfgPrinter.labelWidth > 0) {
            pc.labelWidth = cfgPrinter.labelWidth;
          }
          if (typeof cfgPrinter.labelHeight === 'number' && cfgPrinter.labelHeight > 0) {
            pc.labelHeight = cfgPrinter.labelHeight;
          }
        }
        const driver = this.createPrinterFromConfig(pc, pt);
        if (!driver) continue;

        this.printersById[row.id] = driver;
        if (!this.printers[pt]) this.printers[pt] = driver;
        registeredPrinterIds.add(row.id);

        try {
          const ok = await this.connectPrinterWithTimeout(driver, row.display_name || row.id);
          localPrinterRepo.markOnline(row.id, ok);
          if (!ok) {
            initErrors.push(`${row.display_name || row.id}: failed to connect`);
            logger.warn(`[HardwareModule] ${row.display_name || row.id}: connect failed — driver registered for health-check recovery`);
          }
        } catch (e: any) {
          localPrinterRepo.markOnline(row.id, false);
          logger.error(`[HardwareModule] ${row.display_name || row.id} connect failed:`, e);
          initErrors.push(`${row.display_name || row.id}: ${e.message}`);
        }
      }

      for (const [ptStr, pc] of Object.entries(config.printers || {})) {
        if (!pc?.enabled) continue;
        if (pc.serverPrinterId && registeredPrinterIds.has(pc.serverPrinterId)) continue;
        const pt = ptStr as PrinterType;
        const driver = this.createPrinterFromConfig(pc, pt);
        if (driver) {
          // Always register the driver so the health check can monitor it
          // and recover when the printer comes back online. Previously,
          // drivers that failed connect() were silently dropped — the health
          // check never knew about them, so a config save while the printer
          // was briefly unavailable permanently lost the driver until restart.
          this.printers[pt] = driver;
          if (pc.serverPrinterId) this.printersById[pc.serverPrinterId] = driver;
          try {
            const ok = await this.connectPrinterWithTimeout(driver, pt);
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
          const ok = await this.connectPrinterWithTimeout(this.receiptPrinter, 'Receipt');
          if (!ok) initErrors.push('Receipt: failed to connect');
        } catch (e: any) { initErrors.push(`Receipt: ${e.message}`); }
      }
      this.labelPrinter = this.createPrinterFromConfig(config.labelPrinter, 'Label Printer' as any);
      if (this.labelPrinter) {
        try {
          const ok = await this.connectPrinterWithTimeout(this.labelPrinter, 'Label');
          if (!ok) initErrors.push('Label: failed to connect');
        } catch (e: any) { initErrors.push(`Label: ${e.message}`); }
      }
      this.printerDriver = null;
    } else {
      this.receiptPrinter = null; this.labelPrinter = null;
      this.printerDriver = this.createPrinterDriverLegacy();
      if (this.printerDriver) {
        try {
          const ok = await this.connectPrinterWithTimeout(this.printerDriver, 'Default printer');
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
      if (driver.requiresManualProtocolAction()) {
        logger.info(`[HardwareModule] Skipping active POSNET recovery for ${pt}: physical device is present but selected POSNET protocol did not respond`);
        return false;
      }
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
      setConfig({ multiPrinterMode: true, printers: currentPrinters });
    }

    logger.info(`[HardwareModule] ${pt} recovered → ${newIdentifier}`);
    return true;
  }

  /**
   * True when every active driver is a POSNET driver sitting in
   * `requiresManualProtocolAction()` state — i.e. the printer is physically
   * present but the printer-side PC protocol is not POSNET, and no amount of
   * active probing will change that until the user touches the printer menu.
   */
  private allActiveDriversStuckOnManualProtocol(): boolean {
    const drivers: (PrinterDriver | null)[] = [
      ...Object.values(this.printers),
      this.receiptPrinter,
      this.labelPrinter,
      this.printerDriver,
    ].filter((d): d is PrinterDriver => !!d);

    if (drivers.length === 0) return false;
    return drivers.every(d => d instanceof PosnetDriver && d.requiresManualProtocolAction());
  }

  private async runHealthCheck(): Promise<void> {
    this.healthCheckTick++;
    let changed = false;

    // Fetch a single detection snapshot per cycle so drivers do not each spawn
    // their own presence-check PowerShell queries. When every active driver is
    // a POSNET stuck on the manual-protocol wall AND the port list hasn't
    // changed since last check, reuse the cached snapshot instead of
    // re-running the heavy PnP/spooler query.
    const currentPorts = await listSerialPorts();
    const portSignature = [...currentPorts].sort().join(',');
    const portsUnchanged = portSignature === this.lastDetectionPortSignature;
    const canReuseSnapshot =
      this.lastDetectionSnapshot !== null
      && portsUnchanged
      && this.allActiveDriversStuckOnManualProtocol();

    let statusSnapshot: Awaited<ReturnType<typeof getPosnetDriverStatus>>;
    if (canReuseSnapshot) {
      statusSnapshot = this.lastDetectionSnapshot!;
    } else {
      statusSnapshot = await getPosnetDriverStatus();
      this.lastDetectionSnapshot = statusSnapshot;
      this.lastDetectionPortSignature = portSignature;
    }

    const cachedPrinters = Array.from(new Set(
      statusSnapshot.devices
        .filter((device) => device.windowsPrinterName && device.connectionType !== 'VIRTUAL')
        .map((device) => device.windowsPrinterName as string)
    ));
    const cachedPorts = statusSnapshot.serialPorts;

    const checkedDrivers = new Set<PrinterDriver>();

    // Check all drivers in the printers map
    for (const [pt, driver] of Object.entries(this.printers)) {
      if (!driver) continue;
      checkedDrivers.add(driver);

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

    for (const [printerId, driver] of Object.entries(this.printersById)) {
      if (!driver || checkedDrivers.has(driver)) continue;

      const key = `id:${printerId}`;
      if (this.shouldSkipHealthCheck(key)) continue;

      const row = localPrinterRepo.getById(printerId);
      const printerType = (row?.printer_type || PrinterType.RECEIPT) as PrinterType;
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
      localPrinterRepo.markOnline(printerId, isNow);
      if (isNow !== wasBefore) {
        changed = true;
        logger.info(`[HardwareModule] Health check: ${printerId} ${isNow ? 'reconnected' : 'disconnected'}`);
      }
      if (isNow) {
        this.healthCheckFailCount.delete(key);
        continue;
      }

      const recovered = await this.attemptDriverRecovery(printerType, driver, cachedPrinters, cachedPorts);
      if (recovered) {
        changed = true;
        this.healthCheckFailCount.delete(key);
        localPrinterRepo.markOnline(printerId, true);
      } else {
        const prev = this.healthCheckFailCount.get(key) || 0;
        this.healthCheckFailCount.set(key, prev + 1);
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

    if (config.protocol === 'ELZAB_STX') {
      if (config.port || config.address) {
        return new ElzabDriver({
          port: config.port,
          address: config.address,
          baudRate: config.baudRate || 9600,
          onFiscalUnknown: (info) => {
            try { notifyPosRenderers(this.container, 'pos:fiscal-unknown', info); }
            catch (e: any) { logger.warn(`[HardwareModule] fiscal-unknown notify failed: ${e?.message ?? e}`); }
          },
        });
      }
      logger.warn(`[HardwareModule] ELZAB_STX printer "${name}" requires a COM port or IP address`);
      return null;
    }
    if (config.protocol === 'ZEBRA') {
      // Zebra label printers: send raw ZPL via Windows spooler API
      if (config.windowsPrinter) return new ZebraDriver(config.windowsPrinter, config.labelWidth || 100, config.labelHeight || 50);
      return null;
    }
    if (config.protocol === 'WINDOWS' && printerTypeKey === PrinterType.LABEL) {
      // Label printers generally expose a Windows spooler name, but still need
      // label-language output rather than plain A4 text.
      if (config.windowsPrinter) return new ZebraDriver(config.windowsPrinter, config.labelWidth || 100, config.labelHeight || 50);
      return null;
    }
    const tOpts = { charset: config.charset, cutMode: config.cutMode };
    if (config.protocol === 'WINDOWS') {
      // protocol=WINDOWS covers two very different devices behind the same
      // Windows-spooler API: real ESC/POS thermal receipt printers (Xprinter,
      // Epson TM-Tx, Star, Bixolon, …) AND office printers (A4 laser /
      // inkjet). The two need opposite output paths:
      //   - thermal → raw ESC/POS bytes via WritePrinter (printTest uses
      //     formatTestPage). Going through Out-Printer text instead makes the
      //     spooler render with the driver's default page size (often A4) →
      //     test print comes out misaligned even though receipt printing,
      //     which always uses raw ESC/POS, prints fine.
      //   - office → plain text via Out-Printer (printTest uses
      //     printTestWindowsText). Sending ESC/POS bytes would print as
      //     garbage.
      // Auto-detect by paperWidth: 58/76/80mm = thermal POS receipt; A4 =
      // 210mm, Letter = 216mm. There is no real-world thermal receipt above
      // 80mm and no office paper at or below it, so this discriminates
      // cleanly and survives the user swapping printers without re-toggling
      // a flag they don't see in the UI.
      const paperWidth = config.paperWidth || 80;
      const windowsTextMode = paperWidth > 80;
      if (config.windowsPrinter) return new ThermalDriver(
        config.windowsPrinter,
        config.baudRate || 9600,
        'USB',
        paperWidth,
        config.charsPerLine || 48,
        windowsTextMode,
        tOpts,
      );
      return null;
    }
    if (config.protocol === 'POSNET') {
      if (config.port) return new PosnetDriver(config.port, config.baudRate || 9600);
      logger.warn(`[HardwareModule] POSNET printer "${name}" requires a serial port`);
      return null;
    }
    // THERMAL protocol: ESC/POS thermal receipt printers (USB or serial)
    if (config.windowsPrinter) return new ThermalDriver(config.windowsPrinter, config.baudRate || 9600, 'USB', config.paperWidth || 80, config.charsPerLine || 48, false, tOpts);
    if (config.port) return new ThermalDriver(config.port, config.baudRate || 9600, 'SERIAL', config.paperWidth || 80, config.charsPerLine || 48, false, tOpts);
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
    if (protocol === 'POSNET') {
      if (port) return new PosnetDriver(port, baud, 'POSNET');
      return null;
    }
    if (protocol === 'ELZAB_STX') {
      if (port) return new ElzabDriver({ port, baudRate: baud });
      return null;
    }
    if (zebra) return new ThermalDriver(zebra, baud, 'USB', 80, 48);
    if (port) return new ThermalDriver(port, baud, 'SERIAL', 80, 48);
    return null;
  }

  private getPrinterTypeForJob(job: any): PrinterType {
    if (job.printerId) {
      const localPrinter = localPrinterRepo.getById(job.printerId);
      if (localPrinter?.printer_type) return localPrinter.printer_type as PrinterType;

      const config = getConfig();
      for (const [pt, pc] of Object.entries(config.printers || {})) {
        if (pc?.serverPrinterId === job.printerId) return pt as PrinterType;
      }
    }
    if (job.printerType) return job.printerType;
    if (job.jobType === PrintJobType.LABEL || job.jobType === PrintJobType.BARCODE || job.jobType === PrintJobType.INFO_LABEL) return PrinterType.LABEL;
    if (job.jobType === PrintJobType.KITCHEN_TICKET) return PrinterType.KITCHEN;
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
    // Receipts and invoices printed on a fiscal protocol driver are fiscal
    const driver = this.getPrinterForJob(job);
    if (
      (job.jobType === PrintJobType.RECEIPT || job.jobType === PrintJobType.INVOICE) &&
      (driver instanceof PosnetDriver || isElzabDriver(driver))
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
   * - On final failure: status = 'FAILED' with a fiscal error message so the POS UI can prevent the sale
   *
   * Non-fiscal jobs use the standard retry with a 'FAILED' status on exhaustion.
   */
  private async handlePrintJob(job: any): Promise<void> {
    const { printerType, config: printerConfig } = this.getPrinterConfigForJob(job);
    const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
    const fiscal = this.isFiscalJob(job);

    for (let attempt = 0; attempt <= PRINT_JOB_MAX_RETRIES; attempt++) {
      const targetPrinter = this.getPrinterForJob(job);

      if (!targetPrinter?.isConnected()) {
        if (attempt < PRINT_JOB_MAX_RETRIES) {
          logger.warn(`[HardwareModule] Job ${job.jobId}: printer ${printerType} not connected, retry ${attempt + 1}/${PRINT_JOB_MAX_RETRIES} in ${PRINT_JOB_RETRY_DELAY}ms...`);
          await new Promise(r => setTimeout(r, PRINT_JOB_RETRY_DELAY));
          await this.runHealthCheck();
          continue;
        }
        const failMsg = fiscal
          ? `FISCAL PRINTER ${printerType} NOT CONNECTED — sale must be blocked`
          : `Printer ${printerType} not connected`;
        logger.error(`[HardwareModule] Job ${job.jobId}: ${failMsg}`);
        socket?.sendJobStatus(job.jobId, 'FAILED', failMsg);
        return;
      }

      try {
        socket?.sendJobStatus(job.jobId, 'PRINTING');
        const isLabel = printerType === PrinterType.LABEL;
        const isA4 = printerType === PrinterType.A4;
        const isReport = [PrintJobType.DAILY_REPORT, PrintJobType.X_REPORT, PrintJobType.Z_REPORT].includes(job.jobType);
        const isKitchenTicket = job.jobType === PrintJobType.KITCHEN_TICKET;

        if (isKitchenTicket) {
          // Kitchen ticket: large-font item lines, no prices. Goes through the
          // thermal plain-line path so Vietnamese/Polish dish names raster
          // instead of printing mangled code-page text.
          const ticket = job.payload as KitchenTicketData;
          const lines = buildKitchenTicketLines(ticket);
          if (typeof (targetPrinter as any).printPlainLines === 'function') {
            await (targetPrinter as any).printPlainLines(lines);
          } else {
            throw new Error('Kitchen ticket requires a thermal (ESC/POS) printer');
          }
        } else if (isLabel) {
          if (!(targetPrinter instanceof ZebraDriver)) throw new Error('Label printing requires Zebra printer');
          if (job.jobType === PrintJobType.INFO_LABEL) {
            if (shouldRenderInfoLabelViaWindows(printerConfig)) {
              const printerName = printerConfig?.windowsPrinter || printerConfig?.address;
              if (!printerName) throw new Error('Info label printing requires a Windows printer name');
              await printInfoLabelToDevice({
                printerName,
                labelWidthMm: printerConfig?.labelWidth || printerConfig?.paperWidth || 100,
                labelHeightMm: printerConfig?.labelHeight || 150,
                data: job.payload as InfoLabelData,
              });
            } else {
              await targetPrinter.printInfoLabel(job.payload as InfoLabelData);
            }
          } else {
            await targetPrinter.printLabel(job.payload as LabelData);
          }
        } else if (isA4) {
          const printerName = printerConfig?.windowsPrinter;
          if (!printerName) throw new Error('A4 printing requires a Windows printer name');
          await this.printA4Document(job.payload as DocumentData, printerName);
        } else if (isReport) {
          if (targetPrinter instanceof ThermalDriver) {
            const rd = job.payload as DailyReportData;
            if (job.jobType === PrintJobType.DAILY_REPORT) await targetPrinter.printDailyReport(rd);
            else if (job.jobType === PrintJobType.X_REPORT) await targetPrinter.printXReport(rd);
            else await targetPrinter.printZReport(rd);
          } else if (isElzabDriver(targetPrinter)) {
            const rd = job.payload as DailyReportData;
            if (job.jobType === PrintJobType.DAILY_REPORT) await targetPrinter.printDailyReport(rd);
            else if (job.jobType === PrintJobType.X_REPORT) await targetPrinter.printXReport(rd);
            else await targetPrinter.printZReport(rd);
          } else throw new Error('Reports require Thermal printer');
        } else {
          const receiptPayload = job.payload as ReceiptData;
          const referenceType = String(job.referenceType || '');
          const orderNumber = String(receiptPayload.orderNumber || '');
          const paymentMethod = String(receiptPayload.payment?.method || '').toUpperCase();
          const explicitDrawerRequest = Boolean(job.openDrawer || (job.payload as any)?.openDrawer);
          const looksLikePosOrderCopy = referenceType === 'POS_RECEIPT' || /^POS[-\d]/i.test(orderNumber);
          const inferredPosCashDrawerRequest = (
            !explicitDrawerRequest &&
            looksLikePosOrderCopy &&
            paymentMethod === 'CASH' &&
            !(receiptPayload as any).isReprint &&
            !(receiptPayload as any).isRefund
          );
          const openDrawerRequested = (
            !fiscal &&
            printerType === PrinterType.RECEIPT &&
            (explicitDrawerRequest || inferredPosCashDrawerRequest)
          );
          logger.info(
            `[HardwareModule] Job ${job.jobId}: receipt job metadata referenceType=${referenceType || 'none'} ` +
            `orderNumber=${orderNumber || 'none'} paymentMethod=${paymentMethod || 'none'} ` +
            `openDrawer=${explicitDrawerRequest ? 'true' : 'false'} ` +
            `inferredPosCashDrawer=${inferredPosCashDrawerRequest ? 'true' : 'false'} ` +
            `supportsCashDrawer=${printerConfig?.supportsCashDrawer ? 'true' : 'false'}`,
          );
          if (isElzabDriver(targetPrinter)) {
            await targetPrinter.printReceipt({
              ...receiptPayload,
              orderId: receiptPayload.orderId || job.referenceId || receiptPayload.orderNumber,
            });
          } else {
            await targetPrinter.printReceipt(receiptPayload);
          }
          if (openDrawerRequested) {
            if (printerConfig?.supportsCashDrawer) {
              try {
                await targetPrinter.openDrawer();
                logger.info(`[HardwareModule] Job ${job.jobId}: cash drawer opened after receipt print`);
              } catch (drawerError: any) {
                logger.error(`[HardwareModule] Job ${job.jobId}: receipt printed but cash drawer open failed: ${drawerError?.message || drawerError}`);
              }
            } else {
              logger.warn(`[HardwareModule] Job ${job.jobId}: openDrawer requested but printer does not advertise cash drawer support`);
            }
          }
        }

        socket?.sendJobStatus(job.jobId, 'COMPLETED');
        if (job.printerId) localPrinterRepo.markUsed(job.printerId);
        return; // success — exit retry loop
      } catch (error: any) {
        logger.error(`[HardwareModule] Job ${job.jobId} attempt ${attempt + 1} failed:`, error);

        if (attempt < PRINT_JOB_MAX_RETRIES) {
          logger.info(`[HardwareModule] Retrying in ${PRINT_JOB_RETRY_DELAY}ms...`);
          await new Promise(r => setTimeout(r, PRINT_JOB_RETRY_DELAY));
        } else {
          const failMsg = fiscal
            ? `FISCAL PRINT FAILED — sale must be blocked: ${error.message}`
            : error.message;
          socket?.sendJobStatus(job.jobId, 'FAILED', failMsg);
        }
      }
    }
  }

  private async printA4Document(data: DocumentData | any, printerName: string): Promise<void> {
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    const { pathToFileURL } = require('url') as typeof import('url');

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let tempPath: string | null = null;
    try {
      if (data?.type === 'PDF' && data.data) {
        tempPath = path.join(os.tmpdir(), `zira_a4_${Date.now()}.pdf`);
        fs.writeFileSync(tempPath, Buffer.from(String(data.data), 'base64'));
        await win.loadURL(pathToFileURL(tempPath).toString());
      } else {
        const content = data?.content || data?.title || JSON.stringify(data, null, 2);
        const html = /<\/?[a-z][\s\S]*>/i.test(content)
          ? content
          : `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap;font-size:12pt">${String(content)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')}</pre>`;
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      }

      await new Promise<void>((resolve, reject) => {
        win.webContents.print(
          {
            silent: true,
            deviceName: printerName,
            printBackground: true,
          },
          (success, failureReason) => {
            if (success) resolve();
            else reject(new Error(failureReason || `Failed to print A4 document on ${printerName}`));
          },
        );
      });
    } finally {
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        /* ignore */
      }
      if (tempPath) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* ignore */
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
    const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
    socket?.off('agent:connected', this.handleAgentConnected);
    this.stopHealthCheck();
    await this.scaleNetworkService?.stop();
    this.scanner?.stop();
    for (const d of Object.values(this.printers)) { try { d?.disconnect(); } catch (err: any) { logger.debug('[HardwareModule] disconnect printer on stop failed:', err?.message); } }
    for (const d of [this.receiptPrinter, this.labelPrinter, this.printerDriver]) { try { d?.disconnect(); } catch (err: any) { logger.debug('[HardwareModule] disconnect legacy printer on stop failed:', err?.message); } }
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> {
    const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
    socket?.off('agent:connected', this.handleAgentConnected);
    this.stopHealthCheck();
    await this.scaleNetworkService?.stop();
    this.scanner?.stop();
    for (const d of Object.values(this.printers)) { try { d?.disconnect(); } catch (err: any) { logger.debug('[HardwareModule] disconnect printer on destroy failed:', err?.message); } }
    for (const d of [this.receiptPrinter, this.labelPrinter, this.printerDriver]) { try { d?.disconnect(); } catch (err: any) { logger.debug('[HardwareModule] disconnect legacy printer on destroy failed:', err?.message); } }
    this.setState(ModuleState.STOPPED);
  }
}
