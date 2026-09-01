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
        }),
      }),
    });
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
