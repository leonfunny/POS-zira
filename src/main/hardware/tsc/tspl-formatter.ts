/**
 * TSPL / TSPL2 formatter for TSC label printers.
 *
 * TSC printers do NOT speak ZPL. A few models ship a ZPL emulation mode, but
 * it is off by default and lossy, so driving them through the Zebra path only
 * works by accident. Their native language is TSPL2, which is a display list:
 * set up the media, clear the buffer with CLS, emit drawing commands, PRINT.
 *
 * Two output shapes are produced here:
 *
 *  - `formatLabel()` — a plain barcode/price label drawn with the printer's
 *    internal bitmap fonts. Fast, crisp, and what LABEL jobs use. Internal
 *    fonts are code-page based, so text is transliterated to ASCII first.
 *
 *  - `formatFabricTag()` — a garment care tag. Everything except the barcode
 *    arrives pre-rasterised (see fabric-tag-renderer.ts) and goes out as one
 *    BITMAP block, because a fabric tag needs Vietnamese diacritics, a logo,
 *    and ISO 3758 care symbols that no internal font can render.
 *
 *  - `formatFabricArtwork()` — an operator-approved customer PNG, already
 *    cropped to the printer's physically reachable 142-dot centre strip.
 */
import QRCode from 'qrcode';
import {
  FABRIC_TAG_ARTWORK_MEDIA,
  type BarcodeType,
  type FabricTagData,
  type LabelData,
} from '../../../shared/types';
import type { MonoBitmap } from './fabric-tag-renderer';

/** TSPL barcode selector per symbology. QR has its own command. */
const BARCODE_COMMANDS: Record<Exclude<BarcodeType, 'AUTO' | 'QR'>, string> = {
  CODE128: '128',
  EAN13: 'EAN13',
};

/** Control characters would terminate a TSPL command line early. */
function isControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/** Unicode combining diacritical marks (U+0300-U+036F). */
function isCombiningMark(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x0300 && code <= 0x036f;
}

/** Printable ASCII, the only range the internal bitmap fonts cover. */
function isPrintableAscii(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
}

/** Non-ASCII characters that survive NFD stripping and still need a stand-in. */
const ASCII_TRANSLITERATION: Record<string, string> = {
  'đ': 'd', 'Đ': 'D',   // đ Đ — Vietnamese d-with-stroke
  'ł': 'l', 'Ł': 'L',   // ł Ł — Polish l-with-stroke
  'ı': 'i', 'İ': 'I',   // ı İ — Turkish dotless/dotted i
  '–': '-', '—': '-',   // en/em dash
  '‘': "'", '’': "'",   // curly single quotes
  '“': '"', '”': '"',   // curly double quotes
  '…': '...',
  '·': '-',                  // middle dot, used as a composition separator
  '€': 'EUR',
};

/** Millimetres of tag height reserved for the natively-drawn barcode zone. */
const BARCODE_ZONE_MM = 13;

/**
 * Thinnest bar a 1D symbol may use, in dots. At 203dpi one dot is 0.125mm —
 * about half the EAN13 minimum module, and fabric spreads ink enough to close
 * the gaps at that width. Below this the caller switches to a QR code.
 */
const MIN_BARCODE_MODULE_DOTS = 2;

/** QR cells smaller than this are unreliable on a 203dpi fabric print. */
const MIN_QR_CELL_DOTS = 3;
const MAX_QR_CELL_DOTS = 8;

const MIN_LABEL_DIMENSION_MM = 10;
const MAX_LABEL_DIMENSION_MM = 1000;
const MIN_DPI = 100;
const MAX_DPI = 1200;
const MAX_GAP_MM = 25;
const MIN_SPEED = 1;
const MAX_SPEED = 12;
const MIN_DENSITY = 0;
const MAX_DENSITY = 15;

const PRODUCT_MIN_BAR_HEIGHT_MM = 8;
const PRODUCT_HUMAN_READABLE_MM = 6;
const FABRIC_MIN_BAR_HEIGHT_MM = 6;
const FABRIC_HUMAN_READABLE_MM = 5;
const PRODUCT_PRICE_HEIGHT_MM = 7;
const PRODUCT_DETAIL_HEIGHT_MM = 3;
const QR_TO_TEXT_GAP_MM = 1;

