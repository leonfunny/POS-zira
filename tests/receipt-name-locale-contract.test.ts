import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECEIPT_NAME_LOCALE, resolveName } from '../src/shared/catalog-names';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

describe('receipt name locale contract', () => {
  it('exports the locale the receipt renders item names in', () => {
    expect(RECEIPT_NAME_LOCALE).toBe('pl');
  });

  it('prefers the Polish translation over the canonical name', () => {
    expect(
      resolveName({ name: 'Cat (than lon)', name_translations: { pl: 'Nerka' } }, RECEIPT_NAME_LOCALE),
    ).toBe('Nerka');
  });

  it('falls back to the canonical name when Polish is missing or blank', () => {
    expect(resolveName({ name: 'Cat (than lon)', name_translations: { vi: 'Cat heo' } }, RECEIPT_NAME_LOCALE))
      .toBe('Cat (than lon)');
    expect(resolveName({ name: 'Cat (than lon)', name_translations: { pl: '   ' } }, RECEIPT_NAME_LOCALE))
      .toBe('Cat (than lon)');
    expect(resolveName({ name: 'Cat (than lon)', name_translations: null }, RECEIPT_NAME_LOCALE))
      .toBe('Cat (than lon)');
  });

  it('the print path resolves through the shared constant, not a literal', () => {
    const printPath = source('src/main/pos/payment-controller.ts');
    expect(printPath).toContain('RECEIPT_NAME_LOCALE');
    expect(printPath).not.toMatch(/resolveName\(\s*product\s*,\s*['"]pl['"]\s*\)/);
  });
});
