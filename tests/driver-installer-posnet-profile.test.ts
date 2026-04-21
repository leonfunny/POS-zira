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
  it('keeps POSNET as the supported protocol but requires manual protocol verification for Thermal XL', () => {
    const thermalXl = device({ pid: '100B', model: 'Thermal XL' });

    expect(classifyPrinterCategory(thermalXl)).toEqual({ targetType: 'RECEIPT', protocol: 'POSNET' });
    expect(requiresManualPosnetProtocolSelection(thermalXl)).toBe(true);
  });

  it('does not mark known POSNET v2 Temo HS devices as manual-only', () => {
    const temoHs = device({ pid: '1015', model: 'Temo HS' });

    expect(classifyPrinterCategory(temoHs)).toEqual({ targetType: 'RECEIPT', protocol: 'POSNET' });
    expect(requiresManualPosnetProtocolSelection(temoHs)).toBe(false);
  });
});
