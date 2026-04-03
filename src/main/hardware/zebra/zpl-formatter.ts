import { ReceiptData, LabelData, BarcodeType, CheckinConfirmationData } from '../../../shared/types';

/**
 * ZPL command mappings for barcode types
 */
const BARCODE_COMMANDS: Record<BarcodeType, string> = {
  CODE128: '^BC',
  EAN13: '^BE',
  QR: '^BQ',
};

/**
 * ZPL Formatter for Zebra printers
 * Creates ZPL commands for labels and receipts
 */
export class ZplFormatter {
  private dotsPerMm: number;

  constructor(
    private labelWidth: number = 100,  // mm
    private labelHeight: number = 50,  // mm
    dpi: number = 203                   // Common: 203 or 300 dpi
  ) {
    this.dotsPerMm = dpi / 25.4;
  }

  /**
   * Update label dimensions (used by auto-detect)
   */
  updateDimensions(widthMm: number, heightMm: number): void {
    this.labelWidth = widthMm;
    this.labelHeight = heightMm;
  }

  /**
   * Convert mm to dots
   */
  private mmToDots(mm: number): number {
    return Math.round(mm * this.dotsPerMm);
  }

  /**
   * Sanitize text for ZPL (remove special characters)
   */
  private sanitizeText(text: string, maxLength: number = 50): string {
    return text
      .replace(/[\x00-\x1F\x7F]/g, '') // Control characters
      .replace(/[\^~]/g, '')            // ZPL special chars
      .trim()
      .substring(0, maxLength);
  }

  /**
   * Format label with barcode
   */
  formatLabel(data: LabelData): string {
    const lines: string[] = [];

    // Start ZPL format
    lines.push('^XA');

    // Set label size
    lines.push(`^LL${this.mmToDots(this.labelHeight)}`);
    lines.push(`^PW${this.mmToDots(this.labelWidth)}`);


    // Position for barcode
    const barcodeX = this.mmToDots(5);
    let currentY = this.mmToDots(5);

    // Add barcode based on type
    if (data.barcodeType === 'QR') {
      // QR Code
      lines.push(`^FO${barcodeX},${currentY}`);
      lines.push('^BQN,2,5');  // QR code, normal orientation, magnification 5
      lines.push(`^FDQA,${data.barcode}^FS`);
      currentY += this.mmToDots(25);
    } else {
      // Linear barcode (CODE128 or EAN13)
      lines.push(`^FO${barcodeX},${currentY}^BY2`);  // Barcode defaults, module width 2
      const barcodeCmd = BARCODE_COMMANDS[data.barcodeType] || '^BC';
      lines.push(`${barcodeCmd},${this.mmToDots(12)},Y,N,N`);  // Height, interpretation line
      lines.push(`^FD${data.barcode}^FS`);
      currentY += this.mmToDots(18);
    }

    // Add text lines
    const fontSize = this.mmToDots(3);

    if (data.text1) {
      lines.push(`^FO${barcodeX},${currentY}`);
      lines.push(`^A0,${fontSize},${fontSize}`);
      lines.push(`^FD${this.sanitizeText(data.text1)}^FS`);
      currentY += this.mmToDots(5);
    }

    if (data.text2) {
      lines.push(`^FO${barcodeX},${currentY}`);
      lines.push(`^A0,${Math.round(fontSize * 0.8)},${Math.round(fontSize * 0.8)}`);
      lines.push(`^FD${this.sanitizeText(data.text2)}^FS`);
      currentY += this.mmToDots(4);
    }

    if (data.text3) {
      lines.push(`^FO${barcodeX},${currentY}`);
      lines.push(`^A0,${Math.round(fontSize * 0.8)},${Math.round(fontSize * 0.8)}`);
      lines.push(`^FD${this.sanitizeText(data.text3)}^FS`);
    }

    // Print quantity
    if (data.quantity > 1) {
      lines.push(`^PQ${data.quantity}`);
    }

    // End ZPL format
    lines.push('^XZ');

    return lines.join('\n');
  }

