import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { netFromGross } from '../src/renderer/components/products/price-vat';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

describe('product VAT changes keep the gross selling price authoritative', () => {
  it('recalculates only net from the unchanged gross value', () => {
    const gross = '12.30';

    expect(netFromGross(gross, '8')).toBe('11.39');
    expect(gross).toBe('12.30');
  });

  it.each([
    'ProductCreateDialog.tsx',
    'ProductEditForm.tsx',
  ])('keeps gross unchanged in the VAT handler of %s', (file) => {
    const form = source(`src/renderer/components/products/${file}`);

    expect(form).toContain('setPriceNet(netFromGross(priceGross, nextVat));');
    expect(form).not.toContain('setPriceGross(grossFromNet(priceNet, nextVat));');
  });
});
