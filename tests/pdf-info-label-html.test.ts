import { describe, expect, it, vi } from 'vitest';
import { ManufacturerRole } from '../src/shared/types';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getPath: vi.fn(() => 'C:\\tmp') },
}));

import { buildInfoLabelHtml } from '../src/main/hardware/pdf/pdf-printer';

describe('buildInfoLabelHtml', () => {
  it('preserves Polish characters for Windows-rendered Xprinter labels', () => {
    const html = buildInfoLabelHtml({
      printerName: 'Xprinter XP-423B',
      labelWidthMm: 100,
      labelHeightMm: 150,
      data: {
        productName: 'Złota Nioska Świeże Jaja Klasa A',
        ingredients: 'Składniki: 100% świeże jaja kurze, wartości odżywcze',
        bestBefore: '2026-06-06',
        manufacturerInfo: 'Zollerstraße 7, właściciel marki',
        manufacturerRole: ManufacturerRole.PRODUCER,
        countryOfOrigin: 'PL',
        quantity: 1,
      },
    });

    expect(html).toContain('Złota Nioska Świeże Jaja');
    expect(html).toContain('Składniki');
    expect(html).toContain('wartości odżywcze');
    expect(html).toContain('Najlepiej spożyć przed: 06.06.2026');
    expect(html).toContain('Zollerstraße 7, właściciel marki');
    expect(html).toContain('Kraj pochodzenia: PL');
    expect(html).toContain('@page { size: 100mm 150mm; margin: 0; }');
  });
});
