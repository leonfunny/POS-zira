import { database } from '../database';
import {
  InvoiceRow,
  InvoiceItemRow,
  InvoiceType,
  InvoiceStatus,
  InvoicePaymentStatus,
  InvoicePaymentMethod,
  InvoiceCreateDTO,
  InvoiceItemCreateDTO,
  InvoiceListFilter,
  VatSummaryEntry,
  VatRateRow,
  InvoiceSequenceRow,
  KsefStatus,
} from '../../../shared/types';
import { sellerSettingsRepo } from './seller-settings-repo';
import { invoiceCustomerRepo } from './invoice-customer-repo';
import { invoicePaymentRepo } from './invoice-payment-repo';
import logger from '../../logger';
import { randomUUID } from 'crypto';

export const invoiceRepo = {
  // ==========================================
  // VAT Rates
  // ==========================================

  /**
   * Get all active VAT rates
   */
  getVatRates(): VatRateRow[] {
    return database.all<VatRateRow>(
      'SELECT * FROM vat_rates WHERE is_active = 1 ORDER BY display_order ASC',
    );
  },

  /**
   * Get default VAT rate
   */
  getDefaultVatRate(): number {
    const rate = database.get<VatRateRow>('SELECT * FROM vat_rates WHERE is_default = 1 LIMIT 1');
    return rate?.rate ?? 23;
  },

  // ==========================================
  // Invoice Number Generation
  // ==========================================

  /**
   * Get next invoice number for type
   */
  getNextNumber(type: InvoiceType): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    // Get prefix by type
    const prefixMap: Record<InvoiceType, string> = {
      RECEIPT: 'PAR',
      VAT: 'FV',
      PROFORMA: 'PRO',
      CORRECTION: 'KOR',
      ADVANCE: 'ZAL',
    };
    const prefix = prefixMap[type] || 'FV';

    // Get or create sequence for this type/year/month
    const id = `${type}-${year}-${month}`;
    database.run(
      `INSERT INTO invoice_sequences (id, type, prefix, year, month, last_number, format)
       VALUES (?, ?, ?, ?, ?, 0, '{prefix}/{number}/{month}/{year}')
       ON CONFLICT(id) DO NOTHING`,
      [id, type, prefix, year, month],
    );

    // Atomic increment
    database.run(
      'UPDATE invoice_sequences SET last_number = last_number + 1 WHERE id = ?',
      [id],
    );

    // Read back incremented value
    const sequence = database.get<InvoiceSequenceRow>(
      'SELECT * FROM invoice_sequences WHERE id = ?',
      [id],
    );

    const nextNumber = sequence?.last_number ?? 1;

    // Format: FV/001/02/2026
    const paddedNumber = nextNumber.toString().padStart(3, '0');
    const paddedMonth = month.toString().padStart(2, '0');
    return `${prefix}/${paddedNumber}/${paddedMonth}/${year}`;
  },

  // ==========================================
  // VAT Calculation
  // ==========================================

  /**
   * Calculate line item totals
   */
  calculateItemTotals(item: InvoiceItemCreateDTO): { net: number; vat: number; gross: number } {
    // quantity is x1000, so divide by 1000
    const qty = item.quantity / 1000;
    const unitNet = item.unit_price_net;
    const discount = (item.discount_percent || 0) / 100;  // x100 to percentage

    // Calculate discounted net
    const netBeforeDiscount = Math.round(unitNet * qty);
    const discountAmount = Math.round(netBeforeDiscount * discount);
    const net = netBeforeDiscount - discountAmount;

    // Calculate VAT (handle ZW rate = -1)
    let vat = 0;
    if (item.vat_rate >= 0) {
      vat = Math.round(net * item.vat_rate / 100);
    }

    const gross = net + vat;

    return { net, vat, gross };
  },

  /**
   * Calculate VAT summary grouped by rate
   */
  calculateVatSummary(items: Array<{ vat_rate: number; total_net: number; vat_amount: number; total_gross: number }>): VatSummaryEntry[] {
    const byRate: Record<number, VatSummaryEntry> = {};

    for (const item of items) {
      const rate = item.vat_rate;
      if (!byRate[rate]) {
        byRate[rate] = { rate, net: 0, vat: 0, gross: 0 };
      }
      byRate[rate].net += item.total_net;
      byRate[rate].vat += item.vat_amount;
      byRate[rate].gross += item.total_gross;
    }

    return Object.values(byRate).sort((a, b) => b.rate - a.rate);
  },

  // ==========================================
  // CRUD Operations
  // ==========================================

  /**
   * Get invoice by ID with items
   */
  getById(id: string): { invoice: InvoiceRow; items: InvoiceItemRow[] } | null {
    const invoice = database.get<InvoiceRow>('SELECT * FROM invoices WHERE id = ?', [id]);
    if (!invoice) return null;

    const items = database.all<InvoiceItemRow>(
      'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order ASC',
      [id],
    );

    return { invoice, items };
  },

  /**
   * Get invoice by number
   */
  getByNumber(invoiceNumber: string): { invoice: InvoiceRow; items: InvoiceItemRow[] } | null {
    const invoice = database.get<InvoiceRow>('SELECT * FROM invoices WHERE invoice_number = ?', [invoiceNumber]);
    if (!invoice) return null;

    const items = database.all<InvoiceItemRow>(
      'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order ASC',
      [invoice.id],
    );

    return { invoice, items };
  },

  /**
   * List invoices with filters
   */
  list(filter: InvoiceListFilter = {}): InvoiceRow[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter.type) {
      conditions.push('type = ?');
      params.push(filter.type);
    }

    if (filter.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }

    if (filter.customerId) {
      conditions.push('customer_id = ?');
      params.push(filter.customerId);
    }

    if (filter.dateFrom) {
      conditions.push('date(issue_date) >= date(?)');
      params.push(filter.dateFrom);
    }

    if (filter.dateTo) {
      conditions.push('date(issue_date) <= date(?)');
      params.push(filter.dateTo);
    }

    if (filter.search) {
      conditions.push('(invoice_number LIKE ? OR customer_name LIKE ? OR customer_nip LIKE ?)');
      const term = `%${filter.search}%`;
      params.push(term, term, term);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit || 50;
    const offset = filter.offset || 0;

    return database.all<InvoiceRow>(
      `SELECT * FROM invoices ${whereClause}
       ORDER BY issue_date DESC, created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
  },

  /**
   * Create new invoice
   */
  create(data: InvoiceCreateDTO): { invoice: InvoiceRow; items: InvoiceItemRow[] } {
    // Validate seller settings
    const seller = sellerSettingsRepo.get();
    if (!seller) {
      throw new Error('Seller settings not configured. Please set up your company information first.');
    }

    // Get or create customer
    let customerId = data.customer_id ?? null;
    if (!customerId && data.customer_nip) {
      const existingCustomer = invoiceCustomerRepo.getByNip(data.customer_nip);
      if (existingCustomer) {
        customerId = existingCustomer.id;
      }
    }

    // Generate invoice number (inside transaction for atomicity)
    let invoiceNumber: string = '';
    let invoiceId: string = '';

    database.transaction(() => {
      invoiceNumber = this.getNextNumber(data.type);
      invoiceId = randomUUID();

      // Calculate item totals and invoice totals
      const itemsWithTotals = data.items.map((item, idx) => {
        const totals = this.calculateItemTotals(item);
        return {
          ...item,
          sort_order: idx,
          total_net: totals.net,
          vat_amount: totals.vat,
          total_gross: totals.gross,
        };
      });

      const totalNet = itemsWithTotals.reduce((sum, i) => sum + i.total_net, 0);
      const totalVat = itemsWithTotals.reduce((sum, i) => sum + i.vat_amount, 0);
      const totalGross = itemsWithTotals.reduce((sum, i) => sum + i.total_gross, 0);

      // Calculate VAT summary
      const vatSummary = this.calculateVatSummary(itemsWithTotals);

      // Check MPP (split payment) for B2B >= 15000 PLN
      const splitPaymentMarker = data.customer_nip && totalGross >= 1500000 ? 1 : 0;

      // Determine initial status
      const status: InvoiceStatus = 'DRAFT';

      // Insert invoice
      database.run(
        `INSERT INTO invoices (
          id, invoice_number, type, status,
          issue_date, sale_date, due_date,
          seller_name, seller_nip, seller_regon, seller_address, seller_bank_account, seller_bank_name,
          customer_id, customer_name, customer_nip, customer_regon, customer_address, customer_country,
          total_net, total_vat, total_gross, currency, vat_summary,
          payment_method, payment_status, paid_amount,
          split_payment_marker,
          corrected_invoice_id, correction_reason, valid_until,
          notes, internal_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId,
          invoiceNumber,
          data.type,
          status,
          data.issue_date,
          data.sale_date,
          data.due_date ?? null,
          seller.company_name,
          seller.nip,
          seller.regon,
          sellerSettingsRepo.getFormattedAddress(),
          seller.bank_account,
          seller.bank_name,
          customerId,
          data.customer_name,
          data.customer_nip ?? null,
          data.customer_regon ?? null,
          data.customer_address ?? null,
          data.customer_country ?? 'PL',
          totalNet,
          totalVat,
          totalGross,
          'PLN',
          JSON.stringify(vatSummary),
          data.payment_method,
          'UNPAID',
          0,
          splitPaymentMarker,
          data.corrected_invoice_id ?? null,
          data.correction_reason ?? null,
          data.valid_until ?? null,
          data.notes ?? null,
          data.internal_notes ?? null,
        ],
      );

      // Insert items
      for (const item of itemsWithTotals) {
        const itemId = randomUUID();
        database.run(
          `INSERT INTO invoice_items (
            id, invoice_id, sort_order, accounting_product_id,
            name, sku, unit, pkwiu_code, gtu_code,
            quantity, unit_price_net, vat_rate, discount_percent,
            total_net, vat_amount, total_gross
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            itemId,
            invoiceId,
            item.sort_order,
            item.accounting_product_id ?? null,
            item.name,
            item.sku ?? null,
            item.unit ?? 'szt.',
            item.pkwiu_code ?? null,
            item.gtu_code ?? null,
            item.quantity,
            item.unit_price_net,
            item.vat_rate,
            item.discount_percent ?? 0,
            item.total_net,
            item.vat_amount,
            item.total_gross,
          ],
        );
      }
    });

    database.save();
    logger.info(`[InvoiceRepo] Created invoice: ${invoiceNumber} (${invoiceId}), type=${data.type}`);
    return this.getById(invoiceId)!;
  },

  /**
   * Update invoice (only DRAFT invoices can be updated)
   */
  update(id: string, data: Partial<InvoiceCreateDTO>): { invoice: InvoiceRow; items: InvoiceItemRow[] } {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Invoice not found: ${id}`);
    }

    if (existing.invoice.status !== 'DRAFT') {
      throw new Error('Only draft invoices can be modified');
    }

    database.transaction(() => {
      // Update invoice fields
      const fields: string[] = [];
      const values: any[] = [];

      if (data.customer_name !== undefined) { fields.push('customer_name = ?'); values.push(data.customer_name); }
      if (data.customer_nip !== undefined) { fields.push('customer_nip = ?'); values.push(data.customer_nip || null); }
      if (data.customer_regon !== undefined) { fields.push('customer_regon = ?'); values.push(data.customer_regon || null); }
      if (data.customer_address !== undefined) { fields.push('customer_address = ?'); values.push(data.customer_address || null); }
      if (data.customer_country !== undefined) { fields.push('customer_country = ?'); values.push(data.customer_country || 'PL'); }
      if (data.issue_date !== undefined) { fields.push('issue_date = ?'); values.push(data.issue_date); }
      if (data.sale_date !== undefined) { fields.push('sale_date = ?'); values.push(data.sale_date); }
      if (data.due_date !== undefined) { fields.push('due_date = ?'); values.push(data.due_date || null); }
      if (data.payment_method !== undefined) { fields.push('payment_method = ?'); values.push(data.payment_method); }
      if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes || null); }
      if (data.internal_notes !== undefined) { fields.push('internal_notes = ?'); values.push(data.internal_notes || null); }
      if (data.valid_until !== undefined) { fields.push('valid_until = ?'); values.push(data.valid_until || null); }

      // If items are being updated, recalculate totals
      if (data.items) {
        // Delete existing items
        database.run('DELETE FROM invoice_items WHERE invoice_id = ?', [id]);

        // Calculate and insert new items
        const itemsWithTotals = data.items.map((item, idx) => {
          const totals = this.calculateItemTotals(item);
          return {
            ...item,
            sort_order: idx,
            total_net: totals.net,
            vat_amount: totals.vat,
            total_gross: totals.gross,
          };
        });

        const totalNet = itemsWithTotals.reduce((sum, i) => sum + i.total_net, 0);
        const totalVat = itemsWithTotals.reduce((sum, i) => sum + i.vat_amount, 0);
        const totalGross = itemsWithTotals.reduce((sum, i) => sum + i.total_gross, 0);
        const vatSummary = this.calculateVatSummary(itemsWithTotals);
        const splitPaymentMarker = (data.customer_nip ?? existing.invoice.customer_nip) && totalGross >= 1500000 ? 1 : 0;

        fields.push('total_net = ?', 'total_vat = ?', 'total_gross = ?', 'vat_summary = ?', 'split_payment_marker = ?');
        values.push(totalNet, totalVat, totalGross, JSON.stringify(vatSummary), splitPaymentMarker);

        // Insert new items
        for (const item of itemsWithTotals) {
          const itemId = randomUUID();
          database.run(
            `INSERT INTO invoice_items (
              id, invoice_id, sort_order, accounting_product_id,
              name, sku, unit, pkwiu_code, gtu_code,
              quantity, unit_price_net, vat_rate, discount_percent,
              total_net, vat_amount, total_gross
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              itemId,
              id,
              item.sort_order,
              item.accounting_product_id ?? null,
              item.name,
              item.sku ?? null,
              item.unit ?? 'szt.',
              item.pkwiu_code ?? null,
              item.gtu_code ?? null,
              item.quantity,
              item.unit_price_net,
              item.vat_rate,
              item.discount_percent ?? 0,
              item.total_net,
              item.vat_amount,
              item.total_gross,
            ],
          );
        }
      }

      if (fields.length > 0) {
        fields.push("updated_at = datetime('now')");
        values.push(id);
        database.run(`UPDATE invoices SET ${fields.join(', ')} WHERE id = ?`, values);
      }
    });

    database.save();
    logger.info(`[InvoiceRepo] Updated invoice: ${id}`);
    return this.getById(id)!;
  },

  /**
   * Issue invoice (change from DRAFT to ISSUED)
   */
  issue(id: string): InvoiceRow {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Invoice not found: ${id}`);
    }

    if (existing.invoice.status !== 'DRAFT') {
      throw new Error('Only draft invoices can be issued');
    }

    database.run(
      "UPDATE invoices SET status = 'ISSUED', updated_at = datetime('now') WHERE id = ?",
      [id],
    );
    database.save();
    logger.info(`[InvoiceRepo] Issued invoice: ${id}`);
    return this.getById(id)!.invoice;
  },

  /**
   * Cancel invoice
   */
  cancel(id: string, reason: string, cancelledBy?: string): InvoiceRow {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Invoice not found: ${id}`);
    }

    if (existing.invoice.status === 'CANCELLED') {
      throw new Error('Invoice is already cancelled');
    }

    if (existing.invoice.status === 'PAID') {
      throw new Error('Cannot cancel a paid invoice');
    }

    database.run(
      `UPDATE invoices SET
        status = 'CANCELLED',
        cancelled_at = datetime('now'),
        cancelled_by = ?,
        cancellation_reason = ?,
        updated_at = datetime('now')
       WHERE id = ?`,
      [cancelledBy ?? null, reason, id],
    );
    database.save();
    logger.info(`[InvoiceRepo] Cancelled invoice: ${id}, reason: ${reason}`);
    return this.getById(id)!.invoice;
  },

  /**
   * Mark invoice as paid
   */
  markPaid(id: string): InvoiceRow {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Invoice not found: ${id}`);
    }

    database.run(
      `UPDATE invoices SET
        status = 'PAID',
        payment_status = 'PAID',
        paid_amount = total_gross,
        paid_at = datetime('now'),
        updated_at = datetime('now')
       WHERE id = ?`,
      [id],
    );
    database.save();
    logger.info(`[InvoiceRepo] Marked invoice as paid: ${id}`);
    return this.getById(id)!.invoice;
  },

  /**
   * Add payment to invoice and update status
   */
  addPayment(invoiceId: string, amount: number, paymentMethod?: string, reference?: string): InvoiceRow {
    const existing = this.getById(invoiceId);
    if (!existing) {
      throw new Error(`Invoice not found: ${invoiceId}`);
    }

    database.transaction(() => {
      // Create payment record
      invoicePaymentRepo.create({
        invoice_id: invoiceId,
        amount,
        payment_method: paymentMethod,
        reference_number: reference,
      });

      // Calculate new totals
      const totalPaid = invoicePaymentRepo.getTotalPaid(invoiceId);
      const totalGross = existing.invoice.total_gross;

      let paymentStatus: InvoicePaymentStatus = 'UNPAID';
      let status: InvoiceStatus = existing.invoice.status as InvoiceStatus;
      let paidAt: string | null = null;

      if (totalPaid >= totalGross) {
        paymentStatus = 'PAID';
        status = 'PAID';
        paidAt = new Date().toISOString();
      } else if (totalPaid > 0) {
        paymentStatus = 'PARTIAL';
        status = 'PARTIALLY_PAID';
      }

      database.run(
        `UPDATE invoices SET
          payment_status = ?,
          paid_amount = ?,
          status = ?,
          paid_at = ?,
          updated_at = datetime('now')
         WHERE id = ?`,
        [paymentStatus, totalPaid, status, paidAt, invoiceId],
      );
    });

    database.save();
    logger.info(`[InvoiceRepo] Added payment to invoice: ${invoiceId}, amount=${amount}`);
    return this.getById(invoiceId)!.invoice;
  },

  /**
   * Duplicate invoice (for creating similar invoices)
   */
  duplicate(id: string): { invoice: InvoiceRow; items: InvoiceItemRow[] } {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Invoice not found: ${id}`);
    }

    // Create new invoice with same data but new ID/number
    const today = new Date().toISOString().split('T')[0];
    const data: InvoiceCreateDTO = {
      type: existing.invoice.type as InvoiceType,
      customer_id: existing.invoice.customer_id ?? undefined,
      customer_name: existing.invoice.customer_name,
      customer_nip: existing.invoice.customer_nip ?? undefined,
      customer_regon: existing.invoice.customer_regon ?? undefined,
      customer_address: existing.invoice.customer_address ?? undefined,
      customer_country: existing.invoice.customer_country ?? undefined,
      issue_date: today,
      sale_date: today,
      due_date: existing.invoice.due_date ?? undefined,
      payment_method: existing.invoice.payment_method as InvoicePaymentMethod,
      notes: existing.invoice.notes ?? undefined,
      internal_notes: existing.invoice.internal_notes ?? undefined,
      items: existing.items.map(item => ({
        accounting_product_id: item.accounting_product_id ?? undefined,
        name: item.name,
        sku: item.sku ?? undefined,
        unit: item.unit,
        pkwiu_code: item.pkwiu_code ?? undefined,
        gtu_code: item.gtu_code ?? undefined,
        quantity: item.quantity,
        unit_price_net: item.unit_price_net,
        vat_rate: item.vat_rate,
        discount_percent: item.discount_percent,
      })),
    };

    const newInvoice = this.create(data);
    logger.info(`[InvoiceRepo] Duplicated invoice: ${id} -> ${newInvoice.invoice.id}`);
    return newInvoice;
  },

  /**
   * Create correction invoice
   */
  createCorrection(originalInvoiceId: string, reason: string, newItems: InvoiceItemCreateDTO[]): { invoice: InvoiceRow; items: InvoiceItemRow[] } {
    const original = this.getById(originalInvoiceId);
    if (!original) {
      throw new Error(`Original invoice not found: ${originalInvoiceId}`);
    }

    if (original.invoice.status === 'DRAFT') {
      throw new Error('Cannot create correction for a draft invoice');
    }

    // Calculate correction data (difference)
    const newTotals = newItems.reduce((acc, item) => {
      const t = this.calculateItemTotals(item);
      return { net: acc.net + t.net, vat: acc.vat + t.vat };
    }, { net: 0, vat: 0 });

    const correctionData = {
      originalNet: original.invoice.total_net,
      originalVat: original.invoice.total_vat,
      diffNet: newTotals.net - original.invoice.total_net,
      diffVat: newTotals.vat - original.invoice.total_vat,
    };

    const today = new Date().toISOString().split('T')[0];
    const data: InvoiceCreateDTO = {
      type: 'CORRECTION',
      customer_id: original.invoice.customer_id ?? undefined,
      customer_name: original.invoice.customer_name,
      customer_nip: original.invoice.customer_nip ?? undefined,
      customer_regon: original.invoice.customer_regon ?? undefined,
      customer_address: original.invoice.customer_address ?? undefined,
      customer_country: original.invoice.customer_country ?? undefined,
      issue_date: today,
      sale_date: original.invoice.sale_date,
      payment_method: original.invoice.payment_method as InvoicePaymentMethod,
      corrected_invoice_id: originalInvoiceId,
      correction_reason: reason,
      items: newItems,
    };

    const correction = this.create(data);

    // Store correction data
    database.run(
      "UPDATE invoices SET correction_data = ?, updated_at = datetime('now') WHERE id = ?",
      [JSON.stringify(correctionData), correction.invoice.id],
    );
    database.save();

    logger.info(`[InvoiceRepo] Created correction invoice for ${originalInvoiceId}: ${correction.invoice.id}`);
    return this.getById(correction.invoice.id)!;
  },

  /**
   * Convert proforma to VAT invoice
   */
  convertProforma(proformaId: string): { invoice: InvoiceRow; items: InvoiceItemRow[] } {
    const proforma = this.getById(proformaId);
    if (!proforma) {
      throw new Error(`Proforma not found: ${proformaId}`);
    }

    if (proforma.invoice.type !== 'PROFORMA') {
      throw new Error('Only proforma invoices can be converted');
    }

    if (proforma.invoice.converted_invoice_id) {
      throw new Error('This proforma has already been converted');
    }

    const today = new Date().toISOString().split('T')[0];
    const data: InvoiceCreateDTO = {
      type: 'VAT',
      customer_id: proforma.invoice.customer_id ?? undefined,
      customer_name: proforma.invoice.customer_name,
      customer_nip: proforma.invoice.customer_nip ?? undefined,
      customer_regon: proforma.invoice.customer_regon ?? undefined,
      customer_address: proforma.invoice.customer_address ?? undefined,
      customer_country: proforma.invoice.customer_country ?? undefined,
      issue_date: today,
      sale_date: today,
      due_date: proforma.invoice.due_date ?? undefined,
      payment_method: proforma.invoice.payment_method as InvoicePaymentMethod,
      notes: proforma.invoice.notes ?? undefined,
      items: proforma.items.map(item => ({
        accounting_product_id: item.accounting_product_id ?? undefined,
        name: item.name,
        sku: item.sku ?? undefined,
        unit: item.unit,
        pkwiu_code: item.pkwiu_code ?? undefined,
        gtu_code: item.gtu_code ?? undefined,
        quantity: item.quantity,
        unit_price_net: item.unit_price_net,
        vat_rate: item.vat_rate,
        discount_percent: item.discount_percent,
      })),
    };

    const vatInvoice = this.create(data);

    // Link proforma to VAT invoice
    database.run(
      `UPDATE invoices SET
        converted_invoice_id = ?,
        converted_at = datetime('now'),
        updated_at = datetime('now')
       WHERE id = ?`,
      [vatInvoice.invoice.id, proformaId],
    );

    // Link VAT invoice to proforma
    database.run(
      "UPDATE invoices SET proforma_id = ?, updated_at = datetime('now') WHERE id = ?",
      [proformaId, vatInvoice.invoice.id],
    );

    database.save();
    logger.info(`[InvoiceRepo] Converted proforma ${proformaId} to VAT invoice ${vatInvoice.invoice.id}`);
    return this.getById(vatInvoice.invoice.id)!;
  },

  /**
   * Delete draft invoice
   */
  delete(id: string): void {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Invoice not found: ${id}`);
    }

    if (existing.invoice.status !== 'DRAFT') {
      throw new Error('Only draft invoices can be deleted');
    }

    database.transaction(() => {
      database.run('DELETE FROM invoice_items WHERE invoice_id = ?', [id]);
      database.run('DELETE FROM invoices WHERE id = ?', [id]);
    });
    database.save();
    logger.info(`[InvoiceRepo] Deleted invoice: ${id}`);
  },

  /**
   * Mark invoice as printed
   */
  markPrinted(id: string): void {
    database.run(
      "UPDATE invoices SET printed = 1, printed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      [id],
    );
    database.save();
  },

  /**
   * Get unsynced invoices
   */
  getUnsynced(): InvoiceRow[] {
    return database.all<InvoiceRow>(
      "SELECT * FROM invoices WHERE synced = 0 AND status != 'DRAFT' ORDER BY created_at ASC",
    );
  },

  /**
   * Mark invoice as synced
   */
  markSynced(id: string, backendId: string): void {
    database.run(
      "UPDATE invoices SET synced = 1, backend_id = ?, updated_at = datetime('now') WHERE id = ?",
      [backendId, id],
    );
    database.save();
  },

  /**
   * Get invoice statistics for dashboard
   */
  getStats(dateFrom?: string, dateTo?: string): {
    totalCount: number;
    draftCount: number;
    issuedCount: number;
    paidCount: number;
    totalNet: number;
    totalGross: number;
    unpaidAmount: number;
  } {
    let dateFilter = '';
    const params: any[] = [];

    if (dateFrom) {
      dateFilter += ' AND date(issue_date) >= date(?)';
      params.push(dateFrom);
    }
    if (dateTo) {
      dateFilter += ' AND date(issue_date) <= date(?)';
      params.push(dateTo);
    }

    const stats = database.get<any>(`
      SELECT
        COUNT(*) as totalCount,
        SUM(CASE WHEN status = 'DRAFT' THEN 1 ELSE 0 END) as draftCount,
        SUM(CASE WHEN status = 'ISSUED' THEN 1 ELSE 0 END) as issuedCount,
        SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END) as paidCount,
        COALESCE(SUM(CASE WHEN status != 'CANCELLED' THEN total_net ELSE 0 END), 0) as totalNet,
        COALESCE(SUM(CASE WHEN status != 'CANCELLED' THEN total_gross ELSE 0 END), 0) as totalGross,
        COALESCE(SUM(CASE WHEN status IN ('ISSUED', 'PARTIALLY_PAID') THEN total_gross - paid_amount ELSE 0 END), 0) as unpaidAmount
      FROM invoices WHERE 1=1 ${dateFilter}
    `, params);

    return {
      totalCount: stats?.totalCount ?? 0,
      draftCount: stats?.draftCount ?? 0,
      issuedCount: stats?.issuedCount ?? 0,
      paidCount: stats?.paidCount ?? 0,
      totalNet: stats?.totalNet ?? 0,
      totalGross: stats?.totalGross ?? 0,
      unpaidAmount: stats?.unpaidAmount ?? 0,
    };
  },

  // ==========================================
  // KSeF Methods
  // ==========================================

  /**
   * Update KSeF status for an invoice
   */
  updateKsefStatus(
    id: string,
    status: KsefStatus,
    ksefNumber: string | null,
    error: string | null,
  ): void {
    const retryIncrement = status === 'ERROR' ? 1 : 0;

    database.run(
      `UPDATE invoices SET
        ksef_status = ?,
        ksef_number = COALESCE(?, ksef_number),
        ksef_sent_at = CASE WHEN ? IN ('SENT', 'ACCEPTED') THEN datetime('now') ELSE ksef_sent_at END,
        ksef_error = ?,
        ksef_retry_count = ksef_retry_count + ?,
        updated_at = datetime('now')
      WHERE id = ?`,
      [status, ksefNumber, status, error, retryIncrement, id],
    );
    database.save();
    logger.info(`[InvoiceRepo] Updated KSeF status for ${id}: ${status}${ksefNumber ? ` (${ksefNumber})` : ''}`);
  },

  /**
   * Get invoices pending KSeF submission
   */
  getKsefPending(): InvoiceRow[] {
    return database.all<InvoiceRow>(
      `SELECT * FROM invoices
       WHERE status != 'DRAFT'
         AND status != 'CANCELLED'
         AND type != 'PROFORMA'
         AND ksef_number IS NULL
         AND (ksef_status IS NULL OR ksef_status IN ('PENDING', 'ERROR'))
         AND ksef_retry_count < 3
       ORDER BY created_at ASC`,
    );
  },

  /**
   * Get invoices that need KSeF sending (for manual "Send to KSeF" button)
   */
  getKsefNotSent(): InvoiceRow[] {
    return database.all<InvoiceRow>(
      `SELECT * FROM invoices
       WHERE status != 'DRAFT'
         AND status != 'CANCELLED'
         AND type != 'PROFORMA'
         AND ksef_number IS NULL
       ORDER BY issue_date DESC, created_at DESC`,
    );
  },

  /**
   * Get KSeF statistics
   */
  getKsefStats(): {
    pending: number;
    sending: number;
    sent: number;
    accepted: number;
    rejected: number;
    error: number;
  } {
    const stats = database.get<any>(`
      SELECT
        SUM(CASE WHEN ksef_status IS NULL OR ksef_status = 'PENDING' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN ksef_status = 'SENDING' THEN 1 ELSE 0 END) as sending,
        SUM(CASE WHEN ksef_status = 'SENT' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN ksef_status = 'ACCEPTED' THEN 1 ELSE 0 END) as accepted,
        SUM(CASE WHEN ksef_status = 'REJECTED' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN ksef_status = 'ERROR' THEN 1 ELSE 0 END) as error
      FROM invoices
      WHERE status != 'DRAFT'
        AND status != 'CANCELLED'
        AND type != 'PROFORMA'
    `);

    return {
      pending: stats?.pending ?? 0,
      sending: stats?.sending ?? 0,
      sent: stats?.sent ?? 0,
      accepted: stats?.accepted ?? 0,
      rejected: stats?.rejected ?? 0,
      error: stats?.error ?? 0,
    };
  },

  /**
   * Check if invoice should be sent to KSeF
   */
  shouldSendToKsef(invoice: InvoiceRow): boolean {
    // Don't send DRAFT or CANCELLED
    if (invoice.status === 'DRAFT' || invoice.status === 'CANCELLED') {
      return false;
    }

    // Don't send PROFORMA
    if (invoice.type === 'PROFORMA') {
      return false;
    }

    // Already sent
    if (invoice.ksef_number) {
      return false;
    }

    return true;
  },
};
