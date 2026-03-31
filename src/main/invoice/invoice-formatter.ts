import { InvoiceRow, InvoiceItemRow, VatSummaryEntry } from '../../shared/types';

/**
 * ESC/POS Commands for thermal printers
 */
const ESC = 0x1B;
const GS = 0x1D;
const LF = 0x0A;

const ESCPOS = {
  INIT: Buffer.from([ESC, 0x40]),
  ALIGN_LEFT: Buffer.from([ESC, 0x61, 0x00]),
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 0x01]),
  ALIGN_RIGHT: Buffer.from([ESC, 0x61, 0x02]),
  BOLD_ON: Buffer.from([ESC, 0x45, 0x01]),
  BOLD_OFF: Buffer.from([ESC, 0x45, 0x00]),
  DOUBLE_HEIGHT_ON: Buffer.from([ESC, 0x21, 0x10]),
  DOUBLE_WIDTH_ON: Buffer.from([ESC, 0x21, 0x20]),
  DOUBLE_SIZE_ON: Buffer.from([ESC, 0x21, 0x30]),
  NORMAL_SIZE: Buffer.from([ESC, 0x21, 0x00]),
  FEED_LINES: (n: number) => Buffer.from([ESC, 0x64, n]),
  CUT_PARTIAL: Buffer.from([GS, 0x56, 0x01]),
};

/**
 * ESC/POS Invoice Formatter for thermal 80mm printers
 * Polish compliance for Paragon and VAT Invoice printing
 */
export class InvoiceFormatter {
  private charsPerLine: number;

  constructor(
    private paperWidth: number = 80,
    charsPerLine?: number,
  ) {
    this.charsPerLine = charsPerLine || (paperWidth === 80 ? 48 : 32);
  }

  /**
   * Format invoice for thermal printing
   */
  formatInvoice(invoice: InvoiceRow, items: InvoiceItemRow[], vatSummary: VatSummaryEntry[]): Buffer {
    const parts: Buffer[] = [];

    // Initialize printer
    parts.push(ESCPOS.INIT);

    // Header - Seller info
    parts.push(ESCPOS.ALIGN_CENTER);
    parts.push(ESCPOS.DOUBLE_SIZE_ON);
    parts.push(this.text(invoice.seller_name));
    parts.push(ESCPOS.NORMAL_SIZE);
    parts.push(this.text(invoice.seller_address));
    parts.push(this.text(`NIP: ${invoice.seller_nip}`));
    parts.push(this.text(''));

    // Invoice title
    parts.push(ESCPOS.BOLD_ON);
    parts.push(ESCPOS.DOUBLE_HEIGHT_ON);
    const title = this.getInvoiceTitle(invoice.type);
    parts.push(this.text(title));
    parts.push(ESCPOS.NORMAL_SIZE);
    parts.push(ESCPOS.BOLD_OFF);

    // Invoice number
    parts.push(this.text(`Nr: ${invoice.invoice_number}`));
    parts.push(this.text(''));

    // Separator
    parts.push(ESCPOS.ALIGN_LEFT);
    parts.push(this.text(this.repeatChar('=', this.charsPerLine)));

    // Dates
    parts.push(this.formatLine('Data wystawienia:', invoice.issue_date));
    parts.push(this.formatLine('Data sprzedazy:', invoice.sale_date));
    if (invoice.due_date) {
      parts.push(this.formatLine('Termin platnosci:', invoice.due_date));
    }

    // Separator
    parts.push(this.text(this.repeatChar('-', this.charsPerLine)));

    // Customer info
    parts.push(ESCPOS.BOLD_ON);
    parts.push(this.text('NABYWCA:'));
    parts.push(ESCPOS.BOLD_OFF);
    parts.push(this.text(invoice.customer_name));
    if (invoice.customer_address) {
      parts.push(this.text(invoice.customer_address));
    }
    if (invoice.customer_nip) {
      parts.push(this.text(`NIP: ${invoice.customer_nip}`));
    }

    // Separator
    parts.push(this.text(this.repeatChar('-', this.charsPerLine)));

    // Items header
    parts.push(ESCPOS.BOLD_ON);
    parts.push(this.text('POZYCJE:'));
    parts.push(ESCPOS.BOLD_OFF);
    parts.push(this.text(''));

    // Items
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      parts.push(this.formatInvoiceItem(i + 1, item));
    }

    // Separator
    parts.push(this.text(this.repeatChar('-', this.charsPerLine)));

