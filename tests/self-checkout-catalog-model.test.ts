import { describe, expect, it } from 'vitest';
import {
  buildVisibleCategories,
  buildVisibleProducts,
  getCategoryDepartment,
  getProductAvailability,
  getProductPriceGrosze,
  getProductStock,
  normalizeCatalogText,
} from '../src/renderer/windows/self-checkout/catalog-model';
import type {
  CatalogCategory,
  SearchProduct,
} from '../src/renderer/windows/self-checkout/types';

const categories: CatalogCategory[] = [
  { id: 'grocery', name: 'Sklep' },
  { id: 'kitchen', name: 'Kuchnia' },
  { id: 'vi-food', name: 'Do an nhanh' },
];

const products: SearchProduct[] = [
  { id: 'cola', name: 'Cola', category_id: 'grocery', retail_price: 599, in_stock: 4 },
  { id: 'pho', name: 'Pho', category_id: 'kitchen', retail_price: 2500, available_qty: 10 },
  { id: 'banh-mi', name: 'Banh mi', category_id: 'vi-food', price_gross: 1800 },
];

describe('self-checkout catalog model', () => {
  it('normalizes accented catalog text for heuristic matching', () => {
    expect(normalizeCatalogText('Kuchnia Żółta Cà phê')).toBe('kuchnia zołta ca phe');
  });

  it('classifies kitchen/menu categories without UI code knowing the regex', () => {
    expect(getCategoryDepartment(categories[0])).toBe('grocery');
    expect(getCategoryDepartment(categories[1])).toBe('kitchen');
    expect(getCategoryDepartment(categories[2])).toBe('kitchen');
  });

  it('builds visible categories and products by department', () => {
    expect(buildVisibleCategories(categories, products, 'grocery').map((c) => c.id)).toEqual(['grocery']);
    expect(buildVisibleCategories(categories, products, 'kitchen').map((c) => c.id)).toEqual(['kitchen', 'vi-food']);
    expect(buildVisibleProducts(categories, products, 'kitchen', null).map((p) => p.id)).toEqual(['pho', 'banh-mi']);
    expect(buildVisibleProducts(categories, products, 'kitchen', 'vi-food').map((p) => p.id)).toEqual(['banh-mi']);
  });

  it('keeps price and stock normalization consistent across menu and search', () => {
    expect(getProductPriceGrosze({ id: 'a', name: 'A', price: 123.4 })).toBe(123);
    expect(getProductPriceGrosze({ id: 'b', name: 'B', price_gross: 456 })).toBe(456);
    expect(getProductPriceGrosze({ id: 'c', name: 'C' })).toBe(0);
    expect(getProductStock({ id: 'd', name: 'D', available_qty: 3 })).toBe(3);
    expect(getProductStock({ id: 'e', name: 'E' })).toBeUndefined();
  });

  it('marks no-price and sold-out products as unavailable for customer add actions', () => {
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
});
