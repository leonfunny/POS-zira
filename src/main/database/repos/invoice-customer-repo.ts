import { database } from '../database';
import { InvoiceCustomerRow, InvoiceCustomerCreateDTO } from '../../../shared/types';
import logger from '../../logger';
import { randomUUID } from 'crypto';

export const invoiceCustomerRepo = {
  /**
   * Get all customers (active only by default)
   */
  getAll(includeInactive = false): InvoiceCustomerRow[] {
    const sql = includeInactive
      ? 'SELECT * FROM invoice_customers ORDER BY name ASC'
      : 'SELECT * FROM invoice_customers WHERE is_active = 1 ORDER BY name ASC';
    return database.all<InvoiceCustomerRow>(sql);
  },

  /**
   * Get customer by ID
   */
  getById(id: string): InvoiceCustomerRow | null {
    return database.get<InvoiceCustomerRow>('SELECT * FROM invoice_customers WHERE id = ?', [id]);
  },

  /**
   * Get customer by NIP
   */
  getByNip(nip: string): InvoiceCustomerRow | null {
    return database.get<InvoiceCustomerRow>('SELECT * FROM invoice_customers WHERE nip = ?', [nip]);
  },

  /**
   * Search customers by name or NIP
   */
  search(query: string, limit = 20): InvoiceCustomerRow[] {
    const searchTerm = `%${query}%`;
    return database.all<InvoiceCustomerRow>(
      `SELECT * FROM invoice_customers
       WHERE is_active = 1 AND (name LIKE ? OR nip LIKE ? OR short_name LIKE ?)
       ORDER BY name ASC
       LIMIT ?`,
      [searchTerm, searchTerm, searchTerm, limit],
    );
  },

  /**
   * Get recent customers (most recently used)
   */
  getRecent(limit = 5): InvoiceCustomerRow[] {
    return database.all<InvoiceCustomerRow>(
      `SELECT c.* FROM invoice_customers c
       LEFT JOIN invoices i ON c.id = i.customer_id
       WHERE c.is_active = 1
       GROUP BY c.id
       ORDER BY MAX(i.created_at) DESC NULLS LAST, c.name ASC
       LIMIT ?`,
      [limit],
    );
  },

  /**
   * Create new customer
   */
  create(data: InvoiceCustomerCreateDTO): InvoiceCustomerRow {
    const id = randomUUID();

    // Validate NIP if provided and is_company
    if (data.nip) {
      const cleanNip = data.nip.replace(/[\s-]/g, '');
      if (cleanNip.length !== 10 || !/^\d{10}$/.test(cleanNip)) {
        throw new Error('NIP must be exactly 10 digits');
      }
    }

    database.run(
      `INSERT INTO invoice_customers (
        id, name, short_name, is_company, nip, regon,
        street, city, postal_code, country,
        email, phone, contact_person,
        payment_term_days, default_payment_method,
        bank_account, bank_name, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.name,
        data.short_name ?? null,
        data.is_company ? 1 : 0,
        data.nip?.replace(/[\s-]/g, '') ?? null,
        data.regon ?? null,
        data.street ?? null,
        data.city ?? null,
        data.postal_code ?? null,
        data.country ?? 'PL',
        data.email ?? null,
        data.phone ?? null,
        data.contact_person ?? null,
        data.payment_term_days ?? 14,
        data.default_payment_method ?? 'BANK_TRANSFER',
        data.bank_account ?? null,
        data.bank_name ?? null,
        data.notes ?? null,
      ],
    );

    database.markDirty();
    logger.info(`[InvoiceCustomerRepo] Created customer: ${data.name} (${id})`);
    return this.getById(id)!;
  },

  /**
   * Update customer
   */
  update(id: string, data: Partial<InvoiceCustomerCreateDTO>): InvoiceCustomerRow {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Customer not found: ${id}`);
    }

    // Validate NIP if provided
    if (data.nip !== undefined && data.nip) {
      const cleanNip = data.nip.replace(/[\s-]/g, '');
      if (cleanNip.length !== 10 || !/^\d{10}$/.test(cleanNip)) {
        throw new Error('NIP must be exactly 10 digits');
      }
    }

    const fields: string[] = [];
    const values: any[] = [];

    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.short_name !== undefined) { fields.push('short_name = ?'); values.push(data.short_name || null); }
    if (data.is_company !== undefined) { fields.push('is_company = ?'); values.push(data.is_company ? 1 : 0); }
    if (data.nip !== undefined) { fields.push('nip = ?'); values.push(data.nip?.replace(/[\s-]/g, '') || null); }
    if (data.regon !== undefined) { fields.push('regon = ?'); values.push(data.regon || null); }
    if (data.street !== undefined) { fields.push('street = ?'); values.push(data.street || null); }
    if (data.city !== undefined) { fields.push('city = ?'); values.push(data.city || null); }
    if (data.postal_code !== undefined) { fields.push('postal_code = ?'); values.push(data.postal_code || null); }
    if (data.country !== undefined) { fields.push('country = ?'); values.push(data.country || 'PL'); }
    if (data.email !== undefined) { fields.push('email = ?'); values.push(data.email || null); }
    if (data.phone !== undefined) { fields.push('phone = ?'); values.push(data.phone || null); }
    if (data.contact_person !== undefined) { fields.push('contact_person = ?'); values.push(data.contact_person || null); }
    if (data.payment_term_days !== undefined) { fields.push('payment_term_days = ?'); values.push(data.payment_term_days); }
    if (data.default_payment_method !== undefined) { fields.push('default_payment_method = ?'); values.push(data.default_payment_method); }
    if (data.bank_account !== undefined) { fields.push('bank_account = ?'); values.push(data.bank_account || null); }
    if (data.bank_name !== undefined) { fields.push('bank_name = ?'); values.push(data.bank_name || null); }
    if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes || null); }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      values.push(id);
      database.run(`UPDATE invoice_customers SET ${fields.join(', ')} WHERE id = ?`, values);
      database.markDirty();
      logger.info(`[InvoiceCustomerRepo] Updated customer: ${id}`);
    }

    return this.getById(id)!;
  },

  /**
   * Soft delete customer (set is_active = 0)
   */
  delete(id: string): void {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Customer not found: ${id}`);
    }

    database.run("UPDATE invoice_customers SET is_active = 0, updated_at = datetime('now') WHERE id = ?", [id]);
    database.markDirty();
    logger.info(`[InvoiceCustomerRepo] Deleted (soft) customer: ${id}`);
  },

  /**
   * Get formatted address
   */
  getFormattedAddress(customer: InvoiceCustomerRow): string {
    const parts: string[] = [];
    if (customer.street) parts.push(customer.street);
    if (customer.postal_code || customer.city) {
      parts.push(`${customer.postal_code ?? ''} ${customer.city ?? ''}`.trim());
    }
    return parts.join(', ');
  },
};
