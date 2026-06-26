import type { CategoryRow } from './product-repo';
import { database } from '../database';

export interface KitchenSelfOrderCategoryPrefRow {
  category_id: string;
  visible: number;
  sort_order: number | null;
  updated_at: string | null;
}

export interface KitchenSelfOrderCategoryOrderUpdate {
  id: string;
  sortOrder: number;
}

export interface KitchenSelfOrderCategoryPreferenceResult {
  categoryId: string;
  kitchenPrint: boolean;
  sortOrder: number | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeCategoryId(value: string): string {
  return String(value || '').trim();
}

function normalizeSortOrder(value: unknown): number | null {
  const sortOrder = Math.floor(Number(value));
  return Number.isFinite(sortOrder) && sortOrder >= 0 ? sortOrder : null;
}

function prefToResult(pref: KitchenSelfOrderCategoryPrefRow): KitchenSelfOrderCategoryPreferenceResult {
  return {
    categoryId: pref.category_id,
    kitchenPrint: pref.visible === 1,
    sortOrder: pref.sort_order ?? null,
  };
}

function getNextVisibleSortOrder(): number {
  const row = database.get<{ next_sort_order: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
     FROM kitchen_self_order_category_prefs
     WHERE visible = 1`,
  );
  return Math.max(0, Number(row?.next_sort_order) || 0);
}

export const kitchenSelfOrderCategoryPrefsRepo = {
  getAll(): KitchenSelfOrderCategoryPrefRow[] {
    return database.all<KitchenSelfOrderCategoryPrefRow>(
      `SELECT category_id, visible, sort_order, updated_at
       FROM kitchen_self_order_category_prefs`,
    );
  },

  getByCategoryId(categoryId: string): KitchenSelfOrderCategoryPrefRow | null {
    const id = normalizeCategoryId(categoryId);
    if (!id) return null;
    return database.get<KitchenSelfOrderCategoryPrefRow>(
      `SELECT category_id, visible, sort_order, updated_at
       FROM kitchen_self_order_category_prefs
       WHERE category_id = ?`,
      [id],
    );
  },

  applyToCategories(categories: CategoryRow[]): CategoryRow[] {
    const prefsByCategoryId = new Map(
      this.getAll().map((pref) => [pref.category_id, pref]),
    );

    return categories.map((category) => {
      const pref = prefsByCategoryId.get(category.id);
      if (!pref) {
        return {
          ...category,
          kitchen_print: 0,
        };
      }
      return {
        ...category,
        kitchen_print: pref.visible === 1 ? 1 : 0,
        sort_order: pref.visible === 1 && pref.sort_order != null
          ? pref.sort_order
          : category.sort_order,
      };
    }).sort((a, b) => {
      const aVisible = (a.kitchen_print ?? 0) === 1;
      const bVisible = (b.kitchen_print ?? 0) === 1;
      if (aVisible !== bVisible) return aVisible ? -1 : 1;
      return (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name);
    });
  },

  setVisible(categoryId: string, visible: boolean): KitchenSelfOrderCategoryPreferenceResult {
    const id = normalizeCategoryId(categoryId);
    if (!id) throw new Error('missing-category-id');

    const existing = this.getByCategoryId(id);
    const sortOrder = existing?.sort_order ?? (visible ? getNextVisibleSortOrder() : null);
    const updatedAt = nowIso();

    database.run(
      `INSERT INTO kitchen_self_order_category_prefs (category_id, visible, sort_order, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(category_id) DO UPDATE SET
         visible = excluded.visible,
         sort_order = COALESCE(kitchen_self_order_category_prefs.sort_order, excluded.sort_order),
         updated_at = excluded.updated_at`,
      [id, visible ? 1 : 0, sortOrder, updatedAt],
    );

    return prefToResult(this.getByCategoryId(id)!);
  },

  setSortOrders(updates: KitchenSelfOrderCategoryOrderUpdate[]): KitchenSelfOrderCategoryPreferenceResult[] {
    const normalized = updates
      .map((update) => ({
        id: normalizeCategoryId(update.id),
        sortOrder: normalizeSortOrder(update.sortOrder),
      }))
      .filter((update): update is { id: string; sortOrder: number } =>
        !!update.id && update.sortOrder != null);

    if (normalized.length === 0) return [];
    const updatedAt = nowIso();
    database.transaction(() => {
      for (const update of normalized) {
        database.run(
          `UPDATE kitchen_self_order_category_prefs
           SET sort_order = ?, updated_at = ?
           WHERE category_id = ? AND visible = 1`,
          [update.sortOrder, updatedAt, update.id],
        );
      }
    });

    return normalized
      .map((update) => this.getByCategoryId(update.id))
      .filter((pref): pref is KitchenSelfOrderCategoryPrefRow => !!pref && pref.visible === 1)
      .map(prefToResult);
  },
};
