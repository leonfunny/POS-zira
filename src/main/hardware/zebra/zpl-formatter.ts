import { ReceiptData, LabelData, BarcodeType, CheckinConfirmationData, InfoLabelData, ManufacturerRole } from '../../../shared/types';

/**
 * ZPL command mappings for barcode types
 */
const BARCODE_COMMANDS: Record<Exclude<BarcodeType, 'AUTO'>, string> = {
  CODE128: '^BC',
  EAN13: '^BE',
  QR: '^BQ',
};

export type ZplTextProfile = 'zebra' | 'ascii';

const ASCII_TRANSLITERATION: Record<string, string> = {
  'ą': 'a',
  'ć': 'c',
  'ę': 'e',
  'ł': 'l',
  'ń': 'n',
  'ó': 'o',
  'ś': 's',
  'ź': 'z',
  'ż': 'z',
  'Ą': 'A',
  'Ć': 'C',
  'Ę': 'E',
  'Ł': 'L',
  'Ń': 'N',
  'Ó': 'O',
  'Ś': 'S',
  'Ź': 'Z',
  'Ż': 'Z',
  'ß': 'ss',
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
    dpi: number = 203,                  // Common: 203 or 300 dpi
    private textProfile: ZplTextProfile = 'zebra',
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
    return this.transliterateForZebra(text)
      .replace(/[\x00-\x1F\x7F]/g, '') // Control characters
      .replace(/[\^~]/g, '')            // ZPL special chars
      .trim()
      .substring(0, maxLength);
  }

  /**
   * Replace characters that the printer font cannot render with readable
   * ASCII equivalents. Zebra Font 0 only needs ł/Ł replacement on tested
   * units; Xprinter-compatible firmware drops broader Polish glyphs.
   */
  private transliterateForZebra(text: string): string {
    if (this.textProfile === 'ascii') {
      return text.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻß]/g, (char) => ASCII_TRANSLITERATION[char] || char);
    }

    return text.replace(/ł/g, 'l').replace(/Ł/g, 'L');
  }

  /**
   * Resolve backend "AUTO" labels without widening the runtime surface.
   * EAN-13 is the only auto-detectable linear barcode we need today; all
   * other values keep the legacy Code128 fallback.
   */
  private resolveBarcodeType(data: LabelData): Exclude<BarcodeType, 'AUTO'> {
    if (data.barcodeType !== 'AUTO') {
      return data.barcodeType;
    }

    return /^\d{13}$/.test(data.barcode) ? 'EAN13' : 'CODE128';
  }

  /**
   * Wrap label copy into at most two readable lines. Explicit backend line
   * breaks are honored first; longer content wraps at word boundaries and
   * gets an ellipsis if it still exceeds the two-line budget.
   */
  private wrapLabelText(text: string, maxCharsPerLine: number, maxLines: number = 2): string[] {
    const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
    const wrapped: string[] = [];
    let overflow = false;

    const appendLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;

      if (wrapped.length < maxLines) {
        wrapped.push(trimmed);
      } else {
        overflow = true;
      }
    };

    for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
      const words = paragraphs[paragraphIndex].trim().split(/\s+/).filter(Boolean);
      let current = '';

      for (const word of words) {
        if (word.length > maxCharsPerLine) {
          if (current) {
            appendLine(current);
            current = '';
          }

          let remainder = word;
          while (remainder.length > maxCharsPerLine) {
            appendLine(remainder.slice(0, maxCharsPerLine));
            remainder = remainder.slice(maxCharsPerLine);
          }
          current = remainder;
          continue;
        }

        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= maxCharsPerLine) {
          current = candidate;
        } else {
          appendLine(current);
          current = word;
        }
      }

      if (current) {
        appendLine(current);
      }

      if (paragraphIndex < paragraphs.length - 1 && wrapped.length >= maxLines) {
        overflow = true;
      }
    }

    if (overflow && wrapped.length > 0) {
      const lastIndex = Math.min(wrapped.length, maxLines) - 1;
      const maxContentLength = Math.max(1, maxCharsPerLine - 1);
      wrapped[lastIndex] = `${wrapped[lastIndex].slice(0, maxContentLength).trimEnd()}…`;
    }

    return wrapped
      .slice(0, maxLines)
      .map((line) => this.sanitizeText(line, maxCharsPerLine));
  }

  /**
   * Format label with barcode
   */
  formatLabel(data: LabelData): string {
    const lines: string[] = [];
    const resolvedBarcodeType = this.resolveBarcodeType(data);

    // Start ZPL format
    lines.push('^XA');
    lines.push('^CI28'); // UTF-8 international chars (Polish + Vietnamese diacritics)

    // Set label size
    // ^LL omitted: rely on the printer's gap-sensor calibration so labels
    // don't drift when our nominal label height (configured in mm) doesn't
    // exactly match the physical media. The check-in label flow does the
    // same thing.
    lines.push(`^PW${this.mmToDots(this.labelWidth)}`);

    // Adaptive vertical budget based on configured label height (mm).
    const H = this.labelHeight;
    const topMarginMm = Math.max(2, H * 0.07);
    const baseBarcodeHeightMm = Math.max(8, Math.min(12, H * 0.34));
    const text2FontMm = Math.max(3.6, Math.min(5.2, H * 0.135));
    const text2GapMm = text2FontMm + 0.1;
    const text3FontMm = Math.max(1.8, Math.min(3, H * 0.072));

    // Helper: returns true if a text field at yDots with given font height would still fit
    const labelHeightDots = this.mmToDots(this.labelHeight);
    const wouldFit = (yDots: number, requiredFontMm: number): boolean =>
      yDots + this.mmToDots(requiredFontMm) + this.mmToDots(0.5) <= labelHeightDots;

    // Position for barcode
    const barcodeX = this.mmToDots(5);
    let currentY = this.mmToDots(topMarginMm);

    // Add barcode based on type
    if (resolvedBarcodeType === 'QR') {
      // QR Code
      lines.push(`^FO${barcodeX},${currentY}`);
      lines.push('^BQN,2,5');  // QR code, normal orientation, magnification 5
      lines.push(`^FDQA,${data.barcode}^FS`);
      currentY += this.mmToDots(25);

      // Keep the legacy QR path intact. On a 30mm label the QR symbol itself
      // consumes almost the full vertical budget, so the new title-above-barcode
      // layout is intentionally limited to linear barcodes.
      const legacyText1FontMm = Math.max(2, H * 0.10);
      const legacyText1GapMm = legacyText1FontMm + 0.5;
      if (data.text1 && wouldFit(currentY, legacyText1FontMm)) {
        lines.push(`^FO${barcodeX},${currentY}`);
        lines.push(`^A0,${this.mmToDots(legacyText1FontMm)},${this.mmToDots(legacyText1FontMm)}`);
        lines.push(`^FD${this.sanitizeText(data.text1)}^FS`);
        currentY += this.mmToDots(legacyText1GapMm);
      }
    } else {
      // Product title first: the old order wasted the whole upper half of
      // 50x30mm product labels by placing every text line below the barcode.
      const titleCharsPerLine = Math.max(22, Math.floor((this.labelWidth - 10) / 1.1));
      const titleMaxLines = H >= 30 ? 3 : 2;
      const text1Lines = data.text1 ? this.wrapLabelText(data.text1, titleCharsPerLine, titleMaxLines) : [];
      const text1FontMm = text1Lines.length >= 3
        ? Math.max(1.9, H * 0.072)
        : text1Lines.length > 1
          ? Math.max(2.1, H * 0.08)
          : Math.max(2.6, H * 0.10);
      const text1GapMm = text1FontMm + 0.25;

      for (const textLine of text1Lines) {
        if (!wouldFit(currentY, text1FontMm)) break;
        lines.push(`^FO${barcodeX},${currentY}`);
        lines.push(`^A0,${this.mmToDots(text1FontMm)},${this.mmToDots(text1FontMm)}`);
        lines.push(`^FD${textLine}^FS`);
        currentY += this.mmToDots(text1GapMm);
      }

      if (text1Lines.length > 0) {
        currentY += this.mmToDots(0.4);
      }

      // Linear barcode (CODE128 or EAN13). Let long product names and the
      // enlarged price line claim vertical space first, while preserving a
      // scannable minimum bar height on 50x30mm labels.
      const currentYMm = currentY / this.dotsPerMm;
      const footerBudgetMm =
        (data.text2 ? text2GapMm : 0)
        + (data.text3 ? text3FontMm + 0.7 : 0)
        + 0.8;
      const barcodeHeightMm = Math.max(7.5, Math.min(baseBarcodeHeightMm, H - currentYMm - footerBudgetMm));
      lines.push(`^FO${barcodeX},${currentY}^BY2`);  // Barcode defaults, module width 2
      const barcodeCmd = BARCODE_COMMANDS[resolvedBarcodeType];
      lines.push(`${barcodeCmd},${this.mmToDots(barcodeHeightMm)},Y,N,N`);  // Adaptive height, interpretation line
      lines.push(`^FD${data.barcode}^FS`);
      currentY += this.mmToDots(barcodeHeightMm + 2);  // ~2mm gap below barcode
    }

    if (data.text2 && wouldFit(currentY, text2FontMm)) {
      lines.push(`^FO${barcodeX},${currentY}`);
      lines.push(`^A0,${this.mmToDots(text2FontMm)},${this.mmToDots(text2FontMm)}`);
      lines.push(`^FD${this.sanitizeText(data.text2)}^FS`);
      currentY += this.mmToDots(text2GapMm);
    }

    if (data.text3 && wouldFit(currentY, text3FontMm)) {
      lines.push(`^FO${barcodeX},${currentY}`);
      lines.push(`^A0,${this.mmToDots(text3FontMm)},${this.mmToDots(text3FontMm)}`);
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
   * Format check-in confirmation label(s): one service per physical label.
   * Omits ^LL so the printer uses its auto-calibrated label length.
   * Outputs multiple ^XA…^XZ blocks printed in reverse so the first page ends up on top.
   */
  formatCheckinConfirmation(data: CheckinConfirmationData): string {
    const services = data.services.length > 0 ? data.services : [{ name: '', price: 0 }];
    const total = services.length;

    if (total === 1) {
      return this.buildCheckinLabel(data, services, 1, 1);
    }

    return services
      .map((svc, idx) => this.buildCheckinLabel(data, [svc], idx + 1, total))
      .reverse()
      .join('\n');
  }

  /** Pipe-separated QR payload for booking lookup: ZIRA|<booking>|<phone>|<iso-timestamp> */
  private buildQrPayload(data: CheckinConfirmationData): string {
    const phone = (data.customerPhone || '').replace(/\|/g, '');
    const ts = data.checkinTime || new Date().toISOString();
    const booking = (data.bookingNumber || '').replace(/\|/g, '');
    return `ZIRA|${booking}|${phone}|${ts}`;
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

    // Services for this page (1 service/label in the new model, but loop still supports N)
    for (const svc of services) {
      lines.push(`^FO${margin},${y}`);
      lines.push(`^A0,${bodyFont},${bodyFont}`);
      lines.push(`^FD- ${this.sanitizeText(svc.name, 28)}^FS`);
      if (svc.price && svc.price > 0) {
        const priceText = `${(svc.price / 100).toFixed(2)} zl`;
        lines.push(`^FO${this.mmToDots(this.labelWidth - 18)},${y}`);
        lines.push(`^A0,${bodyFont},${bodyFont}`);
        lines.push(`^FD${priceText}^FS`);
      }
      y += lineStep;
    }

    if (isLastPage) {
      // Grand total across all services
      const grandTotal = data.services.reduce((sum, s) => sum + (s.price || 0), 0);
      if (grandTotal > 0) {
        const totalText = `TOTAL: ${(grandTotal / 100).toFixed(2)} zl`;
        lines.push(`^FO${margin},${y}`);
        lines.push(`^A0,${bodyFont},${bodyFont}`);
        lines.push(`^FD${totalText}^FS`);
        y += lineStep;
      }

      // Staff
      if (data.staffName) {
        lines.push(`^FO${margin},${y}`);
        lines.push(`^A0,${bodyFont},${bodyFont}`);
        lines.push(`^FDStaff: ${this.sanitizeText(data.staffName, 25)}^FS`);
        y += lineStep;
      }

      // Customer notes (truncated)
      if (data.customerNotes) {
        lines.push(`^FO${margin},${y}`);
        lines.push(`^A0,${bodyFont},${bodyFont}`);
        lines.push(`^FD${this.sanitizeText(data.customerNotes, 32)}^FS`);
        y += lineStep;
      }

      // Date/time
      const dt = new Date(data.checkinTime);
      const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = dt.toLocaleDateString();
      lines.push(`^FO${margin},${y}`);
      lines.push(`^A0,${bodyFont},${bodyFont}`);
      lines.push(`^FD${dateStr} ${timeStr}^FS`);

      // QR code bottom-right — size & magnification scale with configured label dimensions.
      const qrMm = Math.max(7, Math.min(14, this.labelHeight * 0.36, this.labelWidth * 0.24));
      const qrMarginMm = 1.5;
      // ^BQ magnification: each module rendered as N×N dots. Derive so QR stays ~qrMm physical.
      // At 203 DPI: 1mm ≈ 8 dots. For ~21 modules (short payloads): mag = qrMm*8/21.
      const qrMagnification = Math.max(2, Math.min(8, Math.round((qrMm * this.dotsPerMm) / 24)));
      const qrX = this.mmToDots(this.labelWidth - qrMm - qrMarginMm);
      const qrY = this.mmToDots(this.labelHeight - qrMm - qrMarginMm);
      const qrPayload = this.buildQrPayload(data);
      lines.push(`^FO${qrX},${qrY}^BQN,2,${qrMagnification}^FDLA,${qrPayload}^FS`);
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

  /**
   * Format an info label (4-section PL-legal label).
   * Adapts content to paper height: smaller paper → fewer rows / shorter
   * ingredient list. Parallel to `formatLabel()`; uses the same ZPL
   * dialect.
   */
  formatInfoLabel(data: InfoLabelData, widthMm: number, heightMm: number): string {
    const dpmm = 8; // Zebra typical 203 dpi → 8 dots/mm
    const widthDots = Math.round(widthMm * dpmm);

    const rolePrefixMap: Record<ManufacturerRole, string> = {
      PRODUCER: "Producent",
      IMPORTER: "Importer",
      DISTRIBUTOR: "Dystrybutor",
      SUPPLIER: "Dostawca",
    } as Record<ManufacturerRole, string>;

    const formatBestBefore = (iso: string): string => {
      const [y, m, d] = iso.split("-");
      return `${d}.${m}.${y}`;
    };

    // Heuristic line budgets per height
    const tallLabel = heightMm >= 90;
    const ingredientsLines = tallLabel ? 10 : heightMm >= 40 ? (heightMm >= 50 ? 4 : 3) : 2;
    const manufacturerLines = tallLabel ? 5 : heightMm >= 40 ? 2 : 1;
    const showCountry = heightMm >= 40 && data.countryOfOrigin;

    // Truncate helper: wrap at ~charsPerLine, append … on overflow
    // 203 DPI, font width 16 dots ≈ 2mm/char → widthMm/2 chars/line
    const charsPerLine = Math.max(20, Math.floor(widthMm / (tallLabel ? 1.7 : 2)));
    const truncate = (text: string, maxLines: number): string => {
      const words = text.split(/\s+/);
      const lines: string[] = [];
      let current = "";
      for (const w of words) {
        if ((current + " " + w).trim().length > charsPerLine) {
          if (lines.length >= maxLines - 1) {
            return [...lines, current.trim()].slice(0, maxLines).join("\\&") + "…";
          }
          lines.push(current.trim());
          current = w;
        } else {
          current = (current + " " + w).trim();
        }
      }
      if (current) lines.push(current);
      return lines.slice(0, maxLines).join("\\&");
    };

    const ingredientsText = this.transliterateForZebra(
      `Składniki: ${truncate(data.ingredients, ingredientsLines)}`,
    );
    const bestBeforeText = this.transliterateForZebra(
      `Najlepiej spożyć przed: ${formatBestBefore(data.bestBefore)}`,
    );
    const manufacturerText = this.transliterateForZebra(
      `${rolePrefixMap[data.manufacturerRole]}: ${truncate(data.manufacturerInfo, manufacturerLines)}`,
    );
    const countryText = showCountry
      ? this.transliterateForZebra(`Kraj pochodzenia: ${data.countryOfOrigin}`)
      : null;

    const margin = tallLabel ? 40 : 10;
    const contentWidth = Math.max(80, widthDots - margin * 2);
    const titleFont = tallLabel ? 40 : 22;
    const titleLines = tallLabel ? 3 : 2;
    const bodyFont = tallLabel ? 26 : 16;
    const metaFont = tallLabel ? 28 : 18;
    const countryFont = tallLabel ? 22 : 14;
    let y = margin;
    const blocks: string[] = [];

    // Product name — bold, larger
    blocks.push(`^FO${margin},${y}^A0N,${titleFont},${titleFont}^FB${contentWidth},${titleLines},0,L,0^FD${this.transliterateForZebra(data.productName)}^FS`);
    y += tallLabel ? titleFont * titleLines + 28 : 50;
    // Ingredients
    blocks.push(`^FO${margin},${y}^A0N,${bodyFont},${bodyFont}^FB${contentWidth},${ingredientsLines},0,L,0^FD${ingredientsText}^FS`);
    y += (bodyFont + (tallLabel ? 8 : 2)) * ingredientsLines + (tallLabel ? 24 : 4);
    // Best-before
    blocks.push(`^FO${margin},${y}^A0N,${metaFont},${metaFont}^FD${bestBeforeText}^FS`);
    y += metaFont + (tallLabel ? 24 : 4);
    // Manufacturer
    blocks.push(`^FO${margin},${y}^A0N,${bodyFont},${bodyFont}^FB${contentWidth},${manufacturerLines},0,L,0^FD${manufacturerText}^FS`);
    y += (bodyFont + (tallLabel ? 8 : 2)) * manufacturerLines + (tallLabel ? 16 : 2);
    // Country (optional)
    if (countryText) {
      blocks.push(`^FO${margin},${y}^A0N,${countryFont},${countryFont}^FD${countryText}^FS`);
    }

    return [
      "^XA",
      "^CI28",
      // ^LL omitted: defer to printer calibration (see formatLabel comment).
      `^PW${widthDots}`,
      ...blocks,
      `^PQ${data.quantity}`,
      "^XZ",
    ].join("\n");
  }
}
