export interface SessionItemLike {
  id?: string | null;
  variantId?: string | null;
  name?: string | null;
  quantity?: unknown;
  unitPrice?: unknown;
  totalPrice?: unknown;
  addedAt?: unknown;
}

export interface GroupedSessionItem<
  TItem extends SessionItemLike = SessionItemLike,
> {
  key: string;
  id: string;
  variantId: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  rawItems: TItem[];
  sourceItemIds: string[];
}

function parseNumberish(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/\s+/g, '').replace(',', '.');
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeVariantId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizePrice(value: unknown): {
  cents: number;
  amount: number;
} {
  const parsed = parseNumberish(value) ?? 0;
  const cents = Math.round(parsed * 100);
  return { cents, amount: cents / 100 };
}

function normalizeQuantity(value: unknown, fallback = 1): number {
  const parsed = parseNumberish(value);
  const safe = parsed == null ? fallback : Math.max(0, parsed);
  return Math.round(safe * 1000) / 1000;
}

function normalizeTotalPrice(
  item: SessionItemLike,
  quantity: number,
  unitPrice: number,
): number {
  const explicitTotal = parseNumberish(item.totalPrice);
  const total = explicitTotal == null ? quantity * unitPrice : explicitTotal;
  return Math.round(total * 100) / 100;
}

function getItemId(item: SessionItemLike): string | null {
  if (typeof item.id !== 'string') return null;
  const normalized = item.id.trim();
  return normalized || null;
}

/**
 * Group only canonical catalogue lines with the same variant and unit price.
 * Raw/custom lines have no variant, so their persisted item id remains their
 * grouping boundary and two manually-entered lines never merge by accident.
 */
export function groupSessionItems<TItem extends SessionItemLike>(
  items: readonly TItem[] | null | undefined,
): GroupedSessionItem<TItem>[] {
  if (!items?.length) return [];

  const groups: GroupedSessionItem<TItem>[] = [];
  const groupByKey = new Map<string, GroupedSessionItem<TItem>>();

  items.forEach((item, index) => {
    const variantId = normalizeVariantId(item.variantId);
    const itemId = getItemId(item);
    const price = normalizePrice(item.unitPrice);
    const key = variantId
      ? `variant:${variantId.toLowerCase()}:price:${price.cents}`
      : `item:${itemId ?? `missing-${index}`}`;
    const quantity = normalizeQuantity(item.quantity);
    const totalPrice = normalizeTotalPrice(item, quantity, price.amount);
    const existing = groupByKey.get(key);

    if (existing) {
      existing.quantity = normalizeQuantity(existing.quantity + quantity, 0);
      existing.totalPrice =
        Math.round((existing.totalPrice + totalPrice) * 100) / 100;
      existing.rawItems.push(item);
      if (itemId) existing.sourceItemIds.push(itemId);
      if (existing.name === 'Item' && item.name?.trim()) {
        existing.name = item.name.trim();
      }
      return;
    }

    const group: GroupedSessionItem<TItem> = {
      key,
      id: itemId ?? key,
      variantId,
      name: item.name?.trim() || 'Item',
      quantity,
      unitPrice: price.amount,
      totalPrice,
      rawItems: [item],
      sourceItemIds: itemId ? [itemId] : [],
    };

    groups.push(group);
    groupByKey.set(key, group);
  });

  return groups;
}

export function getTotalSessionItemQuantity(
  groups: readonly GroupedSessionItem[] | null | undefined,
): number {
  if (!groups?.length) return 0;
  return normalizeQuantity(
    groups.reduce((sum, group) => sum + normalizeQuantity(group.quantity), 0),
    0,
  );
}

export function findVariantPriceSessionItemGroup<
  TItem extends SessionItemLike,
>(
  groups: readonly GroupedSessionItem<TItem>[] | null | undefined,
  variantId: string | null | undefined,
  unitPrice: unknown,
): GroupedSessionItem<TItem> | undefined {
  const normalizedVariantId = normalizeVariantId(variantId)?.toLowerCase();
  if (!normalizedVariantId || !groups?.length) return undefined;
  const normalizedUnitPrice = normalizePrice(unitPrice).amount;

  return groups.find(
    (group) =>
      normalizeVariantId(group.variantId)?.toLowerCase() === normalizedVariantId
      && normalizePrice(group.unitPrice).amount === normalizedUnitPrice,
  );
}

/**
 * Select one positive source line deterministically. Catalogue rows grouped by
 * variant + unit price are billing-equivalent, while the local cache does not
 * retain a reliable creation timestamp for choosing a chronological "newest"
 * row. Stable id ordering keeps repeated taps and tests predictable.
 */
export function pickSessionItemForDecrement<
  TItem extends SessionItemLike,
>(
  group: GroupedSessionItem<TItem> | null | undefined,
): TItem | undefined {
  if (!group) return undefined;

  return group.rawItems
    .filter((item) => normalizeQuantity(item.quantity, 0) > 0)
    .sort((left, right) =>
      String(getItemId(right) || '').localeCompare(
        String(getItemId(left) || ''),
      ))[0];
}

export function formatSessionItemQuantity(quantity: unknown): string {
  const normalized = normalizeQuantity(quantity, 0);
  return normalized.toFixed(3).replace(/\.?0+$/, '');
}
