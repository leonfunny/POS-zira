import { describe, expect, it } from 'vitest';
import type { SalonPrinterMapping } from '../src/shared/types';
import {
  buildLanFirstKitchenSenderConfig,
  getReadyKitchenWifiPrinters,
} from '../src/shared/lan-first-kitchen-settings';

const readyKitchenPrinter = {
  id: 'kitchen-printer-1',
  machineId: 'machine-pos-2',
  printerType: 'KITCHEN',
  displayName: 'Kitchen Epson',
  windowsPrinterName: 'Epson TM',
  isEnabled: true,
  isOnline: true,
  agentIsOnline: true,
} as SalonPrinterMapping;

describe('LAN_FIRST kitchen Settings helpers', () => {
  it('lists only ready KITCHEN printers as Wi-Fi direct sender targets', () => {
    const rows = getReadyKitchenWifiPrinters([
      readyKitchenPrinter,
      { ...readyKitchenPrinter, id: 'receipt-1', printerType: 'RECEIPT' },
      { ...readyKitchenPrinter, id: 'offline-1', isOnline: false },
      { ...readyKitchenPrinter, id: 'disabled-1', isEnabled: false },
      { ...readyKitchenPrinter, id: 'no-target-1', windowsPrinterName: '', address: '' },
      { ...readyKitchenPrinter, id: 'no-machine-1', machineId: '' },
    ] as SalonPrinterMapping[]);

    expect(rows.map((printer) => printer.id)).toEqual(['kitchen-printer-1']);
  });

  it('maps the selected kitchen printer to a machineId:printerId LAN target key', () => {
    const result = buildLanFirstKitchenSenderConfig({
      current: {
        enabled: false,
        timeoutMs: 2000,
        targets: {
          'old-machine:old-printer': { host: '192.168.1.10', port: 17892 },
        },
      },
      enabled: true,
      selectedPrinterId: 'kitchen-printer-1',
      host: ' 192.168.1.50 ',
      port: '17892',
      timeoutMs: 2500,
      printers: [readyKitchenPrinter],
    });

    expect(result).toEqual({
      ok: true,
      targetKey: 'machine-pos-2:kitchen-printer-1',
      config: {
        enabled: true,
        timeoutMs: 2500,
        targets: {
          'old-machine:old-printer': { host: '192.168.1.10', port: 17892 },
          'machine-pos-2:kitchen-printer-1': { host: '192.168.1.50', port: 17892, timeoutMs: 2500 },
        },
      },
    });
  });

  it('rejects a selected kitchen printer without machineId before saving sender target config', () => {
    const result = buildLanFirstKitchenSenderConfig({
      current: {},
      enabled: true,
      selectedPrinterId: 'kitchen-printer-1',
      host: '192.168.1.50',
      port: '17892',
      printers: [{ ...readyKitchenPrinter, machineId: '' }],
    });

    expect(result).toEqual({
      ok: false,
      error: 'Selected kitchen printer is missing machineId',
    });
  });
});
