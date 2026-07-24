/**
 * Unit tests for PosnetDriver connection state, port mutex, and health check logic.
 * These tests focus on state transitions and mutex behavior without requiring
 * real serial ports or PowerShell execution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/zira-posnet-test', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/hardware/port-utils', () => ({
  listSerialPorts: vi.fn(),
  sanitizePortName: vi.fn((p: string) => p),
}));

vi.mock('../src/main/hardware/posnet/port-mutex', () => ({
  withPortLock: vi.fn(),
  isPortBusy: vi.fn(() => false),
}));

vi.mock('../src/main/hardware/posnet/probe-profiles', () => ({
  POSNET_PRODUCT_IDS: { 0x100B: 'Thermal XL' },
  POSNET_USB_VID: '1424',
}));

// Stub child_process entirely — we don't test PowerShell execution in unit tests
vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('util', () => ({
  promisify: () => vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

import { withPortLock } from '../src/main/hardware/posnet/port-mutex';
import { listSerialPorts } from '../src/main/hardware/port-utils';
import { buildPosnetFiscalFrames, PosnetDriver } from '../src/main/hardware/posnet/posnet-driver';

const mockWithPortLock = vi.mocked(withPortLock);
const mockListSerialPorts = vi.mocked(listSerialPorts);

describe('PosnetDriver connection state model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts in disconnected state', () => {
    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    expect(driver.getConnectionState()).toBe('disconnected');
    expect(driver.isConnected()).toBe(false);
  });

  it('isConnected() only true when protocol_ready', () => {
    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    // Simulate states directly
    (driver as any).connectionState = 'physical_present';
    expect(driver.isConnected()).toBe(false);

    (driver as any).connectionState = 'protocol_ready';
    expect(driver.isConnected()).toBe(true);

    (driver as any).connectionState = 'disconnected';
    expect(driver.isConnected()).toBe(false);
  });

  it('health check: port disappears → disconnected', async () => {
    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    (driver as any).connectionState = 'protocol_ready';

    await driver.healthCheck(['COM3', 'COM4']); // COM6 not in list

    expect(driver.getConnectionState()).toBe('disconnected');
    expect(driver.isConnected()).toBe(false);
  });

  it('health check: port reappears → physical_present only (not connected)', async () => {
    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    expect(driver.getConnectionState()).toBe('disconnected');

    await driver.healthCheck(['COM6']);

    expect(driver.getConnectionState()).toBe('physical_present');
    expect(driver.isConnected()).toBe(false);
  });

  it('health check: protocol_ready stays protocol_ready when port still present', async () => {
    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    (driver as any).connectionState = 'protocol_ready';

    await driver.healthCheck(['COM6']);

    expect(driver.getConnectionState()).toBe('protocol_ready');
    expect(driver.isConnected()).toBe(true);
  });

  it('disconnect() resets to disconnected', () => {
    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    (driver as any).connectionState = 'protocol_ready';
    driver.disconnect();
    expect(driver.getConnectionState()).toBe('disconnected');
    expect(driver.isConnected()).toBe(false);
  });

  it('reconnect() marks physical presence only until protocol is verified', () => {
    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    driver.reconnect('COM7');
    expect(driver.getConnectionState()).toBe('physical_present');
    expect(driver.isConnected()).toBe(false);
    expect(driver.getPort()).toBe('COM7');
  });

  it('recoverPort() does not active-probe after no-protocol diagnostic', async () => {
    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    (driver as any).connectionState = 'physical_present';
    (driver as any).lastDiagnostic = { code: 'DEVICE_DETECTED_NO_PROTOCOL_RESPONSE', detail: 'manual action required' };
    const detectSpy = vi.spyOn(PosnetDriver as any, 'detectPosnetPort').mockResolvedValue('COM6');

    await expect(driver.recoverPort()).resolves.toBeNull();
    expect(detectSpy).not.toHaveBeenCalled();
  });
});

describe('PosnetDriver port mutex integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('connect() returns false with PORT_BUSY when lock unavailable', async () => {
    mockWithPortLock.mockResolvedValue({
      ok: false, error: 'PORT_BUSY', message: 'Port COM6 is busy',
    } as any);

    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    const result = await driver.connect();

    expect(result).toBe(false);
    expect(driver.getLastDiagnostic()?.code).toBe('PORT_BUSY');
    expect(driver.isConnected()).toBe(false);
  });

  it('printTest() throws PORT_BUSY when port lock unavailable', async () => {
    mockWithPortLock.mockResolvedValue({
      ok: false, error: 'PORT_BUSY', message: 'Port COM6 is busy',
    } as any);

    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    (driver as any).connectionState = 'protocol_ready';

    await expect(driver.printTest()).rejects.toThrow('Port COM6 is busy');
    expect(driver.getLastDiagnostic()?.code).toBe('PORT_BUSY');
  });

  it('printTest() throws when not connected', async () => {
    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    await expect(driver.printTest()).rejects.toThrow('Printer not connected');
  });

  it('printReceipt() uses stored line total for decimal weighted lines', async () => {
    const fiscalJournal = {
      findBlockingAttempt: vi.fn(() => null),
      findReconcilableAttempt: vi.fn(),
      resolveReconcilable: vi.fn(),
      getNextAttemptNo: vi.fn(() => 1),
      createPending: vi.fn(() => ({ id: 'attempt-weighted-1' })),
      markSent: vi.fn(),
      markSuccess: vi.fn(),
      markFailed: vi.fn(),
      markUnknown: vi.fn(),
      markBlocked: vi.fn(),
    };
    const driver = new PosnetDriver('COM6', 9600, 'POSNET', {
      fiscalJournal: fiscalJournal as any,
      isRealFiscalPrintEnabled: () => true,
    });
    (driver as any).connectionState = 'protocol_ready';
    const sendSpy = vi.spyOn(driver as any, 'sendPosnetSequence').mockResolvedValue([]);

    await driver.printReceipt({
      orderId: 'order-weight-1',
      orderNumber: 'POS-W1',
      items: [
        {
          name: 'Rieng cu',
          quantity: 0.238,
          unit: 'kg',
          unitPrice: 8000,
          totalPrice: 1904,
          vatRate: 5,
        },
      ],
      payment: { method: 'CARD', amount: 1904 },
      subtotal: 1904,
      total: 1904,
    });

    const frames = sendSpy.mock.calls[0][0];
    expect(frames).toContainEqual(['trline', 'naRieng cu', 'vt2', 'pr8000', 'il0.238', 'wa1904']);
    expect(frames).toContainEqual(['trpayment', 'ty2', 'wa1904']);
    expect(frames).toContainEqual(['trend', 'to1904']);
    expect(fiscalJournal.markSent).toHaveBeenCalledWith('attempt-weighted-1');
    expect(fiscalJournal.markSuccess).toHaveBeenCalledWith('attempt-weighted-1', { responses: 'ok' });
  });

  it('blocks a real POSNET receipt before SENT or serial I/O when the production gate is off', async () => {
    const pendingAttempt = { id: 'attempt-1' };
    const fiscalJournal = {
      findBlockingAttempt: vi.fn(() => null),
      findReconcilableAttempt: vi.fn(),
      resolveReconcilable: vi.fn(),
      getNextAttemptNo: vi.fn(() => 1),
      createPending: vi.fn(() => pendingAttempt),
      markSent: vi.fn(),
      markSuccess: vi.fn(),
      markFailed: vi.fn(),
      markUnknown: vi.fn(),
      markBlocked: vi.fn(),
    };
    const driver = new PosnetDriver('COM6', 9600, 'POSNET', {
      fiscalJournal: fiscalJournal as any,
      isRealFiscalPrintEnabled: () => false,
    });
    (driver as any).connectionState = 'protocol_ready';
    const sendSpy = vi.spyOn(driver as any, 'sendPosnetSequence').mockResolvedValue([]);

    await expect(driver.printReceipt({
      orderId: 'order-gated-1',
      orderNumber: 'POS-G1',
      items: [{ name: 'Tea', quantity: 1, unitPrice: 1000, totalPrice: 1000, vatRate: 23 }],
      payment: { method: 'CASH', amount: 1000 },
      subtotal: 1000,
      total: 1000,
    })).rejects.toThrow('REAL_FISCAL_PRINT_DISABLED');

    expect(fiscalJournal.createPending).toHaveBeenCalledTimes(1);
    expect(fiscalJournal.markBlocked).toHaveBeenCalledWith(
      'attempt-1',
      'REAL_FISCAL_PRINT_DISABLED',
      expect.any(Object),
    );
    expect(fiscalJournal.markSent).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('uses only the non-fiscal prninit test path regardless of the real-print gate', async () => {
    const driver = new PosnetDriver('COM6', 9600, 'POSNET', {
      isRealFiscalPrintEnabled: () => false,
    });
    (driver as any).connectionState = 'protocol_ready';
    (driver as any).modelName = 'POSNET Test';
    const sendSpy = vi.spyOn(driver as any, 'sendPosnetSequence').mockResolvedValue([]);

    await expect(driver.printTest()).resolves.toBeUndefined();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0][0]).toEqual(['prninit']);
    expect(sendSpy.mock.calls[0][0]).not.toContainEqual(['trinit', 'bm0']);
  });

  it('blocks POSNET report transaction while the production gate is off', async () => {
    const driver = new PosnetDriver('COM6', 9600, 'POSNET', {
      isRealFiscalPrintEnabled: () => false,
    });
    (driver as any).connectionState = 'protocol_ready';
    const sendSpy = vi.spyOn(driver as any, 'sendPosnetSequence').mockResolvedValue([]);

    await expect(driver.printZReport({
      date: '2026-07-24',
      transactionCount: 1,
      grossSales: 1000,
      discounts: 0,
      refunds: 0,
      netSales: 1000,
      paymentSummary: [],
    })).rejects.toThrow('REAL_FISCAL_PRINT_DISABLED');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('refuses the misleading THERMAL profile before it can send POSNET fiscal frames', async () => {
    const driver = new PosnetDriver('COM6', 9600, 'THERMAL', {
      isRealFiscalPrintEnabled: () => false,
    });
    (driver as any).connectionState = 'protocol_ready';
    const sendSpy = vi.spyOn(driver as any, 'sendPosnetSequence').mockResolvedValue([]);

    await expect(driver.printReceipt({
      orderId: 'thermal-1',
      items: [{ name: 'Tea', quantity: 1, unitPrice: 1000, totalPrice: 1000, vatRate: 23 }],
      payment: { method: 'CASH', amount: 1000 },
      subtotal: 1000,
      total: 1000,
    })).rejects.toThrow('POSNET_THERMAL_PROTOCOL_UNSUPPORTED');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('keeps exact frozen discounts on mixed-VAT, weighted, multi-quantity, and fully-discounted lines', () => {
    const { frames, payableTotal } = buildPosnetFiscalFrames({
      orderId: 'billiard-fiscal-1',
      items: [
        {
          name: 'Czas gry 60 min',
          quantity: 1,
          unitPrice: 3600,
          totalPrice: 3600,
          allocatedDiscount: 3600,
          vatRate: 23,
          unit: 'min',
        },
        {
          name: 'Owoce na wage',
          quantity: 0.238,
          unitPrice: 8000,
          totalPrice: 1904,
          allocatedDiscount: 104,
          vatRate: 5,
          unit: 'kg',
        },
        {
          name: 'Napoj x3',
          quantity: 3,
          unitPrice: 333,
          totalPrice: 999,
          allocatedDiscount: 1,
          vatRate: 8,
        },
      ],
      payment: { method: 'CASH', amount: 5000 },
      subtotal: 6503,
      discount: 3705,
      total: 2798,
    });

    expect(frames).toContainEqual([
      'trline', 'naCzas gry 60 min', 'vt0', 'pr3600', 'il1.000', 'wa3600', 'rd1', 'rw3600', 'rnRabat',
    ]);
    expect(frames).toContainEqual([
      'trline', 'naOwoce na wage', 'vt2', 'pr8000', 'il0.238', 'wa1904', 'rd1', 'rw104', 'rnRabat',
    ]);
    expect(frames).toContainEqual([
      'trline', 'naNapoj x3', 'vt1', 'pr333', 'il3.000', 'wa999', 'rd1', 'rw1', 'rnRabat',
    ]);
    expect(frames).toContainEqual(['trpayment', 'ty0', 'wa2798']);
    expect(frames).toContainEqual(['trend', 'to2798']);
    expect(payableTotal).toBe(2798);
  });

  it('allocates an ordinary cart-level discount before validating POSNET payable total', () => {
    const { frames, payableTotal } = buildPosnetFiscalFrames({
      orderId: 'ordinary-discount-1',
      items: [{
        name: 'Ordinary product',
        quantity: 1,
        unitPrice: 1000,
        totalPrice: 1000,
        vatRate: 23,
      }],
      payment: { method: 'CARD', amount: 900 },
      subtotal: 1000,
      discount: 100,
      total: 900,
    });

    expect(frames).toContainEqual([
      'trline', 'naOrdinary product', 'vt0', 'pr1000', 'il1.000', 'wa1000', 'rd1', 'rw100', 'rnRabat',
    ]);
    expect(frames).toContainEqual(['trend', 'to900']);
    expect(payableTotal).toBe(900);
  });

  it('refuses mismatched discounted arithmetic before frames can be sent', () => {
    expect(() => buildPosnetFiscalFrames({
      orderId: 'billiard-bad-total',
      items: [{
        name: 'Czas gry',
        quantity: 1,
        unitPrice: 1000,
        totalPrice: 1000,
        allocatedDiscount: 1000,
        vatRate: 23,
      }],
      payment: { method: 'CASH', amount: 1 },
      subtotal: 1000,
      discount: 1000,
      total: 1,
    })).toThrow('POSNET_FISCAL_PAYABLE_MISMATCH');
  });

  it('fails closed on a zero unit price instead of sending POSNET pr0', () => {
    expect(() => buildPosnetFiscalFrames({
      orderId: 'zero-price',
      items: [{ name: 'Free line', quantity: 1, unitPrice: 0, totalPrice: 0, vatRate: 23 }],
      payment: { method: 'CASH', amount: 0 },
      subtotal: 0,
      total: 0,
    })).toThrow('POSNET_FISCAL_PRICE_INVALID');
  });

  it('rejects an unsupported VAT rate instead of falling back to POSNET VAT A/23', () => {
    expect(() => buildPosnetFiscalFrames({
      orderId: 'unsupported-vat-frame',
      items: [{ name: 'Unsupported VAT', quantity: 1, unitPrice: 1000, totalPrice: 1000, vatRate: 12 }],
      payment: { method: 'CASH', amount: 1000 },
      subtotal: 1000,
      total: 1000,
    })).toThrow(
      'POSNET_FISCAL_VAT_UNSUPPORTED: VAT rate 12 is not mapped to a POSNET fiscal VAT code. Supported rates: 23, 8, 5, 0, -1.',
    );
  });

  it('rejects unsupported VAT before creating a fiscal attempt or sending any printer byte', async () => {
    const fiscalJournal = {
      findBlockingAttempt: vi.fn(),
      findReconcilableAttempt: vi.fn(),
      resolveReconcilable: vi.fn(),
      getNextAttemptNo: vi.fn(),
      createPending: vi.fn(),
      markSent: vi.fn(),
      markSuccess: vi.fn(),
      markFailed: vi.fn(),
      markUnknown: vi.fn(),
      markBlocked: vi.fn(),
    };
    const driver = new PosnetDriver('COM6', 9600, 'POSNET', { fiscalJournal: fiscalJournal as any });
    (driver as any).connectionState = 'protocol_ready';
    const sendSpy = vi.spyOn(driver as any, 'sendPosnetSequence').mockResolvedValue([]);

    await expect(driver.printReceipt({
      orderId: 'unsupported-vat-print',
      items: [{ name: 'Unsupported VAT', quantity: 1, unitPrice: 1000, totalPrice: 1000, vatRate: 12 }],
      payment: { method: 'CARD', amount: 1000 },
      subtotal: 1000,
      total: 1000,
    })).rejects.toThrow('POSNET_FISCAL_VAT_UNSUPPORTED');

    expect(fiscalJournal.findBlockingAttempt).not.toHaveBeenCalled();
    expect(fiscalJournal.getNextAttemptNo).not.toHaveBeenCalled();
    expect(fiscalJournal.createPending).not.toHaveBeenCalled();
    expect(fiscalJournal.markSent).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('keeps an entirely discounted positive-price service at zero payable', () => {
    const { frames, payableTotal } = buildPosnetFiscalFrames({
      orderId: 'fully-discounted-time',
      items: [{
        name: 'Czas gry',
        quantity: 1,
        unitPrice: 1000,
        totalPrice: 1000,
        allocatedDiscount: 1000,
        vatRate: 23,
      }],
      payment: { method: 'CASH', amount: 0 },
      subtotal: 1000,
      discount: 1000,
      total: 0,
    });
    expect(payableTotal).toBe(0);
    expect(frames).toContainEqual(['trpayment', 'ty0', 'wa0']);
    expect(frames).toContainEqual(['trend', 'to0']);
  });
});

describe('PosnetDriver diagnostic codes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getStatus() includes connectionState and diagnostic', async () => {
    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    (driver as any).connectionState = 'physical_present';
    (driver as any).lastDiagnostic = { code: 'DEVICE_DETECTED_NO_PROTOCOL_RESPONSE', detail: 'test' };
    (driver as any).detectedPid = 0x100B;

    const status = await driver.getStatus();
    expect(status.connectionState).toBe('physical_present');
    expect(status.diagnostic?.code).toBe('DEVICE_DETECTED_NO_PROTOCOL_RESPONSE');
    expect(status.detectedPid).toBe(0x100B);
    expect(status.connected).toBe(false);
  });

  it('explains POSNET Thermal protocol mismatch when PID 100B gives no POSNET response', async () => {
    mockWithPortLock.mockImplementation(async (_port, _operation, fn) => ({
      ok: true,
      value: await fn(),
    }) as any);
    mockListSerialPorts.mockResolvedValue(['COM6']);
    vi.spyOn(PosnetDriver as any, 'findPosnetPidForPort').mockResolvedValue(0x100B);
    vi.spyOn(PosnetDriver as any, 'verifyPosnetDeviceUnlocked').mockResolvedValue({ ok: false, result: 'NOREPLY' });

    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    const connected = await driver.connect();

    expect(connected).toBe(false);
    expect(driver.getConnectionState()).toBe('physical_present');
    const diagnostic = driver.getLastDiagnostic();
    expect(diagnostic?.code).toBe('DEVICE_DETECTED_NO_PROTOCOL_RESPONSE');
    expect(diagnostic?.detail).toContain('Thermal XL');
    expect(diagnostic?.detail).toContain('THEMAL');
    expect(diagnostic?.detail).toContain('9600:NOREPLY');
    expect(diagnostic?.detail).not.toContain('19200:NOREPLY');
    expect(diagnostic?.detail).not.toContain('115200:NOREPLY');
    expect((PosnetDriver as any).verifyPosnetDeviceUnlocked).toHaveBeenCalledTimes(1);
  });

  it('keeps baud probing for POSNET models without ambiguous Thermal protocol', async () => {
    mockWithPortLock.mockImplementation(async (_port, _operation, fn) => ({
      ok: true,
      value: await fn(),
    }) as any);
    mockListSerialPorts.mockResolvedValue(['COM6']);
    vi.spyOn(PosnetDriver as any, 'findPosnetPidForPort').mockResolvedValue(0x1015);
    vi.spyOn(PosnetDriver as any, 'verifyPosnetDeviceUnlocked').mockResolvedValue({ ok: false, result: 'NOREPLY' });

    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    const connected = await driver.connect();

    expect(connected).toBe(false);
    expect((PosnetDriver as any).verifyPosnetDeviceUnlocked).toHaveBeenCalledTimes(3);
    expect(driver.getLastDiagnostic()?.detail).toContain('9600:NOREPLY');
    expect(driver.getLastDiagnostic()?.detail).toContain('19200:NOREPLY');
    expect(driver.getLastDiagnostic()?.detail).toContain('115200:NOREPLY');
  });

  it('classifies serial write timeout as wrong baud or printer-side mode and aborts further baud probing', async () => {
    mockWithPortLock.mockImplementation(async (_port, _operation, fn) => ({
      ok: true,
      value: await fn(),
    }) as any);
    mockListSerialPorts.mockResolvedValue(['COM6']);
    vi.spyOn(PosnetDriver as any, 'findPosnetPidForPort').mockResolvedValue(0x100B);
    vi.spyOn(PosnetDriver as any, 'verifyPosnetDeviceUnlocked').mockResolvedValue({
      ok: false,
      result: 'ERROR:Exception calling "Write" with "3" argument(s): "The semaphore timeout period has expired."',
      errorCode: 'WRONG_BAUD_OR_MODE',
      detail: 'The semaphore timeout period has expired.',
    });

    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    const connected = await driver.connect();

    expect(connected).toBe(false);
    expect(driver.getConnectionState()).toBe('physical_present');
    expect(driver.getLastDiagnostic()?.code).toBe('WRONG_BAUD_OR_MODE');
    expect(driver.requiresManualProtocolAction()).toBe(true);
    expect((PosnetDriver as any).verifyPosnetDeviceUnlocked).toHaveBeenCalledTimes(1);
  });

  it('WRONG_BAUD_OR_MODE detail on Thermal XL includes printer-menu guidance', async () => {
    mockWithPortLock.mockImplementation(async (_port, _operation, fn) => ({
      ok: true,
      value: await fn(),
    }) as any);
    mockListSerialPorts.mockResolvedValue(['COM6']);
    vi.spyOn(PosnetDriver as any, 'findPosnetPidForPort').mockResolvedValue(0x100B);
    vi.spyOn(PosnetDriver as any, 'verifyPosnetDeviceUnlocked').mockResolvedValue({
      ok: false,
      errorCode: 'WRONG_BAUD_OR_MODE',
      detail: 'The semaphore timeout period has expired.',
    });

    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    await driver.connect();
    const detail = driver.getLastDiagnostic()?.detail || '';

    expect(detail).toContain('Thermal XL');
    expect(detail).toContain('Interfejs PC');
    expect(detail).toContain('POSNET');
    expect(detail).toMatch(/restart the printer/i);
  });

  it('does not auto-switch protocol to THERMAL after failed POSNET probe', async () => {
    mockWithPortLock.mockImplementation(async (_port, _operation, fn) => ({
      ok: true,
      value: await fn(),
    }) as any);
    mockListSerialPorts.mockResolvedValue(['COM6']);
    vi.spyOn(PosnetDriver as any, 'findPosnetPidForPort').mockResolvedValue(0x100B);
    vi.spyOn(PosnetDriver as any, 'verifyPosnetDeviceUnlocked').mockResolvedValue({
      ok: false, errorCode: 'WRONG_BAUD_OR_MODE', detail: 'timeout',
    });

    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
    await driver.connect();
    const status = await driver.getStatus();

    expect(status.protocol).toBe('POSNET');
    expect(status.connected).toBe(false);
    expect(status.connectionState).toBe('physical_present');
  });
});

describe('PosnetDriver.diagnosePort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns PORT_NOT_FOUND when the port is missing from the system list', async () => {
    mockListSerialPorts.mockResolvedValue(['COM3']);
    vi.spyOn(PosnetDriver as any, 'findPosnetPidForPort').mockResolvedValue(null);

    const result = await PosnetDriver.diagnosePort('COM6', 9600);

    expect(result.portPresent).toBe(false);
    expect(result.diagnostic.code).toBe('PORT_NOT_FOUND');
    expect(result.posnetResponse).toBe(false);
    expect(result.guidance.length).toBeGreaterThan(0);
    expect(result.requiresManualSetup).toBe(false);
  });

  it('returns PORT_BUSY without disturbing an in-flight operation', async () => {
    mockListSerialPorts.mockResolvedValue(['COM6']);
    vi.spyOn(PosnetDriver as any, 'findPosnetPidForPort').mockResolvedValue(0x100B);
    const verifySpy = vi.spyOn(PosnetDriver as any, 'verifyPosnetDeviceUnlocked');
    mockWithPortLock.mockResolvedValue({
      ok: false, error: 'PORT_BUSY', message: 'Port COM6 is busy',
    } as any);

    const result = await PosnetDriver.diagnosePort('COM6', 9600);

    expect(result.diagnostic.code).toBe('PORT_BUSY');
    expect(result.posnetResponse).toBe(false);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('returns success + Test Print hint when POSNET v2 responds', async () => {
    mockListSerialPorts.mockResolvedValue(['COM6']);
    vi.spyOn(PosnetDriver as any, 'findPosnetPidForPort').mockResolvedValue(0x100B);
    mockWithPortLock.mockImplementation(async (_port, _op, fn) => ({ ok: true, value: await fn() }) as any);
    vi.spyOn(PosnetDriver as any, 'verifyPosnetDeviceUnlocked').mockResolvedValue({ ok: true, result: 'POSNET' });

    const result = await PosnetDriver.diagnosePort('COM6', 9600);

    expect(result.posnetResponse).toBe(true);
    expect(result.diagnostic.code).toBe('PRINT_OK');
    expect(result.requiresManualSetup).toBe(false);
    expect(result.modelName).toContain('Thermal XL');
    expect(result.guidance.join(' ')).toMatch(/Test Print/i);
  });

  it('returns WRONG_BAUD_OR_MODE with printer-menu guidance for Thermal XL', async () => {
    mockListSerialPorts.mockResolvedValue(['COM6']);
    vi.spyOn(PosnetDriver as any, 'findPosnetPidForPort').mockResolvedValue(0x100B);
    mockWithPortLock.mockImplementation(async (_port, _op, fn) => ({ ok: true, value: await fn() }) as any);
    vi.spyOn(PosnetDriver as any, 'verifyPosnetDeviceUnlocked').mockResolvedValue({
      ok: false, errorCode: 'WRONG_BAUD_OR_MODE', detail: 'semaphore timeout',
    });

    const result = await PosnetDriver.diagnosePort('COM6', 9600);

    expect(result.posnetResponse).toBe(false);
    expect(result.diagnostic.code).toBe('WRONG_BAUD_OR_MODE');
    expect(result.requiresManualSetup).toBe(true);
    expect(result.vidMatch).toBe(true);
    expect(result.guidance.some(s => /Interfejs PC/i.test(s))).toBe(true);
    expect(result.guidance.some(s => /POSNET/.test(s))).toBe(true);
    expect(result.guidance.some(s => /restart the printer/i.test(s))).toBe(true);
  });

  it('falls back to generic guidance for non-thermal POSNET models', async () => {
    mockListSerialPorts.mockResolvedValue(['COM6']);
    // 0x1015 Temo HS is not in the mocked POSNET_PRODUCT_IDS — treated as unknown/non-thermal
    vi.spyOn(PosnetDriver as any, 'findPosnetPidForPort').mockResolvedValue(0x1015);
    mockWithPortLock.mockImplementation(async (_port, _op, fn) => ({ ok: true, value: await fn() }) as any);
    vi.spyOn(PosnetDriver as any, 'verifyPosnetDeviceUnlocked').mockResolvedValue({
      ok: false, result: 'NOREPLY',
    });

    const result = await PosnetDriver.diagnosePort('COM6', 9600);

    expect(result.diagnostic.code).toBe('DEVICE_DETECTED_NO_PROTOCOL_RESPONSE');
    expect(result.requiresManualSetup).toBe(false);
    expect(result.guidance.length).toBeGreaterThan(0);
    expect(result.guidance.every(s => !/Interfejs PC/i.test(s))).toBe(true);
  });

  it('never triggers a print command path — only verify rtcget', async () => {
    mockListSerialPorts.mockResolvedValue(['COM6']);
    vi.spyOn(PosnetDriver as any, 'findPosnetPidForPort').mockResolvedValue(0x100B);
    mockWithPortLock.mockImplementation(async (_port, _op, fn) => ({ ok: true, value: await fn() }) as any);
    const verifySpy = vi.spyOn(PosnetDriver as any, 'verifyPosnetDeviceUnlocked').mockResolvedValue({ ok: true });

    await PosnetDriver.diagnosePort('COM6', 9600);

    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledWith('COM6', 9600);
  });
});
