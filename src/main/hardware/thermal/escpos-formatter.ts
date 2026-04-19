import { ReceiptData, ReceiptItem, charsPerLineFor } from '../../../shared/types';

export type EscPosCharset = 'utf8' | 'cp1250' | 'ascii';
export type EscPosCutMode = 'partial' | 'full' | 'none';

/**
 * Subset of CP1250 (Polish) mappings for the characters most likely to appear
 * in Polish receipts. Characters outside this map fall back to ASCII stripping.
 */
const CP1250_MAP: Record<string, number> = {
  'Ą': 0xA5, 'ą': 0xB9, 'Ć': 0xC6, 'ć': 0xE6, 'Ę': 0xCA, 'ę': 0xEA,
  'Ł': 0xA3, 'ł': 0xB3, 'Ń': 0xD1, 'ń': 0xF1, 'Ó': 0xD3, 'ó': 0xF3,
  'Ś': 0x8C, 'ś': 0x9C, 'Ź': 0x8F, 'ź': 0x9F, 'Ż': 0xAF, 'ż': 0xBF,
};

function encodeText(str: string, charset: EscPosCharset): Buffer {
  if (charset === 'utf8') return Buffer.from(str, 'utf8');
  if (charset === 'cp1250') {
    const bytes: number[] = [];
    for (const ch of str) {
      if (ch.charCodeAt(0) < 0x80) { bytes.push(ch.charCodeAt(0)); continue; }
      const mapped = CP1250_MAP[ch];
      if (mapped !== undefined) { bytes.push(mapped); continue; }
      // Unmapped: strip diacritic and keep ASCII fallback
      const stripped = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      for (const s of stripped) bytes.push(s.charCodeAt(0) < 0x80 ? s.charCodeAt(0) : 0x3F);
    }
    return Buffer.from(bytes);
  }
  // ASCII: strip diacritics aggressively
  const ascii = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[Łł]/g, m => m === 'Ł' ? 'L' : 'l')
    .replace(/[^\x00-\x7F]/g, '?');
  return Buffer.from(ascii, 'ascii');
}

/**
 * ESC/POS Commands for thermal printers
 * Standard commands supported by most thermal receipt printers
 */
const ESC = 0x1B;  // Escape
const FS = 0x1C;   // Field Separator
const GS = 0x1D;   // Group Separator
const LF = 0x0A;   // Line Feed
const CR = 0x0D;   // Carriage Return

