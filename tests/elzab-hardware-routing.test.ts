import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_PROTOCOLS_BY_TYPE,
  PrinterType,
  PrintJobType,
  type AgentConfig,
  type PrinterConfig,
} from '../src/shared/types';

const mock = vi.hoisted(() => ({
  currentConfig: {} as Partial<AgentConfig>,
  setConfig: vi.fn(),
  getEnabled: vi.fn(),
  getById: vi.fn(),
  markOnline: vi.fn(),
  markUsed: vi.fn(),
  rowToPrinterConfig: vi.fn(),
  thermalCtor: vi.fn(),
  zebraCtor: vi.fn(),
  printInfoLabelToDevice: vi.fn(),
  elzabCtor: vi.fn(),
  elzabInstances: [] as any[],
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
  setConfig: mock.setConfig,
}));

vi.mock('../src/main/database/repos/local-printer-repo', () => ({
  localPrinterRepo: {
    getEnabled: mock.getEnabled,
    getById: mock.getById,
    markOnline: mock.markOnline,
    markUsed: mock.markUsed,
  },
  rowToPrinterConfig: mock.rowToPrinterConfig,
}));

vi.mock('../src/main/hardware/thermal/thermal-driver', () => {
  class ThermalDriver {
    constructor(...args: unknown[]) { mock.thermalCtor(...args); }
    connect = vi.fn(async () => true);
    disconnect = vi.fn();
    isConnected = vi.fn(() => true);
    printTest = vi.fn();
    printReceipt = vi.fn();
    openDrawer = vi.fn();
  }
  return { ThermalDriver };
});

vi.mock('../src/main/hardware/elzab/elzab-driver', () => {
  class ElzabDriver {
    options: any;
    constructor(options: any) {
      this.options = options;
      mock.elzabCtor(options);
      mock.elzabInstances.push(this);
    }
    connect = vi.fn(async () => false);
    disconnect = vi.fn();
    isConnected = vi.fn(() => false);
    printTest = vi.fn(async () => { throw new Error('ELZAB bridge missing'); });
    printReceipt = vi.fn(async () => { throw new Error('ELZAB bridge missing'); });
    printDailyReport = vi.fn(async () => { throw new Error('ELZAB report missing'); });
    printXReport = vi.fn(async () => { throw new Error('ELZAB report missing'); });
    printZReport = vi.fn(async () => { throw new Error('ELZAB report missing'); });
    openDrawer = vi.fn();
    healthCheck = vi.fn(async () => false);
    getLastDiagnostic = vi.fn(() => ({ code: 'ELZAB_BRIDGE_NOT_CONFIGURED', detail: 'missing bridge' }));
    getConnectionState = vi.fn(() => 'disconnected');
    getPort = vi.fn(() => this.options.port);
    getAddress = vi.fn(() => this.options.address);
  }
  return { ElzabDriver };
});

vi.mock('../src/main/hardware/posnet/posnet-driver', () => {
  class PosnetDriver {
    constructor() {}
    connect = vi.fn(async () => false);
    disconnect = vi.fn();
    isConnected = vi.fn(() => false);
    printTest = vi.fn();
    printReceipt = vi.fn();
    openDrawer = vi.fn();
  }
  return { PosnetDriver };
});

vi.mock('../src/main/hardware/zebra/zebra-driver', () => {
  class ZebraDriver {
    constructor(...args: unknown[]) { mock.zebraCtor(...args); }
    connect = vi.fn(async () => true);
    disconnect = vi.fn();
    isConnected = vi.fn(() => true);
    printTest = vi.fn();
    printLabel = vi.fn();
    printInfoLabel = vi.fn();
    openDrawer = vi.fn();
  }
  return { ZebraDriver };
});

vi.mock('../src/main/hardware/pdf/pdf-printer', () => ({
  printLabelToDevice: vi.fn(),
  printInfoLabelToDevice: mock.printInfoLabelToDevice,
  cleanupOldLabels: vi.fn(),
}));

async function buildDriver(config: PrinterConfig, type: PrinterType = PrinterType.FISCAL) {
  const { HardwareModule } = await import('../src/main/modules/hardware.module');
  const module = new HardwareModule({ set: vi.fn(), getOptional: vi.fn() } as any);
  return (module as any).createPrinterFromConfig(config, type);
}