    // VAT Summary
    if (vatSummary.length > 0) {
      parts.push(ESCPOS.BOLD_ON);
      parts.push(this.text('ZESTAWIENIE VAT:'));
      parts.push(ESCPOS.BOLD_OFF);

      for (const vat of vatSummary) {
        const rateName = vat.rate >= 0 ? `${vat.rate}%` : 'ZW';
        parts.push(this.formatLine(
          `  ${rateName}:`,
          `${this.formatMoney(vat.net)} + ${this.formatMoney(vat.vat)} = ${this.formatMoney(vat.gross)}`,
        ));
      }
      parts.push(this.text(''));
    }

    // Separator
    parts.push(this.text(this.repeatChar('=', this.charsPerLine)));

    // Totals
    parts.push(this.formatLine('Razem netto:', this.formatMoney(invoice.total_net)));
    parts.push(this.formatLine('Razem VAT:', this.formatMoney(invoice.total_vat)));

    parts.push(ESCPOS.BOLD_ON);
    parts.push(ESCPOS.DOUBLE_HEIGHT_ON);
    parts.push(this.formatLine('DO ZAPLATY:', this.formatMoney(invoice.total_gross)));
    parts.push(ESCPOS.NORMAL_SIZE);
    parts.push(ESCPOS.BOLD_OFF);

    // Payment method
    parts.push(this.text(''));
    parts.push(this.formatLine('Forma platnosci:', this.getPaymentMethodName(invoice.payment_method)));

    // Bank info for transfers
    if (invoice.payment_method === 'BANK_TRANSFER' && invoice.seller_bank_account) {
      parts.push(this.text(''));
      parts.push(this.text('Rachunek bankowy:'));
      if (invoice.seller_bank_name) {
        parts.push(this.text(invoice.seller_bank_name));
      }
      parts.push(this.text(invoice.seller_bank_account));
    }

    // MPP warning
    if (invoice.split_payment_marker) {
      parts.push(this.text(''));
      parts.push(ESCPOS.BOLD_ON);
      parts.push(this.text('** MECHANIZM PODZIELONEJ PLATNOSCI **'));
      parts.push(ESCPOS.BOLD_OFF);
    }

    // Notes
    if (invoice.notes) {
      parts.push(this.text(''));
      parts.push(this.text('Uwagi:'));
      parts.push(this.text(invoice.notes));
    }

    // Footer
    parts.push(this.text(''));
    parts.push(ESCPOS.ALIGN_CENTER);
    parts.push(this.text('Dziekujemy!'));

    // Feed and cut
    parts.push(ESCPOS.FEED_LINES(4));
    parts.push(ESCPOS.CUT_PARTIAL);

