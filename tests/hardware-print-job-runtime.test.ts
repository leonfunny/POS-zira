import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PrintJobType,
  PrinterType,
  type AgentConfig,
  type KitchenTicketData,
  type PrinterConfig,
  type ReceiptData,
} from '../src/shared/types';

const PRINT_JOB_RETRY_DELAY_MS = 2_000;

const mock = vi.hoisted(() => ({
  currentConfig: {} as Partial<AgentConfig>,
  getEnabled: vi.fn(),
  getAll: vi.fn(),
  getById: vi.fn(),
  markOnline: vi.fn(),
  markUsed: vi.fn(),
  updateWindowsPrinterName: vi.fn(),
  lanFirstBeginPrintAttempt: vi.fn(),
  lanFirstMarkCompleted: vi.fn(),
  lanFirstMarkFailed: vi.fn(),
  posnetConnects: false,
  posnetInstances: [] as any[],
  rowToPrinterConfig: vi.fn(),
  thermalConnectImpl: null as null | ((driver: any) => Promise<boolean> | boolean),
  thermalInitiallyConnected: true,
  thermalInstances: [] as any[],
  thermalPrintBusy: false,
  thermalSupportsBundledDrawer: false,
  tscInstances: [] as any[],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: { getVersion: vi.fn(() => 'test'), getPath: vi.fn(() => 'C:\\tmp'), getAppPath: vi.fn(() => 'C:\\app') },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/config/store', () => ({
  getConfig: () => mock.currentConfig,
  getConfigValue: (key: keyof AgentConfig) => mock.currentConfig[key],
  setConfig: vi.fn(),
}));

vi.mock('../src/main/database/repos/local-printer-repo', () => ({
  localPrinterRepo: {
    getEnabled: mock.getEnabled,
    getAll: mock.getAll,
    getById: mock.getById,
    markOnline: mock.markOnline,
    markUsed: mock.markUsed,
    updateWindowsPrinterName: mock.updateWindowsPrinterName,
  },
  rowToPrinterConfig: mock.rowToPrinterConfig,
}));

vi.mock('../src/main/database/repos/lan-first-print-attempt-repo', () => ({
  lanFirstPrintAttemptRepo: {
    beginPrintAttempt: mock.lanFirstBeginPrintAttempt,
    markCompleted: mock.lanFirstMarkCompleted,
    markFailed: mock.lanFirstMarkFailed,
  },
}));

vi.mock('../src/main/hardware/elzab/elzab-driver', () => ({
  ElzabDriver: undefined,
}));

vi.mock('../src/main/hardware/thermal/thermal-driver', () => {
  class ThermalDriver {
    static isAnyPrintBusy = vi.fn(() => mock.thermalPrintBusy);
    connected = mock.thermalInitiallyConnected;
    printReceipt = vi.fn();
    openDrawer = vi.fn();
    constructor() {
      // Older thermal drivers lack the bundled receipt+drawer write; the
      // module must feature-detect it, so the mock only exposes it on demand.
      if (mock.thermalSupportsBundledDrawer) {
        (this as any).printReceiptWithDrawer = vi.fn();
      }
      mock.thermalInstances.push(this);
    }
    connect = vi.fn(async () => {
      if (mock.thermalConnectImpl) {
        const ok = await mock.thermalConnectImpl(this);
        this.connected = ok;
        return ok;
      }
      this.connected = true;
      return true;
    });
    disconnect = vi.fn(() => {
      this.connected = false;
    });
    isConnected = vi.fn(() => this.connected);
    healthCheck = vi.fn(async () => undefined);
    recoverPrinter = vi.fn(async () => ({ recovered: false, newIdentifier: null }));
    reconnect = vi.fn(async () => {
      this.connected = true;
    });
    printDailyReport = vi.fn();
    printXReport = vi.fn();
    printZReport = vi.fn();
    printPlainLines = vi.fn();
  }
  return { ThermalDriver };
});

vi.mock('../src/main/hardware/posnet/posnet-driver', () => {
  class PosnetDriver {
    printReceipt = vi.fn();
    openDrawer = vi.fn();
    connect = vi.fn(async () => mock.posnetConnects);
    disconnect = vi.fn();
    isConnected = vi.fn(() => mock.posnetConnects);
    constructor() {
      mock.posnetInstances.push(this);
    }
  }
  return { PosnetDriver };
});

vi.mock('../src/main/hardware/zebra/zebra-driver', () => {
  class ZebraDriver {
    connect = vi.fn(async () => true);
    disconnect = vi.fn();
    isConnected = vi.fn(() => true);
    printLabel = vi.fn();
    printInfoLabel = vi.fn();
  }
  return { ZebraDriver };
});

vi.mock('../src/main/hardware/tsc/tsc-driver', () => {
  class TscDriver {
    connected = true;
    constructor(
      public printerName: string,
      public labelWidth: number,
      public labelHeight: number,
      public media: Record<string, unknown>,
    ) {
      mock.tscInstances.push(this);
    }
    connect = vi.fn(async () => {
      this.connected = true;
      return true;
    });
    disconnect = vi.fn(() => { this.connected = false; });
    isConnected = vi.fn(() => this.connected);
    healthCheck = vi.fn(async () => this.connected);
    recoverPrinter = vi.fn(async () => ({ recovered: false, newIdentifier: null }));
    reconnect = vi.fn(async (newPrinterName: string) => {
      this.printerName = newPrinterName;
      this.connected = true;
    });
    printFabricTag = vi.fn(async () => undefined);
    printLabel = vi.fn(async () => undefined);
    printInfoLabel = vi.fn(async () => undefined);
    printTest = vi.fn(async () => undefined);
    calibrate = vi.fn(async () => undefined);
  }
  return { TscDriver };
});

vi.mock('../src/main/hardware/pdf/pdf-printer', () => ({
  printLabelToDevice: vi.fn(),
  printInfoLabelToDevice: vi.fn(),
  cleanupOldLabels: vi.fn(),
}));

