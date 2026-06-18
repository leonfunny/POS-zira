import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PrintJobType,
  PrinterType,
  type AgentConfig,
  type KitchenTicketData,
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
  posnetConnects: false,
  posnetInstances: [] as any[],
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

vi.mock('../src/main/hardware/pdf/pdf-printer', () => ({
  printLabelToDevice: vi.fn(),
  printInfoLabelToDevice: vi.fn(),
  cleanupOldLabels: vi.fn(),
}));

describe('HardwareModule print job runtime guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.thermalInstances.length = 0;
    mock.posnetInstances.length = 0;
    mock.posnetConnects = false;
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
});
