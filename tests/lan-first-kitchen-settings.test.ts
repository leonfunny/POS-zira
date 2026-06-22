import { describe, expect, it } from 'vitest';
import type { SalonPrinterMapping } from '../src/shared/types';
import {
  buildLanFirstKitchenSenderConfig,
  DEFAULT_LAN_FIRST_KITCHEN_TIMEOUT_MS,
  getReadyKitchenWifiPrinters,
  planLanKitchenSave,
  resolveLanFirstKitchenTimeoutMs,
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
  it('uses the production-safe LAN-first timeout floor for slow thermal prints', () => {
    expect(DEFAULT_LAN_FIRST_KITCHEN_TIMEOUT_MS).toBe(6000);
    expect(resolveLanFirstKitchenTimeoutMs(2000)).toBe(6000);
    expect(resolveLanFirstKitchenTimeoutMs(6000)).toBe(6000);
    expect(resolveLanFirstKitchenTimeoutMs(10000)).toBe(10000);
  });

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
        timeoutMs: 6000,
        targets: {
          'old-machine:old-printer': { host: '192.168.1.10', port: 17892 },
          'machine-pos-2:kitchen-printer-1': { host: '192.168.1.50', port: 17892, timeoutMs: 6000 },
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

describe('LAN_FIRST kitchen manual host + save plan', () => {
  it('builds a manual host/IP sender target without a backend kitchen printer', () => {
    const result = buildLanFirstKitchenSenderConfig({
      current: { enabled: false, timeoutMs: 2000, targets: {} },
      enabled: true,
      selectedPrinterId: '',
      host: ' 192.168.1.77 ',
      port: '17892',
      printers: [],
    });
    expect(result).toEqual({
      ok: true,
      targetKey: 'manual',
      config: {
        enabled: true,
        timeoutMs: 6000,
        targets: {},
        manualTarget: { host: '192.168.1.77', port: 17892 },
      },
    });
  });

  it('rejects a sender target with neither a ready printer nor a host', () => {
    const result = buildLanFirstKitchenSenderConfig({
      current: {},
      enabled: true,
      selectedPrinterId: '',
      host: '   ',
      port: '17892',
      printers: [],
    });
    expect(result).toEqual({ ok: false, error: 'Select a kitchen printer or enter a host/IP' });
  });

  it('keeps both pairing codes even when the sender target cannot be built', () => {
    const plan = planLanKitchenSave({
      receiveEnabled: true,
      receivePort: '17892',
      senderEnabled: true,
      selectedPrinterId: '',
      host: '',
      port: '17892',
      printers: [],
      receiverPairingCode: ' 123456 ',
      senderPairingCode: '123456',
      currentSender: { enabled: false, timeoutMs: 2000, targets: {} },
    });
    expect(plan.receiverCode).toBe('123456');
    expect(plan.senderCode).toBe('123456');
    expect(plan.receiverPatch).toEqual({ enabled: true, port: 17892, auth: { allowUnauthenticated: false } });
    expect(plan.senderPatch.enabled).toBe(true);
    expect(plan.warnings.length).toBe(1);
  });

  it('plans a manual sender target and trims empty codes to null', () => {
    const plan = planLanKitchenSave({
      receiveEnabled: false,
      receivePort: '17892',
      senderEnabled: true,
      selectedPrinterId: '',
      host: '10.0.0.5',
      port: '17892',
      printers: [],
      receiverPairingCode: '',
      senderPairingCode: '   ',
      currentSender: null,
    });
    expect(plan.receiverCode).toBeNull();
    expect(plan.senderCode).toBeNull();
    expect(plan.warnings).toEqual([]);
    expect(plan.senderPatch.manualTarget).toEqual({ host: '10.0.0.5', port: 17892 });
    expect(plan.senderPatch.enabled).toBe(true);
  });

  it('disabling the sender preserves existing targets and clears enabled', () => {
    const plan = planLanKitchenSave({
      receiveEnabled: false,
      receivePort: '17892',
      senderEnabled: false,
      selectedPrinterId: '',
      host: '',
      port: '17892',
      printers: [],
      receiverPairingCode: '',
      senderPairingCode: '',
      currentSender: { enabled: true, timeoutMs: 2000, targets: { 'm:p': { host: '1.2.3.4', port: 17892 } } },
    });
    expect(plan.senderPatch.enabled).toBe(false);
    expect(plan.senderPatch.targets).toEqual({ 'm:p': { host: '1.2.3.4', port: 17892 } });
    expect(plan.warnings).toEqual([]);
  });
});
