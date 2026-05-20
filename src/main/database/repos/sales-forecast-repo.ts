import { database } from '../database';

const HIDE_TEMPLATES_WITH_VARIANTS = `
  AND pv.id NOT IN (
    SELECT DISTINCT child.template_id
    FROM product_variants child
    WHERE child.template_id IS NOT NULL AND child.is_active = 1
  )
`;

export interface ForecastSalesRow {
  variant_id: string;
  sale_date: string;
  units: number;
  revenue: number;
}

export interface ForecastProductSnapshot {
  variantId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  categoryId: string | null;
  categoryName: string | null;
  retailPrice: number;
  stockOnHand: number;
}

export interface ItemSalesSummaryRow {
  variantId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  categoryId: string | null;
  categoryName: string | null;
  quantity: number;
  revenue: number;
  orderCount: number;
  avgUnitPrice: number;
  stockOnHand: number;
  lastSoldAt: string | null;
}

export interface ItemDailySalesRow {
  itemKey: string;
  saleDate: string;
  units: number;
}

function mapProductRow(row: any): ForecastProductSnapshot {
  return {
    variantId: String(row.variant_id),
    name: String(row.name || ''),
    sku: row.sku ?? null,
    barcode: row.barcode ?? null,
    categoryId: row.category_id ?? null,
    categoryName: row.category_name ?? null,
    retailPrice: Number(row.retail_price) || 0,
    stockOnHand: Math.max(0, Math.round(Number(row.stock_on_hand) || 0)),
  };
}

export const salesForecastRepo = {
  getOrderCount(startDate: string, endDate: string): number {
    return database.get<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM orders
       WHERE date(created_at) BETWEEN date(?) AND date(?)`,
      [startDate, endDate],
    )?.count ?? 0;
  },

  getItemSalesSummary(startDate: string, endDate: string): ItemSalesSummaryRow[] {
    return database.all<any>(
      `SELECT
          COALESCE(oi.variant_id, 'manual:' || lower(trim(COALESCE(oi.sku, '') || ':' || COALESCE(oi.name, '')))) AS item_key,
          COALESCE(pv.name, oi.name) AS name,
          COALESCE(pv.sku, oi.sku) AS sku,
          pv.barcode,
          pv.category_id,
          c.name AS category_name,
          SUM(oi.quantity) AS quantity,
          SUM(oi.total) AS revenue,
          COUNT(DISTINCT oi.order_id) AS order_count,
          CASE WHEN SUM(oi.quantity) > 0 THEN ROUND(SUM(oi.total) * 1.0 / SUM(oi.quantity)) ELSE 0 END AS avg_unit_price,
          COALESCE(pv.available_qty, pv.in_stock, 0) AS stock_on_hand,
          MAX(o.created_at) AS last_sold_at
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN product_variants pv ON pv.id = oi.variant_id
       LEFT JOIN categories c ON c.id = pv.category_id
       WHERE date(o.created_at) BETWEEN date(?) AND date(?)
         AND COALESCE(o.status, 'COMPLETED') NOT IN ('CANCELLED', 'REFUNDED', 'VOID')
       GROUP BY item_key, COALESCE(pv.name, oi.name), COALESCE(pv.sku, oi.sku), pv.barcode, pv.category_id, c.name
       ORDER BY quantity DESC, revenue DESC, name ASC`,
      [startDate, endDate],
    ).map((row) => ({
      variantId: String(row.item_key),
      name: String(row.name || ''),
      sku: row.sku ?? null,
      barcode: row.barcode ?? null,
      categoryId: row.category_id ?? null,
      categoryName: row.category_name ?? null,
      quantity: Number(row.quantity) || 0,
      revenue: Number(row.revenue) || 0,
      orderCount: Number(row.order_count) || 0,
      avgUnitPrice: Number(row.avg_unit_price) || 0,
      stockOnHand: Math.max(0, Math.round(Number(row.stock_on_hand) || 0)),
      lastSoldAt: row.last_sold_at ?? null,
    }));
  },

  getDailyItemSales(startDate: string, endDate: string): ItemDailySalesRow[] {
    return database.all<any>(
      `SELECT
          COALESCE(oi.variant_id, 'manual:' || lower(trim(COALESCE(oi.sku, '') || ':' || COALESCE(oi.name, '')))) AS item_key,
          date(o.created_at) AS sale_date,
          SUM(oi.quantity) AS units
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE date(o.created_at) BETWEEN date(?) AND date(?)
         AND COALESCE(o.status, 'COMPLETED') NOT IN ('CANCELLED', 'REFUNDED', 'VOID')
       GROUP BY item_key, date(o.created_at)
       ORDER BY sale_date ASC`,
      [startDate, endDate],
    ).map((row) => ({
      itemKey: String(row.item_key),
      saleDate: String(row.sale_date),
      units: Number(row.units) || 0,
    }));
  },

  getDailySales(startDate: string, endDate: string, categoryId?: string): ForecastSalesRow[] {
    const params: any[] = [startDate, endDate];
    const categoryClause = categoryId ? 'AND pv.category_id = ?' : '';
    if (categoryId) params.push(categoryId);

    return database.all<ForecastSalesRow>(
      `SELECT
          oi.variant_id,
          date(o.created_at) AS sale_date,
          SUM(oi.quantity) AS units,
          SUM(oi.total) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN product_variants pv ON pv.id = oi.variant_id
       WHERE oi.variant_id IS NOT NULL
         AND date(o.created_at) BETWEEN date(?) AND date(?)
         AND COALESCE(o.status, 'COMPLETED') NOT IN ('CANCELLED', 'REFUNDED', 'VOID')
         ${categoryClause}
       GROUP BY oi.variant_id, date(o.created_at)
       ORDER BY sale_date ASC`,
      params,
    ).map((row) => ({
      variant_id: row.variant_id,
      sale_date: row.sale_date,
      units: Number(row.units) || 0,
      revenue: Number(row.revenue) || 0,
    }));
  },

  getProductSnapshots(categoryId?: string): ForecastProductSnapshot[] {
    const params: any[] = [];
    const categoryClause = categoryId ? 'AND pv.category_id = ?' : '';
    if (categoryId) params.push(categoryId);

    return database.all<any>(
      `SELECT
          pv.id AS variant_id,
          pv.name,
          pv.sku,
          pv.barcode,
          pv.category_id,
          c.name AS category_name,
          pv.retail_price,
          COALESCE(pv.available_qty, pv.in_stock, 0) AS stock_on_hand
       FROM product_variants pv
       LEFT JOIN categories c ON c.id = pv.category_id
       WHERE pv.is_active = 1
         ${HIDE_TEMPLATES_WITH_VARIANTS}
         ${categoryClause}
       ORDER BY pv.name`,
      params,
    ).map(mapProductRow);
  },
};
