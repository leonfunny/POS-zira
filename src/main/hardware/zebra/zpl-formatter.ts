import { ReceiptData, LabelData, BarcodeType } from '../../../shared/types';

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
   * Format test print ZPL
   */
  formatTestPrint(): string {
    const lines: string[] = [];
    const leftMargin = this.mmToDots(5);
    let currentY = this.mmToDots(5);
    const lineHeight = this.mmToDots(6);

    lines.push('^XA');
    lines.push(`^LL${this.mmToDots(this.labelHeight)}`);
    lines.push(`^PW${this.mmToDots(this.labelWidth)}`);

    // Title
    lines.push(`^FO${leftMargin},${currentY}`);
    lines.push(`^A0,${this.mmToDots(5)},${this.mmToDots(5)}`);
    lines.push('^FDZira AI^FS');
    currentY += lineHeight;

    // Subtitle
    lines.push(`^FO${leftMargin},${currentY}`);
    lines.push(`^A0,${this.mmToDots(3.5)},${this.mmToDots(3.5)}`);
    lines.push('^FDZebra Test Print^FS');
    currentY += lineHeight;

    // Date/time
    const now = new Date();
    lines.push(`^FO${leftMargin},${currentY}`);
    lines.push(`^A0,${this.mmToDots(3)},${this.mmToDots(3)}`);
    lines.push(`^FD${now.toLocaleString()}^FS`);
    currentY += lineHeight;

    // Test barcode
    lines.push(`^FO${leftMargin},${currentY}^BY2`);
    lines.push(`^BC,${this.mmToDots(10)},Y,N,N`);
    lines.push('^FD123456789^FS');
    currentY += this.mmToDots(18);

    // Label dimensions info
    lines.push(`^FO${leftMargin},${currentY}`);
    lines.push(`^A0,${this.mmToDots(2.5)},${this.mmToDots(2.5)}`);
    lines.push(`^FDLabel: ${this.labelWidth}x${this.labelHeight}mm^FS`);

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
