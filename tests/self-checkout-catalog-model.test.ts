import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  getProductAvailability,
  getProductPriceGrosze,
  getProductStock,
  normalizeCatalogText,
} from '../src/renderer/windows/self-checkout/catalog-model';

describe('self-checkout catalog model', () => {
  it('normalizes accented catalog text for search matching', () => {
    expect(normalizeCatalogText('Kuchnia Zolta Ca phe')).toBe('kuchnia zolta ca phe');
  });

  it('no longer ships the department keyword classifier', () => {
    const src = readFileSync(
      new URL('../src/renderer/windows/self-checkout/catalog-model.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toContain('getCategoryDepartment');
    expect(src).not.toContain("'kitchen'");
  });

  it('keeps price and stock normalization consistent across menu and search', () => {
    expect(getProductPriceGrosze({ id: 'a', name: 'A', price: 123.4 })).toBe(123);
    expect(getProductPriceGrosze({ id: 'b', name: 'B', price_gross: 456 })).toBe(456);
    expect(getProductPriceGrosze({ id: 'c', name: 'C' })).toBe(0);
    expect(getProductStock({ id: 'd', name: 'D', available_qty: 3 })).toBe(3);
    expect(getProductStock({ id: 'e', name: 'E' })).toBeUndefined();
  });

  it('marks no-price and sold-out products as unavailable for customer add actions by default', () => {
    expect(getProductAvailability({ id: 'ok', name: 'OK', retail_price: 500 })).toMatchObject({
      canAdd: true,
      reason: null,
      priceGrosze: 500,
    });
    expect(getProductAvailability({ id: 'free', name: 'Free' })).toMatchObject({
      canAdd: false,
      reason: 'no_price',
    });
    expect(getProductAvailability({ id: 'sold', name: 'Sold', retail_price: 500, in_stock: 0 })).toMatchObject({
      canAdd: false,
      reason: 'out_of_stock',
    });
  });

  it('blocks weighted products at the kiosk even with stock, price, and oversell', () => {
    expect(getProductAvailability(
      { id: 'meat', name: 'Thit ba chi', retail_price: 3500, in_stock: 8, sell_by: 'WEIGHT' },
      { allowOversell: true },
    )).toMatchObject({
      canAdd: false,
      reason: 'weighted',
    });
    expect(getProductAvailability(
      { id: 'piece', name: 'Cola', retail_price: 500, in_stock: 8, sell_by: 'PIECE' },
    )).toMatchObject({ canAdd: true, reason: null });
  });

  it('allows sold-out products only when oversell is enabled', () => {
    expect(getProductAvailability(
      { id: 'sold-off', name: 'Sold off', retail_price: 500, in_stock: 0 },
      { allowOversell: false },
    )).toMatchObject({
      canAdd: false,
      reason: 'out_of_stock',
      stock: 0,
    });

    expect(getProductAvailability(
      { id: 'sold-on', name: 'Sold on', retail_price: 500, in_stock: -2 },
      { allowOversell: true },
    )).toMatchObject({
      canAdd: true,
      reason: null,
      stock: -2,
    });
  });

  it('keeps no-price products unavailable even when oversell is enabled', () => {
    expect(getProductAvailability(
      { id: 'free-sold', name: 'Free sold', in_stock: -1 },
      { allowOversell: true },
    )).toMatchObject({
      canAdd: false,
      reason: 'no_price',
      priceGrosze: 0,
      stock: -1,
    });
  });
});
