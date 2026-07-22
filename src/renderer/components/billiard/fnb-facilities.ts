/**
 * Two-tier grouping for the billiard F&B catalogue.
 *
 * A category named "TAG · Name" belongs to facility TAG. Categories without
 * the prefix, uncategorised products, and products whose category disappeared
 * stay in HOME. Salons that do not use this naming convention keep the legacy
 * one-row category browser.
 */

export interface FnbCategory {
  id: string;
  name: string;
}

export interface FacilityGroup {
  key: string;
  label: string;
  icon: string;
  categoryIds: Set<string>;
  categories: FnbCategory[];
}

export interface FacilityGrouping {
  facilities: FacilityGroup[];
  hasTags: boolean;
  taggedCategoryIds: Set<string>;
}

export interface FnbCatalogProduct {
  category_id?: string | null;
  categoryId?: string | null;
}

export const HOME_KEY = 'HOME';

const SEPARATOR = ' · ';
const MAX_TAG_LENGTH = 12;

export const FACILITY_META: Record<string, { label: string; icon: string }> = {
  [HOME_KEY]: { label: 'Bi-a', icon: '🎱' },
  M1: { label: 'Bánh mì · Tầng 1', icon: '🥖' },
  M2: { label: 'Trà sữa · Tầng 3', icon: '🧋' },
};

export function parseFacilityTag(name: string): string | null {
  const idx = (name ?? '').indexOf(SEPARATOR);
  if (idx <= 0) return null;

  const tag = name.slice(0, idx).trim();
  if (!tag || tag.length > MAX_TAG_LENGTH) return null;
  return tag;
}

export function stripFacilityPrefix(name: string): string {
  if (parseFacilityTag(name) === null) return name;

  const rest = name.slice(name.indexOf(SEPARATOR) + SEPARATOR.length).trim();
  return rest || name;
}

export function groupCategoriesByFacility(
  categories: FnbCategory[],
): FacilityGrouping {
  const home: FacilityGroup = {
    key: HOME_KEY,
    label: FACILITY_META[HOME_KEY].label,
    icon: FACILITY_META[HOME_KEY].icon,
    categoryIds: new Set(),
    categories: [],
  };
  const tagged = new Map<string, FacilityGroup>();
  const taggedCategoryIds = new Set<string>();

  for (const category of categories ?? []) {
    const tag = parseFacilityTag(category?.name ?? '');
    if (tag === null) {
      home.categoryIds.add(category.id);
      home.categories.push(category);
      continue;
    }

    let group = tagged.get(tag);
    if (!group) {
      const meta = FACILITY_META[tag] ?? { label: tag, icon: '🏬' };
      group = {
        key: tag,
        label: meta.label,
        icon: meta.icon,
        categoryIds: new Set(),
        categories: [],
      };
      tagged.set(tag, group);
    }

    group.categoryIds.add(category.id);
    taggedCategoryIds.add(category.id);
    group.categories.push({
      ...category,
      name: stripFacilityPrefix(category.name),
    });
  }

  return {
    facilities: [home, ...tagged.values()],
    hasTags: tagged.size > 0,
    taggedCategoryIds,
  };
}

export function isProductInFacility(
  categoryId: string | null | undefined,
  facilityKey: string,
  grouping: FacilityGrouping,
): boolean {
  const normalizedCategoryId = categoryId || null;
  if (facilityKey === HOME_KEY) {
    return normalizedCategoryId === null
      || !grouping.taggedCategoryIds.has(normalizedCategoryId);
  }

  const facility = grouping.facilities.find((group) => group.key === facilityKey);
  return facility !== undefined
    && normalizedCategoryId !== null
    && facility.categoryIds.has(normalizedCategoryId);
}

export function getProductCategoryId(product: FnbCatalogProduct): string | null {
  const categoryId = product?.category_id ?? product?.categoryId ?? null;
  if (typeof categoryId !== 'string') return null;
  return categoryId.trim() || null;
}

export function filterProductsByFacility<T extends FnbCatalogProduct>(
  products: T[],
  facilityKey: string,
  grouping: FacilityGrouping,
): T[] {
  if (!grouping.hasTags) return products;

  return products.filter((product) =>
    isProductInFacility(getProductCategoryId(product), facilityKey, grouping));
}
