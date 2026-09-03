import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRODUCT_LABEL_NAME_LOCALE,
  resolveProductLabelName,
  resolveProductLabelNameResult,
} from '../src/shared/catalog-names';
import { formatProductLabelPriceText } from '../src/renderer/utils/product-label';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

// The Label tab is deliberately absent: it no longer prints a shelf label
// through `printLabel`. It prints bag labels and fabric tags for a garment
// style, whose name it still resolves Polish-first through `resolveName`.
const PRODUCT_LABEL_PRINT_PATHS = [
  'src/renderer/components/pos/POSLayout.tsx',
  'src/renderer/components/pos/templates/retail/RetailTemplate.tsx',
  'src/renderer/components/products/ProductDetailDrawer.tsx',
  'src/renderer/components/products/ProductEditView.tsx',
] as const;

describe('product label name locale contract', () => {
  it('always prefers the Polish translation', () => {
    expect(PRODUCT_LABEL_NAME_LOCALE).toBe('pl');
    expect(resolveProductLabelName({
      name: 'Mi Ramen Vi Hai San Cay',
      name_translations: {
        vi: 'Mì ramen vị hải sản cay',
        pl: 'Zupka błyskawiczna z owocami morza ostra',
      },
    })).toBe('Zupka błyskawiczna z owocami morza ostra');
  });

  it('accepts SQLite JSON and falls back only to the canonical name', () => {
    expect(resolveProductLabelName({
      name: 'Mi Omachi bo/ omachi makaron',
      name_translations: JSON.stringify({ vi: 'Mì Omachi bò' }),
    })).toBe('Mi Omachi bo/ omachi makaron');
    expect(resolveProductLabelName({
      name: 'Nuoc OKF co gas vi kiwi',
      name_translations: JSON.stringify({ pl: '   ', vi: 'Nước OKF có gas vị kiwi' }),
    })).toBe('Nuoc OKF co gas vi kiwi');

    expect(resolveProductLabelNameResult({
      name: 'Nuoc OKF co gas vi kiwi',
      name_translations: JSON.stringify({ vi: 'Nước OKF có gas vị kiwi' }),
    })).toEqual({
      name: 'Nuoc OKF co gas vi kiwi',
      missingPolishName: true,
    });
  });

  it('marks a usable Polish translation as present', () => {
    expect(resolveProductLabelNameResult({
      name: 'Mi Ramen Vi Hai San Cay',
      name_translations: { pl: 'Zupka błyskawiczna ostra' },
    })).toEqual({
      name: 'Zupka błyskawiczna ostra',
      missingPolishName: false,
    });
  });

  it('prints only the price for pieces and keeps /kg for weighted products', () => {
    expect(formatProductLabelPriceText({
      retail_price: 1299,
      sell_by: 'PIECE',
      sale_unit: 'szt',
    }, 'zl')).toBe('12,99 zl');
    expect(formatProductLabelPriceText({
      retail_price: 1299,
      sell_by: 'WEIGHT',
      sale_unit: 'kg',
    }, 'zl')).toBe('12,99 zl/kg');
  });

  it.each(PRODUCT_LABEL_PRINT_PATHS)('%s routes the printed name through the Polish resolver', (path) => {
    const printPath = source(path);
    expect(printPath).toContain('resolveProductLabelNameResult(product)');
    expect(printPath).toMatch(/electronAPI\.printLabel\([\s\S]{0,120}labelName,/);
  });

  it.each(PRODUCT_LABEL_PRINT_PATHS)('%s leaves SKU off the customer shelf label', (path) => {
    const printPath = source(path);
    const printCall = printPath.slice(
      printPath.indexOf('electronAPI.printLabel'),
      printPath.indexOf('});', printPath.indexOf('electronAPI.printLabel')),
    );
    expect(printCall).not.toContain('sku:');
  });
});
