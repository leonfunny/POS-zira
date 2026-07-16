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
  sale_unit?: string | null;
  sell_by?: 'PIECE' | 'WEIGHT' | string | null;
  // Item kind + tracking flag (migration v53). NULL/absent = stockable+tracked.
  // 'service'/'consumable' (or track_inventory=0) hide every stock affordance.
  item_type?: string | null;
  track_inventory?: number | null;
  // Translation map (migration v28). JSON string of `{lang: name}`.
  // Orders/fiscal payloads use canonical `name`; paper receipts localize
  // separately at print time.
  name_translations?: string | null;
  // Renderer-only marker: this row came from `draft_products`, not
  // `product_variants`. Clicking it must route to the scan-import flow
  // (creates a real variant on the server first) instead of adding to
  // the cart directly. Never persisted, never sent over IPC.
  _isDraft?: boolean;
}

export interface Category {
  id: string;
  name: string;
  image_url: string | null;
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
