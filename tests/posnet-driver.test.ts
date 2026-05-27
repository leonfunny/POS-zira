/**
 * Unit tests for PosnetDriver connection state, port mutex, and health check logic.
 * These tests focus on state transitions and mutex behavior without requiring
 * real serial ports or PowerShell execution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { PosnetDriver } from '../src/main/hardware/posnet/posnet-driver';

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
    const driver = new PosnetDriver('COM6', 9600, 'POSNET');
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
    expect(frames).toContainEqual(['trline', 'naRieng cu', 'vt2', 'pr8000', 'il0.238']);
    expect(frames).toContainEqual(['trpayment', 'ty2', 'wa1904']);
    expect(frames).toContainEqual(['trend', 'to1904']);
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