  /**
   * Format receipt as ZPL
   */
  formatReceipt(data: ReceiptData): string {
    const lines: string[] = [];

    // Start ZPL format
    lines.push('^XA');

    // Use continuous media mode for receipts
    lines.push('^MNN');  // Non-continuous media


    const leftMargin = this.mmToDots(3);
    const rightCol = this.mmToDots(this.labelWidth - 25);
    let currentY = this.mmToDots(3);
    const lineHeight = this.mmToDots(5);
    const smallFont = this.mmToDots(2.5);
    const mediumFont = this.mmToDots(3);
    const largeFont = this.mmToDots(4);

    // Header
    lines.push(`^FO${leftMargin},${currentY}`);
    lines.push(`^A0,${largeFont},${largeFont}`);
    lines.push('^FDeNail Receipt^FS');
    currentY += lineHeight + this.mmToDots(2);

    // Order number if present
    if (data.orderNumber) {
      lines.push(`^FO${leftMargin},${currentY}`);
      lines.push(`^A0,${smallFont},${smallFont}`);
      lines.push(`^FDOrder: ${data.orderNumber}^FS`);
      currentY += lineHeight;
    }

    // Separator line
    lines.push(`^FO${leftMargin},${currentY}^GB${this.mmToDots(this.labelWidth - 6)},1,1^FS`);
    currentY += this.mmToDots(3);

    // Items
    for (const item of data.items) {
      const itemName = this.sanitizeText(item.name, 30);
      const quantity = item.quantity > 1 ? `${item.quantity}x ` : '';
      const price = this.formatCurrency(item.totalPrice);

      lines.push(`^FO${leftMargin},${currentY}`);
      lines.push(`^A0,${smallFont},${smallFont}`);
      lines.push(`^FD${quantity}${itemName}^FS`);

      lines.push(`^FO${rightCol},${currentY}`);
      lines.push(`^A0,${smallFont},${smallFont}`);
      lines.push(`^FD${price}^FS`);

      currentY += lineHeight;
    }

    // Separator before totals
    currentY += this.mmToDots(2);
    lines.push(`^FO${leftMargin},${currentY}^GB${this.mmToDots(this.labelWidth - 6)},1,1^FS`);
    currentY += this.mmToDots(3);

    // Subtotal if discount exists
    if (data.discount && data.discount > 0) {
      lines.push(`^FO${leftMargin},${currentY}`);
      lines.push(`^A0,${smallFont},${smallFont}`);
      lines.push(`^FDSubtotal:^FS`);

      lines.push(`^FO${rightCol},${currentY}`);
      lines.push(`^A0,${smallFont},${smallFont}`);
      lines.push(`^FD${this.formatCurrency(data.subtotal)}^FS`);
      currentY += lineHeight;

      // Discount
      lines.push(`^FO${leftMargin},${currentY}`);
      lines.push(`^A0,${smallFont},${smallFont}`);
      lines.push(`^FDDiscount:^FS`);

      lines.push(`^FO${rightCol},${currentY}`);
      lines.push(`^A0,${smallFont},${smallFont}`);
      lines.push(`^FD-${this.formatCurrency(data.discount)}^FS`);
      currentY += lineHeight;
    }

    // Total
    lines.push(`^FO${leftMargin},${currentY}`);
    lines.push(`^A0,${mediumFont},${mediumFont}`);
    lines.push(`^FDTOTAL:^FS`);

    lines.push(`^FO${rightCol},${currentY}`);
    lines.push(`^A0,${mediumFont},${mediumFont}`);
    lines.push(`^FD${this.formatCurrency(data.total)}^FS`);
    currentY += lineHeight + this.mmToDots(2);

    // Payment method
    lines.push(`^FO${leftMargin},${currentY}`);
    lines.push(`^A0,${smallFont},${smallFont}`);
    lines.push(`^FDPayment: ${data.payment.method}^FS`);
    currentY += lineHeight;

    // Cashier name if present
    if (data.cashierName) {
      lines.push(`^FO${leftMargin},${currentY}`);
      lines.push(`^A0,${smallFont},${smallFont}`);
      lines.push(`^FDCashier: ${this.sanitizeText(data.cashierName, 20)}^FS`);
      currentY += lineHeight;
    }

    // Date/time
    const now = new Date();
    lines.push(`^FO${leftMargin},${currentY}`);
    lines.push(`^A0,${smallFont},${smallFont}`);
    lines.push(`^FD${now.toLocaleDateString()} ${now.toLocaleTimeString()}^FS`);

    // End ZPL format
    lines.push('^XZ');

    return lines.join('\n');
  }