describe('ELZAB fiscal protocol routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.currentConfig = {};
    mock.getEnabled.mockReturnValue([]);
    mock.getById.mockReturnValue(null);
    mock.rowToPrinterConfig.mockReset();
    mock.elzabInstances.length = 0;
    mock.zebraCtor.mockReset();
    mock.printInfoLabelToDevice.mockReset();
  });

  it('allows ELZAB_STX only in FISCAL, while RECEIPT stays non-fiscal', () => {
    expect(ALLOWED_PROTOCOLS_BY_TYPE.FISCAL).toEqual(['POSNET', 'ELZAB_STX']);
    expect(ALLOWED_PROTOCOLS_BY_TYPE.RECEIPT).not.toContain('POSNET');
    expect(ALLOWED_PROTOCOLS_BY_TYPE.RECEIPT).not.toContain('ELZAB_STX');
  });

  it('creates ElzabDriver for FISCAL ELZAB_STX config, not ThermalDriver', async () => {
    const driver = await buildDriver({
      enabled: true,
      protocol: 'ELZAB_STX',
      port: 'COM8',
      baudRate: 9600,
    });

    expect(driver).toBe(mock.elzabInstances[0]);
    expect(mock.elzabCtor).toHaveBeenCalledWith(expect.objectContaining({ port: 'COM8', baudRate: 9600 }));
    expect(mock.thermalCtor).not.toHaveBeenCalled();
  });

  it('rejects RECEIPT ELZAB_STX config instead of falling back to thermal', async () => {
    const driver = await buildDriver({
      enabled: true,
      protocol: 'ELZAB_STX',
      port: 'COM8',
    }, PrinterType.RECEIPT);

    expect(driver).toBeNull();
    expect(mock.elzabCtor).not.toHaveBeenCalled();
    expect(mock.thermalCtor).not.toHaveBeenCalled();
  });

  it('maps server ELZAB/STX printer rows to FISCAL ELZAB_STX', async () => {
    const { printerMappingForTests } = await import('../src/main/network/api-client');

    const elzab = printerMappingForTests.mapServerPrinter({
      id: 'elzab-1',
      printerType: 'RECEIPT',
      protocol: 'ELZAB',
      address: 'COM8',
      isEnabled: true,
    } as any);
    expect(elzab?.type).toBe(PrinterType.FISCAL);
    expect(elzab?.config).toMatchObject({ protocol: 'ELZAB_STX', port: 'COM8' });

    const stx = printerMappingForTests.mapServerPrinter({
      id: 'elzab-2',
      printerType: 'KITCHEN',
      protocol: 'STX',
      address: '192.168.192.1:9100',
      isEnabled: true,
    } as any);
    expect(stx?.type).toBe(PrinterType.FISCAL);
    expect(stx?.config).toMatchObject({ protocol: 'ELZAB_STX', address: '192.168.192.1:9100' });
  });

  it('maps server LABEL paperHeight into both config and local mirror rows', async () => {
    const { printerMappingForTests } = await import('../src/main/network/api-client');

    const label = printerMappingForTests.mapServerPrinter({
      id: 'xprinter-1',
      printerType: 'LABEL',
      protocol: 'WINDOWS',
      windowsPrinterName: 'Xprinter XP-423B',
      paperWidth: 100,
      paperHeight: 150,
      isEnabled: true,
    });
    expect(label?.config).toMatchObject({
      paperWidth: 100,
      labelWidth: 100,
      labelHeight: 150,
    });

    const rows = printerMappingForTests.normalizeServerPrinterRows([{
      id: 'xprinter-1',
      printerType: 'LABEL',
      protocol: 'WINDOWS',
      windowsPrinterName: 'Xprinter XP-423B',
      paperWidth: 100,
      paperHeight: 150,
      isOnline: true,
      isEnabled: true,
    }]);
    expect(rows[0]).toMatchObject({ paperWidth: 100, paperHeight: 150, isOnline: true });
  });

  it('routes print jobs by ELZAB server printerId through ElzabDriver', async () => {
    const row = {
      id: 'elzab-1',
      printer_type: PrinterType.FISCAL,
      display_name: 'ELZAB Zeta Online',
      protocol: 'ELZAB_STX',
      is_enabled: 1,
    };
    const config: PrinterConfig = {
      enabled: true,
      protocol: 'ELZAB_STX',
      serverPrinterId: 'elzab-1',
      port: 'COM8',
    };
    mock.currentConfig = { multiPrinterMode: true, printers: {} };
    mock.getEnabled.mockReturnValue([row]);
    mock.getById.mockReturnValue(row);
    mock.rowToPrinterConfig.mockReturnValue(config);

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule({ set: vi.fn(), getOptional: vi.fn() } as any);
    await module.reinitializePrinter();

    const driver = (module as any).getPrinterForJob({
      jobId: 'job-1',
      jobType: PrintJobType.RECEIPT,
      printerId: 'elzab-1',
      payload: {},
    });
    expect(driver).toBe(mock.elzabInstances[0]);
  });

  it('keeps mirrored LABEL row dimensions instead of per-type config fallback', async () => {
    const row = {
      id: 'xprinter-1',
      printer_type: PrinterType.LABEL,
      display_name: 'Xprinter 100x150',
      protocol: 'WINDOWS',
      is_enabled: 1,
    };
    const config: PrinterConfig = {
      enabled: true,
      protocol: 'WINDOWS',
      serverPrinterId: 'xprinter-1',
      windowsPrinter: 'Xprinter XP-423B',
      paperWidth: 100,
      labelWidth: 100,
      labelHeight: 150,
    };
    mock.currentConfig = {
      multiPrinterMode: true,
      printers: {
        LABEL: {
          enabled: true,
          protocol: 'WINDOWS',
          windowsPrinter: 'ZDesigner GK420d',
          labelWidth: 50,
          labelHeight: 30,
        },
      },
    };
    mock.getEnabled.mockReturnValue([row]);
    mock.getById.mockReturnValue(row);
    mock.rowToPrinterConfig.mockReturnValue(config);

    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule({ set: vi.fn(), getOptional: vi.fn() } as any);
    await module.reinitializePrinter();

    expect(mock.zebraCtor).toHaveBeenCalledWith('Xprinter XP-423B', 100, 150);
  });

  it('prints Xprinter info labels through Windows HTML rendering for Unicode text', async () => {
    const row = {
      id: 'xprinter-1',
      printer_type: PrinterType.LABEL,
      display_name: 'Xprinter 100x150',
      protocol: 'WINDOWS',
      is_enabled: 1,
    };
    const config: PrinterConfig = {
      enabled: true,
      protocol: 'WINDOWS',
      serverPrinterId: 'xprinter-1',
      windowsPrinter: 'Xprinter XP-423B',
      paperWidth: 100,
      labelWidth: 100,
      labelHeight: 150,
    };
    mock.currentConfig = { multiPrinterMode: true, printers: {} };
    mock.getEnabled.mockReturnValue([row]);
    mock.getById.mockReturnValue(row);
    mock.rowToPrinterConfig.mockReturnValue(config);
    mock.printInfoLabelToDevice.mockResolvedValue('info-label.html');

    const socket = { sendJobStatus: vi.fn(), isConnected: vi.fn(() => false), sendDeviceStatus: vi.fn() };
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const module = new HardwareModule({ set: vi.fn(), getOptional: vi.fn(() => socket) } as any);
    await module.reinitializePrinter();

    await (module as any).handlePrintJob({
      jobId: 'job-info',
      jobType: PrintJobType.INFO_LABEL,
      printerId: 'xprinter-1',
      payload: {
        productName: 'Złota Nioska Świeże Jaja',
        ingredients: 'Składniki: ś, ż, ć',
        bestBefore: '2026-06-06',
        manufacturerInfo: 'właściciel marki',
        manufacturerRole: 'PRODUCER',
        countryOfOrigin: null,
        quantity: 1,
      },
    });

    expect(mock.printInfoLabelToDevice).toHaveBeenCalledWith(expect.objectContaining({
      printerName: 'Xprinter XP-423B',
      labelWidthMm: 100,
      labelHeightMm: 150,
    }));
    expect(mock.markUsed).toHaveBeenCalledWith('xprinter-1');
  });
});
