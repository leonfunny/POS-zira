import { describe, expect, it } from 'vitest';
import { translations } from '../src/renderer/i18n/translations';

describe('product item-type copy', () => {
  it('uses business-facing labels in English, Vietnamese, and Polish', () => {
    expect(translations.en['products.drawer.sellBy']).toBe('Price by');
    expect(translations.vi['products.drawer.sellBy']).toBe('Tính giá theo');
    expect(translations.pl['products.drawer.sellBy']).toBe('Sposób wyceny');

    expect(translations.en['products.itemType.consumable']).toBe('Goods without inventory tracking');
    expect(translations.vi['products.itemType.consumable']).toBe('Hàng bán không quản lý tồn');
    expect(translations.pl['products.itemType.consumable']).toBe('Towar bez ewidencji stanu');
  });

  it('defines item-type and sale-mode hints without relying on English fallbacks', () => {
    const keys = [
      'products.drawer.sellByPiece',
      'products.drawer.sellByWeight',
      'products.drawer.pieceHint',
      'products.drawer.weightHint',
      'products.itemType.serviceHint',
      'products.itemType.consumableHint',
      'products.itemType.serviceSaleHint',
      'products.itemType.consumableSaleHint',
    ];

    for (const language of ['en', 'vi', 'pl'] as const) {
      for (const key of keys) {
        expect(translations[language][key], `${language}.${key}`).toBeTruthy();
      }
    }
  });
});
