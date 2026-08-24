import { database } from './database';
import { productRepo, ProductVariantRow, CategoryRow } from './repos/product-repo';
import { tableRepo, TableRow } from './repos/table-repo';
import { customerRepo, CustomerRow } from './repos/customer-repo';
import { staffRepo, StaffRow } from './repos/staff-repo';
import logger from '../logger';

const SEED_CATEGORIES: CategoryRow[] = [
  { id: 'cat-demo', name: 'Demo / Mẫu', image_url: null, icon: '🏷️', color: '#8B5CF6', sort_order: 1, updated_at: null },
];

// Helper to add enriched field defaults to seed products
const seedProduct = (p: Omit<ProductVariantRow, 'available_qty' | 'price_gross' | 'price_net' | 'vat_amount' | 'is_on_sale' | 'thumbnail_url' | 'sale_unit' | 'sell_by'>): ProductVariantRow => ({
  ...p,
  available_qty: p.in_stock,
  price_gross: p.retail_price,
  price_net: Math.round(p.retail_price * 100 / (100 + p.vat_rate)),
  vat_amount: p.retail_price - Math.round(p.retail_price * 100 / (100 + p.vat_rate)),
  is_on_sale: 0,
  thumbnail_url: null,
  sale_unit: 'szt.',
  sell_by: 'PIECE',
});

const SEED_PRODUCTS: ProductVariantRow[] = ([
  {
    id: 'demo-sample-1',
    template_id: null,
    name: '[DEMO] Sản phẩm mẫu / Sample Item',
    sku: 'DEMO-001',
    barcode: '88888888',
    retail_price: 1000,
    category_id: 'cat-demo',
    image_url: null,
    in_stock: 99,
    vat_rate: 23,
    is_active: 1,
    updated_at: null,
  },
] as const).map(seedProduct);

const SEED_TABLES: TableRow[] = [
  { id: 'tbl-1', name: 'Stolik 1', zone: 'Sala', capacity: 4, sort_order: 1, is_active: 1, status: 'free', current_order_id: null, covers: 0, opened_at: null },
  { id: 'tbl-2', name: 'Stolik 2', zone: 'Sala', capacity: 4, sort_order: 2, is_active: 1, status: 'free', current_order_id: null, covers: 0, opened_at: null },
  { id: 'tbl-3', name: 'Stolik 3', zone: 'Sala', capacity: 6, sort_order: 3, is_active: 1, status: 'free', current_order_id: null, covers: 0, opened_at: null },
  { id: 'tbl-4', name: 'Stolik 4', zone: 'Sala', capacity: 2, sort_order: 4, is_active: 1, status: 'free', current_order_id: null, covers: 0, opened_at: null },
  { id: 'tbl-5', name: 'Stolik 5', zone: 'Sala', capacity: 8, sort_order: 5, is_active: 1, status: 'free', current_order_id: null, covers: 0, opened_at: null },
  { id: 'tbl-6', name: 'Stolik 6', zone: 'Sala', capacity: 4, sort_order: 6, is_active: 1, status: 'free', current_order_id: null, covers: 0, opened_at: null },
  { id: 'tbl-b1', name: 'Bar 1', zone: 'Bar', capacity: 2, sort_order: 10, is_active: 1, status: 'free', current_order_id: null, covers: 0, opened_at: null },
  { id: 'tbl-b2', name: 'Bar 2', zone: 'Bar', capacity: 2, sort_order: 11, is_active: 1, status: 'free', current_order_id: null, covers: 0, opened_at: null },
];

const SEED_CUSTOMERS: CustomerRow[] = [
  { id: 'cust-1', name: 'Salon ABC sp. z o.o.', nip: '1234567890', email: 'abc@example.com', phone: '+48500100200', credit_limit: 500000, current_debt: 120000, payment_terms: 14, updated_at: null },
  { id: 'cust-2', name: 'Beauty Studio Maria', nip: '9876543210', email: 'maria@beauty.pl', phone: '+48600300400', credit_limit: 200000, current_debt: 0, payment_terms: 7, updated_at: null },
  { id: 'cust-3', name: 'Nail Expert Jan Kowalski', nip: '5551234567', email: 'jan@nailexpert.pl', phone: '+48700500600', credit_limit: 100000, current_debt: 85000, payment_terms: 30, updated_at: null },
];

const SEED_STAFF: StaffRow[] = [
  { id: 'staff-1', name: 'Anna Kowalska', commission_rate: 1500, is_active: 1, updated_at: null },   // 15%
  { id: 'staff-2', name: 'Maria Wiśniewska', commission_rate: 1200, is_active: 1, updated_at: null }, // 12%
  { id: 'staff-3', name: 'Katarzyna Nowak', commission_rate: 1000, is_active: 1, updated_at: null },  // 10%
  { id: 'staff-4', name: 'Ewa Zielińska', commission_rate: 2000, is_active: 1, updated_at: null },    // 20%
];

export function seedIfEmpty(): void {
  const count = database.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM product_variants');
  if (count && count.cnt > 0) {
    logger.info(`[Seed] Database already has ${count.cnt} products, skipping product seed`);
  } else {
    productRepo.upsertCategories(SEED_CATEGORIES);
    productRepo.upsertMany(SEED_PRODUCTS);
    logger.info(`[Seed] Seeded ${SEED_CATEGORIES.length} categories and ${SEED_PRODUCTS.length} products`);
  }

  // Seed mode-specific tables if empty
  const tableCount = database.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM pos_tables');
  if (!tableCount || tableCount.cnt === 0) {
    tableRepo.upsertMany(SEED_TABLES);
    logger.info(`[Seed] Seeded ${SEED_TABLES.length} restaurant tables`);
  }

  const customerCount = database.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM pos_customers');
  if (!customerCount || customerCount.cnt === 0) {
    customerRepo.upsertMany(SEED_CUSTOMERS);
    logger.info(`[Seed] Seeded ${SEED_CUSTOMERS.length} B2B customers`);
  }

  const staffCount = database.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM pos_staff');
  const seedDemoStaff = process.env.ZIRA_SEED_DEMO_STAFF === '1';
  if (seedDemoStaff && (!staffCount || staffCount.cnt === 0)) {
    staffRepo.upsertMany(SEED_STAFF);
    logger.info(`[Seed] Seeded ${SEED_STAFF.length} salon staff`);
  } else if (!seedDemoStaff && (!staffCount || staffCount.cnt === 0)) {
    logger.info('[Seed] Skipping demo salon staff seed; staff must come from backend or manual setup');
  }

  // 5s auto-save loop persists the seeded rows. Awaiting save() here would
  // block app startup behind a multi-megabyte disk write while the renderer
  // is waiting for the main window.
  database.markDirty();
}