describe('HardwareModule print job runtime guards', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mock.thermalInstances.length = 0;
    mock.posnetInstances.length = 0;
    mock.posnetConnects = false;
    mock.thermalConnectImpl = null;
    mock.thermalInitiallyConnected = true;
    mock.thermalPrintBusy = false;
    mock.thermalSupportsBundledDrawer = false;
    mock.tscInstances.length = 0;
    mock.currentConfig = { multiPrinterMode: true, printers: {} };
    mock.lanFirstBeginPrintAttempt.mockResolvedValue({ action: 'PRINT', row: { status: 'PRINTING' } });
    mock.lanFirstMarkCompleted.mockResolvedValue(null);
    mock.lanFirstMarkFailed.mockResolvedValue(null);

    const row = {
      id: 'receipt-printer-1',
      printer_type: PrinterType.RECEIPT,
      display_name: 'xprinter xp80',
      protocol: 'WINDOWS',
      is_enabled: 1,
      windows_printer_name: 'Xprinter XP-80T',
      supports_cash_drawer: 1,
    };
    const config: PrinterConfig = {
      enabled: true,
      protocol: 'WINDOWS',
      serverPrinterId: 'receipt-printer-1',
      windowsPrinter: 'Xprinter XP-80T',
      paperWidth: 80,
      charsPerLine: 48,
      supportsCashDrawer: true,
    };

    mock.getEnabled.mockReturnValue([row]);
    mock.getAll.mockReturnValue([row]);
    mock.getById.mockReturnValue(row);
    mock.rowToPrinterConfig.mockReturnValue(config);
  });

  function configureFabricTagPrinter(): void {
    const row = {
      id: 'fabric-printer-1',
      printer_type: PrinterType.FABRIC_TAG,
      display_name: 'TSC MB241 fabric',
      protocol: 'TSPL',
      is_enabled: 1,
      windows_printer_name: 'TSC MB241',
    };
    const mirroredConfig: PrinterConfig = {
      enabled: true,
      protocol: 'TSPL',
      serverPrinterId: 'fabric-printer-1',
      windowsPrinter: 'TSC MB241',
      labelWidth: 20,
      labelHeight: 60,
    };
    mock.currentConfig = {
      multiPrinterMode: true,
      printers: {
        [PrinterType.FABRIC_TAG]: {
          ...mirroredConfig,
          labelGapMm: 0,
          printSpeed: 3,
          printDensity: 12,
          mediaSensor: 'none',
          labelOriginInsetMm: 1.1,
        },
      },
    };
    mock.getEnabled.mockReturnValue([row]);
    mock.getAll.mockReturnValue([row]);
    mock.getById.mockImplementation((id: string) => (id === row.id ? row : null));
    mock.rowToPrinterConfig.mockReturnValue(mirroredConfig);
  }

  it('restores labelOriginInsetMm and the other TSPL tuning before constructing a mirrored driver', async () => {
    configureFabricTagPrinter();
    const container = { set: vi.fn(), getOptional: vi.fn(() => null) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);

    await module.reinitializePrinter();

    expect(mock.tscInstances).toHaveLength(1);
    expect(mock.tscInstances[0]).toMatchObject({
      printerName: 'TSC MB241',
      labelWidth: 20,
      labelHeight: 60,
      media: {
        gapMm: 0,
        speed: 3,
        density: 12,
        sensor: 'none',
        originInsetMm: 1.1,
      },
    });
  });

  it('safely repairs a legacy 20mm fabric driver that has no saved origin inset', async () => {
    configureFabricTagPrinter();
    delete mock.currentConfig.printers?.[PrinterType.FABRIC_TAG]?.labelOriginInsetMm;
    const container = { set: vi.fn(), getOptional: vi.fn(() => null) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);

    await module.reinitializePrinter();

    expect(mock.tscInstances).toHaveLength(1);
    expect(mock.tscInstances[0].media.originInsetMm).toBe(1.1);
  });

  it('rejects malformed direct and socket fabric-tag payloads before the driver runs', async () => {
    configureFabricTagPrinter();
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const getOptional = vi.fn(() => null as unknown);
    const container = { set: vi.fn(), getOptional };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    const driver = mock.tscInstances[0];

    await expect(module.printFabricTag({
      brandName: 'Zira',
      quantity: Number.POSITIVE_INFINITY,
    })).resolves.toMatchObject({ success: false, error: expect.stringMatching(/quantity/) });
    expect(driver.printFabricTag).not.toHaveBeenCalled();

    getOptional.mockReturnValue(socket);
    await (module as any).handlePrintJob({
      jobId: 'fabric-invalid-1',
      jobType: PrintJobType.FABRIC_TAG,
      printerType: PrinterType.FABRIC_TAG,
      printerId: 'fabric-printer-1',
      payload: { brandName: 'Zira', quantity: 0 },
    });

    expect(driver.printFabricTag).not.toHaveBeenCalled();
    expect(socket.sendJobStatus).toHaveBeenCalledWith(
      'fabric-invalid-1',
      'FAILED',
      expect.stringMatching(/quantity/),
      'FINAL',
    );
  });

  it('rejects a fabric-tag socket job routed by printerId to a LABEL slot before PRINTING', async () => {
    const row = {
      id: 'label-tsc-1',
      printer_type: PrinterType.LABEL,
      display_name: 'TSC product labels',
      protocol: 'TSPL',
      is_enabled: 1,
      windows_printer_name: 'TSC Product Label',
    };
    const config: PrinterConfig = {
      enabled: true,
      protocol: 'TSPL',
      serverPrinterId: row.id,
      windowsPrinter: 'TSC Product Label',
      labelWidth: 50,
      labelHeight: 30,
    };
    mock.currentConfig = { multiPrinterMode: true, printers: { [PrinterType.LABEL]: config } };
    mock.getEnabled.mockReturnValue([row]);
    mock.getAll.mockReturnValue([row]);
    mock.getById.mockReturnValue(row);
    mock.rowToPrinterConfig.mockReturnValue(config);
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = { set: vi.fn(), getOptional: vi.fn(() => socket) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    const driver = mock.tscInstances[0];

    await (module as any).handlePrintJob({
      jobId: 'fabric-wrong-route-1',
      jobType: PrintJobType.FABRIC_TAG,
      printerType: PrinterType.FABRIC_TAG,
      printerId: row.id,
      payload: { brandName: 'Zira', quantity: 1 },
    });

    expect(driver.printFabricTag).not.toHaveBeenCalled();
    expect(driver.printLabel).not.toHaveBeenCalled();
    expect(socket.sendJobStatus).toHaveBeenCalledTimes(1);
    expect(socket.sendJobStatus).toHaveBeenCalledWith(
      'fabric-wrong-route-1',
      'FAILED',
      'Fabric tag job cannot run on LABEL printer',
      'FINAL',
    );
  });

  it('rejects a non-fabric socket job routed to FABRIC_TAG before PRINTING', async () => {
    configureFabricTagPrinter();
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = { set: vi.fn(), getOptional: vi.fn(() => socket) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    const driver = mock.tscInstances[0];

    await (module as any).handlePrintJob({
      jobId: 'label-wrong-route-1',
      jobType: PrintJobType.LABEL,
      printerType: PrinterType.LABEL,
      printerId: 'fabric-printer-1',
      payload: { barcode: '5901234123457', quantity: 1 },
    });

    expect(driver.printFabricTag).not.toHaveBeenCalled();
    expect(driver.printLabel).not.toHaveBeenCalled();
    expect(socket.sendJobStatus).toHaveBeenCalledWith(
      'label-wrong-route-1',
      'FAILED',
      'LABEL job cannot run on FABRIC_TAG printer',
      'FINAL',
    );
  });

  it('never falls back to another fabric printer when the exact socket printerId is unavailable', async () => {
    vi.useFakeTimers();
    const availableRow = {
      id: 'fabric-printer-b',
      printer_type: PrinterType.FABRIC_TAG,
      display_name: 'TSC fabric B',
      protocol: 'TSPL',
      is_enabled: 1,
      windows_printer_name: 'TSC MB241 B',
    };
    const unavailableRow = {
      id: 'fabric-printer-a',
      printer_type: PrinterType.FABRIC_TAG,
      display_name: 'TSC fabric A',
      protocol: 'TSPL',
      is_enabled: 0,
      windows_printer_name: 'TSC MB241 A',
    };
    const availableConfig: PrinterConfig = {
      enabled: true,
      protocol: 'TSPL',
      serverPrinterId: availableRow.id,
      windowsPrinter: 'TSC MB241 B',
      labelWidth: 20,
      labelHeight: 60,
    };
    mock.currentConfig = {
      multiPrinterMode: true,
      printers: { [PrinterType.FABRIC_TAG]: availableConfig },
    };
    mock.getEnabled.mockReturnValue([availableRow]);
    mock.getAll.mockReturnValue([availableRow, unavailableRow]);
    mock.getById.mockImplementation((id: string) => (
      id === availableRow.id ? availableRow : id === unavailableRow.id ? unavailableRow : null
    ));
    mock.rowToPrinterConfig.mockImplementation((row: any) => ({
      ...availableConfig,
      enabled: row.is_enabled === 1,
      serverPrinterId: row.id,
      windowsPrinter: row.windows_printer_name,
    }));
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = { set: vi.fn(), getOptional: vi.fn(() => socket) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    vi.spyOn(module as any, 'runHealthCheck').mockResolvedValue(undefined);
    const availableDriver = mock.tscInstances[0];

    const print = (module as any).handlePrintJob({
      jobId: 'fabric-exact-missing-1',
      jobType: PrintJobType.FABRIC_TAG,
      printerType: PrinterType.FABRIC_TAG,
      printerId: unavailableRow.id,
      payload: { brandName: 'Zira', quantity: 1 },
    });
    await vi.advanceTimersByTimeAsync(PRINT_JOB_RETRY_DELAY_MS * 2);
    await print;

    expect(availableDriver.printFabricTag).not.toHaveBeenCalled();
    expect(socket.sendJobStatus).not.toHaveBeenCalledWith(
      'fabric-exact-missing-1',
      'PRINTING',
    );
    expect(socket.sendJobStatus).toHaveBeenCalledWith(
      'fabric-exact-missing-1',
      'FAILED',
      'Printer FABRIC_TAG not connected',
      'SAFE_BEFORE_PRINT',
    );
  });

  it('serializes direct fabric-tag rendering and fails overlap before a second driver call', async () => {
    configureFabricTagPrinter();
    const container = { set: vi.fn(), getOptional: vi.fn(() => null) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    const driver = mock.tscInstances[0];
    let release!: () => void;
    driver.printFabricTag.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));

    const first = module.printFabricTag({ brandName: 'Zira', quantity: 1 });
    await vi.waitFor(() => expect(driver.printFabricTag).toHaveBeenCalledTimes(1));
    await expect(module.printFabricTag({ brandName: 'Zira', quantity: 1 })).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/busy/i),
    });
    expect(driver.printFabricTag).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toEqual({ success: true });
  });

  it('does not disconnect a fabric-tag driver while its render and RAW write are in flight', async () => {
    configureFabricTagPrinter();
    const container = { set: vi.fn(), getOptional: vi.fn(() => null) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    const driver = mock.tscInstances[0];
    let release!: () => void;
    driver.printFabricTag.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));

    const print = module.printFabricTag({ brandName: 'Zira', quantity: 1 });
    await vi.waitFor(() => expect(driver.printFabricTag).toHaveBeenCalledTimes(1));
    const reinitialize = module.reinitializePrinter();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.disconnect).not.toHaveBeenCalled();

    release();
    await expect(print).resolves.toEqual({ success: true });
    await reinitialize;
    expect(driver.disconnect).toHaveBeenCalled();
  });

  it('re-resolves the fabric-tag driver after a queued reinitialize completes', async () => {
    configureFabricTagPrinter();
    const container = { set: vi.fn(), getOptional: vi.fn(() => null) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    const staleDriver = mock.tscInstances[0];

    let releaseLifecycle!: () => void;
    const blocker = (module as any).withPrinterLifecycleLock(
      () => new Promise<void>((resolve) => { releaseLifecycle = resolve; }),
    );
    await vi.waitFor(() => expect(releaseLifecycle).toBeTypeOf('function'));

    const replacementConfig: PrinterConfig = {
      enabled: true,
      protocol: 'TSPL',
      serverPrinterId: 'fabric-printer-1',
      windowsPrinter: 'TSC MB241 Production',
      labelWidth: 25,
      labelHeight: 60,
    };
    const replacementRow = {
      id: 'fabric-printer-1',
      printer_type: PrinterType.FABRIC_TAG,
      display_name: 'TSC MB241 production',
      protocol: 'TSPL',
      is_enabled: 1,
      windows_printer_name: 'TSC MB241 Production',
    };
    mock.currentConfig = {
      multiPrinterMode: true,
      printers: { [PrinterType.FABRIC_TAG]: replacementConfig },
    };
    mock.getEnabled.mockReturnValue([replacementRow]);
    mock.getAll.mockReturnValue([replacementRow]);
    mock.getById.mockReturnValue(replacementRow);
    mock.rowToPrinterConfig.mockReturnValue(replacementConfig);

    const reinitialize = module.reinitializePrinter();
    const print = module.printFabricTag({ brandName: 'Zira', quantity: 1 });
    releaseLifecycle();
    await blocker;
    await reinitialize;
    await expect(print).resolves.toEqual({ success: true });

    expect(mock.tscInstances).toHaveLength(2);
    const replacementDriver = mock.tscInstances[1];
    expect(replacementDriver).toMatchObject({
      printerName: 'TSC MB241 Production',
      labelWidth: 25,
    });
    expect(staleDriver.printFabricTag).not.toHaveBeenCalled();
    expect(replacementDriver.printFabricTag).toHaveBeenCalledTimes(1);
  });

  it('classifies a busy socket fabric-tag job as safe and retries after the active print', async () => {
    vi.useFakeTimers();
    configureFabricTagPrinter();
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = { set: vi.fn(), getOptional: vi.fn(() => socket) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    const driver = mock.tscInstances[0];
    let release!: () => void;
    driver.printFabricTag.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));

    const direct = module.printFabricTag({ brandName: 'Zira', quantity: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.printFabricTag).toHaveBeenCalledTimes(1);
    const socketPrint = (module as any).handlePrintJob({
      jobId: 'fabric-busy-1',
      jobType: PrintJobType.FABRIC_TAG,
      printerType: PrinterType.FABRIC_TAG,
      printerId: 'fabric-printer-1',
      payload: { brandName: 'Zira', quantity: 1 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.printFabricTag).toHaveBeenCalledTimes(1);

    release();
    await direct;
    await vi.advanceTimersByTimeAsync(PRINT_JOB_RETRY_DELAY_MS);
    await socketPrint;

    expect(driver.printFabricTag).toHaveBeenCalledTimes(2);
    expect(socket.sendJobStatus).toHaveBeenCalledWith('fabric-busy-1', 'COMPLETED');
    expect(socket.sendJobStatus).not.toHaveBeenCalledWith(
      'fabric-busy-1',
      'FAILED',
      expect.anything(),
      expect.anything(),
    );
  });

  it('reports formatter construction failures as the config step before connect/send', async () => {
    const container = { set: vi.fn(), getOptional: vi.fn(() => null) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    vi.spyOn(module as any, 'createPrinterFromConfig').mockImplementation(() => {
      throw new RangeError('Invalid TSPL speed');
    });

    const result = await module.testPrinterByConfig({
      enabled: true,
      protocol: 'TSPL',
      windowsPrinter: 'TSC MB241',
      labelWidth: 20,
      labelHeight: 60,
    }, PrinterType.FABRIC_TAG);

    expect(result.success).toBe(false);
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 'config', ok: false, error: 'Invalid TSPL speed' }),
    ]);
    expect(mock.tscInstances).toHaveLength(0);
  });

  it.each([
    ['labelGapMm', 2],
    ['printSpeed', 4],
    ['printDensity', 9],
    ['mediaSensor', 'gap'],
    ['labelOriginInsetMm', 1.5],
  ] as const)('includes TSPL %s in the runtime signature', async (field, changedValue) => {
    const base: PrinterConfig = {
      enabled: true,
      protocol: 'TSPL',
      windowsPrinter: 'TSC MB241',
      labelWidth: 20,
      labelHeight: 60,
      labelGapMm: 0,
      printSpeed: 2,
      printDensity: 12,
      mediaSensor: 'none',
      labelOriginInsetMm: 1.1,
    };
    mock.currentConfig = {
      multiPrinterMode: true,
      printers: { [PrinterType.FABRIC_TAG]: base },
    };
    const container = { set: vi.fn(), getOptional: vi.fn(() => null) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    const before = (module as any).buildPrinterRuntimeSignature();

    mock.currentConfig = {
      multiPrinterMode: true,
      printers: {
        [PrinterType.FABRIC_TAG]: { ...base, [field]: changedValue },
      },
    };

    expect((module as any).buildPrinterRuntimeSignature()).not.toBe(before);
  });

  it('recovers a renamed TSC queue and persists it in config and the local mirror', async () => {
    configureFabricTagPrinter();
    const container = { set: vi.fn(), getOptional: vi.fn(() => null) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const { setConfig } = await import('../src/main/config/store');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    const driver = mock.tscInstances[0];
    driver.connected = false;
    driver.recoverPrinter.mockResolvedValueOnce({
      recovered: true,
      newIdentifier: 'TSC MB241 (Copy 1)',
      oldIdentifier: 'TSC MB241',
    });

    await expect((module as any).attemptDriverRecovery(
      PrinterType.FABRIC_TAG,
      driver,
      ['TSC MB241 (Copy 1)'],
      [],
      'fabric-printer-1',
    )).resolves.toBe(true);

    expect(driver.recoverPrinter).toHaveBeenCalledWith(['TSC MB241 (Copy 1)']);
    expect(driver.reconnect).toHaveBeenCalledWith('TSC MB241 (Copy 1)');
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({
      printers: expect.objectContaining({
        [PrinterType.FABRIC_TAG]: expect.objectContaining({
          windowsPrinter: 'TSC MB241 (Copy 1)',
        }),
      }),
      recoveredWindowsPrinters: {
        'fabric-printer-1': {
          previousName: 'TSC MB241',
          target: 'TSC MB241 (Copy 1)',
        },
      },
    }));
    expect(mock.updateWindowsPrinterName).toHaveBeenCalledWith(
      'fabric-printer-1',
      'TSC MB241 (Copy 1)',
    );
  });

  it('does not persist a recovery candidate that remains physically disconnected', async () => {
    configureFabricTagPrinter();
    const container = { set: vi.fn(), getOptional: vi.fn(() => null) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const { setConfig } = await import('../src/main/config/store');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    const driver = mock.tscInstances[0];
    driver.connected = false;
    driver.recoverPrinter.mockResolvedValueOnce({
      recovered: true,
      newIdentifier: 'Ghost TSC Queue',
      oldIdentifier: 'TSC MB241',
    });
    driver.reconnect.mockImplementationOnce(async () => { driver.connected = false; });
    vi.mocked(setConfig).mockClear();
    mock.updateWindowsPrinterName.mockClear();
    mock.markOnline.mockClear();

    await expect((module as any).attemptDriverRecovery(
      PrinterType.FABRIC_TAG,
      driver,
      ['Ghost TSC Queue'],
      [],
      'fabric-printer-1',
    )).resolves.toBe(false);

    expect(setConfig).not.toHaveBeenCalled();
    expect(mock.updateWindowsPrinterName).not.toHaveBeenCalled();
    expect(mock.markOnline).toHaveBeenCalledWith('fabric-printer-1', false);
  });

  it('keeps recovery provenance per printer id without overwriting the primary type slot', async () => {
    const secondaryRow = {
      id: 'label-2',
      printer_type: PrinterType.LABEL,
      display_name: 'Secondary TSC',
      protocol: 'TSPL',
      is_enabled: 1,
      windows_printer_name: 'TSC Secondary',
    };
    mock.currentConfig = {
      multiPrinterMode: true,
      printers: {
        [PrinterType.LABEL]: {
          enabled: true,
          protocol: 'TSPL',
          serverPrinterId: 'label-1',
          windowsPrinter: 'TSC Primary',
          labelWidth: 50,
          labelHeight: 30,
        },
      },
    };
    mock.getEnabled.mockReturnValue([secondaryRow]);
    mock.getAll.mockReturnValue([secondaryRow]);
    mock.getById.mockReturnValue(secondaryRow);
    mock.rowToPrinterConfig.mockReturnValue({
      enabled: true,
      protocol: 'TSPL',
      serverPrinterId: 'label-2',
      windowsPrinter: 'TSC Secondary',
      labelWidth: 50,
      labelHeight: 30,
    });
    const container = { set: vi.fn(), getOptional: vi.fn(() => null) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const { setConfig } = await import('../src/main/config/store');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    const driver = mock.tscInstances[0];
    driver.connected = false;
    driver.recoverPrinter.mockResolvedValueOnce({
      recovered: true,
      newIdentifier: 'TSC Secondary (Copy 1)',
      oldIdentifier: 'TSC Secondary',
    });
    vi.mocked(setConfig).mockClear();

    await expect((module as any).attemptDriverRecovery(
      PrinterType.LABEL,
      driver,
      ['TSC Secondary (Copy 1)'],
      [],
      'label-2',
    )).resolves.toBe(true);

    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({
      printers: expect.objectContaining({
        [PrinterType.LABEL]: expect.objectContaining({
          serverPrinterId: 'label-1',
          windowsPrinter: 'TSC Primary',
        }),
      }),
      recoveredWindowsPrinters: {
        'label-2': {
          previousName: 'TSC Secondary',
          target: 'TSC Secondary (Copy 1)',
        },
      },
    }));
  });

  it.each([
    ['fresh setup', undefined, undefined, 2, 12],
    ['existing tuning', 4, 9, 4, 9],
  ])('auto-setup applies fabric media defaults without overwriting %s', async (
    _scenario,
    savedSpeed,
    savedDensity,
    expectedSpeed,
    expectedDensity,
  ) => {
    mock.currentConfig = {
      multiPrinterMode: true,
      printers: {
        [PrinterType.FABRIC_TAG]: {
          enabled: true,
          protocol: 'TSPL',
          printSpeed: savedSpeed,
          printDensity: savedDensity,
        },
      },
    };
    const container = { set: vi.fn(), getOptional: vi.fn(() => null) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const { setConfig } = await import('../src/main/config/store');
    const module = new HardwareModule(container as any);
    vi.spyOn(module, 'reinitializePrinter').mockResolvedValue(undefined);

    await (module as any).autoSetupWindowsPrinter(
      PrinterType.FABRIC_TAG,
      'TSPL',
      {
        vid: '1203',
        pid: '0001',
        brand: 'TSC',
        model: 'MB241',
        windowsPrinterName: 'TSC MB241',
        comPort: null,
        portName: 'USB001',
        connectionType: 'USB',
        driverInstalled: true,
      },
    );

    expect(setConfig).toHaveBeenCalledWith({
      multiPrinterMode: true,
      printers: expect.objectContaining({
        [PrinterType.FABRIC_TAG]: expect.objectContaining({
          labelWidth: 20,
          labelHeight: 60,
          mediaSensor: 'none',
          printSpeed: expectedSpeed,
          printDensity: expectedDensity,
          labelOriginInsetMm: 1.1,
        }),
      }),
      recoveredWindowsPrinters: {},
    });
  });

  it('retargets recovery provenance when auto-setup explicitly selects a new queue', async () => {
    mock.currentConfig = {
      multiPrinterMode: true,
      printers: {
        [PrinterType.FABRIC_TAG]: {
          enabled: true,
          protocol: 'TSPL',
          serverPrinterId: 'fabric-printer-1',
          windowsPrinter: 'TSC MB241 (Copy 1)',
          labelWidth: 20,
          labelHeight: 60,
        },
      },
      recoveredWindowsPrinters: {
        'fabric-printer-1': {
          previousName: 'TSC MB241',
          target: 'TSC MB241 (Copy 1)',
        },
      },
    };
    const container = { set: vi.fn(), getOptional: vi.fn(() => null) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const { setConfig } = await import('../src/main/config/store');
    const { normalizeServerPrinterRows } = await import('../src/main/network/api-client');
    const module = new HardwareModule(container as any);
    vi.spyOn(module, 'reinitializePrinter').mockResolvedValue(undefined);

    await (module as any).autoSetupWindowsPrinter(
      PrinterType.FABRIC_TAG,
      'TSPL',
      {
        vid: '1203',
        pid: '0001',
        brand: 'TSC',
        model: 'MB241',
        windowsPrinterName: 'TSC MB241 Production',
        comPort: null,
        portName: 'USB002',
        connectionType: 'USB',
        driverInstalled: true,
      },
    );

    const saved = vi.mocked(setConfig).mock.calls.at(-1)?.[0];
    expect(saved).toMatchObject({
      recoveredWindowsPrinters: {
        'fabric-printer-1': {
          previousName: 'TSC MB241',
          target: 'TSC MB241 Production',
        },
      },
    });
    expect(mock.updateWindowsPrinterName).toHaveBeenCalledWith(
      'fabric-printer-1',
      'TSC MB241 Production',
    );

    const staleServerRows = normalizeServerPrinterRows(
      [{
        id: 'fabric-printer-1',
        printerType: 'FABRIC_TAG',
        protocol: 'TSPL',
        windowsPrinterName: 'TSC MB241',
        paperWidth: 20,
        paperHeight: 60,
        isEnabled: true,
      }],
      saved?.printers,
      saved?.recoveredWindowsPrinters,
    );
    expect(staleServerRows[0]?.windowsPrinterName).toBe('TSC MB241 Production');
  });

  it('does not persist an unverified legacy TSC recovery candidate', async () => {
    mock.currentConfig = {
      multiPrinterMode: false,
      printers: {},
      labelPrinter: {
        enabled: true,
        protocol: 'TSPL',
        windowsPrinter: 'TSC Legacy',
        labelWidth: 50,
        labelHeight: 30,
      },
    };
    mock.getEnabled.mockReturnValue([]);
    mock.getAll.mockReturnValue([]);
    mock.getById.mockReturnValue(null);
    const container = { set: vi.fn(), getOptional: vi.fn(() => null) };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const { setConfig } = await import('../src/main/config/store');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    const driver = mock.tscInstances[0];
    driver.connected = false;
    driver.recoverPrinter.mockResolvedValueOnce({
      recovered: true,
      oldIdentifier: 'TSC Legacy',
      newIdentifier: 'TSC Ghost',
    });
    driver.reconnect.mockImplementationOnce(async () => { driver.connected = false; });
    vi.mocked(setConfig).mockClear();

    await expect((module as any).attemptLegacyDriverRecovery(
      'Label',
      driver,
      ['TSC Ghost'],
      [],
    )).resolves.toBe(false);

    expect(setConfig).not.toHaveBeenCalled();
  });

  it('prints a routed thermal receipt when the optional Elzab constructor is unavailable', async () => {
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => null),
    };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();

    container.getOptional.mockReturnValue(socket);
    const receipt: ReceiptData = {
      orderId: 'order-1',
      orderNumber: 'SCO-1',
      items: [{ name: 'Tea', quantity: 1, unitPrice: 100, totalPrice: 100, vatRate: 23 }],
      payment: { method: 'CARD', amount: 100 },
      subtotal: 100,
      total: 100,
    };

    await (module as any).handlePrintJob({
      jobId: 'job-1',
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.RECEIPT,
      printerId: 'receipt-printer-1',
      payload: receipt,
    });

    expect(mock.thermalInstances[0].printReceipt).toHaveBeenCalledWith(receipt);
    expect(socket.sendJobStatus).toHaveBeenCalledWith('job-1', 'PRINTING');
    expect(socket.sendJobStatus).toHaveBeenCalledWith('job-1', 'COMPLETED');
    expect(mock.markUsed).toHaveBeenCalledWith('receipt-printer-1');
  });

  it('retries a post-driver failure only when it is explicitly SAFE_BEFORE_PRINT', async () => {
    vi.useFakeTimers();
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => socket),
    };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    const driver = mock.thermalInstances[0];
    driver.printReceipt
      .mockRejectedValueOnce(Object.assign(new Error('worker rejected before WritePrinter'), {
        failureClass: 'SAFE_BEFORE_PRINT',
      }))
      .mockResolvedValueOnce(undefined);

    const receipt: ReceiptData = {
      orderId: 'order-safe-retry',
      orderNumber: 'ZAM-safe-retry',
      items: [{ name: 'Tea', quantity: 1, unitPrice: 100, totalPrice: 100, vatRate: 23 }],
      payment: { method: 'CARD', amount: 100 },
      subtotal: 100,
      total: 100,
    };
    const printPromise = (module as any).handlePrintJob({
      jobId: 'job-safe-retry',
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.RECEIPT,
      printerId: 'receipt-printer-1',
      payload: receipt,
    });

    await vi.advanceTimersByTimeAsync(PRINT_JOB_RETRY_DELAY_MS);
    await printPromise;

    expect(driver.printReceipt).toHaveBeenCalledTimes(2);
    expect(socket.sendJobStatus).toHaveBeenCalledWith('job-safe-retry', 'COMPLETED');
    expect(socket.sendJobStatus).not.toHaveBeenCalledWith(
      'job-safe-retry',
      'FAILED',
      expect.anything(),
      expect.anything(),
    );
  });

  it('fails immediately without retry after an explicit UNCERTAIN_AFTER_PRINT result', async () => {
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => socket),
    };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    const driver = mock.thermalInstances[0];
    driver.printReceipt.mockRejectedValue(
      Object.assign(new Error('WritePrinter result is unknown'), {
        failureClass: 'UNCERTAIN_AFTER_PRINT',
      }),
    );

    await (module as any).handlePrintJob({
      jobId: 'job-uncertain',
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.RECEIPT,
      printerId: 'receipt-printer-1',
      payload: {
        orderId: 'order-uncertain',
        orderNumber: 'ZAM-uncertain',
        items: [{ name: 'Tea', quantity: 1, unitPrice: 100, totalPrice: 100, vatRate: 23 }],
        payment: { method: 'CARD', amount: 100 },
        subtotal: 100,
        total: 100,
      } satisfies ReceiptData,
    });

    expect(driver.printReceipt).toHaveBeenCalledTimes(1);
    expect(socket.sendJobStatus).toHaveBeenCalledWith(
      'job-uncertain',
      'FAILED',
      'WritePrinter result is unknown',
      'UNCERTAIN_AFTER_PRINT',
    );
  });

  it('defers a periodic health check while any thermal print is busy', async () => {
    vi.useFakeTimers();
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => null),
    };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    const runHealthCheck = vi.spyOn(module as any, 'runHealthCheck').mockResolvedValue(undefined);

    (module as any).startHealthCheck();
    mock.thermalPrintBusy = true;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(runHealthCheck).not.toHaveBeenCalled();

    mock.thermalPrintBusy = false;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(runHealthCheck).toHaveBeenCalledTimes(1);
    (module as any).stopHealthCheck();
  });

  it('can register startup printer drivers without connecting them on the critical path', async () => {
    mock.thermalInitiallyConnected = false;
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => null),
    };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter({ connect: false } as any);

    expect(mock.thermalInstances).toHaveLength(1);
    expect(mock.thermalInstances[0].connect).not.toHaveBeenCalled();
  });

  it('connects a disconnected routed printer on demand before failing an early print job', async () => {
    vi.useFakeTimers();
    mock.thermalInitiallyConnected = false;
    mock.thermalConnectImpl = async () => true;
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => socket),
    };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter({ connect: false } as any);
    const driver = mock.thermalInstances[0];
    driver.connect.mockClear();
    driver.connected = false;

    const receipt: ReceiptData = {
      orderId: 'order-early',
      orderNumber: 'SCO-early',
      items: [{ name: 'Tea', quantity: 1, unitPrice: 100, totalPrice: 100, vatRate: 23 }],
      payment: { method: 'CARD', amount: 100 },
      subtotal: 100,
      total: 100,
    };

    const printPromise = (module as any).handlePrintJob({
      jobId: 'job-early',
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.RECEIPT,
      printerId: 'receipt-printer-1',
      payload: receipt,
    });
    await vi.advanceTimersByTimeAsync(4_100);
    await printPromise;

    expect(driver.connect).toHaveBeenCalledTimes(1);
    expect(driver.printReceipt).toHaveBeenCalledWith(receipt);
    expect(socket.sendJobStatus).toHaveBeenCalledWith('job-early', 'COMPLETED');
  });

  it('opens the cash drawer after a successful routed POS receipt when requested', async () => {
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => null),
    };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();

    container.getOptional.mockReturnValue(socket);
    const receipt: ReceiptData = {
      orderId: 'order-1',
      orderNumber: 'POS-1',
      items: [{ name: 'Tea', quantity: 1, unitPrice: 100, totalPrice: 100, vatRate: 23 }],
      payment: { method: 'CASH', amount: 100 },
      subtotal: 100,
      total: 100,
    };

    await (module as any).handlePrintJob({
      jobId: 'job-cash',
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.RECEIPT,
      printerId: 'receipt-printer-1',
      referenceType: 'POS_RECEIPT',
      payload: receipt,
      openDrawer: true,
    });

    expect(mock.thermalInstances[0].printReceipt).toHaveBeenCalledWith(receipt);
    expect(mock.thermalInstances[0].openDrawer).toHaveBeenCalledTimes(1);
    expect(socket.sendJobStatus).toHaveBeenCalledWith('job-cash', 'COMPLETED');
    expect(mock.markUsed).toHaveBeenCalledWith('receipt-printer-1');
  });

  it('bundles the drawer pulse into the receipt write when the driver supports it', async () => {
    // A separate openDrawer() is its own Windows spooler job (~5s on the
    // shared till) — with printReceiptWithDrawer available the module must
    // send one write and skip the standalone drawer call.
    mock.thermalSupportsBundledDrawer = true;
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => null),
    };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();

    container.getOptional.mockReturnValue(socket);
    const receipt: ReceiptData = {
      orderId: 'order-bundled',
      orderNumber: 'POS-9',
      items: [{ name: 'Tea', quantity: 1, unitPrice: 100, totalPrice: 100, vatRate: 23 }],
      payment: { method: 'CASH', amount: 100 },
      subtotal: 100,
      total: 100,
    };

    await (module as any).handlePrintJob({
      jobId: 'job-bundled-cash',
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.RECEIPT,
      printerId: 'receipt-printer-1',
      referenceType: 'POS_RECEIPT',
      payload: receipt,
      openDrawer: true,
    });

    const driver = mock.thermalInstances[0] as any;
    expect(driver.printReceiptWithDrawer).toHaveBeenCalledWith(receipt);
    expect(driver.printReceipt).not.toHaveBeenCalled();
    expect(driver.openDrawer).not.toHaveBeenCalled();
    expect(socket.sendJobStatus).toHaveBeenCalledWith('job-bundled-cash', 'COMPLETED');
  });

  it('opens the cash drawer for legacy routed POS cash receipts even when openDrawer is missing', async () => {
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => null),
    };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();

    container.getOptional.mockReturnValue(socket);
    const receipt: ReceiptData = {
      orderId: 'order-legacy-cash',
      orderNumber: 'POS-2',
      items: [{ name: 'Tea', quantity: 1, unitPrice: 100, totalPrice: 100, vatRate: 23 }],
      payment: { method: 'CASH', amount: 100 },
      subtotal: 100,
      total: 100,
    };

    await (module as any).handlePrintJob({
      jobId: 'job-legacy-cash',
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.RECEIPT,
      printerId: 'receipt-printer-1',
      referenceType: 'POS_RECEIPT',
      payload: receipt,
    });

    expect(mock.thermalInstances[0].printReceipt).toHaveBeenCalledWith(receipt);
    expect(mock.thermalInstances[0].openDrawer).toHaveBeenCalledTimes(1);
    expect(socket.sendJobStatus).toHaveBeenCalledWith('job-legacy-cash', 'COMPLETED');
  });

  it('does not infer drawer intent for non-POS cash receipts without openDrawer', async () => {
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => null),
    };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();

    container.getOptional.mockReturnValue(socket);
    const receipt: ReceiptData = {
      orderId: 'billiard-session-1',
      orderNumber: 'BILL-1',
      items: [{ name: 'Table', quantity: 1, unitPrice: 100, totalPrice: 100, vatRate: 23 }],
      payment: { method: 'CASH', amount: 100 },
      subtotal: 100,
      total: 100,
    };

    await (module as any).handlePrintJob({
      jobId: 'job-non-pos-cash',
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.RECEIPT,
      printerId: 'receipt-printer-1',
      payload: receipt,
    });

    expect(mock.thermalInstances[0].printReceipt).toHaveBeenCalledWith(receipt);
    expect(mock.thermalInstances[0].openDrawer).not.toHaveBeenCalled();
    expect(socket.sendJobStatus).toHaveBeenCalledWith('job-non-pos-cash', 'COMPLETED');
  });

  it('routes a FISCAL receipt job by printerId and never opens the cash drawer', async () => {
    mock.posnetConnects = true;
    const fiscalRow = {
      id: 'fiscal-printer-1',
      printer_type: PrinterType.FISCAL,
      display_name: 'posnet thermal hd',
      protocol: 'POSNET',
      is_enabled: 1,
      address: 'COM4',
      supports_cash_drawer: 1,
    };
    const fiscalConfig: PrinterConfig = {
      enabled: true,
      protocol: 'POSNET',
      serverPrinterId: 'fiscal-printer-1',
      port: 'COM4',
      paperWidth: 80,
      charsPerLine: 48,
      supportsCashDrawer: true,
    };
    mock.getEnabled.mockReturnValue([fiscalRow]);
    mock.getAll.mockReturnValue([fiscalRow]);
    mock.getById.mockImplementation((id: string) => (id === 'fiscal-printer-1' ? fiscalRow : null));
    mock.rowToPrinterConfig.mockReturnValue(fiscalConfig);

    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => null),
    };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();

    container.getOptional.mockReturnValue(socket);
    const receipt: ReceiptData = {
      orderId: 'order-fiscal-1',
      orderNumber: 'POS-3',
      items: [{ name: 'Tea', quantity: 1, unitPrice: 100, totalPrice: 100, vatRate: 23 }],
      payment: { method: 'CARD', amount: 100 },
      subtotal: 100,
      total: 100,
    };

    await (module as any).handlePrintJob({
      jobId: 'job-fiscal',
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.FISCAL,
      printerId: 'fiscal-printer-1',
      referenceType: 'POS_FISCAL_RECEIPT',
      referenceId: 'order-fiscal-1',
      payload: receipt,
      openDrawer: true,
    });

    expect(mock.posnetInstances[0].printReceipt).toHaveBeenCalledWith(receipt);
    expect(mock.posnetInstances[0].openDrawer).not.toHaveBeenCalled();
    expect(socket.sendJobStatus).toHaveBeenCalledWith('job-fiscal', 'COMPLETED');
    expect(mock.markUsed).toHaveBeenCalledWith('fiscal-printer-1');
  });

  it('never retries a fiscal driver result classified as UNCERTAIN_AFTER_PRINT', async () => {
    mock.posnetConnects = true;
    const fiscalRow = {
      id: 'fiscal-printer-1',
      printer_type: PrinterType.FISCAL,
      display_name: 'posnet thermal hd',
      protocol: 'POSNET',
      is_enabled: 1,
      address: 'COM4',
      supports_cash_drawer: 1,
    };
    mock.getEnabled.mockReturnValue([fiscalRow]);
    mock.getAll.mockReturnValue([fiscalRow]);
    mock.getById.mockImplementation((id: string) => (id === 'fiscal-printer-1' ? fiscalRow : null));
    mock.rowToPrinterConfig.mockReturnValue({
      enabled: true,
      protocol: 'POSNET',
      serverPrinterId: 'fiscal-printer-1',
      port: 'COM4',
      paperWidth: 80,
      charsPerLine: 48,
      supportsCashDrawer: true,
    } satisfies PrinterConfig);
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => socket),
    };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    mock.posnetInstances[0].printReceipt.mockRejectedValue(
      Object.assign(new Error('printer not connected after an ambiguous send'), {
        failureClass: 'UNCERTAIN_AFTER_PRINT',
      }),
    );

    await (module as any).handlePrintJob({
      jobId: 'job-fiscal-uncertain',
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.FISCAL,
      printerId: 'fiscal-printer-1',
      referenceType: 'POS_FISCAL_RECEIPT',
      referenceId: 'order-fiscal-uncertain',
      payload: {
        orderId: 'order-fiscal-uncertain',
        orderNumber: 'POS-fiscal-uncertain',
        items: [{ name: 'Tea', quantity: 1, unitPrice: 100, totalPrice: 100, vatRate: 23 }],
        payment: { method: 'CARD', amount: 100 },
        subtotal: 100,
        total: 100,
      } satisfies ReceiptData,
    });

    expect(mock.posnetInstances[0].printReceipt).toHaveBeenCalledTimes(1);
    expect(socket.sendJobStatus).toHaveBeenCalledWith(
      'job-fiscal-uncertain',
      'FAILED',
      expect.stringContaining('FISCAL PRINT FAILED'),
      'UNCERTAIN_AFTER_PRINT',
    );
  });

  it('keeps the current printer driver when a backend refresh emits unchanged config', async () => {
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => null),
    };

    const { EventBus } = await import('../src/main/core/event-bus');
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();

    const firstDriver = mock.thermalInstances[0];
    expect(mock.thermalInstances).toHaveLength(1);

    const bus = new EventBus();
    module.registerEventHandlers(bus);
    bus.emit('config:changed', { changedKeys: ['printers', 'multiPrinterMode'] });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mock.thermalInstances).toHaveLength(1);
    expect(firstDriver.disconnect).not.toHaveBeenCalled();
  });

  it('LAN_FIRST kitchen printing requires the exact printerId driver and never falls back by KITCHEN type', async () => {
    const fallbackKitchenRow = {
      id: 'kitchen-fallback',
      printer_type: PrinterType.KITCHEN,
      display_name: 'kitchen fallback',
      protocol: 'WINDOWS',
      is_enabled: 1,
      windows_printer_name: 'Kitchen Epson',
      supports_cash_drawer: 0,
    };
    const missingKitchenRow = {
      ...fallbackKitchenRow,
      id: 'kitchen-missing',
      display_name: 'kitchen missing',
      windows_printer_name: 'Missing Epson',
    };
    const fallbackConfig: PrinterConfig = {
      enabled: true,
      protocol: 'WINDOWS',
      serverPrinterId: 'kitchen-fallback',
      windowsPrinter: 'Kitchen Epson',
      paperWidth: 80,
      charsPerLine: 48,
    };
    const missingConfig: PrinterConfig = {
      ...fallbackConfig,
      serverPrinterId: 'kitchen-missing',
      windowsPrinter: 'Missing Epson',
    };

    mock.getEnabled.mockReturnValue([fallbackKitchenRow]);
    mock.getAll.mockReturnValue([fallbackKitchenRow, missingKitchenRow]);
    mock.getById.mockImplementation((id: string) => (
      id === 'kitchen-missing'
        ? missingKitchenRow
        : id === 'kitchen-fallback'
          ? fallbackKitchenRow
          : null
    ));
    mock.rowToPrinterConfig.mockImplementation((row: { id: string }) => (
      row.id === 'kitchen-missing' ? missingConfig : fallbackConfig
    ));

    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => null),
    };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();

    const ticket: KitchenTicketData = {
      orderId: 'order-1',
      orderNumber: 'K-001',
      createdAt: '2026-06-18T10:00:00.000Z',
      source: 'SELF_CHECKOUT',
      items: [{ name: 'Pho bo', quantity: 1 }],
    };

    await expect(module.printLanFirstKitchenTicket({
      jobId: 'job-1',
      idempotencyKey: 'idem-1',
      payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      dispatchMode: 'LAN_FIRST',
      sourceMachineId: 'source-machine',
      targetMachineId: 'target-machine',
      printerId: 'kitchen-missing',
      jobType: 'KITCHEN_TICKET',
      printerType: 'KITCHEN',
      referenceType: 'KITCHEN_TICKET',
      referenceId: 'order-1',
      payload: ticket,
    })).rejects.toThrow(/not initialized|not connected/i);

    expect(mock.thermalInstances[0].printPlainLines).not.toHaveBeenCalled();
    expect(mock.markUsed).not.toHaveBeenCalledWith('kitchen-missing');
  });

  function configureKitchenPrinter(): void {
    const kitchenRow = {
      id: 'kitchen-printer-1',
      printer_type: PrinterType.KITCHEN,
      display_name: 'kitchen printer',
      protocol: 'WINDOWS',
      is_enabled: 1,
      windows_printer_name: 'Kitchen Epson',
      supports_cash_drawer: 0,
    };
    const kitchenConfig: PrinterConfig = {
      enabled: true,
      protocol: 'WINDOWS',
      serverPrinterId: 'kitchen-printer-1',
      windowsPrinter: 'Kitchen Epson',
      paperWidth: 80,
      charsPerLine: 48,
    };
    mock.getEnabled.mockReturnValue([kitchenRow]);
    mock.getAll.mockReturnValue([kitchenRow]);
    mock.getById.mockImplementation((id: string) => (id === 'kitchen-printer-1' ? kitchenRow : null));
    mock.rowToPrinterConfig.mockReturnValue(kitchenConfig);
  }

  function kitchenTicket(): KitchenTicketData {
    return {
      orderId: 'order-1',
      orderNumber: 'K-001',
      createdAt: '2026-06-18T10:00:00.000Z',
      source: 'SELF_CHECKOUT',
      items: [{ name: 'Pho bo', quantity: 1 }],
    };
  }

  function lanFirstKitchenSocketJob(overrides: Record<string, unknown> = {}) {
    return {
      jobId: 'job-lan-1',
      dispatchMode: 'LAN_FIRST',
      idempotencyKey: 'idem-1',
      payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceMachineId: 'source-machine',
      targetMachineId: 'target-machine',
      jobType: PrintJobType.KITCHEN_TICKET,
      printerType: PrinterType.KITCHEN,
      printerId: 'kitchen-printer-1',
      referenceType: 'KITCHEN_TICKET',
      referenceId: 'order-1',
      payload: kitchenTicket(),
      ...overrides,
    };
  }

  it('LAN_FIRST socket kitchen job with completed ledger no-ops and sends COMPLETED', async () => {
    configureKitchenPrinter();
    mock.lanFirstBeginPrintAttempt.mockResolvedValueOnce({
      action: 'NOOP',
      duplicate: true,
      status: 'COMPLETED',
      row: { status: 'COMPLETED' },
    });
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = { set: vi.fn(), getOptional: vi.fn(() => socket) };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    await (module as any).handlePrintJob(lanFirstKitchenSocketJob());

    expect(mock.lanFirstBeginPrintAttempt).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'idem-1',
      payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      jobId: 'job-lan-1',
      printerId: 'kitchen-printer-1',
    }));
    expect(mock.thermalInstances[0].printPlainLines).not.toHaveBeenCalled();
    expect(socket.sendJobStatus).toHaveBeenCalledWith('job-lan-1', 'COMPLETED');
  });

  it('LAN_FIRST socket kitchen job with hash mismatch fails and does not print', async () => {
    configureKitchenPrinter();
    mock.lanFirstBeginPrintAttempt.mockResolvedValueOnce({
      action: 'REJECT',
      reason: 'PAYLOAD_HASH_MISMATCH',
      row: { status: 'COMPLETED' },
    });
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = { set: vi.fn(), getOptional: vi.fn(() => socket) };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    await (module as any).handlePrintJob(lanFirstKitchenSocketJob({
      payloadHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }));

    expect(mock.thermalInstances[0].printPlainLines).not.toHaveBeenCalled();
    expect(socket.sendJobStatus).toHaveBeenCalledWith(
      'job-lan-1',
      'FAILED',
      expect.stringMatching(/PAYLOAD_HASH_MISMATCH/),
      'FINAL',
    );
  });

  it('LAN_FIRST socket kitchen job first attempt marks ledger and prints once', async () => {
    configureKitchenPrinter();
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = { set: vi.fn(), getOptional: vi.fn(() => socket) };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    await (module as any).handlePrintJob(lanFirstKitchenSocketJob());

    expect(mock.lanFirstBeginPrintAttempt).toHaveBeenCalledTimes(1);
    expect(mock.thermalInstances[0].printPlainLines).toHaveBeenCalledTimes(1);
    expect(mock.lanFirstMarkCompleted).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'idem-1',
      jobId: 'job-lan-1',
      printerId: 'kitchen-printer-1',
    }));
    expect(socket.sendJobStatus).toHaveBeenCalledWith('job-lan-1', 'COMPLETED');
  });

  it('normal socket kitchen ticket still prints through the existing path', async () => {
    configureKitchenPrinter();
    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const container = { set: vi.fn(), getOptional: vi.fn(() => socket) };

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule(container as any);
    await module.reinitializePrinter();
    await (module as any).handlePrintJob({
      jobId: 'job-normal-kitchen',
      jobType: PrintJobType.KITCHEN_TICKET,
      printerType: PrinterType.KITCHEN,
      printerId: 'kitchen-printer-1',
      referenceType: 'KITCHEN_TICKET',
      referenceId: 'order-1',
      payload: kitchenTicket(),
    });

    expect(mock.lanFirstBeginPrintAttempt).not.toHaveBeenCalled();
    expect(mock.thermalInstances[0].printPlainLines).toHaveBeenCalledTimes(1);
    expect(socket.sendJobStatus).toHaveBeenCalledWith('job-normal-kitchen', 'COMPLETED');
  });
});
