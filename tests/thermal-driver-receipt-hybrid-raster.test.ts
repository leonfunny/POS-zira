import { describe, expect, it, vi } from 'vitest';
import { ThermalDriver } from '../src/main/hardware/thermal/thermal-driver';
import { WindowsThermalWorkerError } from '../src/main/hardware/thermal/windows-thermal-worker';
import type { ReceiptData } from '../src/shared/types';

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function buildReceipt(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    orderNumber: 'POS-20260516-0001',
    salonName: 'CHE SAI GON',
    sellerName: 'CHE SAI GON Sp. z o.o.',
    sellerAddress: 'ul. Marszalkowska 1',
    sellerNip: '5220052349',
    items: [
      { name: 'Bulka', quantity: 2, unitPrice: 200, totalPrice: 400, vatRate: 5 },
    ],
    payment: { method: 'CASH', amount: 400 },
    subtotal: 400,
    total: 400,
    cashierName: 'Anna',
    ...overrides,
  };
}

describe('ThermalDriver receipt hybrid raster path', () => {
  it('classifies a disconnected receipt attempt as explicitly safe before print', async () => {
    const driver = new ThermalDriver('COM1', 9600, 'SERIAL', 80, 48, false, {
      charset: 'utf8',
      cutMode: 'partial',
    });

    const error = await driver.printReceipt(buildReceipt()).catch((caught) => caught);

    expect(error).toMatchObject({
      code: 'PRINTER_NOT_CONNECTED',
      stage: 'DRIVER_PREFLIGHT',
      failureClass: 'SAFE_BEFORE_PRINT',
      action: 'print',
    });
  });

  it('does not refresh physical-presence cache from Winspool acceptance alone', async () => {
    const driver = new ThermalDriver('Xprinter XP-80T', 9600, 'USB', 80, 48, false, {
      charset: 'utf8',
      cutMode: 'partial',
    });
    const verifiedAt = Date.now() - 1_000;
    const printRaw = vi.fn(async (_printerName: string, data: Buffer) => ({
      jobId: 81,
      bytesWritten: data.length,
      spoolMs: 4,
      preflightMs: 1,
      reconcileMs: 25,
      printerStatus: 0,
      printerStatusText: 'READY',
      jobStatus: 0x80,
      jobStatusText: 'PRINTED',
    }));
    (driver as any).connected = true;
    (driver as any).lastPresenceCheckAt = verifiedAt;
    (driver as any).getWindowsWorker = () => ({ printRaw });

    await driver.printReceipt(buildReceipt());

    expect(printRaw).toHaveBeenCalledTimes(1);
    expect((driver as any).lastPresenceCheckAt).toBe(verifiedAt);
  });

  it('does not legacy-fallback around a semantic PRINTER_NOT_READY failure', async () => {
    const driver = new ThermalDriver('Xprinter XP-80T', 9600, 'USB', 80, 48, false, {
      charset: 'utf8',
      cutMode: 'partial',
    });
    const printerError = new WindowsThermalWorkerError({
      message: 'Printer is not ready: OFFLINE|PAPER_OUT',
      code: 'PRINTER_NOT_READY',
      stage: 'PRINTER_PREFLIGHT',
      failureClass: 'SAFE_BEFORE_PRINT',
      action: 'print',
    });
    const printRaw = vi.fn(async () => {
      throw printerError;
    });
    (driver as any).connected = true;
    (driver as any).lastPresenceCheckAt = Date.now();
    (driver as any).getWindowsWorker = () => ({ printRaw });

    const error = await driver.printReceipt(buildReceipt()).catch((caught) => caught);

    expect(error).toBe(printerError);
    expect(printRaw).toHaveBeenCalledTimes(1);
  });

  it('rasterizes only the Unicode span and keeps the ASCII tail on native ESC/POS text', async () => {
    const driver = new ThermalDriver('COM1', 9600, 'SERIAL', 80, 48, false, {
      charset: 'utf8',
      cutMode: 'partial',
    });
    (driver as any).connected = true;

    const raster = Buffer.from([0x1d, 0x76, 0x30, 0x00, 0xaa]);
    const renderTextToRaster = vi.fn(async () => raster);
    const printRaw = vi.fn(async () => undefined);
    (driver as any).renderTextToRaster = renderTextToRaster;
    (driver as any).printRawUnlocked = printRaw;

    // Shop name and seller name were removed from the receipt template
    // per operator preference. Address is still rendered, so we use it to
    // smuggle the Unicode span the test needs to trigger the raster path.
    await driver.printReceipt(buildReceipt({ sellerAddress: 'ul. Chè Sài Gòn 1' }));

    expect(renderTextToRaster).toHaveBeenCalledTimes(1);
    expect(renderTextToRaster).toHaveBeenCalledWith(
      [expect.objectContaining({ text: 'ul. Chè Sài Gòn 1', center: true })],
      { includeInit: false, includeFeed: false, includeCut: false },
    );

    const printed = printRaw.mock.calls[0][0] as Buffer;
    expect(printed).not.toEqual(raster);
    const rasterOffset = printed.indexOf(raster);
    expect(rasterOffset).toBeGreaterThanOrEqual(0);
    expect(printed.lastIndexOf(raster)).toBe(rasterOffset);
    expect(rasterOffset).toBeLessThan(printed.indexOf(Buffer.from('SUMA PLN')));
    expect(printed.toString('utf8')).toContain('ZAMOWIENIE');
    expect(printed.toString('utf8')).toContain('SUMA PLN');
    expect(printed.toString('utf8')).toContain('Dziekujemy za zakupy!');
  });

  it('keeps ASCII-only receipts on the existing raw ESC/POS text path', async () => {
    const driver = new ThermalDriver('COM1', 9600, 'SERIAL', 80, 48, false, {
      charset: 'utf8',
      cutMode: 'partial',
    });
    (driver as any).connected = true;

    const renderTextToRaster = vi.fn(async () => Buffer.from('raster'));
    const printRaw = vi.fn(async () => undefined);
    (driver as any).renderTextToRaster = renderTextToRaster;
    (driver as any).printRawUnlocked = printRaw;

    await driver.printReceipt(buildReceipt());

    expect(renderTextToRaster).not.toHaveBeenCalled();
    const printed = printRaw.mock.calls[0][0] as Buffer;
    // Shop / seller name dropped from the template; address + NIP still
    // print, and the title is what we care about for this happy-path test.
    expect(printed.toString('utf8')).toContain('ul. Marszalkowska 1');
    expect(printed.toString('utf8')).toContain('ZAMOWIENIE');
  });

  it('prefixes the cash drawer pulse when printing a cash receipt with drawer', async () => {
    const driver = new ThermalDriver('COM1', 9600, 'SERIAL', 80, 48, false, {
      charset: 'utf8',
      cutMode: 'partial',
    });
    (driver as any).connected = true;

    const printRaw = vi.fn(async () => undefined);
    (driver as any).printRawUnlocked = printRaw;

    await driver.printReceiptWithDrawer(buildReceipt());

    const printed = printRaw.mock.calls[0][0] as Buffer;
    expect([...printed.slice(0, 5)]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
    expect(printed.toString('utf8')).toContain('ZAMOWIENIE');
  });

  it('keeps QR commands native when plain-line text falls back to raster', async () => {
    const driver = new ThermalDriver('COM1', 9600, 'SERIAL', 80, 48, false, {
      charset: 'utf8',
      cutMode: 'partial',
    });
    (driver as any).connected = true;

    const raster = Buffer.from([0x1d, 0x76, 0x30, 0x00, 0xbb]);
    const renderTextToRaster = vi.fn(async () => raster);
    const printRaw = vi.fn(async () => undefined);
    (driver as any).renderTextToRaster = renderTextToRaster;
    (driver as any).printRawUnlocked = printRaw;

    await driver.printPlainLines([
      { text: 'Zażółć gesla', center: true },
      { text: '', qrData: 'KSO1:test-payload', qrSize: 7 },
    ]);

    expect(renderTextToRaster).toHaveBeenCalledTimes(1);
    const printed = printRaw.mock.calls[0][0] as Buffer;
    expect(printed.includes(raster)).toBe(true);
    expect(printed.toString('utf8')).toContain('KSO1:test-payload');
  });
});