  /**
   * How many services fit on a single check-in label.
   */
  getMaxServicesPerLabel(): number {
    return this.labelHeight <= 25 ? 2 : this.labelHeight <= 35 ? 3 : this.labelHeight <= 50 ? 4 : 6;
  }

  /**
   * Format check-in confirmation label(s).
   * Omits ^LL so the printer uses its auto-calibrated label length.
   * If services exceed one label, outputs multiple ^XA…^XZ blocks
   * that the printer processes as sequential labels.
   */
  formatCheckinConfirmation(data: CheckinConfirmationData): string {
    const maxPerLabel = this.getMaxServicesPerLabel();

    if (data.services.length <= maxPerLabel) {
      // Single label — all services fit
      return this.buildCheckinLabel(data, data.services, 1, 1);
    }

    // Multi-label: split services into chunks
    const chunks: typeof data.services[] = [];
    for (let i = 0; i < data.services.length; i += maxPerLabel) {
      chunks.push(data.services.slice(i, i + maxPerLabel));
    }

    // Print in reverse order: summary page first, CHECK-IN header last.
    // Last printed label ends up on top of the stack → customer sees header first.
    return chunks.map((chunk, idx) =>
      this.buildCheckinLabel(data, chunk, idx + 1, chunks.length)
    ).reverse().join('\n');
  }

