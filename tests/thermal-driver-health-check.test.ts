import { beforeEach, describe, expect, it, vi } from 'vitest';

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
});
