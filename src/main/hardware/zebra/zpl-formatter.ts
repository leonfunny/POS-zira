import { ReceiptData, LabelData, BarcodeType, CheckinConfirmationData, InfoLabelData, ManufacturerRole, type KitchenTicketData } from '../../../shared/types';
import QRCode from 'qrcode';
import { kitchenItemCount } from '../../printing/kitchen-ticket';

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
  '\u0142': 'l',
  '\u0141': 'L',
  '\u00df': 'ss',
  '\u0111': 'd',
  '\u0110': 'D',
};

type KitchenLabelLang = 'pl' | 'vi' | 'en';

const KITCHEN_LABEL_COPY: Record<KitchenLabelLang, {
  order: string; count: string; pay: string; takeaway: string; dineIn: string;
}> = {
  pl: { order: 'NR ZAMOWIENIA', count: 'poz.', pay: 'Zaplac przy kasie', takeaway: 'NA WYNOS', dineIn: 'NA MIEJSCU' },
  vi: { order: 'SO DON', count: 'mon', pay: 'Ra quay tra tien', takeaway: 'MANG DI', dineIn: 'AN TAI QUAN' },
  en: { order: 'ORDER NO', count: 'items', pay: 'Pay at counter', takeaway: 'TAKEAWAY', dineIn: 'DINE IN' },
};

function kitchenLabelLang(value: unknown): KitchenLabelLang {
  const lang = String(value || '').toLowerCase();
  return lang === 'vi' || lang === 'en' ? lang : 'pl';
}

function kitchenLabelFulfillment(value: unknown, lang: KitchenLabelLang): string | null {
  const normalized = String(value || '').toUpperCase();
  if (normalized === 'TAKEAWAY') return KITCHEN_LABEL_COPY[lang].takeaway;
  if (normalized === 'DINE_IN') return KITCHEN_LABEL_COPY[lang].dineIn;
  return null;
}

function kitchenLabelTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

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

  private sanitizeAscii(text: string, maxLength: number = 50): string {
    return this.transliterateLatinToAscii(text)
      .replace(/[\^~]/g, '')
      .replace(/[^\x20-\x7E]/g, '')
      .trim()
      .substring(0, maxLength);
  }

  private kitchenLabelQrLayout(payload: string): { magnification: number; x: number } {
    const marginMm = 2;
    const leftColMm = 22;
    const maxQrMm = Math.max(10, this.labelWidth - leftColMm - marginMm);
    let modules = 25;
    try {
      modules = QRCode.create(payload, { errorCorrectionLevel: 'M' }).modules.size;
    } catch {
      modules = 25;
    }
    let magnification = 2;
    for (const value of [4, 3, 2]) {
      if ((modules * value) / this.dotsPerMm <= maxQrMm) {
        magnification = value;
        break;
      }
    }
    const widthDots = modules * magnification;
    const x = Math.max(
      this.mmToDots(leftColMm),
      this.mmToDots(this.labelWidth) - widthDots - this.mmToDots(marginMm),
    );
    return { magnification, x };
  }

  private transliterateLatinToAscii(text: string): string {
    return text
      .replace(/[\u0142\u0141\u00df\u0111\u0110]/g, (char) => ASCII_TRANSLITERATION[char] || char)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  /**
   * Replace characters that the printer font cannot render with readable
   * ASCII equivalents. Xprinter-compatible firmware drops broader Latin
   * glyphs; Zebra Font 0 at least drops l-stroke on tested units.
   */
  private transliterateForZebra(text: string): string {
    if (this.textProfile === 'ascii') {
      return this.transliterateLatinToAscii(text);
    }

    return text.replace(/\u0142/g, 'l').replace(/\u0141/g, 'L');
  }

  /**
   * GK420d Font 0 glyphs occupy only about one third of the requested ^A0
   * width. Treating that width as a full character cell made titles and EANs
   * visibly condensed even though most of the 40mm printable band stayed
   * empty. Size against the measured glyph ratio and retain a slightly wide,
   * readable aspect ratio whenever the line has room.
   */
  private fittedTextWidthMm(
    text: string,
    fontHeightMm: number,
    maxWidthMm: number,
  ): number {
    const glyphCount = Math.max(1, Array.from(text).length);
    const measuredGlyphWidthRatio = 0.32;
    const readableCellWidthMm = fontHeightMm * 1.15;
    const fittedCellWidthMm = maxWidthMm / (glyphCount * measuredGlyphWidthRatio);
    return Math.max(0.9, Math.min(readableCellWidthMm, fittedCellWidthMm));
  }

  /**
   * Food information labels use Font 0 blocks; GK420d renders some Latin
   * Extended-A and Vietnamese glyphs as blanks even with ^CI28. Keep the labels
   * readable until we ship/download a Unicode font to the printer.
   */
  private transliterateForInfoLabel(text: string): string {
    return this.transliterateLatinToAscii(text);
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
   * Wrap the complete label copy at word boundaries. Product shelf labels
   * must never silently replace the end of a name with an ellipsis.
   */
  private wrapLabelText(text: string, maxCharsPerLine: number): string[] {
    const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
    const wrapped: string[] = [];

    const appendLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      wrapped.push(trimmed);
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

    }

    return wrapped
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
    const compactShelfLabel = this.labelWidth >= 45 && this.labelWidth <= 55 && H <= 35;
    const topMarginMm = compactShelfLabel ? 1.1 : Math.max(2, H * 0.07);
    const baseBarcodeHeightMm = Math.max(10, Math.min(15, H * 0.42));
    const text2FontMm = compactShelfLabel ? 5.6 : Math.max(4.2, Math.min(5.8, H * 0.16));
    const text2GapMm = text2FontMm + 0.1;
    const text3FontMm = Math.max(1.8, Math.min(3, H * 0.072));
    const barcodeValueFontMm = compactShelfLabel ? 3 : Math.max(2.2, Math.min(3, H * 0.075));
    const barcodeToValueGapMm = 0.25;
    const valueToPriceGapMm = compactShelfLabel ? 0.4 : 0.35;

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
      const standardTitleCharsPerLine = Math.max(22, Math.floor((this.labelWidth - 10) / 1.1));
      const largeCompactTitleCharsPerLine = Math.max(22, Math.floor((this.labelWidth - 10) / 1.35));
      const normalizedTitleLength = data.text1
        ? data.text1.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim().length
        : 0;
      // A medium title on the common 50x30 stock fits cleanly on two lines.
      // Use fewer characters per line so both lines can be materially larger;
      // genuinely long names retain the denser layout instead of being clipped.
      const useLargeCompactTitle = compactShelfLabel
        && normalizedTitleLength > largeCompactTitleCharsPerLine + 10
        && normalizedTitleLength <= largeCompactTitleCharsPerLine * 2;
      const titleCharsPerLine = useLargeCompactTitle
        ? largeCompactTitleCharsPerLine
        : standardTitleCharsPerLine;
      const text1Lines = data.text1 ? this.wrapLabelText(data.text1, titleCharsPerLine) : [];
      const maxReadableTitleLines = compactShelfLabel ? 4 : Math.max(4, Math.floor(H / 8));
      if (text1Lines.length > maxReadableTitleLines) {
        throw new Error(`Product name needs ${text1Lines.length} lines; ${maxReadableTitleLines} fit readably on this label`);
      }
      const text1FontMm = compactShelfLabel
        ? text1Lines.length >= 4
          ? 2.2
          : text1Lines.length === 3
            ? 2.6
            : text1Lines.length > 1
              ? useLargeCompactTitle ? Math.max(4.2, Math.min(4.5, H * 0.147)) : 3.6
              : 4.8
        : text1Lines.length >= 3
          ? Math.max(2.4, Math.min(2.8, H * 0.072))
          : text1Lines.length > 1
            ? Math.max(2.4, Math.min(3.1, H * 0.09))
            : Math.max(3, Math.min(4.1, H * 0.115));
      const titleLineGapMm = compactShelfLabel
        ? text1Lines.length >= 3 ? 0.3 : useLargeCompactTitle ? 0.75 : 0.55
        : 0.25;

      for (let lineIndex = 0; lineIndex < text1Lines.length; lineIndex += 1) {
        const textLine = text1Lines[lineIndex];
        if (!wouldFit(currentY, text1FontMm)) break;
        const text1WidthMm = this.fittedTextWidthMm(textLine, text1FontMm, this.labelWidth - 10);
        lines.push(`^FO${barcodeX},${currentY}`);
        lines.push(`^A0,${this.mmToDots(text1FontMm)},${this.mmToDots(text1WidthMm)}`);
        lines.push(`^FD${textLine}^FS`);
        currentY += this.mmToDots(text1FontMm);
        if (lineIndex < text1Lines.length - 1) {
          currentY += this.mmToDots(titleLineGapMm);
        }
      }

      if (text1Lines.length > 0) {
        currentY += this.mmToDots(compactShelfLabel ? 0.35 : 0.4);
      }

      // Linear barcode (CODE128 or EAN13). Let long product names and the
      // enlarged price line claim vertical space first, while preserving a
      // scannable minimum bar height on 50x30mm labels.
      const currentYMm = currentY / this.dotsPerMm;
      const priceGapBelowBarcodeMm = barcodeToValueGapMm + barcodeValueFontMm + valueToPriceGapMm;
      const footerBudgetMm =
        priceGapBelowBarcodeMm
        + (data.text2 ? text2GapMm : 0)
        + (data.text3 ? text3FontMm + 0.7 : 0)
        + (compactShelfLabel ? 0.7 : 0.8);
      const minimumBarcodeHeightMm = compactShelfLabel ? 9 : 9.5;
      const barcodeHeightMm = Math.max(
        minimumBarcodeHeightMm,
        Math.min(baseBarcodeHeightMm, H - currentYMm - footerBudgetMm),
      );
      const barcodeModuleWidth = resolvedBarcodeType === 'EAN13' && this.labelWidth >= 45 ? 3 : 2;
      lines.push(`^FO${barcodeX},${currentY}^BY${barcodeModuleWidth}`);  // Wider EAN bars on GK420d 50mm labels.
      const barcodeCmd = BARCODE_COMMANDS[resolvedBarcodeType];
      lines.push(`${barcodeCmd},${this.mmToDots(barcodeHeightMm)},N,N,N`);  // Explicit readable value line follows.
      lines.push(`^FD${data.barcode}^FS`);
      currentY += this.mmToDots(barcodeHeightMm + barcodeToValueGapMm);

      const printableBarcode = this.sanitizeText(data.barcode, 50);
      if (printableBarcode && wouldFit(currentY, barcodeValueFontMm)) {
        const barcodeValueWidthMm = this.fittedTextWidthMm(
          printableBarcode,
          barcodeValueFontMm,
          this.labelWidth - 10,
        );
        lines.push(`^FO${barcodeX},${currentY}`);
        lines.push(`^A0,${this.mmToDots(barcodeValueFontMm)},${this.mmToDots(barcodeValueWidthMm)}`);
        lines.push(`^FD${printableBarcode}^FS`);
        currentY += this.mmToDots(barcodeValueFontMm + valueToPriceGapMm);
      }
    }

    const printableText2 = data.text2 ? this.sanitizeText(data.text2) : '';
    if (printableText2 && wouldFit(currentY, text2FontMm)) {
      const text2WidthMm = this.fittedTextWidthMm(printableText2, text2FontMm, this.labelWidth - 10);
      lines.push(`^FO${barcodeX},${currentY}`);
      lines.push(`^A0,${this.mmToDots(text2FontMm)},${this.mmToDots(text2WidthMm)}`);
      lines.push(`^FD${printableText2}^FS`);
      currentY += this.mmToDots(text2GapMm);
    }

    const printableText3 = data.text3 ? this.sanitizeText(data.text3) : '';
    if (printableText3 && wouldFit(currentY, text3FontMm)) {
      const text3WidthMm = this.fittedTextWidthMm(printableText3, text3FontMm, this.labelWidth - 10);
      lines.push(`^FO${barcodeX},${currentY}`);
      lines.push(`^A0,${this.mmToDots(text3FontMm)},${this.mmToDots(text3WidthMm)}`);
      lines.push(`^FD${printableText3}^FS`);
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
   * Dedicated 50x30 payment label for kitchen self-order kiosks.
   */
  formatKitchenPaymentLabel(data: KitchenTicketData): string {
    const lang = kitchenLabelLang(data.customerLanguage);
    const copy = KITCHEN_LABEL_COPY[lang];
    const total = Math.max(
      0,
      Math.round(Number(data.totalGrosze) || data.items.reduce((sum, item) => {
        const explicit = Math.round(Number(item.lineTotalGrosze) || 0);
        if (explicit > 0) return sum + explicit;
        const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
        return sum + Math.max(0, Math.round(Number(item.unitPriceGrosze) || 0)) * quantity;
      }, 0)),
    );
    const orderNumber = this.sanitizeAscii(data.pickupNumber || data.orderNumber || '----', 24);
    const brand = this.sanitizeAscii(data.brandName || 'Zira POS', 28);
    const fulfillment = kitchenLabelFulfillment(data.fulfillmentType, lang);
    const headerText = fulfillment ? `${brand}  -  ${fulfillment}` : brand;
    const totalText = this.sanitizeAscii(
      `${kitchenItemCount(data.items)} ${copy.count}  -  ${(total / 100).toFixed(2).replace('.', ',')} zl`,
      40,
    );
    const time = kitchenLabelTime(data.createdAt);
    const payload = this.sanitizeText(data.labelQrPayload || data.qrPayload || '', 1200);
    const left = this.mmToDots(3);

    const lines: string[] = [
      '^XA',
      '^CI28',
      `^PW${this.mmToDots(this.labelWidth)}`,
      `^FO${left},${this.mmToDots(2)}^A0,${this.mmToDots(2.6)},${this.mmToDots(2.6)}^FD${this.sanitizeAscii(headerText, 40)}^FS`,
      `^FO${left},${this.mmToDots(6)}^A0,${this.mmToDots(2.6)},${this.mmToDots(2.6)}^FD${this.sanitizeAscii(copy.order, 24)}^FS`,
      `^FO${left},${this.mmToDots(9)}^A0,${this.mmToDots(7)},${this.mmToDots(7)}^FD${orderNumber}^FS`,
      `^FO${left},${this.mmToDots(18)}^A0,${this.mmToDots(2.8)},${this.mmToDots(2.8)}^FD${totalText}^FS`,
      `^FO${left},${this.mmToDots(22)}^A0,${this.mmToDots(2.3)},${this.mmToDots(2.3)}^FD${this.sanitizeAscii(copy.pay, 40)}^FS`,
      `^FO${left},${this.mmToDots(26)}^A0,${this.mmToDots(2.1)},${this.mmToDots(2.1)}^FD${this.sanitizeAscii(time, 8)}^FS`,
    ];

    if (payload) {
      const qr = this.kitchenLabelQrLayout(payload);
      lines.push(`^FO${qr.x},${this.mmToDots(4)}`);
      lines.push(`^BQN,2,${qr.magnification}`);
      lines.push(`^FDMA,${payload}^FS`);
    }

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

    const tallLabel = heightMm >= 90;
    const compactLabel = heightMm < 40;
    const marginX = tallLabel ? 40 : compactLabel ? 16 : 10;
    const marginTop = tallLabel ? 40 : compactLabel ? 16 : 10;
    const contentWidth = Math.max(80, widthDots - marginX * 2);
    const titleFont = tallLabel ? 40 : compactLabel ? 22 : 22;
    const titleLines = tallLabel ? 3 : 2;
    const bodyFont = tallLabel ? 26 : compactLabel ? 17 : 16;
    const metaFont = tallLabel ? 28 : compactLabel ? 19 : 18;
    const countryFont = tallLabel ? 22 : 14;
    const titleBlockHeight = tallLabel ? titleFont * titleLines + 28 : titleFont * titleLines + 6;
    const bodyLineGap = tallLabel ? 8 : compactLabel ? 1 : 2;
    const titleLineGap = compactLabel ? 1 : 0;
    const sectionGap = tallLabel ? 24 : compactLabel ? 8 : 4;
    const metaGap = tallLabel ? 24 : compactLabel ? 8 : 4;

    // Heuristic line budgets per height
    const ingredientsLines = tallLabel ? 10 : compactLabel ? 3 : heightMm >= 50 ? 4 : 3;
    const manufacturerLines = tallLabel ? 5 : compactLabel ? 3 : 2;
    const showCountry = heightMm >= 40 && data.countryOfOrigin;

    // Wrap helper: wrap at an estimated Font 0 width and append ASCII
    // ellipsis on overflow. The prefix ("Skladniki:", "Producent:") is part
    // of the wrapped text so it cannot steal a line after truncation.
    const charsPerLineForFont = (fontDots: number): number =>
      Math.max(16, Math.floor(contentWidth / Math.max(9, fontDots * (compactLabel ? 0.58 : 0.75))));
    const wrapText = (
      text: string | null | undefined,
      maxLines: number,
      charsPerLine: number,
    ): { text: string; lineCount: number } => {
      const source = (text ?? "").trim();
      if (!source) return { text: "", lineCount: 0 };

      const words = source.split(/\s+/);
      const lines: string[] = [];
      let overflow = false;
      let current = "";
      for (const w of words) {
        if ((current + " " + w).trim().length > charsPerLine) {
          if (lines.length >= maxLines - 1) {
            overflow = true;
            break;
          }
          lines.push(current.trim());
          current = w;
        } else {
          current = (current + " " + w).trim();
        }
      }
      if (current) lines.push(current);

      const visibleLines = lines.slice(0, maxLines);
      if (overflow && visibleLines.length > 0) {
        const lastIndex = visibleLines.length - 1;
        const suffix = "...";
        visibleLines[lastIndex] = `${visibleLines[lastIndex].slice(0, Math.max(1, charsPerLine - suffix.length)).trimEnd()}${suffix}`;
      }

      return {
        text: visibleLines.join("\\&"),
        lineCount: visibleLines.length,
      };
    };
    const titleCharsPerLine = charsPerLineForFont(titleFont);
    const bodyCharsPerLine = charsPerLineForFont(bodyFont);
    const blockLineCount = (lineCount: number, maxLines: number): number =>
      compactLabel ? Math.max(1, lineCount) : maxLines;

    const titleWrapped = wrapText(data.productName, titleLines, titleCharsPerLine);
    const ingredientsWrapped = wrapText(`Składniki: ${data.ingredients ?? ""}`, ingredientsLines, bodyCharsPerLine);
    const manufacturerWrapped = wrapText(`${rolePrefixMap[data.manufacturerRole]}: ${data.manufacturerInfo ?? ""}`, manufacturerLines, bodyCharsPerLine);

    const ingredientsText = this.transliterateForInfoLabel(
      ingredientsWrapped.text,
    );
    const bestBeforeText = this.transliterateForInfoLabel(
      `Najlepiej spożyć przed: ${formatBestBefore(data.bestBefore)}`,
    );
    const manufacturerText = this.transliterateForInfoLabel(
      manufacturerWrapped.text,
    );
    const countryText = showCountry
      ? this.transliterateForInfoLabel(`Kraj pochodzenia: ${data.countryOfOrigin}`)
      : null;

    let y = marginTop;
    const blocks: string[] = [];

    // Product name — bold, larger
    blocks.push(`^FO${marginX},${y}^A0N,${titleFont},${titleFont}^FB${contentWidth},${titleLines},0,L,0^FD${this.transliterateForInfoLabel(titleWrapped.text)}^FS`);
    y += compactLabel
      ? (titleFont + titleLineGap) * blockLineCount(titleWrapped.lineCount, titleLines) + 4
      : titleBlockHeight;
    // Ingredients
    blocks.push(`^FO${marginX},${y}^A0N,${bodyFont},${bodyFont}^FB${contentWidth},${ingredientsLines},0,L,0^FD${ingredientsText}^FS`);
    y += (bodyFont + bodyLineGap) * blockLineCount(ingredientsWrapped.lineCount, ingredientsLines) + sectionGap;
    // Best-before
    blocks.push(`^FO${marginX},${y}^A0N,${metaFont},${metaFont}^FD${bestBeforeText}^FS`);
    y += metaFont + metaGap;
    // Manufacturer
    blocks.push(`^FO${marginX},${y}^A0N,${bodyFont},${bodyFont}^FB${contentWidth},${manufacturerLines},0,L,0^FD${manufacturerText}^FS`);
    y += (bodyFont + bodyLineGap) * blockLineCount(manufacturerWrapped.lineCount, manufacturerLines) + (tallLabel ? 16 : compactLabel ? 4 : 2);
    // Country (optional)
    if (countryText) {
      blocks.push(`^FO${marginX},${y}^A0N,${countryFont},${countryFont}^FD${countryText}^FS`);
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