  /**
   * Build a single check-in label ZPL block.
   */
  private buildCheckinLabel(
    data: CheckinConfirmationData,
    services: CheckinConfirmationData['services'],
    page: number,
    totalPages: number,
  ): string {
    const lines: string[] = [];
    const margin = this.mmToDots(2);
    const contentWidth = this.mmToDots(this.labelWidth - 4);
    let y = this.mmToDots(2);

    const titleFont = this.mmToDots(3);
    const bodyFont = this.mmToDots(2);
    const lineStep = this.mmToDots(3.2);
    const isFirstPage = page === 1;
    const isLastPage = page === totalPages;
    const isMultiPage = totalPages > 1;

    lines.push('^XA');
    lines.push(`^PW${this.mmToDots(this.labelWidth)}`);

    if (isFirstPage) {
      // Header
      lines.push(`^FO${margin},${y}`);
      lines.push(`^A0,${titleFont},${titleFont}`);
      lines.push('^FDCheck-in Confirmed^FS');
      if (isMultiPage) {
        // Page indicator right-aligned
        const pageText = `${page}/${totalPages}`;
        lines.push(`^FO${this.mmToDots(this.labelWidth - 12)},${y}`);
        lines.push(`^A0,${bodyFont},${bodyFont}`);
        lines.push(`^FD${pageText}^FS`);
      }
      y += this.mmToDots(4);

      // Separator
      lines.push(`^FO${margin},${y}^GB${contentWidth},1,1^FS`);
      y += this.mmToDots(2);

      // Customer name
      lines.push(`^FO${margin},${y}`);
      lines.push(`^A0,${titleFont},${titleFont}`);
      lines.push(`^FD${this.sanitizeText(data.customerName, 30)}^FS`);
      y += this.mmToDots(3.5);
    } else {
      // Continuation header: customer name + page
      lines.push(`^FO${margin},${y}`);
      lines.push(`^A0,${titleFont},${titleFont}`);
      lines.push(`^FD${this.sanitizeText(data.customerName, 25)}^FS`);
      const pageText = `${page}/${totalPages}`;
      lines.push(`^FO${this.mmToDots(this.labelWidth - 12)},${y}`);
      lines.push(`^A0,${bodyFont},${bodyFont}`);
      lines.push(`^FD${pageText}^FS`);
      y += this.mmToDots(4);

      lines.push(`^FO${margin},${y}^GB${contentWidth},1,1^FS`);
      y += this.mmToDots(2);
    }

    // Services for this page
    for (const svc of services) {
      lines.push(`^FO${margin},${y}`);
      lines.push(`^A0,${bodyFont},${bodyFont}`);
      lines.push(`^FD- ${this.sanitizeText(svc.name, 28)}^FS`);
      y += lineStep;
    }

    if (isLastPage) {
      // Staff
      if (data.staffName) {
        lines.push(`^FO${margin},${y}`);
        lines.push(`^A0,${bodyFont},${bodyFont}`);
        lines.push(`^FDStaff: ${this.sanitizeText(data.staffName, 25)}^FS`);
        y += lineStep;
      }

      // Customer notes
      if (data.customerNotes) {
        lines.push(`^FO${margin},${y}`);
        lines.push(`^A0,${bodyFont},${bodyFont}`);
        lines.push(`^FD${this.sanitizeText(data.customerNotes, 35)}^FS`);
        y += lineStep;
      }

      // Date/time
      const dt = new Date(data.checkinTime);
      const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = dt.toLocaleDateString();
      lines.push(`^FO${margin},${y}`);
      lines.push(`^A0,${bodyFont},${bodyFont}`);
      lines.push(`^FD${dateStr} ${timeStr}^FS`);
      y += lineStep;

      // Bottom separator + Welcome
      lines.push(`^FO${margin},${y}^GB${contentWidth},1,1^FS`);
      y += this.mmToDots(2);
      lines.push(`^FO${margin},${y}`);
      lines.push(`^A0,${bodyFont},${bodyFont}`);
      lines.push('^FDWelcome! Please wait.^FS');
    } else {
      // "continued" indicator
      lines.push(`^FO${margin},${y}`);
      lines.push(`^A0,${bodyFont},${bodyFont}`);
      lines.push('^FD>> continued...^FS');
    }

    lines.push('^XZ');
    return lines.join('\n');
  }

  /**
   * Format test print ZPL
   */
  formatTestPrint(): string {
    const lines: string[] = [];
    const margin = this.mmToDots(3);
    let y = this.mmToDots(3);
    const step = this.mmToDots(5);

    lines.push('^XA');
    // No ^LL — let the printer use its own calibrated label length.
    // ^PW set to configured width so content stays within the label.
    lines.push(`^PW${this.mmToDots(this.labelWidth)}`);

    // Title
    lines.push(`^FO${margin},${y}^A0,${this.mmToDots(4)},${this.mmToDots(4)}^FDZira AI^FS`);
    y += step;

    // Subtitle
    lines.push(`^FO${margin},${y}^A0,${this.mmToDots(3)},${this.mmToDots(3)}^FDTest Print OK^FS`);
    y += step;

    // Date/time (ASCII-safe)
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    lines.push(`^FO${margin},${y}^A0,${this.mmToDots(2.5)},${this.mmToDots(2.5)}^FD${ts}^FS`);
    y += step;

    // Dimensions info
    lines.push(`^FO${margin},${y}^A0,${this.mmToDots(2.5)},${this.mmToDots(2.5)}^FD${this.labelWidth}x${this.labelHeight}mm^FS`);

    lines.push('^XZ');

    return lines.join('\n');
  }

  /**
   * Format currency value (grosze to zł)
   */
  private formatCurrency(grosze: number): string {
    const zl = grosze / 100;
    return zl.toFixed(2) + ' zl';
  }
}
