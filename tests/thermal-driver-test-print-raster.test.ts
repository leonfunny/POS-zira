import { describe, expect, it, vi } from 'vitest';
import { ThermalDriver } from '../src/main/hardware/thermal/thermal-driver';

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('ThermalDriver test print raster fallback', () => {
  it('renders the test page as raster when the salon header contains non-ASCII text', async () => {
    const driver = new ThermalDriver('COM1', 9600, 'SERIAL', 80, 48, false, {
      charset: 'utf8',
      cutMode: 'partial',
    });
    (driver as any).connected = true;

    const raster = Buffer.from([0x1d, 0x76, 0x30, 0x00]);
    const renderTextToRaster = vi.fn(async () => raster);
    const printRaw = vi.fn(async () => undefined);
    (driver as any).renderTextToRaster = renderTextToRaster;
    (driver as any).printRaw = printRaw;

    await driver.printTest({
      salonName: 'Chè Sài Gòn',
      sellerName: 'CHE SAI GON',
      sellerNip: '522310395',
    });

    expect(renderTextToRaster).toHaveBeenCalledTimes(1);
    expect(renderTextToRaster.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Chè Sài Gòn', big: true, center: true }),
        expect.objectContaining({ text: 'CHE SAI GON', center: true }),
        expect.objectContaining({ text: 'NIP: 522310395', center: true }),
      ]),
    );
    expect(printRaw).toHaveBeenCalledWith(raster);
  });

  it('keeps ASCII-only test pages on the raw ESC/POS text path', async () => {
    const driver = new ThermalDriver('COM1', 9600, 'SERIAL', 80, 48, false, {
      charset: 'utf8',
      cutMode: 'partial',
    });
    (driver as any).connected = true;

    const renderTextToRaster = vi.fn(async () => Buffer.from('raster'));
    const printRaw = vi.fn(async () => undefined);
    (driver as any).renderTextToRaster = renderTextToRaster;
    (driver as any).printRaw = printRaw;

    await driver.printTest({
      salonName: 'CHE SAI GON',
      sellerName: 'CHE SAI GON',
      sellerNip: '522310395',
    });

    expect(renderTextToRaster).not.toHaveBeenCalled();
    const printed = printRaw.mock.calls[0][0] as Buffer;
    expect(printed.toString('utf8')).toContain('Zira AI - Test Print');
  });
});
