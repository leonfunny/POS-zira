import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'C:\\print-agent-master',
  },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/hardware/port-utils', () => ({
  listSerialPorts: vi.fn(),
}));

import {
  classifyPrinterCategory,
  requiresManualPosnetProtocolSelection,
  type DetectedDevice,
} from '../src/main/hardware/driver-installer';
import { ALLOWED_PROTOCOLS_BY_TYPE } from '../src/shared/types';

function device(overrides: Partial<DetectedDevice>): DetectedDevice {
  return {
    vid: '1424',
    pid: '100B',
    brand: 'POSNET',
    model: 'POSNET Thermal Serial Port',
    windowsPrinterName: null,
    comPort: 'COM6',
    portName: 'COM6',
    connectionType: 'SERIAL',
    driverInstalled: true,
    ...overrides,
  };
}

describe('POSNET Thermal profile routing', () => {
  it('routes every detected POSNET device to the FISCAL slot with POSNET protocol', () => {
    expect(classifyPrinterCategory(device({ brand: 'POSNET', vid: '9999', pid: '1015', model: 'Temo HS' })))
      .toEqual({ targetType: 'FISCAL', protocol: 'POSNET' });
    expect(classifyPrinterCategory(device({ brand: 'Unknown', vid: '1424', pid: '1015', model: 'USB Serial Device' })))
      .toEqual({ targetType: 'FISCAL', protocol: 'POSNET' });
  });

  it('requires manual printer-side POSNET protocol verification for ambiguous Thermal HD and XL models', () => {
    const thermalHd = device({ pid: '100A', model: 'Thermal HD' });
    const thermalXl = device({ pid: '100B', model: 'Thermal XL' });
    const thermalXlByName = device({ pid: '9999', model: 'Posnet Thermal XL Fiscal Printer' });

    expect(classifyPrinterCategory(thermalHd)).toEqual({ targetType: 'FISCAL', protocol: 'POSNET' });
    expect(requiresManualPosnetProtocolSelection(thermalHd)).toBe(true);
    expect(classifyPrinterCategory(thermalXl)).toEqual({ targetType: 'FISCAL', protocol: 'POSNET' });
    expect(requiresManualPosnetProtocolSelection(thermalXl)).toBe(true);
    expect(classifyPrinterCategory(thermalXlByName)).toEqual({ targetType: 'FISCAL', protocol: 'POSNET' });
    expect(requiresManualPosnetProtocolSelection(thermalXlByName)).toBe(true);
  });

  it('does not require manual protocol verification for known POSNET v2 Temo HS devices', () => {
    const temoHs = device({ pid: '1015', model: 'Temo HS' });

    expect(classifyPrinterCategory(temoHs)).toEqual({ targetType: 'FISCAL', protocol: 'POSNET' });
    expect(requiresManualPosnetProtocolSelection(temoHs)).toBe(false);
  });

  it('keeps RECEIPT and FISCAL protocol slots separated by the fiscal ADR contract', () => {
    expect(ALLOWED_PROTOCOLS_BY_TYPE.RECEIPT).not.toContain('POSNET');
    expect(ALLOWED_PROTOCOLS_BY_TYPE.RECEIPT).toContain('THERMAL');
    expect(ALLOWED_PROTOCOLS_BY_TYPE.FISCAL).toEqual(['POSNET']);
  });

  it('keeps non-POSNET thermal serial printers on RECEIPT with THERMAL protocol', () => {
    const serialThermal = device({
      vid: '0000',
      pid: '0000',
      brand: 'Generic Serial',
      model: 'Generic Thermal Receipt Printer',
      comPort: 'COM7',
      portName: 'COM7',
    });

    expect(classifyPrinterCategory(serialThermal)).toEqual({ targetType: 'RECEIPT', protocol: 'THERMAL' });
    expect(requiresManualPosnetProtocolSelection(serialThermal)).toBe(false);
  });

  it('keeps Zebra devices classified as label printers', () => {
    const zebra = device({
      vid: '0A5F',
      pid: '0164',
      brand: 'Zebra',
      model: 'ZDesigner GK420d',
      windowsPrinterName: 'ZDesigner GK420d',
      comPort: null,
      portName: 'USB001',
      connectionType: 'USB',
    });

    expect(classifyPrinterCategory(zebra)).toEqual({ targetType: 'LABEL', protocol: 'ZEBRA' });
    expect(requiresManualPosnetProtocolSelection(zebra)).toBe(false);
  });
});
