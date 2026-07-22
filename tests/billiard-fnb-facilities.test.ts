import { describe, expect, it } from 'vitest';
import {
  HOME_KEY,
  filterProductsByFacility,
  groupCategoriesByFacility,
  isProductInFacility,
  parseFacilityTag,
  stripFacilityPrefix,
} from '../src/renderer/components/billiard/fnb-facilities';

const CATEGORIES = [
  { id: 'c-club', name: 'Napoje' },
  { id: 'c-m1-bread', name: 'M1 · Bánh mì' },
  { id: 'c-m2-tea', name: 'M2 · Trà sữa' },
  { id: 'c-m1-burger', name: 'M1 · Burger' },
  { id: 'c-other', name: 'ZZ · Quán lạ' },
];

describe('billiard F&B facility tag parsing', () => {
  it('extracts only a compact tag before the exact separator', () => {
    expect(parseFacilityTag('M1 · Bánh mì')).toBe('M1');
    expect(parseFacilityTag('M2 · Trà · Sữa')).toBe('M2');
    expect(parseFacilityTag('M1·Bánh mì')).toBeNull();
    expect(parseFacilityTag(' · Empty')).toBeNull();
    expect(parseFacilityTag('TagOverTwelveChars · X')).toBeNull();
  });

  it('strips tagged prefixes without changing ordinary category names', () => {
    expect(stripFacilityPrefix('M1 · Bánh mì')).toBe('Bánh mì');
    expect(stripFacilityPrefix('M2 · Trà · Sữa')).toBe('Trà · Sữa');
    expect(stripFacilityPrefix('Napoje')).toBe('Napoje');
  });
});

describe('billiard F&B facility grouping', () => {
  it('keeps HOME first and tagged facilities in first-seen order', () => {
    const grouping = groupCategoriesByFacility(CATEGORIES);

    expect(grouping.facilities.map((facility) => facility.key)).toEqual([
      HOME_KEY,
      'M1',
      'M2',
      'ZZ',
    ]);
    expect(grouping.hasTags).toBe(true);
  });

  it('uses known facility labels, a safe fallback, and clean category labels', () => {
    const grouping = groupCategoriesByFacility(CATEGORIES);
    const byKey = Object.fromEntries(
      grouping.facilities.map((facility) => [facility.key, facility]),
    );

    expect(byKey[HOME_KEY].label).toBe('Bi-a');
    expect(byKey.M1.label).toBe('Bánh mì · Tầng 1');
    expect(byKey.M2.label).toBe('Trà sữa · Tầng 3');
    expect(byKey.ZZ.label).toBe('ZZ');
    expect(byKey.M1.categories.map((category) => category.name)).toEqual([
      'Bánh mì',
      'Burger',
    ]);
    expect(byKey[HOME_KEY].categories.map((category) => category.name)).toEqual([
      'Napoje',
    ]);
  });

  it('falls back to one HOME group when a salon does not use facility tags', () => {
    const grouping = groupCategoriesByFacility([{ id: 'c1', name: 'Napoje' }]);

    expect(grouping.hasTags).toBe(false);
    expect(grouping.facilities.map((facility) => facility.key)).toEqual([HOME_KEY]);
  });
});

describe('billiard F&B facility filtering', () => {
  const grouping = groupCategoriesByFacility(CATEGORIES);
  const products = [
    { id: 'club', category_id: 'c-club' },
    { id: 'm1-snake', category_id: 'c-m1-bread' },
    { id: 'm1-camel', categoryId: 'c-m1-burger' },
    { id: 'm2', category_id: 'c-m2-tea' },
    { id: 'uncategorised', category_id: null },
    { id: 'orphan', category_id: 'deleted-category' },
  ];

  it('keeps uncategorised, ordinary, and orphan products in HOME', () => {
    expect(
      filterProductsByFacility(products, HOME_KEY, grouping).map((product) => product.id),
    ).toEqual(['club', 'uncategorised', 'orphan']);
  });

  it('supports the POS snake_case category id and API camelCase alias', () => {
    expect(
      filterProductsByFacility(products, 'M1', grouping).map((product) => product.id),
    ).toEqual(['m1-snake', 'm1-camel']);
    expect(
      filterProductsByFacility(products, 'M2', grouping).map((product) => product.id),
    ).toEqual(['m2']);
  });

  it('returns no products for an unknown facility', () => {
    expect(filterProductsByFacility(products, 'NOPE', grouping)).toEqual([]);
    expect(isProductInFacility('c-m1-bread', 'NOPE', grouping)).toBe(false);
  });

  it('does not filter catalogues that have no facility-tag convention', () => {
    const untagged = groupCategoriesByFacility([{ id: 'c-club', name: 'Napoje' }]);

    expect(filterProductsByFacility(products, HOME_KEY, untagged)).toBe(products);
  });
});
