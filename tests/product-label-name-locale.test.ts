import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRODUCT_LABEL_NAME_LOCALE,
  resolveProductLabelName,
} from '../src/shared/catalog-names';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

const PRODUCT_LABEL_PRINT_PATHS = [
  'src/renderer/components/label/LabelModule.tsx',
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
  });

  it.each(PRODUCT_LABEL_PRINT_PATHS)('%s routes the printed name through the Polish resolver', (path) => {
    const printPath = source(path);
    expect(printPath).toContain('resolveProductLabelName(product)');
    expect(printPath).toMatch(/electronAPI\.printLabel\([\s\S]{0,120}labelName,/);
  });
});
