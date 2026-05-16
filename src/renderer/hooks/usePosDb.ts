// Types matching the SQLite row shapes from main process repos.
// These mirror ProductVariantRow and CategoryRow from main/database/repos.

export interface Product {
  id: string;
  template_id: string | null;
  name: string;
  sku: string | null;
  barcode: string | null;
  retail_price: number;       // grosze
  category_id: string | null;
  image_url: string | null;
  in_stock: number;
  vat_rate: number;
  is_active: number;
  updated_at: string | null;
  // Enriched fields (migration v14 — optional for backward compat)
  available_qty?: number;
  price_gross?: number;
  price_net?: number;
  vat_amount?: number;
  is_on_sale?: number;
  thumbnail_url?: string | null;
  // Display-only translation map (migration v28). JSON string of `{lang: name}`.
  // Receipts/fiscal payloads always use canonical `name` — never substitute this.
  name_translations?: string | null;
}

export interface Category {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sort_order: number;
  updated_at: string | null;
  // Display-only translation map (migration v28).
  name_translations?: string | null;
}

export interface DailyStats {
  order_count: number;
  total_sales: number;
  cash_total: number;
  card_total: number;
}
