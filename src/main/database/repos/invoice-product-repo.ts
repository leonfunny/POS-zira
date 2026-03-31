import { database } from '../database';
import { AccountingProductRow, AccountingProductCreateDTO } from '../../../shared/types';
import logger from '../../logger';
import { randomUUID } from 'crypto';

export const invoiceProductRepo = {
  /**
   * Get all products (active only by default)
   */
  getAll(includeInactive = false): AccountingProductRow[] {
    const sql = includeInactive
      ? 'SELECT * FROM accounting_products ORDER BY name ASC'
      : 'SELECT * FROM accounting_products WHERE is_active = 1 ORDER BY name ASC';
    return database.all<AccountingProductRow>(sql);
  },

  /**
   * Get product by ID
   */
  getById(id: string): AccountingProductRow | null {
    return database.get<AccountingProductRow>('SELECT * FROM accounting_products WHERE id = ?', [id]);
  },

  /**
   * Get product by SKU
   */
  getBySku(sku: string): AccountingProductRow | null {
    return database.get<AccountingProductRow>('SELECT * FROM accounting_products WHERE sku = ?', [sku]);
  },

  /**
   * Get product by barcode
   */
  getByBarcode(barcode: string): AccountingProductRow | null {
    return database.get<AccountingProductRow>('SELECT * FROM accounting_products WHERE barcode = ?', [barcode]);
  },

  /**
   * Search products by name, SKU, or barcode
   */
  search(query: string, limit = 20): AccountingProductRow[] {
    const searchTerm = `%${query}%`;
    return database.all<AccountingProductRow>(
      `SELECT * FROM accounting_products
       WHERE is_active = 1 AND (name LIKE ? OR sku LIKE ? OR barcode LIKE ?)
       ORDER BY name ASC
       LIMIT ?`,
      [searchTerm, searchTerm, searchTerm, limit],
    );
  },

  /**
   * Calculate gross price from net and VAT rate
   */
  calculateGross(netPrice: number, vatRate: number): number {
    if (vatRate < 0) return netPrice; // ZW (exempt)
    return Math.round(netPrice * (1 + vatRate / 100));
  },

  /**
   * Create new product
   */
  create(data: AccountingProductCreateDTO): AccountingProductRow {
    const id = randomUUID();

    // Calculate gross if not provided
    const priceGross = this.calculateGross(data.price_net, data.vat_rate);

    database.run(
      `INSERT INTO accounting_products (
        id, sku, name, description,
        price_net, vat_rate, price_gross, purchase_price_net,
        unit, pkwiu_code, gtu_code, cn_code, barcode, type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.sku ?? null,
        data.name,
        data.description ?? null,
        data.price_net,
        data.vat_rate,
        priceGross,
        data.purchase_price_net ?? null,
        data.unit ?? 'szt.',
        data.pkwiu_code ?? null,
        data.gtu_code ?? null,
        data.cn_code ?? null,
        data.barcode ?? null,
        data.type ?? 'PRODUCT',
      ],
    );

    database.save();
    logger.info(`[InvoiceProductRepo] Created product: ${data.name} (${id})`);
    return this.getById(id)!;
  },

  /**
   * Update product
   */
  update(id: string, data: Partial<AccountingProductCreateDTO>): AccountingProductRow {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Product not found: ${id}`);
    }

    const fields: string[] = [];
    const values: any[] = [];

    if (data.sku !== undefined) { fields.push('sku = ?'); values.push(data.sku || null); }
    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description || null); }
    if (data.price_net !== undefined) { fields.push('price_net = ?'); values.push(data.price_net); }
    if (data.vat_rate !== undefined) { fields.push('vat_rate = ?'); values.push(data.vat_rate); }
    if (data.purchase_price_net !== undefined) { fields.push('purchase_price_net = ?'); values.push(data.purchase_price_net || null); }
    if (data.unit !== undefined) { fields.push('unit = ?'); values.push(data.unit || 'szt.'); }
    if (data.pkwiu_code !== undefined) { fields.push('pkwiu_code = ?'); values.push(data.pkwiu_code || null); }
    if (data.gtu_code !== undefined) { fields.push('gtu_code = ?'); values.push(data.gtu_code || null); }
    if (data.cn_code !== undefined) { fields.push('cn_code = ?'); values.push(data.cn_code || null); }
    if (data.barcode !== undefined) { fields.push('barcode = ?'); values.push(data.barcode || null); }
    if (data.type !== undefined) { fields.push('type = ?'); values.push(data.type || 'PRODUCT'); }

    // Recalculate gross if price_net or vat_rate changed
    const newNet = data.price_net ?? existing.price_net;
    const newVat = data.vat_rate ?? existing.vat_rate;
    if (data.price_net !== undefined || data.vat_rate !== undefined) {
      const priceGross = this.calculateGross(newNet, newVat);
      fields.push('price_gross = ?');
      values.push(priceGross);
    }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      values.push(id);
      database.run(`UPDATE accounting_products SET ${fields.join(', ')} WHERE id = ?`, values);
      database.save();
      logger.info(`[InvoiceProductRepo] Updated product: ${id}`);
    }

    return this.getById(id)!;
  },

  /**
   * Soft delete product (set is_active = 0)
   */
  delete(id: string): void {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Product not found: ${id}`);
    }

    database.run("UPDATE accounting_products SET is_active = 0, updated_at = datetime('now') WHERE id = ?", [id]);
    database.save();
    logger.info(`[InvoiceProductRepo] Deleted (soft) product: ${id}`);
  },

  /**
   * Update stock quantity
   */
  updateStock(id: string, quantityChange: number): void {
    database.run(
      `UPDATE accounting_products
       SET stock_quantity = stock_quantity + ?, updated_at = datetime('now')
       WHERE id = ?`,
      [quantityChange, id],
    );
    database.save();
  },
};