export interface TsplMediaOptions {
  /** Gap between labels in mm. Ignored when sensor is 'none'. */
  gapMm?: number;
  /** How far dot 0 sits inside the media edge. See `contentWidthDots`. */
  originInsetMm?: number;
  /** Print speed in inches/second. */
  speed?: number;
  /** Burn darkness, 0-15. */
  density?: number;
  /** Media sensor type. */
  sensor?: 'gap' | 'bline' | 'none';
}

/**
 * Accumulates TSPL into a Buffer.
 *
 * A Buffer rather than a string because BITMAP embeds raw binary bytes that
 * any multi-byte text encoding would mangle on the way to the spooler.
 */
export class TsplBuilder {
  private chunks: Buffer[] = [];

  /** Append one CRLF-terminated TSPL command. */
  cmd(line: string): this {
    this.chunks.push(Buffer.from(`${line}\r\n`, 'latin1'));
    return this;
  }

  /** Append text with no terminator — for a command that is followed by binary. */
  partial(text: string): this {
    this.chunks.push(Buffer.from(text, 'latin1'));
    return this;
  }

  /** Append raw bytes (BITMAP payload). */
  raw(buffer: Buffer): this {
    this.chunks.push(buffer);
    return this;
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export class TsplFormatter {
  constructor(
    private labelWidthMm: number = 40,
    private labelHeightMm: number = 60,
    private dpi: number = 203,
    private media: TsplMediaOptions = {},
  ) {
    // Config enters through IPC at runtime, where TypeScript's numeric types
    // provide no protection against strings containing extra TSPL commands.
    // Copy and validate before any formatter method can emit bytes.
    this.media = { ...media };
    this.validateConfiguration();
  }

  setDimensions(widthMm: number, heightMm: number): void {
    this.validateDimensions(widthMm, heightMm);
    this.validateMedia(this.media, widthMm);
    this.labelWidthMm = widthMm;
    this.labelHeightMm = heightMm;
  }

  setMedia(media: TsplMediaOptions): void {
    const next = { ...this.media, ...media };
    this.validateMedia(next, this.labelWidthMm);
    this.media = next;
  }

  getDimensions(): { widthMm: number; heightMm: number } {
    return { widthMm: this.labelWidthMm, heightMm: this.labelHeightMm };
  }

  private assertFiniteRange(name: string, value: number, minimum: number, maximum: number): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be a finite number between ${minimum} and ${maximum}`);
    }
  }

  private validateDimensions(widthMm: number, heightMm: number): void {
    this.assertFiniteRange('Label width', widthMm, MIN_LABEL_DIMENSION_MM, MAX_LABEL_DIMENSION_MM);
    this.assertFiniteRange('Label height', heightMm, MIN_LABEL_DIMENSION_MM, MAX_LABEL_DIMENSION_MM);
  }

  private validateMedia(media: TsplMediaOptions, widthMm: number): void {
    if (media.gapMm !== undefined) this.assertFiniteRange('Media gap', media.gapMm, 0, MAX_GAP_MM);
    if (media.speed !== undefined) this.assertFiniteRange('Print speed', media.speed, MIN_SPEED, MAX_SPEED);
    if (media.density !== undefined) {
      this.assertFiniteRange('Print density', media.density, MIN_DENSITY, MAX_DENSITY);
    }
    if (media.originInsetMm !== undefined) {
      this.assertFiniteRange('Origin inset', media.originInsetMm, 0, MAX_LABEL_DIMENSION_MM);
      if (media.originInsetMm >= widthMm / 2) {
        throw new Error('Origin inset must be less than half the label width');
      }
    }
  }

  private validateConfiguration(labelHeightMmOverride?: number): void {
    this.validateDimensions(this.labelWidthMm, this.labelHeightMm);
    this.assertFiniteRange('Printer DPI', this.dpi, MIN_DPI, MAX_DPI);
    this.validateMedia(this.media, this.labelWidthMm);
    if (labelHeightMmOverride !== undefined) {
      this.assertFiniteRange(
        'Label height override',
        labelHeightMmOverride,
        MIN_LABEL_DIMENSION_MM,
        MAX_LABEL_DIMENSION_MM,
      );
    }
  }

  /** Dots for a millimetre value at the printer's head resolution. */
  mmToDots(mm: number): number {
    return Math.round((mm / 25.4) * this.dpi);
  }

  get widthDots(): number {
    return this.mmToDots(this.labelWidthMm);
  }

  /**
   * Width available to content, in dots.
   *
   * The print origin does not always land on the media's edge: measured on the
   * factory MB241, dot 0 sits ~1.1mm inside a 20mm ribbon, so a full-width tag
   * runs its right edge off the cloth and reads as shifted. TSPL cannot
   * address a negative column, so sitting centred on the media means giving up
   * the same margin on the reachable side too.
   */
  get contentWidthDots(): number {
    const inset = this.mmToDots(Math.max(0, this.media.originInsetMm ?? 0));
    return Math.max(8, this.widthDots - inset * 2);
  }

  get heightDots(): number {
    return this.mmToDots(this.labelHeightMm);
  }

  /**
   * Height in mm available to the rasterised graphic block on a fabric tag.
   * The barcode zone is only reserved when there is actually a barcode.
   */
  graphicHeightMm(hasBarcode: boolean): number {
    if (!hasBarcode) return this.labelHeightMm;
    return Math.max(this.labelHeightMm * 0.4, this.labelHeightMm - BARCODE_ZONE_MM);
  }

  /**
   * TSPL string literal escaping. Strings are double-quoted and TSPL2 uses
   * backslash as the escape character, so both must be escaped. Control
   * characters would terminate the command early, so they are dropped.
   */
  private quote(text: string): string {
    const escaped = String(text ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .split('')
      .map((ch) => (isControl(ch) ? ' ' : ch))
      .join('');
    return `"${escaped}"`;
  }

  /** Internal fonts are code-page based — fold anything outside ASCII. */
  private toAscii(text: string, maxLength = 60): string {
    const folded = String(text ?? '')
      .normalize('NFD')
      .split('')
      // Drop combining marks so Vietnamese/Polish letters keep their base form.
      .filter((ch) => !isCombiningMark(ch))
      .map((ch) => ASCII_TRANSLITERATION[ch] ?? ch)
      .join('')
      .split('')
      .filter(isPrintableAscii)
      .join('');
    return folded.trim().slice(0, maxLength);
  }

  private resolveBarcodeType(barcode: string, requested?: BarcodeType): Exclude<BarcodeType, 'AUTO'> {
    if (requested && requested !== 'AUTO') return requested;
    return /^\d{13}$/.test(barcode) ? 'EAN13' : 'CODE128';
  }

  /**
   * Total modules a symbol occupies, quiet zones included.
   * EAN13 is a fixed 95 modules; CODE128-B is start + 11 per character +
   * checksum + a 13-module stop pattern.
   */
  private barcodeModules(type: Exclude<BarcodeType, 'AUTO' | 'QR'>, content: string): number {
    if (type === 'EAN13') return 95 + 18;
    return 11 * (content.length + 2) + 13 + 20;
  }

  /**
   * Widest module that still fits the media, in dots.
   *
   * Narrow media is the reason this exists: a 20mm fabric ribbon is 160 dots,
   * and a fixed 2-dot module puts an EAN13 at 190 dots — off the edge of the
   * ribbon, printing a symbol that cannot scan.
   *
   * Returns 0 when the symbol cannot be drawn at a scannable size, which tells
   * the caller to use a QR instead. "Fits" is not the bar: a 1-dot module at
   * 203dpi is 0.125mm, roughly half the EAN13 minimum, and woven fabric
   * spreads ink enough to close the gaps at that size. 2 dots (0.25mm) is the
   * practical floor.
   */
  private barcodeModuleWidth(type: Exclude<BarcodeType, 'AUTO' | 'QR'>, content: string, usableDots: number): number {
    const modules = this.barcodeModules(type, content);
    if (modules <= 0) return 0;
    const fitted = Math.floor(usableDots / modules);
    if (fitted < MIN_BARCODE_MODULE_DOTS) return 0;
    // Cap at 3: wider bars waste tag length without helping a 203dpi scanner.
    return Math.min(3, fitted);
  }

  /** QR geometry in dots, based on the module count of this exact payload. */
  private qrGeometry(
    content: string,
    usableWidthDots: number,
    availableHeightDots: number,
  ): { cell: number; modules: number; sizeDots: number } {
    let modules: number;
    try {
      // TSPL's `M` argument selects the same error-correction level. Using the
      // encoder here prevents a long payload from silently outgrowing the
      // version-2/25-module estimate that used to drive this calculation.
      modules = QRCode.create(content, { errorCorrectionLevel: 'M' }).modules.size;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`QR code payload cannot be encoded: ${detail}`);
    }

    const width = Math.max(0, Math.floor(usableWidthDots));
    const height = Math.max(0, Math.floor(availableHeightDots));
    const fitted = Math.min(MAX_QR_CELL_DOTS, Math.floor(Math.min(width, height) / modules));
    if (fitted < MIN_QR_CELL_DOTS) {
      throw new Error(
        `QR code (${modules} modules) does not fit at the minimum cell size of ` +
        `${MIN_QR_CELL_DOTS} dots: requires ${modules * MIN_QR_CELL_DOTS} dots, ` +
        `available ${width}x${height} dots`,
      );
    }
    return { cell: fitted, modules, sizeDots: fitted * modules };
  }

  /**
   * Fit a 1D barcode inside a vertical zone that also contains the firmware's
   * human-readable line. A too-short label must fail instead of growing beyond
   * SIZE: Math.max(minimum, available) caused exactly that overflow before.
   */
  private oneDimensionalBarcodeHeight(
    availableZoneDots: number,
    minimumBarHeightDots: number,
    humanReadableReserveDots: number,
    preferredBarHeightDots: number,
  ): number {
    const available = Number.isFinite(availableZoneDots)
      ? Math.max(0, Math.floor(availableZoneDots))
      : 0;
    const required = minimumBarHeightDots + humanReadableReserveDots;
    if (available < required) {
      throw new Error(
        `1D barcode does not fit with its human-readable text: requires at least ` +
        `${required} dots (${minimumBarHeightDots} dots of bars + ` +
        `${humanReadableReserveDots} dots human-readable reserve), available ${available} dots`,
      );
    }

    const preferred = Number.isFinite(preferredBarHeightDots)
      ? Math.max(minimumBarHeightDots, Math.floor(preferredBarHeightDots))
      : minimumBarHeightDots;
    return Math.min(preferred, available - humanReadableReserveDots);
  }

  private copies(quantity: number): number {
    const n = Number(quantity);
    return Number.isFinite(n) ? Math.max(1, Math.min(999, Math.round(n))) : 1;
  }

  /**
   * Media setup + CLS. Every job starts here so a tag never inherits the
   * geometry of whatever was printed before it.
   */
  header(builder: TsplBuilder, labelHeightMmOverride?: number): TsplBuilder {
    // Recheck at the last safe boundary too. This keeps header fail-closed even
    // if an untyped caller mutates a formatter instance after construction.
    this.validateConfiguration(labelHeightMmOverride);
    const sensor = this.media.sensor ?? 'gap';
    const gapMm = this.media.gapMm ?? 2;
    // Continuous media has no pitch to honour, so a tag may declare the length
    // its content actually needs instead of the configured maximum.
    const heightMm = labelHeightMmOverride ?? this.labelHeightMm;
    builder.cmd(`SIZE ${this.labelWidthMm} mm,${heightMm} mm`);
    if (sensor === 'bline') builder.cmd(`BLINE ${gapMm} mm,0 mm`);
    else if (sensor === 'none') builder.cmd('GAP 0 mm,0 mm');
    else builder.cmd(`GAP ${gapMm} mm,0 mm`);
    builder.cmd('DIRECTION 1,0');
    builder.cmd('REFERENCE 0,0');
    builder.cmd(`SPEED ${this.media.speed ?? 3}`);
    builder.cmd(`DENSITY ${Math.round(this.media.density ?? 10)}`);
    builder.cmd('SET TEAR ON');
    builder.cmd('CLS');
    return builder;
  }

  /**
   * Emit `BITMAP x,y,widthBytes,heightDots,mode,<binary>`.
   *
   * The payload starts immediately after the last comma with no separator, so
   * the command text and the bytes have to be written as one unterminated run
   * — a CRLF there would be consumed as the first two pixels of the image.
   */
  private bitmap(builder: TsplBuilder, x: number, y: number, image: MonoBitmap): void {
    builder.partial(`BITMAP ${x},${y},${image.widthBytes},${image.heightDots},0,`);
    builder.raw(image.data);
    builder.partial('\r\n');
  }

  /**
   * Plain product label: name, barcode, price, detail line.
   * Mirrors what ZplFormatter.formatLabel produces so LABEL jobs look the
   * same whichever brand of printer they land on.
   */
  formatLabel(data: LabelData): Buffer {
    const b = this.header(new TsplBuilder());
    const margin = this.mmToDots(2);
    const inner = this.widthDots - margin * 2;

    // Font "3" is the 16x24 internal font; multipliers scale it in whole steps.
    let y = margin;
    const title = this.toAscii(data.text1 || data.barcode, 40);
    if (title) {
      b.cmd(`BLOCK ${margin},${y},${inner},${this.mmToDots(8)},"3",0,1,1,0,2,${this.quote(title)}`);
      y += this.mmToDots(8);
    }

    const price = this.toAscii(data.text2 || '', 24);
    const detail = this.toAscii(data.text3 || '', 40);
    const trailingTextHeight =
      (price ? this.mmToDots(PRODUCT_PRICE_HEIGHT_MM) : 0) +
      (detail ? this.mmToDots(PRODUCT_DETAIL_HEIGHT_MM) : 0);

    const barcode = String(data.barcode || '').trim();
    if (barcode) {
      const type = this.resolveBarcodeType(barcode, data.barcodeType);
      const module = type === 'QR' ? 0 : this.barcodeModuleWidth(type, barcode, inner);
      if (type === 'QR' || module === 0) {
        // Too narrow for bars — a QR still scans in the space a 1D symbol needs.
        const gap = trailingTextHeight > 0 ? this.mmToDots(QR_TO_TEXT_GAP_MM) : 0;
        const qr = this.qrGeometry(
          barcode,
          inner,
          this.heightDots - y - margin - trailingTextHeight - gap,
        );
        b.cmd(`QRCODE ${margin},${y},M,${qr.cell},A,0,M2,${this.quote(barcode)}`);
        y += qr.sizeDots + gap;
      } else {
        const humanReadableReserve = this.mmToDots(PRODUCT_HUMAN_READABLE_MM);
        const barHeight = this.oneDimensionalBarcodeHeight(
          this.heightDots - y - margin - trailingTextHeight,
          this.mmToDots(PRODUCT_MIN_BAR_HEIGHT_MM),
          humanReadableReserve,
          Math.round(this.heightDots * 0.3),
        );
        b.cmd(`BARCODE ${margin},${y},"${BARCODE_COMMANDS[type]}",${barHeight},1,0,${module},${module * 2},${this.quote(barcode)}`);
        y += barHeight + humanReadableReserve;
      }
    }

    if (price) {
      b.cmd(`TEXT ${margin},${y},"3",0,2,2,${this.quote(price)}`);
      y += this.mmToDots(PRODUCT_PRICE_HEIGHT_MM);
    }

    if (detail) {
      b.cmd(`TEXT ${margin},${y},"2",0,1,1,${this.quote(detail)}`);
    }

    b.cmd(`PRINT 1,${this.copies(data.quantity)}`);
    return b.build();
  }

  /**
   * Garment care tag.
   *
   * `graphic` is the pre-rendered top block (logo/brand, size, composition,
   * care symbols, price). The barcode is drawn natively underneath it: printer
   * firmware rasterises bars far more accurately than a downsampled bitmap,
   * and a fabric tag that will not scan at the till is a defective tag.
   */
  formatFabricTag(
    data: FabricTagData,
    graphic: MonoBitmap | null,
    labelHeightMmOverride?: number,
  ): Buffer {
    const b = this.header(new TsplBuilder(), labelHeightMmOverride);
    const effectiveHeightMm = labelHeightMmOverride ?? this.labelHeightMm;
    const effectiveHeightDots = this.mmToDots(effectiveHeightMm);
    const margin = this.mmToDots(2);
    const barcode = String(data.barcode || '').trim();

    if (graphic) this.bitmap(b, 0, 0, graphic);

    if (barcode) {
      const y = graphic ? graphic.heightDots + this.mmToDots(1) : margin;
      const inner = this.widthDots - margin * 2;
      const type = this.resolveBarcodeType(barcode, data.barcodeType);
      const module = type === 'QR' ? 0 : this.barcodeModuleWidth(type, barcode, inner);
      // A narrow fabric ribbon cannot hold a 1D symbol at a scannable module
      // width, so fall back to QR rather than print bars that run off the edge.
      if (data.useQrCode || type === 'QR' || module === 0) {
        const qr = this.qrGeometry(barcode, inner, effectiveHeightDots - y - margin);
        b.cmd(`QRCODE ${margin},${y},M,${qr.cell},A,0,M2,${this.quote(barcode)}`);
      } else {
        const humanReadableReserve = this.mmToDots(FABRIC_HUMAN_READABLE_MM);
        const barHeight = this.oneDimensionalBarcodeHeight(
          effectiveHeightDots - y,
          this.mmToDots(FABRIC_MIN_BAR_HEIGHT_MM),
          humanReadableReserve,
          effectiveHeightDots - y - humanReadableReserve,
        );
        b.cmd(`BARCODE ${margin},${y},"${BARCODE_COMMANDS[type]}",${barHeight},1,0,${module},${module * 2},${this.quote(barcode)}`);
      }
    }

    b.cmd(`PRINT 1,${this.copies(data.quantity)}`);
    return b.build();
  }

  /**
   * Print customer-supplied fabric artwork without fitting or scaling it.
   * The importer owns the fixed 160px canvas and nine-dot safety margins;
   * this final boundary accepts only the resulting 142-dot centre bitmap.
   */
  formatFabricArtwork(
    graphic: MonoBitmap,
    quantity: number,
    labelHeightMm: number,
  ): Buffer {
    if (
      !Number.isSafeInteger(quantity)
      || quantity < 1
      || quantity > 999
    ) {
      throw new RangeError('Fabric artwork quantity must be an integer from 1 to 999');
    }
    if (
      this.labelWidthMm !== 20
      || this.dpi !== 203
      || this.media.originInsetMm !== 1.1
      || this.widthDots !== 160
      || this.contentWidthDots !== 142
    ) {
      throw new RangeError(
        'Fabric artwork requires 20mm media at 203dpi with a 1.1mm origin inset',
      );
    }
    if (
      graphic.widthDots !== this.contentWidthDots
      || graphic.widthBytes !== Math.ceil(graphic.widthDots / 8)
      || graphic.heightDots < FABRIC_TAG_ARTWORK_MEDIA.minHeightPx
      || graphic.heightDots > FABRIC_TAG_ARTWORK_MEDIA.maxHeightPx
      || graphic.data.byteLength !== graphic.widthBytes * graphic.heightDots
    ) {
      throw new RangeError('Fabric artwork bitmap dimensions or byte length are invalid');
    }
    if (this.mmToDots(labelHeightMm) !== graphic.heightDots) {
      throw new RangeError(
        `Fabric artwork length ${labelHeightMm}mm does not preserve its ${graphic.heightDots}px height`,
      );
    }

    const b = this.header(new TsplBuilder(), labelHeightMm);
    this.bitmap(b, 0, 0, graphic);
    b.cmd(`PRINT 1,${quantity}`);
    return b.build();
  }

  /** Print a self-test tag so the user can eyeball media alignment and darkness. */
  formatTestPrint(): Buffer {
    const b = this.header(new TsplBuilder());
    const margin = this.mmToDots(2);
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    b.cmd(`TEXT ${margin},${margin},"3",0,1,1,${this.quote('ZIRA TSPL TEST')}`);
    b.cmd(`TEXT ${margin},${margin + this.mmToDots(7)},"2",0,1,1,${this.quote(`${this.labelWidthMm} x ${this.labelHeightMm} mm`)}`);
    b.cmd(`TEXT ${margin},${margin + this.mmToDots(12)},"2",0,1,1,${this.quote(stamp)}`);
    b.cmd(`BOX ${margin},${margin + this.mmToDots(17)},${this.widthDots - margin},${this.heightDots - margin},3`);
    b.cmd('PRINT 1,1');
    return b.build();
  }
}
