import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrinterType, type AgentConfig, type PrinterConfig } from '../src/shared/types';

const setConfigMock = vi.fn();
let currentConfig: Partial<AgentConfig>;

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: { getVersion: vi.fn(() => 'test'), getPath: vi.fn(() => 'C:\\tmp') },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/config/store', () => ({
  getConfig: () => currentConfig,
  getConfigValue: (key: keyof AgentConfig) => currentConfig[key],
  setConfig: setConfigMock,
}));

describe('HardwareModule POSNET config persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentConfig = {
      multiPrinterMode: true,
      printers: {
        RECEIPT: {
          enabled: true,
          protocol: 'POSNET',
          port: 'COM6',
          baudRate: 9600,
        },
      },
    };
  });

  it('persists probed POSNET baud rate to printers.RECEIPT.baudRate even when the port did not change', async () => {
    const { HardwareModule } = await import('../src/main/modules/hardware.module');
    const { PosnetDriver } = await import('../src/main/hardware/posnet/posnet-driver');

    const module = new HardwareModule({ set: vi.fn(), getOptional: vi.fn() } as any);
    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    (driver as any).baudRate = 19200;

    const originalConfig: PrinterConfig = {
      enabled: true,
      protocol: 'POSNET',
      port: 'COM6',
      baudRate: 9600,
    };

    const changed = (module as any).persistDriverPortMigration(PrinterType.RECEIPT, driver, originalConfig);

    expect(changed).toBe(true);
    expect(setConfigMock).toHaveBeenCalledWith({
      multiPrinterMode: true,
      printers: {
        RECEIPT: expect.objectContaining({
          port: 'COM6',
          baudRate: 19200,
        }),
      },
    });
  });
});
