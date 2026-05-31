import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const retailTemplate = readSource('../src/renderer/components/pos/templates/retail/RetailTemplate.tsx');
const preloadPos = readSource('../src/preload/preload-pos.ts');

describe('retail POS long-press label printing', () => {
  it('exposes label printing in the POS window preload', () => {
    expect(preloadPos).toContain('printLabel: (barcode: string, text?: string, options?:');
    expect(preloadPos).toContain("ipcRenderer.invoke('print-label', barcode, text, options)");
  });

  it('prints the product barcode, name, price, and sku through the Zebra label path', () => {
    expect(retailTemplate).toContain('const handlePrintProductCode = useCallback(async (product: Product) => {');
    expect(retailTemplate).toContain('const barcode = product.barcode?.trim();');
    expect(retailTemplate).toContain('const priceGrosze = Number(product.retail_price) || 0;');
    expect(retailTemplate).toContain('window.electronAPI.printLabel(barcode, displayName, {');
    expect(retailTemplate).toContain('priceText,');
    expect(retailTemplate).toContain('sku: product.sku?.trim() || undefined');
    expect(retailTemplate).toContain('onLongPressProduct={handlePrintProductCode}');
  });
});