    return Buffer.concat(parts);
  }

  /**
   * Format receipt (paragon) for thermal printing - simplified version
   */
  formatReceipt(invoice: InvoiceRow, items: InvoiceItemRow[], vatSummary: VatSummaryEntry[]): Buffer {
    const parts: Buffer[] = [];

    // Initialize printer
    parts.push(ESCPOS.INIT);

    // Header
    parts.push(ESCPOS.ALIGN_CENTER);
    parts.push(ESCPOS.DOUBLE_SIZE_ON);
    parts.push(this.text(invoice.seller_name));
    parts.push(ESCPOS.NORMAL_SIZE);
    parts.push(this.text(invoice.seller_address));
    parts.push(this.text(`NIP: ${invoice.seller_nip}`));

    // Receipt number
    parts.push(this.text(''));
    parts.push(ESCPOS.BOLD_ON);
    parts.push(this.text(`PARAGON nr ${invoice.invoice_number}`));
    parts.push(ESCPOS.BOLD_OFF);
    parts.push(this.text(invoice.issue_date));
    parts.push(this.text(''));

    // Separator
    parts.push(ESCPOS.ALIGN_LEFT);
    parts.push(this.text(this.repeatChar('-', this.charsPerLine)));

    // Items
    for (const item of items) {
      const name = this.truncate(item.name, this.charsPerLine - 15);
      parts.push(this.text(name));

      const qty = (item.quantity / 1000).toFixed(2);
      const price = this.formatMoney(item.unit_price_net);
      const total = this.formatMoney(item.total_gross);
      const vatRate = item.vat_rate >= 0 ? `${item.vat_rate}%` : 'ZW';
      parts.push(this.text(`  ${qty} x ${price} = ${total} [${vatRate}]`));
    }

    // Separator
    parts.push(this.text(this.repeatChar('-', this.charsPerLine)));

    // VAT breakdown (simplified)
    for (const vat of vatSummary) {
      const rateName = vat.rate >= 0 ? `PTU ${vat.rate}%` : 'PTU ZW';
      parts.push(this.formatLine(rateName + ':', this.formatMoney(vat.vat)));
    }

    // Total
    parts.push(this.text(this.repeatChar('=', this.charsPerLine)));
    parts.push(ESCPOS.BOLD_ON);
    parts.push(ESCPOS.DOUBLE_HEIGHT_ON);
    parts.push(this.formatLine('SUMA PLN:', this.formatMoney(invoice.total_gross)));
    parts.push(ESCPOS.NORMAL_SIZE);
    parts.push(ESCPOS.BOLD_OFF);

    // Payment
    parts.push(this.text(''));
    parts.push(this.formatLine('Platnosc:', this.getPaymentMethodName(invoice.payment_method)));

    // Customer NIP if provided (for NIP na paragonie)
    if (invoice.customer_nip) {
      parts.push(this.text(''));
      parts.push(this.text(`NIP nabywcy: ${invoice.customer_nip}`));
    }

    // Footer
    parts.push(this.text(''));
    parts.push(ESCPOS.ALIGN_CENTER);
    parts.push(this.text('Dziekujemy za zakupy!'));
    parts.push(this.text('Zapraszamy ponownie'));

    // Feed and cut
    parts.push(ESCPOS.FEED_LINES(4));
    parts.push(ESCPOS.CUT_PARTIAL);

    return Buffer.concat(parts);
  }

  /**
   * Format a single invoice item
   */
  private formatInvoiceItem(index: number, item: InvoiceItemRow): Buffer {
    const parts: Buffer[] = [];

    // Item name with index
    const name = `${index}. ${item.name}`;
    parts.push(this.text(this.truncate(name, this.charsPerLine)));

    // Details line: qty x price = total (VAT rate)
    const qty = (item.quantity / 1000).toFixed(2);
    const unit = item.unit || 'szt.';
    const price = this.formatMoney(item.unit_price_net);
    const total = this.formatMoney(item.total_gross);
    const vatRate = item.vat_rate >= 0 ? `${item.vat_rate}%` : 'ZW';

    const detail = `   ${qty} ${unit} x ${price} = ${total} [${vatRate}]`;
    parts.push(this.text(detail));

    // Discount if applicable
    if (item.discount_percent > 0) {
      const discountPct = (item.discount_percent / 100).toFixed(0);
      parts.push(this.text(`   Rabat: ${discountPct}%`));
    }

    return Buffer.concat(parts);
  }

  /**
   * Get invoice title based on type
   */
  private getInvoiceTitle(type: string): string {
    const titles: Record<string, string> = {
      RECEIPT: 'PARAGON',
      VAT: 'FAKTURA VAT',
      PROFORMA: 'FAKTURA PROFORMA',
      CORRECTION: 'FAKTURA KORYGUJACA',
      ADVANCE: 'FAKTURA ZALICZKOWA',
    };
    return titles[type] || 'FAKTURA';
  }

  /**
   * Get payment method name in Polish
   */
  private getPaymentMethodName(method: string): string {
    const names: Record<string, string> = {
      CASH: 'Gotowka',
      CARD: 'Karta',
      BANK_TRANSFER: 'Przelew',
      BLIK: 'BLIK',
      P24: 'Przelewy24',
    };
    return names[method] || method;
  }

  /**
   * Format a line with left and right aligned text
   */
  private formatLine(left: string, right: string): Buffer {
    const spaces = this.charsPerLine - left.length - right.length;
    const line = left + this.repeatChar(' ', Math.max(1, spaces)) + right;
    return this.text(line);
  }

  /**
   * Convert text to buffer with line feed
   */
  private text(str: string): Buffer {
    return Buffer.concat([
      Buffer.from(str, 'utf8'),
      Buffer.from([LF]),
    ]);
  }

  /**
   * Format money value (grosze to zł)
   */
  private formatMoney(grosze: number): string {
    const zl = grosze / 100;
    return zl.toFixed(2) + ' PLN';
  }

  /**
   * Repeat a character n times
   */
  private repeatChar(char: string, count: number): string {
    return char.repeat(Math.max(0, count));
  }

  /**
   * Truncate string to max length
   */
  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 1) + '.';
  }
}
