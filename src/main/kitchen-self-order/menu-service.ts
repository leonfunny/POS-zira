import {
  normalizeKitchenSelfOrderAccentColor,
  normalizeKitchenSelfOrderCheckoutMode,
  normalizeKitchenSelfOrderReleasePolicy,
  resolveKitchenSelfOrderMenuSource,
  resolveKitchenSelfOrderBrandName,
  type KitchenSelfOrderMenu,
  type KitchenSelfOrderModifierGroup,
  type KitchenSelfOrderProductMedia,
} from '../../shared/kitchen-self-order';
import type {
  CategoryRow,
  ProductVariantRow,
} from '../database/repos/product-repo';

interface KitchenSelfOrderMenuConfig {
  kitchenSelfOrderBrandName?: string | null;
  kitchenSelfOrderLogoUrl?: string | null;
  kitchenSelfOrderAccentColor?: string | null;
  kitchenSelfOrderCheckoutMode?: string | null;
  kitchenSelfOrderReleasePolicy?: string | null;
  kitchenSelfOrderMenuSource?: string | null;
  kitchenSelfOrderFulfillmentOptions?: unknown;
  salonName?: string | null;
  authUser?: { salonName?: string | null } | null;
}

interface BuildKitchenSelfOrderMenuInput {
  config: KitchenSelfOrderMenuConfig;
  categories: CategoryRow[];
  products: ProductVariantRow[];
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function clampUnit(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function normalizeFulfillmentOptions(value: unknown): Array<'DINE_IN' | 'TAKEAWAY'> {
  if (!Array.isArray(value)) return ['DINE_IN', 'TAKEAWAY'];
  const options = value.filter((item): item is 'DINE_IN' | 'TAKEAWAY' =>
    item === 'DINE_IN' || item === 'TAKEAWAY');
  return [...new Set(options)].slice(0, 2).length > 0
    ? [...new Set(options)].slice(0, 2)
    : ['DINE_IN', 'TAKEAWAY'];
}

function parseMedia(product: ProductVariantRow): KitchenSelfOrderProductMedia {
  const fallbackUrl = product.thumbnail_url || product.image_url || null;
  const parsed = parseJson(product.kiosk_media_json);
  if (!parsed || typeof parsed !== 'object') {
    return {
      url: fallbackUrl,
      fit: 'CONTAIN',
      focalPoint: null,
      zoom: 1,
    };
  }

  const media = parsed as Record<string, unknown>;
  const url = String(media.url || fallbackUrl || '').trim() || null;
  const focal = media.focalPoint && typeof media.focalPoint === 'object'
    ? media.focalPoint as Record<string, unknown>
    : null;
  return {
    url,
    fit: media.fit === 'COVER' ? 'COVER' : 'CONTAIN',
    focalPoint: focal
      ? {
        x: clampUnit(focal.x, 0.5),
        y: clampUnit(focal.y, 0.5),
      }
      : null,
    zoom: Math.min(2, Math.max(1, Number(media.zoom) || 1)),
  };
}

function parseModifierGroups(value: string | null | undefined): KitchenSelfOrderModifierGroup[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  const groups: KitchenSelfOrderModifierGroup[] = [];

  for (const rawGroup of parsed) {
    if (!rawGroup || typeof rawGroup !== 'object') continue;
    const group = rawGroup as Record<string, any>;
    const id = String(group.id || '').trim().slice(0, 80);
    const name = String(group.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const options = Array.isArray(group.options)
      ? group.options
        .map((rawOption: any) => ({
          id: String(rawOption?.id || '').trim().slice(0, 80),
          name: String(rawOption?.name || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          nameTranslations: typeof rawOption?.nameTranslations === 'string'
            ? rawOption.nameTranslations
            : null,
          priceDeltaGrosze: Math.min(
            100_000,
            Math.max(-100_000, Math.round(Number(rawOption?.priceDeltaGrosze) || 0)),
          ),
          isDefault: rawOption?.isDefault === true,
          isAvailable: rawOption?.isAvailable !== false,
          maxQuantity: rawOption?.maxQuantity == null
            ? null
            : Math.min(9, Math.max(1, Math.floor(Number(rawOption.maxQuantity) || 1))),
        }))
        .filter((option) => option.id && option.name)
        .slice(0, 40)
      : [];
    if (!id || !name || options.length === 0) continue;

    const selectionMode = group.selectionMode === 'MULTIPLE' ? 'MULTIPLE' : 'SINGLE';
    const maxAllowed = selectionMode === 'SINGLE' ? 1 : options.length;
    const maxSelections = Math.min(
      maxAllowed,
      Math.max(1, Math.floor(Number(group.maxSelections) || maxAllowed)),
    );
    const minSelections = Math.min(
      maxSelections,
      Math.max(0, Math.floor(Number(group.minSelections) || 0)),
    );
    groups.push({
      id,
      name,
      nameTranslations: typeof group.nameTranslations === 'string' ? group.nameTranslations : null,
      selectionMode,
      minSelections,
      maxSelections,
      displayOrder: Math.floor(Number(group.displayOrder) || 0),
      allowOptionQuantity: selectionMode === 'MULTIPLE' && group.allowOptionQuantity === true,
      options,
    });
    if (groups.length >= 24) break;
  }

  return groups.sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
}

function sortCategoriesByRank(categories: CategoryRow[]): CategoryRow[] {
  return [...categories].sort((a, b) =>
    (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
}

// `categories` must already include the local KSO preference overlay.
function getKitchenCatalog(
  config: KitchenSelfOrderMenuConfig,
  categories: CategoryRow[],
  products: ProductVariantRow[],
): { categories: CategoryRow[]; products: ProductVariantRow[] } {
  const rankedCategories = sortCategoriesByRank(categories);
  if (resolveKitchenSelfOrderMenuSource(config, categories) === 'all') {
    return { categories: rankedCategories, products };
  }
  const kitchenCategoryIds = new Set(
    rankedCategories.filter((category) => category.kitchen_print === 1).map((category) => category.id),
  );
  return {
    categories: rankedCategories.filter((category) => kitchenCategoryIds.has(category.id)),
    products: products.filter((product) =>
      !!product.category_id && kitchenCategoryIds.has(product.category_id)),
  };
}

export function buildKitchenSelfOrderMenu({
  config,
  categories,
  products,
}: BuildKitchenSelfOrderMenuInput): KitchenSelfOrderMenu {
  const catalog = getKitchenCatalog(config, categories, products);
  const categoryById = new Map(catalog.categories.map((category) => [category.id, category]));
  const modifierGroups: KitchenSelfOrderModifierGroup[] = [];
  const categoryGroups = new Map<string, KitchenSelfOrderModifierGroup[]>();

  const attachGroup = (
    group: KitchenSelfOrderModifierGroup,
    attachmentId: string,
  ): KitchenSelfOrderModifierGroup => {
    const attached = { ...group, attachmentId };
    modifierGroups.push(attached);
    return attached;
  };

  for (const category of catalog.categories) {
    const groups = parseModifierGroups(category.kiosk_modifier_groups_json)
      .map((group) => attachGroup(group, `category:${category.id}:${group.id}`));
    categoryGroups.set(category.id, groups);
  }

  const menuProducts = catalog.products
    .filter((product) => product.is_active !== 0)
    .map((product) => {
      const inheritedGroups = product.category_id
        ? categoryGroups.get(product.category_id) || []
        : [];
      const directGroups = parseModifierGroups(product.kiosk_modifier_groups_json);
      const directGroupIds = new Set(directGroups.map((group) => group.id));
      const effectiveInheritedGroups = inheritedGroups.filter((group) =>
        !directGroupIds.has(group.id));
      const attachedDirectGroups = directGroups.map((group) =>
        attachGroup(group, `product:${product.id}:${group.id}`));
      return {
        id: product.id,
        templateId: product.template_id || null,
        categoryId: product.category_id || null,
        name: product.name,
        nameTranslations: product.name_translations || null,
        priceGrosze: Math.max(
          0,
          Math.round(Number(product.retail_price || product.price_gross) || 0),
        ),
        media: parseMedia(product),
        modifierGroupAttachmentIds: [
          ...effectiveInheritedGroups,
          ...attachedDirectGroups,
        ].map((group) => group.attachmentId!),
        noteEnabled: product.kiosk_note_enabled === 1,
      };
    })
    .sort((a, b) => {
      const aCategory = a.categoryId ? categoryById.get(a.categoryId) : null;
      const bCategory = b.categoryId ? categoryById.get(b.categoryId) : null;
      const categoryOrder = (aCategory?.sort_order || 0) - (bCategory?.sort_order || 0);
      return categoryOrder || a.name.localeCompare(b.name);
    });

  return {
    version: 1,
    brand: {
      name: resolveKitchenSelfOrderBrandName(config),
      logoUrl: String(config.kitchenSelfOrderLogoUrl || '').trim() || null,
      accentColor: normalizeKitchenSelfOrderAccentColor(config.kitchenSelfOrderAccentColor),
    },
    policies: {
      checkoutMode: normalizeKitchenSelfOrderCheckoutMode(config.kitchenSelfOrderCheckoutMode),
      kitchenReleasePolicy: normalizeKitchenSelfOrderReleasePolicy(config.kitchenSelfOrderReleasePolicy),
      fulfillmentOptions: normalizeFulfillmentOptions(
        config.kitchenSelfOrderFulfillmentOptions,
      ),
    },
    categories: catalog.categories.map((category) => ({
      id: category.id,
      name: category.name,
      nameTranslations: category.name_translations || null,
      displayOrder: category.sort_order || 0,
    })),
    products: menuProducts,
    modifierGroups: modifierGroups
      .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name)),
  };
}
