import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../src/shared/types';

let currentConfig: Partial<AgentConfig>;
const setConfigMock = vi.fn();

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\tmp') },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/config/store', () => ({
  getConfig: () => currentConfig,
  setConfig: (patch: Partial<AgentConfig>) => {
    setConfigMock(patch);
    currentConfig = { ...currentConfig, ...patch };
  },
}));

describe('ensureReceiptPrinterEnabledOnBoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentConfig = {};
  });

  it('flips printers.RECEIPT.enabled from false to true', async () => {
    currentConfig = {
      multiPrinterMode: true,
      printers: {
        RECEIPT: { enabled: false, protocol: 'THERMAL', windowsPrinter: 'Xprinter' },
      },
    };

    const { ensureReceiptPrinterEnabledOnBoot } = await import(
      '../src/main/config/ensure-receipt-enabled'
    );
    ensureReceiptPrinterEnabledOnBoot();

    expect(setConfigMock).toHaveBeenCalledTimes(1);
    expect(currentConfig.printers?.RECEIPT?.enabled).toBe(true);
    // Other fields preserved
    expect(currentConfig.printers?.RECEIPT?.protocol).toBe('THERMAL');
    expect(currentConfig.printers?.RECEIPT?.windowsPrinter).toBe('Xprinter');
  });

  it('flips legacy receiptPrinter.enabled from false to true', async () => {
    currentConfig = {
      receiptPrinter: { enabled: false, protocol: 'THERMAL', port: 'COM3', baudRate: 9600 },
    };

    const { ensureReceiptPrinterEnabledOnBoot } = await import(
      '../src/main/config/ensure-receipt-enabled'
    );
    ensureReceiptPrinterEnabledOnBoot();

    expect(setConfigMock).toHaveBeenCalledTimes(1);
    expect(currentConfig.receiptPrinter?.enabled).toBe(true);
    expect(currentConfig.receiptPrinter?.port).toBe('COM3');
  });

  it('handles both multi-printer and legacy slots in one boot', async () => {
    currentConfig = {
      multiPrinterMode: true,
      printers: {
        RECEIPT: { enabled: false, protocol: 'THERMAL' },
      },
      receiptPrinter: { enabled: false, protocol: 'THERMAL' },
    };

    const { ensureReceiptPrinterEnabledOnBoot } = await import(
      '../src/main/config/ensure-receipt-enabled'
    );
    ensureReceiptPrinterEnabledOnBoot();

    expect(setConfigMock).toHaveBeenCalledTimes(1);
    const patch = setConfigMock.mock.calls[0][0];
    expect(patch.printers.RECEIPT.enabled).toBe(true);
    expect(patch.receiptPrinter.enabled).toBe(true);
  });

  it('is a no-op when receipt printer is already enabled', async () => {
    currentConfig = {
      multiPrinterMode: true,
      printers: {
        RECEIPT: { enabled: true, protocol: 'THERMAL' },
      },
    };

    const { ensureReceiptPrinterEnabledOnBoot } = await import(
      '../src/main/config/ensure-receipt-enabled'
    );
    ensureReceiptPrinterEnabledOnBoot();

    expect(setConfigMock).not.toHaveBeenCalled();
  });

  it('does NOT invent a receipt config on a fresh install', async () => {
    currentConfig = {
      // No printers, no receiptPrinter — fresh install / never configured
    };

    const { ensureReceiptPrinterEnabledOnBoot } = await import(
      '../src/main/config/ensure-receipt-enabled'
    );
    ensureReceiptPrinterEnabledOnBoot();

    expect(setConfigMock).not.toHaveBeenCalled();
    expect(currentConfig.printers).toBeUndefined();
    expect(currentConfig.receiptPrinter).toBeUndefined();
  });

  it('does not touch other printer types', async () => {
    currentConfig = {
      multiPrinterMode: true,
      printers: {
        RECEIPT: { enabled: false, protocol: 'THERMAL' },
        FISCAL: { enabled: false, protocol: 'POSNET' },
        LABEL: { enabled: true, protocol: 'ZEBRA' },
      },
    };

    const { ensureReceiptPrinterEnabledOnBoot } = await import(
      '../src/main/config/ensure-receipt-enabled'
    );
    ensureReceiptPrinterEnabledOnBoot();

    expect(currentConfig.printers?.RECEIPT?.enabled).toBe(true);
    expect(currentConfig.printers?.FISCAL?.enabled).toBe(false);
    expect(currentConfig.printers?.LABEL?.enabled).toBe(true);
  });

  it('is idempotent — calling twice in the same boot is safe', async () => {
    currentConfig = {
      multiPrinterMode: true,
      printers: {
        RECEIPT: { enabled: false, protocol: 'THERMAL' },
      },
    };

    const { ensureReceiptPrinterEnabledOnBoot } = await import(
      '../src/main/config/ensure-receipt-enabled'
    );
    ensureReceiptPrinterEnabledOnBoot();
    ensureReceiptPrinterEnabledOnBoot();

    // First call writes, second is a no-op
    expect(setConfigMock).toHaveBeenCalledTimes(1);
    expect(currentConfig.printers?.RECEIPT?.enabled).toBe(true);
  });
});
