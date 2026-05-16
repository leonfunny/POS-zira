import { describe, expect, it, vi } from 'vitest';
import { ThermalDriver } from '../src/main/hardware/thermal/thermal-driver';
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
    (driver as any).printRaw = printRaw;

    await driver.printReceipt(buildReceipt({ salonName: 'Chè Sài Gòn' }));

    expect(renderTextToRaster).toHaveBeenCalledTimes(1);
    expect(renderTextToRaster).toHaveBeenCalledWith(
      [expect.objectContaining({ text: 'Chè Sài Gòn', big: true, center: true })],
      { includeInit: false, includeFeed: false, includeCut: false },
    );

    const printed = printRaw.mock.calls[0][0] as Buffer;
    expect(printed).not.toEqual(raster);
    expect(printed.includes(raster)).toBe(true);
    expect(printed.toString('utf8')).toContain('PARAGON NIEFISKALNY');
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
    (driver as any).printRaw = printRaw;

    await driver.printReceipt(buildReceipt());

    expect(renderTextToRaster).not.toHaveBeenCalled();
    const printed = printRaw.mock.calls[0][0] as Buffer;
    expect(printed.toString('utf8')).toContain('CHE SAI GON');
    expect(printed.toString('utf8')).toContain('PARAGON NIEFISKALNY');
  });
});
