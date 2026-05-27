import { database } from './database';
import { productRepo, ProductVariantRow, CategoryRow } from './repos/product-repo';
import { tableRepo, TableRow } from './repos/table-repo';
import { customerRepo, CustomerRow } from './repos/customer-repo';
import { staffRepo, StaffRow } from './repos/staff-repo';
import logger from '../logger';

const SEED_CATEGORIES: CategoryRow[] = [
  { id: 'cat-1', name: 'Paznokcie', icon: '💅', color: '#8B5CF6', sort_order: 1, updated_at: null },
  { id: 'cat-2', name: 'Włosy', icon: '💇', color: '#EC4899', sort_order: 2, updated_at: null },
  { id: 'cat-3', name: 'Kosmetyki', icon: '🧴', color: '#06B6D4', sort_order: 3, updated_at: null },
  { id: 'cat-4', name: 'Akcesoria', icon: '✨', color: '#F59E0B', sort_order: 4, updated_at: null },
  { id: 'cat-5', name: 'Usługi', icon: '💆', color: '#10B981', sort_order: 5, updated_at: null },
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
  // Paznokcie
  { id: 'v-1', template_id: null, name: 'Lakier hybrydowy Red Passion', sku: 'NAI-001', barcode: '5901234567890', retail_price: 3500, category_id: 'cat-1', image_url: null, in_stock: 50, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-2', template_id: null, name: 'Lakier hybrydowy Nude Blush', sku: 'NAI-002', barcode: '5901234567891', retail_price: 3500, category_id: 'cat-1', image_url: null, in_stock: 35, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-3', template_id: null, name: 'Baza hybrydowa 8ml', sku: 'NAI-003', barcode: '5901234567892', retail_price: 2900, category_id: 'cat-1', image_url: null, in_stock: 80, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-4', template_id: null, name: 'Top hybrydowy no-wipe', sku: 'NAI-004', barcode: '5901234567893', retail_price: 3200, category_id: 'cat-1', image_url: null, in_stock: 60, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-5', template_id: null, name: 'Pilnik 100/180', sku: 'NAI-005', barcode: '5901234567894', retail_price: 500, category_id: 'cat-1', image_url: null, in_stock: 200, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-6', template_id: null, name: 'Tipsy naturalne 500szt', sku: 'NAI-006', barcode: '5901234567895', retail_price: 4500, category_id: 'cat-1', image_url: null, in_stock: 25, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-7', template_id: null, name: 'Żel budujący różowy 30ml', sku: 'NAI-007', barcode: '5901234567896', retail_price: 5900, category_id: 'cat-1', image_url: null, in_stock: 40, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-8', template_id: null, name: 'Aceton kosmetyczny 1000ml', sku: 'NAI-008', barcode: '5901234567897', retail_price: 1900, category_id: 'cat-1', image_url: null, in_stock: 30, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-9', template_id: null, name: 'Cleaner 500ml', sku: 'NAI-009', barcode: '5901234567898', retail_price: 1500, category_id: 'cat-1', image_url: null, in_stock: 45, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-10', template_id: null, name: 'Frezarka do paznokci 35000rpm', sku: 'NAI-010', barcode: '5901234567899', retail_price: 29900, category_id: 'cat-1', image_url: null, in_stock: 10, vat_rate: 23, is_active: 1, updated_at: null },
  // Włosy
  { id: 'v-11', template_id: null, name: 'Szampon regenerujący 500ml', sku: 'HAI-001', barcode: '5902345678901', retail_price: 4200, category_id: 'cat-2', image_url: null, in_stock: 30, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-12', template_id: null, name: 'Odżywka nawilżająca 300ml', sku: 'HAI-002', barcode: '5902345678902', retail_price: 3800, category_id: 'cat-2', image_url: null, in_stock: 25, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-13', template_id: null, name: 'Farba do włosów 6.0', sku: 'HAI-003', barcode: '5902345678903', retail_price: 2500, category_id: 'cat-2', image_url: null, in_stock: 40, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-14', template_id: null, name: 'Oksydant 6% 1000ml', sku: 'HAI-004', barcode: '5902345678904', retail_price: 1800, category_id: 'cat-2', image_url: null, in_stock: 20, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-15', template_id: null, name: 'Lakier do włosów Extra Strong', sku: 'HAI-005', barcode: '5902345678905', retail_price: 2200, category_id: 'cat-2', image_url: null, in_stock: 55, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-16', template_id: null, name: 'Olejek arganowy 100ml', sku: 'HAI-006', barcode: '5902345678906', retail_price: 5500, category_id: 'cat-2', image_url: null, in_stock: 15, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-17', template_id: null, name: 'Maska keratynowa 250ml', sku: 'HAI-007', barcode: '5902345678907', retail_price: 4800, category_id: 'cat-2', image_url: null, in_stock: 18, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-18', template_id: null, name: 'Nożyczki fryzjerskie 6"', sku: 'HAI-008', barcode: '5902345678908', retail_price: 8900, category_id: 'cat-2', image_url: null, in_stock: 8, vat_rate: 23, is_active: 1, updated_at: null },
  // Kosmetyki
  { id: 'v-19', template_id: null, name: 'Krem nawilżający 50ml', sku: 'COS-001', barcode: '5903456789001', retail_price: 6500, category_id: 'cat-3', image_url: null, in_stock: 20, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-20', template_id: null, name: 'Serum witamina C 30ml', sku: 'COS-002', barcode: '5903456789002', retail_price: 8900, category_id: 'cat-3', image_url: null, in_stock: 15, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-21', template_id: null, name: 'Tonik oczyszczający 200ml', sku: 'COS-003', barcode: '5903456789003', retail_price: 3200, category_id: 'cat-3', image_url: null, in_stock: 30, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-22', template_id: null, name: 'Peeling enzymatyczny 100ml', sku: 'COS-004', barcode: '5903456789004', retail_price: 4500, category_id: 'cat-3', image_url: null, in_stock: 22, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-23', template_id: null, name: 'Maseczka algowa 250g', sku: 'COS-005', barcode: '5903456789005', retail_price: 3800, category_id: 'cat-3', image_url: null, in_stock: 40, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-24', template_id: null, name: 'Krem pod oczy 15ml', sku: 'COS-006', barcode: '5903456789006', retail_price: 7200, category_id: 'cat-3', image_url: null, in_stock: 12, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-25', template_id: null, name: 'Mleczko do demakijażu 200ml', sku: 'COS-007', barcode: '5903456789007', retail_price: 2800, category_id: 'cat-3', image_url: null, in_stock: 35, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-26', template_id: null, name: 'SPF50 krem ochronny 50ml', sku: 'COS-008', barcode: '5903456789008', retail_price: 5500, category_id: 'cat-3', image_url: null, in_stock: 18, vat_rate: 23, is_active: 1, updated_at: null },
  // Akcesoria
  { id: 'v-27', template_id: null, name: 'Pędzel do pudru', sku: 'ACC-001', barcode: '5904567890001', retail_price: 2500, category_id: 'cat-4', image_url: null, in_stock: 30, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-28', template_id: null, name: 'Gąbka do makijażu Beauty Blender', sku: 'ACC-002', barcode: '5904567890002', retail_price: 1500, category_id: 'cat-4', image_url: null, in_stock: 50, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-29', template_id: null, name: 'Lusterko powiększające x10', sku: 'ACC-003', barcode: '5904567890003', retail_price: 3500, category_id: 'cat-4', image_url: null, in_stock: 15, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-30', template_id: null, name: 'Opaska kosmetyczna', sku: 'ACC-004', barcode: '5904567890004', retail_price: 800, category_id: 'cat-4', image_url: null, in_stock: 100, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-31', template_id: null, name: 'Torba kosmetyczna duża', sku: 'ACC-005', barcode: '5904567890005', retail_price: 4900, category_id: 'cat-4', image_url: null, in_stock: 12, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-32', template_id: null, name: 'Szpatułki drewniane 100szt', sku: 'ACC-006', barcode: '5904567890006', retail_price: 1200, category_id: 'cat-4', image_url: null, in_stock: 60, vat_rate: 23, is_active: 1, updated_at: null },
  // Usługi
  { id: 'v-33', template_id: null, name: 'Manicure hybrydowy', sku: 'SRV-001', barcode: null, retail_price: 8000, category_id: 'cat-5', image_url: null, in_stock: 999, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-34', template_id: null, name: 'Pedicure klasyczny', sku: 'SRV-002', barcode: null, retail_price: 10000, category_id: 'cat-5', image_url: null, in_stock: 999, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-35', template_id: null, name: 'Strzyżenie damskie', sku: 'SRV-003', barcode: null, retail_price: 12000, category_id: 'cat-5', image_url: null, in_stock: 999, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-36', template_id: null, name: 'Koloryzacja włosów', sku: 'SRV-004', barcode: null, retail_price: 18000, category_id: 'cat-5', image_url: null, in_stock: 999, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-37', template_id: null, name: 'Zabieg na twarz basic', sku: 'SRV-005', barcode: null, retail_price: 15000, category_id: 'cat-5', image_url: null, in_stock: 999, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-38', template_id: null, name: 'Depilacja woskiem nogi', sku: 'SRV-006', barcode: null, retail_price: 9000, category_id: 'cat-5', image_url: null, in_stock: 999, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-39', template_id: null, name: 'Przedłużanie rzęs 1:1', sku: 'SRV-007', barcode: null, retail_price: 20000, category_id: 'cat-5', image_url: null, in_stock: 999, vat_rate: 23, is_active: 1, updated_at: null },
  { id: 'v-40', template_id: null, name: 'Henna brwi + regulacja', sku: 'SRV-008', barcode: null, retail_price: 6000, category_id: 'cat-5', image_url: null, in_stock: 999, vat_rate: 23, is_active: 1, updated_at: null },
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
  if (!staffCount || staffCount.cnt === 0) {
    staffRepo.upsertMany(SEED_STAFF);
    logger.info(`[Seed] Seeded ${SEED_STAFF.length} salon staff`);
  }

  // 5s auto-save loop persists the seeded rows. Awaiting save() here would
  // block app startup behind a multi-megabyte disk write while the renderer
  // is waiting for the main window.
  database.markDirty();
}
