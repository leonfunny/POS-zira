import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PrintJobType,
  PrinterType,
  type AgentConfig,
  type PrinterConfig,
  type ReceiptData,
} from '../src/shared/types';

const mock = vi.hoisted(() => ({
  currentConfig: {} as Partial<AgentConfig>,
  getEnabled: vi.fn(),
  getAll: vi.fn(),
  getById: vi.fn(),
  markOnline: vi.fn(),
  markUsed: vi.fn(),
  rowToPrinterConfig: vi.fn(),
  thermalInstances: [] as any[],
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

vi.mock('../src/main/hardware/elzab/elzab-driver', () => ({
  ElzabDriver: undefined,
}));

vi.mock('../src/main/hardware/thermal/thermal-driver', () => {
  class ThermalDriver {
    printReceipt = vi.fn();
    openDrawer = vi.fn();
    constructor() {
      mock.thermalInstances.push(this);
    }
    connect = vi.fn(async () => true);
    disconnect = vi.fn();
    isConnected = vi.fn(() => true);
    printDailyReport = vi.fn();
    printXReport = vi.fn();
    printZReport = vi.fn();
  }
  return { ThermalDriver };
});

vi.mock('../src/main/hardware/posnet/posnet-driver', () => {
  class PosnetDriver {
    connect = vi.fn(async () => false);
    disconnect = vi.fn();
    isConnected = vi.fn(() => false);
    printReceipt = vi.fn();
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

vi.mock('../src/main/hardware/pdf/pdf-printer', () => ({
  printLabelToDevice: vi.fn(),
  printInfoLabelToDevice: vi.fn(),
  cleanupOldLabels: vi.fn(),
}));

describe('HardwareModule print job runtime guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.thermalInstances.length = 0;
    mock.currentConfig = { multiPrinterMode: true, printers: {} };

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
});
