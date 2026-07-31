import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowsThermalWorkerError } from '../src/main/hardware/thermal/windows-thermal-worker';
import type { ReceiptData } from '../src/shared/types';

const portUtils = vi.hoisted(() => ({
  listWindowsPrinters: vi.fn(async () => [] as string[]),
  listSerialPorts: vi.fn(async () => [] as string[]),
  sanitizePrinterName: vi.fn((name: string) => name),
  probeEscPosPort: vi.fn(async () => false),
  isWindowsPrinterPresent: vi.fn(async () => false),
  flushStuckPrintJobs: vi.fn(async () => 0),
  getStuckPrintJobStatus: vi.fn(async () => null),
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/hardware/port-utils', () => portUtils);

describe('ThermalDriver health checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    portUtils.isWindowsPrinterPresent.mockResolvedValue(false);
  });

  it('keeps a USB thermal printer online when the cached detector omits it but direct Windows presence succeeds', async () => {
    const { ThermalDriver } = await import('../src/main/hardware/thermal/thermal-driver');
    const driver = new ThermalDriver('Xprinter XP-80T', 9600, 'USB', 80, 48);
    (driver as any).connected = true;
    portUtils.isWindowsPrinterPresent.mockResolvedValue(true);

    const healthy = await driver.healthCheck([], []);

    expect(portUtils.isWindowsPrinterPresent).toHaveBeenCalledWith('Xprinter XP-80T');
    expect(healthy).toBe(true);
    expect(driver.isConnected()).toBe(true);
  });

  it('keeps the slow PowerShell presence probe off the receipt path when the persistent worker is available', async () => {
    const { ThermalDriver } = await import('../src/main/hardware/thermal/thermal-driver');
    const driver = new ThermalDriver('Xprinter XP-80T', 9600, 'USB', 80, 48);
    const printRaw = vi.fn(async (
      _printerName: string,
      data: Buffer,
      _documentName: string,
      _expectedUsbVids: readonly string[],
    ) => ({
      jobId: 101,
      bytesWritten: data.length,
      spoolMs: 7,
      preflightMs: 3,
      presenceProbeMs: 1,
      presenceReason: 'USBPRINT_PORT_PRESENT',
      portName: 'USB002',
      reconcileMs: 25,
      printerStatus: 0,
      printerStatusText: 'READY',
      jobStatus: 0x80,
      jobStatusText: 'PRINTED',
    }));
    (driver as any).connected = true;
    (driver as any).lastPresenceCheckAt = 0;
    (driver as any).getWindowsWorker = () => ({ printRaw });

    await driver.printReceipt(buildAsciiReceipt());

    expect(portUtils.isWindowsPrinterPresent).not.toHaveBeenCalled();
    expect(printRaw).toHaveBeenCalledWith(
      'Xprinter XP-80T',
      expect.any(Buffer),
      'Zira AI Receipt',
      ['1FC9'],
    );
  });

  it('retains the PowerShell unplug guard only on a proven-safe worker startup fallback', async () => {
    const { ThermalDriver } = await import('../src/main/hardware/thermal/thermal-driver');
    const driver = new ThermalDriver('Xprinter XP-80T', 9600, 'USB', 80, 48);
    const startupError = new WindowsThermalWorkerError({
      message: 'worker did not start',
      code: 'WORKER_READY_TIMEOUT',
      stage: 'STARTUP',
      failureClass: 'SAFE_BEFORE_PRINT',
      action: 'ping',
    });
    (driver as any).connected = true;
    (driver as any).lastPresenceCheckAt = 0;
    (driver as any).getWindowsWorker = () => ({
      printRaw: vi.fn(async () => { throw startupError; }),
    });
    portUtils.isWindowsPrinterPresent.mockResolvedValue(false);

    const error = await driver.printReceipt(buildAsciiReceipt()).catch((caught) => caught);

    expect(portUtils.isWindowsPrinterPresent).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: 'PRINTER_NOT_PRESENT',
      stage: 'DRIVER_PREFLIGHT',
      failureClass: 'SAFE_BEFORE_PRINT',
    });
  });

  it('drops the local route immediately when native SetupAPI proves silent USB unplug', async () => {
    const { ThermalDriver } = await import('../src/main/hardware/thermal/thermal-driver');
    const driver = new ThermalDriver('Xprinter XP-80T', 9600, 'USB', 80, 48);
    const unplugged = new WindowsThermalWorkerError({
      message: 'USB device not present',
      code: 'PRINTER_NOT_PRESENT',
      stage: 'PHYSICAL_PRESENCE_PREFLIGHT',
      failureClass: 'SAFE_BEFORE_PRINT',
      action: 'print',
    });
    (driver as any).connected = true;
    (driver as any).getWindowsWorker = () => ({
      printRaw: vi.fn(async () => { throw unplugged; }),
    });

    const error = await driver.printReceipt(buildAsciiReceipt()).catch((caught) => caught);

    expect(error).toBe(unplugged);
    expect(driver.isConnected()).toBe(false);
    expect(portUtils.isWindowsPrinterPresent).not.toHaveBeenCalled();
  });
});

function buildAsciiReceipt(): ReceiptData {
  return {
    orderNumber: 'POS-20260729-0001',
    salonName: 'CHE SAI GON',
    sellerName: 'CHE SAI GON Sp. z o.o.',
    sellerAddress: 'ul. Marszalkowska 1',
    sellerNip: '5220052349',
    items: [
      { name: 'Bun', quantity: 1, unitPrice: 1200, totalPrice: 1200, vatRate: 5 },
    ],
    payment: { method: 'CASH', amount: 1200 },
    subtotal: 1200,
    total: 1200,
    cashierName: 'Anna',
  };
}
