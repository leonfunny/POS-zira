/**
 * HardwareModule — auto-detect ESC/POS vs Out-Printer text mode.
 *
 * The legacy behaviour was: protocol=WINDOWS → ThermalDriver constructed
 * with windowsTextMode=true unconditionally → printTest goes through
 * PowerShell `Out-Printer` plain text → spooler renders using the
 * Windows printer driver's default paper size (often A4) → on a real
 * thermal receipt printer (Xprinter / Epson TM-Tx / etc.) the test
 * print comes out misaligned even though the receipt print itself
 * (which always uses raw ESC/POS bytes) prints correctly.
 *
 * Fix: derive windowsTextMode from paperWidth. Real thermal POS receipt
 * paper is 58/76/80mm; A4 = 210mm and Letter = 216mm — there is no
 * grey zone. paperWidth ≤ 80 → ESC/POS (windowsTextMode=false). This
 * lets the user change protocol/printer freely without re-toggling a
 * flag they don't understand. THERMAL protocol stays explicit ESC/POS
 * even at large paperWidth (it's the user's opt-in for raw bytes).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PrinterType,
  type AgentConfig,
  type PrinterConfig,
} from '../src/shared/types';

const ctorSpy = vi.fn();
const setConfigMock = vi.fn((patch: Partial<AgentConfig>) => {
  currentConfig = { ...currentConfig, ...patch };
});
let currentConfig: Partial<AgentConfig> = {};

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

vi.mock('../src/main/database/repos/local-printer-repo', () => ({
  localPrinterRepo: {
    getEnabled: vi.fn(() => []),
    markOnline: vi.fn(),
    markUsed: vi.fn(),
    getById: vi.fn(),
  },
  rowToPrinterConfig: vi.fn(),
}));

vi.mock('../src/main/hardware/thermal/thermal-driver', () => {
  class ThermalDriver {
    constructor(...args: unknown[]) {
      ctorSpy(...args);
    }
    connect = vi.fn();
    disconnect = vi.fn();
    printTest = vi.fn();
    printReceipt = vi.fn();
    isConnected = () => true;
  }
  return { ThermalDriver };
});

vi.mock('../src/main/hardware/zebra/zebra-driver', () => {
  class ZebraDriver {
    constructor() {}
  }
  return { ZebraDriver };
});

vi.mock('../src/main/hardware/posnet/posnet-driver', () => {
  class PosnetDriver {
    constructor() {}
  }
  return { PosnetDriver };
});

async function build(
  config: PrinterConfig,
  type: PrinterType = PrinterType.RECEIPT,
) {
  const { HardwareModule } = await import(
    '../src/main/modules/hardware.module'
  );
  const module = new HardwareModule({
    set: vi.fn(),
    getOptional: vi.fn(),
  } as any);
  return (module as any).createPrinterFromConfig(config, type);
}

async function autoSetupWindowsPrinter(
  type: PrinterType,
  protocol: PrinterConfig['protocol'],
  config: Partial<AgentConfig>,
) {
  currentConfig = config;
  const { HardwareModule } = await import(
    '../src/main/modules/hardware.module'
  );
  const module = new HardwareModule({
    set: vi.fn(),
    getOptional: vi.fn(),
  } as any);
  return (module as any).autoSetupWindowsPrinter(type, protocol, {
    vid: '0000',
    brand: 'Xprinter',
    model: 'XP-80T',
    windowsPrinterName: 'Xprinter XP-80T',
    comPort: null,
    portName: 'USB001',
    connectionType: 'USB',
    driverInstalled: true,
  });
}

// 6th positional arg of ThermalDriver constructor is windowsTextMode.
function lastTextMode(): boolean {
  expect(
    ctorSpy.mock.calls.length,
    'ThermalDriver constructor was not called',
  ).toBeGreaterThan(0);
  const args = ctorSpy.mock.calls[ctorSpy.mock.calls.length - 1];
  return args[5] as boolean;
}

describe('HardwareModule — auto-detect windowsTextMode by paperWidth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctorSpy.mockReset();
    setConfigMock.mockClear();
    currentConfig = {};
  });

  describe('protocol=WINDOWS on a real thermal receipt printer', () => {
    it('paperWidth=80 (Xprinter XP-80T) → ESC/POS, not Out-Printer text', async () => {
      await build({
        enabled: true,
        protocol: 'WINDOWS',
        windowsPrinter: 'Xprinter XP-80T',
        paperWidth: 80,
        charsPerLine: 48,
      } as PrinterConfig);
      expect(lastTextMode()).toBe(false);
    });

    it('paperWidth=58 (kiosk / handheld) → ESC/POS', async () => {
      await build({
        enabled: true,
        protocol: 'WINDOWS',
        windowsPrinter: 'Generic 58mm',
        paperWidth: 58,
        charsPerLine: 32,
      } as PrinterConfig);
      expect(lastTextMode()).toBe(false);
    });

    it('paperWidth=76 (Epson TM-U220 / dot-matrix kitchen ticket) → ESC/POS', async () => {
      await build({
        enabled: true,
        protocol: 'WINDOWS',
        windowsPrinter: 'Epson TM-U220',
        paperWidth: 76,
        charsPerLine: 42,
      } as PrinterConfig);
      expect(lastTextMode()).toBe(false);
    });

    it('paperWidth omitted → falls back to 80mm default → ESC/POS', async () => {
      await build({
        enabled: true,
        protocol: 'WINDOWS',
        windowsPrinter: 'Xprinter XP-80T',
      } as PrinterConfig);
      expect(lastTextMode()).toBe(false);
    });
  });

  describe('protocol=WINDOWS on a true office printer (A4 slot)', () => {
    it('paperWidth=210 (A4 laser) → Out-Printer text mode', async () => {
      await build(
        {
          enabled: true,
          protocol: 'WINDOWS',
          windowsPrinter: 'HP LaserJet Pro M404',
          paperWidth: 210,
        } as PrinterConfig,
        PrinterType.A4,
      );
      expect(lastTextMode()).toBe(true);
    });

    it('paperWidth=216 (US Letter) → Out-Printer text mode', async () => {
      await build(
        {
          enabled: true,
          protocol: 'WINDOWS',
          windowsPrinter: 'Canon imageCLASS',
          paperWidth: 216,
        } as PrinterConfig,
        PrinterType.A4,
      );
      expect(lastTextMode()).toBe(true);
    });

    it('paperWidth=82 (just above thermal threshold) → Out-Printer text mode', async () => {
      // 81-82mm is the boundary: real thermal stops at 80, anything above
      // is non-thermal hardware and should not receive ESC/POS bytes.
      await build(
        {
          enabled: true,
          protocol: 'WINDOWS',
          windowsPrinter: 'Some inkjet',
          paperWidth: 82,
        } as PrinterConfig,
        PrinterType.A4,
      );
      expect(lastTextMode()).toBe(true);
    });
  });

  describe('protocol=THERMAL is unaffected (always ESC/POS)', () => {
    it('THERMAL + paperWidth=80 → ESC/POS', async () => {
      await build({
        enabled: true,
        protocol: 'THERMAL',
        windowsPrinter: 'Xprinter XP-80T',
        paperWidth: 80,
      } as PrinterConfig);
      expect(lastTextMode()).toBe(false);
    });

    it('THERMAL + paperWidth=210 still ESC/POS — explicit user opt-in', async () => {
      // THERMAL protocol means "user is sure this is ESC/POS" — do not
      // override based on paperWidth even if it looks office-printer-ish.
      await build({
        enabled: true,
        protocol: 'THERMAL',
        windowsPrinter: 'Wide industrial ESC/POS',
        paperWidth: 210,
      } as PrinterConfig);
      expect(lastTextMode()).toBe(false);
    });
  });

  describe('auto-setup defaults for receipt-like WINDOWS printers', () => {
    it('seeds missing paper settings for a WINDOWS receipt printer without changing protocol', async () => {
      await autoSetupWindowsPrinter(PrinterType.RECEIPT, 'WINDOWS', {
        printers: {},
      });

      const configPatch = setConfigMock.mock.calls.find(
        ([patch]) => !!patch.printers?.RECEIPT,
      )?.[0];
      expect(configPatch?.printers?.RECEIPT).toMatchObject({
        protocol: 'WINDOWS',
        windowsPrinter: 'Xprinter XP-80T',
        paperWidth: 80,
        charsPerLine: 48,
      });
    });

    it('preserves existing paper settings when auto-setup updates a receipt-like slot', async () => {
      await autoSetupWindowsPrinter(PrinterType.KITCHEN, 'WINDOWS', {
        printers: {
          KITCHEN: {
            enabled: true,
            protocol: 'WINDOWS',
            paperWidth: 58,
            charsPerLine: 32,
          },
        },
      });

      const configPatch = setConfigMock.mock.calls.find(
        ([patch]) => !!patch.printers?.KITCHEN,
      )?.[0];
      expect(configPatch?.printers?.KITCHEN).toMatchObject({
        protocol: 'WINDOWS',
        paperWidth: 58,
        charsPerLine: 32,
      });
    });

    it('does not seed receipt paper settings for A4 office printers', async () => {
      await autoSetupWindowsPrinter(PrinterType.A4, 'WINDOWS', {
        printers: {},
      });

      const configPatch = setConfigMock.mock.calls.find(
        ([patch]) => !!patch.printers?.A4,
      )?.[0];
      expect(configPatch?.printers?.A4).toMatchObject({
        protocol: 'WINDOWS',
        windowsPrinter: 'Xprinter XP-80T',
      });
      expect(configPatch?.printers?.A4?.paperWidth).toBeUndefined();
      expect(configPatch?.printers?.A4?.charsPerLine).toBeUndefined();
    });
  });
});
