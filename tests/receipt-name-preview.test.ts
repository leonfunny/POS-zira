import { describe, expect, it } from 'vitest';
import { receiptNamePreview } from '../src/renderer/components/products/receipt-name-preview';
import { RECEIPT_NAME_LOCALE, resolveName } from '../src/shared/catalog-names';

describe('receiptNamePreview', () => {
  it('reports the Polish name when present', () => {
    expect(receiptNamePreview('Cat (than lon)', { pl: 'Nerka', vi: '', en: '' }))
      .toMatchObject({ value: 'Nerka', source: 'pl' });
  });

  it('falls back to the canonical name when the Polish field is blank', () => {
    expect(receiptNamePreview('Cat (than lon)', { pl: '   ', vi: '', en: '' }))
      .toMatchObject({ value: 'Cat (than lon)', source: 'canonical' });
  });

  it('a Vietnamese display name never reaches the receipt', () => {
    expect(receiptNamePreview('Cat (than lon)', { pl: '', vi: 'Cat heo', en: '' }))
      .toMatchObject({ value: 'Cat (than lon)', source: 'canonical' });
  });

  it('shows how an ELZAB printer folds the name to ASCII', () => {
    expect(receiptNamePreview('Cật (thận lợn)', { pl: '', vi: '', en: '' }).fiscalSafe)
      .toBe('Cat (than lon)');
  });

  it('agrees with the print-path resolver for the same input', () => {
    const canonical = 'Cat (than lon)';
    const displayNames = { pl: 'Nerka', vi: '', en: '' };
    expect(receiptNamePreview(canonical, displayNames).value).toBe(
      resolveName({ name: canonical, name_translations: displayNames }, RECEIPT_NAME_LOCALE),
    );
  });
});
