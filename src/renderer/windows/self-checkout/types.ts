export interface SearchProduct {
  id: string;
  template_id?: string | null;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  category_id?: string | null;
  /** PIECE | WEIGHT — weighted products need a scale and are sold at the
   *  staffed counter, never at the kiosk. */
  sell_by?: string | null;
  sale_unit?: string | null;
  retail_price?: number;
  price?: number;
  price_gross?: number;
  vat_rate?: number;
  image_url?: string | null;
  thumbnail_url?: string | null;
  in_stock?: number;
  available_qty?: number;
  name_translations?: string | null;
}

export interface CatalogCategory {
  id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  sort_order?: number;
  name_translations?: string | null;
  kitchen_print?: number | null;
}

export type CatalogDepartment = 'grocery' | 'kitchen';