const ESCPOS = {
  // Initialize printer + enable UTF-8 multi-byte character mode.
  // After ESC @ (reset), we send two commands:
  //   1. ESC t 0xFF  — select codepage 255 (user-defined / bypass) to stop
  //      single-byte codepage interpretation of high bytes
  //   2. FS . 2 0 0 0 — select UTF-8 as the multi-byte encoding
  //      (FS . = 0x1C 0x2E, args: encType=2(UTF-8), hiB=0, loB=0, opt=0)
  // This pair is supported by Epson, Xprinter, Star, Bixolon, and most
  // modern ESC/POS printers. Printers that don't understand FS . silently
  // ignore it and fall back to the selected codepage — harmless.
  INIT: Buffer.from([
    ESC, 0x40,                     // ESC @   — initialize/reset
    FS, 0x2E, 0x02, 0x00, 0x00, 0x00, // FS . 2 0 0 0 — UTF-8 mode
  ]),

  // Text alignment
  ALIGN_LEFT: Buffer.from([ESC, 0x61, 0x00]),
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 0x01]),
  ALIGN_RIGHT: Buffer.from([ESC, 0x61, 0x02]),

  // Text style
  BOLD_ON: Buffer.from([ESC, 0x45, 0x01]),
  BOLD_OFF: Buffer.from([ESC, 0x45, 0x00]),
  UNDERLINE_ON: Buffer.from([ESC, 0x2D, 0x01]),
  UNDERLINE_OFF: Buffer.from([ESC, 0x2D, 0x00]),
  DOUBLE_HEIGHT_ON: Buffer.from([ESC, 0x21, 0x10]),
  DOUBLE_WIDTH_ON: Buffer.from([ESC, 0x21, 0x20]),
  DOUBLE_SIZE_ON: Buffer.from([ESC, 0x21, 0x30]),
  NORMAL_SIZE: Buffer.from([ESC, 0x21, 0x00]),

  // Font
  FONT_A: Buffer.from([ESC, 0x4D, 0x00]),  // Standard font
  FONT_B: Buffer.from([ESC, 0x4D, 0x01]),  // Smaller font

  // Line spacing
  LINE_SPACING_DEFAULT: Buffer.from([ESC, 0x32]),
  LINE_SPACING_SET: (n: number) => Buffer.from([ESC, 0x33, n]),

  // Paper
  FEED_LINES: (n: number) => Buffer.from([ESC, 0x64, n]),
  FEED_PAPER: (n: number) => Buffer.from([ESC, 0x4A, n]),

  // Cut paper
  CUT_PARTIAL: Buffer.from([GS, 0x56, 0x01]),
  CUT_FULL: Buffer.from([GS, 0x56, 0x00]),

  // Cash drawer
  DRAWER_KICK_PIN2: Buffer.from([ESC, 0x70, 0x00, 0x19, 0xFA]),
  DRAWER_KICK_PIN5: Buffer.from([ESC, 0x70, 0x01, 0x19, 0xFA]),

  // Barcode
  BARCODE_HEIGHT: (n: number) => Buffer.from([GS, 0x68, n]),
  BARCODE_WIDTH: (n: number) => Buffer.from([GS, 0x77, n]),
  BARCODE_TEXT_BELOW: Buffer.from([GS, 0x48, 0x02]),
  BARCODE_CODE128: (data: string) => Buffer.concat([
    Buffer.from([GS, 0x6B, 0x49, data.length + 2, 0x7B, 0x42]),
    Buffer.from(data, 'ascii'),
  ]),

  // QR Code
  QR_MODEL: Buffer.from([GS, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
  QR_SIZE: (n: number) => Buffer.from([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, n]),
  QR_ERROR: Buffer.from([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31]),
  QR_STORE: (data: string) => {
    const len = data.length + 3;
    return Buffer.concat([
      Buffer.from([GS, 0x28, 0x6B, len & 0xFF, (len >> 8) & 0xFF, 0x31, 0x50, 0x30]),
      Buffer.from(data, 'utf8'),
    ]);
  },
  QR_PRINT: Buffer.from([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30]),
};

/**
 * ESC/POS Formatter for thermal receipt printers
 */
export class EscPosFormatter {
  private charsPerLine: number;
  private charset: EscPosCharset;
  private cutMode: EscPosCutMode;

  constructor(
    private paperWidth: number = 80,
    charsPerLine?: number,
    opts?: { charset?: EscPosCharset; cutMode?: EscPosCutMode }
  ) {
    this.charsPerLine = charsPerLine || charsPerLineFor(paperWidth);
    this.charset = opts?.charset ?? 'utf8';
    this.cutMode = opts?.cutMode ?? 'partial';
  }

  setCharset(charset: EscPosCharset): void { this.charset = charset; }
  setCutMode(mode: EscPosCutMode): void { this.cutMode = mode; }
  getCharset(): EscPosCharset { return this.charset; }
  getCutMode(): EscPosCutMode { return this.cutMode; }

  private cutBytes(): Buffer {
    if (this.cutMode === 'none') return Buffer.alloc(0);
    return this.cutMode === 'full' ? ESCPOS.CUT_FULL : ESCPOS.CUT_PARTIAL;
  }

  /**
   * Format a complete receipt
   */
  formatReceipt(data: ReceiptData): Buffer {
    const parts: Buffer[] = [];

    // Initialize printer
    parts.push(ESCPOS.INIT);

    // Header
    parts.push(ESCPOS.ALIGN_CENTER);

    // Refund banner
    if (data.isRefund) {
      parts.push(ESCPOS.BOLD_ON);
      parts.push(this.text('*** ZWROT / REFUND ***'));
      parts.push(ESCPOS.BOLD_OFF);
      if (data.originalOrderNumber) {
        parts.push(this.text(`Original: #${data.originalOrderNumber}`));
      }
      if (data.refundReason) {
        parts.push(this.text(`Reason: ${data.refundReason}`));
      }
      parts.push(this.text(''));
    }

    // Reprint banner
    if (data.isReprint) {
      parts.push(ESCPOS.BOLD_ON);
      parts.push(this.text('*** KOPIA / REPRINT ***'));
      parts.push(ESCPOS.BOLD_OFF);
      parts.push(this.text(''));
    }

    parts.push(ESCPOS.DOUBLE_SIZE_ON);
    parts.push(this.text(data.salonName || 'Zira AI POS'));
    parts.push(ESCPOS.NORMAL_SIZE);
    parts.push(this.text(''));

    // Order number
    if (data.orderNumber) {
      parts.push(ESCPOS.BOLD_ON);
      parts.push(this.text(`Order #${data.orderNumber}`));
      parts.push(ESCPOS.BOLD_OFF);
    }

    // Date/Time — use original date for reprints
    const receiptDate = data.isReprint && data.originalDate
      ? new Date(data.originalDate.includes('T') ? data.originalDate : data.originalDate.replace(' ', 'T') + 'Z').toLocaleString()
      : new Date().toLocaleString();
    parts.push(this.text(receiptDate));
    if (data.isReprint) {
      parts.push(this.text(`Reprinted: ${new Date().toLocaleString()}`));
    }
    parts.push(this.text(''));

    // Separator
    parts.push(ESCPOS.ALIGN_LEFT);
    parts.push(this.text(this.repeatChar('-', this.charsPerLine)));

    // Items
    for (const item of data.items) {
      parts.push(this.formatItem(item));
    }

    // Separator
    parts.push(this.text(this.repeatChar('-', this.charsPerLine)));

    // Subtotal
    if (data.subtotal) {
      parts.push(this.formatLine('Subtotal:', this.formatMoney(data.subtotal)));
    }

    // Discount
    if (data.discount && data.discount > 0) {
      parts.push(this.formatLine('Discount:', `-${this.formatMoney(data.discount)}`));
    }

    // Total
    parts.push(ESCPOS.BOLD_ON);
    parts.push(ESCPOS.DOUBLE_HEIGHT_ON);
    parts.push(this.formatLine('TOTAL:', this.formatMoney(data.total)));
    parts.push(ESCPOS.NORMAL_SIZE);
    parts.push(ESCPOS.BOLD_OFF);

    // Separator
    parts.push(this.text(this.repeatChar('=', this.charsPerLine)));

    // Payment — split or single
    if (data.tenders && data.tenders.length > 1) {
      parts.push(this.formatLine('Payment:', 'SPLIT'));
      for (const tender of data.tenders) {
        parts.push(this.formatLine(`  ${tender.method}:`, this.formatMoney(tender.amount)));
      }
      // Change from cash tender
      const cashTender = data.tenders.find(t => t.method.toUpperCase() === 'CASH');
      if (cashTender) {
        const totalNonCash = data.tenders.filter(t => t.method.toUpperCase() !== 'CASH').reduce((s, t) => s + t.amount, 0);
        const cashNeeded = data.total - totalNonCash;
        if (cashTender.amount > cashNeeded && cashNeeded > 0) {
          parts.push(this.formatLine('Change:', this.formatMoney(cashTender.amount - cashNeeded)));
        }
      }
    } else {
      parts.push(this.formatLine('Payment:', data.payment.method));
      parts.push(this.formatLine('Amount:', this.formatMoney(data.payment.amount)));
      if (data.payment.method.toUpperCase() === 'CASH' && data.payment.amount > data.total) {
        const change = data.payment.amount - data.total;
        parts.push(this.formatLine('Change:', this.formatMoney(change)));
      }
    }

    // Footer
    parts.push(this.text(''));
    parts.push(ESCPOS.ALIGN_CENTER);

    // Customer info (if invoice)
    if (data.customerNip) {
      parts.push(this.text(`NIP: ${data.customerNip}`));
      if (data.customerName) {
        parts.push(this.text(data.customerName));
      }
    }

    // Cashier
    if (data.cashierName) {
      parts.push(this.text(`Served by: ${data.cashierName}`));
    }

    // Thank you message
    parts.push(this.text(''));
    parts.push(this.text('Thank you for your visit!'));
    parts.push(this.text('See you again!'));

    // Feed and cut
    parts.push(ESCPOS.FEED_LINES(4));
    parts.push(this.cutBytes());

    return Buffer.concat(parts);
  }

  /**
   * Format a single item line
   */
  private formatItem(item: ReceiptItem): Buffer {
    const parts: Buffer[] = [];

    // Item name
    const name = this.truncate(item.name, this.charsPerLine - 15);
    parts.push(this.text(name));

    // Quantity x Price = Total (with unit if available)
    const unit = item.unit ? ` ${item.unit}` : '';
    const qty = `${item.quantity}${unit}`;
    const price = this.formatMoney(item.unitPrice);
    const total = this.formatMoney(item.totalPrice);
    const detail = `  ${qty} x ${price} = ${total}`;
    parts.push(this.text(detail));

    return Buffer.concat(parts);
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
   * Format test page. Model info (if provided) is printed on the receipt so
   * users can visually verify auto-identification matches their hardware.
   */
  formatTestPage(modelInfo?: { modelName?: string; firmwareVersion?: string }): Buffer {
    const parts: Buffer[] = [];

    parts.push(ESCPOS.INIT);
    parts.push(ESCPOS.ALIGN_CENTER);
    parts.push(ESCPOS.BOLD_ON);
    parts.push(this.text('Zira AI'));
    parts.push(ESCPOS.BOLD_OFF);
    parts.push(this.text(this.repeatChar('-', this.charsPerLine)));
    if (modelInfo?.modelName) {
      parts.push(this.text(modelInfo.modelName));
      if (modelInfo.firmwareVersion) parts.push(this.text(`fw ${modelInfo.firmwareVersion}`));
    }
    parts.push(this.text(`${this.paperWidth}mm / ${this.charsPerLine} chars`));
    parts.push(this.text(`charset: ${this.charset}  cut: ${this.cutMode}`));
    parts.push(this.text(new Date().toLocaleString()));
    parts.push(this.text(this.repeatChar('-', this.charsPerLine)));
    parts.push(this.text('OK'));

    parts.push(ESCPOS.FEED_LINES(3));
    parts.push(this.cutBytes());

    return Buffer.concat(parts);
  }

  /**
   * Format receipt as plain-text structured lines for raster image rendering.
   * Used when the printer doesn't support UTF-8 text mode.
   */
  formatReceiptPlainLines(data: ReceiptData): Array<{ text: string; rightText?: string; bold?: boolean; big?: boolean; center?: boolean; separator?: boolean }> {
    type Line = { text: string; rightText?: string; bold?: boolean; big?: boolean; center?: boolean; separator?: boolean };
    const lines: Line[] = [];
    const lr = (left: string, right: string, opts?: Partial<Line>): Line =>
      ({ text: left, rightText: right, ...opts });

    if (data.isRefund) {
      lines.push({ text: '*** ZWROT / REFUND ***', bold: true, center: true });
      if (data.originalOrderNumber) lines.push({ text: `Original: #${data.originalOrderNumber}`, center: true });
      if (data.refundReason) lines.push({ text: `Reason: ${data.refundReason}`, center: true });
    }
    if (data.isReprint) {
      lines.push({ text: '*** KOPIA / REPRINT ***', bold: true, center: true });
    }
    lines.push({ text: data.salonName || 'Zira AI POS', big: true, center: true });
    lines.push({ text: '' });
    if (data.orderNumber) lines.push({ text: `Order #${data.orderNumber}`, bold: true, center: true });
    const receiptDate = data.isReprint && data.originalDate
      ? new Date(data.originalDate.includes('T') ? data.originalDate : data.originalDate.replace(' ', 'T') + 'Z').toLocaleString()
      : new Date().toLocaleString();
    lines.push({ text: receiptDate, center: true });
    if (data.isReprint) lines.push({ text: `Reprinted: ${new Date().toLocaleString()}`, center: true });
    lines.push({ text: '' });
    lines.push({ separator: true, text: '' });

    for (const item of data.items) {
      const name = this.truncate(item.name, 40);
      lines.push({ text: name });
      const unit = item.unit ? ` ${item.unit}` : '';
      const qty = `${item.quantity}${unit}`;
      lines.push({ text: `  ${qty} x ${this.formatMoney(item.unitPrice)} = ${this.formatMoney(item.totalPrice)}` });
    }

    lines.push({ separator: true, text: '' });
    if (data.subtotal) lines.push(lr('Subtotal:', this.formatMoney(data.subtotal)));
    if (data.discount && data.discount > 0) lines.push(lr('Discount:', `-${this.formatMoney(data.discount)}`));
    lines.push(lr('TOTAL:', this.formatMoney(data.total), { bold: true, big: true }));
    lines.push({ separator: true, text: '' });

    if (data.tenders && data.tenders.length > 1) {
      lines.push(lr('Payment:', 'SPLIT'));
      for (const tender of data.tenders) {
        lines.push(lr(`  ${tender.method}:`, this.formatMoney(tender.amount)));
      }
      const cashTender = data.tenders.find(t => t.method.toUpperCase() === 'CASH');
      if (cashTender) {
        const totalNonCash = data.tenders.filter(t => t.method.toUpperCase() !== 'CASH').reduce((s, t) => s + t.amount, 0);
        const cashNeeded = data.total - totalNonCash;
        if (cashTender.amount > cashNeeded && cashNeeded > 0) {
          lines.push(lr('Change:', this.formatMoney(cashTender.amount - cashNeeded)));
        }
      }
    } else {
      lines.push(lr('Payment:', data.payment.method));
      lines.push(lr('Amount:', this.formatMoney(data.payment.amount)));
      if (data.payment.method.toUpperCase() === 'CASH' && data.payment.amount > data.total) {
        lines.push(lr('Change:', this.formatMoney(data.payment.amount - data.total)));
      }
    }

    lines.push({ text: '' });
    if (data.customerNip) {
      lines.push({ text: `NIP: ${data.customerNip}`, center: true });
      if (data.customerName) lines.push({ text: data.customerName, center: true });
    }
    if (data.cashierName) lines.push({ text: `Served by: ${data.cashierName}`, center: true });
    lines.push({ text: '' });
    lines.push({ text: 'Thank you for your visit!', center: true });
    lines.push({ text: 'See you again!', center: true });

    return lines;
  }

  /**
   * Get cash drawer kick command
   */
  getCashDrawerCommand(): Buffer {
    return ESCPOS.DRAWER_KICK_PIN2;
  }

  /**
   * Get paper cut command
   */
  getCutCommand(fullCut: boolean = false): Buffer {
    return fullCut ? ESCPOS.CUT_FULL : ESCPOS.CUT_PARTIAL;
  }

  /**
   * Convert text to buffer with line feed
   */
  private text(str: string): Buffer {
    return Buffer.concat([
      encodeText(str, this.charset),
      Buffer.from([LF]),
    ]);
  }

  /**
   * Format money value (grosze to zł)
   */
  private formatMoney(grosze: number): string {
    const zl = grosze / 100;
    return zl.toFixed(2) + ' zl';
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

  /**
   * Format barcode
   */
  formatBarcode(data: string, height: number = 80): Buffer {
    const parts: Buffer[] = [];
    parts.push(ESCPOS.ALIGN_CENTER);
    parts.push(ESCPOS.BARCODE_HEIGHT(height));
    parts.push(ESCPOS.BARCODE_WIDTH(2));
    parts.push(ESCPOS.BARCODE_TEXT_BELOW);
    parts.push(ESCPOS.BARCODE_CODE128(data));
    parts.push(Buffer.from([LF, LF]));
    parts.push(ESCPOS.ALIGN_LEFT);
    return Buffer.concat(parts);
  }

  /**
   * Format QR code
   */
  formatQRCode(data: string, size: number = 6): Buffer {
    const parts: Buffer[] = [];
    parts.push(ESCPOS.ALIGN_CENTER);
    parts.push(ESCPOS.QR_MODEL);
    parts.push(ESCPOS.QR_SIZE(size));
    parts.push(ESCPOS.QR_ERROR);
    parts.push(ESCPOS.QR_STORE(data));
    parts.push(ESCPOS.QR_PRINT);
    parts.push(Buffer.from([LF, LF]));
    parts.push(ESCPOS.ALIGN_LEFT);
    return Buffer.concat(parts);
  }

  /**
   * Format daily report (Raport Dobowy)
   * For non-fiscal printers, this generates a summary report
   */
  formatDailyReport(reportData: DailyReportData): Buffer {
    const parts: Buffer[] = [];

    // Initialize
    parts.push(ESCPOS.INIT);

    // Header
    parts.push(ESCPOS.ALIGN_CENTER);
    parts.push(ESCPOS.DOUBLE_SIZE_ON);
    parts.push(this.text('RAPORT DOBOWY'));
    parts.push(ESCPOS.NORMAL_SIZE);
    parts.push(this.text(''));

    // Date range
    parts.push(ESCPOS.BOLD_ON);
    parts.push(this.text(`Data: ${reportData.date}`));
    parts.push(ESCPOS.BOLD_OFF);
    parts.push(this.text(''));

    // Separator
    parts.push(ESCPOS.ALIGN_LEFT);
    parts.push(this.text(this.repeatChar('=', this.charsPerLine)));

    // Sales summary
    parts.push(ESCPOS.BOLD_ON);
    parts.push(this.text('PODSUMOWANIE SPRZEDAZY'));
    parts.push(ESCPOS.BOLD_OFF);
    parts.push(this.text(this.repeatChar('-', this.charsPerLine)));

    parts.push(this.formatLine('Liczba transakcji:', reportData.transactionCount.toString()));
    parts.push(this.formatLine('Sprzedaz brutto:', this.formatMoney(reportData.grossSales)));

    if (reportData.discounts > 0) {
      parts.push(this.formatLine('Rabaty:', `-${this.formatMoney(reportData.discounts)}`));
    }

    parts.push(this.formatLine('Sprzedaz netto:', this.formatMoney(reportData.netSales)));

    // VAT Summary
    if (reportData.vatSummary && reportData.vatSummary.length > 0) {
      parts.push(this.text(''));
      parts.push(this.text(this.repeatChar('-', this.charsPerLine)));
      parts.push(ESCPOS.BOLD_ON);
      parts.push(this.text('PODSUMOWANIE VAT'));
      parts.push(ESCPOS.BOLD_OFF);
      parts.push(this.text(this.repeatChar('-', this.charsPerLine)));

      for (const vat of reportData.vatSummary) {
        parts.push(this.formatLine(`PTU ${vat.rate}%:`, this.formatMoney(vat.amount)));
      }
    }

    // Payment methods
    if (reportData.paymentSummary && reportData.paymentSummary.length > 0) {
      parts.push(this.text(''));
      parts.push(this.text(this.repeatChar('-', this.charsPerLine)));
      parts.push(ESCPOS.BOLD_ON);
      parts.push(this.text('FORMY PLATNOSCI'));
      parts.push(ESCPOS.BOLD_OFF);
      parts.push(this.text(this.repeatChar('-', this.charsPerLine)));

      for (const payment of reportData.paymentSummary) {
        parts.push(this.formatLine(`${payment.method}:`, this.formatMoney(payment.amount)));
      }
    }

    // Separator
    parts.push(this.text(this.repeatChar('=', this.charsPerLine)));

    // Total
    parts.push(ESCPOS.BOLD_ON);
    parts.push(ESCPOS.DOUBLE_HEIGHT_ON);
    parts.push(this.formatLine('SUMA:', this.formatMoney(reportData.netSales)));
    parts.push(ESCPOS.NORMAL_SIZE);
    parts.push(ESCPOS.BOLD_OFF);

    // Footer
    parts.push(this.text(''));
    parts.push(ESCPOS.ALIGN_CENTER);
    parts.push(this.text(`Wydrukowano: ${new Date().toLocaleString()}`));

    if (reportData.cashierName) {
      parts.push(this.text(`Kasjer: ${reportData.cashierName}`));
    }

    // Feed and cut
    parts.push(ESCPOS.FEED_LINES(4));
    parts.push(ESCPOS.CUT_PARTIAL);

    return Buffer.concat(parts);
  }

  /**
   * Format X Report (non-zeroing report)
   */
  formatXReport(reportData: DailyReportData): Buffer {
    const parts: Buffer[] = [];

    parts.push(ESCPOS.INIT);
    parts.push(ESCPOS.ALIGN_CENTER);
    parts.push(ESCPOS.DOUBLE_SIZE_ON);
    parts.push(this.text('RAPORT X'));
    parts.push(ESCPOS.NORMAL_SIZE);
    parts.push(this.text('(Raport niefiskalny)'));
    parts.push(this.text(''));

    // Rest is similar to daily report
    parts.push(ESCPOS.ALIGN_LEFT);
    parts.push(this.text(`Data: ${reportData.date}`));
    parts.push(this.text(this.repeatChar('-', this.charsPerLine)));
    parts.push(this.formatLine('Transakcje:', reportData.transactionCount.toString()));
    parts.push(this.formatLine('Sprzedaz:', this.formatMoney(reportData.grossSales)));
    parts.push(this.formatLine('Rabaty:', this.formatMoney(reportData.discounts)));
    parts.push(this.formatLine('Netto:', this.formatMoney(reportData.netSales)));
    parts.push(this.text(this.repeatChar('-', this.charsPerLine)));

    parts.push(ESCPOS.ALIGN_CENTER);
    parts.push(this.text(`Wydrukowano: ${new Date().toLocaleString()}`));

    parts.push(ESCPOS.FEED_LINES(4));
    parts.push(ESCPOS.CUT_PARTIAL);

    return Buffer.concat(parts);
  }

  /**
   * Format Z Report (end of day, zeroing report)
   */
  formatZReport(reportData: DailyReportData): Buffer {
    const parts: Buffer[] = [];

    parts.push(ESCPOS.INIT);
    parts.push(ESCPOS.ALIGN_CENTER);
    parts.push(ESCPOS.DOUBLE_SIZE_ON);
    parts.push(this.text('RAPORT Z'));
    parts.push(ESCPOS.NORMAL_SIZE);
    parts.push(this.text('(Raport dobowy fiskalny)'));
    parts.push(this.text(''));

    // This is the same as daily report but marked as Z report
    const dailyReport = this.formatDailyReport(reportData);

    // Remove the header part and add Z report header
    parts.push(ESCPOS.ALIGN_LEFT);
    parts.push(this.text(`Nr raportu: ${reportData.reportNumber || 'N/A'}`));
    parts.push(this.text(`Data: ${reportData.date}`));
    parts.push(this.text(this.repeatChar('=', this.charsPerLine)));

    parts.push(this.formatLine('Transakcje:', reportData.transactionCount.toString()));
    parts.push(this.formatLine('Sprzedaz brutto:', this.formatMoney(reportData.grossSales)));
    parts.push(this.formatLine('Rabaty:', this.formatMoney(reportData.discounts)));
    parts.push(ESCPOS.BOLD_ON);
    parts.push(this.formatLine('SUMA NETTO:', this.formatMoney(reportData.netSales)));
    parts.push(ESCPOS.BOLD_OFF);

    // VAT breakdown
    if (reportData.vatSummary) {
      parts.push(this.text(''));
      parts.push(this.text('PTU:'));
      for (const vat of reportData.vatSummary) {
        parts.push(this.formatLine(`  ${vat.rate}%:`, this.formatMoney(vat.amount)));
      }
    }

    parts.push(this.text(this.repeatChar('=', this.charsPerLine)));
    parts.push(ESCPOS.ALIGN_CENTER);
    parts.push(this.text(`Wydrukowano: ${new Date().toLocaleString()}`));

    parts.push(ESCPOS.FEED_LINES(4));
    parts.push(ESCPOS.CUT_PARTIAL);

    return Buffer.concat(parts);
  }
}

/**
 * Daily report data structure
 */
export interface DailyReportData {
  date: string;
  reportNumber?: string;
  transactionCount: number;
  grossSales: number;      // In grosze
  discounts: number;       // In grosze
  netSales: number;        // In grosze
  vatSummary?: Array<{
    rate: number;          // VAT rate (23, 8, 5, 0)
    amount: number;        // In grosze
  }>;
  paymentSummary?: Array<{
    method: string;        // CASH, CARD, etc.
    amount: number;        // In grosze
  }>;
  cashierName?: string;
}
